import { execFile } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const script = path.resolve('scripts/t3-code-bridge.mjs');
const messageId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
let directory: string;
let server: http.Server;
let routes: string[];
let answer: (req: http.IncomingMessage, res: http.ServerResponse, body: any) => void;

beforeEach(async () => {
  directory = await makeTempDir('cos-t3-');
  await fs.mkdir(path.join(directory, 'control-api'));
  answer = (_req, res) => { res.writeHead(404); res.end('{}'); };
  routes = ['/v1/workers/{ownerId}', '/v1/sessions/{id}/events/stream'];
  server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-token') {
      res.writeHead(401); res.end('{}'); return;
    }
    if (req.url === '/v1/health') { json(res, { protocol: 1, actions: { enabled: true }, routes }); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    answer(req, res, body ? JSON.parse(body) : null);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture listener');
  await fs.writeFile(path.join(directory, 'control-api/endpoint.json'), JSON.stringify({ protocol: 1, port: address.port, pid: process.pid }));
  await fs.writeFile(path.join(directory, 'control-api/token'), 'fixture-token\n');
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await removeTempDir(directory);
});

function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function run(command: string, request?: unknown) {
  const args = [script, command, '--data-dir', directory];
  if (request !== undefined) {
    const file = path.join(directory, 'request.json');
    await fs.writeFile(file, JSON.stringify(request));
    args.push('--request-file', file);
  }
  return new Promise<{ code: number; rows: any[]; stderr: string }>(resolve => {
    execFile(process.execPath, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      const rows = stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
      resolve({ code: error ? Number(error.code) || 1 : 0, rows, stderr });
    });
  });
}

it('delegates exact assignments directly to the worker broker without a coordinator prompt', async () => {
  let received: any;
  answer = (req, res, body) => {
    if (req.url === `/v1/workers/${messageId}/spawn` && req.method === 'POST') {
      received = body;
      json(res, { runId: sessionId, workers: [{ id: 'worker-1', state: 'invited' }] }, 202);
    } else json(res, {} , 404);
  };
  const result = await run('delegate', { ownerId: messageId, context: 'Read-only audit.', workers: [{ label: 'Audit', task: 'Inspect architecture; do not edit files.' }] });
  expect(result.code, result.stderr).toBe(0);
  expect(received).toEqual({ context: 'Read-only audit.', workers: [{ label: 'Audit', task: 'Inspect architecture; do not edit files.' }] });
  expect(result.rows[0]).toMatchObject({ workers: [{ state: 'invited' }] });
});

it('sends an update to the exact coordinator and reads delivery separately from admission', async () => {
  let saved: any;
  answer = (req, res, body) => {
    if (req.method === 'POST' && req.url === '/v1/inputs') {
      saved = body;
      json(res, { input: { ...body, delivery: 'pending' }, replayed: false }, 202);
    } else if (req.url === '/v1/inputs?limit=500') {
      json(res, { inputs: [{ ...saved, delivery: 'sent' }], total: 1 });
    } else json(res, {}, 404);
  };
  expect((await run('send', { id: messageId, sessionId, text: 'Please include test evidence.' })).rows[0].input.delivery).toBe('pending');
  expect(saved).toEqual({ id: messageId, sessionId, text: 'Please include test evidence.' });
  expect((await run('inputs', { id: messageId })).rows[0]).toMatchObject({ input: { id: messageId, delivery: 'sent' } });
});

it('reads health, paged sessions, live session state and workers from existing API projections', async () => {
  answer = (req, res) => {
    const replies: Record<string, unknown> = {
      '/v1/health': { protocol: 1, actions: { enabled: true } },
      '/v1/status': { bridge: { paired: true } },
      '/v1/sessions?limit=20&cursor=10.abcdefgh': { sessions: [{ id: sessionId }], nextCursor: '9.abcdefgh' },
      [`/v1/sessions/${sessionId}?live=1`]: { session: { id: sessionId }, live: { activeTurnId: 'turn-1' } },
      [`/v1/workers/${messageId}?runId=${sessionId}`]: { workers: [{ id: 'worker-1', state: 'sleeping', revivable: true }] }
    };
    json(res, replies[req.url ?? ''] ?? {}, replies[req.url ?? ''] ? 200 : 404);
  };
  expect((await run('health')).rows[0]).toMatchObject({ actions: { enabled: true } });
  expect((await run('status')).rows[0]).toMatchObject({ bridge: { paired: true } });
  expect((await run('sessions', { cursor: '10.abcdefgh' })).rows[0].nextCursor).toBe('9.abcdefgh');
  expect((await run('session', { sessionId })).rows[0].live.activeTurnId).toBe('turn-1');
  expect((await run('agents', { ownerId: messageId, runId: sessionId })).rows[0].workers).toEqual([{ id: 'worker-1', state: 'sleeping', revivable: true }]);
});

it('streams revised assistant updates and returns a sequence cursor for resuming', async () => {
  answer = (req, res) => {
    if (!req.url?.startsWith(`/v1/sessions/${sessionId}/events/stream?from=7&`)) return json(res, {}, 404);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = Buffer.from(': heartbeat\r\n\r\nid: 7\r\nevent: assistant_message\r\ndata: {"seq":7,"kind":"assistant_message","message":{"text":"مرحبا"}}\r\n\r\nid: 9\r\nevent: assistant_message\r\ndata: {"seq":9,"kind":"assistant_message","message":{"text":"done"},"final":true}\r\n\r\nevent: end\r\ndata: {"reason":"stopped"}\r\n\r\n');
    for (let offset = 0; offset < frame.length; offset += 3) res.write(frame.subarray(offset, offset + 3));
    res.end();
  };
  const result = await run('updates', { sessionId, from: 7, durationMs: 1000 });
  expect(result.code, result.stderr).toBe(0);
  expect(result.rows).toEqual([
    { event: { seq: 7, kind: 'assistant_message', message: { text: 'مرحبا' } }, nextFrom: 8 },
    { event: { seq: 9, kind: 'assistant_message', message: { text: 'done' }, final: true }, nextFrom: 10 },
    { end: 'stopped', nextFrom: 10 }
  ]);
});

