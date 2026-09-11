/**
 * Explicit, read-only network-path comparison; never discovers running app credentials.
 * Set CLF_BENCH_LOCAL_URL and CLF_BENCH_TUNNEL_URL, then run this file with Node.
 * Optional: CLF_BENCH_ROUNDS (default 5, max 20), CLF_BENCH_TIMEOUT_MS (10000, max 30000),
 * CLF_BENCH_MAX_BYTES (2 MiB, max 8 MiB), and per-route CLF_BENCH_{LOCAL,TUNNEL}_BEARER.
 * URLs, credentials, response contents and transport exception messages are never printed.
 *
 * Every round performs local tools/list followed by tunnel tools/list, with no concurrency,
 * retry, warm-up, pagination or arbitrary tool payload. The first round is included.
 * First-byte timing means the first response BODY chunk observable through fetch; byte
 * counts are decoded response-body bytes, not TLS/compression bytes. Full-body timing ends
 * at EOF, before JSON parsing. Results do not measure receipt by remote ChatGPT. Source
 * telemetry separately measures identity, handler, delivery, recorder and local HTTP phases.
 */
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

const MAX_RUNTIME_MS = 120_000;
const RPC_ID = 1;
// The SDK's LATEST_PROTOCOL_VERSION names its stable 2025-era protocol, whose
// stateless discovery has no per-request _meta envelope. Adding that envelope
// selects the 2026 routing branch and makes the same 2025 version invalid.
const REQUEST_BODY = JSON.stringify({ jsonrpc: '2.0', id: RPC_ID, method: 'tools/list', params: {} });
class BenchmarkError extends Error {}

function boundedInteger(value, fallback, maximum, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new BenchmarkError(`Invalid ${name}.`);
  return parsed;
}

function endpoint(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new BenchmarkError(`${label}: invalid endpoint URL.`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol) ||
      (label === 'local' && !loopback) || (url.protocol === 'http:' && !loopback)) {
    throw new BenchmarkError(`${label}: use a loopback local URL or HTTPS tunnel URL without userinfo or fragment.`);
  }
  return url.href;
}

function catalog(text) {
  const messages = [];
  const parse = data => {
    let message;
    try { message = JSON.parse(data); } catch { throw new BenchmarkError('Invalid JSON-RPC response.'); }
    if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) throw new BenchmarkError('Invalid JSON-RPC response.');
    if ('error' in message) throw new BenchmarkError('RPC error response.');
    if (message.id === RPC_ID) messages.push(message);
  };
  if (text.trimStart().startsWith('{')) parse(text);
  else {
    let data = [];
    for (const line of [...text.split(/\r\n|\n|\r/), '']) {
      if (line === '') {
        if (data.length) parse(data.join('\n'));
        data = [];
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (messages.length !== 1 || !Array.isArray(messages[0].result?.tools)) throw new BenchmarkError('Expected one tools/list response.');
  // Compare the same first-page catalog, without printing its descriptions or schemas.
  return createHash('sha256').update(JSON.stringify(messages[0].result)).digest('hex');
}

async function measure(url, bearer, timeoutMs, maxBytes, fetchImpl) {
  const controller = new AbortController();
  const start = performance.now();
  let timer, reader, completed = false;
  const operation = async () => {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
      },
      body: REQUEST_BODY
    });
    controller.signal.throwIfAborted();
    if (!response.ok) throw new BenchmarkError(`HTTP ${response.status}.`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new BenchmarkError('Response exceeds byte limit.');
    if (!response.body) throw new BenchmarkError('Empty response body.');
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0, firstBodyByteMs = null;
    while (true) {
      const part = await reader.read();
      controller.signal.throwIfAborted();
      if (part.done) break;
      if (!part.value.byteLength) continue;
      firstBodyByteMs ??= performance.now() - start;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new BenchmarkError('Response exceeds byte limit.');
      chunks.push(part.value);
    }
    const fullBodyMs = performance.now() - start;
    if (firstBodyByteMs === null) throw new BenchmarkError('Empty response body.');
    const fingerprint = catalog(Buffer.concat(chunks, bytes).toString('utf8'));
    completed = true;
    return { firstBodyByteMs, fullBodyMs, bytes, status: response.status, fingerprint };
  };
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BenchmarkError('Request timed out.'));
      }, timeoutMs);
    })]);
  } catch (error) {
    // Native fetch errors can contain a tokenized URL or headers. Never expose their text.
    throw error instanceof BenchmarkError ? error : new BenchmarkError('Transport failed.');
  } finally {
    clearTimeout(timer);
    if (!completed) {
      controller.abort();
      void reader?.cancel().catch(() => {});
    } else reader?.releaseLock();
  }
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = percentile => Math.round(sorted[Math.ceil(sorted.length * percentile) - 1] * 100) / 100;
  return { p50: rank(0.5), p95: rank(0.95) };
}

