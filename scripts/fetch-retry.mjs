/**
 * A download that survives a dropped connection (2026-10-14: two canary builds in a row failed
 * on one ECONNRESET among 730 native source downloads, and a third on the tunnel client). Every
 * packaging download goes through here.
 *
 * Retries network errors, timeouts, 429 and 5xx, each attempt with its own timeout. Any other
 * answer, a 404 included, is returned at once for the caller to judge, so a wrong URL still
 * fails on the first try. Checksums stay the caller's job.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

export async function fetchWithRetry(url, { timeoutMs = 180_000, headers } = {},
  { fetchImpl = fetch, delays = RETRY_DELAYS_MS, log = console.warn } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt >= delays.length) throw error;
      log(`Download of ${url} failed (${error?.cause?.code ?? error?.name ?? 'error'}); retrying.`);
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < delays.length) {
      log(`Download of ${url} answered HTTP ${response.status}; retrying.`);
      await response.body?.cancel().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      continue;
    }
    return response;
  }
}

/**
 * The first good answer from a source's address and then its mirrors, in order (2026-10-14:
 * cairographics.org answered one request in three). Each address gets fetchWithRetry's retries.
 * Returns the last non-OK answer when none is OK, and throws the last error when none answered.
 */
export async function fetchFirst(urls, options = {}, dependencies = {}) {
  let last = null;
  let failure = null;
  for (const url of urls) {
    try {
      const response = await fetchWithRetry(url, options, dependencies);
      if (response.ok) return response;
      last = response;
      (dependencies.log ?? console.warn)(`Download of ${url} answered HTTP ${response.status}; trying the next address.`);
    } catch (error) {
      failure = error;
      (dependencies.log ?? console.warn)(`Download of ${url} failed after retries; trying the next address.`);
    }
  }
  if (last) return last;
  throw failure;
}
