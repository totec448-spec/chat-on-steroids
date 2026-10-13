/**
 * The control API's event stream over real loopback HTTP: a chat's recorded events and then the
 * ones that arrive, as Server-Sent Events, with the same projection as the paged read (#1349).
 */

import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' }
}));

const { initConfigPath } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, flushDurable } = await import('../src/main/durable.js');
const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { notifyChanged } = await import('../src/main/session/recorder.js');
const controlApi = await import('../src/main/control-api.js');
const stream = await import('../src/main/control-stream.js');

let dir: string;
let port = 0;
let auth: Record<string, string> = {};
let sessionId = '';
const text = (value: string) => ({ text: value, truncated: false, chars: value.length });

interface Frame { id: string | null; event: string | null; data: any }
interface Open {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
  frames: Frame[];
  comments: string[];
  closed: Promise<void>;
  close: () => void;
  /** Resolves once `count` event frames have arrived. */
  got: (count: number) => Promise<Frame[]>;
}

/** Opens a stream and parses what arrives; a non-200 answer is read as JSON instead. */
function open(route: string, headers: Record<string, string> = auth): Promise<Open> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'GET', headers }, (res) => {
      const frames: Frame[] = [];
      const comments: string[] = [];
      let buffer = '';
      let ended: () => void = () => undefined;
      const closed = new Promise<void>((done) => { ended = done; });
      res.on('close', () => ended());
      res.on('end', () => ended());
      const result: Open = {
        status: res.statusCode ?? 0, headers: res.headers, body: null, frames, comments, closed,
        close: () => req.destroy(),
        got: (count) => vi.waitFor(() => { expect(frames.length).toBeGreaterThanOrEqual(count); return frames; }, { timeout: 5_000 })
      };
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => { result.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); resolve(result); });
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          if (block.startsWith(':')) { comments.push(block); continue; }
          const frame: Frame = { id: null, event: null, data: null };
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4);
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
          }
          frames.push(frame);
        }
      });
      resolve(result);
    });
    req.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); });
    req.end();
  });
}

