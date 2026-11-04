/**
 * A one-shot screenshot permission check, initiated only by a click in CoS Settings.
 * GNOME needs the requesting application's own window to be foregrounded before it can
 * show its portal consent dialog. Never ask the portal in a background retry loop.
 *
 * The screenshot is handled in this process only. No image bytes, base64 or paths are
 * returned to the renderer, written to disk, or included in logs.
 */
import { checkLinuxScreenshotVersion, runLinuxScreenshot, type LinuxScreenshotCommand, type LinuxDesktopEnvelope } from './linux-screenshot-backend.js';
import { parseLinuxScreenshot } from './linux-screenshot.js';
import { logInfo } from '../logger.js';

export interface LinuxScreenshotConsentDependencies {
  focused: () => boolean;
  enabled: () => boolean;
  screenAllowed: () => boolean;
  checkVersion?: () => Promise<void>;
  run?: (command: LinuxScreenshotCommand) => Promise<LinuxDesktopEnvelope>;
}

export async function testLinuxScreenshotConsent(deps: LinuxScreenshotConsentDependencies): Promise<{ pngBytes: number }> {
  if (process.platform !== 'linux') {
    logInfo('linux screenshot consent: refused because the platform is not Linux');
    throw new Error('Native Linux screenshot consent is available only on Linux.');
  }
  if (!deps.enabled() || !deps.screenAllowed()) {
    logInfo('linux screenshot consent: refused because native Linux Desktop or Screen access is disabled');
    throw new Error('Enable native Linux Desktop and Screen access first.');
  }
  if (!deps.focused()) {
    logInfo('linux screenshot consent: refused because the main window is not focused');
    throw new Error('Activate the Chat On Steroids window before requesting screenshot permission.');
  }
  await (deps.checkVersion ?? checkLinuxScreenshotVersion)();
  // User focus and live settings can change while checking the backend version.
  if (!deps.enabled() || !deps.screenAllowed()) {
    logInfo('linux screenshot consent: refused because native Linux Desktop or Screen access was disabled before the screenshot request');
    throw new Error('Screen access was disabled before the screenshot request.');
  }
  if (!deps.focused()) {
    logInfo('linux screenshot consent: refused because the main window lost focus during the version check');
    throw new Error('The Chat On Steroids window lost focus; no screenshot was requested.');
  }
  const result = await (deps.run ?? runLinuxScreenshot)({ kind: 'screenshot', display: 0 });
  if (!result.ok) {
    const error = result.error as { code?: unknown } | null;
    // A code is only kept when it looks like one: backend text could carry application content.
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'UNKNOWN';
    // The backend does not say whether GNOME refused or something else failed, so neither does this line.
    logInfo(`linux screenshot consent: refused because the screenshot backend returned ${code}`);
    // Only report the backend error code. Backend details could contain arbitrary
    // application text, and a failed consent is never grounds for an automatic retry.
    throw new Error(`GNOME screenshot portal returned ${code}. No image was saved.`);
  }
  const screenshot = await parseLinuxScreenshot(result);
  // Consent is not a durable grant: Screen permission or native opt-in may
  // have been revoked while GNOME displayed the portal or decoded the image.
  if (!deps.enabled() || !deps.screenAllowed()) {
    logInfo('linux screenshot consent: discarded the capture because native Linux Desktop or Screen access was disabled during the request');
    throw new Error('Native Linux Desktop or Screen access was disabled during the screenshot request.');
  }
  return { pngBytes: screenshot.png.byteLength };
}
