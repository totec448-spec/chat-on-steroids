import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// #2082 (CodeRabbit on #2087): if writing the app's stopped end fails, the turn must not stay open
// for good. The quiet mark stays and the end is tried again.
const hooks = vi.hoisted(() => ({ failNextAppEnd: false }));
vi.mock('../src/main/session/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/session/store.js')>();
  return {
    ...real,
    appendEvent: async (...args: Parameters<typeof real.appendEvent>) => {
      const [, event] = args;
      if (hooks.failNextAppEnd && event.kind === 'turn_end' && event.source === 'app') {
        hooks.failNextAppEnd = false;
        throw new Error('disk full');
      }
      return real.appendEvent(...args);
    }
  };
});
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSessionStore, readEvents, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { liveConversations, recordChatObservations, recordToolCall, REOPENED_STOP_QUIET_MS, sessionForConversation } = await import('../src/main/session/recorder.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let directory: string;
beforeAll(async () => {
  directory = await makeTempDir('clf-reopened-stop-');
  initConfigPath(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
});
afterAll(async () => { resetSessionStoreForTests(); await removeTempDir(directory); });

const tool = (requestId: string, startedAt = Date.now()) => recordToolCall({
  tool: 'read', args: { paths: ['/project/a.ts'] }, content: [{ type: 'text', text: 'ok' }],
  outcome: 'ok' as const, durationMs: 1, startedAt, requestId
});

it('tries the stopped end again when writing it fails, and then ends the turn', async () => {
  vi.useFakeTimers();
  try {
    const conversationId = 'conv-reopened-stop-retry';
    const request = 'wfr_reopened_stop_retry';
    const sessionId = await sessionForConversation(conversationId);
    const active = () => liveConversations().find((entry) => entry.conversationId === conversationId)?.activeTurnId ?? null;
    const start = Date.now();
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: start, turnId: 'g-retry' },
      { kind: 'tool_evidence', time: start, fiberConversationId: conversationId,
        calls: [{ messageId: 'retry-0', tool: 'read', order: 0, answered: false, requestId: request }] }
    ]);
    await tool(request, start + 10);
    await recordChatObservations(conversationId, [{ kind: 'turn_end', time: start + 20, turnId: 'g-retry', outcome: 'stopped' }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await tool(request, Date.now());
    expect(active()).toBe('g-retry');
    hooks.failNextAppEnd = true;
    await vi.advanceTimersByTimeAsync(REOPENED_STOP_QUIET_MS + 1_000);
    // The write failed: still open, and nothing was recorded.
    expect(hooks.failNextAppEnd).toBe(false);
    expect(active()).toBe('g-retry');
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(active()).toBeNull(), { timeout: 10_000 });
    const ends = (await readEvents(sessionId!, { kinds: ['turn_end'] })).filter((event) => event.kind === 'turn_end' && event.source === 'app');
    expect(ends).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