async function restart(): Promise<void> {
  await controlApi.stopControlApi();
  await controlApi.startControlApi();
  const endpoint = JSON.parse(await fs.readFile(path.join(dir, 'control-api', 'endpoint.json'), 'utf8'));
  port = endpoint.port;
  auth = { authorization: 'Bearer ' + (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim() };
}

const add = async (kind: 'note' | 'user_message', value: string) => {
  const event = await appendEvent(sessionId, { kind, source: 'app', time: Date.now(), message: text(value) } as never);
  notifyChanged(sessionId);
  return event;
};

beforeAll(async () => {
  dir = await makeTempDir('clf-control-stream-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  controlApi.initControlApiPath(dir);
  const { saveConfig, getConfig } = await import('../src/main/config.js');
  await saveConfig({ ...getConfig(), controlApi: { enabled: true, allowActions: false } });
  sessionId = (await createSession({ title: 'Stream me' })).id;
  await appendEvent(sessionId, { kind: 'user_message', source: 'extension', time: 10, message: text('First') });
  await appendEvent(sessionId, { kind: 'note', source: 'app', time: 20, message: text('Second') });
  await restart();
});

afterEach(() => {
  stream.closeEventStreams('test');
  stream.setStreamTimingForTests({});
});

afterAll(async () => {
  await controlApi.shutdownControlApi();
  await flushDurable();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

describe('GET /v1/sessions/{id}/events/stream', () => {
  it('sends what is recorded, then each new event as it is written, in the shape of the paged read', async () => {
    const paged = (await new Promise<any>((resolve) => http.get({ hostname: '127.0.0.1', port, path: `/v1/sessions/${sessionId}/events?from=0`, headers: auth }, (res) => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', (c) => { raw += c; }); res.on('end', () => resolve(JSON.parse(raw)));
    })));
    const live = await open(`/v1/sessions/${sessionId}/events/stream?from=0`);
    expect(live.status).toBe(200);
    expect(live.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(live.headers['cache-control']).toBe('no-store');
    const first = await live.got(2);
    expect(first.map((frame) => frame.data)).toEqual(paged.events);
    expect(first.map((frame) => frame.event)).toEqual(['user_message', 'note']);
    expect(first.map((frame) => frame.id)).toEqual(paged.events.map((event: { seq: number }) => String(event.seq)));

    const added = await add('note', 'Third, live');
    const next = (await live.got(3))[2]!;
    expect(next).toMatchObject({ id: String(added.seq), event: 'note', data: { seq: added.seq, kind: 'note' } });
    live.close();
  });

  it('resumes after the last id a client saw, and filters by kind', async () => {
    const all = await open(`/v1/sessions/${sessionId}/events/stream`);
    const frames = await all.got(3);
    all.close();
    const lastSeen = frames[1]!.id!;

    const resumed = await open(`/v1/sessions/${sessionId}/events/stream`, { ...auth, 'last-event-id': lastSeen });
    const rest = await resumed.got(1);
    expect(rest[0]!.id).toBe(frames[2]!.id);
    resumed.close();

    const users = await open(`/v1/sessions/${sessionId}/events/stream?from=0&kinds=user_message`);
    expect((await users.got(1)).map((frame) => frame.event)).toEqual(['user_message']);
    await add('note', 'Not for this stream');
    const typed = await add('user_message', 'A second question');
    expect((await users.got(2))[1]).toMatchObject({ id: String(typed.seq), event: 'user_message' });
    expect(users.frames.every((frame) => frame.event === 'user_message')).toBe(true);
    users.close();
  });

  it('refuses what it cannot stream before any stream starts', async () => {
    expect(await open('/v1/sessions/2026-01-01-deadbeef/events/stream')).toMatchObject({ status: 404, body: { error: 'session_not_found' } });
    expect(await open(`/v1/sessions/${sessionId}/events/stream?before=3`)).toMatchObject({ status: 400, body: { error: 'invalid_query' } });
    expect(await open(`/v1/sessions/${sessionId}/events/stream`, { ...auth, 'last-event-id': 'abc' })).toMatchObject({ status: 400, body: { error: 'invalid_query' } });
    expect((await open(`/v1/sessions/${sessionId}/events/stream`, {})).status).toBe(401);
    expect((await open(`/v1/sessions/${sessionId}/events/stream`, { ...auth, origin: 'https://example.test' })).status).toBe(403);
  });

  it('holds a few streams at once and turns the next one away', async () => {
    const held: Open[] = [];
    for (let index = 0; index < stream.MAX_EVENT_STREAMS; index++) held.push(await open(`/v1/sessions/${sessionId}/events/stream`));
    expect(held.every((entry) => entry.status === 200)).toBe(true);
    expect(await open(`/v1/sessions/${sessionId}/events/stream`)).toMatchObject({ status: 503, body: { error: 'busy' } });
    held[0]!.close();
    await vi.waitFor(async () => {
      const again = await open(`/v1/sessions/${sessionId}/events/stream`);
      expect(again.status).toBe(200);
      again.close();
    });
    for (const entry of held) entry.close();
  });

  it('keeps an idle stream alive with comments, and ends it after its longest life with a reason', async () => {
    stream.setStreamTimingForTests({ heartbeatMs: 30, maxLifeMs: 200 });
    const live = await open(`/v1/sessions/${sessionId}/events/stream?from=10000000`);
    await vi.waitFor(() => expect(live.comments).toContain(': keep-alive'));
    await live.closed;
    expect(live.frames.at(-1)).toMatchObject({ event: 'end', data: { reason: 'max_duration' } });
  });

  it('opens at once even when there is nothing to send yet', async () => {
    const began = Date.now();
    const live = await open(`/v1/sessions/${sessionId}/events/stream?from=10000000`);
    // The answer's headers do not wait for the first event or the first heartbeat.
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(live.status).toBe(200);
    await vi.waitFor(() => expect(live.comments).toEqual([': stream open']));
    expect(live.frames).toEqual([]);
    live.close();
  });

  it('ends every stream when the API stops', async () => {
    const live = await open(`/v1/sessions/${sessionId}/events/stream?from=10000000`);
    const began = Date.now();
    await controlApi.stopControlApi();
    await live.closed;
    expect(live.frames.at(-1)).toMatchObject({ event: 'end', data: { reason: 'stopped' } });
    // The stream does not hold the listener open for its drain grace.
    expect(Date.now() - began).toBeLessThan(3_000);
    await restart();
  });

  it('is listed among the routes this build serves', async () => {
    const health = await new Promise<any>((resolve) => http.get({ hostname: '127.0.0.1', port, path: '/v1/health', headers: auth }, (res) => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', (c) => { raw += c; }); res.on('end', () => resolve(JSON.parse(raw)));
    }));
    expect(health.routes).toContain('/v1/sessions/{id}/events/stream');
  });
});
