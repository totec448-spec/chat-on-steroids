import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as durable from '../src/main/durable.js';
import * as requestPlans from '../src/main/session/request-plans.js';
import * as agents from '../src/main/agents.js';
import * as logger from '../src/main/logger.js';
import { providerSessionKey } from '../src/main/mcp/provider-session.js';
import { observeProviderSessionRequest, observeRequestCorrelation, requestCorrelation,
  awaitRequestCorrelation, resetCorrelationRegistryForTests, restoreRequestCorrelations } from '../src/main/session/correlation.js';
import { createSession, flushSessions, initSessionStore, rebindSession, resetSessionStoreForTests,
  unsetSessionRootForTests } from '../src/main/session/store.js';
import type { SurfaceId } from '../src/main/mcp/surfaces.js';
import { flushRecorder, resetRecorderForTests } from '../src/main/session/recorder.js';

let directory: string;
const meta = (session = 'opaque-chat-a', subject = 'opaque-user') => ({ params: {
  _meta: { 'openai/session': session, 'openai/subject': subject }
} });
const key = (surface: SurfaceId = 'core', session = 'opaque-chat-a', profile = 'profile-a') =>
  providerSessionKey(surface, profile, {}, meta(session))!;
async function prove(requestId = 'native-a', conversationId = 'chat-a') {
  const session = await createSession({ conversationId });
  observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
    messageId: `message-${requestId}`, tool: '', observedAt: Date.now() });
  return session;
}
beforeEach(async () => {
  resetCorrelationRegistryForTests();
  directory = await mkdtemp(path.join(tmpdir(), 'cos-provider-session-'));
  durable.initDurableStore(directory);
  initSessionStore(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await flushRecorder();
  await flushSessions();
  await durable.flushDurable();
  resetCorrelationRegistryForTests();
  resetRecorderForTests();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  durable.resetDurableForTests();
  await rm(directory, { recursive: true, force: true });
});

it('accepts only host metadata and isolates the Setup, surface, subject and conversation', () => {
  const base = key();
  expect(base).toMatch(/^[a-f0-9]{64}$/);
  expect(new Set([base, key('plugins'), key('desktop'), key('core', 'opaque-chat-b'),
    key('core', 'opaque-chat-a', 'profile-b'), providerSessionKey('core', 'profile-a', {}, meta('opaque-chat-a', 'other-user'))]).size).toBe(6);
  expect(providerSessionKey('core', 'profile-a', {}, { params: { arguments: meta().params } })).toBeNull();
  expect(providerSessionKey('core', 'profile-a', {}, { params: { _meta: { sessionId: 'generic-id' } } })).toBeNull();
  expect(providerSessionKey('core', 'profile-a', { 'x-openai-session': 'different' }, meta())).toBeNull();
  expect(providerSessionKey('core', 'profile-a', { 'x-openai-subject': ['opaque-user', 'opaque-user'] }, meta())).toBeNull();
  expect(providerSessionKey('core', 'profile-a', {}, meta('x'.repeat(513)))).toBeNull();
});

it.each<[string, unknown]>([
  ['missing body', undefined], ['null body', null], ['empty body', {}], ['array body', []],
  ['empty params', { params: {} }], ['null metadata', { params: { _meta: null } }],
  ...['', ' ', '\t', '\n', '\r', '\u0000', '\u001f', '\u007f', 'embedded space'].flatMap<[string, unknown]>(value => [
    [`invalid session ${JSON.stringify(value)}`, meta(value)],
    [`invalid subject ${JSON.stringify(value)}`, meta('opaque-chat-a', value)]
  ])
])('rejects %s without creating a provider key', (_label, body) => {
  expect(providerSessionKey('core', 'profile-a', {}, body)).toBeNull();
  expect(requestCorrelation('unknown')).toBeNull();
});

it('keeps durable admission successful and logs a failed plan attachment', async () => {
  await prove();
  await observeProviderSessionRequest('native-a', key());
  const warning = vi.spyOn(logger, 'logWarn');
  vi.spyOn(requestPlans, 'attachRequestPlan').mockRejectedValueOnce(new Error('plan disk unavailable'));
  await expect(observeProviderSessionRequest('plan-failure', key())).resolves.toBe('known');
  expect(requestCorrelation('plan-failure')?.providerSessionAnchor).toBe('native-a');
  expect((await durable.readDurable<{ entries: unknown[] }>('request-correlations'))?.entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ requestId: 'plan-failure', providerSessionAnchor: 'native-a' })]));
  await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
    'request plan attachment failed for plan-failure: plan disk unavailable'), { timeout: 10_000 });
});

