/**
 * The Compact & Resume transaction: moving one durable local session from chat A to chat B.
 *
 * Every test here is about the failure half of that move rather than the happy path. The
 * invariant the whole design exists to protect is that a commit either lands completely or
 * leaves the session attached to chat A — never a session on disk in B with its swarm, its
 * workspace or its recorded history still in A. So these drive the races directly: two
 * claimants, a claim arriving mid-commit, a sweep firing mid-commit, an abort mid-commit, a
 * durable write that fails, and a handover deadline crossed while the write is in flight.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8')
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const {
  TRANSFER_TTL_MS,
  beginPrimeTransfer,
  cancelPrimeTransfer,
  commitPrimeTransfer,
  freezePrimeTransfer,
  primeConversation,
  primeConversationGone,
  repairPrimeConversationAfterRecovery,
  resetAgentsForTests,
  spawn,
  swarmRunning,
  thawPrimeTransfer
} = await import('../src/main/agents.js');
const {
  CONTINUATION_TTL_MS,
  abortContinuation,
  attachSummary,
  claimContinuationNow,
  commitContinuation,
  continuationByToken,
  continuationForSession,
  openContinuationNow,
  repairPrimeFromResumeShadow,
  resetContinuationsForTests,
  restoreContinuations,
  setContinuationRecoveryHooks
} = await import('../src/main/session/continuation.js');
const { RESUME_CLAIM_WINDOW_MS, resumeOpeningChat } = await import('../src/main/session/resume-gate.js');
const { briefShortfall } = await import('../src/main/session/handoff.js');
const { createSession, getSession, initSessionStore, resetSessionStoreForTests, sessionsRoot } = await import(
  '../src/main/session/store.js'
);
const store = await import('../src/main/session/store.js');
const { resetRecorderForTests, sessionForConversation } = await import('../src/main/session/recorder.js');
const { resetWorkspaces, setWorkspaceFor, workspaceEntries } = await import('../src/main/workspace.js');
const { makeTempDir, removeTempDir, SAMPLE_BRIEF } = await import('./helpers.js');

let dir: string;

/** The chat this session is attached to right now. */
async function attachedChat(sessionId: string): Promise<string | null> {
  return (await getSession(sessionId))?.conversationId ?? null;
}

/** How many handoffs this session has on disk. One per continuation, ever. */
async function handoffCount(sessionId: string): Promise<number> {
  try {
    return (await fs.readdir(path.join(sessionsRoot(), sessionId, 'handoffs'))).length;
  } catch {
    return 0;
  }
}

const CHAT_A = 'chat-a';
const CHAT_B = 'chat-b';

beforeAll(async () => {
  dir = await makeTempDir('clf-continuation-');
  initConfigPath(dir);
  initSessionStore(dir);
  await saveConfig({ ...defaultConfig(), multiAgent: { enabled: true, maxWorkers: 3 } });
});

