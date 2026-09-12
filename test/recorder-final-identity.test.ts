import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { closeConversation, liveConversations, recordChatObservations, recordToolCall, resetRecorderForTests } from '../src/main/session/recorder.js';
import { emptyEvidence, trackInFlight } from '../src/main/mcp/call-context.js';
import { appendEvent, flushSessions, getSession, initSessionStore, readEvents, resetSessionStoreForTests } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
it('records an empty native image message and keeps its stable origin on replay', async () => {
  const image = { kind: 'user_message' as const, messageId: 'image-only-user', time: 100, text: '',
    attachments: [{ id: 'native-file', name: 'example.png', size: 123, mimeType: 'image/png' }] };
  const opened = await recordChatObservations('image-only-recording', [image]);
  const [before] = await readEvents(opened.sessionId!, { kinds: ['user_message'] });
  expect(before).toMatchObject({ kind: 'user_message', message: { text: '' }, attachments: image.attachments });
  await recordChatObservations('image-only-recording', [{ kind: 'turn_start', time: 110, turnId: 'image-answer' }, image]);
  const users = await readEvents(opened.sessionId!, { kinds: ['user_message'] });
  expect(users).toHaveLength(1);
  expect(users[0]!.seq).toBe(before!.seq);
});
beforeAll(async () => {
  directory = await makeTempDir('clf-final-identity-');
  initConfigPath(directory);
  initSessionStore(directory);
  await saveConfig(defaultConfig());
});
beforeEach(() => { resetRecorderForTests(); resetSessionStoreForTests(); });
afterAll(async () => { resetRecorderForTests(); resetSessionStoreForTests(); await removeTempDir(directory); });

it.each([false, true])('records stopped partial-answer revisions without restoring activity (restart=%s)', async restart => {
  const conversationId = `stopped-partial-${restart}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'stopped-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'stopped-turn', messageId: 'partial', text: 'Working', state: 'streaming', activeNow: true },
    { kind: 'turn_end', time: 12, turnId: 'stopped-turn', outcome: 'stopped' }
  ]);
  if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
  const revised = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'partial', text: 'Preserved partial answer', state: 'streaming', activeNow: true }
  ]);
  expect(revised.activity).toMatchObject({ meaningful: false, working: false, terminal: false });
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))[0]).toMatchObject({ message: { text: 'Preserved partial answer' } });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  await recordChatObservations(conversationId, [{ kind: 'turn_start', time: 30, turnId: 'new-turn' }]);
  const old = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 31, turnId: 'new-turn', messageId: 'partial', text: 'Historical partial revision', state: 'streaming', activeNow: true }
  ]);
  expect(old.activity.working).toBe(false);
  const current = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 32, turnId: 'new-turn', messageId: 'new-answer', text: 'New work', state: 'streaming', activeNow: true }
  ]);
  expect(current.activity.working).toBe(true);
});

it.each(['missing', 'replaced', 'matching', 'restart'])('closes the canonical reply owner after reload with a %s page turn id', async mode => {
  const conversationId = `canonical-final-${mode}`;
  const turnId = `original-${mode}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId },
    { kind: 'assistant_message', time: 11, turnId, messageId: 'stable-answer', text: 'Working', state: 'streaming' }
  ]);
  await closeConversation(conversationId);
  if (mode === 'restart') {
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  }
  const final = { kind: 'assistant_message' as const, time: 20, messageId: 'stable-answer',
    text: 'The full canonical answer.', state: 'final' as const, final: true, goalEligible: true,
    ...(mode === 'matching' ? { turnId } : mode === 'replaced' ? { turnId: 'replacement-page-id' } : {}) };
  const recovered = await recordChatObservations(conversationId, [final]);
  const sessionId = opened.sessionId!;
  expect(recovered.sessionId).toBe(sessionId);
  const [message] = await readEvents(sessionId, { kinds: ['assistant_message'] });
  expect(message).toMatchObject({ turnId, state: 'final', message: { text: final.text } });
  expect((await getSession(sessionId))?.activeTurnId).toBeNull();
  expect(liveConversations().find(row => row.conversationId === conversationId)?.activeTurnId).toBeNull();
  expect(recovered.activity).toMatchObject({ terminal: true, endedTurnId: turnId });
  expect(recovered.goalCandidates).toEqual([expect.objectContaining({ replyId: 'stable-answer', turnId })]);
  await recordChatObservations(conversationId, [final]);
  expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toHaveLength(1);
});

it.each(['missing', 'replacement'] as const)(
  'recovers a distinct final from the exact response branch after recorder restart with a %s page turn id',
  async pageTurn => {
  const conversationId = `distinct-response-branch-final-${pageTurn}`;
  const turnId = `response-branch-turn-${pageTurn}`;
  const branch = { responseExchangeId: 'exchange_exact', responseWorkingId: 'working_exact' };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId },
    { kind: 'assistant_message', time: 11, turnId, messageId: 'partial-before-reload',
      providerMessageId: 'provider-partial', text: 'Working.', state: 'streaming', ...branch }
  ]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();

  const recovered = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, messageId: 'distinct-final-after-reload',
    providerMessageId: 'provider-final', text: 'Completed.', state: 'final', final: true,
    activeNow: true, ...(pageTurn === 'replacement' ? { turnId: 'replacement-page-turn' } : {}), ...branch
  }]);

  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(recovered.activity).toMatchObject({ terminal: true, endedTurnId: turnId });
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] })).at(-1)).toMatchObject({
    turnId, responseExchangeId: branch.responseExchangeId, responseWorkingId: branch.responseWorkingId
  });
});

it('binds replacement-page streaming before its matching native-branch final', async () => {
  const conversationId = 'replacement-streaming-then-final';
  const turnId = 'durable-response-turn';
  const branch = { responseExchangeId: 'exchange_exact', responseWorkingId: 'working_exact' };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId },
    { kind: 'assistant_message', time: 11, turnId, messageId: 'old-page-partial',
      providerMessageId: 'provider-partial', text: 'Working.', state: 'streaming', ...branch }
  ]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();

  await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, turnId: 'replacement-page-turn', messageId: 'new-page-answer',
    providerMessageId: 'provider-answer', text: 'Still working.', state: 'streaming', activeNow: true, ...branch
  }]);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] })).at(-1)).toMatchObject({ turnId });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe(turnId);

  const completed = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 30, turnId: 'replacement-page-turn', messageId: 'new-page-answer',
    providerMessageId: 'provider-answer', text: 'Completed.', state: 'final', final: true, activeNow: true, ...branch
  }]);
  expect(completed.activity).toMatchObject({ terminal: true, endedTurnId: turnId });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] })).at(-1)).toMatchObject({
    turnId, state: 'final', message: { text: 'Completed.' }
  });
});

