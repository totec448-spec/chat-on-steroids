import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { closeConversation, liveConversations, recordChatObservations, recordToolCall, resetRecorderForTests } from '../src/main/session/recorder.js';
import { emptyEvidence, trackInFlight } from '../src/main/mcp/call-context.js';
import { appendEvent, flushSessions, getSession, initSessionStore, readEvents, readCompletedFinal, upsertMessageEvent, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { sessionInputPolicy } from '../src/main/session/input.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;

it.each(['same', 'new-question', 'new-turn'] as const)('accepts a later native Stop only for its still-current source (%s)', async change => {
  const conversationId = `native-stop-upgrade-${change}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'user_message', messageId: 'stop-question', text: 'Work', time: 10 },
    { kind: 'turn_start', turnId: 'stop-source', time: 11 },
    { kind: 'turn_end', turnId: 'stop-source', outcome: 'interrupted', time: 12 }
  ]);
  if (change === 'new-question') await recordChatObservations(conversationId, [{ kind: 'user_message', messageId: 'new-question', text: 'Next', time: 13 }]);
  if (change === 'new-turn') await recordChatObservations(conversationId, [{ kind: 'turn_start', turnId: 'new-turn', time: 13 }]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const stop = { kind: 'turn_end' as const, turnId: 'stop-source', outcome: 'stopped' as const, time: 14 };
  const accepted = await recordChatObservations(conversationId, [stop]);
  expect(accepted.activity.terminal).toBe(change === 'same');
  await recordChatObservations(conversationId, [stop]);
  const ends = await readEvents(opened.sessionId!, { kinds: ['turn_end'] });
  expect(ends.filter(event => event.kind === 'turn_end' && event.outcome === 'stopped')).toHaveLength(change === 'same' ? 1 : 0);
  if (change === 'new-turn') expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('new-turn');
});

it('finds the latest real work behind a later revision of an old native label', async () => {
  const { readRecentEvents } = await import('../src/main/session/store.js');
  const { workSequence } = await import('../src/shared/session.js');
  const opened = await recordChatObservations('native-label-work-order', [
    { kind: 'turn_start', turnId: 'work-order', time: 10 },
    { kind: 'page_tool', messageId: 'old-step', turnId: 'work-order', text: 'Preparing', time: 11 },
    { kind: 'page_tool', messageId: 'new-step', turnId: 'work-order', text: 'Searching', time: 12 }
  ]);
  const [before] = await readRecentEvents(opened.sessionId!, 1, { kinds: ['page_tool', 'turn_start'] });
  await recordChatObservations('native-label-work-order', [{ kind: 'page_tool', messageId: 'old-step', turnId: 'work-order', text: 'Prepared', time: 13 }]);
  const [after] = await readRecentEvents(opened.sessionId!, 1, { kinds: ['page_tool', 'turn_start'] });
  expect(workSequence(after!)).toBe(workSequence(before!));
});
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
    text: 'The full canonical answer.', state: 'final' as const, final: true,
    ...(mode === 'matching' ? { turnId } : mode === 'replaced' ? { turnId: 'replacement-page-id' } : {}) };
  const recovered = await recordChatObservations(conversationId, [final]);
  const sessionId = opened.sessionId!;
  expect(recovered.sessionId).toBe(sessionId);
  const [message] = await readEvents(sessionId, { kinds: ['assistant_message'] });
  expect(message).toMatchObject({ turnId, state: 'final', message: { text: final.text } });
  expect((await getSession(sessionId))?.activeTurnId).toBeNull();
  expect(liveConversations().find(row => row.conversationId === conversationId)?.activeTurnId).toBeNull();
  expect(recovered.activity).toMatchObject({ terminal: true, endedTurnId: turnId });
  await recordChatObservations(conversationId, [final]);
  expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toHaveLength(1);
});

it.each(['missing', 'current-page-id', 'original-page-id'])('never closes newer work from an old canonical answer with %s identity', async mode => {
  const conversationId = `historical-final-${mode}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'old-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'old-turn', messageId: 'old-answer', text: 'Old result', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'old-turn', outcome: 'completed' },
    { kind: 'turn_start', time: 20, turnId: 'new-turn' }
  ]);
  const result = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 30, messageId: 'old-answer', text: 'Old result, revised', state: 'final', final: true,
    activeNow: true, renderedHtml: '<p>Old result, revised</p>',
    ...(mode === 'current-page-id' ? { turnId: 'new-turn' } : mode === 'original-page-id' ? { turnId: 'old-turn' } : {})
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('new-turn');
  expect(result.activity).toMatchObject({ meaningful: false, working: false, terminal: false });
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
  const revised = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Final answer', state: 'final', final: true, activeNow: true },
    { kind: 'user_message', time: 21, messageId: 'next-user', text: 'New work', authoredNow: true }
  ]);
  expect(revised.activity).toMatchObject({ working: true, terminal: false });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});

it('commits a recovered final while its running tool still blocks delivery', async () => {
  const conversationId = 'final-with-running-tool';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  const final = { kind: 'assistant_message' as const, time: 20, messageId: 'answer', text: 'Full answer', state: 'final' as const, final: true };
  await trackInFlight({ startedAt: 12, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { conversationId, requestId: 'running-call', transportKey: null } }, async () => {
    await recordChatObservations(conversationId, [final]);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
    expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
  });
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
  const revised = await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 21, messageId: 'next-user', text: 'New work', authoredNow: true },
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Final answer', state: 'final', final: true, activeNow: true }
  ]);
  expect(revised.activity).toMatchObject({ working: true, terminal: false });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});


