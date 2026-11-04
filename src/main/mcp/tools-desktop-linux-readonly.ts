/** The first native Linux Desktop surface is deliberately screenshots ONLY. */
import { z } from 'zod';
import sharp from 'sharp';
import { getConfig, effectiveCapabilities } from '../config.js';
import { runLinuxScreenshot, checkLinuxScreenshotVersion } from '../computer/linux-screenshot-backend.js';
import { LinuxScreenshotError, parseLinuxScreenshot } from '../computer/linux-screenshot.js';
import { MAX_VIEW_IMAGE_BYTES, validateImageBytes } from '../codex/view-image.js';
import { fail, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

const inputSchema = z.object({
  what: z.literal('screenshot'),
  display: z.literal(0).default(0)
}).strict();

function refused(): ToolResult | null {
  const cfg = getConfig();
  if (cfg.ui.linuxDesktopEnabled !== true) return fail('LINUX_DESKTOP_DISABLED: Enable native Linux screenshot access in Settings.');
  if (!effectiveCapabilities(cfg).screen) return fail('TOOL_DISABLED: Live Screen permission is required.');
  return null;
}

export function registerLinuxScreenshotTool(reg: SurfaceRegistrar): void {
  if (process.platform !== 'linux' || !(reg.ctx.exposedLinuxDesktop ?? getConfig().ui.linuxDesktopEnabled) ||
      !reg.exposedCaps.screen) return;
  reg.register('linux_observe', toolDeclaration('linux_observe', () => ({
    description: 'Read-only GNOME Wayland DISPLAY screenshot through the OS consent portal. This is not a window capture. Requires native Linux Desktop opt-in and live Screen permission; never clicks, types, scans accessibility refs, or retries a refused consent.',
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }), 'linux-screenshot-only'), async input => reg.guarded('screen', 'linux_observe', async () => {
    const denied = refused();
    if (denied) return denied;
    // Do not rely on the advertised Zod schema alone: internal callers can
    // invoke a handler directly, and a granted Screen is not an all-display grant.
    if (input.display !== 0) return fail('LINUX_SCREENSHOT_DISPLAY_UNSUPPORTED: only display 0 is available.');
    await checkLinuxScreenshotVersion();
    const afterVersion = refused();
    if (afterVersion) return afterVersion;
    const result = await runLinuxScreenshot({ kind: 'screenshot', display: input.display });
    // The person may revoke Screen while waiting at the GNOME consent portal.
    const afterPortal = refused();
    if (afterPortal) return afterPortal;
    if (!result.ok) {
      const code = (result.error as { code?: unknown } | null)?.code;
      return fail('LINUX_SCREENSHOT_BACKEND: ' + (typeof code === 'string' ? code.slice(0, 60) : 'UNKNOWN'));
    }
    try {
      const original = await parseLinuxScreenshot(result);
      let png = original.png;
      let resized = false;
      if (png.length > MAX_VIEW_IMAGE_BYTES) {
        resized = true;
        for (const width of [2560, 1920, 1280]) {
          png = await sharp(original.png).resize({ width, withoutEnlargement: true })
            .png({ compressionLevel: 9 }).toBuffer();
          if (png.length <= MAX_VIEW_IMAGE_BYTES) break;
        }
      }
      if (png.length > MAX_VIEW_IMAGE_BYTES || await validateImageBytes(png) !== 'image/png')
        return fail('LINUX_SCREENSHOT_INVALID: image exceeded transport budget or decoding failed.');
      const meta = await sharp(png).metadata();
      const revoked = refused();
      if (revoked) return revoked;
      const info = { scope: 'display', display: input.display, mimeType: 'image/png',
        width: meta.width, height: meta.height, sourceWidth: original.width,
        sourceHeight: original.height, resized };
      return { content: [
        { type: 'text', text: JSON.stringify(info) },
        { type: 'image', mimeType: 'image/png', data: resized ? png.toString('base64') : original.base64 }
      ], structuredContent: { value: info } };
    } catch (error) {
      return fail('LINUX_SCREENSHOT_INVALID: ' + (error instanceof LinuxScreenshotError ? error.code : 'PNG_PROCESSING_FAILED'));
    }
  }));
}
