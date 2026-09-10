import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelCatalog } from '../src/shared/chat-models.js';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';
import type { ConnectionStatus } from '../src/shared/types.js';
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_VERSION_HEADER,
  controlRequestView,
  startControlServer,
  type ControlDependencies,
  type ControlServer
} from '../src/main/control.js';
import { controlInputFingerprint, type InputArgs, type InputEntry } from '../src/main/session/input.js';

const model = { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Thinking', efforts: ['high', 'xhigh'] as const };
const catalog: ChatModelCatalog = { state: 'ready', requestedAt: 1, observedAt: 2,
  models: [{ ...model, efforts: [...model.efforts] }] };
const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function summary(id = 'session-control'): SessionSummary {
  return { id, title: 'Controlled task', conversationId: 'conversation-control', chatIds: ['conversation-control'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null };
}

function row(state: InputEntry['state'], overrides: Partial<InputEntry> = {}): InputEntry {
  const input: InputArgs = { id: requestId, sessionId: null, text: 'Run the task', mode: 'auto', dueAt: 100,
    model: model.id, reasoningEffort: 'xhigh' };
  return { ...input, backgroundDelivery: true, controlFingerprint: controlInputFingerprint(input), state,
    owner: null, createdAt: 100, conversationId: null, ...overrides };
}

function dependencies(): ControlDependencies & { rows: InputEntry[]; sessionsById: Map<string, SessionSummary>; eventsById: Map<string, SessionEvent[]> } {
  const rows: InputEntry[] = [];
  const sessionsById = new Map<string, SessionSummary>();
  const eventsById = new Map<string, SessionEvent[]>();
  const connection: ConnectionStatus = { state: 'disconnected', detail: '', publicUrl: null, localUrl: null,
    handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] };
  return {
    rows, sessionsById, eventsById,
    send: vi.fn(async input => {
      const entry = row('queued', { ...input, backgroundDelivery: true, controlFingerprint: controlInputFingerprint(input), createdAt: Date.now() });
      rows.push(entry);
      return entry;
    }),
    cancel: vi.fn(async id => {
      const entry = rows.find(candidate => candidate.id === id);
      if (!entry || !['queued', 'browser'].includes(entry.state)) return false;
      entry.state = 'cancelled';
      return true;
    }),
    cancelDelivered: vi.fn(async id => {
      const entry = rows.find(candidate => candidate.id === id);
      if (!entry || entry.state !== 'sent' || entry.backgroundDelivery !== true) return false;
      entry.state = 'cancelled';
      return true;
    }),
    inputs: async () => rows.map(entry => ({ ...entry })),
    models: () => structuredClone(catalog),
    refreshModels: vi.fn(async (): Promise<ChatModelCatalog> => ({ ...structuredClone(catalog), state: 'pending' })),
    projects: async () => [{ id: '11111111-2222-4333-8444-555555555555', name: 'Coin', path: 'F:\\Coin', createdAt: 1 }],
    session: async id => sessionsById.get(id) ?? null,
    sessions: async () => ({ sessions: [...sessionsById.values()], total: sessionsById.size, nextCursor: null }),
    events: async id => eventsById.get(id) ?? [],
    overflow: async () => null,
    stop: vi.fn(async () => ({})),
    recording: () => true,
    roots: () => [{ name: 'coin', path: 'F:\\Coin' }],
    connection: () => structuredClone(connection),
    connect: vi.fn(async () => { connection.state = 'connected'; connection.handshakeAt = 123; })
  };
}

describe('authenticated external control', () => {
  let directory: string;
  let server: ControlServer;
  let deps: ReturnType<typeof dependencies>;
  let token: string;
  const call = (pathname: string, init: RequestInit = {}, auth = token, version = String(CONTROL_PROTOCOL_VERSION)) =>
    fetch(`http://127.0.0.1:${server.port}${pathname}`, { ...init, redirect: 'error', headers: {
      authorization: `Bearer ${auth}`, [CONTROL_VERSION_HEADER]: version, 'content-type': 'application/json', ...(init.headers ?? {})
    } });

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-control-'));
    deps = dependencies();
    server = await startControlServer(directory, deps);
    token = (await fs.readFile(server.tokenFile, 'utf8')).trim();
  });
  afterEach(async () => { await server.close(); await fs.rm(directory, { recursive: true, force: true }); });

  it('publishes compatible discovery and rejects wrong authentication or protocol versions', async () => {
    expect(JSON.parse(await fs.readFile(server.discoveryFile, 'utf8'))).toEqual({ port: server.port, protocolVersion: 1 });
    expect((await call('/v1/capabilities', {}, 'wrong')).status).toBe(401);
    const incompatible = await call('/v1/capabilities', {}, token, '2');
    expect(incompatible.status).toBe(426);
    expect(await incompatible.json()).toMatchObject({ error: { code: 'incompatible_version' } });
    const compatible = await call('/v1/capabilities');
    expect(compatible.status).toBe(200);
    expect(await compatible.json()).toMatchObject({ protocolVersion: 1, backgroundDelivery: 'required', exactModelSelection: 'required', roots: [{ name: 'coin' }] });
  });

  it('reads connection status and invokes only the existing connect lifecycle', async () => {
    expect(await (await call('/v1/connection')).json()).toMatchObject({ connection: { state: 'disconnected' } });
    const connected = await call('/v1/connection/connect', { method: 'POST' });
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({ connection: { state: 'connected', handshakeAt: 123 } });
    expect(deps.connect).toHaveBeenCalledTimes(1);
    expect(await (await call('/v1/connection')).json()).toMatchObject({ connection: { state: 'connected' } });
  });

  it('uses the outbox UUID as the durable idempotency identity for duplicate submissions', async () => {
    const submittedAt = Date.now();
    const payload = { requestId, submittedAt, text: 'Run the task', model: model.id, reasoningEffort: 'xhigh' };
    const first = await call('/v1/requests', { method: 'POST', body: JSON.stringify(payload) });
    const duplicate = await call('/v1/requests', { method: 'POST', body: JSON.stringify(payload) });
    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ idempotent: true, request: { requestId, state: 'queued' } });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.rows).toHaveLength(1);
    expect(deps.rows[0]).toMatchObject({ id: requestId, backgroundDelivery: true });
  });

  it('fails closed for unknown ids and unavailable exact model selections', async () => {
    expect((await call(`/v1/requests/${requestId}`)).status).toBe(404);
    deps.models = () => ({ ...structuredClone(catalog), state: 'unknown', models: [] });
    const response = await call('/v1/requests', { method: 'POST', body: JSON.stringify({
      requestId, submittedAt: Date.now(), text: 'Run', model: model.id, reasoningEffort: 'xhigh'
    }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'models_not_ready' } });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('stops only the active generation owned by the exact controller request', async () => {
    const session = summary();
    session.activeTurnId = 'generation-exact';
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-a', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'A', chars: 1, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-exact' }
    ]);
    deps.rows.push(row('sent', { sessionId: session.id, deliveredSessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));

    const response = await call(`/v1/requests/${requestId}/cancel`, { method: 'POST' });
    expect(await response.json()).toMatchObject({ cancelAccepted: true, request: { state: 'cancelled' } });
    expect(deps.stop).toHaveBeenCalledWith(session.id, 'generation-exact');
    expect(deps.cancelDelivered).toHaveBeenCalledWith(requestId);
  });

  it('never cancels a newer turn through an older controller request', async () => {
    const session = summary();
    session.activeTurnId = 'generation-b';
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-a', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'A', chars: 1, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-a' },
      { seq: 3, time: 202, source: 'extension', kind: 'turn_end', turnId: 'generation-a', outcome: 'completed' },
      { seq: 4, time: 210, source: 'app', kind: 'user_message', inputId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', messageId: 'user-b', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'B', chars: 1, truncated: false } },
      { seq: 5, time: 211, source: 'extension', kind: 'turn_start', turnId: 'generation-b' }
    ]);
    deps.rows.push(row('sent', { sessionId: session.id, deliveredSessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));

    const response = await call(`/v1/requests/${requestId}/cancel`, { method: 'POST' });
    expect(await response.json()).toMatchObject({ cancelAccepted: false });
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it('does not publish a cancellation fence when native Stop was not accepted', async () => {
    const session = summary();
    session.activeTurnId = 'generation-exact';
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-a', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'A', chars: 1, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-exact' }
    ]);
    deps.rows.push(row('sent', { sessionId: session.id, deliveredSessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));
    deps.stop = vi.fn(async () => { throw new Error('native stop unavailable'); });

    const response = await call(`/v1/requests/${requestId}/cancel`, { method: 'POST' });
    expect(response.status).toBe(500);
    expect(deps.cancelDelivered).not.toHaveBeenCalled();
    expect(deps.rows[0]?.state).toBe('sent');
  });

  it('returns bounded projects/sessions and requests model discovery without submitting a message', async () => {
    deps.sessionsById.set('session-control', summary());
    expect(await (await call('/v1/projects')).json()).toMatchObject({ projects: [{ name: 'Coin' }] });
    expect(await (await call('/v1/sessions?limit=10')).json()).toMatchObject({ sessions: [{ id: 'session-control' }], total: 1, nextCursor: null });
    expect((await call('/v1/models/refresh', { method: 'POST' })).status).toBe(202);
    expect(deps.refreshModels).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['queued', 'queued'], ['browser', 'delivering'], ['sent', 'running'], ['failed', 'failed'], ['cancelled', 'cancelled']
  ] as const)('projects outbox %s as control status %s', async (stored, expected) => {
    expect((await controlRequestView(deps, row(stored))).state).toBe(expected);
  });

  it('associates the result with the exact outbox user row and exposes verified picker evidence', async () => {
    const session = summary();
    // A later follow-up changed the session's current picker. The earlier request's
    // proof belongs to its exact canonical user message and must remain unchanged.
    session.selectedModel = { conversationId: 'conversation-control', model: 'gpt-6-pro', reasoningEffort: 'high', observedAt: 999 };
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 210, source: 'extension', kind: 'assistant_message', messageId: 'assistant-1', message: { text: 'Exact answer', chars: 12, truncated: false }, final: true, state: 'final' },
      { seq: 3, time: 220, source: 'extension', kind: 'user_message', messageId: 'user-2', message: { text: 'Later', chars: 5, truncated: false } },
      { seq: 4, time: 230, source: 'extension', kind: 'assistant_message', messageId: 'assistant-2', message: { text: 'Wrong later answer', chars: 18, truncated: false }, final: true, state: 'final' }
    ]);
    const view = await controlRequestView(deps, row('sent', { sessionId: session.id, conversationId: session.conversationId, deliveredAt: 201 }));
    expect(view).toMatchObject({ state: 'completed', sessionId: session.id,
      verifiedSelection: { model: model.id, reasoningEffort: 'xhigh', observedAt: 201 },
      result: { text: 'Exact answer', truncated: false } });
  });

  it('does not invent immutable picker proof for a legacy recorded user row', async () => {
    const session = summary();
    session.selectedModel = { conversationId: 'conversation-control', model: model.id, reasoningEffort: 'xhigh', observedAt: 999 };
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'legacy-user', inputDelivery: 'confirmed', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 210, source: 'extension', kind: 'assistant_message', messageId: 'legacy-answer', message: { text: 'Answer', chars: 6, truncated: false }, final: true, state: 'final' }
    ]);
    const view = await controlRequestView(deps, row('sent', { sessionId: session.id, conversationId: session.conversationId, deliveredAt: 201 }));
    expect(view).toMatchObject({ state: 'running', verifiedSelection: null });
    expect(view.result).toBeUndefined();
  });

  it('keeps a transient page error running and accepts only terminal evidence from the exact generation', async () => {
    const session = summary();
    deps.sessionsById.set(session.id, session);
    const delivered = row('sent', { sessionId: session.id, conversationId: session.conversationId, deliveredAt: 201 });
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', turnId: 'provider-user-message-id', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-exact' },
      { seq: 3, time: 202, source: 'extension', kind: 'chat_error', turnId: 'generation-exact', message: { text: '요청이 너무 많습니다', chars: 12, truncated: false } },
      { seq: 4, time: 203, source: 'extension', kind: 'turn_end', turnId: 'generation-stale', outcome: 'failed', detail: 'stale page failure' },
      { seq: 5, time: 204, source: 'extension', kind: 'assistant_message', messageId: 'assistant-stale', turnId: 'generation-stale', message: { text: 'Wrong answer', chars: 12, truncated: false }, final: true, state: 'final' }
    ]);
    expect(await controlRequestView(deps, delivered)).toMatchObject({ state: 'running' });

    deps.eventsById.get(session.id)!.push(
      { seq: 6, time: 205, source: 'extension', kind: 'turn_end', turnId: 'generation-exact', outcome: 'interrupted', detail: 'exact turn interrupted' }
    );
    expect(await controlRequestView(deps, delivered)).toMatchObject({ state: 'failed', error: 'exact turn interrupted' });
  });
  it('fails a delivered request once a later user message proves it no longer owns the turn', async () => {
    const session = summary();
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-lost-on-rebind' },
      { seq: 3, time: 210, source: 'extension', kind: 'user_message', messageId: 'user-2', message: { text: 'Later', chars: 5, truncated: false } },
      { seq: 4, time: 211, source: 'extension', kind: 'turn_start', turnId: 'generation-later' }
    ]);
    const view = await controlRequestView(deps, row('sent', { sessionId: session.id, conversationId: session.conversationId, deliveredAt: 201 }));
    expect(view).toMatchObject({ state: 'failed',
      error: 'A later user message superseded this request before its completion was recorded.' });
    expect(view.result).toBeUndefined();
  });
  it('accepts a final from a replacement generation started after the exact user row', async () => {
    const session = summary();
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-before-reload' },
      { seq: 3, time: 202, source: 'extension', kind: 'turn_start', turnId: 'generation-after-reload' },
      { seq: 4, time: 203, source: 'extension', kind: 'assistant_message', messageId: 'assistant-final', turnId: 'generation-after-reload', message: { text: 'Recovered final', chars: 15, truncated: false }, final: true, state: 'final' },
      { seq: 5, time: 204, source: 'extension', kind: 'turn_end', turnId: 'generation-after-reload', outcome: 'completed' }
    ]);
    const view = await controlRequestView(deps, row('sent', { sessionId: session.id, conversationId: session.conversationId, deliveredAt: 201 }));
    expect(view).toMatchObject({ state: 'completed', result: { text: 'Recovered final' } });
  });
});
