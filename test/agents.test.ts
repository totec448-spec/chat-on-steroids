/**
 * The broker: what a run is, who may act in it, and what happens to messages.
 *
 * Identity itself — which conversation is which agent, and what a code may and may not do —
 * lives in swarm.test.ts. This file is about everything downstream of that answer: creating
 * a run atomically, the star topology, at-least-once delivery, terminal states, restart, and
 * the shape of all of it over the actual MCP endpoint.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from '../src/main/agents.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const {
  AgentError,
  PRIME_ID,
  acknowledgeOffers,
  acknowledgeOffersForConversation,
  bindConversation,
  closableWorkerConversations,
  clearAgent,
  claimWorkerRevival,
  currentRunId,
  dormantWorkerNotice,
  reactivateDormantRunForConversation,
  failAgent,
  finishAgent,
  finishWorkerConversation,
  identify,
  offerMessages,
  offerMessagesForConversation,
  onSpawnRequest,
  onSwarmEnd,
  onSwarmPersist,
  onSwarmPersistNow,
  pendingCount,
  pendingWorkerSpawns,
  pauseSwarmForDisable,
  DETACHED_SILENCE_MS,
  endedWorkerNotice,
  sleepSilentDetachedWorkers,
  sleepWorker,
  noteAgentAlive,
  noteAgentContextTokens,
  failWorkerRevival,
  noteWorkerRevived,
  onReviveRequest,
  pendingWorkerRevivals,
  primeConversationGone,
  WORKER_CONTEXT_CEILING_TOKENS,
  freeWorkerSlots,
  releaseQuiescentRun,
  repairPrimeConversationAfterRecovery,
  retiredWorkerForConversation,
  restoreRetiredWorkers,
  rollbackWorkerRevivalClaim,
  persistCriticalSwarmNow,
  resetAgentsForTests,
  resetSwarm,
  restoreSwarm,
  sendMessage,
  stageQueuedWorkerRevivals,
  stageFinishAgent,
  stageWorkerConversationFinish,
  stageMessages,
  stageSpawn,
  snapshotSwarm,
  spawn,
  swarmRunning,
  swarmState,
  swarmStateForCaller,
  statusForCaller,
  workerConversationGone,
  workerRevivalClaimed
} = await import('../src/main/agents.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { runningToolCalls } = await import('../src/main/mcp/call-context.js');
const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import('../src/main/durable.js');
const { findSessionByConversation, initSessionStore, readRecentEvents, resetSessionStoreForTests } = await import(
  '../src/main/session/store.js'
);
const { recordChatObservations, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { resetWorkspaces, setWorkspaceFor, workspaceForChat } = await import('../src/main/workspace.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

async function setEnabled(enabled: boolean, maxWorkers = 3, allowUnattributedCalls = false): Promise<void> {
  const base = defaultConfig();
  await saveConfig({
    ...base,
    multiAgent: { ...base.multiAgent, enabled, maxWorkers, allowUnattributedCalls }
  });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-agents-');
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  await setEnabled(true);
});

afterAll(async () => {
  resetAgentsForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(() => {
  resetAgentsForTests();
  resetRecorderForTests();
  resetWorkspaces();
  // The real app wires the broker's immediate persistence sink during startup. MCP endpoint
  // tests exercise that production contract rather than an intentionally half-wired broker;
  // durability-specific cases below replace this no-op sink with controlled writers.
  onSwarmPersistNow(async () => undefined);
});

const PRIME_CHAT = 'c-prime';
const prime: Caller = { conversationId: PRIME_CHAT };

/**
 * A read of `/anything` that actually reached the sandbox and was refused on roots.
 *
 * The wording is platform-shaped and both spellings have to be here. On Windows `/anything`
 * is a virtual path whose first segment names no approved root, so `sandbox.ts` answers
 * `Unknown root "/anything"`. On macOS and Linux the same string is a native absolute path,
 * which takes the containment branch instead and answers that it is not inside an approved
 * folder. Matching only the Windows half asserts the host, not the behaviour — the point of
 * these assertions is that the call ran and failed honestly about roots rather than being
 * stopped at the identity fence.
 */
const REFUSED_ON_ROOTS = /unknown root|not found|not inside an approved folder/i;

interface StartedSwarm {
  prime: Caller;
  spawned: Array<{ id: string; task: string }>;
}

/** Prime + n workers, without opening any browser tabs. */
function startSwarm(count = 2, caller: Caller = prime): StartedSwarm {
  const spawned: Array<{ id: string; task: string }> = [];
  onSpawnRequest((workers) => spawned.push(...workers));
  const result = spawn({
    workers: Array.from({ length: count }, (_, i) => ({ label: `Worker ${i + 1}`, task: `task ${i + 1}` })),
    caller
  });
  expect(result.becamePrime).toBe(true);
  return { prime: caller, spawned };
}

/**
 * A worker started the way the app makes it happen: the extension reports the chat it
 * opened, and that binding is the whole of it. No join, no key, nothing typed by a model.
 */
function startWorker(id: string, conversationId = `c-${id}`): { caller: Caller } {
  expect(bindConversation(id, conversationId)).toBe(true);
  return { caller: { conversationId } };
}

/**
 * Fills a worker's chat past the context ceiling.
 *
 * The one thing that makes a worker's next stop permanent, and the only way a test reaches a
 * genuinely terminal worker now that reporting means sleeping. Measured from the app's own
 * session record in production; here the same broker entry point is called directly.
 */
function fillContext(conversationId: string): void {
  noteAgentContextTokens(conversationId, WORKER_CONTEXT_CEILING_TOKENS);
}

describe('worker chats the browser may close', () => {
  it('names the stopped worker chats beyond the ones most recently used, and no working one', async () => {
    vi.useFakeTimers();
    try {
      await setEnabled(true, 3);
      startSwarm(3);
      const first = startWorker('worker-1');
      const second = startWorker('worker-2');
      startWorker('worker-3');
      expect(closableWorkerConversations(1)).toEqual([]);

      // Two stop, in order; the third keeps working and is never on the list.
      finishAgent(first.caller, 'first done');
      vi.setSystemTime(Date.now() + 1_000);
      finishAgent(second.caller, 'second done');
      expect(closableWorkerConversations(2)).toEqual([]);
      expect(closableWorkerConversations(1)).toEqual(['c-worker-1']);
      expect(closableWorkerConversations(0)).toEqual(['c-worker-1', 'c-worker-2']);

      // The first worker is used again: it is the most recent stopped chat now, so the other
      // one is the surplus.
      vi.setSystemTime(Date.now() + 1_000);
      expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
      finishAgent(first.caller, 'first done again');
      expect(closableWorkerConversations(1)).toEqual(['c-worker-2']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('spawning a run', () => {
  it('refuses the feature while it is switched off', async () => {
    await setEnabled(false);
    expect(() => spawn({ workers: [{ task: 'x' }], caller: prime })).toThrow(/not enabled|switched off|disabled/i);
    await setEnabled(true);
  });

  it('binds the calling conversation as prime and creates its workers', () => {
    const { spawned } = startSwarm(2);
    const state = swarmState();
    expect(state.agents.map((agent) => agent.id)).toEqual([PRIME_ID, 'worker-1', 'worker-2']);
    expect(state.agents[0]?.conversationId).toBe(PRIME_CHAT);
    expect(spawned.map((worker) => worker.id)).toEqual(['worker-1', 'worker-2']);
    // Nothing about a run is a credential the state can leak: the prime has none at all,
    // and a worker's code exists only as a hash until it joins.
    expect(JSON.stringify(state)).not.toMatch(/secret|joinKey|codeHash/i);
  });

  it('uses a full UUID as the run incarnation key that fences stale worker commands', () => {
    startSwarm(1);
    expect(currentRunId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('creates nothing at all when any worker in the request is invalid', () => {
    expect(() =>
      spawn({ workers: [{ task: 'fine' }, { task: '   ' }], caller: prime })
    ).toThrow(/Worker 2 has no task/);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('rejects an over-long label before creating anything, not only an over-long task', () => {
    expect(() => spawn({ workers: [{ label: 'x'.repeat(200), task: 'fine' }], caller: prime })).toThrow(
      /label is too long/
    );
    expect(swarmRunning()).toBe(false);
  });

  it('refuses a caller whose conversation this app could not prove, and creates nothing', () => {
    expect(() => spawn({ workers: [{ task: 'fine' }], caller: {} })).toThrow(AgentError);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('enforces the configured live-worker limit', () => {
    startSwarm(3);
    expect(() => spawn({ workers: [{ task: 'one too many' }], caller: prime })).toThrow(/limit|maximum|too many/i);
  });

  it('lets only the prime conversation recruit more workers', () => {
    startSwarm(1);
    expect(() => spawn({ workers: [{ task: 'more' }], caller: { conversationId: 'c-stranger' } })).toThrow(
      /AGENTS_BUSY/
    );
    expect(swarmState().agents).toHaveLength(2);
    spawn({ workers: [{ task: 'more' }], caller: prime });
    expect(swarmState().agents.map((agent) => agent.id)).toContain('worker-2');
  });

  it('creates a fresh worker on spawn even when an identical old worker is sleeping', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'the first task finished');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    const fresh = spawn({ workers: [{ label: 'Worker 1', task: 'task 1' }], caller: prime });

    expect(fresh.created.map((agent) => agent.id)).toEqual(['worker-2']);
    expect(fresh.created[0]?.state).toBe('invited');
    expect(swarmRunning()).toBe(true);
    expect(swarmStateForCaller(prime).agents.filter((agent) => agent.role === 'worker').map((agent) => agent.id)).toEqual([
      'worker-1',
      'worker-2'
    ]);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true
    });
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-2']);
  });

  it('keeps the sleeping worker separately revivable after a fresh same-brief spawn', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'old identical task finished');
    spawn({ workers: [{ label: 'Worker 1', task: 'task 1' }], caller: prime });
    expect(bindConversation('worker-2', 'c-worker-2')).toBe(true);
    finishAgent({ conversationId: 'c-worker-2' }, 'fresh worker done too');
    expect(releaseQuiescentRun()).toBe(true);

    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'come back to the older chat' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    expect(pendingWorkerRevivals()[0]).toMatchObject({ id: 'worker-1', conversationId: 'c-worker-1' });
  });
});

describe('star topology', () => {
  it('allows worker → prime and prime → worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(sendMessage(worker.caller, PRIME_ID, 'found something').to).toBe(PRIME_ID);
    expect(sendMessage(prime, 'worker-1', 'noted, carry on').to).toBe('worker-1');
  });

  it('forbids worker → worker in both directions', () => {
    startSwarm(2);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');
    expect(() => sendMessage(one.caller, 'worker-2', 'psst')).toThrow(AgentError);
    expect(() => sendMessage(two.caller, 'worker-1', 'psst')).toThrow(AgentError);
    expect(pendingCount('worker-1')).toBe(0);
    expect(pendingCount('worker-2')).toBe(0);
  });

  it('refuses empty text and unknown recipients, and takes a sleeping one', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(() => sendMessage(worker.caller, PRIME_ID, '   ')).toThrow(/empty/i);
    expect(() => sendMessage(prime, 'worker-9', 'hello')).toThrow(/Unknown agent/);

    // Reporting is not ending. The worker sleeps, its slot goes back, and the prime messaging
    // it is how it gets woken — in the chat it already has, not in a new one.
    finishAgent(worker.caller, 'done');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
    expect(freeWorkerSlots()).toBe(3);
    expect(() => sendMessage(prime, 'worker-1', 'one more thing')).not.toThrow();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    // Waking is holding a slot, not asking for one later: the reservation happens here, so two
    // sends racing for the last slot cannot both win it.
    expect(freeWorkerSlots()).toBe(2);
  });

  it('refuses a worker that ended for good, because its chat has no room left', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    expect(finishAgent(worker.caller, 'done').info.state).toBe('finished');
    expect(() => sendMessage(prime, 'worker-1', 'one more thing')).toThrow(/finished/);
  });
});

describe('at-least-once delivery', () => {
  it('re-offers an unacknowledged message and retires it only on the next call', () => {
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'a correction');

    const first = offerMessages('worker-1');
    expect(first).toHaveLength(1);
    expect(first[0]?.offers).toBe(1);

    // The result never came back, so the same message is offered again rather than lost.
    const second = offerMessages('worker-1');
    expect(second).toHaveLength(1);
    expect(second[0]?.offers).toBe(2);

    // The worker's next authenticated call is the evidence the previous result arrived.
    expect(acknowledgeOffers('worker-1')).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
    expect(offerMessages('worker-1')).toEqual([]);
  });

  it('offers a bounded inbox batch so a deep queue cannot make every tool result enormous', () => {
    startSwarm(1);
    startWorker('worker-1');
    for (let index = 0; index < 20; index++) {
      sendMessage(prime, 'worker-1', `message-${index} ${'x'.repeat(3_980)}`);
    }

    const first = offerMessages('worker-1');
    // The old broker appended every waiting row in one go. Even this 20-message fixture was
    // ~80k characters; the real queue limit permits ~800k before MCP framing/tool output is
    // counted. A result too large to reach ChatGPT is then re-offered unchanged forever.
    expect(first.length).toBeLessThan(20);
    expect(first.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(32_000);

    const delivered = acknowledgeOffers('worker-1');
    expect(delivered.map((message) => message.id)).toEqual(first.map((message) => message.id));
    const second = offerMessages('worker-1');
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((message) => first.some((prior) => prior.id === message.id))).toBe(false);
  });

  it('refuses queue overflow instead of silently dropping an older message', () => {
    startSwarm(1);
    startWorker('worker-1');
    for (let i = 0; i < 200; i++) sendMessage(prime, 'worker-1', `message ${i}`);
    expect(() => sendMessage(prime, 'worker-1', 'one too many')).toThrow(AgentError);
    expect(pendingCount('worker-1')).toBe(200);
  });

  // A run does not end because its workers did. The prime is the run, and it is still
  // sitting there able to spawn more; only the prime chat going away ends it.
  it('queues each final report for the prime and leaves the run standing', () => {
    const ended: string[] = [];
    onSwarmEnd((reason) => ended.push(reason));
    startSwarm(2);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');

    const first = finishAgent(one.caller, 'part one done');
    expect(first.report?.to).toBe(PRIME_ID);
    expect(first.report?.text).toContain('part one done');

    finishAgent(two.caller, 'part two done');
    expect(ended).toEqual([]);
    expect(swarmRunning()).toBe(true);
    expect(pendingCount(PRIME_ID)).toBe(2);
  });

  it('releases the global run as soon as the last worker stops while preserving the prime report', () => {
    const ended: string[] = [];
    onSwarmEnd((reason) => ended.push(reason));
    startSwarm(1);
    const worker = startWorker('worker-1');
    // Only a worker whose own chat has no room left is terminal. Anything else sleeps, and a
    // run that still owns a wakeable worker is not a run anybody has finished with.
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'finished safely');

    // The report belongs to the prime history, not to the scarce global execution claim.
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
    // Parking is not destructive teardown and therefore must not fire the end listener that
    // cancels browser work / installs retired-worker leases.
    expect(ended).toEqual([]);

    const dormant = statusForCaller(prime);
    expect(dormant.state.running).toBe(false);
    expect(dormant.state.agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(1);
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
    expect(acknowledgeOffersForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(0);
  });

  it('keeps the prime on the project it moved to during the swarm after the run ends', () => {
    setWorkspaceFor(`chat:${PRIME_CHAT}`, { virtual: '/root/project-a', real: 'C:\\root\\project-a' });
    startSwarm(1);
    const worker = startWorker('worker-1');

    // Spawn mirrored project A into `agent:prime`. During the live run the prime is resolved
    // under that agent identity, so an explicit absolute-path call now moves only that key to B.
    setWorkspaceFor('agent:prime', { virtual: '/root/project-b', real: 'C:\\root\\project-b' });
    expect(workspaceForChat(PRIME_CHAT)?.virtual).toBe('/root/project-a');

    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(releaseQuiescentRun()).toBe(true);

    // After endRun the kernel stops assigning `agent:prime`; the conversation key therefore
    // has to carry forward the newest workspace rather than reviving the pre-swarm project.
    expect(workspaceForChat(PRIME_CHAT)?.virtual).toBe('/root/project-b');
  });

  it('keeps a finished worker as a durable dormant identity rather than retiring its history', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'finished safely');

    // Normal parking is ownership preservation, not destructive retirement.
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
    expect(retiredWorkerForConversation('c-worker-1')).toBeNull();
    expect(dormantWorkerNotice('c-worker-1')).toMatch(/WORKER_ENDED.*worker-1/i);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'c-worker-1'
    });
  });

  it('does not release the run while a durability-gated message is still unpublished', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');

    // A production agents::message call stages first, then waits for its immediate durable
    // barrier before commit publishes it to inbox readers. Keep that exact window open.
    const staged = stageMessages(worker.caller, [{ to: PRIME_ID, text: 'one last finding' }]);
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(offerMessages(PRIME_ID)).toEqual([]);

    // A parallel finish can make the last worker terminal while its staged message is still in
    // that acceptance window. Retire the visible finish report exactly as two later prime calls
    // would, leaving pending=0 even though the unpublished message still exists in the queue.
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'finished');
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(pendingCount(PRIME_ID)).toBe(0);

    // Ending the run here detaches the staged message object from broker state. Its original
    // tool call can later commit and report success, but no prime inbox exists to receive it.
    expect(releaseQuiescentRun()).toBe(false);
    expect(swarmRunning()).toBe(true);

    staged.commit();
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(releaseQuiescentRun()).toBe(true);
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
    expect(acknowledgeOffersForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
  });
});

