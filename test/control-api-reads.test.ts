/**
 * The control API's read routes over real loopback HTTP and the real session store: what they
 * return, what they refuse, and that a projection publishes only the fields it names.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, ToolCallRecord } from '../src/shared/session.js';
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
const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests, upsertMessageEvent } = await import('../src/main/session/store.js');
const { cancelInput, enqueueInput } = await import('../src/main/session/input.js');
const { logInfo, logWarn, logError } = await import('../src/main/logger.js');
const { redactSecretText } = await import('../src/main/redaction.js');
const { prependUserPrompt } = await import('../src/shared/user-prompt.js');
const controlApi = await import('../src/main/control-api.js');
const reads = await import('../src/main/control-reads.js');

let dir: string;
let port = 0;
let auth: Record<string, string> = {};

// Built at run time so no secret-shaped literal sits in the source.
const apiKey = `sk-proj-${randomBytes(24).toString('hex')}`;
const text = (value: string) => ({ text: value, truncated: false, chars: value.length });

function call(route: string, headers: Record<string, string> = auth): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const toolCall = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  callId: 'call-1',
  tool: 'exec_command',
  attribution: 'request_id',
  requestId: 'req-1',
  conversationId: null,
  attributionMethod: 'request_id',
  args: text(JSON.stringify({ cmd: `curl -H "Authorization: ${apiKey}" https://example.test` })),
  result: text('ok'),
  outcome: 'ok',
  durationMs: 12,
  summary: { title: 'Ran curl', tone: 'neutral', kind: 'run' },
  changes: [{ path: 'src/a.ts', added: 3, removed: 1, approximate: false, reviewAssetId: 'asset-secret' }],
  ...over
});

let sessionId: string;
let liveSessionId: string;
let firstAssistantSeq = 0;
let revisionSeq = 0;
const allIds: string[] = [];

beforeAll(async () => {
  dir = await makeTempDir('clf-control-reads-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  controlApi.initControlApiPath(dir);

  const session = await createSession({ title: `Audit me ${apiKey}` });
  sessionId = session.id;
  await appendEvent(sessionId, { kind: 'user_message', source: 'extension', time: 10, message: text('Please run the checks') });
  const assistant = { kind: 'assistant_message' as const, source: 'extension' as const, time: 20, messageId: 'm1', message: text('x'.repeat(9_000)), final: true };
  firstAssistantSeq = (await upsertMessageEvent(sessionId, assistant)).event.seq;
  await appendEvent(sessionId, { kind: 'tool_call', source: 'mcp', time: 30, call: toolCall() });
  await appendEvent(sessionId, { kind: 'note', source: 'app', time: 40, message: text('A note') });
  await appendEvent(sessionId, { kind: 'turn_end', source: 'extension', time: 50, outcome: 'completed', turnId: 'turn-1' });
  // A revision keeps the message's first position but takes the newest seq.
  revisionSeq = (await upsertMessageEvent(sessionId, { ...assistant, renderedHtml: text('<p>x</p>') })).event.seq;

  const others = [await createSession({ title: 'Second' }), await createSession({ title: 'Third' })];
  liveSessionId = (await createSession({ title: 'Has a chat', conversationId: 'chat-live-1' })).id;
  allIds.push(sessionId, ...others.map((row) => row.id), liveSessionId);

  await controlApi.startControlApi();
  const endpoint = JSON.parse(await fs.readFile(path.join(dir, 'control-api', 'endpoint.json'), 'utf8'));
  const token = (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim();
  port = endpoint.port;
  auth = { authorization: `Bearer ${token}` };
});

afterAll(async () => {
  await controlApi.shutdownControlApi();
  await flushDurable();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

describe('read routes', () => {
  it('are listed by health and need the token like every other route', async () => {
    const health = await call('/v1/health');
    expect(health.body.routes).toEqual([
      '/v1/health', '/v1/status', '/v1/sessions', '/v1/sessions/{id}', '/v1/sessions/{id}/events', '/v1/inputs', '/v1/agents', '/v1/log'
    ]);
    for (const route of ['/v1/sessions', `/v1/sessions/${sessionId}`, `/v1/sessions/${sessionId}/events`, '/v1/inputs', '/v1/agents', '/v1/log']) {
      expect((await call(route, {})).status).toBe(401);
      expect((await call(route)).status).toBe(200);
    }
  });

  it('refuse unknown, repeated and malformed parameters instead of ignoring them', async () => {
    for (const route of [
      '/v1/sessions?limit=0',
      '/v1/sessions?limit=51',
      '/v1/sessions?limit=abc',
      '/v1/sessions?limit=1&limit=2',
      '/v1/sessions?verbose=1',
      '/v1/sessions?cursor=nonsense',
      '/v1/sessions?cursor=',
      '/v1/sessions?__proto__=1',
      '/v1/sessions?constructor=1',
      `/v1/sessions/${sessionId}?x=1`,
      `/v1/sessions/${sessionId}?live=yes`,
      `/v1/sessions/${sessionId}/events?limit=101`,
      `/v1/sessions/${sessionId}/events?kinds=user_message,bogus`,
      `/v1/sessions/${sessionId}/events?kinds=`,
      `/v1/sessions/${sessionId}/events?from=1&before=5`,
      `/v1/sessions/${sessionId}/events?from=1&after=0`,
      '/v1/inputs?state=deleted',
      '/v1/inputs?state=decision',
      '/v1/inputs?limit=501',
      '/v1/agents?x=1',
      '/v1/log?level=debug',
      '/v1/log?since=-1'
    ]) {
      const response = await call(route);
      expect(response.status, route).toBe(400);
      expect(response.body.error).toBe('invalid_query');
    }
    expect((await call('/v1/sessions?__proto__=1')).body.detail).toBe('unknown parameter');
  });

  it('answer 404 for an unknown session and for ids that cannot be sessions', async () => {
    const missing = await call('/v1/sessions/2026-01-01-deadbeef');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('session_not_found');
    expect((await call('/v1/sessions/2026-01-01-deadbeef/events')).body.error).toBe('session_not_found');
    for (const route of ['/v1/sessions/short', '/v1/sessions/..%2F..%2Fconfig', `/v1/sessions/${sessionId}/other`, '/v1/sessions/a/b/c']) {
      expect((await call(route)).status, route).toBe(404);
    }
  });

  it('do not resolve a differently cased spelling of a session id', async () => {
    // A case-insensitive filesystem would otherwise open the same journal under a second name.
    // Session ids are random lowercase hex, so about one in 43 has no letter at all and upper-cases to
    // itself. Use one that has a letter, or the check would pass or fail by chance.
    let cased = sessionId;
    for (let attempt = 0; cased.toUpperCase() === cased && attempt < 50; attempt++) cased = (await createSession({ title: 'Cased' })).id;
    expect(cased.toUpperCase()).not.toBe(cased);
    const before = (await call('/v1/sessions?limit=50')).body.total;
    for (const route of [`/v1/sessions/${cased.toUpperCase()}`, `/v1/sessions/${cased.toUpperCase()}/events`]) {
      const response = await call(route);
      expect(response.status, route).toBe(404);
      expect(response.body.error).toBe('not_found');
    }
    expect((await call('/v1/sessions?limit=50')).body.total).toBe(before);
  });

  it('turn away a burst of journal reads instead of holding them all in memory', async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => reads.serveRead(`/v1/sessions/${sessionId}/events`, new URLSearchParams()))
    );
    const refused = settled.filter((result) => result.status === 'rejected');
    expect(refused.length).toBeGreaterThan(0);
    for (const result of refused) expect(result).toMatchObject({ reason: { status: 503, code: 'busy' } });
    expect(settled.some((result) => result.status === 'fulfilled')).toBe(true);
    // The count is released, so the next read goes through.
    expect((await call(`/v1/sessions/${sessionId}/events`)).status).toBe(200);
  });
});

describe('sessions', () => {
  it('publishes exactly the named fields, with the title redacted', async () => {
    const { body } = await call(`/v1/sessions/${sessionId}`);
    expect(Object.keys(body)).toEqual(['session']);
    expect(Object.keys(body.session).sort()).toEqual([
      'activeTurnId', 'activityExpiresAt', 'agents', 'contextTokens', 'conversationId', 'endedAt', 'errors', 'estimatedTokens',
      'events', 'id', 'lastAssistantFinalAt', 'lastToolCallAt', 'lastTurnEndAt', 'lastTurnOutcome', 'model', 'origin',
      'processExitNonzero', 'projectId', 'startedAt', 'title', 'toolCalls', 'toolInternalErrors', 'toolRejected', 'updatedAt', 'userMessages'
    ]);
    expect(body.session).toMatchObject({ id: sessionId, userMessages: 1, toolCalls: 1 });
    expect(body.session.title).toBe('Audit me [redacted]');
    expect(JSON.stringify(body)).not.toContain(apiKey);
  });

  it('attaches live state only when asked, and is null for a chat with nothing to describe', async () => {
    const never = await call(`/v1/sessions/${sessionId}?live=1`);
    expect(never.body.live).toBeNull();

    const attached = await call(`/v1/sessions/${liveSessionId}?live=1`);
    expect(attached.status).toBe(200);
    expect(attached.body.session.conversationId).toBe('chat-live-1');
    expect(attached.body.live).toEqual({ activeTurnId: null, stopPending: false, automation: 'off', blocked: '' });
    expect(Object.keys((await call(`/v1/sessions/${liveSessionId}`)).body)).toEqual(['session']);
  });

  it('lists newest first and walks every session once with a cursor', async () => {
    const full = await call('/v1/sessions?limit=50');
    const ids = full.body.sessions.map((row: { id: string }) => row.id);
    const times = full.body.sessions.map((row: { updatedAt: number }) => row.updatedAt);
    expect(full.body.total).toBe(ids.length);
    for (const id of allIds) expect(ids).toContain(id);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(full.body.sessions[0].pressure).toEqual({ level: 'ok', advisory: expect.any(Number), limit: expect.any(Number) });
    expect(full.body.nextCursor).toBeNull();

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page <= ids.length; page += 1) {
      const response: { body: any } = await call(`/v1/sessions?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(response.body.sessions).toHaveLength(1);
      expect(response.body.nextCursor === null || /^\d+\.[0-9a-z-]+$/.test(response.body.nextCursor)).toBe(true);
      walked.push(response.body.sessions[0].id);
      cursor = response.body.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(walked).toEqual(ids);
  });

  it('never carries a stored field the projection does not name', () => {
    const projected = reads.projectSession({
      id: 'abc12345', title: 'T', conversationId: 'chat-b', chatIds: ['c1', 'c2'], startedAt: 1, updatedAt: 2, endedAt: null,
      events: 0, userMessages: 0, toolCalls: 0, lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0,
      toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0, lastHandoffId: 'h1', lastHandoffAt: null,
      lastTurnOutcome: null, agents: [], origin: { kind: 'worker', fromSessionId: 'abc00000', agentId: 'worker-1', task: `Fix ${apiKey}` },
      timelineTurns: { secret: true }, requestTurns: { secret: true }, retiredChatAt: { c1: 1 }, finishTurn: { turnId: 't' },
      selectedModel: { conversationId: 'chat-b', model: 'gpt-x', observedAt: 1 }
    } as never);
    const raw = JSON.stringify(projected);
    for (const hidden of ['chatIds', 'timelineTurns', 'requestTurns', 'retiredChatAt', 'finishTurn', 'lastHandoffId', 'secret', apiKey]) {
      expect(raw).not.toContain(hidden);
    }
    expect(projected.model).toBe('gpt-x');
    expect(projected.origin).toEqual({ kind: 'worker', fromSessionId: 'abc00000', agentId: 'worker-1', task: 'Fix [redacted]' });
  });

  it('does not report the model of an earlier chat of the session', () => {
    const summary = { id: 'abc12345', title: 'T', conversationId: 'chat-b', agents: [], origin: null,
      selectedModel: { conversationId: 'chat-a', model: 'gpt-old', observedAt: 1 } };
    expect(reads.projectSession(summary as never).model).toBeNull();
  });
});

describe('session events', () => {
  it('projects each kind through its allowlist and cuts long text', async () => {
    const { body } = await call(`/v1/sessions/${sessionId}/events`);
    expect(body.events.map((event: { kind: string }) => event.kind)).toEqual(['user_message', 'assistant_message', 'tool_call', 'note', 'turn_end']);
    expect(body.total).toBeGreaterThanOrEqual(5);

    const assistant = body.events[1];
    expect(assistant.message.text).toHaveLength(4_000);
    expect(assistant.message).toMatchObject({ chars: 9_000, truncated: true });
    expect(assistant).toMatchObject({ messageId: 'm1', final: true });

    const tool = body.events[2].tool;
    expect(Object.keys(tool).sort()).toEqual(['args', 'attribution', 'callId', 'changes', 'durationMs', 'name', 'outcome', 'result', 'summary']);
    expect(tool).toMatchObject({ name: 'exec_command', outcome: 'ok', changes: [{ path: 'src/a.ts', added: 3, removed: 1 }] });
    expect(Object.keys(tool.changes[0]).sort()).toEqual(['added', 'path', 'removed']);
    expect(tool.args.text).toContain('[redacted]');

    const raw = JSON.stringify(body);
    expect(raw).not.toContain(apiKey);
    for (const hidden of ['reviewAssetId', 'asset-secret', 'requestId', 'req-1', 'approximate']) expect(raw).not.toContain(hidden);
  });

  it('exposes a position that pages through history even when a message was revised', async () => {
    const tail = await call(`/v1/sessions/${sessionId}/events`);
    const assistant = tail.body.events.find((event: { kind: string }) => event.kind === 'assistant_message');
    // The revision took a later seq than its first appearance; only position is a usable cursor.
    expect(assistant.position).toBe(firstAssistantSeq);
    expect(assistant.seq).toBe(revisionSeq);
    expect(assistant.seq).toBeGreaterThan(assistant.position);

    const positions = tail.body.events.map((event: { position: number }) => event.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    const seen: string[] = [];
    let after = 0;
    for (let page = 0; page < 10; page += 1) {
      const response = await call(`/v1/sessions/${sessionId}/events?after=${after}&limit=2`);
      if (response.body.events.length === 0) break;
      seen.push(...response.body.events.map((event: { kind: string }) => event.kind));
      after = response.body.events.at(-1).position;
    }
    expect(seen).toEqual(['user_message', 'assistant_message', 'tool_call', 'note', 'turn_end']);

    const older = await call(`/v1/sessions/${sessionId}/events?before=${assistant.position}&limit=5`);
    expect(older.body.events.map((event: { kind: string }) => event.kind)).toEqual(['user_message']);
    const newer = await call(`/v1/sessions/${sessionId}/events?after=${assistant.position}&limit=1`);
    expect(newer.body.events.map((event: { kind: string }) => event.kind)).toEqual(['tool_call']);
  });

  it('filters by kind, alone and with a history cursor', async () => {
    const kinds = async (query: string) =>
      (await call(`/v1/sessions/${sessionId}/events?${query}`)).body.events.map((event: { kind: string }) => event.kind);
    expect(await kinds('kinds=user_message,turn_end')).toEqual(['user_message', 'turn_end']);
    expect(await kinds('kinds=note,turn_end&after=0')).toEqual(['note', 'turn_end']);
    expect(await kinds(`kinds=user_message,note&before=${firstAssistantSeq + 10}`)).toEqual(['user_message', 'note']);
    expect(await kinds('kinds=chat_error')).toEqual([]);
  });

  it('follows a session live from a seq cursor', async () => {
    const first = await call(`/v1/sessions/${sessionId}/events?from=0&limit=100`);
    expect(first.body.events.length).toBeGreaterThan(0);
    const cursor = first.body.nextFrom;
    expect(cursor).toBe(Math.max(...first.body.events.map((event: { seq: number }) => event.seq)) + 1);

    const idle = await call(`/v1/sessions/${sessionId}/events?from=${cursor}`);
    expect(idle.body.events).toEqual([]);
    expect(idle.body.nextFrom).toBe(cursor);

    const added = await appendEvent(sessionId, { kind: 'note', source: 'app', time: 60, message: text('Later note') });
    const next = await call(`/v1/sessions/${sessionId}/events?from=${cursor}`);
    expect(next.body.events).toHaveLength(1);
    expect(next.body.events[0]).toMatchObject({ kind: 'note', seq: added.seq, message: { text: 'Later note' } });
    expect(next.body.nextFrom).toBe(added.seq + 1);
  });

  it('describes a kind it has never heard of by name only', () => {
    const future = { seq: 7, time: 9, kind: 'future_kind', source: 'app', secret: apiKey, message: text(apiKey) };
    expect(reads.projectEvent(future as never)).toEqual({ seq: 7, position: 7, time: 9, kind: 'future_kind', source: 'app' });
  });

  it('publishes exactly the named fields for every other kind', () => {
    const base = { seq: 4, time: 9, source: 'app' as const };
    const keys = (event: object) => Object.keys(JSON.parse(JSON.stringify(reads.projectEvent(event as SessionEvent)))).sort();
    const common = ['kind', 'position', 'seq', 'source', 'time'];
    const cases: Array<[object, string[]]> = [
      [{ ...base, kind: 'session_start', conversationId: 'c1', title: 'T' }, ['conversationId', 'title']],
      [{ ...base, kind: 'progress', message: text('working'), progressId: 'secret-progress' }, ['message']],
      [{ ...base, kind: 'page_tool', messageId: 'm', label: 'Searching' }, ['label']],
      [{ ...base, kind: 'turn_start', detail: 'reopened' }, ['detail']],
      [{ ...base, kind: 'turn_end', outcome: 'completed', providerMessageId: 'secret-provider' }, ['outcome']],
      [{ ...base, kind: 'chat_error', message: text('boom'), recoverable: true, blocking: false }, ['blocking', 'message', 'recoverable']],
      [{ ...base, kind: 'native_image', messageId: 'm', providerAssetId: 'secret-asset', providerRole: 'tool', previewStatus: 'available', width: 3, height: 4 }, ['height', 'previewStatus', 'width']],
      [{ ...base, kind: 'agent_message', messageId: 'am', from: 'prime', to: 'worker-1', message: text('go'), delivery: 'sent' }, ['delivery', 'from', 'message', 'messageId', 'to']],
      [{ ...base, kind: 'handoff', handoffId: 'h', chars: 12, reason: 'manual' }, ['chars', 'handoffId', 'reason']]
    ];
    for (const [event, own] of cases) {
      expect(keys(event), JSON.stringify(event)).toEqual([...common, ...own].sort());
      expect(JSON.stringify(reads.projectEvent(event as SessionEvent))).not.toContain('secret');
    }
  });

  it('keeps the stored length when the recorder already cut a text, and never splits a surrogate pair', () => {
    const cut = reads.projectEvent({ seq: 1, time: 1, source: 'app', kind: 'note', message: { text: 'a'.repeat(50), truncated: true, chars: 50_000 } } as never);
    expect(cut.message).toEqual({ text: 'a'.repeat(50), chars: 50_000, truncated: true });

    const emoji = `a${'\u{1F600}'.repeat(3_000)}`;
    const clipped = reads.projectEvent({ seq: 1, time: 1, source: 'app', kind: 'note', message: text(emoji) } as never).message!;
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toHaveLength(3_999);
    const last = clipped.text.charCodeAt(clipped.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('shows what the user wrote, not the instructions the app framed it with', () => {
    const framed = prependUserPrompt('Fix the failing test', `Project rules. ${'r'.repeat(6_000)}`);
    expect(framed.length).toBeGreaterThan(6_000);
    const event = (extra: object) => reads.projectEvent({ seq: 1, time: 1, source: 'app', kind: 'user_message', message: text(framed), ...extra } as never);
    expect(event({}).message).toMatchObject({ text: 'Fix the failing test', truncated: false });
    expect(event({ authoredText: 'Fix it' }).message).toMatchObject({ text: 'Fix it', chars: 6, truncated: false });
    // A plain message is published as recorded.
    expect(reads.projectEvent({ seq: 1, time: 1, source: 'extension', kind: 'user_message', message: text('hello') } as never).message).toMatchObject({ text: 'hello' });
  });

  it('reports the normalised outcome and tool text under its own, smaller cap', () => {
    const call = toolCall({
      outcome: 'rejected' as never,
      args: text('a'.repeat(5_000)),
      result: text('r'.repeat(5_000)),
      changes: Array.from({ length: 30 }, (_, index) => ({ path: `src/${'d'.repeat(300)}${index}.ts`, added: 1, removed: 0, approximate: false }))
    });
    const { tool } = reads.projectEvent({ seq: 1, time: 1, source: 'mcp', kind: 'tool_call', call } as never);
    expect(tool!.outcome).toBe('tool_rejected');
    expect(tool!.args).toMatchObject({ chars: 5_000, truncated: true });
    expect(tool!.args.text).toHaveLength(2_000);
    expect(tool!.result.text).toHaveLength(2_000);
    expect(tool!.changes).toHaveLength(20);
    expect(tool!.changes[0]!.path).toHaveLength(200);
  });

  it('names a row it cannot read instead of failing the page', () => {
    const broken = { seq: 9, time: 1, source: 'app', kind: 'note' };
    expect(() => reads.projectEvent(broken as never)).toThrow();
    expect(reads.projectReadableEvent(broken as never)).toEqual({ seq: 9, position: 9, time: 1, kind: 'note', source: 'app', unreadable: true });
    const fine = { seq: 10, time: 1, source: 'app', kind: 'note', message: text('ok') };
    expect(reads.projectReadableEvent(fine as never)).toMatchObject({ seq: 10, message: { text: 'ok' } });
  });
});

describe('input outbox', () => {
  const entry = (over: object = {}) => ({
    id: randomUUID(), sessionId: null, text: 'hello', mode: 'auto', dueAt: 1, model: null, reasoningEffort: null,
    state: 'queued', owner: null, createdAt: 1, conversationId: null, ...over
  }) as never;

  it('lists queued messages with text cut and redacted and without delivery internals', async () => {
    const queued = await enqueueInput({
      id: randomUUID(),
      sessionId: null,
      text: `Deploy with ${apiKey} ${'y'.repeat(5_000)}`,
      mode: 'auto',
      dueAt: Date.now(),
      model: null,
      reasoningEffort: null
    });
    const all = await call('/v1/inputs');
    const row = all.body.inputs.find((input: { id: string }) => input.id === queued.id);
    expect(row).toBeDefined();
    expect(row.text.text).toHaveLength(4_000);
    expect(row.text).toMatchObject({ truncated: true });
    expect(row.text.chars).toBeGreaterThan(4_000);
    expect(JSON.stringify(all.body)).not.toContain(apiKey);
    expect(Object.keys(row).sort()).toEqual([
      'attachments', 'cancelledByUser', 'conversationId', 'createdAt', 'deliveredAt', 'deliveredSessionId', 'dueAt', 'error', 'id',
      'images', 'messageId', 'mode', 'model', 'offeredAt', 'purpose', 'queueOrder', 'reasoningEffort', 'requiresAuthorization',
      'sendAuthorizedAt', 'sessionId', 'state', 'text'
    ]);

    expect((await call(`/v1/inputs?state=${row.state}`)).body.inputs.map((input: { id: string }) => input.id)).toContain(queued.id);
    expect(await cancelInput(queued.id)).toBe(true);
    const cancelled = await call('/v1/inputs?state=cancelled');
    expect(cancelled.body.inputs.map((input: { id: string }) => input.id)).toContain(queued.id);
    expect(cancelled.body.inputs.every((input: { state: string }) => input.state === 'cancelled')).toBe(true);
    expect((await call(`/v1/inputs?state=${row.state === 'cancelled' ? 'failed' : row.state}`)).body.inputs.map((input: { id: string }) => input.id)).not.toContain(queued.id);
  });

  it('drops the fields an outbox row carries only for its own delivery', () => {
    const projected = reads.projectInput(entry({
      owner: 'request-id-secret', deliveryText: `wrapped ${apiKey}`, response: 'private', toolImages: [{ name: 'i', dataUrl: 'data:secret' }],
      attachments: [{ id: 'a', name: 'C:\\private\\file.txt' }], silenceBoundary: { turnId: 't' },
      recovery: { questionId: 'q-secret' }, directTurn: { id: 'd-secret' }, finishOwner: { turnId: 'f-secret' }
    }));
    const raw = JSON.stringify(projected);
    for (const hidden of ['wrapped', 'private', 'data:secret', 'silenceBoundary', 'request-id-secret', 'q-secret', 'd-secret', 'f-secret', 'owner']) {
      expect(raw).not.toContain(hidden);
    }
    expect(projected).toMatchObject({ attachments: 1, images: 0, state: 'queued', text: { text: 'hello', chars: 5, truncated: false } });
  });

  it('selects by state, hides decision rows and keeps the newest rows by creation time', () => {
    const rows = [
      entry({ id: 'a', createdAt: 5, state: 'queued', queueOrder: 0 }),
      entry({ id: 'b', createdAt: 1, state: 'sent', dueAt: 1 }),
      entry({ id: 'c', createdAt: 9, state: 'queued', dueAt: 1_790_000_000_000 }),
      entry({ id: 'd', createdAt: 7, state: 'decision', purpose: 'decision' }),
      entry({ id: 'e', createdAt: 3, state: 'cancelled' })
    ];
    const ids = (selected: { rows: Array<{ id: string }> }) => selected.rows.map((row) => row.id);
    expect(ids(reads.selectInputs(rows, { limit: 10 }))).toEqual(['b', 'e', 'a', 'c']);
    expect(reads.selectInputs(rows, { limit: 10 }).total).toBe(4);
    expect(ids(reads.selectInputs(rows, { state: ['queued'], limit: 10 }))).toEqual(['a', 'c']);
    // A reordered row (queueOrder 0) sorts first in the queue, but a small limit still keeps the newest.
    expect(ids(reads.selectInputs(rows, { limit: 2 }))).toEqual(['a', 'c']);
    expect(reads.selectInputs(rows, { limit: 2 }).total).toBe(4);
    expect(ids(reads.selectInputs(rows, { state: ['sent', 'cancelled'], limit: 10 }))).toEqual(['b', 'e']);
  });
});

describe('agents', () => {
  it('serves the swarm as the broker holds it', async () => {
    expect((await call('/v1/agents')).body).toEqual({ enabled: expect.any(Boolean), running: false, agents: [] });
  });

  it('publishes an agent without its recovery bookkeeping', () => {
    const agent = {
      runId: 'run-1', primeConversationId: 'prime-chat', id: 'worker-1', role: 'worker', label: 'Fixer', task: `Fix it with ${apiKey}`,
      reasoningEffort: null, model: 'gpt-x', state: 'sleeping', createdAt: 1, activatedAt: 2, finishedAt: 3, result: `Done. ${'d'.repeat(5_000)}`,
      pending: 1, awaitingAck: 0, delivered: 3, conversationId: 'chat-1', detachedAt: null, lastSeenAt: 5, revivable: true,
      silenceParked: true, silenceRecoveryTurnId: 'turn-secret', silenceRecoveryRequestOriginMax: 9,
      lastRevivalCommandId: 'command-secret', sleptAt: 4, contextTokens: 100
    };
    const projected = reads.projectAgents({ enabled: true, running: true, agents: [agent] } as never);
    const raw = JSON.stringify(projected);
    for (const hidden of ['turn-secret', 'command-secret', 'prime-chat', 'silence', apiKey]) expect(raw).not.toContain(hidden);
    expect(Object.keys(projected.agents[0]!).sort()).toEqual([
      'activatedAt', 'awaitingAck', 'contextTokens', 'conversationId', 'createdAt', 'delivered', 'detachedAt', 'finishedAt', 'id',
      'label', 'lastSeenAt', 'model', 'pending', 'reasoningEffort', 'result', 'revivable', 'role', 'runId', 'sleptAt', 'state', 'task'
    ]);
    expect(projected.agents[0]).toMatchObject({ task: { text: 'Fix it with [redacted]', truncated: false }, result: { chars: 5_006, truncated: true } });
    expect(projected.agents[0]!.result!.text).toHaveLength(4_000);
  });
});

describe('activity log', () => {
  it('serves the newest entries, filtered by level and time', async () => {
    const marker = randomBytes(6).toString('hex');
    const before = Date.now() - 1;
    logInfo(`reads-test info ${marker}`);
    logWarn(`reads-test warn ${marker}`);
    logError(`reads-test error ${marker}`);

    const ours = (entries: Array<{ message: string; level: string }>) => entries.filter((entry) => entry.message.includes(marker)).map((entry) => entry.level);
    const all = await call(`/v1/log?since=${before}`);
    expect(ours(all.body.entries)).toEqual(['info', 'warn', 'error']);
    expect(all.body.ringSize).toBeGreaterThanOrEqual(3);
    expect(ours((await call(`/v1/log?since=${before}&level=warn,error`)).body.entries)).toEqual(['warn', 'error']);

    const last = await call('/v1/log?limit=1');
    expect(last.body.entries).toHaveLength(1);
    expect(all.body.entries.map((entry: { time: number }) => entry.time)).toEqual(all.body.entries.map((entry: { time: number }) => entry.time).sort((a: number, b: number) => a - b));
    expect((await call(`/v1/log?since=${Date.now() + 60_000}`)).body.entries).toEqual([]);
  });

  it('includes the line at the given time, so a caller cannot lose one written in the same millisecond', async () => {
    const marker = randomBytes(6).toString('hex');
    logInfo(`reads-test boundary ${marker}`);
    const { entries } = (await call('/v1/log?limit=500')).body;
    const mine = entries.find((entry: { message: string }) => entry.message.includes(marker));
    const again = await call(`/v1/log?since=${mine.time}&limit=500`);
    expect(again.body.entries.some((entry: { message: string }) => entry.message.includes(marker))).toBe(true);
  });

  it('masks credential shapes and cuts a very long line, and says so', () => {
    const [long] = reads.projectLog([{ time: 1, level: 'info', message: 'z'.repeat(9_000) }]);
    expect(long!.message).toHaveLength(4_000);
    expect(long!.truncated).toBe(true);
    const [masked] = reads.projectLog([{ time: 1, level: 'warn', message: `retry with Authorization: Bearer ${'t'.repeat(30)}`, agent: 'worker-1' }]);
    expect(masked).toEqual({ time: 1, level: 'warn', message: 'retry with Authorization: Bearer [redacted]', agent: 'worker-1' });
  });
});

describe('secret redaction', () => {
  const shapes: Record<string, string> = {
    'github token': `ghp_${'aB3'.repeat(12)}`,
    'github fine-grained token': `github_pat_${'aB3'.repeat(16)}`,
    'slack token': `xoxb-${'1234567890-'.repeat(3)}abc`,
    'aws access key': `AKIA${'Q'.repeat(16)}`,
    'google api key': `AIza${'x'.repeat(35)}`,
    'stripe key': `sk_live_${'a1'.repeat(12)}`,
    jwt: `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`
  };

  it.each(Object.entries(shapes))('masks a %s', (_name, secret) => {
    const out = redactSecretText(`before ${secret} after`);
    expect(out).toBe('before [redacted] after');
  });

  it('masks headers, URL passwords, private keys and MCP endpoint paths', () => {
    const token = 'k'.repeat(43);
    expect(redactSecretText(`curl -H "Authorization: Bearer ${token}" -H 'authorization: basic ZHVtbXk6ZHVtbXk='`)).toBe(
      'curl -H "Authorization: Bearer [redacted]" -H \'authorization: basic [redacted]\''
    );
    expect(redactSecretText(`Bearer ${token}`)).toBe('Bearer [redacted]');
    expect(redactSecretText('postgres://admin:hunter2@db.internal:5432/app')).toBe('postgres://[redacted]@db.internal:5432/app');
    expect(redactSecretText(`https://tunnel.example/mcp/core/${token}`)).toBe('https://tunnel.example/mcp/core/[redacted]');
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy', '-----END RSA PRIVATE KEY-----'].join('\n');
    expect(redactSecretText(`key:\n${pem}\ndone`)).toBe('key:\n[redacted private key]\ndone');
    expect(redactSecretText('-----BEGIN PRIVATE KEY-----\nMIIBOgIBAAJB')).toBe('[redacted private key]');
  });

  it('leaves hashes, ids and ordinary prose alone', () => {
    const untouched = [
      '9fceb02d0ae598e95dc970b74767f19372d61af8',
      randomUUID(),
      'Basic configuration is described in the implementation-details section',
      'The bearer of this note should read src/main/control-reads.ts',
      'https://example.test/docs/mcp/overview',
      'user@example.test'
    ];
    for (const text of untouched) expect(redactSecretText(text)).toBe(text);
  });
});
