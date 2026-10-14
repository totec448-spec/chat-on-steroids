import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  initWorkerArchivePath,
  loadWorkerArchive,
  nextWorkerArchive,
  queueWorkerArchives,
  settleWorkerArchive,
  WORKER_ARCHIVE_LEASE_MS,
  WORKER_ARCHIVE_MAX_ATTEMPTS,
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
  // Drain anything an earlier test left behind.
  for (let next = nextWorkerArchive(Number.MAX_SAFE_INTEGER - 1); next; next = nextWorkerArchive(Number.MAX_SAFE_INTEGER - 1)) {
    settleWorkerArchive(next, 'archived');
  }
});

it('queues nothing while the setting is off', async () => {
  await archiving(false);
  queueWorkerArchives([A], 1_000);
  await archiving(true);
  expect(nextWorkerArchive(1_000)).toBeNull();
});

it('hands out each ended worker chat once, leased, and forgets it once archived', () => {
  queueWorkerArchives([A, A.toUpperCase(), 'not-a-chat-id', B], 1_000);
  expect(nextWorkerArchive(1_000)).toBe(A);
  expect(nextWorkerArchive(1_000)).toBe(B);
  // Both are leased: another browser pass gets nothing until the lease runs out.
  expect(nextWorkerArchive(1_001)).toBeNull();
  settleWorkerArchive(A, 'archived');
  expect(nextWorkerArchive(1_000 + WORKER_ARCHIVE_LEASE_MS)).toBe(B);
  settleWorkerArchive(B, 'archived');
  expect(nextWorkerArchive(Number.MAX_SAFE_INTEGER - 1)).toBeNull();
});

it('stops handing out chats when the setting is turned off, and resumes when it is on again', async () => {
  queueWorkerArchives([A], 1_000);
  await archiving(false);
  expect(nextWorkerArchive(1_000)).toBeNull();
  await archiving(true);
  expect(nextWorkerArchive(1_000)).toBe(A);
});

it('retries a failed archive later and gives up after the last attempt', () => {
  queueWorkerArchives([A], 0);
  let now = 0;
  for (let attempt = 1; attempt <= WORKER_ARCHIVE_MAX_ATTEMPTS; attempt += 1) {
    expect(nextWorkerArchive(now)).toBe(A);
    settleWorkerArchive(A, 'failed', now);
    // Not again right away.
    expect(nextWorkerArchive(now + 1)).toBeNull();
    now += 24 * 60 * 60_000;
  }
  expect(nextWorkerArchive(now)).toBeNull();
});

it('does not count a pass without a ChatGPT tab as an attempt', () => {
  queueWorkerArchives([A], 0);
  for (let pass = 0; pass < WORKER_ARCHIVE_MAX_ATTEMPTS + 2; pass += 1) {
    expect(nextWorkerArchive(pass)).toBe(A);
    settleWorkerArchive(A, 'deferred', pass);
  }
  expect(nextWorkerArchive(1_000)).toBe(A);
});

it('drops a chat that waited longer than a week', () => {
  queueWorkerArchives([A], 0);
  expect(nextWorkerArchive(8 * 24 * 60 * 60_000)).toBeNull();
});

it('keeps queued chats across a restart', async () => {
  queueWorkerArchives([A], 1_000);
  await workerArchiveWritten();
  await loadWorkerArchive();
  expect(nextWorkerArchive(1_000)).toBe(A);
});

it('ignores a result for a chat it never queued', () => {
  settleWorkerArchive(B, 'archived');
  queueWorkerArchives([A], 1_000);
  settleWorkerArchive(B, 'failed', 1_000);
  expect(nextWorkerArchive(1_000)).toBe(A);
});