afterAll(async () => {
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetContinuationsForTests();
  resetAgentsForTests();
  resetRecorderForTests();
  resetWorkspaces();
  await resetSessionStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A session attached to chat A with its brief already captured, ready to be claimed. */
async function readyContinuation(): Promise<{ sessionId: string; token: string }> {
  const summary = await createSession({ title: 'work', conversationId: CHAT_A });
  const opened = await openContinuationNow(summary.id, CHAT_A);
  await attachSummary(opened.token, SAMPLE_BRIEF);
  return { sessionId: summary.id, token: opened.token };
}

describe('capturing the brief', () => {
  it('answers a repeated capture with the handoff it already wrote', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);

    const first = await attachSummary(opened.token, SAMPLE_BRIEF);
    // The connector loses tool results, so the page reports the same finished generation
    // again. That retry must read as the success it is, not as a failure worth another flow.
    const again = await attachSummary(opened.token, SAMPLE_BRIEF);

    expect(first).not.toBeNull();
    expect(again?.id).toBe(first?.id);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('writes one handoff even when two captures race', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);

    // Both see `awaiting-summary` before either write lands. Without a lock taken before the
    // first await, both would write, and the second brief would silently win.
    const [first, second] = await Promise.all([
      attachSummary(opened.token, SAMPLE_BRIEF),
      attachSummary(opened.token, SAMPLE_BRIEF)
    ]);

    expect(first?.id).toBe(second?.id);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('gives every waiter the same retryable answer when the write fails', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const spy = vi.spyOn(store, 'saveHandoff').mockRejectedValueOnce(new Error('disk full'));

    // The duplicate joins the attempt already in flight. It must not receive a rejected
    // promise for a step that simply has to be done again.
    const both = await Promise.all([
      attachSummary(opened.token, SAMPLE_BRIEF),
      attachSummary(opened.token, SAMPLE_BRIEF)
    ]);
    expect(both).toEqual([null, null]);

    spy.mockRestore();
    expect(await attachSummary(opened.token, SAMPLE_BRIEF)).not.toBeNull();
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('does not publish a handoff whose continuation WAL transition was rejected', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const durable = await import('../src/main/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('continuation state disk full'));

    // The handoff file write succeeds; only the semantic continuation transition fails. A
    // failed compaction must remain invisible as the session's "latest handoff", otherwise a
    // fresh chat can recover a brief this transaction explicitly rejected.
    expect(await attachSummary(opened.token, SAMPLE_BRIEF)).toBeNull();
    expect(continuationForSession(summary.id)?.state).toBe('awaiting-summary');
    expect((await getSession(summary.id))?.lastHandoffId).toBeNull();
  });

  it('repairs a handoff event after a crash between continuation WAL commit and session publication', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const { prepareHandoff } = await import('../src/main/session/handoff.js');
    const prepared = await prepareHandoff({ sessionId: summary.id, text: SAMPLE_BRIEF });
    expect((await getSession(summary.id))?.lastHandoffId).toBeNull();

    // This is the exact durable state after the continuation WAL landed but before the
    // following session handoff event could be appended. Recovery must publish that event
    // once, rather than losing handoff discovery or aborting a semantically committed capture.
    await restoreContinuations({
      version: 1,
      savedAt: Date.now(),
      entries: [
        {
          token: 'recovery-handoff-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: null,
          openedAt: Date.now(),
          state: 'awaiting-chat',
          summary: SAMPLE_BRIEF,
          handoffId: prepared.id,
          claimedBy: null,
          armed: true,
          error: null
        }
      ]
    });

    expect((await getSession(summary.id))?.lastHandoffId).toBe(prepared.id);
    // Idempotent recovery must not append a second handoff event or reorder the timeline.
    await restoreContinuations({
      version: 1,
      savedAt: Date.now(),
      entries: [
        {
          token: 'recovery-handoff-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: null,
          openedAt: Date.now(),
          state: 'awaiting-chat',
          summary: SAMPLE_BRIEF,
          handoffId: prepared.id,
          claimedBy: null,
          armed: true,
          error: null
        }
      ]
    });
    const handoffEvents = (await store.readEvents(summary.id, { kinds: ['handoff'] })).filter(
      (event) => event.kind === 'handoff' && event.handoffId === prepared.id
    );
    expect(handoffEvents).toHaveLength(1);
  });

  it('keeps the first brief when a re-observation differs, and still reports success', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const first = await attachSummary(opened.token, SAMPLE_BRIEF);

    const again = await attachSummary(opened.token, `${SAMPLE_BRIEF}

(re-rendered slightly differently)`);

    expect(again?.id).toBe(first?.id);
    expect(again?.text).toBe(first?.text);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('refuses an empty or interrupted answer and stays in chat A', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);

    expect(await attachSummary(opened.token, '   ')).toBeNull();
    expect(continuationForSession(summary.id)?.state).toBe('awaiting-summary');
    expect(await claimContinuationNow(opened.token, 'tab-1')).toBeNull();
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
  });
});

describe('claiming', () => {
  it('serves one claimant and refuses a second', async () => {
    const { token } = await readyContinuation();

    expect((await claimContinuationNow(token, 'tab-1'))?.summary).toContain(SAMPLE_BRIEF);
    expect(await claimContinuationNow(token, 'tab-2')).toBeNull();
    expect((await claimContinuationNow(token, 'tab-1'))?.summary).toContain(SAMPLE_BRIEF);
  });

  it('does not move the state backwards while a commit is in flight', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    // Hold the durable write open, so the commit is provably mid-flight.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.rebindSession;
    const spy = vi.spyOn(store, 'rebindSession').mockImplementation(async (...args) => {
      await held;
      return real(...args);
    });

    const commit = commitContinuation(token, CHAT_B);
    await Promise.resolve();
    expect(continuationForSession(sessionId)?.state).toBe('committing');

    // The retrying claimant wants its brief; what it must not get is the state put back to
    // `claimed`, which was the one way a second commit could enter behind the first.
    expect((await claimContinuationNow(token, 'tab-1'))?.summary).toContain(SAMPLE_BRIEF);
    expect(continuationForSession(sessionId)?.state).toBe('committing');
    const second = await commitContinuation(token, 'chat-c');
    expect(second).toBe(false);

    release();
    expect(await commit).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });
});