it.each(['plan', 'worker'] as const)('does not block subsequent admissions on %s reconciliation', async kind => {
  await prove();
  await observeProviderSessionRequest('native-a', key());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  if (kind === 'plan') vi.spyOn(requestPlans, 'attachRequestPlan').mockImplementationOnce(async () => {
    entered(); await resume; return 'missing';
  });
  else vi.spyOn(agents, 'reconcileAgentRequestOwners').mockImplementationOnce(async () => {
    entered(); await resume;
  });
  let admitted = false;
  const first = observeProviderSessionRequest('slow-reconciliation', key()).then(value => { admitted = true; return value; });
  let second: ReturnType<typeof observeProviderSessionRequest> | undefined;
  try {
    await started;
    second = observeProviderSessionRequest('next-admission', key());
    await vi.waitFor(() => expect(admitted).toBe(true), { timeout: 10_000 });
    expect(await second).toBe('known');
    expect(requestCorrelation('next-admission')?.providerSessionAnchor).toBe('native-a');
  } finally {
    release();
    await first;
    await second;
  }
});

it.each(['core', 'desktop', 'plugins'] as const)('lets a known native %s request bypass a slow commit while new bindings and derivations stay queued', async surface => {
  await prove();
  const b = await prove('fast-native-b', 'fast-chat-b');
  const firstKey = key(surface), secondKey = key(surface, 'fast-provider-b');
  const newKey = key(surface, 'fast-provider-new');
  await observeProviderSessionRequest('native-a', firstKey);
  await observeProviderSessionRequest('fast-native-b', secondKey);
  await observeProviderSessionRequest('known-derived-b', secondKey);
  const write = durable.writeDurableNow;
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const commit = vi.spyOn(durable, 'writeDurableNow').mockImplementationOnce(async (name, value) => {
    entered(); await resume; return write(name, value);
  });
  const slow = observeProviderSessionRequest('slow-derived-a', firstKey);
  let fast: ReturnType<typeof observeProviderSessionRequest> | undefined;
  let binding: ReturnType<typeof observeProviderSessionRequest> | undefined;
  let derived: ReturnType<typeof observeProviderSessionRequest> | undefined;
  let knownDerived: ReturnType<typeof observeProviderSessionRequest> | undefined;
  try {
    await paused;
    // Put mutating admissions ahead of the known request to prove it skips the whole queue.
    binding = observeProviderSessionRequest('fast-native-b', newKey);
    derived = observeProviderSessionRequest('queued-derived-b', secondKey);
    let derivedCompleted = false;
    knownDerived = observeProviderSessionRequest('known-derived-b', secondKey).then(status => { derivedCompleted = true; return status; });
    let completed = false;
    fast = observeProviderSessionRequest('fast-native-b', secondKey).then(status => { completed = true; return status; });
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 10_000 });
    expect(await fast).toBe('known');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(requestCorrelation('fast-native-b')).toMatchObject({ conversationId: 'fast-chat-b', sessionId: b.id });
    expect(requestCorrelation('fast-native-b')?.providerSessionKeys).not.toContain(newKey);
    expect(requestCorrelation('slow-derived-a')).toBeNull();
    expect(requestCorrelation('queued-derived-b')).toBeNull();
    expect(derivedCompleted).toBe(false);
  } finally {
    release();
    await Promise.all([slow, fast, binding, derived, knownDerived]);
  }
  expect(requestCorrelation('queued-derived-b')).toMatchObject({ sessionId: b.id, providerSessionAnchor: 'fast-native-b' });
  expect(requestCorrelation('fast-native-b')?.providerSessionKeys).toContain(newKey);
  expect(commit).toHaveBeenCalledTimes(3);
});