describe('an agent that has ended', () => {
  it('treats a repeated finish as the same finish and reports to the prime only once', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const first = finishAgent(worker.caller, 'the work, described');
    expect(first.repeat).toBe(false);
    const again = finishAgent(worker.caller, 'the work, described slightly differently');
    expect(again.repeat).toBe(true);
    expect(again.report).toBeNull();
    expect(pendingCount(PRIME_ID)).toBe(1);
  });

  it('stops a worker that ended for good sending anything more from its own chat', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    expect(() => sendMessage(worker.caller, PRIME_ID, 'actually, one more thing')).toThrow(AgentError);
  });

  it('lets a worker that only fell asleep carry on talking, because it evidently had not stopped', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');

    // A tool call from that chat is first-hand proof the model is still running there, which
    // is worth more than the app's guess a moment ago. It takes its slot back and the prime is
    // told, because it was told the opposite.
    expect(() => sendMessage(worker.caller, PRIME_ID, 'actually, one more thing')).not.toThrow();
    expect(noteAgentAlive('c-worker-1')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(offerMessages(PRIME_ID).some((message) => /awake again/.test(message.text))).toBe(true);
  });

  it('is told so on its own next tool call, instead of quietly working on', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    // The chat itself does not stop when the slot does — the turn is ChatGPT's — so the
    // next call from it has to be the sentence that says the work is over.
    const notice = endedWorkerNotice(worker.caller.conversationId);
    expect(notice).toMatch(/WORKER_ENDED/);
    expect(notice).toMatch(/worker-1/);
    expect(endedWorkerNotice('c-stranger')).toBeNull();
  });

  it('refuses to finish the prime, because a run with no prime is a reset', () => {
    startSwarm(1);
    expect(() => finishAgent(prime, 'I am done')).toThrow(/prime agent does not finish/);
  });
});

describe('a worker whose chat never opened', () => {
  it('ends as failed, frees its slot, and reports to the prime', () => {
    startSwarm(1);
    expect(failAgent('worker-1', 'no ChatGPT tab could be opened')?.report?.to).toBe(PRIME_ID);
    const info = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(info?.state).toBe('failed');
    expect(info?.result).toContain('no ChatGPT tab');
    expect(pendingCount(PRIME_ID)).toBe(1);
    // The slot is free again: a replacement may be created inside the same limit.
    expect(() => spawn({ workers: [{ task: 'replacement' }], caller: prime })).not.toThrow();
  });

  it('stays failed when its chat was never the reason, so no stray tab can revive the slot', () => {
    startSwarm(1);
    startWorker('worker-1');
    failAgent('worker-1', 'tab never opened');
    // A verdict about the work is final. Only a worker given up on because its *view* went
    // away may be taken back, and this one was not.
    expect(noteAgentAlive('c-worker-1')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('failed');
  });

  it('refuses to fail the prime', () => {
    startSwarm(1);
    expect(failAgent(PRIME_ID, 'whatever')).toBeNull();
    expect(swarmRunning()).toBe(true);
  });
});

describe('a worker whose chat closed', () => {
  it('detaches the exact bound worker rather than ending it: the turn is not the tab', () => {
    startSwarm(1);
    startWorker('worker-1');
    expect(workerConversationGone('c-worker-1')).toBe(true);
    const info = swarmState().agents.find((agent) => agent.id === 'worker-1');
    // Still live, still holding its slot, still owed a result. A ChatGPT turn runs on
    // OpenAI's servers, so a closed tab says nothing about whether the work stopped.
    expect(info?.state).toBe('detached');
    // And the prime is told nothing yet, because there is nothing it could act on.
    expect(pendingCount(PRIME_ID)).toBe(0);
  });

  it('keeps a closed-tab worker detached while its server-side turn keeps calling, until a page returns', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // A connector call can continue after the tab was closed because the model turn is
    // server-side. It proves liveness, but not that a browser document exists again. Keep the
    // detached state/slot and restart its silence clock from this call rather than losing the
    // only path that can eventually release a worker whose page never returns.
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');
    expect(sleepSilentDetachedWorkers(Date.now() + DETACHED_SILENCE_MS - 1_000)).toEqual([]);

    // A page observation is the first-hand evidence that the browser view really came back.
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    // It was never out of the run, so its own finish still lands the ordinary way.
    expect(finishAgent(worker.caller, 'done')?.info.state).toBe('sleeping');
  });

  it('sleeps a detached worker on durable completion, and its open tab never wakes it', () => {
    startSwarm(1);
    startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // The stale-run recovery path can observe the durable turn completion after the browser
    // view is already gone. The work stopped; the worker did not end.
    expect(finishWorkerConversation('c-worker-1', 'durably completed')?.info.state).toBe('sleeping');
    const slept = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(slept?.revivable).toBe(true);
    expect(freeWorkerSlots()).toBe(3);

    // Its tab is still open and still reporting the same settled transcript. Waking on that
    // would hand the slot straight back every time the page said hello.
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
  });

  it('ends a durably completed worker for good once its chat is full', () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');
    expect(finishWorkerConversation('c-worker-1', 'durably completed')?.info.state).toBe('finished');
    const finished = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(finished?.revivable).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
  });

  it('sleeps a detached worker only once it has also gone quiet, and reports that to prime', () => {
    startSwarm(1);
    startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // Nothing has been heard from it since the tab went. Its slot goes back, but nothing here
    // is evidence that it is done — the chat is intact and the prime can wake it in place.
    expect(sleepSilentDetachedWorkers(Date.now() + DETACHED_SILENCE_MS + 1_000).length).toBe(1);
    const slept = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(slept?.state).toBe('sleeping');
    expect(slept?.revivable).toBe(true);
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(() => spawn({ workers: [{ task: 'replacement after close' }], caller: prime })).not.toThrow();

    // A worker that was quiet for six minutes and then calls again was, evidently, still going.
    const back = noteAgentAlive('c-worker-1');
    expect(back?.revived).toBe(true);
    expect(back?.report?.to).toBe(PRIME_ID);
    expect(back?.report?.text).toMatch(/awake again/);
  });

  it('does nothing for the prime, a stranger, or an already finished worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(workerConversationGone(PRIME_CHAT)).toBe(false);
    expect(workerConversationGone('c-stranger')).toBe(false);
    finishAgent(worker.caller, 'done');
    expect(workerConversationGone('c-worker-1')).toBe(false);
  });
});

