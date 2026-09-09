/** Validates bounded native-file references and streams from trusted file hosts.
 * The schema requests ChatGPT native-file injection; a URL shape is not proof of who
 * authored a reference. Host/path checks and the approved-root write policy still apply.
 */

import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

const OPENAI_FILE_HOSTS = new Set([
  'files.oaiusercontent.com',
  // Exact image-generation download host in OpenAI's own executed cookbook:
  // https://github.com/openai/openai-cookbook/blob/main/examples/dalle/Image_generations_edits_and_variations_with_DALL-E.ipynb
  'oaidalleapiprodscus.blob.core.windows.net'
]);
// A customer-chosen Azure account prefix is not proof of OpenAI ownership. Regional
// hosts need exact verified entries; never trust a wildcard over that shared namespace.
const OPENAI_FILE_ID_MAX_LENGTH = 512;
const OPENAI_FILE_ID_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u;
const OPENAI_FILE_KEYS = new Set([
  'download_url',
  'file_id',
  'mime_type',
  'file_name',
  'name',
  'size'
]);
const OPENAI_FILE_REDIRECT_LIMIT = 3;
const OPENAI_FILE_DOWNLOAD_TIMEOUT_MS = 30_000;

export class ArtifactFetchError extends Error {}

export interface ArtifactSource {
  size?: number;
  stream: Readable;
}

export interface OpenAIFileReference {
  download_url: string;
  file_id: string;
  size?: number;
}

export interface OpenAIFileAdapterOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function isOpenAIFileReferenceCandidate(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length >= 2 &&
    keys.every((key) => OPENAI_FILE_KEYS.has(key)) &&
    Object.hasOwn(value, 'download_url') &&
    Object.hasOwn(value, 'file_id')
  );
}

export function normalizeOpenAIFileReference(value: unknown): OpenAIFileReference {
  if (!isOpenAIFileReferenceCandidate(value)) {
    throw new ArtifactFetchError('ChatGPT file reference is malformed.');
  }
  const downloadUrl = value['download_url'];
  const fileId = value['file_id'];
  if (typeof downloadUrl !== 'string' || downloadUrl.length > 16_384 || typeof fileId !== 'string' || !isValidOpenAIFileId(fileId)) {
    throw new ArtifactFetchError('ChatGPT file reference is malformed.');
  }
  const mimeType = nullableString(value['mime_type']);
  const fileName = nullableString(value['file_name']);
  const nameAlias = nullableString(value['name']);
  if (mimeType === null || fileName === null || nameAlias === null) {
    throw new ArtifactFetchError('ChatGPT file reference is malformed.');
  }
  let size: number | undefined;
  const rawSize = value['size'];
  if (rawSize !== undefined && rawSize !== null) {
    if (typeof rawSize !== 'number' || !Number.isSafeInteger(rawSize) || rawSize < 0) {
      throw new ArtifactFetchError('ChatGPT file reference is malformed.');
    }
    size = rawSize;
  }
  return {
    download_url: downloadUrl,
    file_id: fileId,
    size
  };
}

/** Fetch the trusted file URL and return its stream. Every redirect is re-validated. */
export async function openArtifactFile(
  value: unknown,
  options: OpenAIFileAdapterOptions = {}
): Promise<ArtifactSource> {
  const fetchFile = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? OPENAI_FILE_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ArtifactFetchError('Artifact download timeout must be a positive integer.');
  }
  const reference = normalizeOpenAIFileReference(value);

  let downloadUrl = validateOpenAIFileUrl(reference.download_url);
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= OPENAI_FILE_REDIRECT_LIMIT; redirect += 1) {
    try {
      response = await fetchFile(downloadUrl, {
        redirect: 'manual',
        signal
      });
    } catch {
      throw new ArtifactFetchError('ChatGPT file could not be downloaded.');
    }
    if (!isRedirectStatus(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirect === OPENAI_FILE_REDIRECT_LIMIT) {
      throw new ArtifactFetchError('ChatGPT file download returned an invalid redirect.');
    }
    try { downloadUrl = validateOpenAIFileUrl(new URL(location, downloadUrl).toString()); }
    catch (error) {
      if (error instanceof ArtifactFetchError) throw error;
      throw new ArtifactFetchError('ChatGPT file download returned an invalid redirect.');
    }
  }

  if (!response?.ok || !response.body) {
    await response?.body?.cancel().catch(() => undefined);
    throw new ArtifactFetchError('ChatGPT file download did not return file content.');
  }
  const responseSize = responseContentLength(response);
  if (reference.size !== undefined && responseSize !== undefined && reference.size !== responseSize) {
    await response.body.cancel().catch(() => undefined);
    throw new ArtifactFetchError('ChatGPT file metadata did not match the downloaded content.');
  }
  return { size: responseSize ?? reference.size,
    stream: Readable.fromWeb(response.body as unknown as NodeReadableStream) };
}

function nullableString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' && value.length <= 1024 ? value : null;
}

function isValidOpenAIFileId(value: string): boolean {
  return (
    value.length > 0 && value.length <= OPENAI_FILE_ID_MAX_LENGTH && !OPENAI_FILE_ID_CONTROL_PATTERN.test(value)
  );
}

export function validateOpenAIFileUrl(value: string): string {
  if (value.length > 16_384) throw new ArtifactFetchError('ChatGPT file download URL is invalid.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ArtifactFetchError('ChatGPT file download URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    !isTrustedOpenAIFileHost(url.hostname) ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    // Native signed URLs carry credentials and private file identity. The canonical
    // hostname alone makes a new regional host diagnosable without recording either.
    throw new ArtifactFetchError(`ChatGPT file download URL is outside the trusted file host (host: ${url.hostname.slice(0, 253) || 'none'}).`);
  }
  return url.toString();
}

function isTrustedOpenAIFileHost(hostname: string): boolean {
  // ChatGPT ImageGen uses regional hosts within OpenAI's documented file namespace:
  // https://help.openai.com/en/articles/9247338
  // A DNS-label boundary accepts those regions without accepting lookalike suffixes.
  // Azure remains exact-only: other Azure account names are independently controlled.
  return OPENAI_FILE_HOSTS.has(hostname) || hostname.endsWith('.oaiusercontent.com');
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function responseContentLength(response: Response): number | undefined {
  const value = response.headers.get('content-length');
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}
