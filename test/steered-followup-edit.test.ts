import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as sessionStore from '../src/main/session/store.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionEvent } from '../src/shared/session.js';
import { appendEvent, createSession, initSessionStore, readEvents, resetSessionStoreForTests, unsetSessionRootForTests, upsertMessageEvent } from '../src/main/session/store.js';
import { editReplacement, noteEditReplacement, replacedQuestion, resetEditsForTests } from '../src/main/session/edits.js';
import { flushRecorder, recordChatObservations, resetRecorderForTests } from '../src/main/session/recorder.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, flushDurable, writeDurableNow } from '../src/main/durable.js';
import { configureInputDelivery, listInputs, resetInputForTests, type InputEntry } from '../src/main/session/input.js';
import { recordDeliveredInput } from '../src/main/session/input-history.js';
const T0 = 1793454400000;
const text = (text: string) => ({ text, truncated: false, chars: text.length });

describe('replacement evidence at review boundaries', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-edit-evidence-'));
    initConfigPath(directory);
    initSessionStore(directory);
    resetSessionStoreForTests();
    resetEditsForTests();
    resetRecorderForTests();
    resetInputForTests();
    resetDurableForTests();
    initDurableStore(directory);
    configureInputDelivery({ recordDelivered: recordDeliveredInput, applyAutomation: async () => undefined, changed: () => {} });
    await saveConfig(defaultConfig());
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await flushRecorder();
    await flushDurable();
    resetInputForTests();
    resetDurableForTests();
    configureInputDelivery({ applyAutomation: async () => undefined, changed: () => {} });
    resetRecorderForTests();
    resetEditsForTests();
    resetSessionStoreForTests();
    unsetSessionRootForTests();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('recovers retained edits with one history scan per session and remembers a pending native echo', async () => {
    const sessions = await Promise.all([0, 1].map(index => createSession({
      title: `Retained edits ${index}`, conversationId: randomUUID()
    })));
    const receipts: InputEntry[] = [];
    for (const session of sessions) {
      for (let index = 0; index < 30; index++) await upsertMessageEvent(session.id, {
        kind: 'user_message', source: 'extension', time: T0 + index,
        messageId: randomUUID(), message: text('Earlier question')
      });
      for (let index = 0; index < 3; index++) {
        const receipt: InputEntry = { id: randomUUID(), sessionId: session.id,
          conversationId: session.conversationId, text: 'Edited question', mode: 'auto', dueAt: 0,
          model: null, reasoningEffort: null, state: 'sent', owner: 'test-page', createdAt: T0 + 40,
          deliveredAt: T0 + 41, messageId: randomUUID(), edit: { messageId: randomUUID() }, historyRecorded: index < 2 };
        receipts.push(receipt);
        if (receipt.historyRecorded) await upsertMessageEvent(session.id, {
          kind: 'user_message', source: 'app', time: receipt.deliveredAt!, messageId: receipt.messageId,
          inputId: receipt.id, message: text(receipt.text)
        });
      }
    }
    await writeDurableNow('session-input', receipts);
    resetInputForTests(); resetEditsForTests(); resetSessionStoreForTests();
    const scans = vi.spyOn(sessionStore, 'readEvents');
    await listInputs();
    for (const session of sessions) expect(scans.mock.calls.filter(([id]) => id === session.id)).toHaveLength(1);
    scans.mockRestore();
    for (const receipt of receipts) {
      expect(editReplacement(receipt.messageId!)).toBe(receipt.edit!.messageId);
      expect((await readEvents(receipt.sessionId!, { kinds: ['user_message'] })).find(event =>
        event.kind === 'user_message' && event.messageId === receipt.messageId)).toMatchObject({
        replaces: receipt.edit!.messageId, replacesConfirmed: true
      });
    }
    const pending = receipts.find(receipt => !receipt.historyRecorded)!;
    await recordChatObservations(pending.conversationId!, [{ kind: 'user_message', time: T0 + 45,
      messageId: pending.messageId!, parentId: 'parent', parentExact: true, text: pending.text }]);
    resetEditsForTests(); resetSessionStoreForTests();
    expect((await readEvents(pending.sessionId!, { kinds: ['user_message'] })).find(event =>
      event.kind === 'user_message' && event.messageId === pending.messageId)).toMatchObject({
      replaces: pending.edit!.messageId, replacesConfirmed: true
    });
  });

  it('confirms an edit without overwriting a native revision queued after the recovery read', async () => {
    const session = await createSession({ title: 'Concurrent edit confirmation' });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: T0,
      messageId: 'edited', message: text('Earlier body') });
    const write = sessionStore.upsertMessageEvent;
    vi.spyOn(sessionStore, 'upsertMessageEvent').mockImplementationOnce((id, event, options) => {
      const revision = write(id, { kind: 'user_message', source: 'extension', time: T0 + 1,
        messageId: 'edited', message: text('Latest native body'), reaction: 'heart' });
      const confirmation = write(id, event, options);
      return Promise.all([revision, confirmation]).then(([, result]) => result);
    });
    await noteEditReplacement(session.id, 'edited', 'original');
    resetSessionStoreForTests();
    expect((await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
      event.kind === 'user_message' && event.messageId === 'edited')).toMatchObject({
      message: text('Latest native body'), reaction: 'heart', replaces: 'original', replacesConfirmed: true
    });
  });

  it('continues recovering peer edits after one canonical confirmation write fails', async () => {
    const session = await createSession({ title: 'Independent edit recovery', conversationId: randomUUID() });
    const receipts: InputEntry[] = [];
    for (let index = 0; index < 2; index++) {
      const original = randomUUID(), edited = randomUUID();
      await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0,
        messageId: original, message: text('Original question') });
      await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: T0 + 10,
        messageId: edited, message: text('Edited question') });
      receipts.push({ id: randomUUID(), sessionId: session.id, conversationId: session.conversationId,
        text: 'Edited question', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null,
        state: 'sent', owner: 'test-page', createdAt: T0 + 10, deliveredAt: T0 + 11,
        messageId: edited, edit: { messageId: original }, historyRecorded: true });
    }
    await writeDurableNow('session-input', receipts);
    resetInputForTests(); resetEditsForTests(); resetSessionStoreForTests();
    const write = vi.spyOn(sessionStore, 'upsertMessageEvent').mockRejectedValueOnce(new Error('temporary write failure'));
    await expect(listInputs()).resolves.toHaveLength(2);
    write.mockRestore();
    const recovered = (await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
      event.kind === 'user_message' && event.messageId === receipts[1]!.messageId);
    expect(recovered).toMatchObject({ replaces: receipts[1]!.edit!.messageId, replacesConfirmed: true });
    const pending = receipts[0]!;
    expect(editReplacement(pending.messageId!)).toBe(pending.edit!.messageId);
    await recordChatObservations(session.conversationId!, [{ kind: 'user_message', time: T0 + 20,
      messageId: pending.messageId!, text: pending.text }]);
    resetEditsForTests(); resetSessionStoreForTests();
    expect((await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
      event.kind === 'user_message' && event.messageId === pending.messageId)).toMatchObject({
      replaces: pending.edit!.messageId, replacesConfirmed: true
    });
  });

  for (const parent of ['missing', 'streaming'] as const) {
    async function questionWithLateParent() {
      const session = await createSession({ title: 'Edit evidence' });
      await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0,
        messageId: 'original', parentId: 'parent', message: text('Original question') });
      if (parent === 'streaming') {
        await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: T0 + 10,
          messageId: 'parent', message: text('Still working'), state: 'streaming', final: false });
      }
      return session;
    }
    it(`keeps a question eligible for an edit with a ${parent} parent`, async () => {
      const session = await questionWithLateParent();
      expect(await replacedQuestion(session.id, 'edited', 'parent')).toEqual({ replaces: 'original' });
    });
    it(`preserves a saved replacement with a ${parent} parent`, async () => {
      const session = await questionWithLateParent();
      await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0 + 20,
        messageId: 'edited', parentId: 'parent', replaces: 'original', message: text('Edited question') });
      resetSessionStoreForTests();
      expect((await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
        event.kind === 'user_message' && event.messageId === 'edited')).toMatchObject({ replaces: 'original' });
    });
  }

  it.each([
    [false, false], [true, false], [false, true], [true, true]
  ])('restores an acknowledged edit after restart (history recorded: %s, native arrives first: %s)', async (historyRecorded, nativeFirst) => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const original = '22222222-2222-4222-8222-222222222222';
    const edited = '33333333-3333-4333-8333-333333333333';
    const session = await createSession({ title: 'Outbox edit recovery', conversationId });
    await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: T0,
      messageId: 'parent', message: text('Working'), state: 'streaming', final: false });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0 + 10,
      messageId: original, parentId: 'parent', message: text('Steered question') });
    await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: T0 + 20,
      messageId: 'parent', message: text('Finished'), state: 'final', final: true });
    const receipt: InputEntry = { id: '11111111-1111-4111-8111-111111111111', sessionId: session.id,
      conversationId, text: 'Edited question', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null,
      state: 'sent', owner: 'test-page', createdAt: T0 + 30, deliveredAt: T0 + 31,
      messageId: edited, edit: { messageId: original }, historyRecorded };
    if (historyRecorded) await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: T0 + 31,
      messageId: edited, inputId: receipt.id, message: text(receipt.text) });
    await writeDurableNow('session-input', [receipt]);
    resetEditsForTests(); resetRecorderForTests(); resetInputForTests(); resetSessionStoreForTests();
    if (!nativeFirst) await listInputs();
    await recordChatObservations(conversationId, [{ kind: 'user_message', time: T0 + 32,
      messageId: edited, parentId: 'parent', parentExact: true, text: receipt.text }]);
    if (nativeFirst) await listInputs();
    await flushRecorder();
    resetEditsForTests(); resetRecorderForTests(); resetInputForTests(); resetSessionStoreForTests();
    expect((await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
      event.kind === 'user_message' && event.messageId === edited)).toMatchObject({ replaces: original, replacesConfirmed: true });
  });

  it.each([undefined, 2])('keeps a replayed native edit when a finished parent first appears between its versions (contentSeq: %s)', async contentSeq => {
    const session = await createSession({ title: 'Replayed terminal parent' });
    const events = [
      { kind: 'user_message', source: 'extension', time: T0, seq: 1,
        messageId: 'original', parentId: 'parent', message: text('Original question') },
      { kind: 'assistant_message', source: 'extension', time: T0 + 10, seq: 2, contentSeq,
        messageId: 'parent', message: text('Already finished'), final: true, state: 'final' },
      { kind: 'user_message', source: 'extension', time: T0 + 20, seq: 3,
        messageId: 'edited', parentId: 'parent', replaces: 'original', message: text('Edited question') }
    ];
    await fs.writeFile(path.join(directory, 'sessions', session.id, 'messages.json'),
      JSON.stringify(Object.fromEntries(events.map(event => [`${event.kind}\u0000${event.messageId}`, event]))));
    resetSessionStoreForTests();
    expect((await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
      event.kind === 'user_message' && event.messageId === 'edited')).toMatchObject({ replaces: 'original' });
  });

  it.each([false, true])('does not treat a final revision as settlement (previous streaming observed: %s)', async streamingObserved => {
    const session = await createSession({ title: 'Revised terminal parent' });
    if (streamingObserved) await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: T0 - 10,
      messageId: 'parent', message: text('Working'), final: false, state: 'streaming' });
    await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: T0,
      messageId: 'parent', message: text('Already finished'), final: true, state: 'final' });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0 + 10,
      messageId: 'original', parentId: 'parent', message: text('Original question') });
    await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: T0 + 20,
      messageId: 'parent', message: text('Finished answer with updated text'), final: true, state: 'final' });
    expect(await replacedQuestion(session.id, 'edited', 'parent')).toEqual({ replaces: 'original' });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0 + 30,
      messageId: 'edited', parentId: 'parent', replaces: 'original', message: text('Edited question') });
    resetSessionStoreForTests();
    expect((await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
      event.kind === 'user_message' && event.messageId === 'edited')).toMatchObject({ replaces: 'original' });
  });

  it('keeps a native edit eligible when a finished parent is first observed after its original question', async () => {
    const session = await createSession({ title: 'Late finished parent' });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0,
      messageId: 'original', parentId: 'parent', message: text('Original question') });
    await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: T0 + 10,
      messageId: 'parent', message: text('Already finished'), final: true, state: 'final' });
    expect(await replacedQuestion(session.id, 'edited', 'parent')).toEqual({ replaces: 'original' });
  });

  it.each(['before', 'after'] as const)('keeps an app-confirmed edit across reopen when acknowledged %s its native echo', async timing => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const session = await createSession({ title: 'Confirmed edit', conversationId });
    await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: T0,
      messageId: 'parent', message: text('Working'), state: 'streaming', final: false });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0 + 10,
      messageId: 'steer', parentId: 'parent', message: text('Steered question') });
    await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: T0 + 20,
      messageId: 'parent', message: text('Finished'), state: 'final', final: true });
    if (timing === 'before') await noteEditReplacement(session.id, 'edited', 'steer');
    else {
      // The native observation may already have inferred this same link before its ACK arrives.
      await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0 + 30,
        messageId: 'edited', parentId: 'parent', replaces: 'steer', message: text('Edited steering question') });
      await noteEditReplacement(session.id, 'edited', 'steer');
    }
    await recordChatObservations(conversationId, [{ kind: 'user_message', time: T0 + 30,
      messageId: 'edited', parentId: 'parent', parentExact: true, text: 'Edited steering question' }]);
    // A sparse replay cannot erase the durable confirmation.
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0 + 30,
      messageId: 'edited', parentId: 'parent', message: text('Edited steering question') });
    await flushRecorder();
    resetRecorderForTests();
    resetEditsForTests();
    resetSessionStoreForTests();
    expect((await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
      event.kind === 'user_message' && event.messageId === 'edited')).toMatchObject({ replaces: 'steer' });
  });

  it('lets an exact edit acknowledgement correct an earlier inferred target', async () => {
    const session = await createSession({ title: 'Confirmed replacement target' });
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'extension', time: T0,
      messageId: 'edited', replaces: 'inferred-target', message: text('Edited question') });
    await noteEditReplacement(session.id, 'edited', 'confirmed-target');
    resetEditsForTests();
    resetSessionStoreForTests();
    expect((await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
      event.kind === 'user_message' && event.messageId === 'edited')).toMatchObject({ replaces: 'confirmed-target' });
  });

  it('repairs an inferred false replacement even when its confirmation value is damaged', async () => {
    const session = await createSession({ title: 'Damaged confirmation' });
    const events = [
      { kind: 'user_message', source: 'extension', time: T0, seq: 2,
        messageId: 'steer', parentId: 'parent', message: text('Steered question') },
      { kind: 'assistant_message', source: 'extension', time: T0 + 10, seq: 3, origin: 1, contentSeq: 3, settledAtSeq: 3,
        messageId: 'parent', message: text('Completed answer'), final: true, state: 'final' },
      { kind: 'user_message', source: 'extension', time: T0 + 20, seq: 4,
        messageId: 'next', parentId: 'parent', replaces: 'steer', replacesConfirmed: 'yes', message: text('Next question') }
    ];
    await fs.writeFile(path.join(directory, 'sessions', session.id, 'messages.json'),
      JSON.stringify(Object.fromEntries(events.map(event => [`${event.kind}\u0000${event.messageId}`, event]))));
    resetSessionStoreForTests();
    const next = (await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
      event.kind === 'user_message' && event.messageId === 'next');
    expect(next).toMatchObject({ messageId: 'next' });
    expect(next).not.toHaveProperty('replaces');
  });
});

