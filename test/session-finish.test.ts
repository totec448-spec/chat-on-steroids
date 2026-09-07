import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { TaskRequestError } from '../src/main/task-request.js';
const hooks = vi.hoisted(() => ({ caller: { sessionId: '', conversationId: '' }, startedAt: 2000, followup: vi.fn(), enqueue: vi.fn(), hasInput: true, delivered: [] as Array<{ id: string; sessionId: string; text: string; state: string }>, inputListeners: new Set<() => void>() }));
vi.mock('../src/main/session/input.js', () => ({
  hasEligibleToolInput: async () => hooks.hasInput,
  listInputs: async () => hooks.delivered,
  enqueueInput: hooks.enqueue,
  onInputChange: (listener: () => void) => { hooks.inputListeners.add(listener); return () => hooks.inputListeners.delete(listener); }
}));
vi.mock('../src/main/goal.js', async importOriginal => ({ ...await importOriginal<object>(), draftFastFollowup: hooks.followup }));
vi.mock('../src/main/mcp/call-context.js', async (importOriginal) => ({
  ...await importOriginal<object>(), currentCall: () => ({ caller: { ...hooks.caller }, startedAt: hooks.startedAt })
}));
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSessionStore, createSession, getSession, rebindSession, appendEvent, readRecentEvents, flushSessions, resetSessionStoreForTests, observeSessionModel } = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { announceSessionFinish: announceTransport, settleSessionFinishForTests, requestSessionFinishGoal, sessionFinishWaiting, setFinishNotifier, releaseSessionFinish, sessionFinishHeld } = await import('../src/main/session/finish.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
async function announceSessionFinish(sessionId: string, summary: string): Promise<string> {
  const result = await announceTransport(sessionId, summary);
  await settleSessionFinishForTests();
  return result;
}
let directory: string;
let sessionId: string;
const notify = vi.fn();
beforeAll(async () => {
  directory = await makeTempDir('clf-session-finish-');
  initConfigPath(directory); initSessionStore(directory);
});
beforeEach(async () => {
  hooks.hasInput = true; hooks.delivered = [];
  hooks.followup.mockReset().mockResolvedValue('Check the remaining requirement');
  hooks.enqueue.mockReset().mockImplementation(async (input, owner) => ({ ...input, finishOwner: owner, state: 'queued' }));
  notify.mockReset(); setFinishNotifier(notify);
  await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true, finishAction: 'goal' },
    goal: { ...defaultConfig().goal, includeToolCalls: true } });
  const conversationId = randomUUID();
  const session = await createSession({ conversationId, title: 'Finish test' });
  sessionId = session.id;
  hooks.caller = { sessionId, conversationId }; hooks.startedAt = 2000;
  await appendEvent(sessionId, { source: 'extension', kind: 'turn_start', turnId: 'turn-one', time: 1000 });
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  // Switching clocks discards fake timers, but the recorder still owns its pending
  // notification handle. Clear that owner too or later End turn notifications never fire.
  resetRecorderForTests();
});
afterAll(async () => { setFinishNotifier(null); resetSessionStoreForTests(); await removeTempDir(directory); });
describe('session finish turn identity', () => {
  it('keeps one Goal operation through transient retries and queues its eventual result once', async () => {
    let fail!: (error: Error) => void;
    hooks.followup.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await announceTransport(sessionId, 'Ready');
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    vi.useFakeTimers();
    fail(new TaskRequestError('rate_limited: busy', true));
    await vi.advanceTimersByTimeAsync(0);
    await announceTransport(sessionId, 'Still waiting');
    await vi.advanceTimersByTimeAsync(14999);
    expect(hooks.followup).toHaveBeenCalledTimes(1);
    expect(hooks.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await settleSessionFinishForTests();
    expect(hooks.followup).toHaveBeenCalledTimes(2);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(hooks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId, mode: 'auto', text: 'Check the remaining requirement' }),
      { turnId: 'turn-one', periodic: false });
    await announceSessionFinish(sessionId, 'Again');
    expect(hooks.followup).toHaveBeenCalledTimes(2);
  });
  it.each(['new input', 'turn release'])('cancels a pending Goal retry on %s', async reason => {
    let fail!: (error: Error) => void;
    hooks.followup.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await announceTransport(sessionId, 'Ready');
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    vi.useFakeTimers();
    fail(new TaskRequestError('http_503: busy', true));
    await vi.advanceTimersByTimeAsync(0);
    if (reason === 'new input') {
      hooks.delivered.push({ id: 'new-user-work', sessionId, text: 'Changed instructions', state: 'sent' });
      for (const listener of hooks.inputListeners) listener();
    } else await releaseSessionFinish(sessionId, 'turn-one');
    vi.useRealTimers();
    await settleSessionFinishForTests();
    expect(hooks.followup).toHaveBeenCalledTimes(1);
    expect(hooks.enqueue).not.toHaveBeenCalled();
    expect(hooks.inputListeners.size).toBe(0);
  });
  it('uses the armed Astra switch as Loop at finish and suppresses Notify', async () => {
    await observeSessionModel(sessionId, hooks.caller.conversationId, 'gpt-6-pro', Date.now());
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true, finishAction: 'notify' } });
    const { setGoalSwitchNow } = await import('../src/main/goal.js');
    await setGoalSwitchNow(hooks.caller.conversationId, 'goal', true);
    await announceSessionFinish(sessionId, 'Wrapping up');
    expect(hooks.followup.mock.calls.map(call => call[4])).toEqual(['loop']);
    expect(notify).not.toHaveBeenCalled();
    expect(hooks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ mode: 'auto' }), { turnId: 'turn-one', periodic: false });
  });
  it.each(['auto', 'finish', 'after-turn'])('suppresses notices and decisions while %s input remains queued, including future schedules', async mode => {
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true, finishAction: 'notify' } });
    hooks.delivered.push({ id: 'pending', sessionId, text: 'User work', state: 'queued', mode, dueAt: Date.now() + 60000 } as typeof hooks.delivered[number]);
    expect(await announceSessionFinish(sessionId, 'Ready')).toContain('Queued user instructions');
    expect(notify).not.toHaveBeenCalled();
    expect(hooks.followup).not.toHaveBeenCalled();
  });
  it('notifies once with exact turn identity and supports a user-requested Goal in notify mode', async () => {
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true, finishAction: 'notify' } });
    await announceSessionFinish(sessionId, 'Ready');
    await announceSessionFinish(sessionId, 'Again');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Astra is wrapping up', expect.any(String), sessionId, 'turn-one');
    await expect(requestSessionFinishGoal(sessionId, 'turn-one')).rejects.toThrow('expired');
    hooks.hasInput = false;
    const waiting = announceTransport(sessionId, 'Wait for user input');
    await vi.waitFor(() => expect(hooks.inputListeners.size).toBe(1));
    expect(await sessionFinishWaiting(sessionId, 'turn-one', hooks.caller.conversationId)).toBe(true);
    hooks.delivered.push({ id: 'user-priority', sessionId, text: 'First do this', state: 'queued' });
    expect(await sessionFinishWaiting(sessionId, 'turn-one', hooks.caller.conversationId)).toBe(false);
    await expect(requestSessionFinishGoal(sessionId, 'turn-one')).rejects.toThrow('already queued');
    hooks.delivered = [];
    await requestSessionFinishGoal(sessionId, 'turn-one');
    expect(hooks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId }), { turnId: 'turn-one', periodic: false, userRequested: true });
    await releaseSessionFinish(sessionId, 'turn-one');
    await waiting;
    expect(await sessionFinishWaiting(sessionId, 'turn-one', hooks.caller.conversationId)).toBe(false);
    await expect(requestSessionFinishGoal(sessionId, 'turn-one')).rejects.toThrow('expired');
  });
  it('accepts a notification action during its own publication before the transport wait starts', async () => {
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true, finishAction: 'notify' } });
    hooks.hasInput = false;
    let action: Promise<string> | undefined;
    notify.mockImplementationOnce(() => { action = requestSessionFinishGoal(sessionId, 'turn-one'); return true; });
    const call = announceTransport(sessionId, 'Ready');
    await vi.waitFor(() => expect(action).toBeDefined());
    await action;
    expect(hooks.followup).toHaveBeenCalledTimes(1);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    await releaseSessionFinish(sessionId, 'turn-one');
    await call;
    expect(await sessionFinishWaiting(sessionId, 'turn-one', hooks.caller.conversationId)).toBe(false);
  });
  it('keeps a slow Goal provider outside the 25-second transport deadline and suppresses notifications', async () => {
    hooks.hasInput = false;
    let complete!: (text: string) => void;
    hooks.followup.mockImplementationOnce(() => new Promise<string>(resolve => { complete = resolve; }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const call = announceTransport(sessionId, 'Ready');
      await vi.waitFor(() => expect(hooks.followup).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(25000);
      expect(await call).toContain('later tool call');
      expect(hooks.enqueue).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      complete('Continue with verification');
      await settleSessionFinishForTests();
      expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('lets a newly queued user instruction take priority over a provider reply in flight', async () => {
    hooks.followup.mockImplementationOnce(async () => {
      hooks.delivered.push({ id: 'new-user', sessionId, text: 'Do this first', state: 'queued' });
      return 'Old automatic instruction';
    });
    await announceSessionFinish(sessionId, 'Wrapping up');
    expect(JSON.stringify(await readRecentEvents(sessionId, 100, { kinds: ['progress'] }))).toContain('took priority');
    expect(hooks.enqueue).not.toHaveBeenCalled();
  });
  it('does not bill another decision for tool output excluded from the actual provider context', async () => {
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true, finishAction: 'goal' },
      goal: { ...defaultConfig().goal, includeToolCalls: false } });
    await announceSessionFinish(sessionId, 'First check');
    await appendEvent(sessionId, { source: 'mcp', kind: 'tool_call', turnId: 'turn-one', time: 3000,
      call: { callId: randomUUID(), tool: 'read', attribution: 'request_id', requestId: 'tool-context', conversationId: hooks.caller.conversationId, attributionMethod: 'request_id', args: { text: '{}', chars: 2, truncated: false },
        result: { text: 'New private tool output', chars: 23, truncated: false }, outcome: 'ok', durationMs: 1,
        summary: { title: 'Read', tone: 'neutral', kind: 'read' } } });
    await announceSessionFinish(sessionId, 'Same provider-visible context');
    expect(hooks.followup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(hooks.followup.mock.calls[0]?.[2])).not.toContain('New private tool output');
  });
  it('records a Stop release as an unconfirmed stop request rather than permission to write a final answer', async () => {
    await releaseSessionFinish(sessionId, 'turn-one', 'stop');
    const progress = await readRecentEvents(sessionId, 100, { kinds: ['progress'] });
    const release = progress.find(event => event.kind === 'progress' && event.progressId === 'finish-release:turn-one');
    expect(release).toMatchObject({ message: { text: expect.stringContaining('Stop requested.') } });
    expect(release).toMatchObject({ message: { text: expect.stringContaining('has not yet confirmed') } });
    expect(JSON.stringify(release)).not.toContain('write its final answer');
    expect((await getSession(sessionId))?.activeTurnId).toBe('turn-one');
    expect(await sessionFinishHeld(sessionId, 'turn-one', hooks.caller.conversationId)).toBe(false);
    const result = await announceSessionFinish(sessionId, 'After stop');
    expect(result).toContain('RELEASED:');
    expect(result).not.toContain('you may write the final answer');
    expect(result).not.toContain('The user already released');
  });
  it('labels End turn as release of the hold without claiming provider Stop', async () => {
    await releaseSessionFinish(sessionId, 'turn-one');
    const progress = await readRecentEvents(sessionId, 100, { kinds: ['progress'] });
    expect(progress.find(event => event.kind === 'progress' && event.progressId === 'finish-release:turn-one'))
      .toMatchObject({ message: { text: 'Finish hold released. ChatGPT may finish its answer; generation has not been stopped.' } });
  });
  it('retains authority and decision dedup past 4096 rows, restart and legacy metadata rebuild', async () => {
    await appendEvent(sessionId, { source: 'extension', kind: 'progress', progressId: 'actual-work', turnId: 'turn-one', time: 1200,
      message: { text: 'A real requirement remains', chars: 26, truncated: false } });
    await announceSessionFinish(sessionId, 'First');
    await appendEvent(sessionId, { source: 'extension', kind: 'progress', progressId: 'actual-work', turnId: 'turn-one', time: 1300,
      message: { text: 'A real requirement remains', chars: 26, truncated: false } });
    await announceSessionFinish(sessionId, 'Identical streaming revision');
    expect(hooks.followup).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 4200; index++) await appendEvent(sessionId, {
      source: 'app', kind: 'progress', progressId: `noise-${index}`, turnId: 'turn-one', time: 3000 + index,
      message: { text: 'Status', chars: 6, truncated: false }
    });
    expect(await announceSessionFinish(sessionId, 'After a long hold')).toContain('HELD:');
    expect(hooks.followup).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    await flushSessions(); resetSessionStoreForTests(); initSessionStore(directory);
    expect(await announceSessionFinish(sessionId, 'Restart')).toContain('HELD:');
    expect(hooks.followup).toHaveBeenCalledTimes(1);
    await releaseSessionFinish(sessionId, 'turn-one');
    for (let index = 0; index < 4200; index++) await appendEvent(sessionId, {
      source: 'app', kind: 'progress', progressId: `after-release-${index}`, turnId: 'turn-one', time: 8000 + index,
      message: { text: 'Status', chars: 6, truncated: false }
    });
    await flushSessions(); resetSessionStoreForTests();
    const metaFile = path.join(directory, 'sessions', sessionId, 'meta.json');
    const legacy = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    delete legacy.finishTurn;
    await fs.writeFile(metaFile, JSON.stringify(legacy));
    initSessionStore(directory);
    expect(await sessionFinishHeld(sessionId, 'turn-one', hooks.caller.conversationId)).toBe(false);
    expect((await getSession(sessionId))?.finishTurn).toMatchObject({ turnId: 'turn-one', startedAt: 1000, notified: false, released: true });
    expect(await announceSessionFinish(sessionId, 'Legacy restart')).toContain('RELEASED:');
    expect(notify).not.toHaveBeenCalled();
    expect(hooks.followup).toHaveBeenCalledTimes(1);
  }, 60_000); // Writes 8,400 durable events and rebuilds metadata across two restarts.
  it('preserves same-turn repair receipts but resets them for the next turn and frontend rebind', async () => {
    await announceSessionFinish(sessionId, 'First');
    await releaseSessionFinish(sessionId, 'turn-one');
    await appendEvent(sessionId, { source: 'extension', kind: 'turn_end', turnId: 'turn-one', outcome: 'completed', time: 3000 });
    await appendEvent(sessionId, { source: 'app', kind: 'turn_start', turnId: 'turn-one', detail: 'Reopened by exact tool evidence', time: 3500 });
    expect((await getSession(sessionId))?.finishTurn).toMatchObject({ startedAt: 1000, notified: false, released: true });
    await appendEvent(sessionId, { source: 'extension', kind: 'turn_start', turnId: 'turn-two', time: 4000 });
    expect((await getSession(sessionId))?.finishTurn).toMatchObject({ turnId: 'turn-two', startedAt: 4000, notified: false, released: false, decisionRevision: null });
    expect(await rebindSession(sessionId, hooks.caller.conversationId, randomUUID())).toBe(true);
    expect((await getSession(sessionId))?.finishTurn).toBeNull();
    await flushSessions(); resetSessionStoreForTests();
    const metaFile = path.join(directory, 'sessions', sessionId, 'meta.json');
    const legacy = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    delete legacy.finishTurn;
    await fs.writeFile(metaFile, JSON.stringify(legacy));
    initSessionStore(directory);
    expect(await getSession(sessionId)).toMatchObject({ activeTurnId: null, finishTurn: null });
  });
  it('returns HELD at the bounded timeout without repeating provider work, and feature Off releases', async () => {
    hooks.hasInput = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = announceSessionFinish(sessionId, 'Waiting');
      await vi.waitFor(() => expect(hooks.inputListeners.size).toBe(1));
      await vi.advanceTimersByTimeAsync(25000);
      expect(await result).toContain('HELD:');
      expect(hooks.followup).toHaveBeenCalledTimes(1);
      await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: false } });
      expect(await announceSessionFinish(sessionId, 'Disabled')).toContain('RELEASED:');
      expect(hooks.followup).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('waits for input without consuming it and keeps the same turn held', async () => {
    hooks.hasInput = false;
    const result = announceSessionFinish(sessionId, 'Waiting');
    await vi.waitFor(() => expect(hooks.inputListeners.size).toBe(1));
    hooks.hasInput = true;
    for (const listener of hooks.inputListeners) listener();
    expect(await result).toContain('HELD:');
    expect(hooks.hasInput).toBe(true);
    expect(hooks.inputListeners.size).toBe(0);
  });
  it('persists End turn even when the feature is currently off', async () => {
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: false } });
    await releaseSessionFinish(sessionId, 'turn-one');
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true } });
    expect(await sessionFinishHeld(sessionId, 'turn-one', hooks.caller.conversationId)).toBe(false);
  });
  it('releases durably, wakes a waiting call and does not release the next turn', async () => {
    hooks.hasInput = false;
    const released = vi.fn();
    const result = announceSessionFinish(sessionId, 'Waiting').then(value => { released(); return value; });
    await vi.waitFor(() => expect(hooks.inputListeners.size).toBe(1));
    await releaseSessionFinish(sessionId, 'turn-one');
    // A real recorder notification must wake this call; the 25-second transport
    // deadline used to mask a leaked fake notification timer from an earlier test.
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(await result).toContain('RELEASED:');
    await flushSessions(); resetSessionStoreForTests(); initSessionStore(directory);
    expect(await sessionFinishHeld(sessionId, 'turn-one', hooks.caller.conversationId)).toBe(false);
    await appendEvent(sessionId, { source: 'extension', kind: 'turn_start', turnId: 'turn-two', time: 4000 });
    await expect(releaseSessionFinish(sessionId, 'turn-one')).rejects.toThrow('active turn changed');
    expect(await sessionFinishHeld(sessionId, 'turn-two', hooks.caller.conversationId)).toBe(true);
  });
  it('coalesces concurrent calls and deduplicates later requests from durable progress', async () => {
    const results = await Promise.all([announceSessionFinish(sessionId, 'First'), announceSessionFinish(sessionId, 'Repeated')]);
    expect(results[0]).toBe(results[1]);
    expect(notify).not.toHaveBeenCalled();
    expect(hooks.followup).toHaveBeenCalledTimes(1);
    await flushSessions(); resetSessionStoreForTests(); initSessionStore(directory);
    expect(await announceSessionFinish(sessionId, 'After restart')).toContain('Automatic Goal');
    expect(notify).not.toHaveBeenCalled();
    const progress = await readRecentEvents(sessionId, 100, { kinds: ['progress'] });
    const identities = new Set(progress.filter(event => event.kind === 'progress').map(event => event.progressId));
    expect(identities.has('finish:turn-one')).toBe(false);
    expect([...identities].filter(id => id?.startsWith('finish-goal:turn-one:'))).toHaveLength(1);
  });
  it('ignores its own empty wait output but reconsiders real tool results and delivered app input', async () => {
    const recordTool = (tool: string, result: string) => appendEvent(sessionId, {
      source: 'mcp', kind: 'tool_call', turnId: 'turn-one', time: 2200,
      call: { callId: randomUUID(), tool, attribution: 'request_id', requestId: 'same-server-turn', conversationId: hooks.caller.conversationId,
        attributionMethod: 'request_id', args: { text: '{}', chars: 2, truncated: false },
        result: { text: result, chars: result.length, truncated: false }, outcome: 'ok', durationMs: 25000,
        summary: { title: tool, tone: 'neutral', kind: 'other' } }
    });
    await announceSessionFinish(sessionId, 'First');
    await recordTool('keep_astra_on_forever', 'HELD: Keep waiting');
    await announceSessionFinish(sessionId, 'Empty wait');
    expect(hooks.followup).toHaveBeenCalledTimes(1);
    await recordTool('exec_command', 'The validation exposed a missing requirement');
    await announceSessionFinish(sessionId, 'Real tool output');
    expect(hooks.followup).toHaveBeenCalledTimes(2);
    hooks.delivered.push({ id: 'new-instruction', sessionId, text: 'Also cover the image workflow', state: 'tool' });
    await announceSessionFinish(sessionId, 'New app instruction');
    expect(hooks.followup).toHaveBeenCalledTimes(2); // Undelivered user input goes first.
    hooks.delivered[0]!.state = 'sent';
    await announceSessionFinish(sessionId, 'ACK alone');
    expect(hooks.followup).toHaveBeenCalledTimes(3);
    expect(notify).not.toHaveBeenCalled();
  });
  it('reconsiders new authored progress once while preserving the notification receipt', async () => {
    await announceSessionFinish(sessionId, 'First');
    await announceSessionFinish(sessionId, 'Empty wait with a different summary');
    expect(hooks.followup).toHaveBeenCalledTimes(1);
    await appendEvent(sessionId, { source: 'extension', kind: 'progress', progressId: 'real-work', turnId: 'turn-one', time: 2200,
      message: { text: 'Implemented the first part; validation still shows a failure.', chars: 60, truncated: false } });
    await announceSessionFinish(sessionId, 'New work');
    expect(hooks.followup).toHaveBeenCalledTimes(2);
    await appendEvent(sessionId, { source: 'extension', kind: 'progress', progressId: 'real-work', turnId: 'turn-one', time: 2300,
      message: { text: 'Implemented the first part; validation still shows a failure.', chars: 60, truncated: false } });
    await announceSessionFinish(sessionId, 'Another empty wait');
    expect(hooks.followup).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });
  it('allows the next actual turn but rejects a call that began before that turn', async () => {
    await announceSessionFinish(sessionId, 'First');
    await appendEvent(sessionId, { source: 'extension', kind: 'turn_end', turnId: 'turn-one', outcome: 'completed', time: 3000 });
    await appendEvent(sessionId, { source: 'extension', kind: 'turn_start', turnId: 'turn-two', time: 4000 });
    await expect(announceSessionFinish(sessionId, 'Stale')).rejects.toThrow('start could not be verified');
    hooks.startedAt = 5000;
    await announceSessionFinish(sessionId, 'Second');
    expect(notify).not.toHaveBeenCalled();
  });
  it('refuses another conversation and an idle session without notifying', async () => {
    hooks.caller.conversationId = randomUUID();
    await expect(announceSessionFinish(sessionId, 'Wrong caller')).rejects.toThrow('exact active session');
    await appendEvent(sessionId, { source: 'extension', kind: 'turn_end', turnId: 'turn-one', outcome: 'completed', time: 3000 });
    await expect(announceSessionFinish(sessionId, 'Idle')).rejects.toThrow('exact active session');
    expect(notify).not.toHaveBeenCalled();
  });
  it('does not notify or draft if the durable reservation cannot be written', async () => {
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(announceSessionFinish(sessionId, 'Uncommitted')).rejects.toThrow('could not be recorded');
    expect(notify).not.toHaveBeenCalled(); expect(hooks.followup).not.toHaveBeenCalled();
  });
  it('reports an unavailable notification and backend error without repeating either', async () => {
    setFinishNotifier(null);
    hooks.followup.mockRejectedValueOnce(new Error('Offline Goal waits for the final marker'));
    const result = await announceSessionFinish(sessionId, 'Wrapping up');
    expect(result).toContain('Automatic Goal');
    expect(JSON.stringify(await readRecentEvents(sessionId, 100, { kinds: ['progress'] }))).toContain('Offline Goal waits');
    await announceSessionFinish(sessionId, 'Retry');
    expect(hooks.followup).toHaveBeenCalledTimes(1);
  });
  it('discards a follow-up when its source turn changes during provider work', async () => {
    hooks.followup.mockImplementationOnce(async () => {
      await appendEvent(sessionId, { source: 'extension', kind: 'turn_end', turnId: 'turn-one', outcome: 'completed', time: 3000 });
      await appendEvent(sessionId, { source: 'extension', kind: 'turn_start', turnId: 'turn-two', time: 4000 });
      return 'Stale follow-up must not escape';
    });
    const result = await announceSessionFinish(sessionId, 'Wrapping up');
    expect(JSON.stringify(await readRecentEvents(sessionId, 100, { kinds: ['progress'] }))).toContain('discarded');
    expect(result).not.toContain('Stale follow-up must not escape');
  });
});
