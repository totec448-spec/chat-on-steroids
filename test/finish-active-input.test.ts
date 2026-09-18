import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTempDir, removeTempDir } from './helpers.js';

const hooks = vi.hoisted(() => ({ caller: { sessionId: '', conversationId: '' }, followup: vi.fn() }));
vi.mock('../src/main/goal.js', async original => ({ ...await original<object>(), draftFastFollowup: hooks.followup }));
vi.mock('../src/main/mcp/call-context.js', async original => ({
  ...await original<object>(), currentCall: () => ({ caller: { ...hooks.caller }, startedAt: 2000 })
}));

import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { resetGoalStateForTests, setGoalSwitchNow } from '../src/main/goal.js';
import { announceSessionFinish, getSessionFinishDraft, setFinishNotifier, settleSessionFinishForTests } from '../src/main/session/finish.js';
import { acknowledgeToolInput, enqueueInput, listInputs, offerToolInput, pendingBrowserInputs, resetInputForTests, sessionInputPolicy } from '../src/main/session/input.js';
import { resetRecorderForTests } from '../src/main/session/recorder.js';
import { appendEvent, createSession, flushSessions, getSession, initSessionStore, observeSessionModel, readRecentEvents, resetSessionStoreForTests } from '../src/main/session/store.js';

let directory = '';
let releaseProvider: (() => void) | undefined;
let other: { id: string; conversationId: string };
const turnId = 'same-local-turn';

async function activeChat(title: string) {
  const conversationId = randomUUID();
  const session = await createSession({ conversationId, title });
  await observeSessionModel(session.id, conversationId, 'gpt-6-pro', 900, 'pro');
  await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId, time: 1000 });
  return { id: session.id, conversationId };
}

