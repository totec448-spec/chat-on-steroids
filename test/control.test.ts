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
import type { InputArgs, InputEntry } from '../src/main/session/input.js';

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
  return { ...input, state,
    owner: null, createdAt: 100, conversationId: null, ...overrides };
}

function dependencies(): ControlDependencies & { rows: InputEntry[]; sessionsById: Map<string, SessionSummary>; eventsById: Map<string, SessionEvent[]>; continuationRows: ReturnType<ControlDependencies['continuations']> extends ReadonlyArray<infer T> ? T[] : never } {
  const rows: InputEntry[] = [];
  const sessionsById = new Map<string, SessionSummary>();
  const eventsById = new Map<string, SessionEvent[]>();
  const continuationRows: Array<ReturnType<ControlDependencies['continuations']>[number]> = [];
  const connection: ConnectionStatus = { state: 'disconnected', detail: '', publicUrl: null, localUrl: null,
    handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] };
  return {
    rows, sessionsById, eventsById, continuationRows,
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
    models: () => structuredClone(catalog),
    refreshModels: vi.fn(async (): Promise<ChatModelCatalog> => ({ ...structuredClone(catalog), state: 'pending' })),
    projects: async () => [{ id: '11111111-2222-4333-8444-555555555555', name: 'Coin', path: 'F:\\Coin', createdAt: 1 }],
    session: async id => sessionsById.get(id) ?? null,
    sessions: async () => ({ sessions: [...sessionsById.values()], total: sessionsById.size, nextCursor: null }),
    events: async id => eventsById.get(id) ?? [],
    continuations: () => continuationRows,
    abortContinuation: vi.fn(async () => false),
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
    expect(await compatible.json()).toMatchObject({ protocolVersion: 1, backgroundDelivery: 'app-settings', exactModelSelection: 'required', roots: [{ name: 'coin' }] });
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
    expect(deps.rows[0]).toMatchObject({ id: requestId });
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
    expect(await response.json()).toMatchObject({ cancelAccepted: true, request: { state: 'running' } });
    expect(deps.stop).toHaveBeenCalledWith(session.id, 'generation-exact');
  });

  it('durably aborts and stops an automatic handoff owned by the exact controller request', async () => {
    const session = summary();
    session.activeTurnId = 'generation-handoff';
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-a', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'A', chars: 1, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-work' },
      { seq: 3, time: 250, source: 'extension', kind: 'turn_end', turnId: 'generation-work', outcome: 'stopped' },
      { seq: 4, time: 251, source: 'extension', kind: 'user_message', messageId: 'handoff-user', message: { text: 'Internal handoff request', chars: 24, truncated: false } },
      { seq: 5, time: 252, source: 'extension', kind: 'turn_start', turnId: 'generation-handoff' }
    ]);
    deps.rows.push(row('sent', { sessionId: session.id, deliveredSessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));
    const continuation = { sourceTurnId: 'generation-work', token: 'continuation-a', sessionId: session.id,
      openedAt: 240, automatic: true, state: 'awaiting-summary' as const, error: null,
      sourceSend: { state: 'sent', messageId: 'handoff-user' },
      destinationSend: { state: 'not-attempted', conversationId: null, messageId: null } };
    deps.continuationRows.push(continuation);
    deps.abortContinuation = vi.fn(async (token, reason) => {
      if (token !== continuation.token) return false;
      continuation.state = 'aborted' as never;
      continuation.error = reason;
      return true;
    });

    const response = await call(`/v1/requests/${requestId}/cancel`, { method: 'POST' });
    expect(await response.json()).toMatchObject({ cancelAccepted: true,
      request: { state: 'cancelled', error: 'Cancelled by the external controller.' } });
    expect(deps.abortContinuation).toHaveBeenCalledWith('continuation-a', 'Cancelled by the external controller.');
    expect(deps.stop).toHaveBeenCalledWith(session.id, 'generation-handoff');
  });

  it('does not abort an automatic continuation when its owned active turn could not be stopped', async () => {
    const session = summary();
    session.activeTurnId = 'generation-handoff';
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-a', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'A', chars: 1, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-work' },
      { seq: 3, time: 250, source: 'extension', kind: 'turn_end', turnId: 'generation-work', outcome: 'stopped' },
      { seq: 4, time: 251, source: 'extension', kind: 'user_message', messageId: 'handoff-user', message: { text: 'Internal handoff request', chars: 24, truncated: false } },
      { seq: 5, time: 252, source: 'extension', kind: 'turn_start', turnId: 'generation-handoff' }
    ]);
    deps.rows.push(row('sent', { sessionId: session.id, deliveredSessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));
    deps.continuationRows.push({ sourceTurnId: 'generation-work', token: 'continuation-a', sessionId: session.id,
      openedAt: 240, automatic: true, state: 'awaiting-summary', error: null,
      sourceSend: { state: 'sent', messageId: 'handoff-user' },
      destinationSend: { state: 'not-attempted', conversationId: null, messageId: null } });
    deps.stop = vi.fn(async () => { throw new Error('native stop unavailable'); });

    const response = await call(`/v1/requests/${requestId}/cancel`, { method: 'POST' });
    expect(response.status).toBe(500);
    expect(deps.abortContinuation).not.toHaveBeenCalled();
    expect(deps.continuationRows[0]).toMatchObject({ state: 'awaiting-summary', error: null });
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

  it('keeps an exact request running while stock automatic Compact & Resume owns its stopped turn', async () => {
    const session = summary();
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-work' },
      { seq: 3, time: 260, source: 'extension', kind: 'turn_end', turnId: 'generation-work', outcome: 'stopped' }
    ]);
    deps.continuationRows.push({ sourceTurnId: 'generation-work', token: 'continuation-a', sessionId: session.id,
      openedAt: 250, automatic: true, state: 'awaiting-summary', error: null,
      sourceSend: { state: 'not-attempted', messageId: null },
      destinationSend: { state: 'not-attempted', conversationId: null, messageId: null } });

    const view = await controlRequestView(deps, row('sent', { sessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));
    expect(view).toMatchObject({ state: 'running' });
    expect(view.error).toBeUndefined();
  });

  it('does not expose an automatic handoff brief before its continuation is committed', async () => {
    const session = summary();
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-work' },
      { seq: 3, time: 260, source: 'extension', kind: 'turn_end', turnId: 'generation-work', outcome: 'stopped' },
      { seq: 4, time: 261, source: 'extension', kind: 'user_message', messageId: 'handoff-user', message: { text: 'Internal handoff request', chars: 24, truncated: false } },
      { seq: 5, time: 262, source: 'extension', kind: 'turn_start', turnId: 'generation-handoff' },
      { seq: 6, time: 280, source: 'extension', kind: 'assistant_message', messageId: 'handoff-answer', turnId: 'generation-handoff', message: { text: 'Internal handoff brief', chars: 22, truncated: false }, final: true, state: 'final' }
    ]);
    deps.continuationRows.push({ sourceTurnId: 'generation-work', token: 'continuation-a', sessionId: session.id,
      openedAt: 250, automatic: true, state: 'awaiting-chat', error: null,
      sourceSend: { state: 'sent', messageId: 'handoff-user' },
      destinationSend: { state: 'not-attempted', conversationId: null, messageId: null } });

    const view = await controlRequestView(deps, row('sent', { sessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));
    expect(view).toMatchObject({ state: 'running' });
    expect(view.result).toBeUndefined();
  });

  it('follows a committed automatic continuation to its real final without returning the handoff brief', async () => {
    const session = summary();
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-work' },
      { seq: 3, time: 260, source: 'extension', kind: 'turn_end', turnId: 'generation-work', outcome: 'stopped' },
      { seq: 4, time: 261, source: 'extension', kind: 'user_message', messageId: 'handoff-user', message: { text: 'Internal handoff request', chars: 24, truncated: false } },
      { seq: 5, time: 262, source: 'extension', kind: 'turn_start', turnId: 'generation-handoff' },
      { seq: 6, time: 280, source: 'extension', kind: 'assistant_message', messageId: 'handoff-answer', turnId: 'generation-handoff', message: { text: 'Internal handoff brief', chars: 22, truncated: false }, final: true, state: 'final' },
      { seq: 7, time: 290, source: 'extension', kind: 'user_message', messageId: 'resume-user', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Internal resume bootstrap', chars: 25, truncated: false } },
      { seq: 8, time: 291, source: 'extension', kind: 'turn_start', turnId: 'generation-resumed' },
      { seq: 9, time: 350, source: 'extension', kind: 'assistant_message', messageId: 'real-answer', turnId: 'generation-resumed', message: { text: 'Real completed result', chars: 21, truncated: false }, final: true, state: 'final' },
      { seq: 10, time: 351, source: 'extension', kind: 'turn_end', turnId: 'generation-resumed', outcome: 'completed' }
    ]);
    deps.continuationRows.push({ sourceTurnId: 'generation-work', token: 'continuation-a', sessionId: session.id,
      openedAt: 250, automatic: true, state: 'committed', error: null,
      sourceSend: { state: 'sent', messageId: 'handoff-user' },
      destinationSend: { state: 'sent', conversationId: 'conversation-resumed', messageId: 'resume-user' } });

    const view = await controlRequestView(deps, row('sent', { sessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));
    expect(view).toMatchObject({ state: 'completed', result: { text: 'Real completed result' } });
  });

  it('fails closed when a resumed final lacks exact model and reasoning evidence', async () => {
    const session = summary();
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'work' },
      { seq: 3, time: 220, source: 'extension', kind: 'turn_end', turnId: 'work', outcome: 'stopped' },
      { seq: 4, time: 221, source: 'extension', kind: 'user_message', messageId: 'handoff-user', message: { text: 'Handoff', chars: 7, truncated: false } },
      { seq: 5, time: 222, source: 'extension', kind: 'turn_start', turnId: 'handoff' },
      { seq: 6, time: 230, source: 'extension', kind: 'assistant_message', messageId: 'brief', turnId: 'handoff', message: { text: 'Brief', chars: 5, truncated: false }, final: true, state: 'final' },
      { seq: 7, time: 231, source: 'extension', kind: 'user_message', messageId: 'resume-user', message: { text: 'Resume', chars: 6, truncated: false } },
      { seq: 8, time: 232, source: 'extension', kind: 'turn_start', turnId: 'resumed' },
      { seq: 9, time: 250, source: 'extension', kind: 'assistant_message', messageId: 'answer', turnId: 'resumed', message: { text: 'Unverified answer', chars: 17, truncated: false }, final: true, state: 'final' }
    ]);
    deps.continuationRows.push({ sourceTurnId: 'work', token: 'continuation-a', sessionId: session.id,
      openedAt: 210, automatic: true, state: 'committed', error: null,
      sourceSend: { state: 'sent', messageId: 'handoff-user' },
      destinationSend: { state: 'sent', conversationId: 'conversation-resumed', messageId: 'resume-user' } });

    const view = await controlRequestView(deps, row('sent', { sessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));
    expect(view).toMatchObject({ state: 'failed', verifiedSelection: null,
      error: 'The resumed ChatGPT model and reasoning selection was not verified.' });
    expect(view.result).toBeUndefined();
  });

  it('follows two exact automatic continuations to the final resumed result', async () => {
    const session = summary();
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'work-1' },
      { seq: 3, time: 220, source: 'extension', kind: 'turn_end', turnId: 'work-1', outcome: 'stopped' },
      { seq: 4, time: 221, source: 'extension', kind: 'user_message', messageId: 'handoff-user-1', message: { text: 'H1', chars: 2, truncated: false } },
      { seq: 5, time: 222, source: 'extension', kind: 'turn_start', turnId: 'handoff-1' },
      { seq: 6, time: 230, source: 'extension', kind: 'assistant_message', messageId: 'handoff-answer-1', turnId: 'handoff-1', message: { text: 'Brief 1', chars: 7, truncated: false }, final: true, state: 'final' },
      { seq: 7, time: 231, source: 'extension', kind: 'user_message', messageId: 'resume-user-1', model: model.id, reasoningEffort: 'xhigh', message: { text: 'R1', chars: 2, truncated: false } },
      { seq: 8, time: 232, source: 'extension', kind: 'turn_start', turnId: 'work-2' },
      { seq: 9, time: 250, source: 'extension', kind: 'turn_end', turnId: 'work-2', outcome: 'stopped' },
      { seq: 10, time: 251, source: 'extension', kind: 'user_message', messageId: 'handoff-user-2', message: { text: 'H2', chars: 2, truncated: false } },
      { seq: 11, time: 252, source: 'extension', kind: 'turn_start', turnId: 'handoff-2' },
      { seq: 12, time: 260, source: 'extension', kind: 'assistant_message', messageId: 'handoff-answer-2', turnId: 'handoff-2', message: { text: 'Brief 2', chars: 7, truncated: false }, final: true, state: 'final' },
      { seq: 13, time: 261, source: 'extension', kind: 'user_message', messageId: 'resume-user-2', model: model.id, reasoningEffort: 'xhigh', message: { text: 'R2', chars: 2, truncated: false } },
      { seq: 14, time: 262, source: 'extension', kind: 'turn_start', turnId: 'work-3' },
      { seq: 15, time: 280, source: 'extension', kind: 'assistant_message', messageId: 'real-answer', turnId: 'work-3', message: { text: 'Final after two', chars: 15, truncated: false }, final: true, state: 'final' }
    ]);
    deps.continuationRows.push(
      { sourceTurnId: 'work-1', token: 'continuation-a', sessionId: session.id, openedAt: 210, automatic: true,
        state: 'committed', error: null, sourceSend: { state: 'sent', messageId: 'handoff-user-1' },
        destinationSend: { state: 'sent', conversationId: 'conversation-2', messageId: 'resume-user-1' } },
      { sourceTurnId: 'work-2', token: 'continuation-b', sessionId: session.id, openedAt: 240, automatic: true,
        state: 'committed', error: null, sourceSend: { state: 'sent', messageId: 'handoff-user-2' },
        destinationSend: { state: 'sent', conversationId: 'conversation-3', messageId: 'resume-user-2' } }
    );

    const view = await controlRequestView(deps, row('sent', { sessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));
    expect(view).toMatchObject({ state: 'completed', result: { text: 'Final after two' } });
  });

  it('does not cross an intervening user message to claim a later continuation result', async () => {
    const session = summary();
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-work' },
      { seq: 3, time: 260, source: 'extension', kind: 'turn_end', turnId: 'generation-work', outcome: 'stopped' },
      { seq: 4, time: 261, source: 'extension', kind: 'user_message', messageId: 'handoff-user', message: { text: 'Internal handoff request', chars: 24, truncated: false } },
      { seq: 5, time: 262, source: 'extension', kind: 'turn_start', turnId: 'generation-handoff' },
      { seq: 6, time: 280, source: 'extension', kind: 'assistant_message', messageId: 'handoff-answer', turnId: 'generation-handoff', message: { text: 'Internal handoff brief', chars: 22, truncated: false }, final: true, state: 'final' },
      { seq: 7, time: 285, source: 'extension', kind: 'user_message', messageId: 'manual-user', message: { text: 'Different work', chars: 14, truncated: false } },
      { seq: 8, time: 290, source: 'extension', kind: 'user_message', messageId: 'resume-user', message: { text: 'Internal resume bootstrap', chars: 25, truncated: false } },
      { seq: 9, time: 291, source: 'extension', kind: 'turn_start', turnId: 'generation-resumed' },
      { seq: 10, time: 350, source: 'extension', kind: 'assistant_message', messageId: 'wrong-answer', turnId: 'generation-resumed', message: { text: 'Must not be returned', chars: 20, truncated: false }, final: true, state: 'final' }
    ]);
    deps.continuationRows.push({ sourceTurnId: 'generation-work', token: 'continuation-a', sessionId: session.id,
      openedAt: 250, automatic: true, state: 'committed', error: null,
      sourceSend: { state: 'sent', messageId: 'handoff-user' },
      destinationSend: { state: 'sent', conversationId: 'conversation-resumed', messageId: 'resume-user' } });

    const view = await controlRequestView(deps, row('sent', { sessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));
    expect(view).toMatchObject({ state: 'failed',
      error: 'A later user message superseded this request during automatic continuation.' });
    expect(view.result).toBeUndefined();
  });

  it('still reports a stopped request as cancelled when no automatic continuation owns the exact turn', async () => {
    const session = summary();
    deps.sessionsById.set(session.id, session);
    deps.eventsById.set(session.id, [
      { seq: 1, time: 200, source: 'app', kind: 'user_message', inputId: requestId, messageId: 'user-1', inputDelivery: 'confirmed', model: model.id, reasoningEffort: 'xhigh', message: { text: 'Run', chars: 3, truncated: false } },
      { seq: 2, time: 201, source: 'extension', kind: 'turn_start', turnId: 'generation-work' },
      { seq: 3, time: 260, source: 'extension', kind: 'turn_end', turnId: 'generation-work', outcome: 'stopped', detail: 'user stopped' }
    ]);

    const view = await controlRequestView(deps, row('sent', { sessionId: session.id,
      conversationId: session.conversationId, deliveredAt: 200 }));
    expect(view).toMatchObject({ state: 'cancelled', error: 'user stopped' });
  });
});
