import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOAL_CONTINUATIONS, GOAL_MARKER_INSTRUCTION, templateGoalDecision } from '../src/shared/goal-templates.js';
import { promises as fs } from 'node:fs';
const browser = vi.hoisted(() => ({ request: vi.fn(), authorize: vi.fn() }));
vi.mock('../src/main/session/input.js', () => ({ requestBrowserDecision: browser.request, authorizeBrowserHelperRetry: browser.authorize, listInputs: async () => [] }));
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString(), shouldReEncrypt: false })
  }
}));
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const { initDurableStore, resetDurableForTests, flushDurable, readDurable } = await import('../src/main/durable.js');
const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const goal = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
let directory: string;
beforeAll(async () => {
  directory = await makeTempDir('clf-goal-backends-');
  initConfigPath(directory);
  initSecretsPath(directory);
  initSessionStore(directory);
  initDurableStore(directory);
});
beforeEach(async () => {
  goal.resetGoalStateForTests();
  browser.request.mockReset();
  browser.authorize.mockReset();
  await setSecret('openRouterApiKey', '');
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'templates', loopBackend: 'api' } });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected API request'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => {
  goal.resetGoalStateForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

describe('durable browser decision chat role', () => {
  it('binds one helper per durable source session and refuses cross-source reuse', async () => {
    await goal.registerGoalDecisionChat('helper-session-one', 'source-session-one');
    await expect(goal.registerGoalDecisionChat('helper-session-one', 'source-session-two')).rejects.toThrow('wrong_source');
    await expect(goal.registerGoalDecisionChat('helper-session-two', 'source-session-one')).rejects.toThrow('already_bound');
    const snapshot = goal.snapshotGoalSwitches();
    goal.restoreGoalSwitches(snapshot);
    expect(goal.snapshotGoalSwitches().switches).toContainEqual(expect.objectContaining({ conversationId: 'helper-session-one', sourceSessionId: 'source-session-one' }));
  });
  it('survives restart and master-Off while refusing manual rearming or identity moves', async () => {
    const id = 'decision-chat-one';
    await goal.registerGoalDecisionChat(id);
    await goal.setGoalSwitchNow('ordinary-chat', 'goal', true);
    goal.clearAllGoalSwitches();
    goal.clearGoalSwitch(id);
    expect(await goal.setGoalSwitchNow(id, 'loop', true)).toEqual({ enabled: false, mode: 'goal' });
    expect(goal.goalArmedFor(id)).toBe(false);
    expect(goal.moveGoalSwitch(id, 'replacement-chat')).toBe(false);
    await goal.setGoalSwitchNow('ordinary-chat', 'goal', true);
    expect(goal.moveGoalSwitch('ordinary-chat', id)).toBe(false);
    await flushDurable();
    const snapshot = await readDurable<Parameters<typeof goal.restoreGoalSwitches>[0]>(goal.GOAL_SWITCHES_STATE);
    goal.resetGoalStateForTests();
    goal.restoreGoalSwitches(snapshot);
    expect(goal.isGoalDecisionChat(id)).toBe(true);
    expect(goal.goalSwitchFor(id)).toMatchObject({ enabled: false, own: true });
  });
  it('retains helper identities when ordinary preference churn reaches the ledger cap', async () => {
    const id = 'decision-chat-oldest';
    goal.restoreGoalSwitches({ version: 1, savedAt: 1, switches: [
      { conversationId: id, enabled: true, mode: 'loop', role: 'decision', at: 1 },
      ...Array.from({ length: 500 }, (_, index) => ({ conversationId: `ordinary-${index}`, enabled: true, mode: 'goal' as const, at: index + 2 }))
    ] });
    expect(goal.snapshotGoalSwitches().switches).toHaveLength(400);
    expect(goal.isGoalDecisionChat(id)).toBe(true);
    expect(goal.goalArmedFor(id)).toBe(false);
  });
  it('fails closed at helper capacity rather than reviving an old helper', async () => {
    goal.restoreGoalSwitches({ version: 1, savedAt: 1, switches: Array.from({ length: 400 }, (_, index) => ({
      conversationId: `decision-${index}`, enabled: false, mode: 'goal', role: 'decision', at: index + 1
    })) });
    await expect(goal.registerGoalDecisionChat('decision-overflow')).rejects.toThrow('goal_helper_capacity');
    await expect(goal.setGoalSwitchNow('ordinary-overflow', 'goal', true)).rejects.toThrow('goal_switch_capacity');
    expect(goal.isGoalDecisionChat('decision-0')).toBe(true);
    expect(goal.isGoalDecisionChat('decision-overflow')).toBe(false);
    expect(goal.snapshotGoalSwitches().switches).toHaveLength(400);
  });
  it('rolls back a failed helper registration including displaced ordinary preferences', async () => {
    goal.restoreGoalSwitches({ version: 1, savedAt: 1, switches: Array.from({ length: 400 }, (_, index) => ({
      conversationId: `ordinary-${index}`, enabled: true, mode: 'goal', at: index + 1
    })) });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(goal.registerGoalDecisionChat('decision-rejected')).rejects.toThrow('disk busy');
    await flushDurable();
    expect(goal.isGoalDecisionChat('decision-rejected')).toBe(false);
    expect(goal.goalSwitchFor('ordinary-0')).toMatchObject({ own: true, enabled: true });
    const stored = await readDurable<{ switches: Array<{ conversationId: string }> }>(goal.GOAL_SWITCHES_STATE);
    expect(stored?.switches.some(row => row.conversationId === 'decision-rejected')).toBe(false);
    expect(stored?.switches).toHaveLength(400);
  });
  it('serializes duplicate registrations with a simultaneous user enable', async () => {
    const id = 'decision-concurrent';
    await Promise.all([
      goal.registerGoalDecisionChat(id),
      goal.setGoalSwitchNow(id, 'loop', true),
      goal.registerGoalDecisionChat(id)
    ]);
    expect(goal.isGoalDecisionChat(id)).toBe(true);
    expect(goal.goalArmedFor(id)).toBe(false);
    expect(goal.snapshotGoalSwitches().switches.filter(row => row.conversationId === id)).toHaveLength(1);
  });
});
async function recording(conversationId: string, text: string): Promise<string> {
  const session = await createSession({ title: 'Goal backend test', conversationId });
  for (const [role, message] of [['user', 'Finish the original task'], ['assistant', text]] as const) {
    await appendEvent(session.id, {
      time: role === 'user' ? 1000 : 2000, source: 'extension',
      ...(role === 'assistant' ? { kind: 'assistant_message' as const, final: true } : { kind: 'user_message' as const }),
      message: { text: message, chars: message.length, truncated: false }
    });
  }
  return session.id;
}
async function settled(id: string) {
  await vi.waitFor(() => expect(goal.goalViewFor(id)?.stage).not.toMatch(/^(sending|answering)$/));
  return goal.goalViewFor(id)!;
}
describe('Goal decision backends', () => {
  it('restarts only the deliberately authorized failed source helper', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
    const id = 'source-retry-helper';
    const sessionId = await recording(id, 'Next task');
    browser.request.mockRejectedValueOnce(new Error('goal_browser_send_unconfirmed'));
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'source-final' });
    expect((await settled(id)).retryable).toBe(false);
    browser.authorize.mockResolvedValueOnce(false);
    expect(await goal.retryGoalBrowserHelper(sessionId, 'old-input')).toBe(false);
    expect(browser.request).toHaveBeenCalledTimes(1);
    browser.authorize.mockResolvedValueOnce(true);
    browser.request.mockResolvedValueOnce('{"action":"continue","reply":"Perform next check"}');
    expect(await goal.retryGoalBrowserHelper(sessionId, 'old-input')).toBe(true);
    expect(await settled(id)).toMatchObject({ turnId: 'source-final', stage: 'ready' });
    expect(browser.request).toHaveBeenCalledTimes(2);
  });
  it('reuses its durable helper with only proven incremental source messages after restart', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, backend: 'chatgpt' } });
    const id = 'incremental-source';
    const sessionId = await recording(id, 'Original reference only');
    browser.request.mockImplementation(async (_text, _signal, options) => {
      await goal.registerGoalDecisionChat('incremental-helper', options.sourceSessionId);
      return '{"action":"continue","reply":"Continue the checks"}';
    });
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'first' });
    expect((await settled(id)).stage).toBe('ready');
    expect(browser.request.mock.calls[0]?.[2]).toEqual({ sourceSessionId: sessionId, conversationId: null, model: 'gpt-5.6-sol', reasoningEffort: 'high', publish: expect.any(Function) });
    expect(browser.request.mock.calls[0]?.[0]).toContain('Original reference only');
    const saved = goal.snapshotGoalSwitches();
    goal.resetGoalStateForTests();
    goal.restoreGoalSwitches(saved);
    await appendEvent(sessionId, { source: 'extension', kind: 'assistant_message', final: true, time: 3000,
      message: { text: 'New response only', chars: 17, truncated: false } });
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'second' });
    expect((await settled(id)).stage).toBe('ready');
    expect(browser.request.mock.calls[1]?.[2]).toMatchObject({ conversationId: 'incremental-helper', sourceSessionId: sessionId });
    expect(browser.request.mock.calls[1]?.[0]).toContain('New response only');
    expect(browser.request.mock.calls[1]?.[0]).not.toContain('Original reference only');
    expect(browser.request.mock.calls[1]?.[0]).toContain('Append these new source messages');
    await saveConfig({ ...config, goal: { ...config.goal, enabled: true, backend: 'chatgpt', prompt: 'Changed continuation instructions' } });
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'third' });
    expect((await settled(id)).stage).toBe('ready');
    expect(browser.request.mock.calls[2]?.[0]).toContain('Original reference only');
    expect(browser.request.mock.calls[2]?.[2]).toMatchObject({ conversationId: 'incremental-helper' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires an API key for API finish follow-ups', async () => {
    const backend = 'api';
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'templates', loopBackend: backend } });
    await expect(goal.draftFastFollowup('irrelevant-session')).rejects.toThrow('Configure the Goal API key');
    expect(browser.request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the selected API with interim and user context', async () => {
    const backend = 'api';
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'templates', loopBackend: backend, reasoning: 'high', loopPrompt: 'Keep advancing my loop request.' } });
    await setSecret('openRouterApiKey', 'test-key');
    const sessionId = await recording(`finish-api-${backend}`, 'Previous result');
    await appendEvent(sessionId, { source: 'extension', kind: 'progress', progressId: 'work', time: 3000,
      message: { text: 'Actual interim checks are running', chars: 32, truncated: false } });
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.reasoning).toEqual({ effort: 'high', exclude: true });
      expect(body.messages[0].content).toBe('Keep advancing my loop request.');
      expect(body.messages.some((message: { content: string }) => message.content === 'Finish the original task')).toBe(true);
      expect(JSON.stringify(body.messages)).toContain('Actual interim checks are running');
      return Response.json({ choices: [{ message: { content: '{"action":"continue","reply":"Finish the tests"}' } }] });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await goal.draftFastFollowup(sessionId)).toBe('Finish the tests');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(browser.request).not.toHaveBeenCalled();
  });
  it.each(['api', 'templates', 'chatgpt'] as const)('uses Loop ChatGPT settings for finish while ordinary Goal is %s', async backend => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend, loopBackend: 'chatgpt', loopPrompt: 'Keep advancing my loop request.', prompt: 'Ordinary completion gate.', helperModel: 'gpt-5.6-sol', helperReasoning: 'high' } });
    const sessionId = await recording('finish-chatgpt', 'Previous result');
    browser.request.mockResolvedValue('{"action":"continue","reply":"Finish the tests"}');
    expect(await goal.draftFastFollowup(sessionId)).toBe('Finish the tests');
    expect(browser.request).toHaveBeenCalledTimes(1);
    expect(browser.request.mock.calls[0]?.[0]).toContain('Keep advancing my loop request.');
    expect(browser.request.mock.calls[0]?.[0]).not.toContain('Ordinary completion gate.');
    expect(browser.request.mock.calls[0]?.[2]).toMatchObject({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the Loop driver even when offline Goal marked the last answer complete', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'templates', loopBackend: 'chatgpt' } });
    const sessionId = await recording('finish-offline', 'Done\n[[COS_GOAL:COMPLETE]]');
    browser.request.mockResolvedValue('{"action":"continue","reply":"Continue the next useful step"}');
    expect(await goal.draftFastFollowup(sessionId)).toBe('Continue the next useful step');
    expect(browser.request).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it('retains the exact objective in the Loop instruction and refuses a stopping finish answer', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, loopBackend: 'chatgpt', loopPrompt: 'Continue the loop request.' } });
    const conversationId = 'finish-loop-objective';
    const sessionId = await recording(conversationId, 'Previous result');
    await goal.setGoalObjectiveNow(conversationId, 'Finish my exact objective');
    browser.request.mockResolvedValue('{"action":"stop","reply":""}');
    await expect(goal.draftFastFollowup(sessionId)).rejects.toThrow('loop_stop_refused');
    expect(browser.request).toHaveBeenCalledTimes(3);
    expect(browser.request.mock.calls[0]?.[0]).toContain('Continue the loop request.');
    expect(browser.request.mock.calls[0]?.[0]).toContain('Finish my exact objective');
  });
  it('keeps periodic Goal checks on their own backend and completion contract', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'templates', loopBackend: 'chatgpt' } });
    const sessionId = await recording('periodic-offline', 'Done\n[[COS_GOAL:COMPLETE]]');
    expect(await goal.draftFastFollowup(sessionId, undefined, undefined, undefined, 'goal')).toBeNull();
    expect(browser.request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'chatgpt', loopBackend: 'api', prompt: 'Periodic completion gate.' } });
    browser.request.mockResolvedValue('{"action":"stop","reply":""}');
    expect(await goal.draftFastFollowup(sessionId, undefined, undefined, undefined, 'goal')).toBeNull();
    expect(browser.request.mock.calls[0]?.[0]).toContain('Periodic completion gate.');
    expect(browser.request).toHaveBeenCalledTimes(1);
  });
  it('requires API keys only for the selected mode backend', async () => {
    expect(await goal.goalKeyPresent('goal')).toBe(true);
    expect(await goal.goalKeyPresent('loop')).toBe(false);
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'api', loopBackend: 'chatgpt' } });
    expect(await goal.goalKeyPresent('goal')).toBe(false);
    expect(await goal.goalKeyPresent('loop')).toBe(true);
  });
  it('opens offline Goal without API or browser calls and preserves exact instructions', async () => {
    expect(await goal.draftOpeningMessage('Finish this', 'goal')).toEqual({ reply: 'Finish this' + GOAL_MARKER_INSTRUCTION, model: 'Offline Goal' });
    expect(browser.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves the marker protocol exactly in a template continuation', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const id = 'goal-template-continue';
    const sessionId = await recording(id, 'More remains\n[[COS_GOAL:CONTINUE]]');
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-1' });
    const draft = await settled(id);
    random.mockRestore();
    expect(draft.stage).toBe('ready');
    expect(draft.reply.endsWith(GOAL_MARKER_INSTRUCTION)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(browser.request).not.toHaveBeenCalled();
  });
  it('stops on exact completion and pauses for missing markers without guessing', async () => {
    for (const [id, text, stage] of [
      ['goal-template-stop', 'Finished\n[[COS_GOAL:COMPLETE]]', 'no-reply'],
      ['goal-template-missing', 'I probably finished', 'failed']
    ]) {
      const sessionId = await recording(id!, text!);
      goal.startGoalDraft({ conversationId: id!, sessionId, turnId: 'turn' });
      expect((await settled(id!)).stage).toBe(stage);
    }
    expect(goal.goalViewFor('goal-template-missing')).toMatchObject({ error: 'goal_marker_missing', retryable: false });
  });
  it('keeps all 200 template variants unique with identical marker contracts', () => {
    expect(GOAL_CONTINUATIONS).toHaveLength(200);
    expect(new Set(GOAL_CONTINUATIONS).size).toBe(200);
    for (let index = 0; index < GOAL_CONTINUATIONS.length; index++) {
      expect(templateGoalDecision('[[COS_GOAL:CONTINUE]]', index)).toEqual({ action: 'continue', reply: GOAL_CONTINUATIONS[index] + ' ' + GOAL_CONTINUATIONS[(index + 1) % 200] + GOAL_MARKER_INSTRUCTION });
    }
    for (const text of ['prefix [[COS_GOAL:COMPLETE]]', '[[COS_GOAL:COMPLETE]]\nMore work', '[[COS_GOAL:complete]]']) {
      expect(templateGoalDecision(text, 0).action).toBe('invalid');
    }
  });
  it('uses browser JSON decisions without an API key and refuses prose', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'chatgpt' } });
    browser.request.mockResolvedValueOnce('{"action":"continue","reply":"do the tests"}');
    expect(await goal.draftOpeningMessage('Finish this', 'goal')).toMatchObject({ reply: goal.humanReply('do the tests') });
    expect(browser.request.mock.calls[0]?.[0]).toContain('reference data, not a request to execute');
    browser.request.mockResolvedValueOnce('You should continue');
    expect(await goal.draftOpeningMessage('Finish this', 'goal')).toMatchObject({ error: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not let a stale browser answer replace a newer source-chat draft', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
    const id = 'goal-browser-stale';
    const sessionId = await recording(id, 'Next step');
    let release!: (value: string) => void;
    browser.request.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    browser.request.mockResolvedValueOnce('{"action":"continue","reply":"newest work"}');
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'old' });
    await vi.waitFor(() => expect(browser.request).toHaveBeenCalledTimes(1));
    const oldSignal = browser.request.mock.calls[0]?.[1] as AbortSignal;
    goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'new' });
    expect(oldSignal.aborted).toBe(true);
    release('{"action":"continue","reply":"stale work"}');
    const view = await settled(id);
    expect(view.turnId).toBe('new');
    expect(view.reply).toBe(goal.humanReply('newest work'));
  });
});