it('keeps a branchless replacement snapshot promotable by later exact provider-branch proof', async () => {
  const conversationId = 'branchless-replacement-promoted-later';
  const turnId = 'durable-response-turn';
  const branch = { responseExchangeId: 'exchange_exact', responseWorkingId: 'working_exact' };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId },
    { kind: 'assistant_message', time: 11, turnId, messageId: 'old-page-partial',
      providerMessageId: 'provider-partial', text: 'Working.', state: 'streaming', ...branch }
  ]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();

  await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, turnId: 'replacement-page-turn', messageId: 'replacement-snapshot',
    providerMessageId: 'provider-new-answer', text: 'Still working.', state: 'streaming', activeNow: true
  }]);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] })).at(-1)).not.toHaveProperty('turnId');

  const completed = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 30, turnId: 'replacement-page-turn', messageId: 'replacement-remount',
    providerMessageId: 'provider-new-answer', text: 'Completed.', state: 'final', final: true, activeNow: true, ...branch
  }]);
  expect(completed.activity).toMatchObject({ terminal: true, endedTurnId: turnId });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] })).at(-1)).toMatchObject({
    turnId, state: 'final', providerMessageId: 'provider-new-answer'
  });
});

it('does not let an older matching branch close a newer durable turn', async () => {
  const conversationId = 'older-branch-after-newer-turn';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'older-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'older-turn', messageId: 'older-partial',
      text: 'Older work.', state: 'streaming', responseExchangeId: 'exchange_old', responseWorkingId: 'working_old' },
    { kind: 'turn_start', time: 20, turnId: 'newer-turn' },
    { kind: 'user_message', time: 21, turnId: 'newer-turn', messageId: 'newer-user', text: 'New request', authoredNow: true }
  ]);
  const observed = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 30, turnId: 'replacement-page-turn', messageId: 'older-final',
    providerMessageId: 'provider-old-final', text: 'Older completed.', state: 'final', final: true, activeNow: true,
    responseExchangeId: 'exchange_old', responseWorkingId: 'working_old'
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('newer-turn');
  expect(observed.activity.endedTurnId).toBeUndefined();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});

it.each(['user-before-final', 'final-before-user'] as const)(
  'does not close or enqueue a matching-branch final when a fresh user appears %s',
  async order => {
    const conversationId = `matching-branch-with-fresh-user-${order}`;
    const turnId = 'durable-turn';
    const branch = { responseExchangeId: 'exchange_exact', responseWorkingId: 'working_exact' };
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId },
      { kind: 'assistant_message', time: 11, turnId, messageId: 'partial', text: 'Working.', state: 'streaming', ...branch }
    ]);
    const final = { kind: 'assistant_message' as const, time: 20, turnId: 'replacement-page-turn',
      messageId: 'distinct-final', providerMessageId: 'provider-final', text: 'Completed.', state: 'final' as const,
      final: true, activeNow: true, goalEligible: true, ...branch };
    const user = { kind: 'user_message' as const, time: 21, messageId: 'fresh-user', text: 'New work', authoredNow: true };
    const observed = await recordChatObservations(conversationId, order === 'user-before-final' ? [user, final] : [final, user]);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe(turnId);
    expect(observed.activity.endedTurnId).toBeUndefined();
    expect(observed.goalCandidates).toEqual([]);
    expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
  }
);

it.each([
  ['user-before-final', 'missing'],
  ['final-before-user', 'missing'],
  ['user-before-final', 'durable'],
  ['final-before-user', 'durable']
] as const)(
  'does not trust explicit Goal eligibility for a superseded pre-batch final (%s, %s id)',
  async (order, identity) => {
    const conversationId = `superseded-explicit-goal-${order}-${identity}`;
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'durable-turn' },
      { kind: 'assistant_message', time: 11, turnId: 'durable-turn', messageId: 'partial', text: 'Working.', state: 'streaming' }
    ]);
    const final = { kind: 'assistant_message' as const, time: 20, messageId: 'stable-final',
      text: 'Old completion.', state: 'final' as const, final: true, goalEligible: true,
      ...(identity === 'durable' ? { turnId: 'durable-turn' } : {}) };
    const user = { kind: 'user_message' as const, time: 21, messageId: 'fresh-user', text: 'New work', authoredNow: true };
    const observed = await recordChatObservations(conversationId, order === 'user-before-final' ? [user, final] : [final, user]);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('durable-turn');
    expect(observed.goalCandidates).toEqual([]);
    expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
  }
);

it.each(['turn-before-final', 'final-before-turn'] as const)(
  'does not close or enqueue a matching-branch final when a fresh turn appears %s',
  async order => {
    const conversationId = `matching-branch-with-fresh-turn-${order}`;
    const branch = { responseExchangeId: 'exchange_exact', responseWorkingId: 'working_exact' };
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'durable-turn' },
      { kind: 'assistant_message', time: 11, turnId: 'durable-turn', messageId: 'partial', text: 'Working.', state: 'streaming', ...branch }
    ]);
    const final = { kind: 'assistant_message' as const, time: 20, turnId: 'replacement-page-turn',
      messageId: 'distinct-final', providerMessageId: 'provider-final', text: 'Completed.', state: 'final' as const,
      final: true, activeNow: true, goalEligible: true, ...branch };
    const start = { kind: 'turn_start' as const, time: 21, turnId: 'fresh-turn' };
    const observed = await recordChatObservations(conversationId, order === 'turn-before-final' ? [start, final] : [final, start]);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('fresh-turn');
    expect(observed.activity.endedTurnId).toBeUndefined();
    expect(observed.goalCandidates).toEqual([]);
    expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
  }
);

it('keeps an explicit Goal candidate for a legitimate fast new turn in one batch', async () => {
  const conversationId = 'fresh-user-turn-final-one-batch';
  const observed = await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 10, turnId: 'fresh-turn', messageId: 'fresh-user', text: 'New work', authoredNow: true },
    { kind: 'turn_start', time: 11, turnId: 'fresh-turn' },
    { kind: 'assistant_message', time: 12, turnId: 'fresh-turn', messageId: 'fresh-final',
      providerMessageId: 'fresh-provider', text: 'Completed.', state: 'final', final: true, goalEligible: true },
    { kind: 'turn_end', time: 13, turnId: 'fresh-turn', outcome: 'completed' }
  ]);
  expect(observed.goalCandidates).toHaveLength(1);
  expect(observed.goalCandidates[0]).toMatchObject({ replyId: 'fresh-final', turnId: 'fresh-turn' });
});

it('rejects a replacement page turn whose response branch contradicts the durable owner', async () => {
  const conversationId = 'replacement-wrong-response-branch';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'durable-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'durable-turn', messageId: 'durable-partial',
      text: 'Working.', state: 'streaming', responseExchangeId: 'exchange_current', responseWorkingId: 'working_current' }
  ]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const observed = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, turnId: 'replacement-page-turn', messageId: 'wrong-branch-final',
    providerMessageId: 'provider-final', text: 'Different branch.', state: 'final', final: true, activeNow: true,
    goalEligible: true, responseExchangeId: 'exchange_other', responseWorkingId: 'working_other'
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('durable-turn');
  expect(observed.activity.endedTurnId).toBeUndefined();
  expect(observed.activity.terminal).toBe(false);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
  const stored = (await readEvents(opened.sessionId!, { kinds: ['assistant_message'] })).at(-1);
  expect(stored).not.toHaveProperty('turnId');
  expect(stored).not.toHaveProperty('goalEligible');
  expect(observed.goalCandidates).toEqual([]);
});