describe('clearing one agent from the app', () => {
  it('frees a worker slot without touching its siblings, and tells the prime a person did it', () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    const result = clearAgent('worker-1');
    expect(result.cleared).toBe('worker');
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-2')?.state).not.toBe('failed');
    const report = offerMessages(PRIME_ID).map((message) => message.text).join('\n');
    expect(report).toMatch(/user/i);
  });

  it('ends the whole run when the prime is cleared', () => {
    startSwarm(1);
    expect(clearAgent(PRIME_ID).cleared).toBe('run');
    expect(swarmRunning()).toBe(false);
  });

  it('clears only the active prime row and preserves another prime dormant history', () => {
    startSwarm(1);
    const workerA = startWorker('worker-1', 'c-worker-a-row-clear');
    finishAgent(workerA.caller, 'A parked first');
    expect(releaseQuiescentRun()).toBe(true);

    const primeB: Caller = { conversationId: 'c-prime-b-row-clear' };
    spawn({ workers: [{ task: 'B active work' }], caller: primeB });
    startWorker('worker-1', 'c-worker-b-row-clear');

    expect(clearAgent(PRIME_ID).cleared).toBe('run');
    expect(swarmRunning()).toBe(false);
    expect(retiredWorkerForConversation('c-worker-b-row-clear')).toMatchObject({
      id: 'worker-1',
      conversationId: 'c-worker-b-row-clear'
    });
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: 'c-worker-a-row-clear'
    });
  });

  it('does nothing, and says so, for an agent that has already ended or never existed', () => {
    startSwarm(2);
    const worker = startWorker('worker-1');
    const other = startWorker('worker-2');
    // A sleeping worker is still one the person can throw away — that is what clearing is
    // for. Only a worker that has already ended has nothing left to clear.
    finishAgent(worker.caller, 'done');
    expect(clearAgent('worker-1').cleared).toBe('worker');
    fillContext('c-worker-2');
    finishAgent(other.caller, 'done');
    expect(clearAgent('worker-2').cleared).toBe('none');
    expect(clearAgent('worker-9').cleared).toBe('none');
    resetAgentsForTests();
    expect(clearAgent('worker-1').cleared).toBe('none');
  });
});


/**
 * Workers sleep instead of ending, and the prime wakes them in the chat they already have.
 *
 * The expensive part of a run is the conversation a worker built up, and throwing that away
 * after one task is what fills somebody's ChatGPT with abandoned chats. Everything here is
 * about that one chat surviving — the tab closing, the prime pausing, the app restarting —
 * and about the worker slot, which is the only genuinely scarce thing in the run.
 */