it('retires an unretryable helper pickup durably without retiring a newer final', async () => {
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'chatgpt' } });
  const id = 'failed-helper-pickup';
  await goal.setGoalSwitchNow(id, 'goal', true);
  const sessionId = await recording(id, 'Next task');
  await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-one', turnId: 'turn-one', eventSeq: 10, blocked: false });
  expect(goal.goalPendingReplyFor(id)?.turnId).toBe('turn-one');
  browser.request.mockRejectedValueOnce(new Error('goal_browser_send_failed'));
  goal.startGoalDraft({ conversationId: id, sessionId, turnId: 'turn-one' });
  expect(await settled(id)).toMatchObject({ stage: 'failed', retryable: false });
  expect(goal.goalPendingReplyFor(id)).toBeNull();
  expect(goal.pendingGoalReplies().some(row => row.conversationId === id)).toBe(false);
  await flushDurable();
  const stored = await readDurable<any>(goal.GOAL_REPLIES_STATE);
  expect(stored.replies.find((row: any) => row.conversationId === id).state).toBe('handled');
  await goal.acceptGoalReplyNow({ conversationId: id, sessionId, replyId: 'reply-two', turnId: 'turn-two', eventSeq: 11, blocked: false });
  expect(goal.goalPendingReplyFor(id)?.turnId).toBe('turn-two');
});

