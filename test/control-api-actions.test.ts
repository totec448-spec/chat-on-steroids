/**
 * The control API's action routes over real loopback HTTP and the real outbox: what is refused
 * and why, that sending and cancelling go through the app's own outbox and nothing else, and that
 * what a message row proves about delivery is read from the row and never guessed.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallRecord } from '../src/shared/session.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const gate = vi.hoisted(() => ({ actions: true, enabled: true }));

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

// The two switches are read from config on every request; this suite flips the second one.
vi.mock('../src/main/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/config.js')>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), controlApi: { enabled: gate.enabled, allowActions: gate.actions } }) };
});
// Only the effects that would leave the process are replaced: the tunnel, the bridge listener and the browser.
vi.mock('../src/main/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/connection.js')>();
  return {
    ...actual,
    connect: vi.fn(async () => undefined),
    getStatus: () => ({ ...actual.getStatus(), state: 'connected' as const }),
    onStatusChange: () => () => undefined
  };
});
vi.mock('../src/main/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/bridge.js')>();
  return { ...actual, startBridge: vi.fn(async () => true) };
});
vi.mock('../src/main/browser-startup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/browser-startup.js')>();
  return { ...actual, wakeBrowserUrl: vi.fn(async () => undefined) };
});

const { initConfigPath } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { flushDurable, initDurableStore, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { appendEvent, createSession, initSessionStore, observeSessionModel, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const input = await import('../src/main/session/input.js');
const startInput = await import('../src/main/session/start-input.js');
const bridge = await import('../src/main/bridge.js');
const startup = await import('../src/main/browser-startup.js');
const connection = await import('../src/main/connection.js');
const { setChatBlocked } = await import('../src/main/session/blocked-chats.js');
const controlApi = await import('../src/main/control-api.js');
const { listInputs, resetInputForTests } = input;

let dir: string;
let port = 0;
let token = '';
let chatSession = '';
const CHAT = 'chat-actions-1';

async function restart(): Promise<void> {
  // A fresh listener also starts with a fresh action budget and a fresh token.
  await controlApi.stopControlApi();
  await controlApi.startControlApi();
  const endpoint = JSON.parse(await fs.readFile(path.join(dir, 'control-api', 'endpoint.json'), 'utf8'));
  port = endpoint.port;
  token = (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim();
}

interface Reply {
  status: number;
  body: any;
  raw: string;
  headers: http.IncomingHttpHeaders;
  continued: boolean;
  /** The server closed the connection before a whole answer arrived. */
  reset: boolean;
}

function call(
  method: string,
  route: string,
  options: { headers?: Record<string, string>; body?: string | Buffer; auth?: boolean } = {}
): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.auth === false ? {} : { authorization: 'Bearer ' + token }) };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(options.body));
  }
  Object.assign(headers, options.headers);
  for (const key of Object.keys(headers)) if (headers[key] === '') delete headers[key];
  return new Promise((resolve, reject) => {
    let continued = false;
    const expectsContinue = /100-continue/i.test(headers['expect'] ?? '');
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode ?? 0, body, raw, headers: res.headers, continued, reset: false });
      });
    });
    // A refused request may be cut off before its body is read. That is an answer too, and it has
    // to settle this promise: an ECONNRESET closes the socket, so the idle timeout below never fires.
    req.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code?.startsWith('ECONN')) resolve({ status: 0, body: null, raw: '', headers: {}, continued, reset: true });
      else reject(error);
    });
    req.setTimeout(10_000, () => req.destroy(new Error('the test request timed out')));
    if (expectsContinue) {
      req.on('continue', () => { continued = true; req.end(options.body); });
      req.flushHeaders();
    } else {
      req.end(options.body);
    }
  });
}

const post = (route: string, body?: unknown, headers?: Record<string, string>) =>
  call('POST', route, { headers, body: body === undefined ? undefined : JSON.stringify(body) });

const outbox = () => listInputs();
const text = (value: string) => ({ text: value, truncated: false, chars: value.length });
const toolCall = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  callId: 'call-1', tool: 'exec_command', attribution: 'request_id', requestId: 'req-1', conversationId: null, attributionMethod: 'request_id',
  args: text('{}'), result: text('ok'), outcome: 'ok', durationMs: 5, summary: { title: 'Ran a command', tone: 'neutral', kind: 'run' }, ...over
});
const sendBody = (over: object = {}) => ({ id: randomUUID(), sessionId: chatSession, text: 'Keep going', ...over });

/** A chat that is writing an answer right now, as the outbox recognises one that a send would stop. */
async function answeringSession(title: string, conversationId: string, turnId: string): Promise<string> {
  const id = await makeSession(title, conversationId);
  await observeSessionModel(id, conversationId, 'gpt-5.6-sol', Date.now());
  await appendEvent(id, { kind: 'turn_start', source: 'extension', time: Date.now(), turnId });
  return id;
}

async function makeSession(title: string, conversationId: string | null, origin?: object) {
  return (await createSession({ title, conversationId, ...(origin ? { origin: origin as never } : {}) })).id;
}

/** A row as the outbox stores it. Seeding the durable state is how a test gets a row in a state
 * the running app reaches only through a browser page, without pretending to be one. */
const row = (over: object = {}) => ({
  id: randomUUID(), sessionId: chatSession, text: 'hello', mode: 'auto', dueAt: 1, model: null, reasoningEffort: null,
  state: 'queued', owner: null, createdAt: Date.now(), conversationId: null, ...over
});

async function seed(rows: object[]): Promise<void> {
  // Windows can refuse the rename of a state file that a scanner is holding for a moment.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await writeDurableNow('session-input', rows);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  resetInputForTests();
}

const wake = () => vi.mocked(startup.wakeBrowserUrl);

