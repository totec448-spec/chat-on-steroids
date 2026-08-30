import path from 'node:path';
import { promisify } from 'node:util';
import type {
  MacOSCodeIdentity,
  MacOSDesktopAccessStatus,
  MacOSPermissionPair,
  MacOSPermissionState,
  MacOSSigningMode
} from '../../shared/types.js';

const CODESIGN_TIMEOUT_MS = 3000;

function field(output: string, name: string): string | null {
  const match = output.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match?.[1]?.trim() || null;
}

/** Pure parser kept exported so the identity classification has deterministic tests. */
export function parseMacOSCodeIdentity(output: string, executablePath: string): MacOSCodeIdentity {
  const signature = field(output, 'Signature');
  const team = field(output, 'TeamIdentifier');
  let signingMode: MacOSSigningMode = 'unknown';
  if (/not signed at all|code object is not signed/i.test(output)) signingMode = 'unsigned';
  else if (signature === 'adhoc' || /flags=.*\badhoc\b/i.test(output)) signingMode = 'adhoc';
  else if (/^Authority=/m.test(output) || (signature !== null && signature !== 'adhoc')) signingMode = 'signed';

  return {
    executable: path.basename(executablePath),
    identifier: field(output, 'Identifier'),
    teamIdentifier: team === 'not set' ? null : team,
    signingMode,
    cdhash: field(output, 'CDHash')
  };
}

async function inspectIdentity(executablePath: string): Promise<MacOSCodeIdentity> {
  if (process.platform !== 'darwin') {
    return {
      executable: path.basename(executablePath),
      identifier: null,
      teamIdentifier: null,
      signingMode: 'unknown',
      cdhash: null
    };
  }
  try {
    // Several helper-protocol tests replace node:child_process with a deliberately tiny
    // spawn-only mock. Resolve codesign lazily so importing the Desktop backend remains valid
    // in those environments; a missing inspector means unknown identity, never permission.
    const childProcess = await import('node:child_process');
    if (typeof childProcess.execFile !== 'function') {
      return {
        executable: path.basename(executablePath),
        identifier: null,
        teamIdentifier: null,
        signingMode: 'unknown',
        cdhash: null
      };
    }
    const execFileAsync = promisify(childProcess.execFile);
    // codesign writes display output to stderr even on success.
    const result = await execFileAsync('/usr/bin/codesign', ['-d', '--verbose=4', executablePath], {
      encoding: 'utf8',
      timeout: CODESIGN_TIMEOUT_MS,
      maxBuffer: 128 * 1024
    });
    return parseMacOSCodeIdentity(`${result.stdout}\n${result.stderr}`, executablePath);
  } catch (error) {
    const detail = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const output = `${detail.stdout ?? ''}\n${detail.stderr ?? ''}\n${detail.message ?? ''}`;
    return parseMacOSCodeIdentity(output, executablePath);
  }
}

function permission(value: unknown): MacOSPermissionState {
  return value === true ? 'granted' : value === false ? 'missing' : 'unknown';
}

/**
 * Combines the helper's live TCC answer with the identities macOS actually authorises.
 *
 * An ad-hoc designated requirement is content-bound (normally a cdhash), so an enabled row
 * can belong to yesterday's binary after a rebuild.  A real signing identity makes the
 * requirement stable across code changes; the app reports the distinction but never invents
 * or installs credentials for the user.
 */
export async function inspectMacOSDesktopAccess(
  helperPath: string,
  reply: Record<string, unknown>,
  parentPermissions: MacOSPermissionPair,
  error: string | null = null
): Promise<MacOSDesktopAccessStatus> {
  const [parent, backend] = await Promise.all([inspectIdentity(process.execPath), inspectIdentity(helperPath)]);
  const backendPermissions: MacOSPermissionPair = {
    screen: permission(reply['screenPermission']),
    accessibility: permission(reply['accessibilityPermission'])
  };
  return {
    // The backend result is the effective answer: it is the native code that will perform
    // the operation. The parent result owns prompting and should agree in packaged builds.
    ...backendPermissions,
    parentPermissions,
    backendPermissions,
    parent,
    backend,
    rebuildMayInvalidateAuthorization: parent.signingMode !== 'signed',
    checkedAt: Date.now(),
    error
  };
}
