/**
 * A one-shot screenshot permission check, initiated only by a click in CoS Settings.
 * GNOME needs the requesting application's own window to be foregrounded before it can
 * show its portal consent dialog. Never ask the portal in a background retry loop.
 *
 * The screenshot is handled in this process only. No image bytes, base64 or paths are
 * returned to the renderer, written to disk, or included in logs.
 */
import { checkLinuxDesktopVersion, runLinuxDesktop, type LinuxDesktopCommand, type LinuxDesktopEnvelope } from './linux-agent-desktop.js';
import { parseLinuxScreenshot } from './linux-screenshot.js';

export interface LinuxScreenshotConsentDependencies {
  focused: () => boolean;
  enabled: () => boolean;
  screenAllowed: () => boolean;
  checkVersion?: () => Promise<void>;
  run?: (command: LinuxDesktopCommand) => Promise<LinuxDesktopEnvelope>;
}

export async function testLinuxScreenshotConsent(deps: LinuxScreenshotConsentDependencies): Promise<{ pngBytes: number }> {
  if (process.platform !== 'linux') throw new Error('Native Linux screenshot consent is available only on Linux.');
  if (!deps.enabled() || !deps.screenAllowed()) throw new Error('Enable native Linux Desktop and Screen access first.');
  if (!deps.focused()) throw new Error('Activate the Chat On Steroids window before requesting screenshot permission.');
  await (deps.checkVersion ?? checkLinuxDesktopVersion)();
  // User focus and live settings can change while checking the backend version.
  if (!deps.enabled() || !deps.screenAllowed()) throw new Error('Screen access was disabled before the screenshot request.');
  if (!deps.focused()) throw new Error('The Chat On Steroids window lost focus; no screenshot was requested.');
  const result = await (deps.run ?? runLinuxDesktop)({ kind: 'screenshot', display: 0 });
  if (!result.ok) {
    const error = result.error as { code?: unknown } | null;
    const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
    // Only report the backend error code. Backend details could contain arbitrary
    // application text, and a failed consent is never grounds for an automatic retry.
    throw new Error(`GNOME screenshot portal returned ${code}. No image was saved.`);
  }
  const screenshot = await parseLinuxScreenshot(result);
  return { pngBytes: screenshot.png.byteLength };
}
