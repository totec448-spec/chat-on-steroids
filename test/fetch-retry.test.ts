import { describe, expect, it } from 'vitest';
// @ts-expect-error The download helper is a plain Node script without type declarations.
import { fetchWithRetry } from '../scripts/fetch-retry.mjs';

const ok = (body = 'x') => new Response(body, { status: 200 });
const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
const noWait = { delays: [0, 0, 0] };

describe('fetchWithRetry (native source downloads)', () => {
  it('retries a dropped connection and returns the next answer', async () => {
    const answers: Array<() => Response> = [() => { throw reset(); }, () => ok('done')];
    const calls: string[] = [];
    const response = await fetchWithRetry('https://example.test/a.tar.gz', {}, { ...noWait,
      fetchImpl: async (url: string) => { calls.push(url); return answers.shift()!(); }, log: () => undefined });
    expect(await response.text()).toBe('done');
    expect(calls).toHaveLength(2);
  });

  it('retries server errors and rate limits, but not a missing file', async () => {
    const statuses = [503, 429, 200];
    const response = await fetchWithRetry('https://example.test/b', {}, { ...noWait,
      fetchImpl: async () => new Response('', { status: statuses.shift()! }), log: () => undefined });
    expect(response.status).toBe(200);

    let calls = 0;
    const missing = await fetchWithRetry('https://example.test/c', {}, { ...noWait,
      fetchImpl: async () => { calls += 1; return new Response('', { status: 404 }); }, log: () => undefined });
    expect(missing.status).toBe(404);
    expect(calls).toBe(1);
  });

  it('gives up after the last attempt with the original error and names the URL in its log', async () => {
    const logged: string[] = [];
    let calls = 0;
    await expect(fetchWithRetry('https://example.test/d', {}, { ...noWait,
      fetchImpl: async () => { calls += 1; throw reset(); }, log: (line: string) => logged.push(line) })).rejects.toThrow('fetch failed');
    expect(calls).toBe(4);
    expect(logged.join('\n')).toContain('https://example.test/d');
  });

  it('gives each attempt its own timeout', async () => {
    const signals: AbortSignal[] = [];
    const answers: Array<() => Response> = [() => { throw reset(); }, () => ok()];
    await fetchWithRetry('https://example.test/e', { timeoutMs: 1_000 }, { ...noWait,
      fetchImpl: async (_url: string, init: { signal: AbortSignal }) => { signals.push(init.signal); return answers.shift()!(); }, log: () => undefined });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});

// fetchFirst is imported by the same untyped script module as fetchWithRetry.
describe('fetchFirst (a source with mirrors)', () => {
  it('falls back to the next mirror when the original keeps failing or is missing', async () => {
    const { fetchFirst } = await import('../scripts/fetch-retry.mjs' as string) as { fetchFirst: (urls: string[], o: object, d: object) => Promise<Response> };
    const calls: string[] = [];
    const answer = await fetchFirst(['https://origin.test/a', 'https://mirror.test/a'], {}, { ...noWait, log: () => undefined,
      fetchImpl: async (url: string) => { calls.push(url); if (url.startsWith('https://origin')) throw reset(); return ok('from mirror'); } });
    expect(await answer.text()).toBe('from mirror');
    expect(calls.filter(url => url.startsWith('https://origin'))).toHaveLength(4);

    const missing = await fetchFirst(['https://origin.test/b', 'https://mirror.test/b'], {}, { ...noWait, log: () => undefined,
      fetchImpl: async (url: string) => url.startsWith('https://origin') ? new Response('', { status: 404 }) : ok('mirror b') });
    expect(await missing.text()).toBe('mirror b');
  });

  it('reports the last failure when every address fails', async () => {
    const { fetchFirst } = await import('../scripts/fetch-retry.mjs' as string) as { fetchFirst: (urls: string[], o: object, d: object) => Promise<Response> };
    const last = await fetchFirst(['https://origin.test/c', 'https://mirror.test/c'], {}, { ...noWait, log: () => undefined,
      fetchImpl: async (url: string) => new Response('', { status: url.startsWith('https://origin') ? 503 : 404 }) });
    expect(last.status).toBe(404);
    await expect(fetchFirst(['https://origin.test/d'], {}, { ...noWait, log: () => undefined, fetchImpl: async () => { throw reset(); } }))
      .rejects.toThrow('fetch failed');
  });
});

// 2026-10-14: a canary build failed on "Could not bundle tunnel-client: fetch failed", one dropped
// connection in a packaging download that had no retry.
describe('packaging downloads', () => {
  it('sends the request headers on every attempt', async () => {
    const seen: Array<string | null> = [];
    const answers: Array<() => Response> = [() => { throw reset(); }, () => ok()];
    await fetchWithRetry('https://example.test/h', { headers: { 'user-agent': 'chat-on-steroids-build' } }, { ...noWait, log: () => undefined,
      fetchImpl: async (_url: string, init: RequestInit) => { seen.push(new Headers(init.headers).get('user-agent')); return answers.shift()!(); } });
    expect(seen).toEqual(['chat-on-steroids-build', 'chat-on-steroids-build']);
  });

  it.each(['fetch-tunnel-client.mjs', 'fetch-ripgrep.mjs', 'prepare-packaging-native.mjs', 'package-native-sources.mjs'])(
    '%s downloads through the retrying helper', async script => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync(`scripts/${script}`, 'utf8');
      expect(source).not.toMatch(/(?<![\w.])fetch\(/);
      expect(source).toMatch(/fetch(?:WithRetry|First)\(/);
    });
});
