import { describe, expect, it } from 'vitest';
import {
  emptyEvidence,
  inFlightToolCalls,
  runningToolActivity,
  runningToolCalls,
  runningToolProgress,
  setRequestOwner,
  settlingToolCalls,
  trackInFlight,
  type CallContext
} from '../src/main/mcp/call-context.js';

function callFrom(conversationId: string | null): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId: null, conversationId },
    outcome: null,
    evidence: emptyEvidence()
  };
}

/** Runs `fn` while a call attributed to `conversationId` is in flight. */
async function whileRunning(context: CallContext, fn: () => void): Promise<void> {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = trackInFlight(context, async () => {
    await held;
  });
  fn();
  release();
  await call;
}

import { summarizeRunningCall } from '../src/main/session/summarize.js';

describe('what a chat’s calls are doing', () => {
  it('names a running call from its arguments, in the present tense', () => {
    expect(summarizeRunningCall('exec_command', { cmd: 'npm test' }, emptyEvidence())).toEqual({ title: 'Running npm test', kind: 'run' });
    expect(summarizeRunningCall('read', { paths: ['/workspace/src/x.ts'] }, emptyEvidence())).toEqual({ title: expect.stringMatching(/^Reading .*x\.ts$/), kind: 'read' });
    expect(summarizeRunningCall('some_new_tool', {}, emptyEvidence())).toEqual({ title: 'Running some_new_tool', kind: 'other' });
  });

  it('lists only the calls proven to belong to the asking chat', async () => {
    const own = { ...callFrom('conversation-a'), activity: { title: 'Running npm test', kind: 'run' as const } };
    const other = { ...callFrom('conversation-b'), activity: { title: 'Reading secret.txt', kind: 'read' as const } };
    const unproven = { ...callFrom(null), activity: { title: 'Editing x.ts', kind: 'edit' as const } };
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const calls = [other, unproven, own].map(call => trackInFlight(call, () => held));
    expect(runningToolActivity(['conversation-a'])).toEqual([{ title: 'Running npm test', kind: 'run', since: own.startedAt }]);
    release();
    await Promise.all(calls);
    expect(runningToolActivity(['conversation-a'])).toEqual([]);
  });

  it('counts and names a running call by one ownership rule: the page’s exact proof of its request', async () => {
    // Calls are placed only after their handler ran, so a running call names no chat yet. What the
    // caption names and what counts as the chat's running work must be the same calls.
    const call = (requestId: string | null) => ({ ...callFrom(null), activity: { title: 'Running npm test', kind: 'run' as const },
      caller: { transportKey: null, requestId, conversationId: null } });
    const proven = call('req-a'), elsewhere = call('req-b'), unknown = call('req-unknown'), none = call(null);
    const owners: Record<string, string> = { 'req-a': 'conversation-a', 'req-b': 'conversation-b' };
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const calls = [proven, elsewhere, unknown, none].map(entry => trackInFlight(entry, () => held));
    try {
      // No proof installed: neither sees an unplaced call.
      expect(runningToolActivity(['conversation-a'])).toEqual([]);
      expect(runningToolProgress('conversation-a')).toBeNull();
      setRequestOwner(id => owners[id] ?? null);
      expect(runningToolActivity(['conversation-a'])).toEqual([{ title: 'Running npm test', kind: 'run', since: proven.startedAt }]);
      expect(runningToolProgress('conversation-a')).toEqual({ count: 1, since: proven.startedAt });
      expect(runningToolProgress('conversation-b')).toEqual({ count: 1, since: elsewhere.startedAt });
      expect(runningToolProgress('conversation-c')).toBeNull();
    } finally {
      setRequestOwner(() => null);
      release();
      await Promise.all(calls);
    }
  });
});

describe('local calls still running', () => {
  it('does not let one chat’s work hold another chat busy', async () => {
    // The compaction barrier waits for this to reach zero before it submits a settled brief.
    // A swarm runs every chat through this one process, so a global count meant a worker's
    // long build kept the prime's finished compaction waiting until the watch expired and
    // aborted it — blocked by work the prime has nothing to do with and cannot see.
    const worker = callFrom('conversation-b');
    await whileRunning(worker, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(0);
      expect(inFlightToolCalls('conversation-b')).toBe(1);
      expect(runningToolCalls('conversation-b')).toBe(1);
      expect(settlingToolCalls('conversation-b')).toBe(0);
    });
    expect(inFlightToolCalls('conversation-b')).toBe(0);
  });

  it('still holds a chat busy for its own call', async () => {
    // The other half, and the reason the barrier exists: a handoff written while this chat's
    // own edit is mid-flight describes a machine that has changed by the time it is read.
    const own = callFrom('conversation-a');
    await whileRunning(own, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(1);
    });
    expect(inFlightToolCalls('conversation-a')).toBe(0);
  });

  it('charges a call whose chat is not yet known to every chat', async () => {
    // Attribution is proven from page evidence and can still be pending. Until it lands the
    // call could belong to the chat that is asking, so it counts against all of them — the
    // same conservative answer the global count gave, kept for exactly the unproven case.
    const unknown = callFrom(null);
    await whileRunning(unknown, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(1);
      expect(inFlightToolCalls('conversation-b')).toBe(1);
      expect(inFlightToolCalls(null)).toBe(1);
      expect(runningToolCalls('conversation-a')).toBe(1);
      expect(settlingToolCalls('conversation-a')).toBe(0);
    });
  });

  it('follows a call whose chat is identified part-way through it', async () => {
    // trackInFlight holds the context object, not a copy of the id it had at the start, so
    // the moment the caller is proven the count moves with it.
    const late = callFrom(null);
    await whileRunning(late, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(1);
      late.caller.conversationId = 'conversation-b';
      expect(inFlightToolCalls('conversation-a')).toBe(0);
      expect(inFlightToolCalls('conversation-b')).toBe(1);
    });
  });
});