it.each([false, true])('accepts a textless native final only with exact provider identity (%s)', async native => {
  const conversationId = `image-final-${native}`;
  const result = await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 10, messageId: 'image-question', text: 'Generate two images' },
    { kind: 'turn_start', time: 11, turnId: 'image-turn' },
    { kind: 'assistant_message', time: 20, messageId: 'image-final', turnId: 'image-turn', text: '',
      ...(native ? { providerMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } : {}), state: 'final', final: true, goalEligible: true },
    { kind: 'turn_end', time: 21, turnId: 'image-turn', outcome: 'completed' }
  ]);
  expect(!!await readCompletedFinal(result.sessionId!, conversationId)).toBe(native);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  expect(!!await readCompletedFinal(result.sessionId!, conversationId)).toBe(native);
  await recordChatObservations(conversationId, [{ kind: 'user_message', time: 30,
    messageId: 'new-image-question', text: 'Generate another image', authoredNow: true }]);
  expect(await readCompletedFinal(result.sessionId!, conversationId)).toBeNull();
});

it('uses an unowned canonical final as a settled ordinary input boundary without inventing a turn', async () => {
  const conversationId = 'unowned-final-current-question';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'model_selection', time: 1, model: 'gpt-5-6-pro', reasoningEffort: 'pro' },
    { kind: 'user_message', time: 10, messageId: 'question', text: 'Report the findings' },
    { kind: 'assistant_message', time: 20, messageId: 'reply', text: 'Complete report', state: 'final', final: true }
  ]);
  const id = opened.sessionId!;
  expect(await readCompletedFinal(id, conversationId)).toMatchObject({ messageId: 'reply', turnId: null });
  expect(await sessionInputPolicy(id)).toMatchObject({ browserAllowed: true, settled: true });
  expect(await readEvents(id, { kinds: ['turn_start', 'turn_end'] })).toEqual([]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  expect(await readCompletedFinal(id, conversationId)).toMatchObject({ messageId: 'reply', turnId: null });
  await recordChatObservations(conversationId, [{ kind: 'user_message', time: 30, messageId: 'new-question', text: 'New work', authoredNow: true }]);
  await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 40, messageId: 'reply', text: 'Complete report plus metadata', state: 'final', final: true }]);
  expect(await readCompletedFinal(id, conversationId)).toBeNull();
  expect((await sessionInputPolicy(id)).settled).toBe(false);
});

it('preserves final acceptance across metadata, late call recording and restart, but rejects fresh work and rebinding', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const conversationId = 'completion-observed-time';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: 1, messageId: 'question', text: 'Do work' },
      { kind: 'assistant_message', time: 10, messageId: 'answer', text: 'Done', state: 'final', final: true }
    ]);
    const id = opened.sessionId!;
    clock.mockReturnValue(2000);
    await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 10, messageId: 'answer', text: 'Done', renderedHtml: '<p>Done</p>', state: 'final', final: true }]);
    expect(await readCompletedFinal(id, conversationId)).toMatchObject({ completedAt: 1000 });
    const call = (time: number) => appendEvent(id, { kind: 'tool_call', source: 'mcp', time,
      call: { callId: `call-${time}`, tool: 'read', attribution: 'request_id', attributionMethod: 'request_id', conversationId, requestId: 'request',
        args: { text: '{}', chars: 2, truncated: false }, result: { text: 'ok', chars: 2, truncated: false }, summary: { kind: 'read', title: 'Read', tone: 'good' }, outcome: 'ok', durationMs: 1 } });
    await call(500); // Starts after provider creation, before actual final acceptance.
    expect(await readCompletedFinal(id, conversationId)).toMatchObject({ completedAt: 1000 });
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    expect(await readCompletedFinal(id, conversationId)).toMatchObject({ completedAt: 1000 });
    await call(1500);
    expect(await readCompletedFinal(id, conversationId)).toBeNull();
    await upsertMessageEvent(id, { kind: 'assistant_message', source: 'extension', time: 10,
      messageId: 'answer', message: { text: 'A fresh final after more work', chars: 29, truncated: false }, state: 'final', final: true });
    expect(await readCompletedFinal(id, conversationId)).toMatchObject({ completedAt: 2000 });
    expect(await rebindSession(id, conversationId, 'completion-new-binding')).toBe(true);
    expect(await readCompletedFinal(id, conversationId)).toBeNull();
  } finally { clock.mockRestore(); }
});

it.each(['question', 'rebind'] as const)('rejects a final snapshot when %s changes during its disk read', async change => {
  const conversationId = `completion-race-${change}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 1, messageId: 'question', text: 'Do work' },
    { kind: 'assistant_message', time: 2, messageId: 'answer', text: 'Done', state: 'final', final: true }
  ]);
  await flushSessions();
  const originalOpen = fs.open;
  let intercepted = false;
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (!intercepted && String(args[0]).endsWith('events.jsonl') && args[1] === 'r') {
      intercepted = true;
      if (change === 'rebind') await rebindSession(opened.sessionId!, conversationId, 'race-destination');
      else await upsertMessageEvent(opened.sessionId!, { kind: 'user_message', source: 'extension', time: 3,
        messageId: 'new-question', message: { text: 'Next', chars: 4, truncated: false } });
    }
    return originalOpen(...args);
  });
  try {
    expect(await readCompletedFinal(opened.sessionId!, conversationId)).toBeNull();
    expect(intercepted).toBe(true);
  } finally { spy.mockRestore(); }
});
