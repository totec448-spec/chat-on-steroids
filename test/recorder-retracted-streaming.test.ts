import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { recordChatObservations, resetRecorderForTests } from '../src/main/session/recorder.js';
import { readSessionEvents } from '../src/main/session/read-model.js';
import {
  flushSessions,
  getSession,
  initSessionStore,
  readActivityEvents,
  readEvents,
  readRecentEvents,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';

beforeAll(async () => {
  directory = await makeTempDir('clf-retracted-streaming-');
  initConfigPath(directory);
  initSessionStore(directory);
  await saveConfig(defaultConfig());
});

beforeEach(() => {
  resetRecorderForTests();
  resetSessionStoreForTests();
});

afterAll(async () => {
  resetRecorderForTests();
  resetSessionStoreForTests();
  await removeTempDir(directory);
});

it('retracts a vanished streaming assistant message without disturbing surviving or final replies', async () => {
  const conversationId = 'conv-retract-streaming';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 10, messageId: 'user-1', text: 'Audit textures' },
    { kind: 'turn_start', time: 11, turnId: 'turn-1' },
    { kind: 'assistant_message', time: 12, turnId: 'turn-1', messageId: 'kept-interim', text: 'Checking folders first.', state: 'streaming', activeNow: true },
    { kind: 'assistant_message', time: 13, turnId: 'turn-1', messageId: 'aborted-interim', providerMessageId: '11111111-1111-4111-8111-111111111111', text: 'The duplicate check found 303 groups and channels PBR val', state: 'streaming', activeNow: true }
  ]);
  const sessionId = opened.sessionId!;
  const beforeSummary = await getSession(sessionId);
  const beforeLoad = await readSessionEvents(sessionId, { limit: 160 });
  const beforeActivity = await readActivityEvents(sessionId, 0);
  const activityCursor = beforeActivity.events.reduce((max, event) => Math.max(max, event.seq + 1), 0);

  const reconciled = await recordChatObservations(conversationId, [
    { kind: 'turn_messages', time: 14, turnId: 'turn-1', messageIds: ['kept-interim'] } as never
  ]);

  expect(reconciled.activity).toMatchObject({ working: false, meaningful: false, terminal: false });

  const fullAfter = await readEvents(sessionId, { kinds: ['assistant_message'] });
  expect(fullAfter.map(event => event.kind === 'assistant_message' ? event.messageId : null)).toEqual(['kept-interim']);

  const recentAfter = await readRecentEvents(sessionId, 20, { kinds: ['assistant_message'] });
  expect(recentAfter.map(event => event.kind === 'assistant_message' ? event.messageId : null)).toEqual(['kept-interim']);

  const initialReadAfter = await readSessionEvents(sessionId, { limit: 160 });
  expect(initialReadAfter?.events.filter(event => event.kind === 'assistant_message').map(event => event.messageId)).toEqual(['kept-interim']);

  const deltaAfter = await readSessionEvents(sessionId, { from: beforeLoad!.nextFrom, limit: 160 });
  expect(deltaAfter?.events).toEqual([
    expect.objectContaining({ kind: 'assistant_message', messageId: 'aborted-interim', retracted: true })
  ]);

  const activityDelta = await readActivityEvents(sessionId, activityCursor);
  expect(activityDelta.events).toEqual([
    expect.objectContaining({ kind: 'assistant_message', messageId: 'aborted-interim', retracted: true })
  ]);

  const coldActivity = await readActivityEvents(sessionId, 0);
  expect(coldActivity.events.filter(event => event.kind === 'assistant_message').map(event => event.messageId)).toEqual(['kept-interim']);

  const afterSummary = await getSession(sessionId);
  expect(afterSummary!.estimatedTokens).toBeLessThan(beforeSummary!.estimatedTokens);
  expect(afterSummary!.contextTokens).toBeLessThan(beforeSummary!.contextTokens);

  await flushSessions();
  resetRecorderForTests();
  resetSessionStoreForTests();
  const reloadedSummary = await getSession(sessionId);
  expect(reloadedSummary!.estimatedTokens).toBe(afterSummary!.estimatedTokens);
  expect(reloadedSummary!.contextTokens).toBe(afterSummary!.contextTokens);
});

it('keeps streaming messages matched by providerMessageId, final answers, other turns, and continued turns', async () => {
  const conversationId = 'conv-retract-guards';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn-1' },
    { kind: 'assistant_message', time: 11, turnId: 'turn-1', messageId: 'composite-1', providerMessageId: '22222222-2222-4222-8222-222222222222', text: 'Matched by provider id', state: 'streaming', activeNow: true },
    { kind: 'assistant_message', time: 12, turnId: 'turn-1', messageId: 'final-1', text: 'Final answer stays', state: 'final', final: true, activeNow: true },
    { kind: 'turn_start', time: 13, turnId: 'turn-2' },
    { kind: 'assistant_message', time: 14, turnId: 'turn-2', messageId: 'other-turn-interim', text: 'Other turn stays', state: 'streaming', activeNow: true },
    { kind: 'turn_start', time: 15, turnId: 'turn-continued' },
    { kind: 'assistant_message', time: 16, turnId: 'turn-continued', messageId: 'continued-interim', text: 'Continued turn stays', state: 'streaming', activeNow: true },
    { kind: 'turn_end', time: 17, turnId: 'turn-continued', outcome: 'interrupted', continued: true }
  ]);
  const sessionId = opened.sessionId!;

  await recordChatObservations(conversationId, [
    { kind: 'turn_messages', time: 18, turnId: 'turn-1', messageIds: ['22222222-2222-4222-8222-222222222222'] } as never,
    { kind: 'turn_messages', time: 19, turnId: 'turn-continued', messageIds: [] } as never
  ]);

  const kept = (await readEvents(sessionId, { kinds: ['assistant_message'] }))
    .map(event => event.kind === 'assistant_message' ? event.messageId : null);
  expect(kept).toEqual(['composite-1', 'final-1', 'other-turn-interim', 'continued-interim']);
});