it.each(['core', 'desktop', 'plugins'] as const)('identifies a new %s request only after native proof established that surface binding', async surface => {
  const session = await prove();
  expect(await observeProviderSessionRequest('unbound', key(surface))).toBe('unbound');
  expect(requestCorrelation('unbound')).toBeNull();
  expect(await observeProviderSessionRequest('native-a', key(surface))).toBe('known');
  expect(await observeProviderSessionRequest('later', key(surface))).toBe('known');
  expect(requestCorrelation('later')).toMatchObject({ conversationId: 'chat-a', sessionId: session.id,
    providerSessionAnchor: 'native-a', providerSessionKey: key(surface) });
  expect((await durable.readDurable<{ entries: unknown[] }>('request-correlations'))?.entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ requestId: 'later', providerSessionAnchor: 'native-a' })]));
});

it('cannot use a provider-derived request to establish a new surface or another provider binding', async () => {
  await prove();
  await observeProviderSessionRequest('native-a', key());
  await observeProviderSessionRequest('derived', key());
  expect(await observeProviderSessionRequest('derived', key('plugins'))).toBe('unbound');
  expect(await observeProviderSessionRequest('unbound-plugin', key('plugins'))).toBe('unbound');
  expect(requestCorrelation('unbound-plugin')).toBeNull();
});

it('keeps concurrent chats and their requests separate, including late page evidence', async () => {
  const a = await prove();
  const b = await prove('native-b', 'chat-b');
  await Promise.all([observeProviderSessionRequest('native-a', key()),
    observeProviderSessionRequest('native-b', key('core', 'opaque-chat-b'))]);
  await Promise.all([observeProviderSessionRequest('hidden-a', key()),
    observeProviderSessionRequest('hidden-b', key('core', 'opaque-chat-b'))]);
  expect(requestCorrelation('hidden-a')?.sessionId).toBe(a.id);
  expect(requestCorrelation('hidden-b')?.sessionId).toBe(b.id);
  const warning = vi.spyOn(logger, 'logWarn');
  expect(await observeProviderSessionRequest('hidden-a', key('core', 'opaque-chat-b'))).toBe('refused');
  expect(await observeProviderSessionRequest('hidden-a', key('core', 'opaque-chat-b'))).toBe('refused');
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    'provider session binding ignored for request hidden-a; existing request owner disagrees with native anchor; dispatch uses existing request identity');
  expect(requestCorrelation('hidden-a')?.sessionId).toBe(a.id);
  expect(requestCorrelation('hidden-b')?.sessionId).toBe(b.id);
});

it('wakes a waiting request when native evidence later establishes its already observed provider key', async () => {
  await prove();
  await observeProviderSessionRequest('hidden', key());
  const waiting = awaitRequestCorrelation('hidden', 10_000);
  await observeProviderSessionRequest('native-a', key());
  expect((await waiting)?.providerSessionAnchor).toBe('native-a');
});

it('learns a binding when its first native page proof arrives after MCP ingress', async () => {
  const session = await createSession({ conversationId: 'late-chat' });
  expect(await observeProviderSessionRequest('late-native', key())).toBe('unbound');
  await observeProviderSessionRequest('late-hidden', key());
  const waiting = awaitRequestCorrelation('late-hidden', 10_000);
  observeRequestCorrelation({ requestId: 'late-native', conversationId: 'late-chat', sessionId: session.id,
    messageId: 'late-message', tool: '', observedAt: Date.now() });
  expect((await waiting)?.conversationId).toBe('late-chat');
});

it('persists bindings and provenance across restart without storing provider tokens', async () => {
  await prove();
  await observeProviderSessionRequest('native-a', key());
  await observeProviderSessionRequest('derived', key());
  await durable.flushDurable();
  const saved = await durable.readDurable('request-correlations');
  expect(JSON.stringify(saved)).not.toMatch(/opaque-chat|opaque-user|profile-a/);
  resetCorrelationRegistryForTests();
  await restoreRequestCorrelations();
  expect(requestCorrelation('derived')?.providerSessionAnchor).toBe('native-a');
  expect(await observeProviderSessionRequest('after-restart', key())).toBe('known');
});