beforeAll(async () => {
  dir = await makeTempDir('clf-control-actions-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  controlApi.initControlApiPath(dir);
  chatSession = await makeSession('Chat one', CHAT);
});

beforeEach(async () => {
  gate.actions = true;
  gate.enabled = true;
  await seed([]);
  wake().mockClear();
  controlApi.setActionLimitsForTests({});
  await restart();
});

afterAll(async () => {
  await controlApi.shutdownControlApi();
  startInput.resetInputStartupForTests();
  await flushDurable();
  resetInputForTests();
  resetDurableForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

describe('with actions switched off', () => {
  it('answers every action route the same way, before reading anything, and changes nothing', async () => {
    gate.actions = false;
    await seed([row({ id: '00000000-0000-4000-8000-000000000001', text: 'queued before' })]);
    const before = JSON.stringify(await outbox());
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    const cancels = vi.spyOn(startInput, 'cancelDesktopInput');
    try {
      const replies = [
        await post('/v1/inputs', sendBody()),
        await post('/v1/inputs', { nonsense: true }),
        await post('/v1/inputs/00000000-0000-4000-8000-000000000001/cancel'),
        await post('/v1/inputs/ffffffff-ffff-4fff-8fff-ffffffffffff/cancel', { anything: 1 }),
        await post('/v1/inputs/not-even-an-id/cancel'),
        // Announces far more body than it sends, and names no content type.
        await call('POST', '/v1/inputs', { body: '{}', headers: { 'content-length': '5000000', 'content-type': '' } }),
        await call('POST', '/v1/inputs', { body: 'not json', headers: { 'content-type': 'text/plain' } })
      ];
      for (const reply of replies) {
        expect(reply.status).toBe(403);
        expect(reply.raw).toBe(replies[0]!.raw);
        expect(reply.headers.connection).toBe('close');
      }
      expect(replies[0]!.body).toEqual({ error: 'actions_disabled' });
      expect(sends).not.toHaveBeenCalled();
      expect(cancels).not.toHaveBeenCalled();
      expect(JSON.stringify(await outbox())).toBe(before);
    } finally {
      sends.mockRestore();
      cancels.mockRestore();
    }
  });

  it('does not invite a body with 100 Continue, and reads are unaffected', async () => {
    gate.actions = false;
    const refused = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody()), headers: { expect: '100-continue' } });
    expect(refused.status).toBe(403);
    expect(refused.continued).toBe(false);
    expect((await call('GET', '/v1/inputs')).status).toBe(200);
    expect((await call('GET', '/v1/health')).body.actions).toEqual({ enabled: false, routes: ['POST /v1/inputs', 'POST /v1/inputs/{id}/cancel'] });
  });

  it('follows the switch on the next request without restarting the listener', async () => {
    gate.actions = false;
    expect((await post('/v1/inputs', { nonsense: true })).status).toBe(403);
    gate.actions = true;
    const now = await post('/v1/inputs', { nonsense: true });
    expect(now.status).toBe(400);
    expect((await call('GET', '/v1/health')).body.actions.enabled).toBe(true);
  });
});

describe('who may call', () => {
  it.each([false, true])('refuses a missing token, a wrong token, an Origin and a foreign Host (actions on: %s)', async (on) => {
    gate.actions = on;
    const body = JSON.stringify(sendBody());
    expect((await call('POST', '/v1/inputs', { body, auth: false })).status).toBe(401);
    expect((await call('POST', '/v1/inputs', { body, headers: { authorization: 'Bearer ' + token.slice(1) + 'x' } })).status).toBe(401);
    expect((await call('POST', '/v1/inputs', { body, headers: { origin: 'https://chatgpt.com' } })).status).toBe(403);
    expect((await call('POST', '/v1/inputs', { body, headers: { origin: 'chrome-extension://abc' } })).body).toEqual({ error: 'origin_forbidden' });
    expect((await call('POST', '/v1/inputs', { body, headers: { host: 'attacker.example' } })).body).toEqual({ error: 'host_forbidden' });
    expect((await call('POST', '/v1/inputs/' + randomUUID() + '/cancel', { auth: false })).status).toBe(401);
    expect(await outbox()).toEqual([]);
  });

  it('names the right method for each path', async () => {
    const put = await call('PUT', '/v1/inputs', { body: '{}' });
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe('GET, POST');
    const get = await call('GET', '/v1/inputs/' + randomUUID() + '/cancel');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await call('POST', '/v1/status', { body: '{}' })).headers.allow).toBe('GET');
    expect((await call('DELETE', '/v1/inputs/' + randomUUID() + '/cancel')).headers.allow).toBe('POST');
  });
});

