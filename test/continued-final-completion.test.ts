import { describe, expect, it } from 'vitest';
import { effectiveFinalTurnId } from '../src/shared/chronology.js';
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
    expect(effectiveFinalTurnId({ first: { origin: 1, time: T0, endOrigin: 5, continued: true } },
      { kind: 'assistant_message', turnId: 'first', seq: 2, contentSeq: 8, time: T0, final: true })).toBe('first');
  });

  it('does not move a final to a continuation that opened after it settled', () => {
    expect(effectiveFinalTurnId({
      first: { origin: 1, time: T0, endOrigin: 5, continued: true },
      next: { origin: 10, time: T0 + 10 }
    }, { kind: 'assistant_message', turnId: 'first', seq: 2, contentSeq: 8, time: T0, final: true })).toBe('first');
  });

  it('recognizes the consolidated final for the terminal steered continuation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-steer-continued-'));
    try {
      initConfigPath(dir);
      initSessionStore(dir);
      await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
      resetSessionStoreForTests();
      resetEditsForTests();
      const conversationId = '69d626f4-b5ec-8385-816e-145fc405d198';
      const session = await createSession({ title: 'Steered continuation', conversationId });

      // Turn 4 opens and creates the final_answer container before the user steers:
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0, source: 'extension',
        messageId: '679fdbcc-7989-4e80-a00f-fe3b3dcb2f29',
        parentId: 'a0000000-0000-4000-8000-000000000001',
        message: text('Initial question')
      });
      await appendEvent(session.id, {
        kind: 'turn_start', time: T0 + 10, source: 'extension', turnId: 'g-10uer7kwcef0o-0-4'
      });
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 20, source: 'extension',
        turnId: 'g-10uer7kwcef0o-0-4',
        messageId: 'b50804bf-faf8-4272-8f1d-48b16674a51c',
        providerMessageId: 'b50804bf-faf8-4272-8f1d-48b16674a51c',
        message: text('First half of consolidated answer'),
        state: 'streaming', final: false
      });

      // User steers while Turn 4 is still running; Turn 4 ends with continued: true and Turn 5 starts:
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 30, source: 'extension',
        messageId: '05a235d9-231e-487a-9257-76469eb9b5f9',
        parentId: 'b50804bf-faf8-4272-8f1d-48b16674a51c',
        message: text('Steered follow-up')
      });
      await appendEvent(session.id, {
        kind: 'turn_end', time: T0 + 31, source: 'extension',
        turnId: 'g-10uer7kwcef0o-0-4', outcome: 'completed', continued: true
      });
      await appendEvent(session.id, {
        kind: 'turn_start', time: T0 + 32, source: 'extension', turnId: 'g-10uer7kwcef0o-0-5'
      });

      // ChatGPT appends the continuation's answer to the same final_answer message and completes Turn 5:
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', time: T0 + 50, source: 'extension',
        turnId: 'g-10uer7kwcef0o-0-5',
        messageId: 'b50804bf-faf8-4272-8f1d-48b16674a51c',
        providerMessageId: 'b50804bf-faf8-4272-8f1d-48b16674a51c',
        message: text('First half of consolidated answer\n\nContinuation answer.'),
        state: 'final', final: true
      });
      await appendEvent(session.id, {
        kind: 'turn_end', time: T0 + 51, source: 'extension',
        turnId: 'g-10uer7kwcef0o-0-5', outcome: 'completed'
      });

      // readCompletedFinal must recognize the consolidated final for both the continuation turn and the session:
      const byTurn = await readCompletedFinal(session.id, conversationId, 'g-10uer7kwcef0o-0-5');
      expect(byTurn).toMatchObject({
        messageId: 'b50804bf-faf8-4272-8f1d-48b16674a51c',
        turnId: 'g-10uer7kwcef0o-0-5'
      });
      const anyTurn = await readCompletedFinal(session.id, conversationId);
      expect(anyTurn).toMatchObject({
        messageId: 'b50804bf-faf8-4272-8f1d-48b16674a51c',
        turnId: 'g-10uer7kwcef0o-0-5'
      });

    } finally {
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });


});
