/**
 * Port of `codex-rs/core/src/tools/handlers/view_image.rs` and its spec in
 * `view_image_spec.rs`.
 *
 * Two adaptations, both forced by the transport:
 *
 * - Codex's internal result carries an `image_url`; MCP already has a native `image` content
 *   block, so the connector sends the bytes once through that transport instead of duplicating
 *   the same base64 again in structuredContent. The accepted formats are PNG, JPEG, GIF and WebP,
 *   which matches the format features enabled for Codex's `image` dependency in the current workspace.
 * - `image::load_from_memory` fully decodes the file to prove it is an image. The connector now
 *   does the same semantic check through Sharp/libvips for PNG, JPEG, GIF and WebP, under an
 *   explicit decoded-pixel/memory ceiling so a small compressed file cannot amplify without bound.
 *
 * Getting this wrong is not cosmetic. An `image` content block the consumer cannot decode breaks
 * the ChatGPT message stream and kills the whole turn, so anything short of proof is a rejection.
 *
 * `MAX_VIEW_IMAGE_BYTES` has no counterpart in Codex, whose only limit is the 512 MiB
 * `read_file` cap. MCP base64 expands the raw bytes by about 4/3, so the raw-byte ceiling
 * budgets the one native image copy plus ordinary JSON/result metadata inside an 8 MiB wire
 * envelope instead of pretending an 8 MiB source file is an 8 MiB response.
 */

import sharp from 'sharp';

import { getMetadata, readFile } from './filesystem.js';
import { imageMime, validateImageStructure, formatBytes, MAX_IMAGE_BYTES, type SupportedImageMime } from '../fsops.js';

export const VIEW_IMAGE_TOOL_NAME = 'view_image';

export const VIEW_IMAGE_DESCRIPTION =
  'View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.';

export const VIEW_IMAGE_PATH_DESCRIPTION = 'Local filesystem path to an image file.';

export const VIEW_IMAGE_DETAIL_DESCRIPTION =
  'Image detail level. Defaults to `high`; use `original` to preserve exact resolution.';

export const VIEW_IMAGE_UNSUPPORTED_MESSAGE =
  'view_image is not allowed because you do not support image inputs';

export const VIEW_IMAGE_INVALID_MESSAGE = 'unable to process image: invalid or unsupported image data';

/** Wire budget for the serialized base64 image plus ordinary JSON/result metadata. */
const MAX_VIEW_IMAGE_WIRE_BYTES = 8 * 1024 * 1024;
const MAX_VIEW_IMAGE_WIRE_OVERHEAD = 64 * 1024;
/** The connector's raw-image transport limit; see the module comment. */
export const MAX_VIEW_IMAGE_BYTES = Math.min(
  MAX_IMAGE_BYTES,
  Math.floor(((MAX_VIEW_IMAGE_WIRE_BYTES - MAX_VIEW_IMAGE_WIRE_OVERHEAD) * 3) / 4)
);
/** Bound decoded pixels independently of the compressed transport/file ceiling. */
export const MAX_DECODED_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_DECODED_IMAGE_PIXELS = 16 * 1024 * 1024;

/** `ImageDetail`, restricted to the two variants `view_image` can return. */
export type ImageDetail = 'high' | 'original';

/** `DEFAULT_IMAGE_DETAIL`. */
export const DEFAULT_IMAGE_DETAIL: ImageDetail = 'high';

/** `FunctionCallError::RespondToModel`: the message goes to the model verbatim. */
export class ViewImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewImageError';
  }
}

/** `ViewImageOutput`, plus the pieces an MCP `image` content block needs. */
export interface ViewImageResult {
  /** `image_url`: Codex's `data:application/octet-stream;base64,{encoded}`. */
  imageUrl: string;
  /** `detail`. */
  detail: ImageDetail;
  mimeType: SupportedImageMime;
  base64: string;
  bytes: number;
}

/** `ViewImageToolOptions`. `unified_image_budget` covers a history path that has no analogue here. */
export interface ViewImageOptions {
  canRequestOriginalImageDetail: boolean;
}

/** `ViewImageToolOptions::default`. */
export const DEFAULT_VIEW_IMAGE_OPTIONS: ViewImageOptions = {
  canRequestOriginalImageDetail: false
};

/**
 * The handler's detail parsing. Codex keeps accepting `high` and `original` after they disappear
 * from the advertised schema, and rejects anything else.
 */
export function parseViewImageDetail(detail: string | undefined | null): ImageDetail | null {
  if (detail === undefined || detail === null) return null;
  if (detail === 'high') return 'high';
  if (detail === 'original') return 'original';
  throw new ViewImageError(
    `view_image.detail only supports \`high\` or \`original\`; omit \`detail\` for default high resized behavior, got \`${detail}\``
  );
}

