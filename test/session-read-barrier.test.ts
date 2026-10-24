import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  appendEvent, createSession, flushSessions, initSessionStore, readCompletedFinal, readEvents, readRecentEvents,
  resetSessionStoreForTests, sessionsRoot, turnEndedDurably
} from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

/**
 * Reading a chat's events waits for its queued appends, not for its summary. The summary
 * (meta.json, two disk syncs) is batched every 1.5 s; reads used to write it each time, so every
 * tool call paid a metadata write before ChatGPT got its answer.
 */
let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('cos-read-barrier-');
  initConfigPath(dir);
  initSessionStore(dir);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  vi.useRealTimers();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

it('reads the chat\'s events without writing its summary, which stays batched', async () => {
  const session = await createSession({ title: 'Read barrier fixture', conversationId: 'barrier-chat' } as never);
  await flushSessions();
  const meta = path.join(sessionsRoot(), session.id, 'meta.json');
  const before = await fs.readFile(meta, 'utf8');
  // Only the timers are fake (file I/O stays real): on a slow machine the 1.5 s summary batch must
  // not fire during the reads and be mistaken for a reader's write.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await appendEvent(session.id, { time: 100, source: 'extension', kind: 'turn_start', turnId: 'barrier-turn' });
  await appendEvent(session.id, { time: 101, source: 'extension', kind: 'turn_end', turnId: 'barrier-turn', outcome: 'completed' });
  expect((await readEvents(session.id)).map(event => event.kind)).toEqual(['turn_start', 'turn_end']);
  expect((await readRecentEvents(session.id, 1))[0]?.kind).toBe('turn_end');
  expect(await turnEndedDurably(session.id, 'barrier-chat', 'barrier-turn')).toBeTypeOf('boolean');
  await readCompletedFinal(session.id, 'barrier-chat');
  expect(await fs.readFile(meta, 'utf8')).toBe(before);
  // The batched write still happens, and a quit still writes it at once.
  await flushSessions();
  vi.useRealTimers();
  expect(await fs.readFile(meta, 'utf8')).not.toBe(before);
});