it('does not bind a live response branch through a provider alias owned by an ended turn', async () => {
  const conversationId = 'historical-provider-alias-cannot-bind-live-branch';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'ended-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'ended-turn', messageId: 'historical-answer',
      providerMessageId: 'shared-provider-id', text: 'Historical.', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'ended-turn', outcome: 'completed' },
    { kind: 'turn_start', time: 20, turnId: 'live-turn' }
  ]);
  await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 21, turnId: 'live-turn', messageId: 'provider-alias-remount',
    providerMessageId: 'shared-provider-id', text: 'Historical remount.', state: 'streaming', activeNow: true,
    responseExchangeId: 'exchange_live', responseWorkingId: 'working_live'
  }]);
  const attempted = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 30, turnId: 'replacement-page-turn', messageId: 'distinct-final',
    providerMessageId: 'distinct-provider-id', text: 'Unproven completion.', state: 'final', final: true, activeNow: true,
    responseExchangeId: 'exchange_live', responseWorkingId: 'working_live'
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('live-turn');
  expect(attempted.activity.endedTurnId).toBeUndefined();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
});

it('does not trust a differing known historical turn id for active replacement content', async () => {
  const conversationId = 'known-historical-replacement-id';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'historical-turn' },
    { kind: 'turn_end', time: 12, turnId: 'historical-turn', outcome: 'completed' },
    { kind: 'turn_start', time: 20, turnId: 'live-turn' }
  ]);
  const observed = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 30, turnId: 'historical-turn', messageId: 'new-active-answer',
    providerMessageId: 'new-provider', text: 'Unproven.', state: 'final', final: true, activeNow: true, goalEligible: true
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('live-turn');
  expect(observed.goalCandidates).toEqual([]);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] })).at(-1)).not.toHaveProperty('turnId');
});