it('surfaces a disabled-action refusal with the operation id and never retries a send', async () => {
  let posts = 0;
  answer = (_req, res) => { posts++; json(res, { error: 'actions_disabled', detail: 'private detail' }, 403); };
  const result = await run('send', { id: messageId, sessionId, text: 'Update.' });
  expect(result.code).toBe(1);
  expect(result.rows[0]).toMatchObject({ error: 'actions_disabled', inputId: messageId });
  expect(JSON.stringify(result.rows)).not.toContain('private detail');
  expect(posts).toBe(1);
});

it('preserves the operation id when a send loses its acknowledgement', async () => {
  let posts = 0;
  answer = (req) => { posts++; req.socket.destroy(); };
  const result = await run('send', { id: messageId, sessionId, text: 'Update.' });
  expect(result.code).toBe(1);
  expect(result.rows[0]).toMatchObject({ error: 'connection_lost', inputId: messageId });
  expect(posts).toBe(1);
});

it('uses a cursor page when the installed API does not advertise streaming', async () => {
  routes = ['/v1/sessions/{id}/events'];
  answer = (req, res) => {
    if (req.url?.startsWith(`/v1/sessions/${sessionId}/events?from=10&limit=100&`)) {
      json(res, { events: [{ seq: 12, kind: 'assistant_message', message: { text: 'Update' } }], nextFrom: 13, total: 1 });
    } else json(res, {}, 404);
  };
  const result = await run('updates', { sessionId, from: 10 });
  expect(result.code).toBe(0);
  expect(result.rows).toEqual([
    { event: { seq: 12, kind: 'assistant_message', message: { text: 'Update' } }, nextFrom: 13 },
    { end: 'page', nextFrom: 13 }
  ]);
});

it.each([
  { id: messageId, sessionId: '../wrong-chat', text: 'Update.' },
  { id: messageId, sessionId, text: 'Update.', interrupt: 'yes' },
  { id: messageId, sessionId, projectId: messageId, text: 'Update.' },
  { id: messageId, sessionId, text: 'Update.', token: 'should-not-be-forwarded' }
])('refuses invalid send requests before contacting CoS: %j', async invalid => {
  let contacted = false;
  answer = (_req, res) => { contacted = true; json(res, {}); };
  const result = await run('send', invalid);
  expect(result.code).toBe(1);
  expect(contacted).toBe(false);
});

it('ends a quiet stream at the caller deadline without claiming task completion', async () => {
  answer = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': open\n\n'); };
  const result = await run('updates', { sessionId, from: 20, durationMs: 100 });
  expect(result.code).toBe(0);
  expect(result.rows).toEqual([{ end: 'duration', nextFrom: 20 }]);
});

it('stops at the event limit and leaves later events available at the returned cursor', async () => {
  answer = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('id: 1\nevent: progress\ndata: {"seq":1,"kind":"progress"}\n\nid: 2\nevent: progress\ndata: {"seq":2,"kind":"progress"}\n\n');
  };
  expect((await run('updates', { sessionId, limit: 1 })).rows).toEqual([{ event: { seq: 1, kind: 'progress' }, nextFrom: 2 }, { end: 'limit', nextFrom: 2 }]);
});

it('returns failure and the consumed cursor when CoS ends a stream with an error', async () => {
  answer = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('id: 4\nevent: progress\ndata: {"seq":4,"kind":"progress"}\n\nevent: end\ndata: {"reason":"error"}\n\n');
  };
  const result = await run('updates', { sessionId });
  expect(result.code).toBe(1);
  expect(result.rows).toEqual([{ event: { seq: 4, kind: 'progress' }, nextFrom: 5 }, { end: 'error', nextFrom: 5 }, { error: 'stream_error' }]);
});

it('refuses an oversized worker assignment before contacting CoS', async () => {
  let contacted = false;
  answer = (_req, res) => { contacted = true; json(res, {}); };
  const result = await run('delegate', { ownerId: messageId, workers: [{ task: 'x'.repeat(4001) }] });
  expect(result.rows[0].error).toBe('invalid_text');
  expect(contacted).toBe(false);
});

it.each(['stream', 'page'])('keeps revisions and later timeline rows when sequences arrive out of order (%s)', async mode => {
  if (mode === 'page') routes = ['/v1/sessions/{id}/events'];
  const events = [{ seq: 9, kind: 'assistant_message' }, { seq: 7, kind: 'turn_end' }];
  answer = (_req, res) => {
    if (mode === 'page') json(res, { events, nextFrom: 10, total: 2 });
    else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'event: end\ndata: {"reason":"stopped"}\n\n');
    }
  };
  const result = await run('updates', { sessionId, from: 7 });
  expect(result.rows).toEqual([{ event: events[0], nextFrom: 10 }, { event: events[1], nextFrom: 10 }, { end: mode === 'page' ? 'page' : 'stopped', nextFrom: 10 }]);
});

it('refuses a build without direct worker routes before any delegation and uses no coordinator fallback', async () => {
  routes = ['/v1/inputs'];
  let posted = false;
  answer = (_req, res) => { posted = true; json(res, {}); };
  const result = await run('delegate', { ownerId: messageId, workers: [{ task: 'A task.' }] });
  expect(result.rows[0]).toMatchObject({ error: 'worker_broker_unavailable', ownerId: messageId });
  expect(posted).toBe(false);
});
