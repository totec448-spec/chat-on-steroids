import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  cancelChatTitleSync,
  CHAT_TITLE_SYNC_LEASE_MS,
  CHAT_TITLE_SYNC_MAX_ATTEMPTS,
  chatTitleSyncWritten,
  hasDueChatTitleSync,
  initChatTitleSyncPath,
  loadChatTitleSync,
  nextChatTitleSync,
  queueChatTitleSync,
  resetChatTitleSyncForTests,
  settleChatTitleSync
} from '../src/main/chat-title-sync.js';
import {
  clearSessionName,
  createSession,
  getSession,
  initSessionStore,
  rebindSession,
  renameSession,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
const A = 'aaaaaaaa-1111-4222-8333-444444444444';
const B = 'bbbbbbbb-1111-4222-8333-444444444444';

beforeAll(async () => {
  dir = await makeTempDir('clf-chat-title-sync-');
  initChatTitleSyncPath(dir);
  initSessionStore(dir);
});

afterAll(async () => {
  await chatTitleSyncWritten();
  await removeTempDir(dir);
});

beforeEach(() => {
  resetChatTitleSyncForTests();
  resetSessionStoreForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T04:00:00Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(['state', 'sessions'].map(sub => fs.rm(path.join(dir, sub), { recursive: true, force: true }).catch(() => undefined)));
});

it('queues a manual rename and keeps the latest title when edited during an in-flight lease', async () => {
  const session = await createSession({ conversationId: A, title: 'Initial auto title', titleSource: 'provider' });
  await renameSession(session.id, 'My Work', 'manual');

  expect(hasDueChatTitleSync()).toBe(true);
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work' });
  expect(nextChatTitleSync()).toBeNull();

  await renameSession(session.id, 'My   Work  v2', 'manual');
  settleChatTitleSync(A, 'My Work', 'synced');
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work v2' });
  settleChatTitleSync(A, 'My Work v2', 'synced');
  expect(nextChatTitleSync()).toBeNull();
});

it('queues the manual name once an unbound desktop session binds and carries it across Compact & Resume', async () => {
  const desktop = await createSession({ title: 'New chat', titleSource: 'fallback', origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  await renameSession(desktop.id, 'My Work', 'manual');
  expect(hasDueChatTitleSync()).toBe(false);

  expect(await rebindSession(desktop.id, null, A)).toBe(true);
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work' });
  settleChatTitleSync(A, 'My Work', 'synced');

  expect(await rebindSession(desktop.id, A, B, 'handoff-12345678')).toBe(true);
  expect(await getSession(desktop.id)).toMatchObject({ title: 'My Work', titleSource: 'manual' });
  expect(nextChatTitleSync()).toEqual({ conversationId: B, title: 'My Work' });
});

it('repairs bounded async gen_title drift after rebind without looping forever', async () => {
  const session = await createSession({ conversationId: A, title: 'Old title', titleSource: 'provider' });
  await renameSession(session.id, 'My Work', 'manual');
  settleChatTitleSync(A, 'My Work', 'synced');
  expect(await rebindSession(session.id, A, B, 'handoff-87654321')).toBe(true);
  expect(nextChatTitleSync()).toEqual({ conversationId: B, title: 'My Work' });
  settleChatTitleSync(B, 'My Work', 'synced');

  for (const autoTitle of ['Resume Task Brief', 'Another Auto Title']) {
    await renameSession(session.id, autoTitle, 'provider', B);
    expect(nextChatTitleSync()).toEqual({ conversationId: B, title: 'My Work' });
    settleChatTitleSync(B, 'My Work', 'synced');
  }
  await renameSession(session.id, 'Third Auto Title', 'provider', B);
  expect(nextChatTitleSync()).toBeNull();
  expect((await getSession(session.id))?.title).toBe('My Work');
});

it('cancels pending sync when cleared, backs off failures without counting deferred passes, and persists cleanly', async () => {
  const session = await createSession({ conversationId: A, title: 'Auto name', titleSource: 'provider' });
  await renameSession(session.id, 'Temporary Manual', 'manual');
  expect(hasDueChatTitleSync()).toBe(true);
  await clearSessionName(session.id);
  expect(nextChatTitleSync()).toBeNull();
  expect(await getSession(session.id)).toMatchObject({ title: 'Auto name', titleSource: 'provider' });

  expect(queueChatTitleSync(A, 'My Work')).toBe(true);
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work' });
  settleChatTitleSync(A, 'My Work', 'deferred');
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work' });

  for (let attempt = 1; attempt < CHAT_TITLE_SYNC_MAX_ATTEMPTS; attempt++) {
    settleChatTitleSync(A, 'My Work', 'failed');
    expect(nextChatTitleSync()).toBeNull();
    vi.advanceTimersByTime(5_000 * 2 ** (attempt - 1));
    expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work' });
  }
  settleChatTitleSync(A, 'My Work', 'failed');
  expect(nextChatTitleSync()).toBeNull();

  queueChatTitleSync(A, 'Persisted Title');
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'Persisted Title' });
  await chatTitleSyncWritten();
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_LEASE_MS + 1);
  await loadChatTitleSync();
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'Persisted Title' });
  cancelChatTitleSync(A);
  await chatTitleSyncWritten();

  await fs.writeFile(path.join(dir, 'state', 'chat-title-sync.json'), '{broken json', 'utf8');
  await expect(loadChatTitleSync()).resolves.toBeUndefined();
  expect(nextChatTitleSync()).toBeNull();
});