it.each([
  ['inactive exact branch', false, 'exchange_current', 'working_current'],
  ['missing exchange id', true, undefined, 'working_current'],
  ['missing working id', true, 'exchange_current', undefined]
] as const)('does not recover a replacement page turn from %s', async (_case, activeNow, exchangeId, workingId) => {
  const conversationId = `insufficient-branch-proof-${_case}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'durable-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'durable-turn', messageId: 'durable-partial',
      text: 'Working.', state: 'streaming', responseExchangeId: 'exchange_current', responseWorkingId: 'working_current' }
  ]);
  const observed = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, turnId: 'replacement-page-turn', messageId: `insufficient-${_case}`,
    providerMessageId: `provider-${_case}`, text: 'Unproven final.', state: 'final', final: true, activeNow,
    ...(exchangeId ? { responseExchangeId: exchangeId } : {}),
    ...(workingId ? { responseWorkingId: workingId } : {})
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('durable-turn');
  expect(observed.activity.endedTurnId).toBeUndefined();
  expect(observed.activity.terminal).toBe(false);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});

it('rejects a distinct final from a different response branch', async () => {
  const conversationId = 'wrong-response-branch-final';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'current-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'current-partial',
      text: 'Working.', state: 'streaming', responseExchangeId: 'exchange_current', responseWorkingId: 'working_current' }
  ]);
  const observed = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, messageId: 'old-final', text: 'Old answer.', state: 'final', final: true,
    activeNow: true, responseExchangeId: 'exchange_old', responseWorkingId: 'working_old'
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('current-turn');
  expect(observed.activity.terminal).toBe(false);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});

it('fails closed when one local turn has contradictory response branches', async () => {
  const conversationId = 'ambiguous-response-branches';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'current-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'first-branch',
      text: 'First.', state: 'streaming', responseExchangeId: 'exchange_one', responseWorkingId: 'working_one' },
    { kind: 'assistant_message', time: 12, turnId: 'current-turn', messageId: 'second-branch',
      text: 'Second.', state: 'streaming', responseExchangeId: 'exchange_two', responseWorkingId: 'working_two' }
  ]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, turnId: 'replacement-page-turn', messageId: 'ambiguous-final', text: 'Answer.', state: 'final', final: true,
    activeNow: true, responseExchangeId: 'exchange_one', responseWorkingId: 'working_one'
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('current-turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] })).at(-1)).not.toHaveProperty('turnId');
});

it('persists canonical response-branch ambiguity across restart', async () => {
  const conversationId = 'canonical-response-branch-ambiguity';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'current-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'canonical-answer',
      providerMessageId: 'canonical-provider', text: 'First.', state: 'streaming',
      responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' },
    { kind: 'assistant_message', time: 12, turnId: 'current-turn', messageId: 'provider-alias-remount',
      providerMessageId: 'canonical-provider', text: 'Second.', state: 'streaming',
      responseExchangeId: 'exchange_b', responseWorkingId: 'working_b' }
  ]);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))[0]).toMatchObject({
    responseExchangeId: 'exchange_a', responseWorkingId: 'working_a', responseBranchAmbiguous: true
  });
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, turnId: 'replacement-page-turn', messageId: 'distinct-final',
    providerMessageId: 'distinct-provider', text: 'Completed.', state: 'final', final: true, activeNow: true,
    responseExchangeId: 'exchange_b', responseWorkingId: 'working_b'
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('current-turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});

it('does not close or enqueue the contradictory canonical revision that creates ambiguity', async () => {
  const conversationId = 'canonical-final-creates-ambiguity';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'current-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'canonical-answer',
      providerMessageId: 'canonical-provider', text: 'Working.', state: 'streaming',
      responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' }
  ]);
  const observed = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, turnId: 'replacement-page-turn', messageId: 'provider-alias-remount',
    providerMessageId: 'canonical-provider', text: 'Contradictory final.', state: 'final', final: true,
    activeNow: true, goalEligible: true, responseExchangeId: 'exchange_b', responseWorkingId: 'working_b'
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('current-turn');
  expect(observed.goalCandidates).toEqual([]);
  expect(observed.activity.terminal).toBe(false);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))[0]).toMatchObject({
    turnId: 'current-turn', responseBranchAmbiguous: true
  });
});

it.each([
  ['final-before-conflict', 'provider-alias'],
  ['conflict-before-final', 'provider-alias'],
  ['final-before-conflict', 'distinct-message'],
  ['conflict-before-final', 'distinct-message']
] as const)(
  'fails closed for whole-batch response ambiguity (%s, %s)',
  async (order, conflictKind) => {
    const conversationId = `whole-batch-ambiguity-${order}-${conflictKind}`;
    const branchA = { responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' };
    const branchB = { responseExchangeId: 'exchange_b', responseWorkingId: 'working_b' };
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'current-turn' },
      { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'canonical-partial',
        providerMessageId: 'canonical-provider', text: 'Working.', state: 'streaming', ...branchA }
    ]);
    const final = { kind: 'assistant_message' as const, time: 20, turnId: 'replacement-page-turn',
      messageId: 'safe-final-remount', providerMessageId: 'canonical-provider', text: 'Completed.',
      state: 'final' as const, final: true, activeNow: true, goalEligible: true, ...branchA };
    const conflict = { kind: 'assistant_message' as const, time: 21, turnId: 'replacement-page-turn',
      messageId: 'conflicting-snapshot',
      providerMessageId: conflictKind === 'provider-alias' ? 'canonical-provider' : 'distinct-provider',
      text: 'Contradictory branch.', state: 'streaming' as const, activeNow: true, ...branchB };
    const observed = await recordChatObservations(conversationId,
      order === 'final-before-conflict' ? [final, conflict] : [conflict, final]);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('current-turn');
    expect(observed.goalCandidates).toEqual([]);
    expect(observed.activity.terminal).toBe(false);
    expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
  }
);

it.each(['active-final-before-inactive-conflict', 'inactive-conflict-before-active-final'] as const)(
  'retracts provisional recovery when canonical ambiguity appears later in batch order: %s',
  async order => {
    const conversationId = `post-upsert-batch-ambiguity-${order}`;
    const branchA = { responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' };
    const branchB = { responseExchangeId: 'exchange_b', responseWorkingId: 'working_b' };
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'current-turn' },
      { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'canonical-answer',
        providerMessageId: 'canonical-provider', text: 'Working.', state: 'streaming', ...branchA }
    ]);
    const final = { kind: 'assistant_message' as const, time: 20, turnId: 'replacement-page-turn',
      messageId: 'active-final-remount', providerMessageId: 'canonical-provider', text: 'Completed.',
      state: 'final' as const, final: true, activeNow: true, goalEligible: true, ...branchA };
    const conflict = { kind: 'assistant_message' as const, time: 21, turnId: 'historical-page-turn',
      messageId: 'inactive-provider-alias', providerMessageId: 'canonical-provider', text: 'Contradictory final.',
      state: 'final' as const, final: true, activeNow: false, ...branchB };
    const observed = await recordChatObservations(conversationId,
      order === 'active-final-before-inactive-conflict' ? [final, conflict] : [conflict, final]);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('current-turn');
    expect(observed.goalCandidates).toEqual([]);
    expect(observed.activity.terminal).toBe(false);
    expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
  }
);

it('retracts an unowned uncertain-end final when a later alias makes its durable turn ambiguous', async () => {
  const conversationId = 'unowned-uncertain-final-before-alias-conflict';
  const branchA = { responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' };
  const branchB = { responseExchangeId: 'exchange_b', responseWorkingId: 'working_b' };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'current-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'canonical-answer',
      providerMessageId: 'canonical-provider', text: 'Working.', state: 'streaming', ...branchA }
  ]);
  const unownedFinal = { kind: 'assistant_message' as const, time: 20, messageId: 'unowned-final',
    providerMessageId: 'unowned-provider', text: 'Apparently complete.', state: 'final' as const, final: true };
  const observed = await recordChatObservations(conversationId, [
    unownedFinal,
    { kind: 'assistant_message', time: 21, turnId: 'current-turn', messageId: 'provider-alias-conflict',
      providerMessageId: 'canonical-provider', text: 'Conflicting branch.', state: 'final', final: true,
      activeNow: false, ...branchB },
    { kind: 'turn_end', time: 22, turnId: 'current-turn', outcome: 'unknown' }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(observed.goalCandidates).toEqual([]);
  expect(observed.activity.terminal).toBe(false);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))
    .find(event => event.kind === 'assistant_message' && event.messageId === 'unowned-final'))
    .not.toHaveProperty('goalEligible');

  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const replay = await recordChatObservations(conversationId, [unownedFinal]);
  expect(replay.goalCandidates).toEqual([]);
  expect(replay.activity.terminal).toBe(false);
});

it('finds a distinct canonical branch conflict even after an uncertain end clears live ownership', async () => {
  const conversationId = 'distinct-branch-after-uncertain-end';
  const branchA = { responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' };
  const branchB = { responseExchangeId: 'exchange_b', responseWorkingId: 'working_b' };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'current-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'canonical-answer',
      providerMessageId: 'canonical-provider', text: 'Working.', state: 'streaming', ...branchA }
  ]);
  const activeFinal = { kind: 'assistant_message' as const, time: 20, turnId: 'current-turn',
    messageId: 'canonical-answer', providerMessageId: 'canonical-provider', text: 'Apparently complete.',
    state: 'final' as const, final: true, activeNow: true, goalEligible: true, ...branchA };
  const observed = await recordChatObservations(conversationId, [
    activeFinal,
    { kind: 'turn_end', time: 21, turnId: 'current-turn', outcome: 'unknown' },
    { kind: 'assistant_message', time: 22, turnId: 'current-turn', messageId: 'distinct-conflict',
      providerMessageId: 'distinct-provider', text: 'Another branch.', state: 'final', final: true,
      activeNow: false, ...branchB }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(observed.goalCandidates).toEqual([]);
  expect(observed.activity.terminal).toBe(false);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))
    .find(event => event.kind === 'assistant_message' && event.messageId === 'canonical-answer'))
    .not.toHaveProperty('goalEligible');

  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const replay = await recordChatObservations(conversationId, [activeFinal]);
  expect(replay.goalCandidates).toEqual([]);
  expect(replay.activity.terminal).toBe(false);
});

it('promotes Goal eligibility on the latest canonical final without restoring older text', async () => {
  const conversationId = 'latest-final-survives-deferred-eligibility';
  const branch = { responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'current-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'canonical-answer',
      providerMessageId: 'canonical-provider', text: 'Working.', state: 'streaming', ...branch }
  ]);
  const observed = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, turnId: 'current-turn', messageId: 'canonical-answer',
      providerMessageId: 'canonical-provider', text: 'Earlier final.', state: 'final', final: true,
      activeNow: true, goalEligible: true, ...branch },
    { kind: 'assistant_message', time: 21, turnId: 'current-turn', messageId: 'canonical-answer',
      providerMessageId: 'canonical-provider', text: 'Later complete final.', state: 'final', final: true,
      activeNow: false, ...branch }
  ]);
  expect(observed.goalCandidates).toHaveLength(1);
  expect(observed.activity.terminal).toBe(true);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))[0]).toMatchObject({
    message: { text: 'Later complete final.' }, goalEligible: true
  });
});

it('fences ambiguity for an uncertain turn that starts and ends in one observation batch', async () => {
  const conversationId = 'same-batch-fresh-uncertain-ambiguity';
  const unownedFinal = { kind: 'assistant_message' as const, time: 20, messageId: 'unowned-final',
    providerMessageId: 'unowned-provider', text: 'Apparently complete.', state: 'final' as const, final: true };
  const observed = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'fresh-turn' },
    unownedFinal,
    { kind: 'assistant_message', time: 21, turnId: 'fresh-turn', messageId: 'branch-a',
      providerMessageId: 'provider-a', text: 'Branch A.', state: 'final', final: true,
      responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' },
    { kind: 'assistant_message', time: 22, turnId: 'fresh-turn', messageId: 'branch-b',
      providerMessageId: 'provider-b', text: 'Branch B.', state: 'final', final: true,
      responseExchangeId: 'exchange_b', responseWorkingId: 'working_b' },
    { kind: 'turn_end', time: 23, turnId: 'fresh-turn', outcome: 'unknown' }
  ]);
  expect(observed.goalCandidates).toEqual([]);
  expect(observed.activity.terminal).toBe(false);
  expect((await readEvents(observed.sessionId!, { kinds: ['assistant_message'] }))
    .find(event => event.kind === 'assistant_message' && event.messageId === 'unowned-final'))
    .not.toHaveProperty('goalEligible');
});

it.each([
  ['user-first', false], ['final-first', false], ['user-first', true], ['final-first', true]
] as const)(
  'a fresh user supersedes prior uncertain recovery (%s, restart=%s)',
  async (order, restart) => {
    const conversationId = `fresh-user-supersedes-prior-uncertain-${order}-${restart}`;
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'old-turn' },
      { kind: 'turn_end', time: 20, turnId: 'old-turn', outcome: 'unknown' }
    ]);
    if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
    const user = { kind: 'user_message' as const, time: 30, messageId: 'new-user',
      text: 'This is new work.', authoredNow: true };
    const final = { kind: 'assistant_message' as const, time: 31, messageId: 'late-old-final',
      providerMessageId: 'late-old-provider', text: 'Late old answer.', state: 'final' as const, final: true };
    const observed = await recordChatObservations(conversationId,
      order === 'user-first' ? [user, final] : [final, user]);
    expect(observed.goalCandidates).toEqual([]);
    expect(observed.activity.terminal).toBe(false);
  }
);

it('does not mistake the opening user of a same-batch uncertain turn for superseding work', async () => {
  const conversationId = 'same-batch-opening-user-is-not-supersession';
  const observed = await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 5, turnId: 'fresh-turn', messageId: 'opening-user',
      text: 'Do this work.', authoredNow: true },
    { kind: 'turn_start', time: 10, turnId: 'fresh-turn' },
    { kind: 'assistant_message', time: 20, messageId: 'fresh-final', providerMessageId: 'fresh-provider',
      text: 'Completed.', state: 'final', final: true },
    { kind: 'turn_end', time: 21, turnId: 'fresh-turn', outcome: 'unknown' }
  ]);
  expect(observed.goalCandidates).toEqual([expect.objectContaining({
    replyId: 'fresh-final', turnId: 'reply:fresh-final'
  })]);
});

it.each([
  ['without-user', 'start-before-final', false], ['with-user', 'start-before-final', false],
  ['without-user', 'final-before-start', false], ['with-user', 'final-before-start', false],
  ['without-user', 'start-before-final', true], ['with-user', 'start-before-final', true],
  ['without-user', 'final-before-start', true], ['with-user', 'final-before-start', true]
] as const)(
  'recovers a fresh unbound branch without reviving a stale open turn (%s, %s, restart=%s)',
  async (userMode, order, restart) => {
    const conversationId = `fresh-turn-after-stale-open-${userMode}-${order}-${restart}`;
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 1, turnId: 'stale-open-turn' },
      { kind: 'assistant_message', time: 2, turnId: 'stale-open-turn', messageId: 'stale-partial',
        providerMessageId: 'stale-provider', text: 'Old work.', state: 'streaming',
        responseExchangeId: 'exchange_old', responseWorkingId: 'working_old' }
    ]);
    if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
    const openingUser = userMode === 'with-user' ? [{ kind: 'user_message' as const, time: 5,
      turnId: 'fresh-turn', messageId: 'opening-user', text: 'New work.', authoredNow: true }] : [];
    const start = { kind: 'turn_start' as const, time: 10, turnId: 'fresh-turn' };
    const final = { kind: 'assistant_message' as const, time: 20, messageId: 'fresh-final',
      providerMessageId: 'fresh-provider', text: 'Completed.', state: 'final' as const, final: true,
      activeNow: true, responseExchangeId: 'exchange_new', responseWorkingId: 'working_new' };
    const end = { kind: 'turn_end' as const, time: 21, turnId: 'fresh-turn', outcome: 'unknown' as const };
    const observations = order === 'start-before-final'
      ? [...openingUser, start, final, end]
      : [...openingUser, final, start, end];
    const observed = await recordChatObservations(conversationId, observations);
    expect(observed.goalCandidates).toEqual([expect.objectContaining({
      replyId: 'fresh-final', turnId: 'reply:fresh-final'
    })]);
    expect(observed.activity.terminal).toBe(true);
    expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toEqual([
      expect.objectContaining({ turnId: 'fresh-turn', outcome: 'unknown' })
    ]);
  }
);

it.each(['start-before-final', 'final-before-start'] as const)(
  'does not mix a stale open branch with a fresh explicit turn branch (%s)',
  async order => {
    const conversationId = `fresh-explicit-branch-after-stale-open-${order}`;
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 1, turnId: 'stale-open-turn' },
      { kind: 'assistant_message', time: 2, turnId: 'stale-open-turn', messageId: 'stale-partial',
        providerMessageId: 'stale-provider', text: 'Old work.', state: 'streaming',
        responseExchangeId: 'exchange_old', responseWorkingId: 'working_old' }
    ]);
    const start = { kind: 'turn_start' as const, time: 10, turnId: 'fresh-turn' };
    const final = { kind: 'assistant_message' as const, time: 20, turnId: 'fresh-turn',
      messageId: 'fresh-final', providerMessageId: 'fresh-provider', text: 'New completion.',
      state: 'final' as const, final: true, activeNow: true, goalEligible: true,
      responseExchangeId: 'exchange_new', responseWorkingId: 'working_new' };
    const end = { kind: 'turn_end' as const, time: 21, turnId: 'fresh-turn', outcome: 'completed' as const };
    const observed = await recordChatObservations(conversationId,
      order === 'start-before-final' ? [start, final, end] : [final, start, end]);
    expect(observed.goalCandidates).toEqual([expect.objectContaining({
      replyId: 'fresh-final', turnId: 'fresh-turn'
    })]);
    expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toEqual([
      expect.objectContaining({ turnId: 'fresh-turn', outcome: 'completed' })
    ]);
  }
);

it.each([
  ['provider-alias', 'start-before-final', false], ['matching-branch', 'start-before-final', false],
  ['provider-alias', 'final-before-start', false], ['matching-branch', 'final-before-start', false],
  ['provider-alias', 'start-before-final', true], ['matching-branch', 'start-before-final', true],
  ['provider-alias', 'final-before-start', true], ['matching-branch', 'final-before-start', true]
] as const)(
  'does not assign an old canonical answer to a fresh uncertain turn (%s, %s, restart=%s)',
  async (identity, order, restart) => {
    const conversationId = `old-canonical-inside-fresh-turn-${identity}-${order}-${restart}`;
    const branch = { responseExchangeId: 'exchange_old', responseWorkingId: 'working_old' };
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 1, turnId: 'stale-open-turn' },
      { kind: 'assistant_message', time: 2, turnId: 'stale-open-turn', messageId: 'old-answer',
        providerMessageId: 'old-provider', text: 'Old work.', state: 'streaming', ...branch }
    ]);
    if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
    const start = { kind: 'turn_start' as const, time: 10, turnId: 'fresh-turn' };
    const oldFinal = { kind: 'assistant_message' as const, time: 20,
      messageId: identity === 'provider-alias' ? 'old-answer-remount' : 'old-answer-distinct',
      providerMessageId: identity === 'provider-alias' ? 'old-provider' : 'old-provider-distinct',
      text: 'Old completion remounted.', state: 'final' as const, final: true,
      activeNow: true, goalEligible: true,
      ...(identity === 'matching-branch' ? branch : {}) };
    const end = { kind: 'turn_end' as const, time: 21, turnId: 'fresh-turn', outcome: 'unknown' as const };
    const observed = await recordChatObservations(conversationId,
      order === 'start-before-final' ? [start, oldFinal, end] : [oldFinal, start, end]);
    expect(observed.goalCandidates).toEqual([]);
    expect(observed.activity.terminal).toBe(false);
    expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toEqual([
      expect.objectContaining({ turnId: 'fresh-turn', outcome: 'unknown' })
    ]);
  }
);

it.each([
  ['direct-id', false], ['provider-alias', false], ['direct-id', true], ['provider-alias', true]
] as const)(
  'does not enqueue an old canonical final under a newer live turn (%s, restart=%s)',
  async (identity, restart) => {
    const conversationId = `old-canonical-under-new-live-${identity}-${restart}`;
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 1, turnId: 'old-turn' },
      { kind: 'assistant_message', time: 2, turnId: 'old-turn', messageId: 'old-answer',
        providerMessageId: 'old-provider', text: 'Old completion.', state: 'final', final: true },
      { kind: 'turn_end', time: 3, turnId: 'old-turn', outcome: 'completed' }
    ]);
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'new-turn' }
    ]);
    if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
    const observed = await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: 20, turnId: 'new-turn',
      messageId: identity === 'direct-id' ? 'old-answer' : 'old-answer-remount',
      providerMessageId: 'old-provider', text: 'Old completion remounted.', state: 'final', final: true,
      activeNow: true, goalEligible: true
    }]);
    expect(observed.goalCandidates).toEqual([]);
    expect(observed.activity.terminal).toBe(false);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('new-turn');
  }
);

it.each([false, true])(
  'does not re-emit persisted eligibility from an unbound old answer while a newer turn is live (restart=%s)',
  async restart => {
    const conversationId = `persisted-old-eligibility-under-new-live-${restart}`;
    const oldFinal = { kind: 'assistant_message' as const, time: 2, turnId: 'old-turn',
      messageId: 'old-answer', providerMessageId: 'old-provider', text: 'Old completion.',
      state: 'final' as const, final: true, goalEligible: true };
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 1, turnId: 'old-turn' },
      oldFinal,
      { kind: 'turn_end', time: 3, turnId: 'old-turn', outcome: 'completed' }
    ]);
    expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))[0])
      .toMatchObject({ goalEligible: true });
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'new-turn' }
    ]);
    if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
    const observed = await recordChatObservations(conversationId, [{
      ...oldFinal, time: 20, turnId: undefined, activeNow: true, goalEligible: undefined
    }]);
    expect(observed.goalCandidates).toEqual([]);
    expect(observed.activity.terminal).toBe(false);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('new-turn');
  }
);

it.each([
  ['same-branch', false], ['different-branch', false],
  ['same-branch', true], ['different-branch', true]
] as const)(
  'checks an unbound final against the prior uncertain turn branch (%s, restart=%s)',
  async (branchMode, restart) => {
    const conversationId = `prior-uncertain-unbound-branch-${branchMode}-${restart}`;
    const branchA = { responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' };
    const branchB = { responseExchangeId: 'exchange_b', responseWorkingId: 'working_b' };
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'uncertain-turn' },
      { kind: 'assistant_message', time: 11, turnId: 'uncertain-turn', messageId: 'partial',
        providerMessageId: 'partial-provider', text: 'Working.', state: 'streaming', ...branchA },
      { kind: 'turn_end', time: 12, turnId: 'uncertain-turn', outcome: 'unknown' }
    ]);
    if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
    const observed = await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: 20, messageId: 'distinct-final',
      providerMessageId: 'distinct-provider', text: 'Completed.', state: 'final', final: true,
      activeNow: true, ...(branchMode === 'same-branch' ? branchA : branchB)
    }]);
    if (branchMode === 'same-branch') {
      expect(observed.goalCandidates).toEqual([expect.objectContaining({
        replyId: 'distinct-final', turnId: 'reply:distinct-final'
      })]);
      expect(observed.activity.terminal).toBe(true);
    } else {
      expect(observed.goalCandidates).toEqual([]);
      expect(observed.activity.terminal).toBe(false);
      expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))
        .find(event => event.kind === 'assistant_message' && event.messageId === 'distinct-final'))
        .not.toHaveProperty('goalEligible');
    }
  }
);

it('keeps an unbound branch-conflict fence durable across a second restart', async () => {
  const conversationId = 'prior-uncertain-unbound-conflict-second-restart';
  const branchA = { responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' };
  const branchB = { responseExchangeId: 'exchange_b', responseWorkingId: 'working_b' };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'uncertain-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'uncertain-turn', messageId: 'owned-anchor',
      providerMessageId: 'owned-provider', text: 'Working.', state: 'streaming', ...branchA },
    { kind: 'turn_end', time: 12, turnId: 'uncertain-turn', outcome: 'unknown' }
  ]);
  const rejected = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, messageId: 'unbound-conflict',
    providerMessageId: 'unbound-provider', text: 'Contradictory final.', state: 'final', final: true,
    activeNow: true, ...branchB
  }]);
  expect(rejected.goalCandidates).toEqual([]);
  expect(rejected.activity.terminal).toBe(false);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))
    .find(event => event.kind === 'assistant_message' && event.messageId === 'owned-anchor'))
    .toMatchObject({ responseBranchAmbiguous: true });

  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const replay = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 30, messageId: 'unbound-same-branch-after-restart',
    providerMessageId: 'unbound-same-provider', text: 'Looks consistent in isolation.',
    state: 'final', final: true, activeNow: true, ...branchA
  }]);
  expect(replay.goalCandidates).toEqual([]);
  expect(replay.activity.terminal).toBe(false);
});

it('restores the latest published uncertain turn when end timestamps arrive out of order', async () => {
  const conversationId = 'latest-published-uncertain-end';
  const olderBranch = { responseExchangeId: 'exchange_old', responseWorkingId: 'working_old' };
  const latestBranch = { responseExchangeId: 'exchange_latest', responseWorkingId: 'working_latest' };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'older-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'older-turn', messageId: 'older-partial',
      providerMessageId: 'older-provider', text: 'Older work.', state: 'streaming', ...olderBranch },
    { kind: 'turn_end', time: 100, turnId: 'older-turn', outcome: 'unknown' },
    { kind: 'turn_start', time: 20, turnId: 'latest-turn' },
    { kind: 'assistant_message', time: 21, turnId: 'latest-turn', messageId: 'latest-partial',
      providerMessageId: 'latest-provider', text: 'Latest work.', state: 'streaming', ...latestBranch },
    // Delayed publication: this is the latest journal event despite its earlier timestamp.
    { kind: 'turn_end', time: 30, turnId: 'latest-turn', outcome: 'unknown' }
  ]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();

  const observed = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 110, messageId: 'latest-final',
    providerMessageId: 'latest-final-provider', text: 'Latest work completed.',
    state: 'final', final: true, activeNow: true, ...latestBranch
  }]);

  expect(observed.activity.terminal).toBe(true);
  expect(observed.goalCandidates).toEqual([expect.objectContaining({
    replyId: 'latest-final', turnId: 'reply:latest-final'
  })]);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))
    .find(event => event.kind === 'assistant_message' && event.messageId === 'latest-final'))
    .toMatchObject({ responseExchangeId: latestBranch.responseExchangeId });
});

it.each(['branch ambiguity', 'fresh user'] as const)(
  'does not re-emit persisted Goal eligibility through later %s',
  async hazard => {
    const conversationId = `persisted-goal-eligibility-${hazard}`;
    const turnId = 'reopened-turn';
    const branch = { responseExchangeId: 'exchange_a', responseWorkingId: 'working_a' };
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId },
      { kind: 'assistant_message', time: 11, turnId, messageId: 'canonical-answer',
        providerMessageId: 'canonical-provider', text: 'Working.', state: 'streaming', ...branch }
    ]);
    const first = await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: 20, turnId, messageId: 'canonical-answer',
      providerMessageId: 'canonical-provider', text: 'First final.', state: 'final', final: true,
      goalEligible: true, ...branch
    }]);
    expect(first.goalCandidates).toHaveLength(1);
    await appendEvent(opened.sessionId!, {
      kind: 'turn_start', source: 'app', time: 30, turnId, detail: 'late work reopened this turn'
    });
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();

    const final = hazard === 'branch ambiguity'
      ? { kind: 'assistant_message' as const, time: 40, turnId: 'replacement-page-turn',
          messageId: 'provider-alias-remount', providerMessageId: 'canonical-provider',
          text: 'Contradictory final.', state: 'final' as const, final: true, activeNow: true,
          responseExchangeId: 'exchange_b', responseWorkingId: 'working_b' }
      : { kind: 'assistant_message' as const, time: 40, turnId,
          messageId: 'canonical-answer', providerMessageId: 'canonical-provider',
          text: 'First final.', state: 'final' as const, final: true, ...branch };
    const observations = hazard === 'fresh user'
      ? [{ kind: 'user_message' as const, time: 41, messageId: 'new-user', text: 'New work', authoredNow: true }, final]
      : [final];
    const observed = await recordChatObservations(conversationId, observations);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe(turnId);
    expect(observed.goalCandidates).toEqual([]);
    expect(observed.activity.terminal).toBe(false);
  }
);

it('ignores a replayed known turn start while recovering the current exact branch', async () => {
  const conversationId = 'stale-start-with-current-final';
  const branch = { responseExchangeId: 'exchange_current', responseWorkingId: 'working_current' };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 1, turnId: 'old-turn' },
    { kind: 'turn_end', time: 2, turnId: 'old-turn', outcome: 'completed' },
    { kind: 'turn_start', time: 10, turnId: 'current-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'current-partial',
      providerMessageId: 'current-provider', text: 'Working.', state: 'streaming', ...branch }
  ]);
  const observed = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 1, turnId: 'old-turn' },
    { kind: 'assistant_message', time: 20, turnId: 'replacement-page-turn', messageId: 'current-final',
      providerMessageId: 'current-final-provider', text: 'Completed.', state: 'final', final: true,
      activeNow: true, goalEligible: true, ...branch }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(observed.activity.endedTurnId).toBe('current-turn');
  expect(observed.goalCandidates).toHaveLength(1);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(2);
});

it('ignores a replayed authored user row while recovering the current exact branch', async () => {
  const conversationId = 'replayed-user-with-current-final';
  const branch = { responseExchangeId: 'exchange_current', responseWorkingId: 'working_current' };
  const user = { kind: 'user_message' as const, time: 5, turnId: 'current-turn',
    messageId: 'current-user', text: 'Original request', authoredNow: true };
  const opened = await recordChatObservations(conversationId, [
    user,
    { kind: 'turn_start', time: 10, turnId: 'current-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'current-partial',
      providerMessageId: 'current-provider', text: 'Working.', state: 'streaming', ...branch }
  ]);
  const observed = await recordChatObservations(conversationId, [
    user,
    { kind: 'assistant_message', time: 20, turnId: 'replacement-page-turn', messageId: 'current-final',
      providerMessageId: 'current-final-provider', text: 'Completed.', state: 'final', final: true,
      activeNow: true, goalEligible: true, ...branch }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(observed.activity.endedTurnId).toBe('current-turn');
  expect(observed.goalCandidates).toHaveLength(1);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
});

it('uses the last fresh uncertain end when a later uncertain end is only a replay', async () => {
  const conversationId = 'fresh-uncertain-before-replayed-uncertain';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 1, turnId: 'known-ended-turn' },
    { kind: 'turn_end', time: 2, turnId: 'known-ended-turn', outcome: 'unknown' },
    { kind: 'turn_start', time: 10, turnId: 'current-turn' }
  ]);
  const observed = await recordChatObservations(conversationId, [
    { kind: 'turn_end', time: 15, turnId: 'current-turn', outcome: 'unknown' },
    { kind: 'turn_end', time: 2, turnId: 'known-ended-turn', outcome: 'unknown' },
    { kind: 'assistant_message', time: 20, messageId: 'current-final', providerMessageId: 'current-provider',
      text: 'Completed after the uncertain edge.', state: 'final', final: true }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(observed.goalCandidates).toEqual([expect.objectContaining({
    replyId: 'current-final', turnId: 'reply:current-final'
  })]);
});

it('never synthesizes a recoverable response branch from contradictory partial identity', async () => {
  const conversationId = 'partial-response-identity-ambiguity';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'current-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'current-turn', messageId: 'canonical-answer',
      providerMessageId: 'canonical-provider', text: 'First.', state: 'streaming', responseExchangeId: 'exchange_a' },
    { kind: 'assistant_message', time: 12, turnId: 'current-turn', messageId: 'canonical-answer',
      providerMessageId: 'canonical-provider', text: 'Second.', state: 'streaming',
      responseExchangeId: 'exchange_b', responseWorkingId: 'working_b' }
  ]);
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))[0]).toMatchObject({
    responseExchangeId: 'exchange_b', responseWorkingId: 'working_b', responseBranchAmbiguous: true
  });
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 20, turnId: 'replacement-page-turn', messageId: 'distinct-final',
    providerMessageId: 'distinct-provider', text: 'Completed.', state: 'final', final: true, activeNow: true,
    responseExchangeId: 'exchange_b', responseWorkingId: 'working_b'
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('current-turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});

it.each(['missing', 'current-page-id'])('never closes newer work from an old canonical answer with %s identity', async mode => {
  const conversationId = `historical-final-${mode}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'old-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'old-turn', messageId: 'old-answer', text: 'Old result', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'old-turn', outcome: 'completed' },
    { kind: 'turn_start', time: 20, turnId: 'new-turn' }
  ]);
  const result = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 30, messageId: 'old-answer', text: 'Old result', state: 'final', final: true,
    ...(mode === 'current-page-id' ? { turnId: 'new-turn' } : {})
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('new-turn');
  expect(result.activity.terminal).toBe(false);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
});