it('refuses a provider binding shared by contradictory native owners, including after restart', async () => {
  await prove();
  await prove('native-b', 'chat-b');
  await observeProviderSessionRequest('native-a', key());
  await observeProviderSessionRequest('native-b', key());
  expect(await observeProviderSessionRequest('unknown', key())).toBe('refused');
  expect(requestCorrelation('unknown')).toBeNull();
  resetCorrelationRegistryForTests();
  await restoreRequestCorrelations();
  expect(await observeProviderSessionRequest('unknown-again', key())).toBe('refused');
});

it('keeps old frontend provenance after compaction and requires proof for the successor', async () => {
  const a = await prove();
  await observeProviderSessionRequest('native-a', key());
  await rebindSession(a.id, 'chat-a', 'chat-successor');
  await observeProviderSessionRequest('old-frontend', key());
  expect(requestCorrelation('old-frontend')).toMatchObject({ sessionId: a.id, conversationId: 'chat-a' });
  expect(await observeProviderSessionRequest('unproved-successor', key('core', 'opaque-chat-successor'))).toBe('unbound');
});

it('does not publish a derived owner before commit or retain it when that write fails', async () => {
  await prove();
  await observeProviderSessionRequest('native-a', key());
  const write = durable.writeDurableNow;
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(durable, 'writeDurableNow').mockImplementationOnce(async (name, value) => {
    entered(); await resume; return write(name, value);
  });
  let published = false;
  const waiting = awaitRequestCorrelation('paused', 10_000).then(owner => { published = true; return owner; });
  const pending = observeProviderSessionRequest('paused', key());
  await paused;
  expect(requestCorrelation('paused')).toBeNull();
  expect(published).toBe(false);
  release();
  expect(await pending).toBe('known');
  expect((await waiting)?.conversationId).toBe('chat-a');
  vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(observeProviderSessionRequest('failed', key())).rejects.toThrow('disk unavailable');
  expect(requestCorrelation('failed')).toBeNull();
});

it('gives later native proof precedence and disables a contradictory provider binding', async () => {
  await prove();
  const b = await createSession({ conversationId: 'chat-b' });
  await observeProviderSessionRequest('native-a', key());
  await observeProviderSessionRequest('derived', key());
  observeRequestCorrelation({ requestId: 'derived', conversationId: 'chat-b', sessionId: b.id,
    messageId: 'native-b-message', tool: '', observedAt: Date.now() });
  expect(requestCorrelation('derived')).toMatchObject({ conversationId: 'chat-b', sessionId: b.id });
  expect(requestCorrelation('derived')?.providerSessionAnchor).toBeUndefined();
  expect(await observeProviderSessionRequest('unknown', key())).toBe('refused');
});

it('does not restore an orphaned or damaged derivation as native ownership', async () => {
  await prove();
  await observeProviderSessionRequest('native-a', key());
  await observeProviderSessionRequest('derived', key());
  const saved = await durable.readDurable<{ version: number; complete: boolean; entries: Array<Record<string, unknown>> }>('request-correlations');
  saved!.entries.find(row => row.requestId === 'derived')!.providerSessionAnchor = 'absent-native-proof';
  await durable.writeDurableNow('request-correlations', saved);
  resetCorrelationRegistryForTests();
  await restoreRequestCorrelations();
  expect(requestCorrelation('derived')).toBeNull();
  expect(requestCorrelation('native-a')?.conversationId).toBe('chat-a');
});

it('drops damaged auxiliary keys while preserving the independently valid native owner', async () => {
  await prove();
  await observeProviderSessionRequest('native-a', key());
  const saved = await durable.readDurable<{ version: number; complete: boolean; entries: Array<Record<string, unknown>> }>('request-correlations');
  saved!.entries[0]!.providerSessionKeys = ['damaged'];
  await durable.writeDurableNow('request-correlations', saved);
  resetCorrelationRegistryForTests();
  await restoreRequestCorrelations();
  expect(requestCorrelation('native-a')?.conversationId).toBe('chat-a');
  expect(await observeProviderSessionRequest('unknown', key())).toBe('unbound');
});