describe('the request body', () => {
  it('is refused before anything reaches the outbox when it is not a small JSON object', async () => {
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const wrongType = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody()), headers: { 'content-type': 'text/plain' } });
      expect(wrongType.status).toBe(415);
      const charset = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody()), headers: { 'content-type': 'application/json; charset=utf-8' } });
      expect(charset.status).toBe(202);
      await seed([]);

      // The longest message the app accepts, every character escaped as \u0001, still fits.
      expect((await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody({ text: '\u0001'.repeat(64_000) })) })).status).toBe(202);
      await seed([]);

      const huge = await call('POST', '/v1/inputs', { body: '{}', headers: { 'content-length': String(600 * 1024) } });
      expect(huge.status).toBe(413);
      expect(huge.headers.connection).toBe('close');
      // This caller keeps uploading after the refusal, so it may see its connection reset instead of
      // the 413, as `readBody` documents. Windows does this whenever the refused bytes are unread.
      const uploading = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody({ text: 'x'.repeat(520 * 1024) })) });
      expect([413, 'reset']).toContain(uploading.reset ? 'reset' : uploading.status);

      const chunked = await new Promise<number>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/inputs', method: 'POST',
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.write('{"id":');
        req.end('"x"}');
      });
      expect(chunked).toBe(400);

      expect((await call('POST', '/v1/inputs', { body: '{not json' })).body).toEqual({ error: 'invalid_json' });
      expect((await call('POST', '/v1/inputs', { body: Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) })).body).toEqual({ error: 'invalid_json' });
      expect((await call('POST', '/v1/inputs?x=1', { body: JSON.stringify(sendBody()) })).body.error).toBe('invalid_query');
      // Only the two valid requests may have reached the owner.
      expect(sends).toHaveBeenCalledTimes(2);
    } finally {
      sends.mockRestore();
    }
  });

  it('is checked field by field, and unknown fields are refused', async () => {
    const cases: Array<[string, object]> = [
      ['no id', { sessionId: chatSession, text: 'x' }],
      ['uppercase id', sendBody({ id: randomUUID().toUpperCase() })],
      ['id that is not a uuid', sendBody({ id: 'not-a-uuid' })],
      ['bad session id', sendBody({ sessionId: '../etc' })],
      ['no text', { id: randomUUID(), sessionId: chatSession }],
      ['empty text', sendBody({ text: '' })],
      ['whitespace text', sendBody({ text: '  \n ' })],
      ['text over the limit', sendBody({ text: 'x'.repeat(64_001) })],
      ['text that is not a string', sendBody({ text: 42 })],
      ['interrupt that is not a boolean', sendBody({ interrupt: 'yes' })],
      ['a mode', sendBody({ mode: 'finish' })],
      ['a delivery flag', sendBody({ delivery: 'tool' })],
      ['a model', sendBody({ model: 'gpt-x' })],
      ['a due time', sendBody({ dueAt: 1 })],
      ['a project', sendBody({ projectId: randomUUID() })],
      ['images', sendBody({ images: [] })],
      ['attachments', sendBody({ attachments: [] })]
    ];
    for (const [name, body] of cases) {
      const reply = await post('/v1/inputs', body);
      expect(reply.status, name).toBe(400);
      expect(reply.body.error, name).toBe('invalid_body');
    }
    expect((await post('/v1/inputs', sendBody({ mode: 'finish' }))).body.detail).toBe('unknown field');
    expect((await post('/v1/inputs', [1, 2])).status).toBe(400);
    expect((await post('/v1/inputs', null)).status).toBe(400);
    expect((await post('/v1/inputs/' + randomUUID() + '/cancel', { reason: 'x' })).status).toBe(400);
    expect(await outbox()).toEqual([]);
  });

  it('is a 429 once a caller has spent its action budget', async () => {
    let last: Reply | null = null;
    for (let index = 0; index < 31; index += 1) last = await post('/v1/inputs', { nonsense: true });
    expect(last!.status).toBe(429);
    expect(last!.headers['retry-after']).toBe('60');
  });

  it('spends none of that budget on requests refused while actions are off', async () => {
    gate.actions = false;
    for (let index = 0; index < 60; index += 1) expect((await post('/v1/inputs', { nonsense: true })).status).toBe(403);
    gate.actions = true;
    for (let index = 0; index < 30; index += 1) expect((await post('/v1/inputs', { nonsense: true })).status).toBe(400);
    expect((await post('/v1/inputs', { nonsense: true })).status).toBe(429);
  });

  it('is answered 408 when a caller announces a body and does not send it', async () => {
    controlApi.setActionLimitsForTests({ bodyTimeoutMs: 150 });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/inputs', method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': '200' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', (error) => { if ((error as NodeJS.ErrnoException).code?.startsWith('ECONN')) resolve(0); else reject(error); });
      req.write('{"id":');
    });
    expect(status).toBe(408);
    expect(await outbox()).toEqual([]);
  });

  it('refuses a request target that is not plain origin-form, whatever the method', async () => {
    for (const route of ['//v1/inputs', '/v1\\inputs', '/v1/inputs/\\..\\cancel']) {
      for (const method of ['POST', 'GET', 'PUT']) {
        const reply = await call(method, route, method === 'GET' ? {} : { body: '{}' });
        expect(reply.status, method + ' ' + route).toBe(400);
        expect(reply.body).toEqual({ error: 'invalid_target' });
      }
    }
    expect(await outbox()).toEqual([]);
  });

  it('invites the body of an action that passed every check, and only that one', async () => {
    const accepted = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody()), headers: { expect: '100-continue, x-other' } });
    expect(accepted.continued).toBe(true);
    expect(accepted.status).toBe(202);
    await seed([]);
    const refused = await call('POST', '/v1/inputs', { body: JSON.stringify(sendBody()), headers: { expect: '100-continue', 'content-type': 'text/plain' } });
    expect(refused.continued).toBe(false);
    expect(refused.status).toBe(415);
  });
});