it.each(['stopped', 'failed', 'unknown'] as const)('does not turn an explicit %s verdict into completion', async outcome => {
  const conversationId = `explicit-final-${outcome}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'original-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'original-turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Recovered prose', state: 'final', final: true },
    { kind: 'turn_end', time: 21, turnId: 'original-turn', outcome }
  ]);
  const ends = await readEvents(opened.sessionId!, { kinds: ['turn_end'] });
  expect(ends).toHaveLength(1);
  expect(ends[0]).toMatchObject({ outcome });
});

it.each(['canonical', 'explicit'])('keeps a turn reopened for late tools open until fresh %s completion', async completion => {
  const conversationId = `reopened-final-${completion}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'First final', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  await appendEvent(opened.sessionId!, { kind: 'turn_start', source: 'app', time: 20, turnId: 'turn', detail: 'Late tools reopened this turn' });
  resetRecorderForTests();
  await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 30, messageId: 'answer',
    text: 'First final', state: 'final', final: true }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(liveConversations().find(row => row.conversationId === conversationId)?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
  // A fresh canonical revision may finish the same turn; silence cannot.
  await recordChatObservations(conversationId, completion === 'canonical'
    ? [{ kind: 'assistant_message', time: 40, messageId: 'answer', text: 'A new final after the late work.', state: 'final', final: true }]
    : [{ kind: 'turn_end', time: 40, turnId: 'turn', outcome: 'completed' }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
});

it('does not close the old turn after a newer user message arrives in the recovery batch', async () => {
  const conversationId = 'new-user-during-final-recovery';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Final answer', state: 'final', final: true },
    { kind: 'user_message', time: 21, messageId: 'next-user', text: 'New work', authoredNow: true }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});

it('waits for a running tool before accepting a recovered final', async () => {
  const conversationId = 'final-with-running-tool';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  const final = { kind: 'assistant_message' as const, time: 20, messageId: 'answer', text: 'Full answer', state: 'final' as const, final: true };
  await trackInFlight({ startedAt: 12, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { conversationId, requestId: 'running-call', transportKey: null } }, async () => {
    await recordChatObservations(conversationId, [final]);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  });
  await recordChatObservations(conversationId, [final]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
});

it('keeps the exact native final completed when the same Pro request calls tools afterwards', async () => {
  const conversationId = 'native-final-late-tools';
  const requestId = 'wfr_native_final';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'tool_evidence', time: 11, fiberConversationId: conversationId,
      calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId }] }
  ]);
  const call = (startedAt: number) => recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }],
    outcome: 'ok', durationMs: 1, requestId, startedAt });
  await call(12);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, turnId: 'turn', messageId: 'answer', providerMessageId: 'native-answer',
      text: 'Completed native answer', state: 'final', final: true },
    { kind: 'turn_end', time: 21, turnId: 'turn', outcome: 'completed' }
  ]);
  await call(22);
  await call(23);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_start'] })).toHaveLength(1);
  expect(await readEvents(opened.sessionId!, { kinds: ['tool_call'] })).toHaveLength(3);
});

