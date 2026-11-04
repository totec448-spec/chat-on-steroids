/**
 * Exact agent-desktop 1.0.2 screenshot envelope boundary.
 *
 * Rust's screenshot::execute returns { data: <base64>, format: 'png', width,
 * height, scale_factor } INSIDE the outer envelope's data. No screenshot data,
 * even a malformed one, may be written to disk or echoed in an error.
 */
import sharp from 'sharp';
import { imageMime, validateImageStructure } from '../fsops.js';
import { MAX_DECODED_IMAGE_BYTES, MAX_DECODED_IMAGE_PIXELS } from '../codex/view-image.js';
import type { LinuxDesktopEnvelope } from './linux-screenshot-backend.js';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_BASE64_CHARS = 4 * Math.ceil(MAX_CAPTURE_BYTES / 3);

export class LinuxScreenshotError extends Error {
  constructor(readonly code: 'INVALID_SHAPE' | 'IMAGE_TOO_LARGE' | 'INVALID_BASE64' | 'INVALID_PNG' | 'INVALID_DIMENSIONS') {
    super(`Invalid native Linux screenshot (${code}); no screenshot was saved`);
    this.name = 'LinuxScreenshotError';
  }
}

export interface LinuxScreenshot {
  /** Private image bytes, never placed in logs, error messages or renderer IPC. */
  png: Buffer;
  base64: string;
  width: number;
  height: number;
}

/**
 * Rejects unrecognized formats, oversized payloads, malformed PNG structure,
 * inconsistent dimensions and bitstreams Sharp cannot fully decode.
 */
export async function parseLinuxScreenshot(result: LinuxDesktopEnvelope): Promise<LinuxScreenshot> {
  const payload = result.data;
  if (!result.ok || !payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new LinuxScreenshotError('INVALID_SHAPE');
  const value = payload as Record<string, unknown>;
  if (value.format !== 'png' || typeof value.data !== 'string')
    throw new LinuxScreenshotError('INVALID_SHAPE');
  const { data: base64 } = value;
  if (typeof value.width !== 'number' || !Number.isInteger(value.width) ||
      typeof value.height !== 'number' || !Number.isInteger(value.height) ||
      value.width < 1 || value.height < 1 || value.width * value.height > MAX_DECODED_IMAGE_PIXELS)
    throw new LinuxScreenshotError('INVALID_DIMENSIONS');
  if (base64.length > MAX_CAPTURE_BASE64_CHARS) throw new LinuxScreenshotError('IMAGE_TOO_LARGE');
  if (base64.length === 0 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw new LinuxScreenshotError('INVALID_BASE64');
  const png = Buffer.from(base64, 'base64');
  if (png.length > MAX_CAPTURE_BYTES) throw new LinuxScreenshotError('IMAGE_TOO_LARGE');
  if (imageMime(png) !== 'image/png') throw new LinuxScreenshotError('INVALID_PNG');
  try { validateImageStructure(png, 'image/png'); }
  catch { throw new LinuxScreenshotError('INVALID_PNG'); }
  try {
    const decoded = await sharp(png, {
      failOn: 'warning',
      limitInputPixels: MAX_DECODED_IMAGE_PIXELS,
      sequentialRead: true
    }).raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== value.width || decoded.info.height !== value.height ||
        decoded.info.channels < 1 || decoded.info.channels > 4 ||
        decoded.data.length > MAX_DECODED_IMAGE_BYTES ||
        decoded.data.length !== decoded.info.width * decoded.info.height * decoded.info.channels)
      throw new LinuxScreenshotError('INVALID_DIMENSIONS');
  } catch (error) {
    if (error instanceof LinuxScreenshotError) throw error;
    throw new LinuxScreenshotError('INVALID_PNG');
  }
  return { png, base64, width: value.width, height: value.height };
}