describe('committing', () => {
  it('moves the session, its history and its workspace together', async () => {
    const { sessionId, token } = await readyContinuation();
    const before = await sessionForConversation(CHAT_A);
    expect(before).toBe(sessionId);
    setWorkspaceFor(`chat:${CHAT_A}`, { virtual: '/workspace/project', real: dir });
    await claimContinuationNow(token, 'tab-1');

    expect(await commitContinuation(token, CHAT_B)).toBe(true);

    const moved = await getSession(sessionId);
    expect(moved?.conversationId).toBe(CHAT_B);
    // Same durable session, with chat A kept as lineage rather than replaced.
    expect(moved?.chatIds).toEqual([CHAT_A, CHAT_B]);
    // The context meter is per attached chat, or the next turn would re-compact immediately.
    expect(moved?.contextTokens).toBe(0);
    expect(await sessionForConversation(CHAT_B)).toBe(sessionId);
    expect(workspaceEntries().map((held) => held.key)).toEqual([`chat:${CHAT_B}`]);
  });

  it('refuses a chat B that is not a distinct conversation', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    expect(await commitContinuation(token, '')).toBe(false);
    expect(await commitContinuation(token, CHAT_A)).toBe(false);
    expect(await attachedChat(sessionId)).toBe(CHAT_A);
  });

  it('leaves the session in chat A when the durable write fails, and stays retryable', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');
    const spy = vi.spyOn(store, 'rebindSession').mockResolvedValueOnce(false);

    expect(await commitContinuation(token, CHAT_B)).toBe(false);
    expect(await attachedChat(sessionId)).toBe(CHAT_A);
    expect(continuationForSession(sessionId)?.state).toBe('claimed');
    expect(workspaceEntries()).toEqual([]);

    spy.mockRestore();
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  it('treats a repeated ack as the commit that already landed', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect((await getSession(sessionId))?.chatIds).toEqual([CHAT_A, CHAT_B]);
  });
});

describe('the commit lock', () => {
  /** Runs `body` while the durable write is suspended, then lets the commit finish. */
  async function duringDurableWrite(
    token: string,
    to: string,
    body: () => void | Promise<void>
  ): Promise<boolean> {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.rebindSession;
    vi.spyOn(store, 'rebindSession').mockImplementation(async (...args) => {
      await held;
      return real(...args);
    });
    const commit = commitContinuation(token, to);
    await Promise.resolve();
    await body();
    release();
    return commit;
  }

  it('cannot be aborted once the durable write has started', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    const committed = await duringDurableWrite(token, CHAT_B, () => {
      // An abort here would clear the frozen prime handover under a write that is still
      // going to land — the split this transaction exists to make impossible.
      expect(abortContinuation(token, 'user changed their mind')).toBe(false);
    });

    expect(committed).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  it('is not swept away by a lookup that happens to cross the deadline', async () => {
    vi.useFakeTimers();
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    const committed = await duringDurableWrite(token, CHAT_B, () => {
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS + 1_000);
      // Any passing lookup runs the sweep. It must not expire a commit already in flight.
      continuationForSession(sessionId);
    });

    expect(committed).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });
});

