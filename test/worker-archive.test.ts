import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { getLog } from '../src/main/logger.js';
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000);
  await archiving(true);
  resetWorkerArchiveForTests();
});
afterEach(async () => { await workerArchiveWritten(); vi.useRealTimers(); });

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

it.each([false, true])('restores again when an expired archive completes after the restore (reload: %s)', async (reload) => {
  queueWorkerArchives([A], 1_000);
  expect(nextWorkerArchive(1_000)).toEqual({ conversationId: A, archive: true });
  expect(readyForWake(A, 1_001)).toBe(false);
  const later = 1_000 + WORKER_ARCHIVE_LEASE_MS;
  expect(nextWorkerArchive(later)).toEqual({ conversationId: A, archive: false });
  settleWorkerArchive(A, 'unarchived', later + 1);
  expect(readyForWake(A, later + 2)).toBe(true);
  await workerArchiveWritten();
  if (reload) await loadWorkerArchive();
  // The old browser request applies its PATCH last, even though its lease expired.
  settleWorkerArchive(A, 'archived', later + 3);
  await workerArchiveWritten();
  await loadWorkerArchive();
  await archiving(false); // Finishing a restore must not depend on the setting.
  expect(readyForWake(A, later + 4)).toBe(false);
  expect(nextWorkerArchive(later + 4)).toEqual({ conversationId: A, archive: false });
  settleWorkerArchive(A, 'unarchived', later + 5);
  expect(readyForWake(A, later + 6)).toBe(true);
  expect(nextWorkerArchive(later + 6)).toBeNull();
});

it('keeps a newer archive owed when an older restore finishes last', () => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_001);
  expect(readyForWake(A, 2_000)).toBe(false);
  expect(nextWorkerArchive(2_000)?.archive).toBe(false);
  const later = 2_000 + WORKER_ARCHIVE_LEASE_MS;
  expect(nextWorkerArchive(later)?.archive).toBe(false);
  queueWorkerArchives([A], later + 1);
  settleWorkerArchive(A, 'unarchived', later + 2);
  expect(nextArchive(later + 2)).toBe(A);
  // The other restore lands before the newer archive finishes: it cannot retire that archive.
  settleWorkerArchive(A, 'unarchived', later + 3);
  expect(nextArchive(later + 3)).toBe(A);
  settleWorkerArchive(A, 'archived', later + 4);
  expect(nextWorkerArchive(later + 4)).toBeNull();
  // Even after the entry is retired, a delayed restore must be corrected.
  settleWorkerArchive(A, 'unarchived', later + 5);
  expect(nextArchive(later + 5)).toBe(A);
});

it('ignores duplicate settled results and never restores a chat it did not manage', async () => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_001);
  settleWorkerArchive(A, 'archived', 1_002);
  expect(getLog().at(-1)?.message).toContain('ignored late archived result');
  expect(getLog().at(-1)?.message).toContain('already matches remembered state');
  expect(nextWorkerArchive(1_002)).toBeNull();
  expect(readyForWake(A, 1_003)).toBe(false);
  expect(nextWorkerArchive(1_003)?.archive).toBe(false);
  settleWorkerArchive(A, 'unarchived', 1_004);
  await workerArchiveWritten();
  await loadWorkerArchive();
  for (const outcome of ['unarchived', 'failed', 'deferred'] as const) settleWorkerArchive(A, outcome, 1_005);
  for (const outcome of ['archived', 'unarchived'] as const) {
    settleWorkerArchive(B, outcome, 1_005);
    expect(getLog().at(-1)?.message).toContain(`ignored late ${outcome} result`);
    expect(getLog().at(-1)?.message).toContain('no remembered state');
  }
  expect(nextWorkerArchive(1_005)).toBeNull();
  expect(readyForWake(A, 1_005)).toBe(true);
  expect(readyForWake(B, 1_005)).toBe(true);
});