/** fetchImpl exists for bounded synthetic tests; production always uses native fetch. */
export async function benchmarkMcpLatency({ localUrl, tunnelUrl, rounds = 5, timeoutMs = 10_000,
  maxBytes = 2 * 1024 * 1024, localBearer, tunnelBearer, fetchImpl = fetch } = {}) {
  rounds = boundedInteger(rounds, 5, 20, 'round count');
  timeoutMs = boundedInteger(timeoutMs, 10_000, 30_000, 'request timeout');
  maxBytes = boundedInteger(maxBytes, 2 * 1024 * 1024, 8 * 1024 * 1024, 'response byte limit');
  const urls = { local: endpoint(localUrl, 'local'), tunnel: endpoint(tunnelUrl, 'tunnel') };
  const bearers = { local: localBearer, tunnel: tunnelBearer };
  for (const bearer of Object.values(bearers)) if (bearer !== undefined && (typeof bearer !== 'string' || bearer.length > 8192 || /[\r\n]/.test(bearer))) throw new BenchmarkError('Invalid bearer credential.');
  if (urls.local === urls.tunnel) throw new BenchmarkError('Provide two distinct route URLs.');
  const samples = { local: [], tunnel: [] };
  const deadline = performance.now() + MAX_RUNTIME_MS;
  let fingerprint;
  for (let round = 0; round < rounds; round++) for (const route of ['local', 'tunnel']) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new BenchmarkError('Benchmark runtime limit reached.');
    let sample;
    try { sample = await measure(urls[route], bearers[route], Math.min(timeoutMs, remaining), maxBytes, fetchImpl); }
    catch (error) { throw new BenchmarkError(`${route}: ${error instanceof BenchmarkError ? error.message : 'Request failed.'}`); }
    fingerprint ??= sample.fingerprint;
    if (sample.fingerprint !== fingerprint) throw new BenchmarkError('Catalog changed or routes expose different tools; comparison refused.');
    samples[route].push(sample);
  }
  return {
    request: 'tools/list', rounds, comparison: 'network path only; not ChatGPT receipt',
    routes: Object.fromEntries(Object.entries(samples).map(([route, rows]) => [route, {
      firstBodyByteMs: distribution(rows.map(row => row.firstBodyByteMs)),
      fullBodyMs: distribution(rows.map(row => row.fullBodyMs)),
      responseBodyBytes: distribution(rows.map(row => row.bytes)),
      statuses: rows.reduce((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts; }, {})
    }]))
  };
}

export function benchmarkFromEnvironment(env = process.env, fetchImpl = fetch) {
  return benchmarkMcpLatency({ localUrl: env.CLF_BENCH_LOCAL_URL, tunnelUrl: env.CLF_BENCH_TUNNEL_URL,
    localBearer: env.CLF_BENCH_LOCAL_BEARER, tunnelBearer: env.CLF_BENCH_TUNNEL_BEARER,
    rounds: env.CLF_BENCH_ROUNDS, timeoutMs: env.CLF_BENCH_TIMEOUT_MS, maxBytes: env.CLF_BENCH_MAX_BYTES, fetchImpl });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) {
    process.stderr.write('Configure CLF_BENCH_LOCAL_URL and CLF_BENCH_TUNNEL_URL in the environment; no request arguments are accepted.\n');
    process.exitCode = 1;
  } else benchmarkFromEnvironment().then(report => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof BenchmarkError ? error.message : 'Benchmark failed.'}\n`);
    process.exitCode = 1;
  });
}