it('restores a previously retracted streaming message if ChatGPT observes it again', async () => {
  const conversationId = 'conv-retract-restore';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn-1' },
    { kind: 'assistant_message', time: 11, turnId: 'turn-1', messageId: 'flicker-1', text: 'Temporary flicker', state: 'streaming', activeNow: true }
  ]);
  const sessionId = opened.sessionId!;
  const beforeTokens = (await getSession(sessionId))!.estimatedTokens;

  await recordChatObservations(conversationId, [
    { kind: 'turn_messages', time: 12, turnId: 'turn-1', messageIds: [] } as never
  ]);
  expect(await readEvents(sessionId, { kinds: ['assistant_message'] })).toEqual([]);
  expect((await getSession(sessionId))!.estimatedTokens).toBeLessThan(beforeTokens);

  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 13, turnId: 'turn-1', messageId: 'flicker-1', text: 'Temporary flicker restored', state: 'streaming', activeNow: true }
  ]);
  const restored = await readEvents(sessionId, { kinds: ['assistant_message'] });
  expect(restored).toEqual([
    expect.objectContaining({ kind: 'assistant_message', messageId: 'flicker-1', message: expect.objectContaining({ text: 'Temporary flicker restored' }) })
  ]);
  expect((await getSession(sessionId))!.estimatedTokens).toBeGreaterThanOrEqual(beforeTokens);
});

it('treats missing or damaged retracted fields in saved canonical shards as non-retracted', async () => {
  const conversationId = 'conv-retract-saved-data';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn-1' },
    { kind: 'assistant_message', time: 11, turnId: 'turn-1', messageId: 'legacy-msg', text: 'Legacy partial', state: 'streaming', activeNow: true }
  ]);
  const sessionId = opened.sessionId!;
  await flushSessions();
  resetRecorderForTests();
  resetSessionStoreForTests();

  const shardName = `${createHash('sha256').update('assistant_message\u0000legacy-msg').digest('hex')}.json`;
  const shardPath = path.join(directory, 'sessions', sessionId, 'messages', shardName);
  const saved = JSON.parse(await fs.readFile(shardPath, 'utf8')) as Record<string, unknown>;
  saved['retracted'] = 'yes';
  await fs.writeFile(shardPath, JSON.stringify(saved), 'utf8');

  const events = await readEvents(sessionId, { kinds: ['assistant_message'] });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'assistant_message', messageId: 'legacy-msg' });
});

it('fences turn_messages retraction by document, revision, settled flag, and observation timestamp', async () => {
  const conversationId = 'conv-retract-fences';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 100, turnId: 'turn-1' },
    { kind: 'assistant_message', time: 110, turnId: 'turn-1', messageId: 'doc1-msg', docId: 'doc-1', docSeq: 5, text: 'Observed by doc 1', state: 'streaming', activeNow: true } as never
  ]);
  const sessionId = opened.sessionId!;

  // Stale revision from same doc (docSeq <= 5) or older timestamp (time < 110) must not retract.
  await recordChatObservations(conversationId, [
    { kind: 'turn_messages', time: 120, turnId: 'turn-1', messageIds: [], docId: 'doc-1', docSeq: 5 } as never,
    { kind: 'turn_messages', time: 105, turnId: 'turn-1', messageIds: [], docId: 'doc-1', docSeq: 6 } as never
  ]);
  expect((await readEvents(sessionId, { kinds: ['assistant_message'] })).map(e => e.kind === 'assistant_message' ? e.messageId : null)).toEqual(['doc1-msg']);

  // Unsettled snapshot from a different document must not retract doc-1's streaming draft.
  await recordChatObservations(conversationId, [
    { kind: 'turn_messages', time: 130, turnId: 'turn-1', messageIds: [], docId: 'doc-2', docSeq: 1 } as never
  ]);
  expect((await readEvents(sessionId, { kinds: ['assistant_message'] })).map(e => e.kind === 'assistant_message' ? e.messageId : null)).toEqual(['doc1-msg']);

  // Settled snapshot from a newer document (post-reload cleanup) or newer revision retracts cleanly.
  await recordChatObservations(conversationId, [
    { kind: 'turn_messages', time: 140, turnId: 'turn-1', messageIds: [], docId: 'doc-2', docSeq: 2, settled: true } as never
  ]);
  expect(await readEvents(sessionId, { kinds: ['assistant_message'] })).toEqual([]);
});