/** `data_url_from_bytes`. */
export function dataUrlFromBytes(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/**
 * Proves that the encoded bytes actually decode to pixels before they can enter an MCP image
 * result. This is the semantic boundary Codex gets from `image::load_from_memory`.
 *
 * Structural validators are useful for precise framing errors but they are not decoders: a WebP
 * can carry a plausible VP8 key-frame prefix and dimensions while the compressed bitstream after
 * that prefix is garbage. Sharp/libvips decodes PNG/JPEG/GIF/WebP here under an explicit pixel
 * ceiling. `raw().toBuffer()` is intentional; metadata-only parsing would reproduce the same bug.
 */
async function decodesToPixels(data: Buffer): Promise<boolean> {
  try {
    const decoded = await sharp(data, {
      failOn: 'warning',
      limitInputPixels: MAX_DECODED_IMAGE_PIXELS,
      sequentialRead: true
    })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = decoded.info;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false;
    if (!Number.isInteger(channels) || channels <= 0 || channels > 4) return false;
    if (width * height > MAX_DECODED_IMAGE_PIXELS) return false;
    if (decoded.data.length > MAX_DECODED_IMAGE_BYTES) return false;
    return decoded.data.length === width * height * channels;
  } catch {
    return false;
  }
}

/**
 * `ViewImageHandler::handle_call`, minus the parts that belong to systems out of scope: the
 * input-modality gate, environment resolution, the sandbox context and the turn-item events.
 *
 * `path` must already be absolute; Codex joins the relative path onto the environment cwd before
 * this point, and the connector resolves it against the approved roots instead.
 */
export async function viewImage(
  path: string,
  detail: ImageDetail | null,
  options: ViewImageOptions = DEFAULT_VIEW_IMAGE_OPTIONS,
  modelVisiblePath: string = path,
  maxBytes: number = MAX_VIEW_IMAGE_BYTES
): Promise<ViewImageResult> {
  let metadata;
  try {
    metadata = await getMetadata(path);
  } catch (error) {
    throw new ViewImageError(`unable to locate image at \`${modelVisiblePath}\`: ${describe(error, path, modelVisiblePath)}`);
  }

  if (!metadata.isFile) {
    throw new ViewImageError(`image path \`${modelVisiblePath}\` is not a file`);
  }

  const effectiveMaxBytes = Math.max(1, Math.min(MAX_VIEW_IMAGE_BYTES, Math.floor(maxBytes)));
  if (metadata.size > effectiveMaxBytes) {
    throw new ViewImageError(
      `unable to read image at \`${modelVisiblePath}\`: image is too large to return (${formatBytes(metadata.size)}; limit ${formatBytes(effectiveMaxBytes)})`
    );
  }

  let fileBytes: Buffer;
  try {
    // Enforce the image transport ceiling on the opened file handle too. The metadata check above
    // gives the useful error before opening in the common case, while this closes the growth race
    // between stat and read without ever allocating up to the generic 512 MiB file-read limit.
    fileBytes = await readFile(path, effectiveMaxBytes);
  } catch (error) {
    throw new ViewImageError(`unable to read image at \`${modelVisiblePath}\`: ${describe(error, path, modelVisiblePath)}`);
  }

  // Reject non-images before their bytes can reach the model.
  const mimeType = imageMime(fileBytes);
  if (mimeType === null) throw new ViewImageError(VIEW_IMAGE_INVALID_MESSAGE);
  try {
    validateImageStructure(fileBytes, mimeType);
  } catch {
    throw new ViewImageError(VIEW_IMAGE_INVALID_MESSAGE);
  }
  if (!(await decodesToPixels(fileBytes))) throw new ViewImageError(VIEW_IMAGE_INVALID_MESSAGE);

  const useOriginalDetail = options.canRequestOriginalImageDetail && detail === 'original';
  const imageDetail: ImageDetail = useOriginalDetail ? 'original' : DEFAULT_IMAGE_DETAIL;

  const base64 = fileBytes.toString('base64');
  return {
    imageUrl: dataUrlFromBytes('application/octet-stream', base64),
    detail: imageDetail,
    mimeType,
    base64,
    bytes: fileBytes.length
  };
}

/** anyhow's `Display`, which prints the outermost context only. */
function describe(error: unknown, realPath: string, modelVisiblePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  // Native fs errors commonly repeat the host path. Preserve Codex's message shape without
  // exposing the connector's sandbox-internal Windows path to the model.
  return realPath === modelVisiblePath ? message : message.split(realPath).join(modelVisiblePath);
}