describe('sending', () => {
  it('admits a message to an existing chat through the desktop send path and reports only what the row proves', async () => {
    const id = randomUUID();
    const reply = await post('/v1/inputs', { id, sessionId: chatSession, text: '  Keep going, check the last commit.  ' });
    expect(reply.status).toBe(202);
    expect(reply.body.replayed).toBe(false);
    expect(reply.body.input).toMatchObject({
      id, sessionId: chatSession, state: 'queued', delivery: 'pending', mode: 'auto', automatic: false,
      text: { text: 'Keep going, check the last commit.', truncated: false }
    });
    for (const hidden of ['owner', 'deliveryText', 'toolImages', 'response', 'recovery', 'directTurn']) {
      expect(Object.keys(reply.body.input)).not.toContain(hidden);
    }

    // The same path the composer uses brings up the browser; nothing else sends.
    await vi.waitFor(() => expect(wake()).toHaveBeenCalledTimes(1));
    expect(wake().mock.calls[0]![0]).toBe('https://chatgpt.com/c/' + CHAT);

    const listed = (await call('GET', '/v1/inputs')).body.inputs.find((entry: { id: string }) => entry.id === id);
    expect(listed).toMatchObject({ id, delivery: 'pending', state: 'queued' });
    expect((await outbox()).filter((entry) => entry.id === id)).toHaveLength(1);
  });

  it('answers a repeated id with the row that exists and never sends it again', async () => {
    const body = sendBody({ text: 'Only once' });
    const first = await post('/v1/inputs', body);
    expect(first.status).toBe(202);
    await vi.waitFor(() => expect(wake()).toHaveBeenCalledTimes(1));

    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const again = await post('/v1/inputs', body);
      expect(again.status).toBe(200);
      expect(again.body.replayed).toBe(true);
      expect(again.body.input.id).toBe(body.id);
      // A moment later the outbox's own dueAt would differ; the replay does not depend on it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await post('/v1/inputs', body)).status).toBe(200);
      expect(sends).not.toHaveBeenCalled();
      // The text is compared as the outbox stored it, without the padding it trimmed.
      const padded = await post('/v1/inputs', { ...body, text: '  Only once \n' });
      expect(padded.status).toBe(200);
      expect(padded.body.replayed).toBe(true);
      expect(sends).not.toHaveBeenCalled();
    } finally {
      sends.mockRestore();
    }
    expect((await outbox()).filter((entry) => entry.id === body.id)).toHaveLength(1);
    expect(wake()).toHaveBeenCalledTimes(1);

    const otherSession = await makeSession('Chat two', 'chat-actions-2');
    for (const different of [{ text: 'A different message' }, { sessionId: otherSession }]) {
      const conflict = await post('/v1/inputs', { ...body, ...different });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toBe('id_conflict');
    }

    // A planner row's id is not a message the caller can name.
    const planner = row({ purpose: 'decision', state: 'decision', text: 'Only once' });
    await seed([planner]);
    const named = await post('/v1/inputs', { id: planner.id, sessionId: chatSession, text: 'Only once' });
    expect(named.status).toBe(409);
    expect(named.body.error).toBe('id_conflict');
    await seed([]);
  });

  it('refuses a second message while one is still awaiting delivery', async () => {
    expect((await post('/v1/inputs', sendBody())).status).toBe(202);
    const second = await post('/v1/inputs', sendBody({ text: 'Another one' }));
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('busy');
    expect(await outbox()).toHaveLength(1);
  });

  it('refuses a chat it cannot or should not send to', async () => {
    const unknown = await post('/v1/inputs', sendBody({ sessionId: '2026-01-01-deadbeef' }));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('session_not_found');

    const worker = await makeSession('Worker', 'chat-worker', { kind: 'worker', fromSessionId: chatSession, agentId: 'worker-1', task: 't' });
    const helper = await makeSession('Helper', 'chat-helper', { kind: 'helper', fromSessionId: chatSession, agentId: null, task: '' });
    for (const sessionId of [worker, helper]) {
      const reply = await post('/v1/inputs', sendBody({ sessionId }));
      expect(reply.status).toBe(409);
      expect(reply.body.error).toBe('session_not_controllable');
    }
    const unattached = await makeSession('No chat yet', null);
    const noChat = await post('/v1/inputs', sendBody({ sessionId: unattached }));
    expect(noChat.status).toBe(409);
    expect(noChat.body.error).toBe('no_chat');
    expect(await outbox()).toEqual([]);
    expect(wake()).not.toHaveBeenCalled();
  });

  it('will not stop the answer ChatGPT is writing unless the caller says so', async () => {
    const answering = await answeringSession('Answering', 'chat-answering', 'turn-live');
    const refused = await post('/v1/inputs', sendBody({ sessionId: answering }));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('would_interrupt');
    expect(await outbox()).toEqual([]);
    const allowed = await post('/v1/inputs', sendBody({ sessionId: answering, interrupt: true }));
    expect(allowed.status).toBe(202);
    // The outbox itself marked the row as one that stops the answer; the caller had agreed to that.
    expect((await outbox())[0]).toMatchObject({ directTurn: { id: 'turn-live' } });
  });

  it('withdraws a message whose send turned into an interruption after the check', async () => {
    const late = await makeSession('Late turn', 'chat-late');
    await observeSessionModel(late, 'chat-late', 'gpt-5.6-sol', Date.now());
    const real = startInput.sendDesktopInput;
    const sends = vi.spyOn(startInput, 'sendDesktopInput').mockImplementation(async (args) => {
      // The chat starts answering between the caller's check and the outbox's own.
      await appendEvent(late, { kind: 'turn_start', source: 'extension', time: Date.now(), turnId: 'turn-late' });
      return real(args);
    });
    try {
      const reply = await post('/v1/inputs', sendBody({ sessionId: late }));
      expect(reply.status).toBe(409);
      expect(reply.body.error).toBe('would_interrupt');
      const rows = await outbox();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'cancelled' });
      expect(input.deliveryProof(rows[0]!)).toBe('not_sent');
      expect(wake()).not.toHaveBeenCalled();
    } finally {
      sends.mockRestore();
    }
  });

  it('answers an admission that outlives its deadline as unknown, and never runs one it turned away', async () => {
    controlApi.setActionLimitsForTests({ deadlineMs: 150 });
    const real = startInput.sendDesktopInput;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sends = vi.spyOn(startInput, 'sendDesktopInput').mockImplementation(async (args) => { await held; return real(args); });
    try {
      const slowSession = await makeSession('Slow', 'chat-slow');
      const slow = await post('/v1/inputs', sendBody({ sessionId: slowSession }));
      expect(slow.status).toBe(504);
      expect(slow.body.error).toBe('timeout');
      expect(slow.body.detail).toContain('GET /v1/inputs');
      // Actions run one at a time, so the next one waits behind it. It is turned away before it
      // starts, and it is told so, because it will not run once the first one finishes.
      const queued = await post('/v1/inputs', sendBody());
      expect(queued.status).toBe(504);
      expect(queued.body.detail).toContain('will not run');
    } finally {
      release();
      sends.mockRestore();
    }
    await vi.waitFor(async () => expect(await outbox()).toHaveLength(1), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await outbox()).map((entry) => entry.sessionId)).not.toContain(chatSession);
    controlApi.setActionLimitsForTests({});
    await seed([]);
    expect((await post('/v1/inputs', sendBody())).status).toBe(202);
  });

  it('turns away actions beyond the few allowed to wait', async () => {
    const real = startInput.sendDesktopInput;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sends = vi.spyOn(startInput, 'sendDesktopInput').mockImplementation(async (args) => { await held; return real(args); });
    try {
      const sessions = await Promise.all(Array.from({ length: 6 }, (_, index) => makeSession('Queue ' + index, 'chat-queue-' + index)));
      setTimeout(release, 400);
      const replies = await Promise.all(sessions.map((sessionId) => post('/v1/inputs', sendBody({ sessionId }))));
      expect(replies.map((reply) => reply.status).sort()).toEqual([202, 202, 202, 202, 503, 503]);
      expect(replies.find((reply) => reply.status === 503)!.body.error).toBe('busy');
    } finally {
      release();
      sends.mockRestore();
    }
  });

  it('checks the switch again when a queued action gets its turn', async () => {
    const real = startInput.sendDesktopInput;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sends = vi.spyOn(startInput, 'sendDesktopInput').mockImplementation(async (args) => { await held; return real(args); });
    try {
      const other = await makeSession('Second in line', 'chat-second');
      const first = post('/v1/inputs', sendBody());
      const second = post('/v1/inputs', sendBody({ sessionId: other }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      gate.actions = false;
      release();
      expect((await first).status).toBe(202);
      const refused = await second;
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: 'actions_disabled' });
      expect((await outbox()).map((entry) => entry.sessionId)).toEqual([chatSession]);
    } finally {
      release();
      sends.mockRestore();
    }
  });

  it('checks the switch once more just before the outbox, after the lookups that come first', async () => {
    const real = input.sessionInputPolicy;
    const policy = vi.spyOn(input, 'sessionInputPolicy').mockImplementationOnce(async (id, activity) => {
      // The user switches actions off while the caller's session is being looked at.
      gate.actions = false;
      return real(id, activity);
    });
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const reply = await post('/v1/inputs', sendBody());
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual({ error: 'actions_disabled' });
      expect(sends).not.toHaveBeenCalled();
      expect(await outbox()).toEqual([]);
    } finally {
      policy.mockRestore();
      sends.mockRestore();
    }
  });

  it('needs the API switch as well as its own', async () => {
    gate.enabled = false;
    const refused = await post('/v1/inputs', sendBody());
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'actions_disabled' });
    expect((await call('GET', '/v1/health')).body.actions.enabled).toBe(false);
    expect(await outbox()).toEqual([]);
  });

  it('answers what the outbox refuses with a reason, and everything else with a bare 500', async () => {
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const failWith = async (message: string) => {
        sends.mockRejectedValueOnce(new Error(message));
        const reply = await post('/v1/inputs', sendBody());
        return [reply.status, reply.body.error, reply.raw.includes(message)] as const;
      };
      expect(await failWith('The message queue is full')).toEqual([503, 'queue_full', false]);
      expect(await failWith('Input cancelled')).toEqual([409, 'cancelled', false]);
      expect(await failWith('Message id already belongs to different input')).toEqual([409, 'id_conflict', false]);
      expect(await failWith('Something private: C:\\Users\\someone\\secret.txt')).toEqual([500, 'internal_error', false]);
    } finally {
      sends.mockRestore();
    }
  });

  it('answers a send while the app is shutting down, and a chat that is blocked', async () => {
    startInput.stopInputStartup();
    try {
      const shutting = await post('/v1/inputs', sendBody());
      expect(shutting.status).toBe(503);
      expect(shutting.body.error).toBe('shutting_down');
    } finally {
      startInput.resetInputStartupForTests();
    }
    const blockedSession = await makeSession('Blocked', 'chat-blocked-1');
    setChatBlocked('chat-blocked-1', true);
    try {
      const blocked = await post('/v1/inputs', sendBody({ sessionId: blockedSession }));
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe('chat_blocked');
    } finally {
      setChatBlocked('chat-blocked-1', false);
    }
    expect(await outbox()).toEqual([]);
  });

  it('runs two sends for different chats one after the other', async () => {
    const second = await makeSession('Chat three', 'chat-actions-3');
    const replies = await Promise.all([post('/v1/inputs', sendBody()), post('/v1/inputs', sendBody({ sessionId: second }))]);
    expect(replies.map((reply) => reply.status)).toEqual([202, 202]);
    expect(await outbox()).toHaveLength(2);
  });
});

