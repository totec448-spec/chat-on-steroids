/**
 * A download that survives a dropped connection (2026-10-14: two canary builds in a row failed
 * on one ECONNRESET among 730 native source downloads).
 *
 * Retries network errors, timeouts, 429 and 5xx, each attempt with its own timeout. Any other
 * answer, a 404 included, is returned at once for the caller to judge, so a wrong URL still
 * fails on the first try. Checksums stay the caller's job.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

export async function fetchWithRetry(url, { timeoutMs = 180_000 } = {},
  { fetchImpl = fetch, delays = RETRY_DELAYS_MS, log = console.warn } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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
