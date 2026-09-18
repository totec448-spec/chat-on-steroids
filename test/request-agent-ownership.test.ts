import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initDurableStore, flushDurable, resetDurableForTests } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests, createSession, flushSessions, rebindSession } = await import('../src/main/session/store.js');
const { observeRequestCorrelation, resetCorrelationRegistryForTests } = await import('../src/main/session/correlation.js');
const broker = await import('../src/main/agents.js');
const { resetRequestPlansForTests } = await import('../src/main/session/request-plans.js');
const { openContinuationNow, resetContinuationsForTests } = await import('../src/main/session/continuation.js');

let directory: string;
const request = { requestId: 'wfr_request_prime' };

async function permit(enabled: boolean): Promise<void> {
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: true, maxWorkers: 3, allowUnattributedCalls: enabled } });
}

beforeAll(async () => {
  directory = await makeTempDir('clf-request-agents-');
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
});
beforeEach(async () => {
  broker.resetAgentsForTests();
  resetCorrelationRegistryForTests();
  resetContinuationsForTests();
  resetRequestPlansForTests();
  broker.onSwarmPersistNow(async () => undefined);
  await permit(true);
});
afterAll(async () => {
  await flushSessions();
  await flushDurable();
  broker.resetAgentsForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

it('starts workers owned by one unresolved request without inventing a conversation', async () => {
  const opened = vi.fn();
  broker.onSpawnRequest(opened);
  expect(broker.statusForCaller(request).self).toBeNull();
  const stage = broker.stageSpawn({ caller: request, workers: [{ task: 'Read the parser' }] });
  expect(opened).not.toHaveBeenCalled();
  expect(broker.statusForCaller(request).self).toBeNull();
  expect(() => broker.stageSpawn({ caller: request, workers: [{ task: 'Concurrent duplicate' }] })).toThrow(/SPAWN_IN_PROGRESS/);
  expect(await broker.persistCriticalSwarmNow()).toBe(true);
  stage.commit();
  broker.requestWorkerBootstraps(stage.created.map(worker => worker.id), stage.runId);
  expect(opened).toHaveBeenCalledOnce();
  expect(broker.statusForCaller(request)).toMatchObject({ runId: stage.runId, self: { id: 'prime', conversationId: null } });
  expect(broker.statusForCaller({ requestId: 'wfr_other_request' }).state.agents).toEqual([]);
  expect(broker.statusForCaller({ conversationId: 'unrelated-chat' }).state.agents).toEqual([]);
  expect(broker.bindConversation('worker-1', 'request-worker-chat', stage.runId)).toBe(true);
  broker.sendMessage(request, 'worker-1', 'Inspect only');
  expect(broker.offerMessagesForConversation('request-worker-chat')?.messages[0]?.text).toBe('Inspect only');
  broker.finishAgent({ conversationId: 'request-worker-chat' }, 'Parser reviewed');
  expect(broker.statusForCaller(request).state.agents.find(worker => worker.id === 'worker-1')?.result).toBe('Parser reviewed');
});

it('keeps request ownership across restart, late proof and a subsequent request', async () => {
  const session = await createSession({ conversationId: 'request-prime-resolved' });
  const spawned = broker.spawn({ caller: request, workers: [{ task: 'Keep the family' }] });
  broker.bindConversation('worker-1', 'request-worker-restored', spawned.runId);
  broker.restoreSwarm(broker.snapshotSwarm());
  expect(broker.statusForCaller(request).runId).toBe(spawned.runId);
  observeRequestCorrelation({ ...request, conversationId: 'request-prime-resolved', sessionId: session.id,
    messageId: 'request-prime-message', tool: 'agents', observedAt: Date.now() });
  await broker.reconcileAgentRequestOwners();
  const later = { conversationId: 'request-prime-resolved', sessionId: session.id, requestId: 'wfr_next_turn' };
  expect(broker.statusForCaller(later).runId).toBe(spawned.runId);
  expect(broker.statusForCaller(later).self?.conversationId).toBe('request-prime-resolved');
  broker.sendMessage(later, 'worker-1', 'Continue');
  expect(broker.offerMessagesForConversation('request-worker-restored')?.messages[0]?.text).toBe('Continue');
  expect(() => broker.sendMessage({ requestId: 'wfr_stranger' }, 'worker-1', 'Wrong owner')).toThrow();
});

it('does not duplicate an unpublished fleet when its request is identified during the acceptance barrier', async () => {
  const session = await createSession({ conversationId: 'staged-proof-owner' });
  const stage = broker.stageSpawn({ caller: request, workers: [{ task: 'Still being accepted' }] });
  observeRequestCorrelation({ ...request, conversationId: 'staged-proof-owner', sessionId: session.id,
    messageId: 'staged-proof', tool: 'agents', observedAt: Date.now() });
  await broker.reconcileAgentRequestOwners();
  expect(broker.statusForCaller(request).self).toBeNull();
  expect(() => broker.stageSpawn({ caller: request, workers: [{ task: 'Must not duplicate' }] })).toThrow(/SPAWN_IN_PROGRESS/);
  stage.commit();
  await broker.reconcileAgentRequestOwners();
  expect(broker.agentFamiliesForCaller({ conversationId: 'staged-proof-owner' })).toEqual([{ run_id: stage.runId, running: true }]);
});

it('keeps a parked request family and revives its existing worker', () => {
  const spawned = broker.spawn({ caller: request, workers: [{ task: 'Reusable task' }] });
  broker.bindConversation('worker-1', 'request-worker-parked', spawned.runId);
  broker.finishAgent({ conversationId: 'request-worker-parked' }, 'First task complete');
  broker.releaseQuiescentRun({ allowPendingReports: true }, spawned.runId);
  broker.restoreSwarm(broker.snapshotSwarm());
  expect(broker.statusForCaller(request).state.retainedHistory).toBe(true);
  broker.sendMessage(request, 'worker-1', 'Review the follow-up');
  expect(broker.statusForCaller(request).state.agents.find(worker => worker.id === 'worker-1')?.state).toBe('waking');
});

it('does not let the opt-in impersonate an existing worker or grant foreign family access', async () => {
  const spawned = broker.spawn({ caller: { conversationId: 'established-prime' }, workers: [{ task: 'Existing family' }] });
  broker.bindConversation('worker-1', 'established-worker', spawned.runId);
  expect(() => broker.spawn({ caller: { conversationId: 'established-worker', requestId: 'wfr_known_worker' },
    workers: [{ task: 'Forbidden descendant' }] })).toThrow(/Workers must not create|worker in this run/);
  expect(broker.statusForCaller(request).state.agents).toEqual([]);
  await permit(false);
  expect(() => broker.spawn({ caller: request, workers: [{ task: 'Disabled request access' }] })).toThrow();
  await permit(true);
  expect(() => broker.spawn({ caller: {}, workers: [{ task: 'No owner key' }] })).toThrow();
});

it('reattaches several request fleets beside an existing fleet without renaming or losing workers', async () => {
  const session = await createSession({ conversationId: 'fleet-owner' });
  const prime = { conversationId: 'fleet-owner', sessionId: session.id };
  const existing = broker.spawn({ caller: prime, workers: [{ task: 'Original fleet' }] });
  const a = broker.spawn({ caller: { requestId: 'wfr_fleet_a' }, workers: [{ task: 'Unattributed fleet A' }] });
  const b = broker.spawn({ caller: { requestId: 'wfr_fleet_b' }, workers: [{ task: 'Unattributed fleet B' }] });
  for (const [index, fleet] of [existing, a, b].entries()) broker.bindConversation('worker-1', `fleet-worker-${index}`, fleet.runId);
  for (const requestId of ['wfr_fleet_a', 'wfr_fleet_b']) observeRequestCorrelation({ requestId,
    conversationId: 'fleet-owner', sessionId: session.id, messageId: requestId, tool: 'agents', observedAt: Date.now() });
  await broker.reconcileAgentRequestOwners();
  expect(broker.agentFamiliesForCaller(prime)).toHaveLength(3);
  for (const fleet of [existing, a, b]) expect(broker.primeConversation(fleet.runId)).toBe('fleet-owner');
  expect(() => broker.sendMessage(prime, 'worker-1', 'Ambiguous recipient')).toThrow(/run_id/);
  for (const [index, fleet] of [existing, a, b].entries()) {
    broker.sendMessage({ ...prime, runId: fleet.runId }, 'worker-1', `Only fleet ${index}`);
    expect(broker.offerMessagesForConversation(`fleet-worker-${index}`)?.messages.map(message => message.text)).toEqual([`Only fleet ${index}`]);
  }
  broker.restoreSwarm(broker.snapshotSwarm());
  expect(broker.agentFamiliesForCaller(prime)).toHaveLength(3);
  expect(() => broker.sendMessage({ requestId: 'wfr_foreign', runId: a.runId }, 'worker-1', 'Foreign')).toThrow();
  broker.primeConversationGone(prime.conversationId);
  for (const fleet of [existing, a, b]) expect(broker.statusForCaller({ ...prime, runId: fleet.runId }).self?.state).toBe('detached');
  expect(broker.noteAgentAlive(prime.conversationId)?.revived).toBe(true);
  for (const fleet of [existing, a, b]) expect(broker.statusForCaller({ ...prime, runId: fleet.runId }).self?.state).toBe('active');
});

it('moves active and parked fleets through a handoff and attaches later proof to the replacement chat', async () => {
  const session = await createSession({ conversationId: 'fleet-handoff-a' });
  const original = { conversationId: 'fleet-handoff-a', sessionId: session.id };
  const active = broker.spawn({ caller: original, workers: [{ task: 'Active fleet' }] });
  const parked = broker.spawn({ caller: { requestId: 'wfr_handoff_parked' }, workers: [{ task: 'Parked fleet' }] });
  broker.bindConversation('worker-1', 'handoff-worker-active', active.runId);
  broker.bindConversation('worker-1', 'handoff-worker-parked', parked.runId);
  observeRequestCorrelation({ requestId: 'wfr_handoff_parked', conversationId: original.conversationId,
    sessionId: session.id, messageId: 'parked-proof', tool: 'agents', observedAt: Date.now() });
  await broker.reconcileAgentRequestOwners();
  broker.finishAgent({ conversationId: 'handoff-worker-parked' }, 'Parked report');
  broker.releaseQuiescentRun({ allowPendingReports: true }, parked.runId);
  const late = broker.spawn({ caller: { requestId: 'wfr_handoff_late' }, workers: [{ task: 'Late proof fleet' }] });
  broker.bindConversation('worker-1', 'handoff-worker-late', late.runId);
  expect(broker.beginPrimeTransfer(original.conversationId)).toBe(true);
  expect(broker.freezePrimeTransfer(original.conversationId)).toBe('frozen');
  expect(await rebindSession(session.id, original.conversationId, 'fleet-handoff-b')).toBe(true);
  expect(broker.commitPrimeTransfer(original.conversationId, 'fleet-handoff-b')).toBe(true);
  observeRequestCorrelation({ requestId: 'wfr_handoff_late', conversationId: original.conversationId,
    sessionId: session.id, messageId: 'late-proof', tool: 'agents', observedAt: Date.now() });
  await broker.reconcileAgentRequestOwners();
  const replacement = { conversationId: 'fleet-handoff-b', sessionId: session.id };
  expect(broker.agentFamiliesForCaller(replacement)).toHaveLength(3);
  expect(broker.agentFamiliesForCaller(original)).toHaveLength(0);
  expect(broker.primeConversation(late.runId)).toBe('fleet-handoff-b');
  expect(broker.offerMessagesForCaller(replacement)?.messages.some(message => message.text.includes('Parked report'))).toBe(true);
  const wake = broker.stageMessages({ ...replacement, runId: parked.runId }, [{ to: 'worker-1', text: 'Continue in the replacement chat' }]);
  wake.commit();
  expect(wake.runId).not.toBe(parked.runId);
  expect(broker.statusForCaller({ ...replacement, runId: wake.runId }).state.agents.find(agent => agent.id === 'worker-1')?.state).toBe('waking');
  broker.restoreSwarm(broker.snapshotSwarm());
  await broker.reconcileAgentRequestOwners();
  expect(broker.agentFamiliesForCaller(replacement)).toHaveLength(3);
});

it('recovers a pre-existing rogue worker fleet under its actual prime without promoting the worker', async () => {
  const session = await createSession({ conversationId: 'rogue-prime' });
  const prime = { conversationId: 'rogue-prime', sessionId: session.id };
  const root = broker.spawn({ caller: prime, workers: [{ task: 'Original worker' }] });
  broker.bindConversation('worker-1', 'rogue-worker', root.runId);
  const workerSession = await createSession({ conversationId: 'rogue-worker' });
  const rogue = broker.spawn({ caller: { requestId: 'wfr_rogue_worker' }, workers: [{ task: 'Already accepted before attribution' }] });
  broker.bindConversation('worker-1', 'rogue-descendant', rogue.runId);
  observeRequestCorrelation({ requestId: 'wfr_rogue_worker', conversationId: 'rogue-worker', sessionId: workerSession.id,
    messageId: 'worker-proof', tool: 'agents', observedAt: Date.now() });
  await broker.reconcileAgentRequestOwners();
  expect(broker.primeConversation(rogue.runId)).toBe('rogue-prime');
  expect(broker.agentFamiliesForCaller(prime)).toHaveLength(2);
  expect(broker.statusForCaller({ requestId: 'wfr_rogue_worker' }).self?.role).toBe('worker');
  expect(() => broker.spawn({ caller: { requestId: 'wfr_rogue_worker' }, workers: [{ task: 'Another descendant' }] })).toThrow(/worker/i);
  expect(() => broker.sendMessage({ requestId: 'wfr_rogue_worker', runId: rogue.runId }, 'worker-1', 'Impersonating prime')).toThrow();
  broker.sendMessage({ ...prime, runId: rogue.runId }, 'worker-1', 'Root owns the recovered fleet');
  expect(broker.offerMessagesForConversation('rogue-descendant')?.messages[0]?.text).toBe('Root owns the recovered fleet');
});

it('corrects the in-flight caller role when late proof identifies a provisional prime as a worker', async () => {
  const { dispatch, ok } = await import('../src/main/mcp/kernel.js');
  const { currentCall } = await import('../src/main/mcp/call-context.js');
  await createSession({ conversationId: 'role-root' });
  const root = broker.spawn({ caller: { conversationId: 'role-root' }, workers: [{ task: 'Existing worker' }] });
  broker.bindConversation('worker-1', 'role-worker', root.runId);
  const workerSession = await createSession({ conversationId: 'role-worker' });
  broker.sendMessage({ conversationId: 'role-root' }, 'worker-1', 'Keep your worker assignment');
  let context!: NonNullable<ReturnType<typeof currentCall>>;
  const result = await dispatch('agents', { action: 'spawn' }, null, 'wfr_role_worker', 'core', async () => {
    context = currentCall()!;
    const fleet = broker.spawn({ caller: { requestId: 'wfr_role_worker' }, workers: [{ task: 'Accepted before proof' }] });
    context.agent = 'prime';
    context.caller.runId = fleet.runId;
    observeRequestCorrelation({ requestId: 'wfr_role_worker', conversationId: 'role-worker', sessionId: workerSession.id,
      messageId: 'role-proof', tool: 'agents', observedAt: Date.now() });
    return ok('Fleet accepted');
  });
  expect(context.agent).toBe('worker-1');
  expect(context.caller.runId).toBeUndefined();
  expect(JSON.stringify(result)).toContain('Keep your worker assignment');
});

it('automatically joins a handoff already open before the first fleet was attributable', async () => {
  const conversationId = 'auto-fleet-handoff-a';
  const session = await createSession({ conversationId });
  await openContinuationNow(session.id, conversationId);
  const fleet = broker.spawn({ caller: { requestId: 'wfr_auto_handoff' }, workers: [{ task: 'Late first fleet' }] });
  broker.bindConversation('worker-1', 'auto-handoff-worker', fleet.runId);
  observeRequestCorrelation({ requestId: 'wfr_auto_handoff', conversationId, sessionId: session.id,
    messageId: 'auto-handoff-proof', tool: 'agents', observedAt: Date.now() });
  // The production observation hook does the work; no explicit reconcile call is made.
  await vi.waitFor(() => expect(broker.primeConversation(fleet.runId)).toBe(conversationId));
  expect(broker.freezePrimeTransfer(conversationId)).toBe('frozen');
  expect(await rebindSession(session.id, conversationId, 'auto-fleet-handoff-b')).toBe(true);
  expect(broker.commitPrimeTransfer(conversationId, 'auto-fleet-handoff-b')).toBe(true);
  expect(broker.primeConversation(fleet.runId)).toBe('auto-fleet-handoff-b');
  expect(broker.agentFamiliesForCaller({ requestId: 'wfr_auto_handoff' })).toEqual([]);
});

it('preserves both parked fleets and consumes only messages actually offered to their prime', async () => {
  const conversationId = 'two-parked-fleets';
  const session = await createSession({ conversationId });
  const fleets = ['wfr_parked_first', 'wfr_parked_second'].map((requestId, index) => {
    const fleet = broker.spawn({ caller: { requestId }, workers: [{ task: `Work ${index}` }] });
    broker.bindConversation('worker-1', `two-parked-worker-${index}`, fleet.runId);
    broker.finishAgent({ conversationId: `two-parked-worker-${index}` }, `Report ${index}`);
    broker.releaseQuiescentRun({ allowPendingReports: true }, fleet.runId);
    observeRequestCorrelation({ requestId, conversationId, sessionId: session.id,
      messageId: requestId, tool: 'agents', observedAt: Date.now() });
    return fleet;
  });
  await broker.reconcileAgentRequestOwners();
  broker.restoreSwarm(broker.snapshotSwarm());
  expect(broker.agentFamiliesForCaller({ conversationId })).toHaveLength(2);
  const one = broker.offerMessagesForCaller({ conversationId, runId: fleets[0]!.runId })!;
  expect(one.messages.map(message => message.text)).toEqual([expect.stringContaining('Report 0')]);
  broker.acknowledgeOffersForCaller({ conversationId });
  const remaining = broker.offerMessagesForCaller({ conversationId })!;
  expect(remaining.messages.map(message => message.text)).toEqual([expect.stringContaining('Report 1')]);
  expect(remaining.messages[0]?.runId).toBe(fleets[1]!.runId);
  const wake = broker.stageMessages({ conversationId, runId: fleets[0]!.runId }, [{ to: 'worker-1', text: 'Follow up' }]);
  wake.commit();
  expect(broker.agentFamiliesForCaller({ conversationId })).toHaveLength(2);
  expect(broker.statusForCaller({ conversationId, runId: fleets[1]!.runId }).state.retainedHistory).toBe(true);
});

it('returns no inbox while an exact prime spawn is still unpublished', () => {
  const conversationId = 'unpublished-prime-inbox';
  const stage = broker.stageSpawn({ caller: { conversationId }, workers: [{ task: 'Awaiting acceptance' }] });
  try {
    expect(broker.offerMessagesForCaller({ conversationId })).toBeNull();
    expect(broker.acknowledgeOffersForCaller({ conversationId })).toBeNull();
  } finally { stage.rollback(); }
});

it('keeps late proof inside the handoff when the durable session moved before broker publication', async () => {
  const conversationId = 'fleet-commit-gap-a';
  const session = await createSession({ conversationId });
  const existing = broker.spawn({ caller: { conversationId }, workers: [{ task: 'Existing fleet' }] });
  const late = broker.spawn({ caller: { requestId: 'wfr_fleet_commit_gap' }, workers: [{ task: 'Late fleet' }] });
  broker.bindConversation('worker-1', 'commit-gap-worker-0', existing.runId);
  broker.bindConversation('worker-1', 'commit-gap-worker-1', late.runId);
  await openContinuationNow(session.id, conversationId);
  expect(broker.freezePrimeTransfer(conversationId)).toBe('frozen');
  expect(await rebindSession(session.id, conversationId, 'fleet-commit-gap-b')).toBe(true);
  observeRequestCorrelation({ requestId: 'wfr_fleet_commit_gap', conversationId, sessionId: session.id,
    messageId: 'commit-gap-proof', tool: 'agents', observedAt: Date.now() });
  await broker.reconcileAgentRequestOwners();
  expect(broker.commitPrimeTransfer(conversationId, 'fleet-commit-gap-b')).toBe(true);
  expect(broker.primeConversation(existing.runId)).toBe('fleet-commit-gap-b');
  expect(broker.primeConversation(late.runId)).toBe('fleet-commit-gap-b');
  expect(broker.agentFamiliesForCaller({ conversationId: 'fleet-commit-gap-b' })).toHaveLength(2);
});
