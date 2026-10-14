/**
 * Archiving worker chats in ChatGPT once their run has ended (#1460).
 *
 * Every worker is a ChatGPT conversation, so a few runs fill the user's chat list. With
 * `multiAgent.archiveWorkerChats` on, each worker chat of an ended run is queued here, and the
 * browser extension archives it from a ChatGPT tab (`PATCH /backend-api/conversation/<id>`
 * with `is_archived: true`). Archiving is ChatGPT's own reversible action: the chat leaves the
 * list and can be restored from ChatGPT's settings. Nothing is ever deleted, and this app keeps
 * its own transcript either way.
 *
 * Temporary Chats were checked instead (2026-10-14): tools work there, but a page reload
 * loses the conversation, and recovery reloads stuck tabs.
 *
 * The queue survives a restart. Each entry is leased to one browser pass at a time; a failed
 * attempt backs off, a pass without any ChatGPT tab is not an attempt, and an entry is dropped
 * after its last attempt or a week of waiting.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';

export type WorkerArchiveOutcome = 'archived' | 'failed' | 'deferred';
type Entry = { conversationId: string; queuedAt: number; attempts: number; notBefore: number };

/** One browser pass owns an entry for this long before another may try it. */
export const WORKER_ARCHIVE_LEASE_MS = 2 * 60_000;
export const WORKER_ARCHIVE_MAX_ATTEMPTS = 6;
const FIRST_BACKOFF_MS = 5 * 60_000;
const MAX_WAIT_MS = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 500;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let filePath = '';
const entries = new Map<string, Entry>();
let writing: Promise<void> = Promise.resolve();
let pending = false;

function enabled(): boolean {
  return getConfig().multiAgent.archiveWorkerChats === true;
}

function cleanId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CONVERSATION_ID.test(id) ? id : null;
}

export function initWorkerArchivePath(userDataDir: string): void {
  filePath = path.join(userDataDir, 'state', 'worker-archive.json');
}

export async function loadWorkerArchive(): Promise<void> {
  entries.clear();
  if (!filePath) return;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { entries?: unknown };
    for (const raw of Array.isArray(parsed.entries) ? parsed.entries : []) {
      const value = raw as Partial<Entry>;
      const id = cleanId(value.conversationId);
      const number = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);
      if (!id) continue;
      // A lease never outlives the process that took it.
      entries.set(id, { conversationId: id, queuedAt: number(value.queuedAt), attempts: number(value.attempts), notBefore: 0 });
    }
  } catch (error) {
    // Missing until the first queued chat; an unreadable file only means chats stay in the list.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logWarn(`Worker archive queue unreadable: ${(error as Error).message}`);
  }
}

function persist(): void {
  if (!filePath || pending) return;
  pending = true;
  writing = writing.then(async () => {
    pending = false;
    const temporary = `${filePath}.tmp`;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries: [...entries.values()] }), 'utf8');
      await fs.rename(temporary, filePath);
    } catch (error) {
      logWarn(`Worker archive queue not saved: ${(error as Error).message}`);
    }
  });
}

/** Resolves once every change so far has reached the disk (tests, shutdown). */
export function workerArchiveWritten(): Promise<void> {
  return writing;
}

/** Queues the chats of workers whose run just ended, when the setting is on. */
export function queueWorkerArchives(conversationIds: readonly string[], now = Date.now()): void {
  if (!enabled()) return;
  let added = 0;
  for (const value of conversationIds) {
    const id = cleanId(value);
    if (!id || entries.has(id) || entries.size >= MAX_ENTRIES) continue;
    entries.set(id, { conversationId: id, queuedAt: now, attempts: 0, notBefore: 0 });
    added += 1;
  }
  if (added) {
    logInfo(`worker archive: queued ${added} worker chat(s)`);
    persist();
  }
}

/** The next chat to archive, leased to the caller; null while off or when nothing is due. */
export function nextWorkerArchive(now = Date.now()): string | null {
  if (!enabled()) return null;
  let dropped = false;
  for (const entry of entries.values()) {
    if (now - entry.queuedAt > MAX_WAIT_MS) {
      entries.delete(entry.conversationId);
      logWarn(`worker archive: gave up on ${entry.conversationId} after a week`);
      dropped = true;
      continue;
    }
    if (entry.notBefore > now) continue;
    entry.notBefore = now + WORKER_ARCHIVE_LEASE_MS;
    if (dropped) persist();
    return entry.conversationId;
  }
  if (dropped) persist();
  return null;
}

/** What the browser reported for one leased chat. */
export function settleWorkerArchive(conversationId: string, outcome: WorkerArchiveOutcome, now = Date.now()): void {
  const id = cleanId(conversationId);
  const entry = id ? entries.get(id) : undefined;
  if (!entry) return;
  if (outcome === 'archived') {
    entries.delete(entry.conversationId);
    logInfo(`worker archive: archived ${entry.conversationId}`);
  } else if (outcome === 'deferred') {
    // No ChatGPT tab to do it from: try again on a later pass, without spending an attempt.
    entry.notBefore = 0;
    return;
  } else {
    entry.attempts += 1;
    if (entry.attempts >= WORKER_ARCHIVE_MAX_ATTEMPTS) {
      entries.delete(entry.conversationId);
      logWarn(`worker archive: gave up on ${entry.conversationId} after ${entry.attempts} attempts`);
    } else {
      entry.notBefore = now + FIRST_BACKOFF_MS * 2 ** (entry.attempts - 1);
    }
  }
  persist();
}
