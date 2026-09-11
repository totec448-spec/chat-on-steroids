import { expect, it, vi } from 'vitest';
// @ts-ignore Diagnostic scripts are intentionally plain ESM JavaScript.
import { benchmarkMcpLatency, benchmarkFromEnvironment } from '../scripts/benchmark-mcp-latency.mjs';

const urls = { localUrl: 'http://127.0.0.1:12345/mcp/local-path-secret', tunnelUrl: 'https://tunnel.invalid/mcp/tunnel-path-secret' };
const reply = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] } };
const json = JSON.stringify(reply);

it('alternates identical read-only requests sequentially, handles JSON/SSE, and reports no credentials or URLs', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let active = 0, peak = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    return url === urls.localUrl ? new Response(json) : new Response(`: keepalive\n\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\nevent: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":${JSON.stringify(reply.result)}}\n\n`);
  });
  const result = await benchmarkFromEnvironment({
    CLF_BENCH_LOCAL_URL: urls.localUrl, CLF_BENCH_TUNNEL_URL: urls.tunnelUrl,
    CLF_BENCH_LOCAL_BEARER: 'local-auth-secret', CLF_BENCH_TUNNEL_BEARER: 'tunnel-auth-secret', CLF_BENCH_ROUNDS: '3'
  }, fetchImpl);
  expect(peak).toBe(1);
  expect(requests.map(request => request.url)).toEqual(Array.from({ length: 3 }, () => [urls.localUrl, urls.tunnelUrl]).flat());
  expect(new Set(requests.map(request => request.init.body)).size).toBe(1);
  for (const [index, request] of requests.entries()) {
    expect(request.init.method).toBe('POST');
    expect(request.init.redirect).toBe('error');
    expect(JSON.parse(String(request.init.body))).toMatchObject({ jsonrpc: '2.0', method: 'tools/list' });
    expect(JSON.parse(String(request.init.body)).params).not.toHaveProperty('arguments');
    expect(JSON.parse(String(request.init.body)).params).not.toHaveProperty('_meta');
    expect(new Headers(request.init.headers).get('authorization')).toBe(index % 2 === 0 ? 'Bearer local-auth-secret' : 'Bearer tunnel-auth-secret');
  }
  expect(result.routes.local.responseBodyBytes).toEqual({ p50: Buffer.byteLength(json), p95: Buffer.byteLength(json) });
  for (const route of ['local', 'tunnel']) {
    expect(result.routes[route].statuses).toEqual({ 200: 3 });
    expect(result.routes[route].firstBodyByteMs.p95).toBeGreaterThanOrEqual(result.routes[route].firstBodyByteMs.p50);
    expect(result.routes[route].fullBodyMs.p50).toBeGreaterThanOrEqual(result.routes[route].firstBodyByteMs.p50);
  }
  expect(JSON.stringify(result)).not.toMatch(/secret|127\.0\.0\.1|tunnel\.invalid|fixture/);
});

it.each([
  ['transport', () => { throw new Error('tunnel-path-secret Authorization tunnel-auth-secret'); }, 'Transport failed'],
  ['HTTP', () => new Response('tunnel-path-secret', { status: 403 }), 'HTTP 403'],
  ['RPC', () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'tunnel-auth-secret' } })), 'RPC error'],
  ['malformed', () => new Response('data: tunnel-auth-secret\n\n'), 'Invalid JSON-RPC'],
  ['wrong ID', () => new Response(JSON.stringify({ ...reply, id: 2 })), 'Expected one tools/list']
] as const)('refuses %s failure without retrying or exposing remote error contents', async (_label, respond, message) => {
  const fetchImpl = vi.fn(respond);
  const error = await benchmarkMcpLatency({ ...urls, rounds: 2, fetchImpl }).catch((error: Error) => error);
  expect(error.message).toContain(message);
  expect(error.message).not.toMatch(/secret|Authorization/);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('bounds chunked responses before concatenating or parsing and cancels the remaining stream', async () => {
  const cancel = vi.fn();
  const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(101)); }, cancel
  })));
  await expect(benchmarkMcpLatency({ ...urls, rounds: 1, maxBytes: 100, fetchImpl })).rejects.toThrow('Response exceeds byte limit');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('rejects oversized declared responses without reading the body', async () => {
  const fetchImpl = vi.fn(async () => new Response(json, { headers: { 'content-length': '1000000' } }));
  await expect(benchmarkMcpLatency({ ...urls, rounds: 1, maxBytes: 100, fetchImpl })).rejects.toThrow('Response exceeds byte limit');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each(['fetch', 'body'])('bounds a stalled %s and aborts without starting another route', async stage => {
  let signal: AbortSignal | undefined;
  const cancel = vi.fn();
  const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal!;
    return stage === 'fetch' ? new Promise<Response>(() => {}) : Promise.resolve(new Response(new ReadableStream({ cancel })));
  });
  await expect(benchmarkMcpLatency({ ...urls, rounds: 1, timeoutMs: 10, fetchImpl })).rejects.toThrow('Request timed out');
  expect(signal?.aborted).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  if (stage === 'body') expect(cancel).toHaveBeenCalledTimes(1);
});

it('refuses differing catalogs instead of comparing unrelated surfaces or changing discovery', async () => {
  const fetchImpl = vi.fn(async () => new Response(json)).mockResolvedValueOnce(new Response(JSON.stringify({ ...reply, result: { tools: [] } })));
  await expect(benchmarkMcpLatency({ ...urls, rounds: 2, fetchImpl })).rejects.toThrow('comparison refused');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it.each([
  { rounds: 21 }, { rounds: 0 }, { timeoutMs: 30_001 }, { maxBytes: 8 * 1024 * 1024 + 1 },
  { localUrl: 'https://remote.invalid/local-path-secret' }, { tunnelUrl: 'http://remote.invalid/tunnel-path-secret' },
  { tunnelUrl: 'https://user:tunnel-auth-secret@remote.invalid/' }, { localBearer: 'tunnel-auth-secret\r\nInjected: yes' }
])('validates explicit bounded settings before making any request: %j', async options => {
  const fetchImpl = vi.fn();
  const error = await benchmarkMcpLatency({ ...urls, ...options, fetchImpl }).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain('secret');
  expect(fetchImpl).not.toHaveBeenCalled();
});
