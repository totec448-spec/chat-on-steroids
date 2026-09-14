import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  downloadNativeSource,
  NATIVE_SOURCE_MAX_ATTEMPTS,
  NATIVE_SOURCE_RETRY_DELAYS_MS,
} from '../scripts/native-source-download.mjs';

const good = Buffer.from('reviewed native source bytes');
const source = {
  file: 'native-source.tar.gz',
  url: 'https://sources.example.test/native-source.tar.gz',
  bytes: good.length,
  sha256: createHash('sha256').update(good).digest('hex'),
};

function response(status: number, chunks: Buffer[] = [], cancelled?: () => void) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
      cancel: async () => { cancelled?.(); },
    },
  };
}

const noSleep = vi.fn(async (_ms: number) => undefined);

describe('native source download retries', () => {
  it('retries the observed HTTP 406, discards its body and succeeds on the next attempt', async () => {
    let cancelled = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(406, [Buffer.from('error body')], () => cancelled++))
      .mockResolvedValueOnce(response(200, [good]));
    const sleep = vi.fn(async (_ms: number) => undefined);

    await expect(downloadNativeSource(source, { fetchImpl, sleep })).resolves.toEqual(good);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cancelled).toBe(1);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it('bounds retryable HTTP failures to three attempts with 1s/2s backoff', async () => {
    let cancelled = 0;
    const fetchImpl = vi.fn(async () => response(503, [], () => cancelled++));
    const sleep = vi.fn(async (_ms: number) => undefined);

    await expect(downloadNativeSource(source, { fetchImpl, sleep })).rejects.toThrow(/HTTP 503/);
    expect(fetchImpl).toHaveBeenCalledTimes(NATIVE_SOURCE_MAX_ATTEMPTS);
    expect(cancelled).toBe(NATIVE_SOURCE_MAX_ATTEMPTS);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(NATIVE_SOURCE_RETRY_DELAYS_MS);
  });

  it('retries fetch network failures but not arbitrary local errors', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(response(200, [good]));
    await expect(downloadNativeSource(source, { fetchImpl, sleep: noSleep })).resolves.toEqual(good);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const local = vi.fn().mockRejectedValue(new Error('programming error'));
    await expect(downloadNativeSource(source, { fetchImpl: local, sleep: noSleep })).rejects.toThrow('programming error');
    expect(local).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-transient HTTP status such as 404 and still discards the body', async () => {
    let cancelled = 0;
    const fetchImpl = vi.fn(async () => response(404, [Buffer.from('not found')], () => cancelled++));
    await expect(downloadNativeSource(source, { fetchImpl, sleep: noSleep })).rejects.toThrow(/HTTP 404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(1);
  });

  it('fails immediately when a successful response exceeds the reviewed byte size', async () => {
    const fetchImpl = vi.fn(async () => response(200, [good, Buffer.from('x')]));
    await expect(downloadNativeSource(source, { fetchImpl, sleep: noSleep })).rejects.toThrow(/exceeds reviewed size/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails immediately on wrong hash or a truncated successful body', async () => {
    const wrong = Buffer.from('reviewed native source byteX');
    expect(wrong.length).toBe(good.length);
    const wrongFetch = vi.fn(async () => response(200, [wrong]));
    await expect(downloadNativeSource(source, { fetchImpl: wrongFetch, sleep: noSleep })).rejects.toThrow(/checksum mismatch/);
    expect(wrongFetch).toHaveBeenCalledTimes(1);

    const shortFetch = vi.fn(async () => response(200, [good.subarray(0, good.length - 1)]));
    await expect(downloadNativeSource(source, { fetchImpl: shortFetch, sleep: noSleep })).rejects.toThrow(/checksum mismatch/);
    expect(shortFetch).toHaveBeenCalledTimes(1);
  });
});