describe('cancelling', () => {
  it('withdraws a queued message and says it was not sent', async () => {
    const sent = await post('/v1/inputs', sendBody());
    const id = sent.body.input.id;
    const cancelled = await post('/v1/inputs/' + id + '/cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancelled).toBe(true);
    expect(cancelled.body.input).toMatchObject({ id, state: 'cancelled', delivery: 'not_sent', cancelledByUser: true });

    const again = await post('/v1/inputs/' + id + '/cancel');
    expect(again.status).toBe(200);
    expect(again.body.cancelled).toBe(false);
    expect(again.body.input.delivery).toBe('not_sent');

    // Sending the same id afterwards names the cancelled row; it is not queued again.
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const replay = await post('/v1/inputs', { id, sessionId: chatSession, text: 'Keep going' });
      expect(replay.status).toBe(200);
      expect(replay.body.input.state).toBe('cancelled');
      expect(sends).not.toHaveBeenCalled();
    } finally {
      sends.mockRestore();
    }
  });

  it('refuses what has already been handed to ChatGPT, and reports it as sent', async () => {
    const delivered = row({ state: 'sent', owner: 'page', conversationId: CHAT, offeredAt: 5, requiresAuthorization: true, sendAuthorizedAt: 6, deliveredAt: 7, messageId: 'native-1' });
    const injected = row({ text: 'injected', state: 'tool', owner: 'req-1', conversationId: CHAT, offeredAt: 5, toolTurnId: 'turn-1' });
    await seed([delivered, injected]);
    const cancels = vi.spyOn(startInput, 'cancelDesktopInput');
    try {
      const afterDelivery = await post('/v1/inputs/' + delivered.id + '/cancel');
      expect(afterDelivery.status).toBe(409);
      expect(afterDelivery.body.error).toBe('not_cancellable');
      expect(afterDelivery.body.input).toMatchObject({ state: 'sent', delivery: 'sent', messageId: 'native-1' });

      const afterOffer = await post('/v1/inputs/' + injected.id + '/cancel');
      expect(afterOffer.status).toBe(409);
      expect(afterOffer.body.input.delivery).toBe('unconfirmed');
      expect((await outbox()).map((entry) => entry.state).sort()).toEqual(['sent', 'tool']);
      // The outbox's cancel is not even asked about a message that is no longer cancellable.
      expect(cancels).not.toHaveBeenCalled();
    } finally {
      cancels.mockRestore();
    }
  });

  it('withdraws a message that was claimed before Send was authorized, and refuses one after', async () => {
    const claimed = row({ text: 'claimed', state: 'browser', owner: 'page', conversationId: CHAT, offeredAt: Date.now(), requiresAuthorization: true });
    const otherSession = await makeSession('Chat four', 'chat-actions-4');
    const authorized = row({ sessionId: otherSession, text: 'authorized', state: 'browser', owner: 'page-2', conversationId: 'chat-actions-4',
      offeredAt: Date.now(), requiresAuthorization: true, sendAuthorizedAt: Date.now() });
    await seed([claimed, authorized]);

    const before = await post('/v1/inputs/' + claimed.id + '/cancel');
    expect(before.status).toBe(200);
    expect(before.body.cancelled).toBe(true);
    expect(before.body.input).toMatchObject({ state: 'cancelled', delivery: 'not_sent' });
    expect(before.body.input.error).toContain('before Send was authorized');

    // Send was authorized: it may be in ChatGPT already, and cancelling would free the chat for a
    // second copy of the same words. It is refused and left exactly as it is.
    const cancels = vi.spyOn(startInput, 'cancelDesktopInput');
    try {
      const after = await post('/v1/inputs/' + authorized.id + '/cancel');
      expect(after.status).toBe(409);
      expect(after.body.error).toBe('not_cancellable');
      expect(after.body.detail).toContain('Send was authorized');
      expect(after.body.input).toMatchObject({ state: 'browser', delivery: 'unconfirmed' });
      expect(cancels).not.toHaveBeenCalled();
    } finally {
      cancels.mockRestore();
    }
    const sameChat = await post('/v1/inputs', { id: randomUUID(), sessionId: otherSession, text: 'authorized' });
    expect(sameChat.status).toBe(409);
    expect(sameChat.body.error).toBe('busy');
  });

  it('reports a cancel that lost a race with Send authorization as unconfirmed, not as cancelled', async () => {
    const claimed = row({ state: 'browser', owner: 'page', conversationId: CHAT, offeredAt: Date.now(), requiresAuthorization: true });
    await seed([claimed]);
    const cancels = vi.spyOn(startInput, 'cancelDesktopInput').mockImplementation(async (id) => {
      // The page authorizes Send just before the outbox's own cancel runs.
      await input.authorizeBrowserInput(id, 'page', CHAT);
      return input.cancelInput(id);
    });
    try {
      const reply = await post('/v1/inputs/' + claimed.id + '/cancel');
      expect(reply.status).toBe(409);
      expect(reply.body.error).toBe('delivery_unconfirmed');
      expect(reply.body.input).toMatchObject({ state: 'cancelled', delivery: 'unconfirmed' });
    } finally {
      cancels.mockRestore();
    }
  });

  it('leaves to the app whatever cancelling would do beyond the one message', async () => {
    const reserved = randomUUID();
    const opening = row({ id: reserved, sessionId: reserved, text: 'first message of a new chat', opening: true });
    const pairedSession = await makeSession('Paired', 'chat-paired');
    const first = row({ sessionId: pairedSession, text: 'one', conversationId: 'chat-paired' });
    const second = row({ sessionId: pairedSession, text: 'two', conversationId: 'chat-paired' });
    const workerSession = await makeSession('Worker', 'chat-worker-2', { kind: 'worker', fromSessionId: chatSession, agentId: 'worker-1', task: 't' });
    const workers = row({ sessionId: workerSession, text: 'for a worker', conversationId: 'chat-worker-2' });
    await seed([opening, { ...first, companionInputId: (second as { id: string }).id }, { ...second, companionInputId: (first as { id: string }).id }, workers]);
    const cancels = vi.spyOn(startInput, 'cancelDesktopInput');
    try {
      const refusals = await Promise.all([opening, first, second].map((entry) => post('/v1/inputs/' + (entry as { id: string }).id + '/cancel')));
      expect(refusals.map((reply) => reply.status)).toEqual([409, 409, 409]);
      expect(refusals.map((reply) => reply.body.error)).toEqual(['not_cancellable', 'not_cancellable', 'not_cancellable']);
      expect(refusals[0]!.body.detail).toContain('new chat');
      expect(refusals[1]!.body.detail).toContain('paired');
      const forWorker = await post('/v1/inputs/' + (workers as { id: string }).id + '/cancel');
      expect(forWorker.status).toBe(409);
      expect(forWorker.body.error).toBe('session_not_controllable');
      expect(cancels).not.toHaveBeenCalled();
    } finally {
      cancels.mockRestore();
    }
    const rows = await outbox();
    expect(rows.every((entry) => entry.state === 'queued')).toBe(true);
    // The reserved chat of the opening message is still there.
    const { getSession } = await import('../src/main/session/store.js');
    expect(await getSession(chatSession)).not.toBeNull();
  });

  it('is not Stop: withdrawing a message asks for no stop and creates no stop command', async () => {
    const sent = await post('/v1/inputs', sendBody());
    const stops = vi.spyOn(bridge, 'stopSessionTurn');
    const commands = bridge.pendingCommands().length;
    try {
      const cancelled = await post('/v1/inputs/' + sent.body.input.id + '/cancel');
      expect(cancelled.status).toBe(200);
      expect(stops).not.toHaveBeenCalled();
      expect(bridge.pendingCommands()).toHaveLength(commands);
    } finally {
      stops.mockRestore();
    }
  });

  it('stops a browser startup that is still in flight when its message is cancelled', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(connection.connect).mockImplementationOnce(async () => { await held; });
    const sent = await post('/v1/inputs', sendBody());
    expect(sent.status).toBe(202);
    const cancelled = await post('/v1/inputs/' + sent.body.input.id + '/cancel');
    expect(cancelled.body.cancelled).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wake()).not.toHaveBeenCalled();
  });

  it('is a 404 for an unknown message, a planner row, and a path that is not an id', async () => {
    const decision = row({ purpose: 'decision', state: 'decision', text: 'planner work' });
    await seed([decision]);
    for (const id of [randomUUID(), decision.id]) {
      const reply = await post('/v1/inputs/' + id + '/cancel');
      expect(reply.status).toBe(404);
      expect(reply.body.error).toBe('input_not_found');
    }
    for (const route of ['/v1/inputs/not-an-id/cancel', '/v1/inputs/' + randomUUID().toUpperCase() + '/cancel']) {
      expect((await post(route)).status, route).toBe(404);
    }
    // Not an action path at all, so a POST there is a wrong method, as it always was.
    expect((await post('/v1/inputs/a/b/cancel')).status).toBe(405);
    // The app retires a planner row by itself on load; what matters is that the API did not.
    expect((await outbox())[0]!.cancelledByUser).not.toBe(true);
  });
});

