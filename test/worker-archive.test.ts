import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  initWorkerArchivePath,
  loadWorkerArchive,
  nextWorkerArchive,
  onWorkerChatReady,
  queueWorkerArchives,
  readyForWake,
  resetWorkerArchiveForTests,
  settleWorkerArchive,
  WORKER_ARCHIVE_LEASE_MS,
  WORKER_ARCHIVE_MAX_ATTEMPTS,
  WORKER_UNARCHIVE_HOLD_MS,
  workerArchiveWritten
} from '../src/main/worker-archive.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
const A = 'aaaaaaaa-1111-4222-8333-444444444444';
const B = 'bbbbbbbb-1111-4222-8333-444444444444';

async function archiving(on: boolean): Promise<void> {
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, archiveWorkerChats: on } });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-worker-archive-');
  initConfigPath(dir);
  initWorkerArchivePath(dir);
});
afterAll(async () => { await removeTempDir(dir); });
beforeEach(async () => {
  await archiving(true);
  resetWorkerArchiveForTests();
});
afterEach(() => { vi.useRealTimers(); });

/** The id of the next chat to archive, or null. */
function nextArchive(now: number): string | null {
  const job = nextWorkerArchive(now);
  if (job && !job.archive) throw new Error(`expected an archive, got an unarchive of ${job.conversationId}`);
  return job?.conversationId ?? null;
}

it('queues nothing while the setting is off', async () => {
  await archiving(false);
  queueWorkerArchives([A], 1_000);
  await archiving(true);
  expect(nextArchive(1_000)).toBeNull();
});

it('hands out each ended worker chat once, leased, and forgets it once archived', () => {
  queueWorkerArchives([A, A.toUpperCase(), 'not-a-chat-id', B], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  expect(nextArchive(1_000)).toBe(B);
  // Both are leased: another browser pass gets nothing until the lease runs out.
  expect(nextArchive(1_001)).toBeNull();
  settleWorkerArchive(A, 'archived');
  expect(nextArchive(1_000 + WORKER_ARCHIVE_LEASE_MS)).toBe(B);
  settleWorkerArchive(B, 'archived');
  expect(nextArchive(Number.MAX_SAFE_INTEGER - 1)).toBeNull();
});

it('stops handing out chats when the setting is turned off, and resumes when it is on again', async () => {
  queueWorkerArchives([A], 1_000);
  await archiving(false);
  expect(nextArchive(1_000)).toBeNull();
  await archiving(true);
  expect(nextArchive(1_000)).toBe(A);
});

it('retries a failed archive later and gives up after the last attempt', () => {
  queueWorkerArchives([A], 0);
  let now = 0;
  for (let attempt = 1; attempt <= WORKER_ARCHIVE_MAX_ATTEMPTS; attempt += 1) {
    expect(nextArchive(now)).toBe(A);
    settleWorkerArchive(A, 'failed', now);
    // Not again right away.
    expect(nextArchive(now + 1)).toBeNull();
    now += 24 * 60 * 60_000;
  }
  expect(nextArchive(now)).toBeNull();
});

it('does not count a pass without a ChatGPT tab as an attempt', () => {
  queueWorkerArchives([A], 0);
  for (let pass = 0; pass < WORKER_ARCHIVE_MAX_ATTEMPTS + 2; pass += 1) {
    expect(nextArchive(pass)).toBe(A);
    settleWorkerArchive(A, 'deferred', pass);
  }
  expect(nextArchive(1_000)).toBe(A);
});

it('drops a chat that waited longer than a week', () => {
  queueWorkerArchives([A], 0);
  expect(nextArchive(8 * 24 * 60 * 60_000)).toBeNull();
});

it('keeps queued chats across a restart', async () => {
  queueWorkerArchives([A], 1_000);
  await workerArchiveWritten();
  await loadWorkerArchive();
  expect(nextArchive(1_000)).toBe(A);
});

it('ignores a result for a chat it never queued', () => {
  settleWorkerArchive(B, 'archived');
  queueWorkerArchives([A], 1_000);
  settleWorkerArchive(B, 'failed', 1_000);
  expect(nextArchive(1_000)).toBe(A);
});

it('waits the given delay before handing out a chat queued on finish, also across a restart', async () => {
  queueWorkerArchives([A], 1_000, 120_000);
  expect(nextArchive(1_000 + 119_999)).toBeNull();
  await workerArchiveWritten();
  await loadWorkerArchive();
  expect(nextArchive(1_000 + 119_999)).toBeNull();
  expect(nextArchive(1_000 + 120_000)).toBe(A);
});

it('does not archive the same chat twice', () => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_000);
  // The run ends later and names the same worker chat again.
  queueWorkerArchives([A], 2_000);
  expect(nextArchive(2_000)).toBeNull();
});

