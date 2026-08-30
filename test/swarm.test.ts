/**
 * Who a caller is, in the rebuilt broker.
 *
 * Identity here is a binding and only ever a binding: a chat becomes the prime by spawning
 * from its own proven conversation, and a worker is the chat the app opened for its slot,
 * bound and started by the extension's report before the model in it has said anything. No
 * agent holds a credential, so there is nothing here about codes or keys on ordinary calls —
 * the adversarial cases are the ones where something *claims* an identity it was not given.
 *
 * `join` is the one exception, and these tests pin down what separates recovery from
 * impersonation: it may install a binding that never arrived, and it may never move one that
 * did.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  AgentsBusyError,
  IdentityLostError,
  PRIME_ID,
  agentConversation,
  agentForCaller,
  agentForConversation,
  bindConversation,
  finishAgent,
  identify,
  pendingWorkerSpawns,
  resetAgentsForTests,
  sendMessage,
  sendMessages,
  spawn,
  swarmState
} = await import('../src/main/agents.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const PRIME_CHAT = 'chat-prime';

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-swarm-');
  initConfigPath(dir);
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: true, maxWorkers: 3 } });
});

afterEach(async () => {
  resetAgentsForTests();
  await removeTempDir(dir).catch(() => undefined);
});

beforeEach(() => {
  resetAgentsForTests();
});

/** A run with two workers, neither bound to a chat yet. */
function startRun(): [string, string] {
  const result = spawn({
    workers: [{ task: 'read the tests' }, { task: 'read the docs' }],
    caller: { conversationId: PRIME_CHAT }
  });
  const [first, second] = result.created.map((info) => info.id);
  if (!first || !second) throw new Error('spawn did not create the two workers it was asked for');
  return [first, second];
}

describe('binding a worker to its chat', () => {
  it('starts the worker: binding is the lifecycle transition, not a later join', () => {
    const [first] = startRun();
    expect(identifyState(first)).toBe('invited');
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toContain(first);

    expect(bindConversation(first, 'chat-1')).toBe(true);

    // Active before the model in that chat has done anything at all — which is the whole
    // invariant: an app-created worker chat is already a worker.
    expect(identifyState(first)).toBe('active');
    expect(identify({ conversationId: 'chat-1' }).activatedAt).toBeTypeOf('number');
    // And the spawn is no longer pending, so the bridge retires its command rather than
    // holding it open waiting for a join that is never coming.
    expect(pendingWorkerSpawns().map((worker) => worker.id)).not.toContain(first);
  });

  it('binds once and refuses to move', () => {
    const [first] = startRun();

    expect(bindConversation(first, 'chat-1')).toBe(true);
    // A second report naming a different chat is a mistake or someone else's tab. Honouring
    // it would point the worker's messages at a chat that is not doing the work.
    expect(bindConversation(first, 'chat-2')).toBe(false);
    expect(agentConversation(first)).toBe('chat-1');
    // Re-reporting the same chat is a no-op, not a failure.
    expect(bindConversation(first, 'chat-1')).toBe(true);
  });

  it('refuses a chat that another agent already holds', () => {
    const [first, second] = startRun();
    bindConversation(first, 'chat-1');

    expect(bindConversation(second, 'chat-1')).toBe(false);
    expect(bindConversation(second, PRIME_CHAT)).toBe(false);
    expect(agentConversation(second)).toBeNull();
    expect(agentForConversation('chat-1')).toBe(first);
    expect(agentForConversation(PRIME_CHAT)).toBe(PRIME_ID);
  });

  it('will not bind a worker that has ended', () => {
    const [first] = startRun();
    bindConversation(first, 'chat-1');
    finishAgent({ conversationId: 'chat-1' }, 'done');

    expect(bindConversation(first, 'chat-9')).toBe(false);
    expect(agentConversation(first)).toBe('chat-1');
  });
});

describe('an ordinary call from a worker', () => {
  it('routes by conversation, with nothing carried by the caller', () => {
    const [first, second] = startRun();
    bindConversation(first, 'chat-1');
    bindConversation(second, 'chat-2');

    expect(agentForCaller({ conversationId: 'chat-1' })).toBe(first);
    expect(agentForCaller({ conversationId: 'chat-2' })).toBe(second);
    expect(agentForCaller({ conversationId: PRIME_CHAT })).toBe(PRIME_ID);
    // The worker can act at once: no join, no key, and its messages route from the start.
    expect(sendMessage({ conversationId: 'chat-1' }, 'prime', 'starting').from).toBe(first);
  });

  it('gives an unplaceable call no agent, and does not refuse it', () => {
    const [first] = startRun();
    bindConversation(first, 'chat-1');

    // A phone, an unrelated chat, a call the page never named — none of them are worker
    // impersonation, and none of them may be filed under whichever agent was busiest.
    expect(agentForCaller({})).toBeNull();
    expect(agentForCaller({ conversationId: null })).toBeNull();
    expect(agentForCaller({ conversationId: 'chat-elsewhere' })).toBeNull();
  });

  it('refuses a control call it cannot place, by name', () => {
    startRun();

    // Two different failures with two different answers. A stranger this app *can* identify
    // learns only that agents are busy; a call it cannot place at all is told its identity
    // was lost, which is the thing recovery is documented against.
    expect(() => identify({ conversationId: 'chat-stranger' })).toThrow(AgentsBusyError);
    expect(() => identify({ conversationId: 'chat-stranger' })).toThrow(/AGENTS_BUSY/);
    expect(() => identify({})).toThrow(IdentityLostError);
    expect(() => identify({})).toThrow(/WORKER_IDENTITY_LOST/);
  });

  it('will not let a stranger send a message as a worker', () => {
    const [first] = startRun();
    bindConversation(first, 'chat-1');

    expect(() => sendMessage({ conversationId: 'chat-elsewhere' }, 'prime', 'hi')).toThrow(AgentsBusyError);
    expect(() => sendMessage({}, 'prime', 'hi')).toThrow(IdentityLostError);
  });
});

