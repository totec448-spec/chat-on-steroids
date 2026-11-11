import { describe, expect, it } from 'vitest';
import { projectTimeline, type Chronological } from '../src/shared/chronology.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, createSession, initSessionStore, readCompletedFinal, resetSessionStoreForTests, unsetSessionRootForTests, upsertMessageEvent } from '../src/main/session/store.js';
import { resetEditsForTests } from '../src/main/session/edits.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
const T0 = 1793454400000;
const text = (text: string) => ({ text, truncated: false, chars: text.length });

describe('continued final completion', () => {
  it('keeps a final in its original turn when a continued turn has no successor', () => {
    expect(projectTimeline<Chronological>([
      { kind: 'assistant_message', turnId: 'first', seq: 2, contentSeq: 8, time: T0, final: true }
    ], { first: { origin: 1, time: T0, endOrigin: 5, continued: true } })[0]?.turnOrigin).toBe(1);
  });

  it('does not move a final to a continuation that opened after it settled', () => {
    expect(projectTimeline<Chronological>([
      { kind: 'assistant_message', turnId: 'first', seq: 2, contentSeq: 8, time: T0, final: true }
    ], {
      first: { origin: 1, time: T0, endOrigin: 5, continued: true },
      next: { origin: 10, time: T0 + 10 }
    })[0]?.turnOrigin).toBe(1);
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

    } finally {
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });


});