describe('a worker that is sleeping', () => {
  it('lets a proven call from a parked sleeping worker take the slot back, as inside a live run', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done for now');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    // Identity lookup alone never reactivates, and neither does the prime's own activity.
    expect(dormantWorkerNotice('c-worker-1')).toContain('WORKER_SLEEPING');
    expect(reactivateDormantRunForConversation(PRIME_CHAT)).toBe(false);
    expect(swarmRunning()).toBe(false);

    // The worker's call does: its family holds the slot again and the call revives it, which
    // is exactly what the same call would have done a moment earlier, before the parking.
    expect(reactivateDormantRunForConversation('c-worker-1')).toBe(true);
    expect(swarmRunning()).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(dormantWorkerNotice('c-worker-1')).toBeNull();
  });

  it('keeps a parked family parked for a worker that is over, or while another prime owns the slot', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'over the ceiling');
    expect(releaseQuiescentRun()).toBe(true);
    expect(reactivateDormantRunForConversation('c-worker-1')).toBe(false);
    expect(swarmRunning()).toBe(false);

    spawn({ workers: [{ task: 'other work' }], caller: { conversationId: 'c-prime-b' } });
    const other = startWorker('worker-1', 'c-worker-b-1');
    finishAgent(other.caller, 'B done');
    expect(releaseQuiescentRun()).toBe(true);
    startSwarm(1, { conversationId: 'c-prime-c' });
    expect(reactivateDormantRunForConversation('c-worker-b-1')).toBe(false);
    expect(dormantWorkerNotice('c-worker-b-1')).toContain('WORKER_SLEEPING');
  });

  it('lets MCP win only before the browser claims a waking worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();

    expect(workerRevivalClaimed('c-worker-1')).toBe(false);
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(workerRevivalClaimed('c-worker-1')).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'waking',
      revivable: false
    });

    // A failed durable browser claim restores the pre-cut arbitration window. Only then may a
    // proven old-turn MCP call take the worker back to active and receive the queued inbox.
    expect(rollbackWorkerRevivalClaim('worker-1', 'c-worker-1')).toBe(true);
    expect(workerRevivalClaimed('c-worker-1')).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['second piece']);
  });

  it('finishes a delivered wake on the turn that starts after the sleep, not only on the first call', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    const sleptAt = swarmState().agents.find((agent) => agent.id === 'worker-1')!.sleptAt!;
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);

    // Claimed but not typed: the browser owns the payload, so nothing may end the wake yet —
    // not a turn the page reports, and not the old turn being replayed either.
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)?.revived).toBe(false);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt)?.revived).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    // The typed message started a turn. That is the model running, and the wake is over.
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)).toMatchObject({ revived: true, report: null });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'active',
      sleptAt: null
    });
    expect(pendingWorkerRevivals()).toEqual([]);
  });

  it('lets a turn end a pre-claim wake the way a call does, and refuses the page alone', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    const sleptAt = swarmState().agents.find((agent) => agent.id === 'worker-1')!.sleptAt!;
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    // The queued words were never typed, so they ride on the worker's next result as usual.
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['second piece']);
  });

  it('does not let a stop observed while waking end the wake', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const before = pendingCount(PRIME_ID);

    // The page replaying the settled answer that put the worker to sleep, the sweep proving
    // that same quiet, and the old turn's late finish call: none of them is a fresh stop.
    expect(stageWorkerConversationFinish('c-worker-1', 'first piece done')).toBeNull();
    expect(finishWorkerConversation('c-worker-1', 'first piece done')).toBeNull();
    expect(sleepWorker('worker-1', 'It went quiet.')).toBeNull();
    expect(finishAgent(worker.caller, 'first piece done').repeat).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(pendingWorkerRevivals().map((entry) => entry.id)).toEqual(['worker-1']);
    expect(pendingCount(PRIME_ID), 'the prime is not told the same report twice').toBe(before);

    // The wake still ends the ordinary way.
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('never re-offers a browser-delivered revival row and only lets a later call acknowledge it', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'browser-owned wake text' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);

    // While the browser owns the wake, even a worker MCP result has no inbox delivery authority.
    expect(offerMessages('worker-1')).toEqual([]);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const offeredAt = snapshotSwarm()!.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;

    // A call that began before (or in the same millisecond as) the browser ACK cannot use its
    // later completion as evidence that it saw the injected user message.
    expect(acknowledgeOffers('worker-1', false, offeredAt)).toEqual([]);
    expect(offerMessages('worker-1')).toEqual([]);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(acknowledgeOffers('worker-1', false, offeredAt + 1)).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('preserves a revival-proven offer across restart instead of duplicating it through MCP', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'already typed into the worker chat' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const saved = snapshotSwarm()!;
    const offeredAt = saved.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;

    resetAgentsForTests();
    restoreSwarm(saved);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(offerMessages('worker-1')).toEqual([]);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(acknowledgeOffers('worker-1', false, offeredAt + 1)).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('does not type a browser-delivered revival row again after disable, re-enable and a later wake', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'already delivered before disable' }]).commit();
    const firstRevival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', firstRevival.messageIds)).toBe(true);

    // Turning the feature off is an authoritative pause, not an acknowledgement from the
    // worker. Keep the delivered row for at-least-once receipt accounting, but park the exact
    // worker conversation without ever making that row eligible for browser injection again.
    await setEnabled(false);
    expect(pauseSwarmForDisable()).toBe(true);
    expect(swarmRunning()).toBe(false);

    await setEnabled(true);
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'new work after re-enable' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    const secondRevival = pendingWorkerRevivals()[0]!;
    expect(secondRevival.conversationId).toBe('c-worker-1');
    expect(secondRevival.text).toContain('new work after re-enable');
    expect(secondRevival.text).not.toContain('already delivered before disable');
    expect(secondRevival.messageIds).toHaveLength(1);
  });

  it('keeps a staged finish result and prime report when disable parks the owner before commit', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const staged = stageFinishAgent(worker.caller, 'finish result racing the feature toggle');

    await setEnabled(false);
    expect(pauseSwarmForDisable()).toBe(true);
    expect(swarmRunning()).toBe(false);

    // Ordinary/debounced state must not publish the finish before its acceptance barrier. The
    // disable placeholder is sleeping, but the worker's actual result/report are still staged.
    const ordinary = snapshotSwarm()!;
    const ordinaryWorker = ordinary.dormantRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1');
    expect(ordinaryWorker?.info.result).not.toBe('finish result racing the feature toggle');

    const durable: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      durable.push(snapshot);
    });
    expect(await persistCriticalSwarmNow()).toBe(true);
    const durableHistory = durable.at(-1)?.dormantRuns?.[0]?.agents ?? [];
    expect(durableHistory.find((entry) => entry.info.id === 'worker-1')?.info).toMatchObject({
      state: 'sleeping',
      result: 'finish result racing the feature toggle',
      revivable: true
    });
    expect(durableHistory.find((entry) => entry.info.id === PRIME_ID)?.queue).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('finish result racing the feature toggle') })])
    );

    staged.commit();
    await setEnabled(true);
    const liveHistory = swarmStateForCaller(prime).agents;
    expect(liveHistory.find((entry) => entry.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      result: 'finish result racing the feature toggle',
      revivable: true
    });
    expect(liveHistory.find((entry) => entry.id === PRIME_ID)?.pending).toBe(1);
  });

  it('keeps an in-flight staged message unpublished normally but durable through a disable acceptance barrier', async () => {
    startSwarm(1);
    startWorker('worker-1');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'message accepted while disable races' }]);

    await setEnabled(false);
    expect(pauseSwarmForDisable()).toBe(true);
    expect(snapshotSwarm()!.dormantRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([]);

    const durable: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      durable.push(snapshot);
    });
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(durable.at(-1)?.dormantRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([
      expect.objectContaining({ text: 'message accepted while disable races' })
    ]);

    staged.commit();
    await setEnabled(true);
    expect(swarmStateForCaller(prime).agents.find((entry) => entry.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      pending: 1,
      conversationId: 'c-worker-1'
    });
  });

  it('retires already-offered inbox rows transactionally when the browser observes the worker final', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
    });
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'also inspect the parser edge case');
    const offered = offerMessages('worker-1');
    expect(offered).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(1);

    const staged = stageWorkerConversationFinish('c-worker-1', 'final browser answer');
    expect(staged?.repeat).toBe(false);
    expect(await persistCriticalSwarmNow()).toBe(true);
    const projected = persisted.at(-1)!;
    // The one disk generation that says the worker slept also says the already-delivered row
    // is gone and the prime report exists. Live readers stay pre-finish until commit.
    expect(projected.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([]);
    expect(projected.agents.find((entry) => entry.info.id === PRIME_ID)?.queue.at(-1)?.text).toContain('final browser answer');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'active', pending: 1 });

    // A rejected acceptance write must restore the exact offer; it is still retryable work.
    staged!.rollback();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'active', pending: 1 });

    const retry = stageWorkerConversationFinish('c-worker-1', 'final browser answer');
    expect(await persistCriticalSwarmNow()).toBe(true);
    retry!.commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'sleeping', pending: 0 });

    stageMessages(prime, [{ to: 'worker-1', text: 'now inspect only the lexer' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(revival.text).toContain('now inspect only the lexer');
    expect(revival.text).not.toContain('parser edge case');
  });

  it('frees its slot without leaving the run, and is woken by being messaged', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');

    const asleep = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(asleep?.state).toBe('sleeping');
    expect(asleep?.revivable).toBe(true);
    // Still bound to its own chat: that binding is the worker, and waking it is reopening it.
    expect(asleep?.conversationId).toBe('c-worker-1');

    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'now do the second half' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();

    // The browser is asked for exactly one thing: this chat, with the prime's own words in it.
    const owed = pendingWorkerRevivals();
    expect(owed).toHaveLength(1);
    expect(owed[0]?.conversationId).toBe('c-worker-1');
    expect(owed[0]?.text).toContain('now do the second half');
    expect(owed[0]?.messageIds).toHaveLength(1);
  });

  it('keeps same-named workers isolated across prime histories and revives the original exact chat later', async () => {
    await setEnabled(true, 1);
    startSwarm(1);
    const first = startWorker('worker-1', 'c-worker-a-1');
    finishAgent(first.caller, 'prime A first piece done');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    const primeB: Caller = { conversationId: 'c-prime-b' };
    spawn({ workers: [{ task: 'prime B work' }], caller: primeB });
    const second = startWorker('worker-1', 'c-worker-b-1');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-b-1');

    // A can inspect its history while B owns execution, but cannot wake into B's capacity or
    // enqueue work that would be stranded behind somebody else's active incarnation.
    expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'too early for A' }])).toThrow(/AGENTS_BUSY/i);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      pending: 0,
      conversationId: 'c-worker-a-1'
    });

    finishAgent(second.caller, 'prime B done');
    expect(releaseQuiescentRun()).toBe(true);

    // Both histories keep their own worker-1 without collision after the active claim is gone.
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-a-1');
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-b-1');

    // Explicit owner work reclaims A's history and reserves the one configured slot for A's
    // exact old chat, never B's same-named worker conversation.
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'resume A in the original chat' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    expect(freeWorkerSlots()).toBe(0);
    expect(pendingWorkerRevivals()).toHaveLength(1);
    expect(pendingWorkerRevivals()[0]).toMatchObject({ id: 'worker-1', conversationId: 'c-worker-a-1' });
    expect(pendingWorkerRevivals()[0]?.text).toContain('resume A in the original chat');
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-b-1');

    await setEnabled(true);
  });

  it('restores multiple parked prime histories from one durable snapshot without merging same-named workers', async () => {
    await setEnabled(true, 1);
    const primeB: Caller = { conversationId: 'c-prime-b' };

    startSwarm(1);
    const workerA = startWorker('worker-1', 'c-worker-a-restore');
    finishAgent(workerA.caller, 'A parked');
    expect(releaseQuiescentRun()).toBe(true);

    spawn({ workers: [{ label: 'B worker', task: 'B history' }], caller: primeB });
    const workerB = startWorker('worker-1', 'c-worker-b-restore');
    finishAgent(workerB.caller, 'B parked');
    expect(releaseQuiescentRun()).toBe(true);

    const saved = snapshotSwarm()!;
    expect(saved.version).toBe(5);
    expect(saved.runId).toBeNull();
    expect(saved.dormantRuns).toHaveLength(2);

    resetAgentsForTests();
    restoreSwarm(saved);

    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: 'c-worker-a-restore'
    });
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: 'c-worker-b-restore'
    });

    await setEnabled(true);
  });

  it('explicit Clear swarm destroys parked histories and leaves their worker conversations fenced', () => {
    startSwarm(1);
    const worker = startWorker('worker-1', 'c-worker-clear-dormant');
    finishAgent(worker.caller, 'park before explicit clear');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toBeTruthy();
    expect(swarmState()).toMatchObject({ running: false, retainedHistory: true, agents: [] });

    resetSwarm();

    expect(swarmState()).toMatchObject({ running: false, retainedHistory: false, agents: [] });
    expect(() => swarmStateForCaller(prime)).toThrow(/No sub-agent history/i);
    expect(retiredWorkerForConversation('c-worker-clear-dormant')).toMatchObject({
      id: 'worker-1',
      conversationId: 'c-worker-clear-dormant'
    });
  });

  it('counts only working workers against the limit, so a third runs and the first is woken after', () => {
    startSwarm(3);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');
    const three = startWorker('worker-3');
    expect(freeWorkerSlots()).toBe(0);

    finishAgent(one.caller, 'done');
    expect(freeWorkerSlots()).toBe(1);
    finishAgent(two.caller, 'done');
    finishAgent(three.caller, 'done');
    expect(freeWorkerSlots()).toBe(3);

    // The first one is still there to be woken after the other two have been and gone.
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'back to you' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    expect(freeWorkerSlots()).toBe(2);
  });

  it('refuses to wake one when no slot is free, and queues nothing', () => {
    startSwarm(3);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');
    startWorker('worker-3');
    finishAgent(one.caller, 'done');
    finishAgent(two.caller, 'done');

    // Two sleeping workers, one free slot. The first send takes it; the second is refused
    // outright rather than half-waking anybody.
    stageMessages(prime, [{ to: 'worker-1', text: 'wake up' }]).commit();
    expect(freeWorkerSlots()).toBe(1);
    stageMessages(prime, [{ to: 'worker-2', text: 'you too' }]).commit();
    expect(freeWorkerSlots()).toBe(0);

    const three = startWorker('worker-3');
    finishAgent(three.caller, 'done');
    stageMessages(prime, [{ to: 'worker-3', text: 'and you' }]).commit();
    expect(freeWorkerSlots()).toBe(0);
  });

  it('refuses a second message to a worker whose revival is still in flight', () => {
    startSwarm(2);
    const one = startWorker('worker-1');
    finishAgent(one.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'first' }]).commit();
    // Otherwise the second call's durable message could be stranded with no revival to carry
    // it, if the first one later rolled back.
    expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'second' }])).toThrow(/REVIVE_IN_PROGRESS/);
  });

  it('gives the slot back and keeps the message queued when the browser cannot wake it', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'more work' }]).commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    const report = failWorkerRevival('worker-1', 'the browser could not open its chat');
    const back = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(back?.state).toBe('sleeping');
    expect(back?.revivable).toBe(true);
    expect(freeWorkerSlots()).toBe(3);
    // Nothing was typed, so nothing was delivered: the message is still queued and unoffered.
    expect(pendingCount('worker-1')).toBe(1);
    expect(report?.to).toBe(PRIME_ID);
    expect(report?.text).toContain('could not be woken');

    // And it can simply be tried again.
    const again = stageMessages(prime, [{ to: 'worker-1', text: 'still there?' }]);
    expect(again.waking).toEqual(['worker-1']);
    again.commit();
  });

  it('treats the browser typing the message as an offer, retired by the worker itself', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'the next piece' }]).commit();
    const owed = pendingWorkerRevivals()[0];

    // Another chat is not this worker's revival, whatever the extension reports.
    expect(noteWorkerRevived('worker-1', 'c-somebody-else', owed?.messageIds ?? [])).toBe(false);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', owed?.messageIds ?? [])).toBe(true);
    let awake = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(awake?.state).toBe('waking');
    expect(awake?.result).toBeNull();
    // Offered, not acknowledged: the worker's own next call is what retires it.
    expect(pendingCount('worker-1')).toBe(1);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    awake = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(awake?.state).toBe('active');
    expect(acknowledgeOffers('worker-1')).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('survives its tab closing, and is still there to be woken', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');

    // Closing the tab of a chat nobody is using is not an ending.
    expect(workerConversationGone('c-worker-1')).toBe(false);
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('sleeping');
    expect(after?.conversationId).toBe('c-worker-1');
    expect(stageMessages(prime, [{ to: 'worker-1', text: 'reopen and carry on' }]).waking).toEqual(['worker-1']);
  });

  it('does not let a tab close steal a waking transaction before its exact send acknowledgement', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'reopen and carry on' }]);
    staged.commit();
    expect(staged.waking).toEqual(['worker-1']);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    // Reload/close can race the command ACK. The leased wake transaction owns the state until
    // that ACK or its timeout settles; rewriting it to detached makes a truthful sent ACK fail.
    expect(workerConversationGone('c-worker-1')).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(noteWorkerRevived('worker-1', 'c-worker-1', staged.messages.map((message) => message.id))).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('does not strand work queued while a closed-tab worker was still considered active', async () => {
    startSwarm(1);
    startWorker('worker-1');
    expect(workerConversationGone('c-worker-1')).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');

    // The prime cannot safely inject a second user turn while the server-side turn may still
    // be running, so this is initially an inbox message rather than an immediate revival.
    const queued = stageMessages(prime, [{ to: 'worker-1', text: 'when you are done, inspect the parser too' }]);
    expect(queued.waking).toEqual([]);
    queued.commit();
    expect(pendingCount('worker-1')).toBe(1);

    // Once silence proves the detached turn has stopped, that already-accepted work must be
    // what wakes the worker. Leaving it merely sleeping strands the instruction until the
    // prime happens to send a second message, even though the first call already said queued.
    sleepSilentDetachedWorkers(Date.now() + DETACHED_SILENCE_MS + 1_000);
    const deferred = stageQueuedWorkerRevivals(['worker-1']);
    expect(deferred.waking).toEqual(['worker-1']);
    expect(await persistCriticalSwarmNow()).toBe(true);
    deferred.commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(pendingWorkerRevivals()[0]?.text).toContain('inspect the parser too');
  });

  it('outlives the prime chat closing, because the user comes back and carries on', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    acknowledgeOffers(PRIME_ID);

    // The case this whole feature is for: the prime stops, the user reads the result, and the
    // prime is asked for more an hour later. Ending the run here threw the workers away with it.
    expect(primeConversationGone(PRIME_CHAT)).toBe(false);
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    expect(noteAgentAlive(PRIME_CHAT)?.revived).toBe(true);
    expect(identify({ conversationId: PRIME_CHAT }).id).toBe(PRIME_ID);
    expect(stageMessages(prime, [{ to: 'worker-1', text: 'one more thing' }]).waking).toEqual(['worker-1']);
  });

  it('keeps a terminal worker report until the closed prime returns and acknowledges it', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    expect(swarmState().agents.find((agent) => agent.role === 'prime')?.pending).toBe(1);

    // No reusable worker remains, but the result that made it terminal is still owed to the
    // prime. Closing its tab must not destroy that report.
    expect(primeConversationGone(PRIME_CHAT)).toBe(false);
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.role === 'prime')?.state).toBe('detached');

    expect(noteAgentAlive(PRIME_CHAT)?.revived).toBe(true);
    expect(offerMessages(PRIME_ID).at(-1)?.text).toContain('[worker-1 finished] done');
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
  });

  it('keeps a worker revivable when it stops one token below the 400k ceiling', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    noteAgentContextTokens('c-worker-1', WORKER_CONTEXT_CEILING_TOKENS - 1);

    const done = finishAgent(worker.caller, 'still reusable');
    expect(done.info).toMatchObject({
      state: 'sleeping',
      revivable: true,
      contextTokens: WORKER_CONTEXT_CEILING_TOKENS - 1
    });
    expect(() => sendMessage(prime, 'worker-1', 'wake below the ceiling')).not.toThrow();
  });

  it('keeps working after it crosses the context ceiling, and only then ends for good', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');

    // Crossing is not an interruption. The worker is mid-task and stays exactly where it is;
    // what changes is that this task is now its last one.
    fillContext('c-worker-1');
    const during = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(during?.state).toBe('active');
    expect(during?.revivable).toBe(false);
    // The ceiling revokes the *next wake*, not live messaging. Prime redirects sent while this
    // exact worker is still active must remain deliverable through its normal inbox.
    expect(() => sendMessage(prime, 'worker-1', 'include the last parser edge case')).not.toThrow();
    expect(offerMessages('worker-1').at(-1)?.text).toBe('include the last parser edge case');
    expect(() => sendMessage(worker.caller, PRIME_ID, 'still going')).not.toThrow();

    const done = finishAgent(worker.caller, 'the last thing it will ever do');
    expect(done.info.state).toBe('finished');
    expect(done.info.revivable).toBe(false);
    expect(() => sendMessage(prime, 'worker-1', 'once more')).toThrow(/finished/);
  });

  it('promotes a sleeping worker to finished the moment its chat crosses the ceiling', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    // A late measurement of the same chat — the session store finishing its accounting after
    // the worker stopped — is what makes that stop permanent.
    fillContext('c-worker-1');
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(after?.revivable).toBe(false);
  });

  it('upgrades a staged sleeping finish if the 400k crossing lands before its durable barrier', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const staged = stageFinishAgent(worker.caller, 'last piece done');
    expect(staged.info.state).toBe('sleeping');

    // Session accounting can finish while the broker fsync for the final observation is still
    // pending. The one durable snapshot must not combine the new >=400k authority fact with the
    // stale pre-crossing "sleeping/revivable" finish projection.
    fillContext('c-worker-1');
    let written: ReturnType<typeof snapshotSwarm> | undefined;
    onSwarmPersistNow(async (snapshot) => {
      written = snapshot;
    });
    expect(await persistCriticalSwarmNow()).toBe(true);

    expect(staged.info.state).toBe('finished');
    expect(staged.info.revivable).toBe(false);
    expect(staged.report?.text).toMatch(/finished for good|cannot be woken/i);
    const saved = written?.agents.find((entry) => entry.info.id === 'worker-1')?.info;
    expect(saved?.contextTokens).toBeGreaterThanOrEqual(WORKER_CONTEXT_CEILING_TOKENS);
    expect(saved?.state).toBe('finished');
    expect(saved?.revivable).toBe(false);

    staged.commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
  });

  it('never rolls a waking worker back to revivable sleep after it crosses 400k', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'one more task' }]);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    fillContext('c-worker-1');
    staged.rollback();

    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(after?.revivable).toBe(false);
  });

  it('terminalises a failed in-flight revival if that chat crossed 400k while waking', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'one more task' }]).commit();
    fillContext('c-worker-1');

    const report = failWorkerRevival('worker-1', 'browser could not reopen the chat');
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(after?.revivable).toBe(false);
    expect(report?.text).toMatch(/context limit|cannot be woken|finished for good/i);
    expect(report?.text).not.toMatch(/try agents action=message/i);
  });

  it('does not leave accepted prime work stranded when a sleeping worker crosses the ceiling', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');

    // The prime got an accepted send, but the browser failed before typing it. The worker is
    // asleep again with real unread work in its durable inbox.
    stageMessages(prime, [{ to: 'worker-1', text: 'finish the parser audit' }]).commit();
    failWorkerRevival('worker-1', 'browser could not reopen the chat');
    expect(pendingCount('worker-1')).toBe(1);

    // A late session measurement proves this chat cannot be reused after all. Terminalising it
    // must retire work that can no longer be delivered and tell the prime, rather than leaving
    // a terminal row with a permanently nonzero inbox and a previously-successful send.
    fillContext('c-worker-1');
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(pendingCount('worker-1')).toBe(0);
    expect(
      offerMessages(PRIME_ID).some(
        (message) => message.text.includes('finish the parser audit') && /could not be delivered|not delivered/i.test(message.text)
      )
    ).toBe(true);
  });

  it('never un-crosses the ceiling on a smaller reading', () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');
    noteAgentContextTokens('c-worker-1', 1_000);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.revivable).toBe(false);
  });

  it('keeps an accepted wake across a restart, and asks the browser for it again', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'do the second half' }]).commit();
    const snapshot = snapshotSwarm();

    resetAgentsForTests();
    restoreSwarm(snapshot);

    // The accepted send is durable and so is the reservation carrying it. Demoting this worker
    // back to sleeping on restore would leave the prime's message queued with nothing left to
    // deliver it.
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    const asked: string[] = [];
    onReviveRequest((revivals) => asked.push(...revivals.map((revival) => revival.id)));
    expect(asked).toEqual(['worker-1']);
    expect(pendingWorkerRevivals()[0]?.text).toContain('do the second half');
  });

  it('restores a sleeping worker as itself, still wakeable in the chat it kept', () => {
    startSwarm(2);
    const one = startWorker('worker-1');
    finishAgent(one.caller, 'done');
    const snapshot = snapshotSwarm();
    resetAgentsForTests();
    restoreSwarm(snapshot);

    const restored = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(restored?.state).toBe('sleeping');
    expect(restored?.revivable).toBe(true);
    expect(stageMessages(prime, [{ to: 'worker-1', text: 'again' }]).waking).toEqual(['worker-1']);
  });
});