it('dates recovered completion by observation when testing later request activity', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const conversationId = 'final-observation-time';
    const requestId = 'wfr_final_observation';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'turn' },
      { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' },
      { kind: 'tool_evidence', time: 12, fiberConversationId: conversationId,
        calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId }] }
    ]);
    const call = (startedAt: number) => recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok', durationMs: 1, requestId, startedAt });
    await call(100);
    clock.mockReturnValue(2000);
    await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 11, authoredTime: true,
      messageId: 'answer', text: 'Full answer', state: 'final', final: true }]);
    await call(1500); // Started before the final was observed, despite its old creation time.
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
    await call(2001); // This new same-request call really proves the completion false.
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  } finally { clock.mockRestore(); }
});

it.each(['html', 'authored-time', 'goal-eligibility'])('does not settle late work from an old final gaining %s metadata', async metadata => {
  const conversationId = `final-metadata-${metadata}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'First final', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  await appendEvent(opened.sessionId!, { kind: 'turn_start', source: 'app', time: 20, turnId: 'turn', detail: 'Late tools reopened this turn' });
  resetRecorderForTests();
  const oldFinal = { kind: 'assistant_message' as const, time: 30, messageId: 'answer', text: 'First final', state: 'final' as const, final: true,
    ...(metadata === 'html' ? { renderedHtml: '<p>First final</p>' } : {}),
    ...(metadata === 'authored-time' ? { authoredTime: true } : {}),
    ...(metadata === 'goal-eligibility' ? { goalEligible: true } : {}) };
  await recordChatObservations(conversationId, [oldFinal]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await recordChatObservations(conversationId, [oldFinal]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
});

it('repairs a durable app reopen from the exact native final after restart', async () => {
  const conversationId = 'native-final-repair';
  const final = { kind: 'assistant_message' as const, time: 11, turnId: 'turn', messageId: 'answer',
    providerMessageId: 'native-answer', text: 'Completed answer', state: 'final' as const, final: true };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' }, final,
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  await appendEvent(opened.sessionId!, { kind: 'turn_start', source: 'app', time: 20, turnId: 'turn' });
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await recordChatObservations(conversationId, [{ ...final, time: 30 }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(2);
});

it('does not close an old turn when its revised final follows a newer user message in the batch', async () => {
  const conversationId = 'new-user-before-final-recovery';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 21, messageId: 'next-user', text: 'New work', authoredNow: true },
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Final answer', state: 'final', final: true }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});