describe('the swarm handover', () => {
  const startSwarm = (conversationId: string): void => {
    spawn({ workers: [{ task: 'read the tests' }], caller: { conversationId } });
  };

  it('moves the prime with the session', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'tab-1');

    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);
    expect(primeConversation()).toBe(CHAT_B);
  });

  it('survives a deadline crossed while the durable write is in flight', async () => {
    vi.useFakeTimers();
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'tab-1');

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.rebindSession;
    vi.spyOn(store, 'rebindSession').mockImplementation(async (...args) => {
      // The handover deadline passes while the disk write is happening. Before the freeze
      // this left the session durably in B with the swarm still bound to A.
      //
      // Moved from the caller into the write itself: out there the jump had to be timed by
      // guessing how many microtasks the preflight takes, and the durable record written
      // before the preflight is a real file write, so one `await Promise.resolve()` landed
      // the jump *before* freezePrimeTransfer instead of after it. That tested plain expiry,
      // which is a different test two cases down.
      vi.setSystemTime(Date.now() + TRANSFER_TTL_MS + 1_000);
      await held;
      return real(...args);
    });
    const commit = commitContinuation(opened.token, CHAT_B);
    await Promise.resolve();
    release();

    expect(await commit).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_B);
    expect(primeConversation()).toBe(CHAT_B);
  });

  it('refuses the whole commit when the prime session has no usable handover', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'tab-1');

    // The handover is gone while the continuation itself is still perfectly live — so the
    // refusal below can only be the swarm preflight, never generic expiry. (In production
    // this is the run ending, or being reset, between the button and the new chat.)
    cancelPrimeTransfer(CHAT_A);
    expect(continuationForSession(summary.id)?.state).toBe('claimed');
    expect(freezePrimeTransfer(CHAT_A)).toBe('unavailable');

    expect(await commitContinuation(opened.token, CHAT_B)).toBe(false);
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
    expect(primeConversation()).toBe(CHAT_A);
    // Refused before anything was written: still claimable, and its error says why.
    expect(continuationForSession(summary.id)?.state).toBe('claimed');
    expect(continuationForSession(summary.id)?.error).toMatch(/handover/);
  });

  it('commits a session that owns no swarm at all', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    expect(freezePrimeTransfer(CHAT_A)).toBe('absent');
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  it('keeps reusable workers attached to the run across an ordinary prime pause and a handover', async () => {
    startSwarm(CHAT_A);
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);

    resetAgentsForTests();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);
  });

  it('does not let a frozen handover expire, and thaws back to an expiring one', () => {
    vi.useFakeTimers();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);

    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    vi.setSystemTime(Date.now() + TRANSFER_TTL_MS * 2);
    // Frozen means committed-to: no deadline of its own, so the move cannot decline.
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(commitPrimeTransfer(CHAT_A, CHAT_B)).toBe(true);
    expect(primeConversation()).toBe(CHAT_B);

    resetAgentsForTests();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);
    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    thawPrimeTransfer(CHAT_A);
    vi.setSystemTime(Date.now() + TRANSFER_TTL_MS + 1_000);
    expect(freezePrimeTransfer(CHAT_A)).toBe('unavailable');
  });

  it('will not hand a swarm to a chat that is not the one being replaced', () => {
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);

    expect(commitPrimeTransfer('someone-else', CHAT_B)).toBe(false);
    expect(primeConversation()).toBe(CHAT_A);
  });

  it('does not revive an already-expired waiting continuation after restart', async () => {
    vi.useFakeTimers();
    const openedAt = Date.now();
    const summary = await createSession({ title: 'expired restore', conversationId: CHAT_A });
    spawn({ workers: [{ task: 'read the tests' }], caller: { conversationId: CHAT_A } });

    vi.setSystemTime(openedAt + CONTINUATION_TTL_MS + 1);
    await restoreContinuations({
      version: 1,
      savedAt: openedAt,
      entries: [
        {
          token: 'expired-wait-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: null,
          openedAt,
          state: 'awaiting-summary',
          summary: '',
          handoffId: null,
          claimedBy: null,
          armed: false,
          error: null
        }
      ]
    });

    // Recovery must not mint a fresh transfer lease for a transaction whose own ten-minute
    // deadline already elapsed. The reusable worker run is independent of that expired
    // continuation, so losing the prime browser view pauses the run rather than destroying it.
    expect(continuationByToken('expired-wait-token')?.state).toBe('aborted');
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);
  });
});