it('lets a wake through at once while the chat was never archived, and drops a queued archive for it', () => {
  expect(readyForWake(B, 1_000)).toBe(true);
  queueWorkerArchives([A], 1_000, 120_000);
  // The prime gave the worker more work before its chat was archived.
  expect(readyForWake(A, 2_000)).toBe(true);
  expect(nextArchive(1_000 + 120_000)).toBeNull();
});

it('unarchives an archived chat before a wake, even with the setting off, and then reports it ready', async () => {
  const ready: string[] = [];
  onWorkerChatReady((id) => ready.push(id));
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_000);
  await archiving(false);
  expect(readyForWake(A, 2_000)).toBe(false);
  expect(nextWorkerArchive(2_000)).toEqual({ conversationId: A, archive: false });
  expect(ready).toEqual([]);
  settleWorkerArchive(A, 'unarchived', 2_000);
  expect(ready).toEqual([A]);
  // It is an ordinary chat again: the next wake goes straight through.
  expect(readyForWake(A, 3_000)).toBe(true);
});

it('hands out an unarchive before any archive', () => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_000);
  queueWorkerArchives([B], 1_000);
  expect(readyForWake(A, 2_000)).toBe(false);
  expect(nextWorkerArchive(2_000)).toEqual({ conversationId: A, archive: false });
});

it('unarchives a chat whose archive was already under way when the wake came', () => {
  const ready: string[] = [];
  onWorkerChatReady((id) => ready.push(id));
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  // The browser is archiving it right now.
  expect(readyForWake(A, 1_500)).toBe(false);
  settleWorkerArchive(A, 'archived', 2_000);
  expect(nextWorkerArchive(2_000)).toEqual({ conversationId: A, archive: false });
  settleWorkerArchive(A, 'unarchived', 2_500);
  expect(ready).toEqual([A]);
});

it('releases a held wake after the hold time when the chat cannot be unarchived in time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const ready: string[] = [];
  onWorkerChatReady((id) => ready.push(id));
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_000);
  expect(readyForWake(A, 1_000)).toBe(false);
  // No ChatGPT page to unarchive it from.
  expect(nextWorkerArchive(1_000)?.archive).toBe(false);
  settleWorkerArchive(A, 'deferred', 1_000);
  vi.advanceTimersByTime(WORKER_UNARCHIVE_HOLD_MS - 1);
  expect(ready).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(ready).toEqual([A]);
  // The unarchive itself is still owed.
  expect(nextWorkerArchive(1_000 + WORKER_UNARCHIVE_HOLD_MS)).toEqual({ conversationId: A, archive: false });
  // Later wakes and messages no longer wait for it, and asking again changes nothing.
  expect(readyForWake(A, 2_000 + WORKER_UNARCHIVE_HOLD_MS)).toBe(true);
  settleWorkerArchive(A, 'unarchived', 1_000 + WORKER_UNARCHIVE_HOLD_MS);
  // Released once only.
  expect(ready).toEqual([A]);
});

it('asks once for a restore however often a waiting message asks', () => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_000);
  for (let poll = 0; poll < 5; poll += 1) expect(readyForWake(A, 2_000 + poll)).toBe(false);
  expect(nextWorkerArchive(3_000)).toEqual({ conversationId: A, archive: false });
  expect(nextWorkerArchive(3_000)).toBeNull();
});

it('releases a held wake when the unarchive gives up', () => {
  const ready: string[] = [];
  onWorkerChatReady((id) => ready.push(id));
  queueWorkerArchives([A], 0);
  expect(nextArchive(0)).toBe(A);
  settleWorkerArchive(A, 'archived', 0);
  expect(readyForWake(A, 0)).toBe(false);
  let now = 0;
  for (let attempt = 1; attempt <= WORKER_ARCHIVE_MAX_ATTEMPTS; attempt += 1) {
    expect(nextWorkerArchive(now)).toEqual({ conversationId: A, archive: false });
    settleWorkerArchive(A, 'failed', now);
    now += 60 * 60_000;
  }
  expect(ready).toEqual([A]);
  expect(nextWorkerArchive(now)).toBeNull();
});

it('archives a chat again when its run ends while its unarchive is still owed', () => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_000);
  expect(readyForWake(A, 2_000)).toBe(false);
  // The run is cleared before the browser got to it: the chat stays archived.
  queueWorkerArchives([A], 3_000);
  expect(nextWorkerArchive(3_000)).toBeNull();
});

it('archives a chat again when its run ends while it is being unarchived', () => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_000);
  expect(readyForWake(A, 2_000)).toBe(false);
  expect(nextWorkerArchive(2_000)?.archive).toBe(false);
  queueWorkerArchives([A], 2_500);
  settleWorkerArchive(A, 'unarchived', 3_000);
  expect(nextArchive(3_000)).toBe(A);
});

it('keeps knowing which chats it archived across a restart', async () => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_000);
  await workerArchiveWritten();
  await loadWorkerArchive();
  expect(readyForWake(A, 2_000)).toBe(false);
  expect(nextWorkerArchive(2_000)).toEqual({ conversationId: A, archive: false });
});
