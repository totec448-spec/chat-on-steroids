import { describe, expect, it } from 'vitest';
import { chronological, effectiveFinalTurnId, projectTimeline, type Chronological } from '../src/shared/chronology.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, createSession, getSession, initSessionStore, readCompletedFinal, readRecentEvents, resetSessionStoreForTests, unsetSessionRootForTests,
  upsertMessageEvent, upsertNativeImageEvent } from '../src/main/session/store.js';
import { flushRecorder, recordChatObservations, resetRecorderForTests } from '../src/main/session/recorder.js';
import { resetEditsForTests } from '../src/main/session/edits.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { getLog } from '../src/main/logger.js';
const T0 = 1793454400000;
const text = (text: string) => ({ text, truncated: false, chars: text.length });

describe('continued final completion', () => {
  it('keeps a final in its original turn when a continued turn has no successor', () => {
    expect(projectTimeline<Chronological>([
      { kind: 'assistant_message', turnId: 'first', seq: 2, contentSeq: 8, time: T0, final: true }
    ], { first: { origin: 1, time: T0, endOrigin: 5, continued: true } })[0]?.turnOrigin).toBe(1);
  });

  it('does not move a final to a continuation that opened after it settled', () => {
    const source: Chronological[] = [
      { kind: 'turn_start', turnId: 'first', seq: 1, origin: 1, time: T0 },
      { kind: 'turn_end', turnId: 'first', seq: 2, origin: 5, time: T0 + 5, continued: true },
      { kind: 'assistant_message', turnId: 'first', seq: 3, origin: 8, contentSeq: 8, time: T0 + 8, final: true },
      { kind: 'turn_start', turnId: 'next', seq: 4, origin: 10, time: T0 + 10 }
    ];
    const turns = {
      first: { origin: 1, time: T0, endOrigin: 5, continued: true as const },
      next: { origin: 10, time: T0 + 10 }
    };
    const projected = projectTimeline<Chronological>(source, turns);
    expect(projected[2]?.turnOrigin).toBe(1);
    const projectedOrder = chronological(projected).map(row => row.seq);
    expect(projectedOrder.indexOf(3)).toBeLessThan(projectedOrder.indexOf(4));
    // Older callers without projection still bound the continuation by when the final settled.
    const legacyOrder = chronological(source).map(row => row.seq);
    expect(legacyOrder.indexOf(3)).toBeLessThan(legacyOrder.indexOf(4));
  });

  it('keeps a locally owned final before its end when projected turn metadata is missing', () => {
    const source: Chronological[] = [
      { kind: 'turn_start', turnId: 'first', seq: 1, origin: 1, time: T0 },
      { kind: 'assistant_message', turnId: 'first', seq: 2, origin: 2, time: T0 + 1, final: true },
      { kind: 'turn_end', turnId: 'first', seq: 3, origin: 3, time: T0 + 2 }
    ];
    const projected = projectTimeline<Chronological>(source, {});
    expect(projected.map(entry => entry.turnOrigin)).toEqual([null, null, null]);
    expect(chronological(projected).map(entry => entry.seq)).toEqual([1, 2, 3]);
  });

  it('recognizes the consolidated final for the terminal steered continuation', async () => {
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
        // The canonical message retains the first segment's owner; its final revision is
        // promoted to the continuation by the recorded end boundary and content position.
        turnId: 'continued-first',
        messageId: 'answer-consolidated',
        providerMessageId: 'answer-consolidated',
        message: text('First half of consolidated answer\n\nContinuation answer.'),
        state: 'final', final: true
      });
      await appendEvent(session.id, {
        kind: 'turn_end', time: T0 + 51, source: 'extension',
        turnId: 'continued-terminal', outcome: 'completed'
      });

      // readCompletedFinal must recognize the consolidated final for both the continuation turn and the session:
      const byTurn = await readCompletedFinal(session.id, conversationId, 'continued-terminal');
      expect(byTurn).toMatchObject({
        messageId: 'answer-consolidated',
        turnId: 'continued-terminal'
      });
      const anyTurn = await readCompletedFinal(session.id, conversationId);
      expect(anyTurn).toMatchObject({
        messageId: 'answer-consolidated',
        turnId: 'continued-terminal'
      });
      expect(await readCompletedFinal(session.id, conversationId, 'continued-first')).toBeNull();

    } finally {
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { outcome: 'failed', reopen: false }, { outcome: 'stopped', reopen: false },
    { outcome: 'completed', reopen: false }, { outcome: 'stalled', reopen: false },
    { outcome: 'failed', reopen: true }, { outcome: 'stopped', reopen: true }
  ] as const)('honors a continuation that $outcome before a delayed consolidated final (reopened=$reopen)', async ({ outcome, reopen }) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-steer-terminal-outcome-'));
    try {
      initConfigPath(dir);
      initSessionStore(dir);
      await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
      resetSessionStoreForTests();
      resetEditsForTests();
      const conversationId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
      const session = await createSession({ title: 'Delayed continuation final', conversationId });
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0, source: 'extension', messageId: 'initial-question', message: text('Initial question')
      });
      await appendEvent(session.id, { kind: 'turn_start', time: T0 + 10, source: 'extension', turnId: 'first' });
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 20, source: 'extension', turnId: 'first',
        messageId: 'consolidated-answer', providerMessageId: 'consolidated-answer',
        message: text('Initial work'), state: 'streaming', final: false
      });
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 30, source: 'extension', messageId: 'continued-question', message: text('Continue')
      });
      await appendEvent(session.id, { kind: 'turn_end', time: T0 + 31, source: 'extension', turnId: 'first', outcome: 'interrupted', continued: true });
      await appendEvent(session.id, { kind: 'turn_start', time: T0 + 32, source: 'extension', turnId: 'terminal' });
      await appendEvent(session.id, { kind: 'turn_end', time: T0 + 40, source: 'extension', turnId: 'terminal', outcome });
      if (reopen) await appendEvent(session.id, { kind: 'turn_start', time: T0 + 45, source: 'app', turnId: 'terminal' });
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 50, source: 'extension', turnId: 'first',
        messageId: 'consolidated-answer', providerMessageId: 'consolidated-answer',
        message: text('Initial work and delayed final'), state: 'final', final: true
      });
      for (const scope of [undefined, 'terminal']) {
        const final = await readCompletedFinal(session.id, conversationId, scope);
        if (!reopen && (outcome === 'failed' || outcome === 'stopped')) expect(final).toBeNull();
        else expect(final).toMatchObject({ messageId: 'consolidated-answer', turnId: 'terminal' });
      }
      const refusals = getLog().filter(entry => entry.message.startsWith(`session ${session.id}: refused promoted final`));
      expect(refusals).toHaveLength(!reopen && (outcome === 'failed' || outcome === 'stopped') ? 1 : 0);
      if (refusals.length) expect(refusals[0]?.message).toContain(`turn terminal because its latest end was ${outcome}`);
    } finally {
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not settle a promoted continuation final after a newer question has failed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-steer-later-question-'));
    try {
      initConfigPath(dir);
      initSessionStore(dir);
      await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
      resetSessionStoreForTests();
      resetEditsForTests();
      const conversationId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
      const session = await createSession({ title: 'Later question after continuation', conversationId });

      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0, source: 'extension', messageId: 'question-initial', message: text('Initial question')
      });
      await appendEvent(session.id, { kind: 'turn_start', time: T0 + 10, source: 'extension', turnId: 'continued-first' });
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 20, source: 'extension', turnId: 'continued-first',
        messageId: 'answer-consolidated', providerMessageId: 'answer-consolidated',
        message: text('First half of consolidated answer'), state: 'streaming', final: false
      });
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 30, source: 'extension', messageId: 'question-steer',
        parentId: 'answer-consolidated', message: text('Steered follow-up')
      });
      await appendEvent(session.id, {
        kind: 'turn_end', time: T0 + 31, source: 'extension', turnId: 'continued-first', outcome: 'interrupted', continued: true
      });
      await appendEvent(session.id, { kind: 'turn_start', time: T0 + 32, source: 'extension', turnId: 'continued-terminal' });
      await appendEvent(session.id, { kind: 'turn_end', time: T0 + 51, source: 'extension', turnId: 'continued-terminal', outcome: 'completed' });

      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 60, source: 'extension', turnId: 'later-turn',
        messageId: 'question-later', message: text('A newer question')
      });
      await appendEvent(session.id, { kind: 'turn_start', time: T0 + 61, source: 'extension', turnId: 'later-turn' });
      await appendEvent(session.id, { kind: 'turn_end', time: T0 + 70, source: 'extension', turnId: 'later-turn', outcome: 'failed' });

      // The same final_answer container becomes terminal only after the newer question failed.
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 80, source: 'extension', turnId: 'continued-first',
        messageId: 'answer-consolidated', providerMessageId: 'answer-consolidated',
        message: text('First half of consolidated answer\n\nContinuation answer.'), state: 'final', final: true
      });
      expect(await readCompletedFinal(session.id, conversationId)).toBeNull();
    } finally {
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('matches an image-only completion through its proven continued turn owner', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-steer-image-final-'));
    try {
      initConfigPath(dir);
      initSessionStore(dir);
      await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
      resetSessionStoreForTests();
      resetEditsForTests();
      const conversationId = 'cccccccc-dddd-4eee-8fff-000000000001';
      const session = await createSession({ title: 'Continued image answer', conversationId });
      const imageId = '11111111-2222-4333-8444-555555555555';
      const image = {
        kind: 'native_image' as const, time: T0 + 20, source: 'extension' as const, turnId: 'image-first',
        messageId: imageId, providerAssetId: 'file_abcdefgh', providerRole: 'assistant' as const,
        providerChannel: 'final' as const, providerStatus: 'finished_successfully' as const, previewStatus: 'pending' as const
      };

      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0, source: 'extension', messageId: 'image-question', message: text('Generate an image')
      });
      await appendEvent(session.id, { kind: 'turn_start', time: T0 + 10, source: 'extension', turnId: 'image-first' });
      expect((await upsertNativeImageEvent(session.id, { ...image, providerStatus: 'in_progress' })).event.turnId).toBe('image-first');
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 30, source: 'extension', messageId: 'image-steer',
        message: text('Continue the image response')
      });
      await appendEvent(session.id, {
        kind: 'turn_end', time: T0 + 31, source: 'extension', turnId: 'image-first', outcome: 'interrupted', continued: true
      });
      await appendEvent(session.id, { kind: 'turn_start', time: T0 + 32, source: 'extension', turnId: 'image-terminal' });
      // The canonical image keeps its first owner even when the extension proves the continuation.
      expect((await upsertNativeImageEvent(session.id, { ...image, time: T0 + 40, turnId: 'image-terminal' })).event.turnId)
        .toBe('image-first');
      await appendEvent(session.id, {
        kind: 'turn_end', time: T0 + 50, source: 'extension', turnId: 'image-terminal', outcome: 'completed', providerMessageId: imageId
      });
      expect(await readCompletedFinal(session.id, conversationId, 'image-terminal')).toMatchObject({
        messageId: imageId, turnId: 'image-terminal'
      });

      const unrelatedConversationId = 'cccccccc-dddd-4eee-8fff-000000000002';
      const unrelated = await createSession({ title: 'Unrelated image answer', conversationId: unrelatedConversationId });
      await upsertMessageEvent(unrelated.id, {
        kind: 'user_message', time: T0, source: 'extension', messageId: 'unrelated-question', message: text('Generate another image')
      });
      await appendEvent(unrelated.id, { kind: 'turn_start', time: T0 + 10, source: 'extension', turnId: 'unrelated-first' });
      await upsertNativeImageEvent(unrelated.id, { ...image, turnId: 'unrelated-first' });
      await appendEvent(unrelated.id, { kind: 'turn_end', time: T0 + 31, source: 'extension', turnId: 'unrelated-first', outcome: 'completed' });
      await appendEvent(unrelated.id, { kind: 'turn_start', time: T0 + 32, source: 'extension', turnId: 'unrelated-next' });
      await appendEvent(unrelated.id, {
        kind: 'turn_end', time: T0 + 50, source: 'extension', turnId: 'unrelated-next', outcome: 'completed', providerMessageId: imageId
      });
      expect(await readCompletedFinal(unrelated.id, unrelatedConversationId, 'unrelated-next')).toBeNull();
    } finally {
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('promotes a consolidated streaming answer across a continued end while keeping unmodified pre-steer interim prose in its turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-steer-streaming-'));
    try {
      initConfigPath(dir);
      initSessionStore(dir);
      await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
      resetSessionStoreForTests();
      resetEditsForTests();
      const conversationId = 'dddddddd-eeee-4fff-8000-000000000001';
      const session = await createSession({ title: 'Steered streaming consolidated response', conversationId });

      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0, source: 'extension', messageId: 'question-initial', message: text('Initial question')
      });
      await appendEvent(session.id, { kind: 'turn_start', time: T0 + 10, source: 'extension', turnId: 'continued-first' });
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 15, source: 'extension', turnId: 'continued-first',
        messageId: 'interim-pre-steer', providerMessageId: 'interim-pre-steer',
        message: text('Working before steer...'), state: 'streaming', final: false
      });
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 20, source: 'extension', turnId: 'continued-first',
        messageId: 'answer-consolidated', providerMessageId: 'answer-consolidated',
        message: text('First half before steer'), state: 'streaming', final: false
      });

      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 30, source: 'extension',
        messageId: 'question-steer', parentId: 'answer-consolidated', message: text('Steered follow-up')
      });
      await appendEvent(session.id, {
        kind: 'turn_end', time: T0 + 31, source: 'extension',
        turnId: 'continued-first', outcome: 'interrupted', continued: true
      });
      await appendEvent(session.id, {
        kind: 'turn_start', time: T0 + 32, source: 'extension', turnId: 'continued-terminal'
      });
      await appendEvent(session.id, {
        kind: 'tool_call', time: T0 + 40, source: 'mcp', turnId: 'continued-terminal',
        call: { callId: 'call-after-steer', tool: 'read_file', attribution: 'request_id', attributionMethod: 'request_id', requestId: 'req-steer', conversationId, durationMs: 10, args: text('{}'), result: text('ok'), outcome: 'ok', summary: { kind: 'read', title: 'Read file', tone: 'neutral' } }
      });

      // Re-observing the unchanged pre-steer interim with the continuation's turnId (`work: false`)
      // must keep its contentSeq and turn placement before the steered question.
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 42, source: 'extension', turnId: 'continued-terminal',
        messageId: 'interim-pre-steer', providerMessageId: 'interim-pre-steer',
        message: text('Working before steer...'), state: 'streaming', final: false
      }, { work: false });

      // Genuine post-steer prose arriving in the shared assistant bubble while still streaming (`final: false`)
      // advances `contentSeq` past the continued end and must resolve and order inside the continuation turn.
      const updated = await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 45, source: 'extension', turnId: 'continued-first',
        messageId: 'answer-consolidated', providerMessageId: 'answer-consolidated',
        message: text('First half before steer\n\nContinuing after steer...'), state: 'streaming', final: false
      });

      const summary = await getSession(session.id);
      const recent = await readRecentEvents(session.id, 100);
      const interimEvent = recent.find(e => e.kind === 'assistant_message' && e.messageId === 'interim-pre-steer')!;
      const consolidatedEvent = recent.find(e => e.kind === 'assistant_message' && e.messageId === 'answer-consolidated')!;

      expect(effectiveFinalTurnId(summary?.timelineTurns, interimEvent)).toBe('continued-first');
      expect(effectiveFinalTurnId(summary?.timelineTurns, updated.event)).toBe('continued-terminal');
      expect(effectiveFinalTurnId(summary?.timelineTurns, consolidatedEvent)).toBe('continued-terminal');

      const interimIdx = recent.findIndex(e => e.kind === 'assistant_message' && e.messageId === 'interim-pre-steer');
      const steerIdx = recent.findIndex(e => e.kind === 'user_message' && e.messageId === 'question-steer');
      const toolIdx = recent.findIndex(e => e.kind === 'tool_call' && e.call.callId === 'call-after-steer');
      const streamingIdx = recent.findIndex(e => e.kind === 'assistant_message' && e.messageId === 'answer-consolidated');

      expect(interimIdx).toBeLessThan(steerIdx);
      expect(steerIdx).toBeLessThan(toolIdx);
      expect(streamingIdx).toBeGreaterThan(steerIdx);
      expect(streamingIdx).toBeGreaterThan(toolIdx);
      // Streaming must still never satisfy final completion lookup:
      expect(await readCompletedFinal(session.id, conversationId)).toBeNull();
    } finally {
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['continued-terminal', 'continued-first'] as const)(
    'reports working activity through recordChatObservations for a consolidated streaming answer during continuation (reported turnId=%s)',
    async (reportedTurnId) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-steer-recorder-working-'));
      try {
        initConfigPath(dir);
        initSessionStore(dir);
        await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
        resetRecorderForTests();
        resetSessionStoreForTests();
        const conversationId = `dddddddd-eeee-4fff-8000-0000000000${reportedTurnId === 'continued-terminal' ? '02' : '03'}`;

        const opened = await recordChatObservations(conversationId, [
          { kind: 'user_message', time: T0, messageId: 'question-initial', text: 'Initial question' },
          { kind: 'turn_start', time: T0 + 10, turnId: 'continued-first' },
          {
            kind: 'assistant_message', time: T0 + 15, turnId: 'continued-first',
            messageId: 'interim-pre-steer', providerMessageId: 'interim-pre-steer',
            text: 'Working before steer...', state: 'streaming', activeNow: true
          },
          {
            kind: 'assistant_message', time: T0 + 20, turnId: 'continued-first',
            messageId: 'answer-consolidated', providerMessageId: 'answer-consolidated',
            text: 'First half before steer', state: 'streaming', activeNow: true
          },
          {
            kind: 'user_message', time: T0 + 30, messageId: 'question-steer',
            parentId: 'answer-consolidated', text: 'Steered follow-up'
          },
          { kind: 'turn_end', time: T0 + 31, turnId: 'continued-first', outcome: 'interrupted', continued: true },
          { kind: 'turn_start', time: T0 + 32, turnId: 'continued-terminal' }
        ]);
        const sessionId = opened.sessionId!;

        // Re-observing the unchanged pre-steer interim with activeNow must not report new work.
        const preSteerReplay = await recordChatObservations(conversationId, [
          {
            kind: 'assistant_message', time: T0 + 42, turnId: 'continued-terminal',
            messageId: 'interim-pre-steer', providerMessageId: 'interim-pre-steer',
            text: 'Working before steer...', state: 'streaming', activeNow: true
          }
        ]);
        expect(preSteerReplay.activity.working).toBe(false);

        // Fresh post-steer streaming prose in the consolidated bubble must report working activity
        // and resolve into the active continuation turn.
        const continuedUpdate = await recordChatObservations(conversationId, [
          {
            kind: 'assistant_message', time: T0 + 45, turnId: reportedTurnId,
            messageId: 'answer-consolidated', providerMessageId: 'answer-consolidated',
            text: 'First half before steer\n\nContinuing after steer...', state: 'streaming', activeNow: true
          }
        ]);
        expect(continuedUpdate.activity.working).toBe(true);

        const summary = await getSession(sessionId);
        const recent = await readRecentEvents(sessionId, 100);
        const interimEvent = recent.find(e => e.kind === 'assistant_message' && e.messageId === 'interim-pre-steer')!;
        const consolidatedEvent = recent.find(e => e.kind === 'assistant_message' && e.messageId === 'answer-consolidated')!;
        expect(effectiveFinalTurnId(summary?.timelineTurns, interimEvent)).toBe('continued-first');
        expect(effectiveFinalTurnId(summary?.timelineTurns, consolidatedEvent)).toBe('continued-terminal');
        expect(await readCompletedFinal(sessionId, conversationId)).toBeNull();

        await recordChatObservations(conversationId, [
          {
            kind: 'assistant_message', time: T0 + 50, turnId: reportedTurnId,
            messageId: 'answer-consolidated', providerMessageId: 'answer-consolidated',
            text: 'First half before steer\n\nContinuing after steer...\nDone.', state: 'final'
          },
          { kind: 'turn_end', time: T0 + 51, turnId: 'continued-terminal', outcome: 'completed' }
        ]);
        const afterCompletion = await recordChatObservations(conversationId, [
          {
            kind: 'assistant_message', time: T0 + 60, turnId: 'continued-first',
            messageId: 'late-pre-steer-note', text: 'Late pre-steer progress note',
            state: 'streaming', activeNow: true
          }
        ]);
        expect(afterCompletion.activity.working).toBe(false);
        expect(await readCompletedFinal(sessionId, conversationId)).toMatchObject({ messageId: 'answer-consolidated' });
      } finally {
        await flushRecorder();
        resetRecorderForTests();
        resetSessionStoreForTests();
        unsetSessionRootForTests();
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  );
});
