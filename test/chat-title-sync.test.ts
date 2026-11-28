import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as logger from '../src/main/logger.js';
import {
  cancelAllChatTitleSync,
  cancelChatTitleSync,
  CHAT_TITLE_SYNC_LEASE_MS,
  CHAT_TITLE_SYNC_MAX_ATTEMPTS,
  CHAT_TITLE_SYNC_MIN_INTERVAL_MS,
  CHAT_TITLE_SYNC_RATE_LIMIT_MS,
  chatTitleSyncWritten,
  hasDueChatTitleSync,
  initChatTitleSyncPath,
  loadChatTitleSync,
  nextChatTitleSync,
  noteProviderChatTitle,
  queueChatTitleSync,
  resetChatTitleSyncForTests,
  settleChatTitleSync
} from '../src/main/chat-title-sync.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
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
const C = 'cccccccc-1111-4222-8333-444444444444';

async function setTitleSyncEnabled(on: boolean): Promise<void> {
  const base = defaultConfig();
  await saveConfig({ ...base, sessions: { ...base.sessions, syncManualChatTitles: on } });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-chat-title-sync-');
  initConfigPath(dir);
  initChatTitleSyncPath(dir);
  initSessionStore(dir);
});

afterAll(async () => {
  await chatTitleSyncWritten();
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetChatTitleSyncForTests();
  resetSessionStoreForTests();
  await setTitleSyncEnabled(true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T04:00:00Z'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(['state', 'sessions', 'config.json'].map(sub => fs.rm(path.join(dir, sub), { recursive: true, force: true }).catch(() => undefined)));
});

it('stays off by default until opted in and drops pending syncs when disabled', async () => {
  await setTitleSyncEnabled(false);
  const session = await createSession({ conversationId: A, title: 'Auto', titleSource: 'provider' });
  await renameSession(session.id, 'My Work', 'manual');
  expect(hasDueChatTitleSync()).toBe(false);
  expect(nextChatTitleSync()).toBeNull();
  expect(queueChatTitleSync(A, 'Direct')).toBe(false);
  expect(await rebindSession(session.id, A, B, 'handoff-disabled1')).toBe(true);
  expect(nextChatTitleSync()).toBeNull();

  await setTitleSyncEnabled(true);
  await renameSession(session.id, 'Now Opted In', 'manual');
  expect(hasDueChatTitleSync()).toBe(true);
  await setTitleSyncEnabled(false);
  expect(hasDueChatTitleSync()).toBe(false);
  expect(nextChatTitleSync()).toBeNull();
  expect(cancelAllChatTitleSync('setting-disabled')).toBe(1);
});

it('queues a manual rename and keeps the latest title when edited during an in-flight lease', async () => {
  const session = await createSession({ conversationId: A, title: 'Initial auto title', titleSource: 'provider' });
  await renameSession(session.id, 'My Work', 'manual');

  expect(hasDueChatTitleSync()).toBe(true);
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work', expectedRemoteTitle: 'Initial auto title' });
  expect(nextChatTitleSync()).toBeNull();

  await renameSession(session.id, 'My   Work  v2', 'manual');
  settleChatTitleSync(A, 'My Work', 'synced');
  expect(nextChatTitleSync()).toBeNull();
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work v2', expectedRemoteTitle: 'My Work' });
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
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);

  expect(await rebindSession(desktop.id, A, B, 'handoff-12345678')).toBe(true);
  expect(await getSession(desktop.id)).toMatchObject({ title: 'My Work', titleSource: 'manual' });
  expect(nextChatTitleSync()).toEqual({ conversationId: B, title: 'My Work' });
});

it('preserves later ChatGPT Web changes after Compact & Resume without re-queuing overwrites', async () => {
  const session = await createSession({ conversationId: A, title: 'Old title', titleSource: 'provider' });
  await renameSession(session.id, 'My Work', 'manual');
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work', expectedRemoteTitle: 'Old title' });
  settleChatTitleSync(A, 'My Work', 'synced');
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);

  expect(await rebindSession(session.id, A, B, 'handoff-87654321')).toBe(true);
  expect(nextChatTitleSync()).toEqual({ conversationId: B, title: 'My Work' });
  settleChatTitleSync(B, 'My Work', 'synced');
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);

  await renameSession(session.id, 'Edited On ChatGPT Web', 'provider', B);
  expect(hasDueChatTitleSync()).toBe(false);
  expect(nextChatTitleSync()).toBeNull();
  expect(await getSession(session.id)).toMatchObject({
    title: 'My Work',
    titleSource: 'manual',
    autoTitle: { title: 'Edited On ChatGPT Web', source: 'provider' }
  });
});

