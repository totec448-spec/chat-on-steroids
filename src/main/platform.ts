import { DESKTOP_CAPABILITIES, type Capabilities, type PlatformInfo } from '../shared/types.js';

export function desktopAutomationSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

export function hostPlatformInfo(platform: NodeJS.Platform = process.platform): PlatformInfo {
  if (platform === 'win32') return { family: 'windows', name: 'Windows', desktopAutomation: true };
  if (platform === 'darwin') return { family: 'macos', name: 'macOS', desktopAutomation: false };
  if (platform === 'linux') return { family: 'linux', name: 'Linux', desktopAutomation: false };
  return { family: 'other', name: platform, desktopAutomation: false };
}

/**
 * Desktop control is deliberately not part of the macOS/Linux port. Keep stored choices intact
 * so a config moved back to Windows does not mysteriously lose them, but make the live capability
 * projection incapable of advertising or executing those tools anywhere else.
 */
export function capabilitiesForPlatform(
  capabilities: Capabilities,
  platform: NodeJS.Platform = process.platform
): Capabilities {
  if (desktopAutomationSupported(platform)) return capabilities;
  const next = { ...capabilities };
  for (const capability of DESKTOP_CAPABILITIES) next[capability] = false;
  return next;
}
