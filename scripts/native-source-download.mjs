import { createHash } from 'node:crypto';

export const NATIVE_SOURCE_MAX_ATTEMPTS = 3;
export const NATIVE_SOURCE_RETRY_DELAYS_MS = [1_000, 2_000];
export const NATIVE_SOURCE_ATTEMPT_TIMEOUT_MS = 180_000;

function retryableHttpStatus(status) {
  return status === 406 || status === 408 || status === 429 || status >= 500 && status <= 599;
}

function retryableNetworkError(error) {
  return error instanceof TypeError || error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

async function discardBody(response) {
  try { await response?.body?.cancel?.(); }
  catch { /* A failed response is already unusable; discard is best effort. */ }
}

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Download one reviewed source without weakening its pinned byte/hash identity. */
export async function downloadNativeSource(source, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? NATIVE_SOURCE_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? NATIVE_SOURCE_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(source.url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (!retryableNetworkError(error) || attempt === maxAttempts) throw error;
      await sleep(NATIVE_SOURCE_RETRY_DELAYS_MS[attempt - 1] ?? NATIVE_SOURCE_RETRY_DELAYS_MS.at(-1));
      continue;
    }

    if (!response.ok) {
      await discardBody(response);
      const error = new Error(`Native source download failed: ${source.file}: HTTP ${response.status}`);
      if (!retryableHttpStatus(response.status) || attempt === maxAttempts) throw error;
      await sleep(NATIVE_SOURCE_RETRY_DELAYS_MS[attempt - 1] ?? NATIVE_SOURCE_RETRY_DELAYS_MS.at(-1));
      continue;
    }

    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > source.bytes) throw new Error(`Native source exceeds reviewed size: ${source.file}`);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        throw new Error(`Native source checksum mismatch: ${source.file}`);
      }
      return bytes;
    } catch (error) {
      // Integrity failures are deterministic and must never be retried. A stream-level
      // network/timeout failure is transient in the same way as fetch() rejecting.
      if (!retryableNetworkError(error) || attempt === maxAttempts) throw error;
      await discardBody(response);
      await sleep(NATIVE_SOURCE_RETRY_DELAYS_MS[attempt - 1] ?? NATIVE_SOURCE_RETRY_DELAYS_MS.at(-1));
    }
  }

  throw new Error(`Native source download failed: ${source.file}`);
}
