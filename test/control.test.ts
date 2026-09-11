import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_VERSION_HEADER,
  controlRequestView,
  startControlServer,
  type ControlDependencies,
  type ControlServer
} from '../src/main/control.js';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';

const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function session(id = 'session-control'): SessionSummary {
  return { id, title: 'Controlled task', conversationId: 'conversation-control', chatIds: ['conversation-control'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null };
}

function row(state: InputEntry['state'], overrides: Partial<InputEntry> = {}): InputEntry {
  const input: InputArgs = { id: requestId, sessionId: null, text: 'Run the task', mode: 'auto', dueAt: 100,
    model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' };
  return { ...input, state, owner: null, createdAt: 100, conversationId: null, ...overrides };
}

function dependencies(): ControlDependencies & {
  rows: InputEntry[];
  sessions: Map<string, SessionSummary>;
  recorded: Map<string, SessionEvent[]>;
} {
  const rows: InputEntry[] = [];
  const sessions = new Map<string, SessionSummary>();
  const recorded = new Map<string, SessionEvent[]>();
  return {
    rows, sessions, recorded,
    send: vi.fn(async input => {
      const entry = row('queued', { ...input, createdAt: Date.now() });
      rows.push(entry);
      return entry;
    }),
    cancel: vi.fn(async id => {
      const entry = rows.find(candidate => candidate.id === id);
      if (!entry || !['queued', 'browser'].includes(entry.state)) return false;
      entry.state = 'cancelled';
      return true;
    }),
    inputs: async () => rows.map(entry => ({ ...entry })),
    session: async id => sessions.get(id) ?? null,
    events: async id => recorded.get(id) ?? [],
    overflow: async () => null,
    recording: () => true
  };
}

describe('thin external control', () => {
  let directory: string;
  let server: ControlServer;
  let deps: ReturnType<typeof dependencies>;
  let token: string;
  const call = (pathname: string, init: RequestInit = {}, auth = token, version = String(CONTROL_PROTOCOL_VERSION)) =>
    fetch(`http://127.0.0.1:${server.port}${pathname}`, { ...init, redirect: 'error', headers: {
      authorization: `Bearer ${auth}`,
      [CONTROL_VERSION_HEADER]: version,
      'content-type': 'application/json',
      ...(init.headers ?? {})
    } });

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-control-'));
    deps = dependencies();
    server = await startControlServer(directory, deps);
    token = (await fs.readFile(server.tokenFile, 'utf8')).trim();
  });
  afterEach(async () => {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('publishes loopback discovery and rejects wrong authentication or protocol versions', async () => {
    expect(JSON.parse(await fs.readFile(server.discoveryFile, 'utf8'))).toEqual({ port: server.port, protocolVersion: 1 });
    expect((await call('/v1/capabilities', {}, 'wrong')).status).toBe(401);
    const incompatible = await call('/v1/capabilities', {}, token, '2');
    expect(incompatible.status).toBe(426);
    expect(await incompatible.json()).toMatchObject({ error: { code: 'incompatible_version' } });
    expect(await (await call('/v1/capabilities')).json()).toMatchObject({
      protocolVersion: 1,
      operations: ['submit', 'status', 'result', 'cancel']
    });
  });

  it('uses the outbox UUID as the only submission identity', async () => {
    const payload = { requestId, text: 'Run the task', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' };
    expect((await call('/v1/requests', { method: 'POST', body: JSON.stringify(payload) })).status).toBe(202);
    const duplicate = await call('/v1/requests', { method: 'POST', body: JSON.stringify(payload) });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ idempotent: true, request: { requestId, state: 'queued' } });
    expect(deps.send).toHaveBeenCalledTimes(1);

    const conflict = await call('/v1/requests', { method: 'POST', body: JSON.stringify({ ...payload, text: 'Different task' }) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'request_id_conflict' } });
  });

  it('rejects submission before side effects when exact result recording is off', async () => {
    deps.recording = () => false;
    const response = await call('/v1/requests', { method: 'POST', body: JSON.stringify({ requestId, text: 'Run the task' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'recording_required' } });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('delegates cancellation only to the existing durable input owner', async () => {
    deps.rows.push(row('queued'));
    const response = await call(`/v1/requests/${requestId}/cancel`, { method: 'POST' });
    expect(await response.json()).toMatchObject({ cancelAccepted: true, request: { state: 'cancelled' } });
    expect(deps.cancel).toHaveBeenCalledWith(requestId);
  });

  it('returns only the final answer inside the exact confirmed input boundary', async () => {
    const stored = session();
    deps.sessions.set(stored.id, stored);
    deps.recorded.set(stored.id, [
      { seq: 1, time: 1, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-a',
        inputDelivery: 'confirmed', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 2, source: 'extension', kind: 'turn_start', turnId: 'turn-a' },
      { seq: 3, time: 3, source: 'extension', kind: 'assistant_message', messageId: 'answer-a', turnId: 'turn-a',
        message: { text: 'Exact answer', chars: 12, truncated: false }, final: true, state: 'final' },
      { seq: 4, time: 4, source: 'extension', kind: 'user_message', messageId: 'user-b', message: { text: 'Later', chars: 5, truncated: false } },
      { seq: 5, time: 5, source: 'extension', kind: 'assistant_message', messageId: 'answer-b',
        message: { text: 'Wrong later answer', chars: 18, truncated: false }, final: true, state: 'final' }
    ]);
    const view = await controlRequestView(deps, row('sent', { deliveredSessionId: stored.id, deliveredAt: 2 }));
    expect(view).toMatchObject({
      state: 'completed',
      sessionId: stored.id,
      observedSelection: { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
      result: { text: 'Exact answer', truncated: false }
    });
  });

  it('does not guess completion from an unconfirmed handout or another turn', async () => {
    const stored = session();
    deps.sessions.set(stored.id, stored);
    deps.recorded.set(stored.id, [
      { seq: 1, time: 1, source: 'app', kind: 'user_message', inputId: requestId, messageId: `input:${requestId}`,
        inputDelivery: 'offered', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 2, source: 'extension', kind: 'assistant_message', messageId: 'unowned',
        message: { text: 'Unowned answer', chars: 14, truncated: false }, final: true, state: 'final' }
    ]);
    const view = await controlRequestView(deps, row('sent', { deliveredSessionId: stored.id, deliveredAt: 2 }));
    expect(view.state).toBe('running');
    expect(view).not.toHaveProperty('result');
  });

  it('removes only its own discovery descriptor when the listener closes', async () => {
    const discovery = JSON.parse(await fs.readFile(server.discoveryFile, 'utf8'));
    expect(discovery.port).toBe(server.port);
    await server.close();
    await expect(fs.readFile(server.discoveryFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
