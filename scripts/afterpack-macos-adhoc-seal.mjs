/**
 * Gives the packaged macOS app a valid ad-hoc seal, and refuses to ship one that is not valid.
 *
 * ## The bug this exists for
 *
 * Issue #66: the 2.0.5 arm64 DMG launched to "the application is damaged" on macOS 27, with
 * Gatekeeper assessment already disabled — so this was a structural failure, not a policy one:
 *
 *     codesign --verify --deep --strict "Chat On Steroids.app"
 *     -> code has no resources but signature indicates they must be present
 *     codesign -dvv -> flags=0x20002(adhoc,linker-signed), Sealed Resources=none
 *
 * `linker-signed` is the giveaway. Every arm64 Mach-O gets an ad-hoc signature from the linker
 * whether anyone asks or not — it is not optional on Apple Silicon. `identity: null` tells
 * electron-builder to skip bundle signing, so the app shipped as a *bundle* carrying signed
 * Mach-Os and no `_CodeSignature/CodeResources`. macOS reads the signature on the executable,
 * looks for the resource seal it implies, finds none, and calls the bundle damaged. There was
 * never an x64-only version of this problem, which is why it appeared with Apple Silicon.
 *
 * ## Why ad-hoc rather than Developer ID
 *
 * The release policy is deliberately unsigned and unnotarized, and this does not change that.
 * An ad-hoc seal carries no Authority and no TeamIdentifier — `codesign -dvv` still reports
 * `Signature=adhoc`, and Gatekeeper still will not vouch for it. What it adds is the resource
 * envelope the executable's own signature already claims exists. The bundle stops contradicting
 * itself; it does not become trusted. Users still clear quarantine as before.
 *
 * ## Why it verifies afterwards
 *
 * The real defect was that nothing checked. The bundle audit asserted the *absence* of a seal, so
 * the broken state was the state the build required, and two releases shipped it. Signing without
 * verifying would leave the same hole one layer along, so a failed verify fails the build.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Runs a command and returns its combined output, throwing with that output on failure. */
function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${detail || error.message}`);
  }
}

export default async function sealMacOsBundle(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const app = path.join(context.appOutDir, appName);
  if (!existsSync(app)) throw new Error(`afterPack could not find ${app} to seal`);

  // --deep is the wrong tool for verification and the right one here: an Electron bundle nests
  // frameworks and helper apps that each need their own signature, and signing only the outer
  // bundle would leave the same self-contradiction one level down. Apple discourages --deep for
  // *distribution* signing, where each nested component wants its own identity and entitlements;
  // for a uniform ad-hoc seal with no entitlements there is nothing to distinguish.
  run('codesign', ['--force', '--deep', '--sign', '-', app]);

  // The check the two broken releases did not have. --strict so a seal that merely exists is not
  // mistaken for a seal that is coherent, and --deep so a nested framework cannot be the one
  // thing that is wrong, which is exactly how issue #66 presented.
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

  const shown = run('codesign', ['--display', '--verbose=4', app]);
  // Fail loudly if this ever starts producing a trust-bearing signature. The release notes say
  // unsigned, and an afterPack hook silently turning that into something Gatekeeper vouches for
  // would be a policy change smuggled in as a build step.
  if (/^Authority=/m.test(shown) || !/^Signature=adhoc\s*$/m.test(shown)) {
    throw new Error(`${app} was sealed with something other than an ad-hoc signature:\n${shown}`);
  }

  process.stdout.write(`Sealed ${appName} ad-hoc and verified its resource envelope.\n`);
}