describe('steered follow-up edit attribution', () => {
  it('keeps a follow-up under the settled consolidated parent separate while preserving real edits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-steer-continued-'));
    try {
      initConfigPath(dir);
      initSessionStore(dir);
      await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
      resetSessionStoreForTests();
      resetEditsForTests();
      const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const session = await createSession({ title: 'Steered continuation', conversationId });

      // Turn 4 opens and creates the final_answer container before the user steers:
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0, source: 'extension',
        messageId: 'question-initial',
        parentId: 'a0000000-0000-4000-8000-000000000001',
        message: text('Initial question')
      });
      await appendEvent(session.id, {
        kind: 'turn_start', time: T0 + 10, source: 'extension', turnId: 'continued-first'
      });
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 20, source: 'extension',
        turnId: 'continued-first',
        messageId: 'answer-consolidated',
        providerMessageId: 'answer-consolidated',
        message: text('First half of consolidated answer'),
        state: 'streaming', final: false
      });

      // User steers while Turn 4 is still running; Turn 4 ends with continued: true and Turn 5 starts:
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 30, source: 'extension',
        messageId: 'question-steer',
        parentId: 'answer-consolidated',
        message: text('Steered follow-up')
      });
      await appendEvent(session.id, {
        kind: 'turn_end', time: T0 + 31, source: 'extension',
        turnId: 'continued-first', outcome: 'completed', continued: true
      });
      await appendEvent(session.id, {
        kind: 'turn_start', time: T0 + 32, source: 'extension', turnId: 'continued-terminal'
      });

      // ChatGPT appends the continuation's answer to the same final_answer message and completes Turn 5:
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 50, source: 'extension',
        turnId: 'continued-terminal',
        messageId: 'answer-consolidated',
        providerMessageId: 'answer-consolidated',
        message: text('First half of consolidated answer\n\nContinuation answer.'),
        state: 'final', final: true
      });
      await appendEvent(session.id, {
        kind: 'turn_end', time: T0 + 51, source: 'extension',
        turnId: 'continued-terminal', outcome: 'completed'
      });

      // When the queued message for the next turn is sent under the consolidated final answer parentId,
      // it must not be marked as replacing the steered message:
      const replacement = await replacedQuestion(
        session.id,
        'question-next',
        'answer-consolidated'
      );
      expect(replacement).toEqual({});

      // Even if a pre-fix shard on disk carried `replaces: "question-steer"`, reopening the session cleans it:
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 60, source: 'extension',
        messageId: 'question-next',
        parentId: 'answer-consolidated',
        replaces: 'question-steer',
        message: text('Queued next question')
      });
      // A genuine later edit of the post-continuation question under the same parentId still records `replaces`:
      const genuineEdit = await replacedQuestion(
        session.id,
        'question-next-edited',
        'answer-consolidated'
      );
      expect(genuineEdit).toEqual({ replaces: 'question-next' });
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 70, source: 'extension',
        messageId: 'question-next-edited',
        parentId: 'answer-consolidated',
        ...genuineEdit,
        message: text('Edited next question')
      });
      resetSessionStoreForTests();
      const loaded = await readEvents(session.id, { kinds: ['user_message'] });
      const queued = loaded.find(e => e.kind === 'user_message' && e.messageId === 'question-next');
      expect(queued?.kind).toBe('user_message');
      expect(queued?.kind === 'user_message' ? queued.replaces : undefined).toBeUndefined();
      const edited = loaded.find(e => e.kind === 'user_message' && e.messageId === 'question-next-edited');
      expect(edited?.kind).toBe('user_message');
      expect(edited?.kind === 'user_message' ? edited.replaces : undefined).toBe('question-next');
    } finally {
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('repairs a saved replacement using the merged final of provider timestamp aliases', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-steer-aliases-'));
    try {
      initConfigPath(dir);
      initSessionStore(dir);
      resetSessionStoreForTests();
      const session = await createSession({ title: 'Saved continuation aliases' });
      const events: Extract<SessionEvent, { kind: 'assistant_message' | 'user_message' }>[] = [
        { kind: 'assistant_message', seq: 1, time: T0, source: 'extension',
          messageId: 'assistant:working:1000', providerMessageId: 'provider-final',
          message: text('Working'), state: 'streaming', final: false },
        { kind: 'user_message', seq: 2, time: T0 + 10, source: 'extension',
          messageId: 'steer', parentId: 'provider-final', message: text('Continue with the detail') },
        { kind: 'assistant_message', seq: 3, contentSeq: 3, time: T0 + 20, source: 'extension',
          messageId: 'assistant:working:2000', providerMessageId: 'provider-final',
          message: text('Completed answer'), state: 'final', final: true },
        { kind: 'user_message', seq: 4, time: T0 + 30, source: 'extension',
          messageId: 'queued', parentId: 'provider-final', replaces: 'steer', message: text('Next question') }
      ];
      // Old builds saved each timestamp alias separately. Use their legacy snapshot so
      // current upsert deduplication cannot repair the fixture before the read under test.
      const snapshot = Object.fromEntries(events.map(event => [`${event.kind}\u0000${event.messageId}`, event]));
      await fs.writeFile(path.join(dir, 'sessions', session.id, 'messages.json'), JSON.stringify(snapshot));
      resetSessionStoreForTests();
      const loaded = await readEvents(session.id, { kinds: ['assistant_message', 'user_message'] });
      expect(loaded.filter(event => event.kind === 'assistant_message')).toEqual([
        expect.objectContaining({ messageId: 'assistant:working:1000', final: true, origin: 1 })
      ]);
      const queued = loaded.find(event => event.kind === 'user_message' && event.messageId === 'queued');
      expect(queued?.kind).toBe('user_message');
      expect(queued?.kind === 'user_message' ? queued.replaces : undefined).toBeUndefined();
    } finally {
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