describe('the context every worker in a spawn shares', () => {
  it('puts the shared context in front of each task, labelled, and leaves the tasks alone', () => {
    const result = spawn({
      workers: [{ label: 'Security', task: 'audit attribution' }, { label: 'Tests', task: 'find the gaps' }],
      context: 'Work in C:\\repo. Follow AGENTS.md. Do not commit.',
      caller: { conversationId: PRIME_CHAT }
    });

    // Composed once by the app, so the prime writes the standing instructions a single time
    // and every worker still opens with them.
    for (const info of result.created) {
      expect(info.task).toContain('Work in C:\\repo. Follow AGENTS.md. Do not commit.');
      expect(info.task).toContain('Your task:');
    }
    expect(result.created[0]!.task).toContain('audit attribution');
    expect(result.created[0]!.task).not.toContain('find the gaps');
    // And the composed brief is what the browser is asked to type, not a second field that
    // could be delivered apart from the task.
    const owed = pendingWorkerSpawns();
    expect(owed[0]!.task).toBe(result.created[0]!.task);
  });

  it('leaves the task exactly as written when there is no shared context', () => {
    const result = spawn({
      workers: [{ task: 'audit attribution' }],
      caller: { conversationId: PRIME_CHAT }
    });

    expect(result.created[0]!.task).toBe('audit attribution');
  });

  it('refuses a shared context longer than the limit, and creates nothing', () => {
    expect(() =>
      spawn({
        workers: [{ task: 'audit attribution' }],
        context: 'x'.repeat(4001),
        caller: { conversationId: PRIME_CHAT }
      })
    ).toThrow(/shared context is too long/);
    expect(swarmState().running).toBe(false);
  });
});

describe('sending several messages in one call', () => {
  it('delivers the whole batch, in the order written', () => {
    const [first, second] = startRun();
    bindConversation(first, 'chat-1');
    bindConversation(second, 'chat-2');

    const sent = sendMessages({ conversationId: PRIME_CHAT }, [
      { to: first, text: 'ignore the UI' },
      { to: second, text: 'check the README too' },
      { to: first, text: 'and skip the fixtures' }
    ]);

    expect(sent.map((message) => message.to)).toEqual([first, second, first]);
    expect(identify({ conversationId: 'chat-1' }).pending).toBe(2);
    expect(identify({ conversationId: 'chat-2' }).pending).toBe(1);
  });

  it('delivers nothing at all when one message in the batch cannot be delivered', () => {
    const [first] = startRun();
    bindConversation(first, 'chat-1');

    // The whole point of batching is that a prime redirecting its run cannot end up with
    // two of its three messages sent and no way to tell which.
    expect(() =>
      sendMessages({ conversationId: PRIME_CHAT }, [
        { to: first, text: 'ignore the UI' },
        { to: 'worker-nobody', text: 'check the README too' }
      ])
    ).toThrow(/Unknown agent/);
    expect(identify({ conversationId: 'chat-1' }).pending).toBe(0);
  });

  it('enforces the star topology across the batch, not just on the first message', () => {
    const [first, second] = startRun();
    bindConversation(first, 'chat-1');
    bindConversation(second, 'chat-2');

    expect(() =>
      sendMessages({ conversationId: 'chat-1' }, [
        { to: 'prime', text: 'found something' },
        { to: second, text: 'let us agree a plan' }
      ])
    ).toThrow(/only message the prime/);
    expect(identify({ conversationId: PRIME_CHAT }).pending).toBe(0);
  });

  it('is the same operation as a single message', () => {
    const [first] = startRun();
    bindConversation(first, 'chat-1');

    const one = sendMessage({ conversationId: PRIME_CHAT }, first, 'ignore the UI');
    expect(one.to).toBe(first);
    expect(identify({ conversationId: 'chat-1' }).pending).toBe(1);
  });
});

/** The state of a worker, read the way any other caller would have to read it. */
function identifyState(id: string): string {
  const conversation = agentConversation(id);
  if (conversation) return identify({ conversationId: conversation }).state;
  const pending = pendingWorkerSpawns().find((worker) => worker.id === id);
  return pending ? 'invited' : 'gone';
}
