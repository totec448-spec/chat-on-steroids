import { afterEach, expect, it } from 'vitest';
import { noteCallReleased, resetReleasedCallsForTests, sentResults, trackInFlight, type CallContext } from '../src/main/mcp/call-context.js';

afterEach(() => resetReleasedCallsForTests());

const call = (conversationId: string | null, startedAt: number, completedAt: number | null, failed = false): CallContext => ({
  publication: { completedAt, failed }, startedAt, transportKey: null, agent: null, outcome: null,
  caller: { transportKey: null, requestId: null, conversationId }
} as unknown as CallContext);

it('counts only this chat\'s results sent at least the grace ago, since the turn began', () => {
  noteCallReleased(call('chat-a', 1_000, 2_000), 2_000);
  noteCallReleased(call('chat-a', 3_000, 4_000), 4_000);
  noteCallReleased(call('chat-b', 3_000, 4_000), 4_000);
  noteCallReleased(call('chat-a', 500, 600), 4_000);
  expect(sentResults('chat-a', 1_000, 5_000, 9_000)).toEqual({ count: 2, settled: true });
  // The newer result is still within the grace.
  expect(sentResults('chat-a', 1_000, 5_000, 8_999)).toEqual({ count: 1, settled: false });
});

it('is not settled while a result is unsent, failed to send, or a call still runs', async () => {
  noteCallReleased(call('chat-a', 1_000, null), 1_000);
  expect(sentResults('chat-a', 0, 5_000, 100_000)).toEqual({ count: 0, settled: false });
  resetReleasedCallsForTests();
  noteCallReleased(call('chat-a', 1_000, 2_000, true), 2_000);
  expect(sentResults('chat-a', 0, 5_000, 100_000)).toEqual({ count: 0, settled: false });
  resetReleasedCallsForTests();
  let release!: () => void;
  const running = trackInFlight(call('chat-a', Date.now(), null), () => new Promise<void>(done => { release = done; }));
  expect(sentResults('chat-a', 0, 5_000)).toEqual({ count: 0, settled: false });
  release(); await running;
  expect(sentResults('chat-a', 0, 5_000)).toEqual({ count: 0, settled: true });
});

it('holds every chat back for a call whose owner is not proven yet, without counting it', () => {
  noteCallReleased(call(null, 1_000, null), 1_000);
  expect(sentResults('chat-a', 0, 5_000, 100_000)).toEqual({ count: 0, settled: false });
  resetReleasedCallsForTests();
  noteCallReleased(call(null, 1_000, 2_000), 2_000);
  expect(sentResults('chat-a', 0, 5_000, 100_000)).toEqual({ count: 0, settled: true });
});

it('forgets results older than half an hour and keeps a bounded number', () => {
  noteCallReleased(call('chat-a', 0, 1_000), 1_000);
  noteCallReleased(call('chat-a', 40 * 60_000, 40 * 60_000 + 1), 40 * 60_000 + 1);
  expect(sentResults('chat-a', 0, 0, 50 * 60_000)).toEqual({ count: 1, settled: true });
  for (let at = 0; at < 600; at++) noteCallReleased(call('chat-b', 50 * 60_000 + at, 50 * 60_000 + at), 50 * 60_000 + at);
  expect(sentResults('chat-b', 0, 0, 51 * 60_000).count).toBe(512);
});
