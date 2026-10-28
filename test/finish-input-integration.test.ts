import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTempDir, removeTempDir } from './helpers.js';
const hooks = vi.hoisted(() => ({ caller: { sessionId: '', conversationId: '' }, startedAt: 2000, followup: vi.fn() }));
vi.mock('../src/main/goal.js', async original => ({ ...await original<object>(), draftFastFollowup: hooks.followup }));
vi.mock('../src/main/mcp/call-context.js', async original => ({ ...await original<object>(), currentCall: () => ({ caller: hooks.caller, startedAt: hooks.startedAt }) }));
import { initConfigPath, defaultConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, flushDurable } from '../src/main/durable.js';
import { initSessionStore, createSession, appendEvent, observeSessionModel, resetSessionStoreForTests, flushSessions } from '../src/main/session/store.js';
import { setGoalSwitchNow, resetGoalStateForTests } from '../src/main/goal.js';
import { announceSessionFinish, settleSessionFinishForTests, setFinishNotifier } from '../src/main/session/finish.js';
import { listInputs, offerToolInput, resetInputForTests, pendingBrowserInputs, enqueueInput } from '../src/main/session/input.js';
let directory = '';
afterEach(async () => {
  await flushSessions(); await flushDurable();
  resetInputForTests(); resetGoalStateForTests(); resetSessionStoreForTests(); resetDurableForTests();
  setFinishNotifier(null); vi.restoreAllMocks();
  if (directory) await removeTempDir(directory);
});
describe('finish producer to durable injection integration', () => {
  it('releases the held answer for an after-turn head without letting a later finish checkpoint overtake', async () => {
    directory = await makeTempDir('clf-finish-queue-');
    initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true } });
    const conversationId = randomUUID();
    const session = await createSession({ conversationId, title: 'Ordered queue' });
    hooks.caller = { sessionId: session.id, conversationId };
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'held-turn', time: 1000 });
    const head = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Next native turn', mode: 'after-turn', dueAt: 0, model: 'gpt-6-pro', reasoningEffort: 'pro' });
    await observeSessionModel(session.id, conversationId, 'gpt-6-pro', 1500);
    await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Later checkpoint', mode: 'finish', dueAt: 0, model: 'gpt-6-pro', reasoningEffort: 'pro' });
    hooks.followup.mockClear();
    expect(await announceSessionFinish(session.id, 'Wrapping up')).toMatch(/^RELEASED:/);
    expect(hooks.followup).not.toHaveBeenCalled();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect((await offerToolInput(session.id, conversationId, randomUUID(), Date.now(), true)).messages).toEqual([]);
    await appendEvent(session.id, { source: 'extension', kind: 'turn_end', turnId: 'held-turn', outcome: 'completed', time: Date.now() + 1 });
    expect(await pendingBrowserInputs()).toEqual([expect.objectContaining({ id: head.id })]);
  });

  it.each([
    ['notify', 'goal'], ['notify', 'loop'], ['goal', 'goal'], ['goal', 'loop']
  ] as const)('%s finish default with armed %s produces and retains one real tool injection until chat Off', async (finishAction, mode) => {
    directory = await makeTempDir('clf-finish-input-');
    initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true, finishAction } });
    const conversationId = randomUUID();
    const session = await createSession({ conversationId, title: 'Finish integration' });
    hooks.caller = { sessionId: session.id, conversationId };
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'turn-one', time: 1000 });
    await observeSessionModel(session.id, conversationId, 'gpt-6-pro', 1500);
    await setGoalSwitchNow(conversationId, mode, true);
    hooks.followup.mockResolvedValue('Inspect the remaining work');
    const notify = vi.fn(); setFinishNotifier(notify);
    await announceSessionFinish(session.id, 'Wrapping up');
    await settleSessionFinishForTests();
    const rows = await listInputs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'queued', finishOwner: { turnId: 'turn-one' } });
    expect(await pendingBrowserInputs()).toEqual([]);
    const payload = await offerToolInput(session.id, conversationId, randomUUID(), Date.now() + 10);
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]!.text).toContain('Inspect the remaining work');
    expect(notify).not.toHaveBeenCalled();
    await setGoalSwitchNow(conversationId, mode, false);
    expect((await listInputs())[0]!.state).toBe('cancelled');
    await flushDurable(); resetInputForTests();
    await setGoalSwitchNow(conversationId, mode, true);
    expect((await listInputs())[0]!.state).toBe('cancelled');
    expect((await offerToolInput(session.id, conversationId, randomUUID(), Date.now() + 20)).messages).toEqual([]);
  });

  it.each([['allow', 1], ['hold', 0]] as const)('asks the send check before a Session Finish step is queued (%s)', async (verdict, queued) => {
    // #1794: the step can reach ChatGPT in a tool result, so it is asked about before it is filed.
    directory = await makeTempDir('clf-finish-send-check-');
    initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true, finishAction: 'goal', sendCheckUrl: 'http://127.0.0.1:8123/check' } });
    const asked: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      asked.push(JSON.parse(String(init.body)));
      return Response.json(verdict === 'allow' ? { allow: true } : { allow: false, reason: 'budget' });
    }));
    try {
      const conversationId = randomUUID();
      const session = await createSession({ conversationId, title: 'Finish send check' });
      hooks.caller = { sessionId: session.id, conversationId };
      await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'turn-one', time: 1000 });
      await observeSessionModel(session.id, conversationId, 'gpt-6-pro', 1500);
      await setGoalSwitchNow(conversationId, 'goal', true);
      hooks.followup.mockResolvedValue('Inspect the remaining work');
      await announceSessionFinish(session.id, 'Wrapping up');
      await settleSessionFinishForTests();
      expect(asked).toEqual([expect.objectContaining({ kind: 'goal-step', text: 'Inspect the remaining work', attempt: 1,
        chat: { session: session.id, project: null, worker: null } })]);
      expect(await listInputs()).toHaveLength(queued);
      // Held, nothing more is coming: the finish hold is released so ChatGPT can finish its answer.
      const { getSession } = await import('../src/main/session/store.js');
      expect((await getSession(session.id))?.finishTurn?.released ?? false).toBe(verdict === 'hold');
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not say the hold was released when that release could not be saved (CodeRabbit)', async () => {
    directory = await makeTempDir('clf-finish-send-check-release-');
    initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true, finishAction: 'goal', sendCheckUrl: 'http://127.0.0.1:8123/check' } });
    const conversationId = randomUUID();
    const session = await createSession({ conversationId, title: 'Finish release fails' });
    // The check holds the step, and meanwhile a new turn starts: the old turn's hold cannot be released.
    vi.stubGlobal('fetch', vi.fn(async () => {
      await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'turn-two', time: 3000 });
      return Response.json({ allow: false, reason: 'budget' });
    }));
    try {
      hooks.caller = { sessionId: session.id, conversationId };
      await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'turn-one', time: 1000 });
      await observeSessionModel(session.id, conversationId, 'gpt-6-pro', 1500);
      await setGoalSwitchNow(conversationId, 'goal', true);
      hooks.followup.mockResolvedValue('Inspect the remaining work');
      await announceSessionFinish(session.id, 'Wrapping up');
      await settleSessionFinishForTests();
      const { readEvents } = await import('../src/main/session/store.js');
      const said = JSON.stringify(await readEvents(session.id));
      expect(said).toContain("The person's send check held the automatic Goal instruction, so none was queued.");
      expect(said).not.toContain('The finish hold was released');
      expect(said).toContain('The finish hold could not be released');
    } finally { vi.unstubAllGlobals(); }
  });
});

