import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionEvent } from '../src/shared/session.js';
import { appendEvent, createSession, initSessionStore, readEvents, resetSessionStoreForTests, unsetSessionRootForTests, upsertMessageEvent } from '../src/main/session/store.js';
import { replacedQuestion, resetEditsForTests } from '../src/main/session/edits.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
const T0 = 1793454400000;
const text = (text: string) => ({ text, truncated: false, chars: text.length });

describe('steered follow-up edit attribution', () => {
  it('keeps a follow-up under the settled consolidated parent separate while preserving real edits', async () => {
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

      // When the queued message for the next turn is sent under the consolidated final answer parentId,
      // it must not be marked as replacing the steered message:
      const replacement = await replacedQuestion(
        session.id,
        '648133a5-c219-4adb-b634-340a193fa636',
        'b50804bf-faf8-4272-8f1d-48b16674a51c'
      );
      expect(replacement).toEqual({});

      // Even if a pre-fix shard on disk carried `replaces: "05a235d9-..."`, reopening the session cleans it:
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 60, source: 'extension',
        messageId: '648133a5-c219-4adb-b634-340a193fa636',
        parentId: 'b50804bf-faf8-4272-8f1d-48b16674a51c',
        replaces: '05a235d9-231e-487a-9257-76469eb9b5f9',
        message: text('Queued next question')
      });
      // A genuine later edit of the post-continuation question under the same parentId still records `replaces`:
      const genuineEdit = await replacedQuestion(
        session.id,
        '778133a5-c219-4adb-b634-340a193fa637',
        'b50804bf-faf8-4272-8f1d-48b16674a51c'
      );
      expect(genuineEdit).toEqual({ replaces: '648133a5-c219-4adb-b634-340a193fa636' });
      await upsertMessageEvent(session.id, {
        kind: 'user_message', time: T0 + 70, source: 'extension',
        messageId: '778133a5-c219-4adb-b634-340a193fa637',
        parentId: 'b50804bf-faf8-4272-8f1d-48b16674a51c',
        ...genuineEdit,
        message: text('Edited next question')
      });
      resetSessionStoreForTests();
      const loaded = await readEvents(session.id, { kinds: ['user_message'] });
      const queued = loaded.find(e => e.kind === 'user_message' && e.messageId === '648133a5-c219-4adb-b634-340a193fa636');
      expect(queued?.kind).toBe('user_message');
      expect(queued?.kind === 'user_message' ? queued.replaces : undefined).toBeUndefined();
      const edited = loaded.find(e => e.kind === 'user_message' && e.messageId === '778133a5-c219-4adb-b634-340a193fa637');
      expect(edited?.kind).toBe('user_message');
      expect(edited?.kind === 'user_message' ? edited.replaces : undefined).toBe('648133a5-c219-4adb-b634-340a193fa636');
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