beforeEach(async () => {
  directory = await makeTempDir('clf-finish-active-input-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true, finishAction: 'goal' } });
  hooks.followup.mockReset().mockResolvedValue('Automatic continuation');
  const source = await activeChat('Source');
  hooks.caller = { sessionId: source.id, conversationId: source.conversationId };
  // Identical document-local ids still must not share finish drafts or input custody.
  other = await activeChat('Other chat');
});

afterEach(async () => {
  releaseProvider?.(); releaseProvider = undefined;
  await settleSessionFinishForTests();
  await flushSessions(); await flushDurable();
  resetInputForTests(); resetGoalStateForTests(); resetRecorderForTests();
  resetSessionStoreForTests(); resetDurableForTests(); setFinishNotifier(null);
  vi.restoreAllMocks();
  if (directory) await removeTempDir(directory);
});

async function expectStillWorking() {
  expect(await getSession(hooks.caller.sessionId)).toMatchObject({
    activeTurnId: turnId, lastTurnEndAt: null, lastAssistantFinalAt: null,
    finishTurn: { turnId, released: false }
  });
  expect(await readRecentEvents(hooks.caller.sessionId, 10, { kinds: ['turn_end'] })).toEqual([]);
  expect(await sessionInputPolicy(hooks.caller.sessionId)).toMatchObject({
    canInject: true, injectionTurnId: turnId, directTurn: null, browserAllowed: false, settled: false
  });
  expect(await pendingBrowserInputs()).toEqual([]);
}

async function injectCorrection() {
  const input = await enqueueInput({ id: randomUUID(), sessionId: hooks.caller.sessionId,
    text: 'Only fix the unexpected continuation; keep this turn working.', mode: 'auto',
    dueAt: Date.now(), model: 'gpt-6-pro', reasoningEffort: 'pro' });
  expect(input.transportIntent).toBe('tool');
  return input;
}

async function expectExactInjection(input: Awaited<ReturnType<typeof injectCorrection>>) {
  expect((await offerToolInput(other.id, other.conversationId, randomUUID(), Date.now() + 10)).messages).toEqual([]);
  expect((await offerToolInput(hooks.caller.sessionId, other.conversationId, randomUUID(), Date.now() + 10)).messages).toEqual([]);
  const requestId = randomUUID();
  const payload = await offerToolInput(hooks.caller.sessionId, hooks.caller.conversationId, requestId, Date.now() + 10);
  expect(payload.messages).toEqual([{ text: input.text, images: [] }]);
  expect((await listInputs()).find(row => row.id === input.id)).toMatchObject({ state: 'tool', owner: requestId });
  // A later invocation in the same request proves receipt; neither a browser send
  // nor a terminal lifecycle event is needed for a user correction to arrive.
  await acknowledgeToolInput(hooks.caller.sessionId, hooks.caller.conversationId, requestId, Date.now() + 20);
  expect((await listInputs()).find(row => row.id === input.id)).toMatchObject({
    state: 'sent', transportIntent: 'tool', messageId: `input:${input.id}`
  });
  await expectStillWorking();
}

describe('active Astra finish and user-input ownership', () => {
  it.each(['implicit', 'goal', 'loop'] as const)('keeps %s Off authoritative while another chat is armed, without ending the turn or switching delivery', async mode => {
    if (mode !== 'implicit') await setGoalSwitchNow(hooks.caller.conversationId, mode, false);
    await setGoalSwitchNow(other.conversationId, 'goal', true);
    const notify = vi.fn(); setFinishNotifier(notify);
    expect(await announceSessionFinish(hooks.caller.sessionId, 'Still verifying', Date.now())).toMatch(/^HELD:/);
    await settleSessionFinishForTests();
    expect(notify).toHaveBeenCalledOnce();
    expect(hooks.followup).not.toHaveBeenCalled();
    expect(getSessionFinishDraft(hooks.caller.sessionId, turnId)).toBeNull();
    expect(getSessionFinishDraft(other.id, turnId)).toBeNull();
    expect(await listInputs()).toEqual([]);
    await expectStillWorking();
    await expectExactInjection(await injectCorrection());
  });

  it('aborts a slow finish decision for the real user injection without publishing its late response or ending the active turn', async () => {
    await setGoalSwitchNow(hooks.caller.conversationId, 'goal', true);
    // Startup persists several records before reaching the provider. Wait for
    // that boundary, and make cleanup available even if startup is still pending.
    const response = new Promise<string>(resolve => { releaseProvider = () => resolve('Obsolete automatic instruction'); });
    const providerStarted = new Promise<AbortSignal>(resolve => {
      hooks.followup.mockImplementationOnce((_id, currentSignal: AbortSignal) => {
        resolve(currentSignal);
        return response;
      });
    });
    expect(await announceSessionFinish(hooks.caller.sessionId, 'Still verifying', Date.now())).toMatch(/^HELD:/);
    const signal = await providerStarted;
    expect(hooks.followup).toHaveBeenCalledOnce();
    expect(getSessionFinishDraft(hooks.caller.sessionId, turnId)?.stage).toBe('sending');
    expect(getSessionFinishDraft(other.id, turnId)).toBeNull();
    await setGoalSwitchNow(other.conversationId, 'goal', false);
    expect(signal?.aborted).toBe(false);
    await expectStillWorking();
    const correction = await injectCorrection();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    releaseProvider!();
    await settleSessionFinishForTests();
    expect(getSessionFinishDraft(hooks.caller.sessionId, turnId)).toBeNull();
    expect((await listInputs()).map(row => row.id)).toEqual([correction.id]);
    await expectExactInjection(correction);
  });

  it('retires a queued finish instruction on Off while the user correction retains exclusive tool custody', async () => {
    await setGoalSwitchNow(hooks.caller.conversationId, 'goal', true);
    await announceSessionFinish(hooks.caller.sessionId, 'Still verifying', Date.now());
    await settleSessionFinishForTests();
    const [automatic] = await listInputs();
    expect(automatic).toMatchObject({ state: 'queued', finishOwner: { turnId } });
    await expectStillWorking();
    await setGoalSwitchNow(hooks.caller.conversationId, 'goal', false);
    expect((await listInputs()).find(row => row.id === automatic!.id)?.state).toBe('cancelled');
    const correction = await injectCorrection();
    await flushDurable(); resetInputForTests();
    await expectExactInjection(correction);
    expect((await listInputs()).find(row => row.id === automatic!.id)).toMatchObject({ state: 'cancelled', owner: null });
  });
});
