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