it('keeps an unsettled Compact & Resume rebind queued through initial ChatGPT Web auto-titles', async () => {
  const session = await createSession({ conversationId: A, title: 'Old title', titleSource: 'provider' });
  await renameSession(session.id, 'My Work', 'manual');
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work', expectedRemoteTitle: 'Old title' });
  settleChatTitleSync(A, 'My Work', 'synced');
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);

  // Even if the new replacement tab already reported an initial placeholder before rebind commits,
  // and ChatGPT Web later emits async gen_title changes before/during the lease, rebind still lands.
  noteProviderChatTitle(B, 'New chat');
  expect(await rebindSession(session.id, A, B, 'handoff-race1234')).toBe(true);
  await renameSession(session.id, 'Initial Auto Title', 'provider', B);
  expect(hasDueChatTitleSync()).toBe(true);

  expect(nextChatTitleSync()).toEqual({ conversationId: B, title: 'My Work' });
  await renameSession(session.id, 'Refined Auto Title', 'provider', B);
  expect(settleChatTitleSync(B, 'My Work', 'synced')).toBe(true);
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);

  // Once the rebind sync has settled, subsequent ChatGPT Web edits remain preserved without overwriting.
  await renameSession(session.id, 'Edited On Web Later', 'provider', B);
  expect(hasDueChatTitleSync()).toBe(false);
  expect(nextChatTitleSync()).toBeNull();
  expect(await getSession(session.id)).toMatchObject({
    title: 'My Work',
    titleSource: 'manual',
    autoTitle: { title: 'Edited On Web Later', source: 'provider' }
  });
});

it('drops a superseded queued rename when the in-flight push returns conflict', async () => {
  const session = await createSession({ conversationId: A, title: 'Original Web Title', titleSource: 'provider' });
  await renameSession(session.id, 'CoS 1', 'manual');
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'CoS 1', expectedRemoteTitle: 'Original Web Title' });

  await renameSession(session.id, 'CoS 2', 'manual');
  expect(settleChatTitleSync(A, 'CoS 1', 'conflict', { remoteTitle: 'Manual Web Change' })).toBe(true);
  await renameSession(session.id, 'Manual Web Change', 'provider', A);
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);

  expect(hasDueChatTitleSync()).toBe(false);
  expect(nextChatTitleSync()).toBeNull();
  expect(await getSession(session.id)).toMatchObject({
    title: 'CoS 2',
    titleSource: 'manual',
    autoTitle: { title: 'Manual Web Change', source: 'provider' }
  });
});

it('respects newer ChatGPT Web edits and never overwrites them before or after sync', async () => {
  const session = await createSession({ conversationId: A, title: 'Original Web Title', titleSource: 'provider' });
  await renameSession(session.id, 'CoS Pending Rename', 'manual');

  // Re-observing the same prior title (e.g. opening the tab) keeps the pending sync queued.
  await renameSession(session.id, 'Original Web Title', 'provider', A);
  expect(hasDueChatTitleSync()).toBe(true);

  // A newer remote title observed before the push runs drops CoS's pending push instead of overwriting Web.
  await renameSession(session.id, 'Renamed On ChatGPT Web', 'provider', A);
  expect(hasDueChatTitleSync()).toBe(false);
  expect(nextChatTitleSync()).toBeNull();
  expect(await getSession(session.id)).toMatchObject({
    title: 'CoS Pending Rename',
    titleSource: 'manual',
    autoTitle: { title: 'Renamed On ChatGPT Web', source: 'provider' }
  });

  // Settling as conflict on GET pre-check drops cleanly without re-queuing.
  await renameSession(session.id, 'CoS Second Attempt', 'manual');
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'CoS Second Attempt', expectedRemoteTitle: 'Renamed On ChatGPT Web' });
  expect(settleChatTitleSync(A, 'CoS Second Attempt', 'conflict', { remoteTitle: 'Web Concurrent Edit' })).toBe(true);
  expect(nextChatTitleSync()).toBeNull();

  // Later Web renames after a settled manual-rename do not re-trigger pushes.
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);
  await renameSession(session.id, 'CoS Synced Title', 'manual');
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'CoS Synced Title', expectedRemoteTitle: 'Web Concurrent Edit' });
  settleChatTitleSync(A, 'CoS Synced Title', 'synced');
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);
  expect(noteProviderChatTitle(A, 'Web Edited Afterwards')).toBe(false);
  expect(nextChatTitleSync()).toBeNull();
});