it('loads a version 2 archive record and skips damaged restored records', async () => {
  await workerArchiveWritten();
  const file = path.join(dir, 'state', 'worker-archive.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 2, entries: [], archived: [{ conversationId: A, at: 1_000 }] }));
  await loadWorkerArchive();
  expect(readyForWake(A, 1_001)).toBe(false);
  expect(nextWorkerArchive(1_001)?.archive).toBe(false);
  await workerArchiveWritten();
  await fs.writeFile(file, JSON.stringify({
    version: 3, entries: [], archived: [{ conversationId: A, at: 1_000 }],
    restored: [null, false, { conversationId: 'not-a-chat' }, { conversationId: B, at: 1_001 }]
  }));
  await loadWorkerArchive();
  expect(readyForWake(B, 1_002)).toBe(true);
  settleWorkerArchive(B, 'archived', 1_003);
  expect(nextWorkerArchive(1_003)).toEqual({ conversationId: B, archive: false });
  expect(readyForWake(A, 1_003)).toBe(false);
});

it.each(['load', 'lookup'])('expires archived and restored records after 30 days at %s', async boundary => {
  queueWorkerArchives([A, B], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_000);
  expect(nextArchive(1_000)).toBe(B);
  settleWorkerArchive(B, 'archived', 1_000);
  expect(readyForWake(B, 1_001)).toBe(false);
  expect(nextWorkerArchive(1_001)?.archive).toBe(false);
  settleWorkerArchive(B, 'unarchived', 1_001);
  await workerArchiveWritten();
  const now = 1_001 + 31 * 24 * 60 * 60_000;
  vi.setSystemTime(now);
  if (boundary === 'load') await loadWorkerArchive();
  expect(readyForWake(A, now)).toBe(true);
  settleWorkerArchive(B, 'archived', now);
  expect(nextWorkerArchive(now)).toBeNull();
  queueWorkerArchives([A], now); // Expired archive memory cannot suppress new work either.
  expect(nextArchive(now)).toBe(A);
});

it('keeps the saved timestamp when loading a retained record', async () => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  settleWorkerArchive(A, 'archived', 1_000);
  await workerArchiveWritten();
  const day = 24 * 60 * 60_000;
  vi.setSystemTime(1_000 + 29 * day);
  await loadWorkerArchive();
  vi.setSystemTime(1_001 + 30 * day);
  expect(readyForWake(A)).toBe(true);
});

it.each([false, true])('ignores receipts before the correction is leased (reload: %s)', async reload => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A);
  expect(readyForWake(A, 1_001)).toBe(false);
  const now = 1_000 + WORKER_ARCHIVE_LEASE_MS;
  expect(nextWorkerArchive(now)?.archive).toBe(false);
  settleWorkerArchive(A, 'unarchived', now + 1);
  settleWorkerArchive(A, 'archived', now + 2);
  await workerArchiveWritten();
  if (reload) await loadWorkerArchive();
  for (const outcome of ['unarchived', 'archived', 'failed', 'deferred'] as const) {
    settleWorkerArchive(A, outcome, now + 3);
    expect(readyForWake(A, now + 4)).toBe(false);
  }
  expect(nextWorkerArchive(now + 5)).toEqual({ conversationId: A, archive: false });
  settleWorkerArchive(A, 'unarchived', now + 6);
  expect(readyForWake(A, now + 7)).toBe(true);
  expect(nextWorkerArchive(now + 7)).toBeNull();
});

it('known limit: an older restore receipt can finish an already-leased correction', () => {
  queueWorkerArchives([A], 1_000);
  expect(nextArchive(1_000)).toBe(A); // Archive PATCH is held past its lease.
  expect(readyForWake(A, 1_001)).toBe(false);
  expect(nextWorkerArchive(1_000 + WORKER_ARCHIVE_LEASE_MS)?.archive).toBe(false);
  const now = 1_000 + 2 * WORKER_ARCHIVE_LEASE_MS;
  expect(nextWorkerArchive(now)?.archive).toBe(false);
  settleWorkerArchive(A, 'unarchived', now + 1); // Newer restore completes first.
  settleWorkerArchive(A, 'archived', now + 2); // Original archive PATCH lands last.
  expect(readyForWake(A, now + 3)).toBe(false);
  expect(nextWorkerArchive(now + 3)).toEqual({ conversationId: A, archive: false });
  // The older restore PATCH ran before the archive; only its receipt arrives now.
  // Once leased, the guard cannot distinguish this receipt from the correction's own.
  settleWorkerArchive(A, 'unarchived', now + 4);
  expect(nextWorkerArchive(now + 5)).toBeNull();
  expect(readyForWake(A, now + 5)).toBe(true); // Remote chat can still be archived.
});

it.each(['archived', 'restored'])('keeps at most 2,000 %s records without evicting the other state', async state => {
  const other = state === 'archived' ? 'restored' : 'archived';
  const records = Array.from({ length: 2_000 }, (_, i) => ({
    conversationId: `${i.toString(16).padStart(8, '0')}-1111-4222-8333-444444444444`, at: 1_000 + i
  }));
  await workerArchiveWritten();
  const file = path.join(dir, 'state', 'worker-archive.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 3, entries: [], [state]: records, [other]: [{ conversationId: B, at: 1_000 }] }));
  vi.setSystemTime(4_000);
  await loadWorkerArchive();
  queueWorkerArchives([A]);
  expect(nextArchive(4_000)).toBe(A);
  settleWorkerArchive(A, 'archived');
  if (state === 'restored') {
    expect(readyForWake(A)).toBe(false);
    expect(nextWorkerArchive()?.archive).toBe(false);
    settleWorkerArchive(A, 'unarchived');
  }
  await workerArchiveWritten();
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(saved[state]).toHaveLength(2_000);
  expect(saved[state]).not.toContainEqual(records[0]);
  expect(saved[state]).toContainEqual({ conversationId: A, at: 4_000 });
  expect(saved[other]).toEqual([{ conversationId: B, at: 1_000 }]);
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