describe('what a message row proves', () => {
  const OLD = 20 * 60_000;

  it('never resends a message whose Send may have happened, and a late receipt turns it into sent', async () => {
    const started = Date.now() - OLD;
    const ambiguous = row({ text: 'was it sent?', state: 'browser', owner: 'page', conversationId: CHAT, createdAt: started,
      offeredAt: started, requiresAuthorization: true, sendAuthorizedAt: started + 1000 });
    await seed([ambiguous]);

    // Reading the outbox retires a send that never got a receipt; the row is then unknown, not failed.
    const listed = await call('GET', '/v1/inputs');
    expect(listed.body.inputs[0]).toMatchObject({ id: ambiguous.id, state: 'cancelled', delivery: 'unconfirmed' });
    expect(listed.body.inputs[0].error).toContain('will not be resent');

    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const retry = await post('/v1/inputs', { id: ambiguous.id, sessionId: chatSession, text: 'was it sent?' });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ replayed: true, input: { delivery: 'unconfirmed' } });
      expect(sends).not.toHaveBeenCalled();
    } finally {
      sends.mockRestore();
    }
    expect(wake()).not.toHaveBeenCalled();

    // The page confirms later: the same row now carries the receipt, and only then is it sent.
    expect(await input.acknowledgeBrowserInput(ambiguous.id, 'page', CHAT, 'native-late')).toBe(true);
    const confirmed = (await call('GET', '/v1/inputs')).body.inputs[0];
    expect(confirmed).toMatchObject({ id: ambiguous.id, delivery: 'sent', messageId: 'native-late' });
    expect(wake()).not.toHaveBeenCalled();
  });

  it('takes a final or a repeated question elsewhere in the chat for nothing', async () => {
    const proofless = await makeSession('Foreign final', 'chat-foreign');
    const started = Date.now() - 60_000;
    const unknown = row({ sessionId: proofless, text: 'Run the checks', state: 'browser', owner: 'page', conversationId: 'chat-foreign',
      createdAt: started, offeredAt: started, requiresAuthorization: true, sendAuthorizedAt: started + 500 });
    await seed([unknown]);
    // The same words and another answer's final land in that chat, inside the range of the turn.
    await appendEvent(proofless, { kind: 'user_message', source: 'extension', time: started + 1000, messageId: 'someone-else', message: { text: 'Run the checks', truncated: false, chars: 14 } });
    await appendEvent(proofless, { kind: 'turn_start', source: 'extension', time: started + 1100, turnId: 'other-turn' });
    await appendEvent(proofless, { kind: 'assistant_message', source: 'extension', time: started + 2000, messageId: 'other-final', turnId: 'other-turn', final: true, message: { text: 'Done, all green.', truncated: false, chars: 16 } });
    await appendEvent(proofless, { kind: 'turn_end', source: 'extension', time: started + 2100, outcome: 'completed', turnId: 'other-turn' });

    const listed = (await call('GET', '/v1/inputs')).body.inputs[0];
    expect(listed).toMatchObject({ id: unknown.id, delivery: 'unconfirmed', messageId: null, deliveredAt: null });
    // An outbox row carries no reply, and neither does anything an action returns.
    expect(JSON.stringify(listed)).not.toContain('all green');
    const cancelled = await post('/v1/inputs/' + unknown.id + '/cancel');
    expect(cancelled.body.input.delivery).toBe('unconfirmed');
    expect(cancelled.raw).not.toContain('all green');
  });

  it('keeps two chats that were sent the same words apart, each by its own receipt', async () => {
    const other = await makeSession('Twin', 'chat-twin');
    const confirmed = row({ text: 'Same words', state: 'sent', owner: 'page', conversationId: CHAT, offeredAt: 5, requiresAuthorization: true, sendAuthorizedAt: 6, deliveredAt: 7, messageId: 'native-a', createdAt: 1 });
    const unsure = row({ sessionId: other, text: 'Same words', state: 'browser', owner: 'page-2', conversationId: 'chat-twin', createdAt: 2,
      offeredAt: Date.now(), requiresAuthorization: true, sendAuthorizedAt: Date.now() });
    await seed([confirmed, unsure]);
    const third = await makeSession('Third twin', 'chat-twin-3');
    const fresh = await post('/v1/inputs', sendBody({ sessionId: third, text: 'Same words' }));
    expect(fresh.status).toBe(202);

    const byId = new Map((await call('GET', '/v1/inputs')).body.inputs.map((entry: { id: string }) => [entry.id, entry]));
    expect(byId.get(confirmed.id)).toMatchObject({ delivery: 'sent', messageId: 'native-a' });
    expect(byId.get(unsure.id)).toMatchObject({ delivery: 'unconfirmed', messageId: null });
    expect(byId.get(fresh.body.input.id)).toMatchObject({ delivery: 'pending' });
    expect(byId.size).toBe(3);
  });

  it('settles an injected message only from the final of its own turn', async () => {
    const t0 = Date.now() - 20_000;
    const own = await makeSession('Own turn', 'chat-inj-own');
    const foreign = await makeSession('Foreign turn', 'chat-inj-foreign');
    const inject = (sessionId: string, conversationId: string, owner: string) =>
      row({ sessionId, conversationId, text: 'nudge', state: 'tool', owner, createdAt: t0, offeredAt: t0 + 2_000, toolTurnId: 'turn-own' });
    const rowOwn = inject(own, 'chat-inj-own', 'req-own');
    const rowForeign = inject(foreign, 'chat-inj-foreign', 'req-foreign');
    await seed([rowOwn, rowForeign]);
    for (const [sessionId, conversationId, owner] of [[own, 'chat-inj-own', 'req-own'], [foreign, 'chat-inj-foreign', 'req-foreign']] as const) {
      await appendEvent(sessionId, { kind: 'user_message', source: 'extension', time: t0, messageId: 'q-' + owner, message: text('Do the work') });
      await appendEvent(sessionId, { kind: 'turn_start', source: 'extension', time: t0 + 500, turnId: 'turn-own' });
      await appendEvent(sessionId, { kind: 'tool_call', source: 'mcp', time: t0 + 1_000, turnId: 'turn-own',
        call: toolCall({ requestId: owner, conversationId, attribution: 'request_id', callId: 'call-' + owner }) });
    }
    // In one chat the final belongs to the turn the message was injected into; in the other it
    // belongs to a different turn that happens to sit later in the same journal.
    await appendEvent(own, { kind: 'assistant_message', source: 'extension', time: t0 + 5_000, messageId: 'final-own', turnId: 'turn-own', final: true, message: text('Done.') });
    await appendEvent(own, { kind: 'turn_end', source: 'extension', time: t0 + 5_100, outcome: 'completed', turnId: 'turn-own' });
    await appendEvent(foreign, { kind: 'turn_start', source: 'extension', time: t0 + 4_000, turnId: 'turn-other' });
    await appendEvent(foreign, { kind: 'assistant_message', source: 'extension', time: t0 + 5_000, messageId: 'final-other', turnId: 'turn-other', final: true, message: text('Done elsewhere.') });
    await appendEvent(foreign, { kind: 'turn_end', source: 'extension', time: t0 + 5_100, outcome: 'completed', turnId: 'turn-other' });

    const byId = new Map((await call('GET', '/v1/inputs')).body.inputs.map((entry: { id: string }) => [entry.id, entry]));
    expect(byId.get((rowOwn as { id: string }).id)).toMatchObject({ state: 'sent', delivery: 'sent', messageId: expect.stringMatching(/^input:/) });
    expect(byId.get((rowForeign as { id: string }).id)).toMatchObject({ state: 'tool', delivery: 'unconfirmed', messageId: null, deliveredAt: null });
  });

  it('tells the messages the app filed itself from the ones a person or agent sent', async () => {
    const recovery = row({ text: 'Keep working until the request is complete.', state: 'failed', error: 'After-turn pickup was withdrawn before Send.',
      requiresAuthorization: true, offeredAt: 5, recovery: { questionId: 'q1', pro: false, busyUntil: 0, phase: 'ready' } });
    // A silence boundary can ride a message a person typed, so it alone does not make a row automatic.
    const typed = row({ text: 'typed by a person', silenceBoundary: { turnId: 't1', conversationId: CHAT, workSeq: 1 } });
    await seed([recovery, typed]);
    const listed = new Map((await call('GET', '/v1/inputs')).body.inputs.map((entry: { id: string }) => [entry.id, entry]));
    expect(listed.get(recovery.id)).toMatchObject({ automatic: true, state: 'failed', delivery: 'not_sent' });
    expect(listed.get(typed.id)).toMatchObject({ automatic: false });
  });
});

describe('logging', () => {
  it('records that a message was admitted or cancelled, without its text', async () => {
    const { getLog } = await import('../src/main/logger.js');
    const secret = 'sk-proj-' + randomBytes(24).toString('hex');
    const sent = await post('/v1/inputs', sendBody({ text: 'Use ' + secret }));
    await post('/v1/inputs/' + sent.body.input.id + '/cancel');
    const lines = getLog().map((entry) => entry.message).filter((message) => message.includes(sent.body.input.id));
    expect(lines.some((message) => message.includes('admitted'))).toBe(true);
    expect(lines.some((message) => message.includes('cancelled'))).toBe(true);
    expect(lines.join('\n')).not.toContain(secret);
  });
});
