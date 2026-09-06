import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function compareVersions(left, right) {
  const a = String(left).split('.').map((part) => Number.parseInt(part, 10));
  const b = String(right).split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const av = Number.isFinite(a[index]) ? a[index] : 0;
    const bv = Number.isFinite(b[index]) ? b[index] : 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/**
 * Run an otool inspection without handing otool-classic a parenthesized pathname.
 *
 * Xcode's classic otool parser treats `file(member)` as archive-member syntax. Electron's
 * nested helpers are legitimately named e.g. `Chat On Steroids Helper (GPU)`, so passing that
 * pathname directly makes otool strip the parenthesized suffix and report a nonexistent file.
 * A temporary symlink with a parser-safe basename keeps the bytes and audit semantics identical
 * without modifying the packaged bundle.
 */
export function withOtoolSafePath(file, inspect, overrides = {}) {
  if (!/[()]/.test(file)) return inspect(file);

  const temporaryDirectory = (overrides.mkdtempSync ?? mkdtempSync)(
    path.join(overrides.tmpdir ?? os.tmpdir(), 'cos-otool-')
  );
  const alias = path.join(temporaryDirectory, 'payload');
  try {
    (overrides.symlinkSync ?? symlinkSync)(file, alias);
    return inspect(alias);
  } finally {
    (overrides.rmSync ?? rmSync)(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Extract every macOS deployment floor encoded in `otool -l` output. */
export function macOSDeploymentTargetsFromOtool(output) {
  const targets = [];
  let command = null;
  let platform = null;

  for (const line of String(output).split(/\r?\n/)) {
    const commandMatch = line.match(/^\s*cmd\s+(LC_[A-Z0-9_]+)/);
    if (commandMatch) {
      command = commandMatch[1];
      platform = null;
      continue;
    }

    if (command === 'LC_BUILD_VERSION') {
      const platformMatch = line.match(/^\s*platform\s+(\S+)/i);
      if (platformMatch) {
        platform = platformMatch[1].toLowerCase();
        continue;
      }
      const minosMatch = line.match(/^\s*minos\s+(\d+(?:\.\d+)*)/i);
      if (minosMatch) {
        // `otool` prints numeric platform 1 on older Xcode and `macos` on newer versions.
        if (platform == null || platform === '1' || platform === 'macos') targets.push(minosMatch[1]);
      }
      continue;
    }

    if (command === 'LC_VERSION_MIN_MACOSX') {
      const versionMatch = line.match(/^\s*version\s+(\d+(?:\.\d+)*)/i);
      if (versionMatch) targets.push(versionMatch[1]);
    }
  }

  return targets;
}

export function assertCompatibleMacOSDeploymentTargets(file, otoolOutput, declaredMinimum) {
  const targets = macOSDeploymentTargetsFromOtool(otoolOutput);
  if (targets.length === 0) throw new Error(`${file} has no macOS deployment target load command`);
  for (const target of targets) {
    if (compareVersions(target, declaredMinimum) > 0) {
      throw new Error(
        `${file} requires macOS ${target}, newer than Info.plist LSMinimumSystemVersion ${declaredMinimum}`
      );
    }
  }
  return targets;
}

/**
 * Enforce the release's "unsigned" policy without rejecting Apple-Silicon ad-hoc signatures.
 *
 * arm64 Mach-O executables can carry an ad-hoc LC_CODE_SIGNATURE even when the application has
 * never been signed by a Developer ID. `codesign --display` may therefore succeed for a bundle
 * whose publisher identity is still untrusted. A trust-bearing signature instead exposes an
 * Authority chain and/or a real TeamIdentifier.
 *
 * The resource envelope is now required rather than forbidden, which is the opposite of what this
 * asserted before. That inversion was issue #66: arm64 Mach-Os are ad-hoc signed by the linker
 * whether anyone asks or not, so a bundle without CodeResources is one whose executables claim a
 * resource seal the bundle does not have. macOS reads that contradiction as damage and refuses to
 * launch, with Gatekeeper assessment disabled and no crash report to show for it. Demanding the
 * absence of a seal made the broken artifact the compliant one, and two releases shipped it.
 *
 * Coherent and untrusted are different axes. Only the second is the policy, and it is still
 * enforced below.
 */
export function assertNoTrustBearingMacCodeSignature(file, codesignResult, hasCodeResources = false) {
  if (!hasCodeResources) {
    throw new Error(
      `${file} has no bundle CodeResources envelope; macOS reads an ad-hoc linker-signed bundle ` +
        'without one as damaged. The afterPack ad-hoc seal should have created it.'
    );
  }

  const output = `${codesignResult.stdout ?? ''}\n${codesignResult.stderr ?? ''}`;
  if (codesignResult.status !== 0) {
    if (codesignResult.status === 1 && /code object is not signed(?: at all)?/i.test(output)) return;
    throw new Error(`${file} code-signature inspection failed unexpectedly (status ${codesignResult.status ?? 'null'})`);
  }

  const adHoc = /^Signature=adhoc\s*$/m.test(output);
  const authority = /^Authority=/m.test(output);
  const teamMatch = output.match(/^TeamIdentifier=(.+)$/m);
  const trustedTeam = teamMatch != null && teamMatch[1].trim() !== 'not set';
  if (!adHoc || authority || trustedTeam) {
    throw new Error(`${file} unexpectedly has a trust-bearing code signature; release metadata says unsigned`);
  }
}