describe('restart lifetime recovery', () => {
  it('does not roll an expired pre-commit record back into a fresh transfer', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const summary = await createSession({ title: 'expired committing restore', conversationId: CHAT_A });
    spawn({ workers: [{ task: 'read the tests' }], caller: { conversationId: CHAT_A } });

    await restoreContinuations({
      version: 1,
      savedAt: now,
      entries: [
        {
          token: 'expired-commit-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: now - CONTINUATION_TTL_MS - 1,
          state: 'committing',
          summary: SAMPLE_BRIEF,
          handoffId: null,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    });

    // The session still being on A proves the durable move never landed. Recovery may not
    // convert that expired intent back to `claimed` and mint a new transfer lifetime.
    expect(continuationByToken('expired-commit-token')?.state).toBe('aborted');
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
  });

  it('keeps a terminal commit replayable during the second TTL window', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const summary = await createSession({ title: 'committed restore', conversationId: CHAT_A });
    expect(await store.rebindSession(summary.id, CHAT_A, CHAT_B)).toBe(true);

    await restoreContinuations({
      version: 1,
      savedAt: now,
      entries: [
        {
          token: 'terminal-replay-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: now - CONTINUATION_TTL_MS - 1,
          state: 'committed',
          summary: SAMPLE_BRIEF,
          handoffId: null,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    });

    expect(await commitContinuation('terminal-replay-token', CHAT_B)).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_B);
  });
});


/**
 * The brief a session is worth moving for.
 *
 * On 2026-08-23 a compaction turn was declared finished 28 characters in, and `TASK\nContinue
 * implementing ` — cut off at an opening backtick — was stored as the whole handoff for a
 * session holding 455 events and 318,422 tokens. It was typed into a replacement chat that
 * had no way to tell it from a complete document, because no receiver has: a brief is prose,
 * and a truncated one is still prose.
 *
 * So the check has to happen before it is stored, and it cannot be a check on meaning. Length
 * against the size of what is being handed over is the one property that separates the two
 * outcomes here — and the direction of the failure is what makes a crude test acceptable. A
 * refused brief costs a second press; an accepted truncated one costs the session.
 */
describe('a brief that cannot be the whole handoff', () => {
  it('refuses nothing at all', () => {
    expect(briefShortfall('', 50_000)).toMatch(/nothing/i);
    expect(briefShortfall('   \n  ', 50_000)).toMatch(/nothing/i);
  });

  it('refuses the twenty-eight characters that started this', () => {
    const cut = 'TASK\nContinue implementing `';
    const refusal = briefShortfall(cut, 318_422);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('28 characters');
  });

  it('refuses a plausible-looking brief that is far too small for the session it carries', () => {
    // Long enough to read as a document, and nowhere near enough to be one. This is the
    // shape a turn cut off mid-way actually produces.
    const partial = `TASK — ${'continue the rewrite. '.repeat(12)}`;
    expect(partial.length).toBeGreaterThan(200);
    expect(briefShortfall(partial, 300_000)).toMatch(/cannot be the whole handoff/i);
    // The same text is a fine brief for a session that has barely started.
    expect(briefShortfall(partial, 900)).toBeNull();
  });

  it('accepts a real one', () => {
    expect(briefShortfall(SAMPLE_BRIEF, 318_422)).toBeNull();
  });
});

/**
 * The 302 milliseconds that lost a session.
 *
 * When a resume opens chat B, two things race to react to B appearing: the recorder, which
 * invents a session for any conversation it has not seen, and the commit, which moves the
 * *existing* session onto B. The recorder won, the commit found its own destination already
 * owned — "the replacement chat already belongs to another local session" — and refused to
 * rebind. The prime role moved to the new chat anyway; the session did not follow it.
 *
 * The gate is one boolean the recorder can ask before inventing anything. These are about
 * when it is armed and, more importantly, when it stops being: an armed gate that nothing
 * clears would make every unrelated new chat wait.
 */
describe('the window in which a replacement chat is expected', () => {
  it('is armed by a claim and cleared by the commit', async () => {
    expect(resumeOpeningChat()).toBe(false);
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(resumeOpeningChat()).toBe(true);

    await commitContinuation(token, CHAT_B);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
    expect(resumeOpeningChat()).toBe(false);
  });

  it('is cleared by an abort as well, so a failed move does not hold new chats up', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(resumeOpeningChat()).toBe(true);
    abortContinuation(token, 'gave up');
    expect(resumeOpeningChat()).toBe(false);
  });

  it('expires on its own when the replacement chat never appears', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(resumeOpeningChat()).toBe(true);
    // A crash between the claim and the commit, or a browser that never opened the tab.
    // Failing to wait costs a visible stub session; waiting forever would stop the app
    // recording new chats at all, so this expires in the safe direction.
    expect(resumeOpeningChat(Date.now() + RESUME_CLAIM_WINDOW_MS + 1)).toBe(false);
    expect(resumeOpeningChat()).toBe(false);
  });

  it('is not armed by a durable claim whose write failed', async () => {
    const { token } = await readyContinuation();
    const durable = await import('../src/main/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));
    await expect(claimContinuationNow(token, CHAT_B)).rejects.toThrow(/disk full/);
    // Nothing was claimed, so nothing may be waited for. Arming before the write is what
    // would have made every unrelated new chat pay the settle window for a claim that does
    // not exist.
    expect(resumeOpeningChat()).toBe(false);
  });

  it('is re-armed for a continuation recovered still holding its claim', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    const snapshot = {
      version: 1 as const,
      savedAt: Date.now(),
      entries: [
        {
          token,
          sessionId,
          from: CHAT_A,
          to: null,
          openedAt: Date.now(),
          state: 'claimed' as const,
          summary: SAMPLE_BRIEF,
          handoffId: continuationForSession(sessionId)?.handoffId ?? null,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    };

    // The restart. The claim that armed the gate happened in a process that is gone, and
    // the replacement chat may be sitting in a tab about to report in — which is exactly
    // the restart most likely to hit the collision this exists to prevent.
    resetContinuationsForTests();
    expect(resumeOpeningChat()).toBe(false);
    await restoreContinuations(snapshot);
    expect(resumeOpeningChat()).toBe(true);
  });

  it('is not re-armed for a continuation that was already finished', async () => {
    const { sessionId, token } = await readyContinuation();
    resetContinuationsForTests();
    await restoreContinuations({
      version: 1 as const,
      savedAt: Date.now(),
      entries: [
        {
          token,
          sessionId,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: Date.now(),
          state: 'aborted' as const,
          summary: SAMPLE_BRIEF,
          handoffId: null,
          claimedBy: CHAT_B,
          armed: true,
          error: 'gave up'
        }
      ]
    });
    expect(resumeOpeningChat()).toBe(false);
  });

  it('is cleared by the test reset, so one case cannot slow the next one down', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(resumeOpeningChat()).toBe(true);
    resetContinuationsForTests();
    expect(resumeOpeningChat()).toBe(false);
  });

  it('lets the exact app-opened shadow chat recover the prime after the historical collision', async () => {
    const from = '81818181-1111-2222-3333-444444444444';
    const to = '82828282-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'prime before broken resume', conversationId: from });
    spawn({ workers: [{ task: 'keep the reusable worker alive' }], caller: { conversationId: from } });
    const opened = await openContinuationNow(source.id, from);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'resume-shadow-owner');

    // The buggy recorder beat the ACK and stamped B as an app-created resume session. The real
    // continuation then refused to overwrite that session and the bridge durably aborted it.
    await createSession({
      title: 'Resumed · prime before broken resume',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    expect(await commitContinuation(opened.token, to)).toBe(false);
    abortContinuation(opened.token, 'the replacement chat already belongs to another local session');
    expect(primeConversation()).toBe(from);

    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(to)).toBe(true);
    expect(primeConversation()).toBe(to);

    // Same-origin-looking data without that exact failed WAL is not takeover authority.
    const stranger = '83838383-1111-2222-3333-444444444444';
    await createSession({
      title: 'unrelated resume-looking chat',
      conversationId: stranger,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    expect(await repairPrimeFromResumeShadow(stranger)).toBe(false);
    expect(primeConversation()).toBe(to);
  });
});
