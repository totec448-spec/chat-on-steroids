import os from 'node:os';
import { DESKTOP_CAPABILITIES, type Capabilities, type PlatformInfo } from '../shared/types.js';

/** ScreenCaptureKit is present from macOS 12.3 (Darwin 21.4). */
export function macOSDesktopAutomationSupported(release: string): boolean {
  const [major = 0, minor = 0] = release.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return major > 21 || (major === 21 && minor >= 4);
}

export function desktopAutomationSupported(
  platform: NodeJS.Platform = process.platform,
  release?: string
): boolean {
  if (platform === 'win32') return true;
  if (platform !== 'darwin') return false;
  // An explicit cross-platform projection models a supported Mac. The real host uses its actual
  // Darwin release so Core remains available on macOS 12.0-12.2 while Desktop stays hidden.
  return release !== undefined || process.platform === 'darwin'
    ? macOSDesktopAutomationSupported(release ?? os.release())
    : true;
}

export function hostPlatformInfo(
  platform: NodeJS.Platform = process.platform,
  release?: string
): PlatformInfo {
  if (platform === 'win32') return { family: 'windows', name: 'Windows', desktopAutomation: true };
  if (platform === 'darwin') {
    return { family: 'macos', name: 'macOS', desktopAutomation: desktopAutomationSupported(platform, release) };
  }
  if (platform === 'linux') return { family: 'linux', name: 'Linux', desktopAutomation: false };
  return { family: 'other', name: platform, desktopAutomation: false };
}

/**
 * Linux does not yet have a native Desktop backend. Keep stored choices intact so a config moved
 * to Windows or macOS does not lose them, but make the live capability projection incapable of
 * advertising or executing those tools on unsupported hosts.
 *
 * This takes `control` down with it, and `control` is also what gates the `browser` tool — which
 * needs no operating-system permission at all, since it runs inside the extension's DevTools
 * session. So browser control is unavailable on Linux and pre-13 macOS even though it would
 * work there. That is deliberate for now rather than an oversight: the Desktop surface is hidden
 * wholesale on those hosts, and publishing a connector whose only working tool is the browser
 * one would need its own surface rather than a second gate inside this one.
 */
export function capabilitiesForPlatform(
  capabilities: Capabilities,
  platform: NodeJS.Platform = process.platform,
  release?: string
): Capabilities {
  if (desktopAutomationSupported(platform, release)) return capabilities;
  const next = { ...capabilities };
  for (const capability of DESKTOP_CAPABILITIES) next[capability] = false;
  return next;
}