describe('restart', () => {
  it('drops parked histories beyond the newest sixteen or older than a week, retiring their worker chats', async () => {
    vi.useFakeTimers();
    try {
      await setEnabled(true, 1);
      const park = (n: number): void => {
        spawn({ workers: [{ task: `work ${n}` }], caller: { conversationId: `c-prime-${n}` } });
        const worker = startWorker('worker-1', `c-worker-${n}`);
        finishAgent(worker.caller, `done ${n}`);
        expect(releaseQuiescentRun()).toBe(true);
        vi.setSystemTime(Date.now() + 1_000);
      };
      for (let n = 1; n <= 17; n++) park(n);
      expect(snapshotSwarm()!.dormantRuns).toHaveLength(16);
      expect(dormantWorkerNotice('c-worker-1')).toBeNull();
      expect(retiredWorkerForConversation('c-worker-1')?.id).toBe('worker-1');
      expect(dormantWorkerNotice('c-worker-2')).toContain('WORKER_SLEEPING');

      // A week later the rest are history too, on the next parking and on a restart alike.
      const saved = snapshotSwarm()!;
      vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000);
      park(18);
      expect(snapshotSwarm()!.dormantRuns?.map((entry) => entry.primeConversationId)).toEqual(['c-prime-18']);

      resetAgentsForTests();
      restoreSwarm(saved);
      expect(snapshotSwarm()?.dormantRuns ?? []).toHaveLength(0);
      expect(retiredWorkerForConversation('c-worker-17')?.id).toBe('worker-1');
    } finally {
      vi.useRealTimers();
      await setEnabled(true);
    }
  });

  it('restores every still-live retired worker fence after histories grow beyond the old 64-worker ceiling', () => {
    const now = Date.now();
    restoreRetiredWorkers({
      version: 1,
      savedAt: now,
      workers: Array.from({ length: 65 }, (_, index) => ({
        id: `worker-${index + 1}`,
        conversationId: `c-retired-${index + 1}`,
        reason: 'explicit clear of a long-lived worker history',
        retiredAt: now
      }))
    });

    expect(retiredWorkerForConversation('c-retired-1')).toMatchObject({ id: 'worker-1' });
    expect(retiredWorkerForConversation('c-retired-65')).toMatchObject({ id: 'worker-65' });
  });

  it('restores an active prime beside another prime full sleeping and terminal dormant history', () => {
    const primeB: Caller = { conversationId: 'c-prime-b-active-restore' };
    startSwarm(2);
    const sleeper = startWorker('worker-1', 'c-worker-a-sleeper-restore');
    const terminal = startWorker('worker-2', 'c-worker-a-terminal-restore');
    finishAgent(sleeper.caller, 'keep this exact chat reusable');
    fillContext('c-worker-a-terminal-restore');
    finishAgent(terminal.caller, 'this exact chat is full');
    expect(releaseQuiescentRun()).toBe(true);

    spawn({ workers: [{ task: 'B stays active across restart' }], caller: primeB });
    startWorker('worker-1', 'c-worker-b-active-restore');
    const saved = snapshotSwarm()!;
    expect(saved.runId).not.toBeNull();
    expect(saved.dormantRuns).toHaveLength(1);

    resetAgentsForTests();
    restoreSwarm(saved);

    expect(swarmRunning()).toBe(true);
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'active',
      conversationId: 'c-worker-b-active-restore'
    });
    const aHistory = swarmStateForCaller(prime).agents;
    expect(aHistory.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'c-worker-a-sleeper-restore'
    });
    expect(aHistory.find((agent) => agent.id === 'worker-2')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'c-worker-a-terminal-restore'
    });
    expect(statusForCaller(prime)).toMatchObject({ runId: null, freeWorkerSlots: 0 });
  });

  it('persists worker binding and activation as one state transition', () => {
    startSwarm(1);
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => persisted.push(snapshotSwarm()));

    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
    expect(persisted).toHaveLength(1);
    const worker = persisted[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.info;
    expect(worker?.conversationId).toBe('c-worker-1');
    expect(worker?.state).toBe('active');
  });

  it('repairs the legacy bound-but-invited crash snapshot instead of opening a duplicate worker chat', () => {
    startSwarm(1);
    const snapshot = snapshotSwarm()!;
    const worker = snapshot.agents.find((entry) => entry.info.id === 'worker-1')!.info;
    // This is the exact intermediate generation the old two-step activation could put on
    // disk if the process died between its two changed() calls.
    worker.conversationId = 'c-worker-1';
    worker.state = 'invited';
    worker.activatedAt = null;

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(pendingWorkerSpawns()).toEqual([]);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(identify({ conversationId: 'c-worker-1' }).id).toBe('worker-1');
  });

  it('repairs a legacy finished snapshot that still says the worker is revivable', () => {
    startSwarm(1);
    startWorker('worker-1');
    const snapshot = snapshotSwarm()!;
    const worker = snapshot.agents.find((entry) => entry.info.id === 'worker-1')!.info;
    worker.state = 'finished';
    worker.finishedAt = Date.now();
    worker.result = 'already done';
    worker.revivable = true;

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.revivable).toBe(false);
    expect(noteAgentAlive('c-worker-1')).toBeNull();
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
  });

  it('re-keys a pre-UUID version-4 snapshot instead of restoring its 32-bit run incarnation', () => {
    startSwarm(1);
    const snapshot = snapshotSwarm()!;
    // Version 4 predates the full-UUID run fence. Those builds wrote only the first eight hex
    // characters but the snapshot version itself did not change, so an upgrade can genuinely
    // encounter this durable shape.
    snapshot.runId = 'deadbeef';

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(currentRunId()).not.toBe('deadbeef');
    expect(currentRunId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // Re-keying the recovered incarnation must not throw away the durable run itself. An
    // invited worker will simply be re-bootstrapped under the new fence.
    expect(swarmState().agents.map((agent) => agent.id)).toEqual([PRIME_ID, 'worker-1']);
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1']);
  });

  it('separates critical broker durability from delivery telemetry and drains exact snapshots on demand', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
    });

    startSwarm(1);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.primeConversationId).toBe(PRIME_CHAT);

    sendMessage(prime, 'worker-1', 'critical queue mutation');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(persisted[1]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);

    // Offer/ACK timestamps are delivery telemetry. They still use the debounced persistence
    // callback, but they do not manufacture another critical disk barrier revision.
    offerMessages('worker-1');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
    acknowledgeOffers('worker-1');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
  });

  it('does not mark a newer critical generation durable when it appears during an older immediate write', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
      if (persisted.length === 1) {
        firstStarted();
        await firstGate;
      }
    });

    startSwarm(1);
    const draining = persistCriticalSwarmNow();
    await firstWriteStarted;
    sendMessage(prime, 'worker-1', 'created while generation one is on disk');
    releaseFirst();

    expect(await draining).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);
    expect(persisted[1]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);
  });

  it('keeps an unpublished message out of a debounced disk write while its immediate acceptance write is held and failing', async () => {
    const stateName = 'message-atomicity-race';
    startSwarm(1);
    // Drain the run-creation revision through the normal test sink so the controlled
    // immediate writer below belongs only to the message being exercised.
    expect(await persistCriticalSwarmNow()).toBe(true);

    // Production wiring snapshots synchronously into the debounced lane whenever the broker
    // says it changed. The timer may reach disk while an independent immediate acceptance
    // barrier is still waiting, so this must be a *committed-only* snapshot.
    onSwarmPersist(() => writeDurableSoon(stateName, snapshotSwarm()));

    let immediateEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      immediateEntered = resolve;
    });
    let releaseImmediate!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseImmediate = resolve;
    });
    let targetRenames = 0;
    const realRename = fs.rename.bind(fs);
    const renameFailure = Object.assign(new Error('injected immediate swarm rename failure'), { code: 'EBUSY' });
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${stateName}.json`)) {
        targetRenames += 1;
        // Rename #1 is the debounced writer fired while the barrier is held. Rename #2 is
        // the immediate acceptance generation, which fails and therefore remains pending.
        if (targetRenames === 2) throw renameFailure;
      }
      return realRename(from, to);
    });

    onSwarmPersistNow(async (snapshot) => {
      // The immediate lane is the *only* snapshot allowed to contain unpublished messages:
      // it is exactly the generation whose fsync decides whether this send was accepted.
      expect(snapshot?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);
      immediateEntered();
      await held;
      await writeDurableNow(stateName, snapshot);
    });

    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'do not publish before fsync' }]);
    const barrier = persistCriticalSwarmNow();
    await entered;

    // Force the ordinary debounce to disk *before* the acceptance barrier is released. A
    // crash here must recover the pre-send queue, because the sender has not been told the
    // message was accepted yet.
    await flushDurable();
    const whileHeld = await readDurable<ReturnType<typeof snapshotSwarm>>(stateName);
    expect(whileHeld?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);

    releaseImmediate();
    await expect(barrier).rejects.toMatchObject({ code: 'EBUSY' });
    staged.rollback();

    // writeDurableNow keeps its failed generation pending for retry. Rollback must enqueue a
    // *newer* committed-only snapshot, so that failed staged generation can never win later.
    rename.mockRestore();
    await flushDurable();
    const afterRollback = await readDurable<ReturnType<typeof snapshotSwarm>>(stateName);
    expect(afterRollback?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);
  });

  it('publishes a staged worker topology only after its exact critical snapshot is durable', async () => {
    const ordinary: Array<ReturnType<typeof snapshotSwarm>> = [];
    const critical: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => ordinary.push(snapshotSwarm()));
    onSwarmPersistNow(async (snapshot) => {
      critical.push(snapshot);
    });

    const staged = stageSpawn({ workers: [{ task: 'inspect topology' }], caller: prime });

    // The broker reserves the one global run while acceptance is in flight, but nothing that
    // can publish/open workers is allowed to see the planned topology yet.
    expect(swarmRunning()).toBe(true);
    expect(swarmState()).toMatchObject({ running: false, agents: [] });
    expect(snapshotSwarm()).toBeNull();
    expect(pendingWorkerSpawns()).toEqual([]);
    expect(ordinary.at(-1)).toBeNull();

    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(critical.at(-1)?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
    staged.commit();

    expect(swarmState().running).toBe(true);
    expect(snapshotSwarm()?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
    expect(pendingWorkerSpawns()).toEqual([{ id: 'worker-1', task: 'inspect topology' }]);
    expect(ordinary.at(-1)?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
  });

  it('rolls a staged addition back to the previously accepted run without leaking it to ordinary snapshots', () => {
    spawn({ workers: [{ task: 'accepted worker' }], caller: prime });
    const before = snapshotSwarm();

    const staged = stageSpawn({ workers: [{ task: 'second worker' }], caller: prime });
    expect(staged.created.map((entry) => entry.id)).toEqual(['worker-2']);
    expect(snapshotSwarm()?.agents.some((entry) => entry.info.id === 'worker-2')).toBe(false);
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-1']);

    staged.rollback();
    expect(swarmState().agents.some((entry) => entry.id === 'worker-2')).toBe(false);
    expect(snapshotSwarm()?.agents.map((entry) => entry.info.id)).toEqual(before?.agents.map((entry) => entry.info.id));
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-1']);
  });

  it('carries the run, its bindings and its in-flight messages through a snapshot', () => {
    let persists = 0;
    onSwarmPersist(() => {
      persists += 1;
    });
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'keep going, but check the parser');
    offerMessages('worker-1');

    const snapshot = snapshotSwarm()!;
    expect(persists).toBeGreaterThan(0);
    // Nothing in a snapshot can authorise a call, because nothing in this app can: an agent
    // is the conversation it runs in, and that id is recorded on purpose.
    expect(JSON.stringify(snapshot)).not.toMatch(/key|secret|hash/i);

    resetAgentsForTests();
    expect(swarmRunning()).toBe(false);
    restoreSwarm(snapshot);

    expect(swarmRunning()).toBe(true);
    // The prime is still the same chat, and the worker is still in its own.
    expect(identify(prime).id).toBe(PRIME_ID);
    expect(identify({ conversationId: 'c-worker-1' }).id).toBe('worker-1');
    // An offer that was in flight when the app stopped is offered again, not lost.
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual([
      'keep going, but check the parser'
    ]);
  });

  it('replays a queued worker spawn when the bridge registers after the restore', () => {
    startSwarm(2);
    const snapshot = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(snapshot);
    const spawned: string[] = [];
    onSpawnRequest((workers) => spawned.push(...workers.map((worker) => worker.id)));
    expect(spawned).toEqual(['worker-1', 'worker-2']);
  });

  it('repairs only the exact durable prime A→B recovery transition after transfer state was lost', () => {
    startSwarm(2);
    const snapshot = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(true);
    expect(snapshotSwarm()?.primeConversationId).toBe('c-resumed');
    expect(identify({ conversationId: 'c-resumed' }).id).toBe(PRIME_ID);
    // Recovery replay is idempotent, but neither a different source nor an unrelated target
    // can use this hook as a takeover mechanism.
    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(true);
    expect(repairPrimeConversationAfterRecovery('c-other', 'c-hijack')).toBe(false);
    expect(snapshotSwarm()?.primeConversationId).toBe('c-resumed');
  });

  it('refuses recovery repair when the durable target chat is already a worker identity', () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-resumed');
    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(false);
    expect(snapshotSwarm()?.primeConversationId).toBe(PRIME_CHAT);
  });
});

describe('through the MCP endpoint', () => {
  let endpoint: Awaited<ReturnType<typeof startMcpServer>>;
  let nextId = 1;

  const post = (body: unknown, extraHeaders: Record<string, string> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const url = new URL(endpoint.url);
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(payload),
            ...extraHeaders
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            const frame = text.startsWith('{') ? text : ([...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? '{}');
            try {
              resolve(JSON.parse(frame));
            } catch {
              resolve({ raw: text });
            }
          });
        }
      );
      req.on('error', reject);
      req.end(payload);
    });

  let evidenceSeq = 0;

  const waitForRunningToolCall = async (timeoutMs = 5_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (runningToolCalls() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runningToolCalls()).toBeGreaterThan(0);
  };

  const callTool = async (name: string, args: unknown): Promise<string> => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
    return ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
  };

  const agents = (action: string, args: Record<string, unknown> = {}): Promise<string> =>
    callTool('agents', { action, ...args });

  const agentsWithRequestId = async (
    requestId: string,
    action: string,
    args: Record<string, unknown> = {}
  ): Promise<string> => {
    const reply = await replyWithRequestId(requestId, action, args);
    return ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
  };

  const replyWithRequestId = (requestId: string, action: string, args: Record<string, unknown>): Promise<any> =>
    post(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'agents', arguments: { action, ...args } } },
      { 'x-request-id': `${requestId}/relay` }
    );

  const ordinaryWithRequestId = (requestId: string, name: string, args: Record<string, unknown>): Promise<any> =>
    post(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
      { 'x-request-id': `${requestId}/relay` }
    );

  const textOfReply = (reply: any): string =>
    ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');

  /** The evidence dance of asChat, kept, but reading the machine half of the result. */
  const structuredAsChat = async (
    conversationId: string,
    action: string,
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> => {
    const seq = ++evidenceSeq;
    const requestId = `wfr_agents_${seq}`;
    const pending = replyWithRequestId(requestId, action, args);
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-${seq}`,
        calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
      }
    ]);
    return (await pending).result?.structuredContent ?? {};
  };

  /**
   * Makes a call that ChatGPT's own message model names, from one conversation.
   *
   * This is the only identity anything has now, so it is the only way to make a control
   * call as somebody. The evidence is fed *while the request is in flight*, which is one of
   * the two ways it really arrives. The other is ahead of the call — ChatGPT paints the
   * connector row while it is still composing the request — and that one is covered
   * separately below, because assuming it could not happen is exactly what made every live
   * spawn impossible.
   */
  const asChat = async (conversationId: string, action: string, args: Record<string, unknown> = {}): Promise<string> => {
    const seq = ++evidenceSeq;
    const requestId = `wfr_agents_${seq}`;
    const pending = agentsWithRequestId(requestId, action, args);
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-${seq}`,
        calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
      }
    ]);
    return pending;

  };

  beforeEach(async () => {
    endpoint = await startMcpServer(() => ({
      roots: [],
      caps: { ...DEFAULT_CAPABILITIES },
      readOnly: true,
      sessionTools: false,
      agentTools: true
    }));
  });

  afterEach(async () => {
    await endpoint.stop();
  });

  // One flat tool with five actions. The names it replaced are gone outright, not aliased,
  // so a chat still holding the old instructions gets an honest unknown-tool error.
  it('publishes one agents tool with exactly four actions', async () => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
    const names = (reply.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain('agents');
    for (const gone of [
      'agent_inbox',
      'agent_status',
      'create_agents',
      'finish_agent',
      'join_agent',
      'revive_agent',
      'send_agent_message'
    ]) {
      expect(names).not.toContain(gone);
    }

    const schema = (reply.result.tools as Array<{ name: string; inputSchema: any }>).find(
      (tool) => tool.name === 'agents'
    )!.inputSchema;
    expect(schema.properties.action.enum.slice().sort()).toEqual(['finish', 'message', 'spawn', 'status']);
    // Revive is gone from the wire as well as from the broker: no field survives for it.
    expect(Object.keys(schema.properties)).not.toContain('agent');
  });

  it('is identified by exact request-id evidence that arrived before the call it names', async () => {
    // Evidence may arrive before HTTP. The timestamp is irrelevant; the normalized request
    // id is the join, so a pre-existing exact mate remains authoritative.
    await recordChatObservations('c-ahead', [
      { kind: 'turn_start', time: Date.now() - 5_500, turnId: 't-ahead' },
      {
        kind: 'tool_evidence',
        time: Date.now() - 5_500,
        turnId: 't-ahead',
        calls: [{ messageId: 'm-ahead', tool: 'agents', order: 0, answered: false, requestId: 'wfr_agents_ahead' }]
      }
    ]);

    const text = await agentsWithRequestId('wfr_agents_ahead', 'spawn', { workers: [{ task: 'read the file' }] });

    expect(text).not.toContain('UNIDENTIFIED_CALLER');
    expect(swarmRunning()).toBe(true);
    expect(identify({ conversationId: 'c-ahead' }).id).toBe(PRIME_ID);
  });

  it('refuses a spawn whose conversation this app cannot prove, and creates nothing', async () => {
    const text = await agents('spawn', { workers: [{ task: 'anything' }] });
    expect(text).toMatch(/UNIDENTIFIED_CALLER|could not/i);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('rolls back a spawn whose durable acceptance barrier fails instead of resurrecting it from the debounce', async () => {
    const stateName = 'spawn-atomicity-failure';
    onSwarmPersist(() => writeDurableSoon(stateName, snapshotSwarm()));
    onSwarmPersistNow(async () => {
      throw new Error('injected spawn durability failure');
    });

    const failed = await asChat(PRIME_CHAT, 'spawn', { workers: [{ task: 'audit the parser' }] });
    expect(failed).toMatch(/durable acceptance barrier|durab|injected spawn durability failure/i);

    // A failed public operation must not keep an invisible run claim in memory. More
    // importantly, spawn() already fired the ordinary debounced persistence callback before
    // the immediate barrier ran; if that callback was allowed to see the staged topology, a
    // later restart would restore it and replay pendingWorkerSpawns(), opening a worker tab for
    // a spawn ChatGPT was explicitly told had failed.
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
    await flushDurable();
    expect(await readDurable(stateName)).toBeNull();
  });

  it('exposes no key field anywhere in the agents schema', async () => {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
    const tools = reply.result.tools as Array<{ name: string; inputSchema: any }>;
    // Not on agents, and — the part that used to be false — not on any other tool either.
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('agent_key');
    }
    const agentsSchema = tools.find((tool) => tool.name === 'agents')!.inputSchema;
    // Not a key by any spelling: the recovery action that needed one is gone entirely.
    for (const field of Object.keys(agentsSchema.properties)) {
      expect(field).not.toMatch(/key|secret|token/i);
    }
    expect(JSON.stringify(agentsSchema)).not.toMatch(/join/i);
  });

  it('tells an unrelated chat AGENTS_BUSY and nothing whatsoever about the run', async () => {
    startSwarm(1);
    const text = await asChat('c-stranger', 'status');
    expect(text).toContain('AGENTS_BUSY');
    expect(text).not.toContain('worker-1');
    expect(text).not.toContain('task 1');
    expect(text).not.toContain(PRIME_CHAT);
  });

  it('shows a parked prime only its own history while another prime owns the active run', async () => {
    spawn({ workers: [{ label: 'A history worker', task: 'A private task' }], caller: prime });
    expect(bindConversation('worker-1', 'c-worker-a')).toBe(true);
    finishAgent({ conversationId: 'c-worker-a' }, 'A done for now');
    expect(releaseQuiescentRun()).toBe(true);

    spawn({
      workers: [{ label: 'B live worker', task: 'B private task' }],
      caller: { conversationId: 'c-prime-b' }
    });
    const structured = await structuredAsChat(PRIME_CHAT, 'status');
    expect(structured.self).toBe(PRIME_ID);
    expect(structured.run_id).toBeNull();
    // A owns history but cannot consume the one global execution claim while B is active.
    expect(structured.free_worker_slots).toBe(0);
    expect(structured.agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'worker-1', label: 'A history worker', state: 'sleeping' })])
    );
    expect(JSON.stringify(structured)).not.toContain('B live worker');
    expect(JSON.stringify(structured)).not.toContain('B private task');
  });

  it('fences an exact dormant worker tool call while another prime owns the active run', async () => {
    await setEnabled(true, 3, true);
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first prime work done');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    // Another prime is now entitled to the one active execution claim and may reuse the same
    // friendly worker ids. The old exact worker conversation remains worker-owned history, not
    // an ordinary chat that can keep using local tools.
    spawn({ workers: [{ task: 'second prime work' }], caller: { conversationId: 'c-prime-b' } });

    const requestId = 'wfr_dormant_worker_exact';
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: Date.now(), turnId: 't-dormant-exact' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: 't-dormant-exact',
        calls: [{ messageId: 'm-dormant-exact', tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    const reply = await ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] });
    const text = textOfReply(reply);
    await setEnabled(true);
    expect(text).toContain('WORKER_SLEEPING');
    expect(text).toContain('Nothing was run');
    expect(text).not.toMatch(REFUSED_ON_ROOTS);
    expect(identify({ conversationId: 'c-prime-b' }).id).toBe(PRIME_ID);
  });

  it('allows only ambiguous unattributed execution while preserving an exact retired-worker fence', async () => {
    startSwarm(1);
    startWorker('worker-1', 'c-retired-worker-policy');
    expect(clearAgent(PRIME_ID).cleared).toBe('run');

    const blocked = await callTool('read', { paths: ['/anything'] });
    expect(blocked).toContain('CALLER_IDENTITY_REQUIRED');

    await setEnabled(true, 3, true);
    const anonymous = await callTool('read', { paths: ['/anything'] });
    expect(anonymous).not.toContain('CALLER_IDENTITY_REQUIRED');
    expect(anonymous).toMatch(REFUSED_ON_ROOTS);

    const requestId = 'wfr_retired_worker_allow_unattributed';
    await recordChatObservations('c-retired-worker-policy', [
      { kind: 'turn_start', time: Date.now(), turnId: 't-retired-policy' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: 't-retired-policy',
        calls: [{ messageId: 'm-retired-policy', tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    const exact = textOfReply(await ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] }));
    await setEnabled(true);
    expect(exact).toContain('WORKER_RETIRED');
  });

  it('permits an unattributed workspace-dependent call to fail honestly instead of guessing a chat', async () => {
    await setEnabled(true, 3, true);
    startSwarm(1);
    const text = await callTool('read', { paths: ['relative.txt'] });
    await setEnabled(true);

    expect(text).not.toContain('CALLER_IDENTITY_REQUIRED');
    expect(text).toMatch(/relative.*no active folder/i);
    expect(text).toContain('(none approved)');
  });

  it('waits for late exact identity while dormant worker histories exist, then revives that worker', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'sleep before late evidence');
    expect(releaseQuiescentRun()).toBe(true);

    const requestId = 'wfr_dormant_worker_late';
    const pending = ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] });
    // Initial cheap correlation has already had a chance to miss. Deliver the exact page mate
    // while the kernel is in its dormant-worker evidence window.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: Date.now(), turnId: 't-dormant-late' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: 't-dormant-late',
        calls: [{ messageId: 'm-dormant-late', tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    // The exact worker is still calling, so it never stopped: no other prime owns the slot,
    // and the call takes its family out of parking and the worker out of sleep. On 2026-09-01
    // six workers were refused WORKER_SLEEPING mid-turn here for being the last to "finish".
    const text = textOfReply(await pending);
    expect(text).not.toContain('WORKER_SLEEPING');
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('delivers and acknowledges a parked prime inbox by exact conversation without adopting another history', async () => {
    startSwarm(1);
    startWorker('worker-1');

    const finished = await asChat('c-worker-1', 'finish', { result: 'parked-prime-report' });
    expect(finished).toMatch(/reported and is now asleep/i);
    expect(swarmRunning()).toBe(false);

    // The final worker report lives in A's dormant prime queue. There is no live agent:prime
    // identity to address here, so delivery must resolve from the exact prime conversation.
    const first = await asChat(PRIME_CHAT, 'status');
    expect(first).toContain('--- 1 message(s) for prime ---');
    expect(first).toContain('parked-prime-report');
    expect(swarmRunning()).toBe(false);

    // Make another prime active with the same friendly `prime`/`worker-1` ids before A proves
    // receipt. Friendly-id recording would now resolve `prime` to B, which is exactly the leak
    // this regression guards against.
    spawn({ workers: [{ task: 'B is the active owner now' }], caller: { conversationId: 'c-prime-b' } });
    await recordChatObservations('c-prime-b', [{ kind: 'turn_start', time: Date.now(), turnId: 'b-active-turn' }]);

    // This authenticated follow-up proves the preceding result arrived and retires that offer.
    // The historical worker/result can still appear in the status table, but the inbox row must
    // not be pushed a second time.
    const second = await asChat(PRIME_CHAT, 'status');
    expect(second).not.toContain('--- 1 message(s) for prime ---');
    expect(swarmRunning()).toBe(true);

    const aSession = await findSessionByConversation(PRIME_CHAT, { requireUnique: true });
    const bSession = await findSessionByConversation('c-prime-b', { requireUnique: true });
    expect(aSession).toBeTruthy();
    expect(bSession).toBeTruthy();
    const aDelivered = (await readRecentEvents(aSession!.id, 50, { kinds: ['agent_message'] })).filter(
      (event) => event.kind === 'agent_message' && event.delivery === 'delivered' && event.message.text.includes('parked-prime-report')
    );
    const bDelivered = (await readRecentEvents(bSession!.id, 50, { kinds: ['agent_message'] })).filter(
      (event) => event.kind === 'agent_message' && event.delivery === 'delivered' && event.message.text.includes('parked-prime-report')
    );
    expect(aDelivered).toHaveLength(1);
    expect(bDelivered).toHaveLength(0);
  });

  it('makes a pending context-ceiling authority change durable before status publishes it', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'sleep before the late context measurement');
    expect(releaseQuiescentRun()).toBe(true);

    // Simulate the exact authority edge measureSleepingWorkers can discover from the durable
    // worker session: the parked chat is now over 400k and therefore no longer revivable. Leave
    // that critical revision pending, then prove the read-only status path itself drains it.
    noteAgentContextTokens('c-worker-1', WORKER_CONTEXT_CEILING_TOKENS);
    let written: ReturnType<typeof snapshotSwarm> | undefined;
    onSwarmPersistNow(async (snapshot) => {
      written = snapshot;
    });

    const text = await asChat(PRIME_CHAT, 'status');
    expect(text).toMatch(/worker-1.*finished \(not reusable\)/s);
    expect(text).not.toContain('REUSE FIRST: worker-1');
    const persistedWorker = written?.dormantRuns
      ?.flatMap((history) => history.agents)
      .find((entry) => entry.info.id === 'worker-1' && entry.info.conversationId === 'c-worker-1');
    expect(persistedWorker?.info).toMatchObject({
      state: 'finished',
      revivable: false,
      contextTokens: WORKER_CONTEXT_CEILING_TOKENS
    });
  });

  it('refuses a control call it cannot place at all, and says where to look', async () => {
    startSwarm(1);
    // No page evidence: this call could have come from anywhere, so it is not treated as a
    // stranger and it is certainly not given a credential to carry instead.
    const text = await agents('status');
    expect(text).toContain('WORKER_IDENTITY_LOST');
    expect(text).toMatch(/extension/i);
    expect(text).not.toContain('worker-1');
  });

  it('uses the inbound HTTP request id instead of stealing a worker’s earlier agents evidence', async () => {
    startSwarm(1);
    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
    const now = Date.now();

    // The worker has an unclaimed agents request visible first. Before the HTTP-id hardening,
    // callerNow() saw this while the prime page was one poll late and authenticated the prime
    // call as worker-1, producing the live "An agent cannot message itself" failure.
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: now, turnId: 'worker-stale' },
      {
        kind: 'tool_evidence',
        time: now,
        turnId: 'worker-stale',
        calls: [
          {
            messageId: 'worker-stale-agents',
            tool: 'agents',
            order: 0,
            answered: false,
            requestId: 'wfr_worker_stale',
            createTime: now / 1000
          }
        ]
      }
    ]);

    const pending = agentsWithRequestId('wfr_prime_current', 'message', {
      to: 'worker-1',
      text: 'prime correction'
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await recordChatObservations(PRIME_CHAT, [
      { kind: 'turn_start', time: now + 80, turnId: 'prime-current' },
      {
        kind: 'tool_evidence',
        time: now + 80,
        turnId: 'prime-current',
        calls: [
          {
            messageId: 'prime-current-agents',
            tool: 'agents',
            order: 0,
            answered: false,
            requestId: 'wfr_prime_current',
            createTime: (now + 80) / 1000
          }
        ]
      }
    ]);

    const text = await pending;
    expect(text).toContain('Queued for worker-1');
    expect(text).not.toContain('cannot message itself');
    expect(pendingCount('worker-1')).toBe(1);
  });

  it('publishes no message when its durable acceptance barrier fails, and a retry queues exactly one', async () => {
    startSwarm(1);
    const snapshots: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => snapshots.push(snapshotSwarm()));
    let fail = true;
    onSwarmPersistNow(async () => {
      if (fail) {
        fail = false;
        throw new Error('injected disk barrier failure');
      }
    });

    const failed = await asChat(PRIME_CHAT, 'message', { to: 'worker-1', text: 'check the parser' });
    expect(failed).toMatch(/durable (?:acceptance )?barrier|nothing was queued/i);
    // The staged queue entry was never visible to the worker while the write was in flight,
    // and rollback removed it before the failed call returned.
    expect(pendingCount('worker-1')).toBe(0);
    expect(offerMessages('worker-1')).toEqual([]);
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((entry) => entry.id === 'worker-1')).toMatchObject({ pending: 0 });
    const afterFailure = snapshotSwarm();
    expect(afterFailure).not.toBeNull();
    expect(afterFailure?.agents.find((entry) => entry.info.id === 'worker-1')?.queue ?? []).toEqual([]);
    // rollback is itself a critical mutation and therefore emits a newer safe snapshot. This
    // supersedes durable.ts's retained failed generation instead of letting it resurrect the
    // rejected message later.
    // The injected failure can now be consumed by the earlier context/revival measurement
    // barrier, before message staging exists at all. In that case no rollback snapshot is
    // necessary. If any debounced snapshots were published, none may contain the rejected row.
    expect(
      snapshots.every(
        (snapshot) => snapshot?.agents.find((entry) => entry.info.id === 'worker-1')?.queue.length !== 1
      )
    ).toBe(true);

    const retried = await asChat(PRIME_CHAT, 'message', { to: 'worker-1', text: 'check the parser' });
    expect(retried).toContain('Queued for worker-1');
    expect(pendingCount('worker-1')).toBe(1);
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['check the parser']);
  });

  it('publishes no worker finish or prime report when its durable acceptance barrier fails', async () => {
    startSwarm(1);
    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
    let fail = true;
    onSwarmPersistNow(async () => {
      if (fail) {
        fail = false;
        throw new Error('injected finish durability failure');
      }
    });

    const failed = await asChat('c-worker-1', 'finish', { result: 'finished the audit' });
    expect(failed).toMatch(/durable acceptance barrier|nothing was published|finish durability failure/i);
    // Old finish mutated the worker and queued its report before awaiting the disk barrier, so
    // the worker became terminal and a concurrent prime call could consume a result whose own
    // caller was being told to retry. A failed acceptance must leave no live trace instead.
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(offerMessages(PRIME_ID)).toEqual([]);

    const retried = await asChat('c-worker-1', 'finish', { result: 'finished the audit' });
    expect(retried).toMatch(/reported and is now asleep/i);
    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(1);
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
  });

  it('carries a worker through message and finish on its conversation alone', async () => {
    startSwarm(1);
    // The extension reports the chat it opened, exactly as it does in production. That is
    // the whole of the worker's startup: no join, no key, nothing typed by the model.
    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);

    const sent = await asChat('c-worker-1', 'message', { to: PRIME_ID, text: 'the parser is the problem' });
    expect(sent).toContain('Queued for prime');
    expect(pendingCount(PRIME_ID)).toBe(1);

    const finished = await asChat('c-worker-1', 'finish', { result: 'fixed the parser' });
    expect(finished).toMatch(/reported and is now asleep/i);
    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
  });

  it('does not tell the prime a worker missed a message that the finish call itself confirms', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    sendMessage(prime, 'worker-1', 'include the parser edge case in your final result');

    // This result offers the instruction. It stays pending until the worker's *next* exact
    // call, because that next call is the broker's evidence that this result reached ChatGPT.
    const offered = await asChat('c-worker-1', 'status');
    expect(offered).toContain('include the parser edge case');
    expect(pendingCount('worker-1')).toBe(1);

    // The next call happens to be finish. Kernel acknowledgement runs after the handler so the
    // old finish planner still saw the offered row as unacked and wrote a false warning into the
    // final report, even though this exact call immediately marks that same row delivered.
    await asChat('c-worker-1', 'finish', { result: 'parser edge case included' });
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.pending).toBe(0);
    const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
      message.text.includes('[worker-1 reported]')
    );
    expect(report?.text).toContain('parser edge case included');
    expect(report?.text).not.toContain('ended without ever confirming');
  });

  it('tells the prime how much worker capacity the report just freed, and that the worker is reusable', async () => {
    // A worker that reports is capacity coming back, and the prime is the only party that can
    // spend it. The final report used to end at the result, so "finished" read as an ending
    // and remaining work sat unspawned. The count is what makes it actionable: it has to be
    // the slots free *after* this worker stops, not the whole limit. And the slot is not the
    // only thing coming back — the worker itself is, in the chat it already has.
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    bindConversation('worker-2', 'c-worker-2');

    const workerResult = await asChat('c-worker-1', 'finish', { result: 'first half done' });
    expect(workerResult).toContain('remains reusable');
    expect(workerResult).toContain('wake this same chat with agents action=message before spawning a replacement');
    const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
      message.text.includes('[worker-1 reported]')
    );
    // worker-2 is still live against a limit of 3, so two slots are free — not three.
    expect(report?.text).toContain('2 of 3 worker slots are free');
    expect(report?.text).toContain('is sleeping, not gone');
    expect(report?.text).toContain('reuse it first with agents action=message');
    expect(report?.text).toContain('action=spawn only when no sleeping worker is suitable');
    expect(report?.text).not.toContain('cannot be reused');

    const status = await asChat(PRIME_CHAT, 'status');
    expect(status).toContain('worker-1  worker  sleeping (reusable; wake with action=message)');
    expect(status).toContain('REUSE FIRST: worker-1');
    expect(status).toContain('For related follow-up work, do this before action=spawn');

    // With the last worker asleep the whole limit is free, and the singular reads correctly.
    await asChat('c-worker-2', 'finish', { result: 'second half done' });
    const last = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
      message.text.includes('[worker-2 reported]')
    );
    expect(last?.text).toContain('3 of 3 worker slots are free');
  });

  it('tells the prime a worker is gone for good only once its own chat is full', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    fillContext('c-worker-1');

    const workerResult = await asChat('c-worker-1', 'finish', { result: 'all of it done' });
    expect(workerResult).toContain('reached its context limit');
    expect(workerResult).not.toContain('remains reusable');
    const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
      message.text.includes('[worker-1 finished]')
    );
    expect(report?.text).toContain('context limit');
    expect(report?.text).toContain('Spawn a new worker');
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.revivable).toBe(false);
  });

  it('cannot be spoofed by naming an agent in the arguments', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    const spoofed = await asChat('c-outsider', 'message', { agent: 'worker-1', to: PRIME_ID, text: 'spoof' });
    // The live schema now rejects the retired `agent` field before broker identity runs. That
    // is stronger than the old AGENTS_BUSY path: caller-controlled identity is not even a
    // syntactically valid request anymore. Keep the broker invariant below as the real outcome.
    expect(spoofed).toMatch(/input validation|unrecognized key|AGENTS_BUSY|unknown/i);
    expect(pendingCount(PRIME_ID)).toBe(0);
  });

  it('pushes waiting messages onto a worker result and acknowledges them on the next call', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');

    sendMessage(prime, 'worker-1', 'stop and check the parser first');
    const withMessage = await asChat('c-worker-1', 'status');
    expect(withMessage).toContain('stop and check the parser first');

    // The next placed call is what retires it, so a lost result is re-offered.
    const after = await asChat('c-worker-1', 'status');
    expect(after).not.toContain('stop and check the parser first');
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('does not let an MCP call already in flight across a browser revival ACK consume or repeat the wake text', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    finishAgent({ conversationId: 'c-worker-1' }, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'wake text belongs to the browser user turn' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);

    // Re-open this test's MCP endpoint with one real command tool so the handler can remain in
    // flight while the browser ACK lands. The exact request-id evidence is recorded *before*
    // the request, which is also a real ordering supported by ChatGPT's connector renderer.
    await endpoint.stop();
    endpoint = await startMcpServer(() => ({
      roots: [{ name: 'probe', path: dir }],
      caps: { ...DEFAULT_CAPABILITIES, command: true },
      readOnly: false,
      sessionTools: false,
      agentTools: true
    }));
    const requestId = `wfr_exec_held_${++evidenceSeq}`;
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: Date.now(), turnId: `t-held-${evidenceSeq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-held-${evidenceSeq}`,
        calls: [{ messageId: `m-held-${evidenceSeq}`, tool: 'exec_command', order: 0, answered: false, requestId }]
      }
    ]);

    const started = Date.now();
    const shell =
      process.platform === 'win32'
        ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : '/bin/sh';
    const heldCommand =
      process.platform === 'win32'
        ? "Start-Sleep -Milliseconds 750; Write-Output 'held-call-done'"
        : "sleep 1; printf '%s\\n' held-call-done";
    const pending = post(
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: {
          name: 'exec_command',
          arguments: {
            cmd: heldCommand,
            workdir: dir,
            shell,
            yield_time_ms: 30_000
          }
        }
      },
      { 'x-request-id': `${requestId}/relay` }
    );
    await waitForRunningToolCall();
    expect(runningToolCalls('c-worker-1')).toBeGreaterThan(0);

    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const offeredAt = snapshotSwarm()!.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;
    expect(offeredAt).toBeGreaterThanOrEqual(started);

    const reply = await pending;
    const text = ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
    expect(text).toContain('held-call-done');
    expect(text).not.toContain('wake text belongs to the browser user turn');
    // This call began before the browser offered the real user message, so completing later is
    // not evidence that it saw that message. The row remains pending but is non-reofferable.
    expect(pendingCount('worker-1')).toBe(1);
    expect(offerMessages('worker-1')).toEqual([]);

    // The next authenticated call really did begin after the user-message delivery and may
    // retire it. It still must not repeat those words through its own result.
    const later = await asChat('c-worker-1', 'status');
    expect(later).not.toContain('wake text belongs to the browser user turn');
    expect(pendingCount('worker-1')).toBe(0);
  }, 45_000);

  it('keeps a terminal worker tombstone only for finish retry and re-offers the lost finish inbox', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');
    sendMessage(prime, 'worker-1', 'check the parser before you stop');
    // A tombstone is only ever a worker that ended for good; anything else sleeps and is
    // welcome back on its own next call.
    fillContext('c-worker-1');

    // The message is first offered on the finish result. If that result is lost, another
    // finish call is not evidence that the worker saw it and must not ACK it.
    const first = await asChat('c-worker-1', 'finish', { result: 'done' });
    expect(first).toContain('check the parser before you stop');
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.pending).toBe(1);

    const retry = await asChat('c-worker-1', 'finish', { result: 'done, retry after lost result' });
    expect(retry).toMatch(/already finished|already.*done/i);
    expect(retry).toContain('check the parser before you stop');
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.pending).toBe(1);

    // The tombstone is not general membership. The same terminal chat still cannot use the
    // ordinary agents surface after it has finished.
    const status = await asChat('c-worker-1', 'status');
    expect(status).toMatch(/WORKER_ENDED|AGENTS_BUSY/);
  });

  it('enforces worker-to-worker refusal over the wire', async () => {
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    bindConversation('worker-2', 'c-worker-2');
    // This regression is about the worker-to-worker policy, not the separate late page-evidence
    // window exercised by asChat(). Give the request its exact browser mate before HTTP so a slow
    // hosted runner cannot turn an unrelated correlation race into WORKER_IDENTITY_LOST.
    const seq = ++evidenceSeq;
    const requestId = `wfr_agents_worker_policy_${seq}`;
    await recordChatObservations('c-worker-1', [
      { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-${seq}`,
        calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
      }
    ]);
    const refused = await agentsWithRequestId(requestId, 'message', { to: 'worker-2', text: 'psst' });
    expect(refused).toMatch(/prime/i);
    expect(pendingCount('worker-2')).toBe(0);
  });

  it('messages several workers in one call, on one identity resolution', async () => {
    startSwarm(2);
    bindConversation('worker-1', 'c-worker-1');
    bindConversation('worker-2', 'c-worker-2');

    const text = await asChat(PRIME_CHAT, 'message', {
      messages: [
        { to: 'worker-1', text: 'ignore the UI' },
        { to: 'worker-2', text: 'check the README too' }
      ]
    });

    expect(text).toContain('worker-1');
    expect(text).toContain('worker-2');
    expect(pendingCount('worker-1')).toBe(1);
    expect(pendingCount('worker-2')).toBe(1);
  });

  it('refuses a message call that spells the same operation both ways at once', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');

    const text = await asChat(PRIME_CHAT, 'message', {
      to: 'worker-1',
      text: 'one way',
      messages: [{ to: 'worker-1', text: 'the other way' }]
    });

    expect(text).toMatch(/either to\+text or messages/i);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('carries the run and every agent in machine-readable form beside the prose', async () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-worker-1');

    const structured = await structuredAsChat(PRIME_CHAT, 'status');
    expect(structured.action).toBe('status');
    expect(structured.self).toBe(PRIME_ID);
    expect(structured.run_id).toBeTypeOf('string');
    const worker = (structured.agents as Array<Record<string, unknown>>).find((agent) => agent.id === 'worker-1');
    expect(worker).toMatchObject({ id: 'worker-1', role: 'worker', state: 'active' });
  });
});
