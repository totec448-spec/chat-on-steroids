import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readDurable, writeDurableNow } from '../durable.js';
import type { MacOSPermissionState } from '../../shared/types.js';

/**
 * macOS Screen Recording and Accessibility grants across updates.
 *
 * macOS keeps these grants per code signature. Releases are ad-hoc signed, so every update is a
 * new app to it: the switch in System Settings stays on, but no longer applies (live 2026-10-15).
 * Remembering that a permission was granted once tells that case apart from one never given,
 * and resetting this app's own entries lets macOS ask again, which is the repair.
 */

/** electron-builder's `appId`, the bundle macOS files the grants under. */
export const MACOS_BUNDLE_ID = 'com.chatonsteroids.app';

export type MacOSPermission = 'screen' | 'accessibility';
export interface MacOSGrantsSeen { screen: boolean; accessibility: boolean }

const STORE = 'macos-permission-grants';
const SERVICES: Record<MacOSPermission, string> = { screen: 'ScreenCapture', accessibility: 'Accessibility' };

/** Records the permissions granted now; returns every permission ever granted to this app. */
export async function noteMacOSGrants(status: Record<MacOSPermission, MacOSPermissionState>): Promise<MacOSGrantsSeen> {
  const saved = await readDurable<Partial<MacOSGrantsSeen>>(STORE);
  const seen: MacOSGrantsSeen = {
    screen: saved?.screen === true || status.screen === 'granted',
    accessibility: saved?.accessibility === true || status.accessibility === 'granted'
  };
  if (seen.screen !== (saved?.screen === true) || seen.accessibility !== (saved?.accessibility === true)) {
    await writeDurableNow(STORE, seen);
  }
  return seen;
}

type Run = (file: string, args: string[]) => Promise<unknown>;
/** Bound when a repair runs, not at load: nothing else in the Desktop backend starts programs. */
const execFileAsync: Run = (file, args) => promisify(execFile)(file, args);

/** Removes this app's own entries, so macOS asks again for the build that is running now. */
export async function resetMacOSPermissions(permissions: readonly MacOSPermission[], run: Run = execFileAsync): Promise<void> {
  for (const permission of permissions) await run('/usr/bin/tccutil', ['reset', SERVICES[permission], MACOS_BUNDLE_ID]);
}

export interface RepairSteps {
  reset(permissions: readonly MacOSPermission[]): Promise<void>;
  /** Asks for a screen source: what makes macOS list the app and prompt for Screen Recording. */
  requestScreen(): Promise<void>;
  /** Reads the live state again; prompting for Accessibility is Electron's own request. */
  refresh(options: { promptAccessibility: boolean }): Promise<void>;
}

/** Resets the missing permissions and has macOS ask for each again; returns what was reset. */
export async function repairMacOSPermissions(status: Record<MacOSPermission, MacOSPermissionState>, steps: RepairSteps): Promise<MacOSPermission[]> {
  const missing = (['screen', 'accessibility'] as const).filter(permission => status[permission] === 'missing');
  if (missing.length) await steps.reset(missing);
  if (missing.includes('screen')) await steps.requestScreen().catch(() => undefined);
  await steps.refresh({ promptAccessibility: missing.includes('accessibility') });
  return missing;
}