it('generates a validated staged plan through the existing browser helper without an API key', async () => {
  browser.request.mockResolvedValueOnce(JSON.stringify({ action: 'continue', reply: JSON.stringify({ stages: ['Implement the requested feature', 'Test every acceptance criterion'] }) }));
  expect(await goal.draftTaskPlan('Build the feature and test it', 'chatgpt')).toEqual(['Implement the requested feature', 'Test every acceptance criterion']);
  expect(browser.request).toHaveBeenCalledTimes(1);
  expect(browser.request.mock.calls[0]![0]).toContain('Build the feature and test it');
  expect(browser.request.mock.calls[0]![0]).not.toMatch(/session_finish|minutes before/i);
  browser.request.mockResolvedValueOnce(JSON.stringify({ action: 'continue', reply: '{"stages":[""]}' }));
  await expect(goal.draftTaskPlan('Build it', 'chatgpt')).rejects.toThrow('invalid stages');
  await expect(goal.draftTaskPlan('Build it', 'api')).rejects.toThrow('API key');
});

it('publishes readable partial plan stages while final validation remains authoritative', async () => {
  const progress = vi.fn();
  const raw = JSON.stringify({ action: 'continue', reply: JSON.stringify({ stages: ['Build the feature', 'Verify acceptance'] }) });
  browser.request.mockImplementationOnce(async (_prompt, _signal, options) => {
    options.publish(raw.slice(0, raw.indexOf('feature') + 3));
    options.publish(raw);
    return raw;
  });
  expect(await goal.draftTaskPlan('Build it', 'chatgpt', progress)).toEqual(['Build the feature', 'Verify acceptance']);
  expect(browser.request.mock.calls[0]?.[2]).toMatchObject({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  expect(progress).toHaveBeenCalledWith({ phase: 'generating', text: '1. Build the fea' });
  expect(progress).toHaveBeenCalledWith({ phase: 'generating', text: '1. Build the feature\n\n2. Verify acceptance' });

  browser.request.mockImplementationOnce(async (_prompt, _signal, options) => {
    options.publish(raw.slice(0, raw.indexOf('feature') + 3));
    return raw.slice(0, -2);
  });
  progress.mockClear();
  await expect(goal.draftTaskPlan('Build it', 'chatgpt', progress)).rejects.toThrow();
  expect(progress).toHaveBeenCalledWith({ phase: 'generating', text: '1. Build the fea' });
  expect(progress.mock.calls.some(([update]) => update.phase === 'ready')).toBe(false);
});