it('paces bursts across chats, honors 429 cooldowns, logs every decision, and persists cleanly', async () => {
  const info = vi.spyOn(logger, 'logInfo');
  const warn = vi.spyOn(logger, 'logWarn');

  const session = await createSession({ conversationId: A, title: 'Auto name', titleSource: 'provider' });
  await renameSession(session.id, 'Temporary Manual', 'manual');
  expect(hasDueChatTitleSync()).toBe(true);
  await clearSessionName(session.id);
  expect(nextChatTitleSync()).toBeNull();
  expect(await getSession(session.id)).toMatchObject({ title: 'Auto name', titleSource: 'provider' });

  // Burst across B and C is spaced by CHAT_TITLE_SYNC_MIN_INTERVAL_MS.
  expect(queueChatTitleSync(B, 'Burst One', { expectedRemoteTitle: 'Before One' })).toBe(true);
  expect(queueChatTitleSync(C, 'Burst Two', { expectedRemoteTitle: 'Before Two' })).toBe(true);
  expect(nextChatTitleSync()).toEqual({ conversationId: B, title: 'Burst One', expectedRemoteTitle: 'Before One' });
  settleChatTitleSync(B, 'Burst One', 'deferred');
  expect(nextChatTitleSync()).toEqual({ conversationId: B, title: 'Burst One', expectedRemoteTitle: 'Before One' });
  settleChatTitleSync(B, 'Burst One', 'synced');
  expect(hasDueChatTitleSync()).toBe(false);
  expect(nextChatTitleSync()).toBeNull();
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS - 1);
  expect(nextChatTitleSync()).toBeNull();
  vi.advanceTimersByTime(1);
  expect(nextChatTitleSync()).toEqual({ conversationId: C, title: 'Burst Two', expectedRemoteTitle: 'Before Two' });

  // 429 imposes a global cooldown honoring Retry-After.
  settleChatTitleSync(C, 'Burst Two', 'failed', { status: 429, retryAfterMs: 12_000 });
  expect(nextChatTitleSync()).toBeNull();
  expect(queueChatTitleSync(B, 'During Cooldown')).toBe(true);
  expect(nextChatTitleSync()).toBeNull();
  vi.advanceTimersByTime(11_999);
  expect(nextChatTitleSync()).toBeNull();
  vi.advanceTimersByTime(1);
  expect(nextChatTitleSync()).toEqual({ conversationId: C, title: 'Burst Two', expectedRemoteTitle: 'Before Two' });
  settleChatTitleSync(C, 'Burst Two', 'synced');
  cancelChatTitleSync(B);
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);

  // Normal failure exponential backoff until CHAT_TITLE_SYNC_MAX_ATTEMPTS then dropped.
  expect(queueChatTitleSync(A, 'My Work')).toBe(true);
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work', expectedRemoteTitle: 'Auto name' });
  for (let attempt = 1; attempt < CHAT_TITLE_SYNC_MAX_ATTEMPTS; attempt++) {
    settleChatTitleSync(A, 'My Work', 'failed', { status: 500 });
    expect(nextChatTitleSync()).toBeNull();
    vi.advanceTimersByTime(5_000 * 2 ** (attempt - 1));
    expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'My Work', expectedRemoteTitle: 'Auto name' });
  }
  settleChatTitleSync(A, 'My Work', 'failed', { status: 500 });
  expect(nextChatTitleSync()).toBeNull();
  expect(CHAT_TITLE_SYNC_RATE_LIMIT_MS).toBe(60_000);

  const infoLines = info.mock.calls.map(([line]) => String(line));
  const warnLines = warn.mock.calls.map(([line]) => String(line));
  expect(infoLines.some(line => line.includes('chat title sync: queued'))).toBe(true);
  expect(infoLines.some(line => line.includes('chat title sync: leased'))).toBe(true);
  expect(infoLines.some(line => line.includes('chat title sync: deferred'))).toBe(true);
  expect(infoLines.some(line => line.includes('chat title sync: sent'))).toBe(true);
  expect(infoLines.some(line => line.includes('chat title sync: dropped'))).toBe(true);
  expect(warnLines.some(line => line.includes('chat title sync: failed'))).toBe(true);
  expect(warnLines.some(line => line.includes('chat title sync: dropped'))).toBe(true);

  vi.advanceTimersByTime(CHAT_TITLE_SYNC_MIN_INTERVAL_MS);
  queueChatTitleSync(A, 'Persisted Title');
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'Persisted Title', expectedRemoteTitle: 'Auto name' });
  await chatTitleSyncWritten();
  vi.advanceTimersByTime(CHAT_TITLE_SYNC_LEASE_MS + 1);
  await loadChatTitleSync();
  expect(nextChatTitleSync()).toEqual({ conversationId: A, title: 'Persisted Title', expectedRemoteTitle: 'Auto name' });
  cancelChatTitleSync(A);
  await chatTitleSyncWritten();

  await fs.writeFile(path.join(dir, 'state', 'chat-title-sync.json'), '{broken json', 'utf8');
  await expect(loadChatTitleSync()).resolves.toBeUndefined();
  expect(nextChatTitleSync()).toBeNull();
});
