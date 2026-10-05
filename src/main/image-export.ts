/**
 * Saves the original of an image ChatGPT generated in a chat into an approved folder (#889).
 *
 * The recording keeps only a bounded preview of a generated image (WebP, at most 1600 px), so the
 * original has to come from ChatGPT itself. The page that shows the image already holds it: its
 * `<img>` loads ChatGPT's own same-origin URL (or a page `blob:`), and the page script fetches
 * exactly that, with the page's own session. No signed URL, cookie or file credential reaches this
 * app or the model, and the app never contacts ChatGPT for it.
 *
 * Flow: the tool call registers one export here; `/status` hands it to the browser, which routes
 * it to the tab showing that chat; the page posts the bytes to `/image-export`; this module checks
 * them (size, a real PNG/JPEG/WebP that decodes) and writes them without ever replacing a file.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { rawPromises as fs } from './rawfs.js';
import { wakeBrowserWork } from './browser-wake.js';
import { logInfo } from './logger.js';

/** The largest original accepted; generated images are a few megabytes. */
export const MAX_IMAGE_EXPORT_BYTES = 25 * 1024 * 1024;
/** How long a tool call waits for the page to deliver the image. */
export const IMAGE_EXPORT_TIMEOUT_MS = 60_000;
/** Base64 of the largest original plus the JSON around it. */
export const IMAGE_EXPORT_BODY_BYTES = Math.ceil(MAX_IMAGE_EXPORT_BYTES / 3) * 4 + 64 * 1024;

const FORMATS: Record<string, string> = { png: '.png', jpeg: '.jpg', webp: '.webp' };
const EXTENSIONS: Record<string, string> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };

export interface ImageExportTarget {
  /** Real destination path, already resolved inside an approved root. */
  real: string;
  /** The same path as the model and the user see it. */
  virtual: string;
}
export interface ImageExportResult { virtual: string; format: string; width: number; height: number; bytes: number }

/** Page-side refusals, in words a person can act on. */
const PAGE_ERRORS: Record<string, string> = {
  not_open: 'the chat is not open in the browser. Open it in ChatGPT and try again.',
  not_rendered: 'the image is not shown on the chat\'s page right now. Scroll it into view in ChatGPT and try again.',
  fetch_failed: 'ChatGPT did not hand out the image file.',
  not_image: 'ChatGPT answered with something that is not an image.',
  too_large: `the image is larger than ${MAX_IMAGE_EXPORT_BYTES / 1024 / 1024} MB.`,
  unsupported: 'this browser companion cannot save images yet. Update the browser extension and try again.'
};

interface Pending {
  nonce: string;
  conversationId: string;
  messageId: string;
  assetId: string;
  target: ImageExportTarget;
  expiresAt: number;
  settle: (result: ImageExportResult | Error) => void;
}
const pending = new Map<string, Pending>();

export class ImageExportError extends Error {}

/** Exports waiting for the browser, without their destinations: those never leave the app. */
export function pendingImageExports(now = Date.now()): Array<{ nonce: string; conversationId: string; messageId: string; assetId: string }> {
  for (const entry of [...pending.values()]) if (now >= entry.expiresAt) entry.settle(new ImageExportError('the browser did not deliver the image in time. Make sure the chat is open in ChatGPT and try again.'));
  return [...pending.values()].map(({ nonce, conversationId, messageId, assetId }) => ({ nonce, conversationId, messageId, assetId }));
}

/** The extension a saved image gets: the one asked for, or the format's own when none was given. */
export function exportFileName(requested: string, format: string): string {
  const own = FORMATS[format];
  if (!own) throw new ImageExportError(`ChatGPT delivered an unsupported image format (${format}).`);
  const extension = path.extname(requested).toLowerCase();
  if (!extension) return requested + own;
  const named = EXTENSIONS[extension];
  if (!named) throw new ImageExportError(`the image is a ${format.toUpperCase()}; name the file with ${own} (or leave the extension out).`);
  if (named !== format) throw new ImageExportError(`the image is a ${format.toUpperCase()}, not ${extension}; name the file with ${own} (or leave the extension out).`);
  return requested;
}

/** Asks the browser for one image and resolves once it is saved, or rejects with a readable reason. */
export function exportImage(
  image: { conversationId: string; messageId: string; assetId: string },
  target: ImageExportTarget,
  timeoutMs = IMAGE_EXPORT_TIMEOUT_MS
): Promise<ImageExportResult> {
  return new Promise((resolve, reject) => {
    const nonce = randomUUID();
    const timer = setTimeout(() => entry.settle(new ImageExportError('the browser did not deliver the image in time. Make sure the chat is open in ChatGPT and try again.')), timeoutMs);
    timer.unref?.();
    const entry: Pending = {
      nonce, ...image, target, expiresAt: Date.now() + timeoutMs,
      settle: (result) => {
        if (pending.get(nonce) !== entry) return;
        pending.delete(nonce);
        clearTimeout(timer);
        if (result instanceof Error) reject(result); else resolve(result);
      }
    };
    pending.set(nonce, entry);
    logInfo(`image export requested id=${nonce} conversation=${image.conversationId}`);
    wakeBrowserWork();
  });
}

/**
 * The page's answer for one export: base64 bytes, or a refusal code. Returns false for an unknown
 * or settled nonce, so a late or repeated delivery changes nothing.
 */
export async function completeImageExport(raw: unknown): Promise<boolean> {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const entry = typeof body.nonce === 'string' ? pending.get(body.nonce) : undefined;
  if (!entry) return false;
  if (typeof body.error === 'string') {
    entry.settle(new ImageExportError(PAGE_ERRORS[body.error] ?? 'the browser could not read the image.'));
    return true;
  }
  if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) {
    entry.settle(new ImageExportError('the browser sent the image in an unreadable form.'));
    return true;
  }
  try {
    entry.settle(await save(Buffer.from(body.data, 'base64'), entry.target));
  } catch (error) {
    entry.settle(error instanceof ImageExportError ? error : new ImageExportError(`the image could not be saved: ${(error as Error).message}`));
  }
  return true;
}

async function save(bytes: Buffer, target: ImageExportTarget): Promise<ImageExportResult> {
  if (bytes.length === 0) throw new ImageExportError('ChatGPT handed out an empty image file.');
  if (bytes.length > MAX_IMAGE_EXPORT_BYTES) throw new ImageExportError(PAGE_ERRORS.too_large!);
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
    // Decoding the pixels, not only the header, proves the file is a whole image.
    await sharp(bytes, { limitInputPixels: 100_000_000 }).stats();
  } catch { throw new ImageExportError('ChatGPT handed out a file that is not a readable image.'); }
  const format = metadata.format ?? 'unknown';
  const file = exportFileName(target.real, format);
  const virtual = exportFileName(target.virtual, format);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Written beside the destination, then linked into place: a link never replaces an existing
  // file, so a name taken meanwhile fails instead of being overwritten, and no half file appears.
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.part`);
  await fs.writeFile(temporary, bytes, { flag: 'wx' });
  try {
    await fs.link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ImageExportError(`${virtual} already exists. Choose another name.`);
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
  const result = { virtual, format, width: metadata.width ?? 0, height: metadata.height ?? 0, bytes: bytes.length };
  logInfo(`image export saved ${virtual} (${result.width}x${result.height} ${format}, ${bytes.length} bytes)`);
  return result;
}

export function resetImageExportsForTests(): void {
  for (const entry of [...pending.values()]) entry.settle(new ImageExportError('reset'));
}
