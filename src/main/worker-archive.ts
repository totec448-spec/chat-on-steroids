/**
 * Archiving worker chats in ChatGPT once their run has ended (#1460).
 *
 * Every worker is a ChatGPT conversation, so a few runs fill the user's chat list. With
 * `multiAgent.archiveWorkerChats` on, a worker's chat is queued here a little after it reports
 * its task done (#1701), and every worker chat of an ended run is queued too. The browser
 * extension archives it from a ChatGPT tab (`PATCH /backend-api/conversation/<id>` with
 * `is_archived: true`). Archiving is ChatGPT's own reversible action: the chat leaves the
 * list and can be restored from ChatGPT's settings. Nothing is ever deleted, and this app keeps
 * its own transcript either way.
 *
 * Temporary Chats were checked instead (2026-10-14): tools work there, but a page reload
 * loses the conversation, and recovery reloads stuck tabs.
 *
 * A finished worker can still be given more work. ChatGPT offers no message box in an archived
 * chat, so a wake for a chat archived here is held until the browser has unarchived it
 * ({@link readyForWake}), at most {@link WORKER_UNARCHIVE_HOLD_MS}. Unarchiving works with the
 * setting off too: turning it off must not strand a worker the app archived earlier.
 *
 * The queue survives a restart. Each entry is leased to one browser pass at a time; a failed
 * attempt backs off, a pass without any ChatGPT tab is not an attempt, and an entry is dropped
 * after its last attempt or a week of waiting.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';

export type WorkerArchiveOutcome = 'archived' | 'unarchived' | 'failed' | 'deferred';
/** One request for the browser: archive the chat, or (`archive: false`) restore it. */
export type WorkerArchiveJob = { conversationId: string; archive: boolean };
type Entry = {
  conversationId: string;
  archive: boolean;
  queuedAt: number;
  /** Not handed out before this (a finished worker's grace period). */
  dueAt: number;
  attempts: number;
  notBefore: number;
  /** Set while handed out: the browser is doing this job right now. */
  leased: boolean;
  /** Archive again once this unarchive has finished: the run ended meanwhile. */
  rearchive: boolean;
};

/** One browser pass owns an entry for this long before another may try it. */
export const WORKER_ARCHIVE_LEASE_MS = 2 * 60_000;
export const WORKER_ARCHIVE_MAX_ATTEMPTS = 6;
/** How long after a worker reports its task done its chat is archived: its last answer may still be streaming. */
export const WORKER_ARCHIVE_AFTER_FINISH_MS = 2 * 60_000;
/** The longest a wake waits for its chat to be unarchived before it goes ahead anyway. */
export const WORKER_UNARCHIVE_HOLD_MS = 90_000;
const FIRST_BACKOFF_MS = 5 * 60_000;
/** A held wake is waiting: retry an unarchive much sooner than an archive. */
const FIRST_UNARCHIVE_BACKOFF_MS = 15_000;
const MAX_WAIT_MS = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 500;
/** Chats archived here are remembered this long, and at most this many. */
const ARCHIVED_KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_ARCHIVED = 2_000;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let filePath = '';
const entries = new Map<string, Entry>();
/** Chats this app archived and has not restored since, with when. */
const archived = new Map<string, number>();
/** Wakes waiting for their chat to be unarchived, with the timer that lets them go anyway. */
const held = new Map<string, ReturnType<typeof setTimeout>>();
/** Chats whose hold ran out while their unarchive is still owed: they no longer wait. */
const gaveWay = new Set<string>();
const readyListeners = new Set<(conversationId: string) => void>();
let writing: Promise<void> = Promise.resolve();
let pending = false;

function enabled(): boolean {
  return getConfig().multiAgent.archiveWorkerChats === true;
}

function cleanId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CONVERSATION_ID.test(id) ? id : null;
}

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

export function initWorkerArchivePath(userDataDir: string): void {
  filePath = path.join(userDataDir, 'state', 'worker-archive.json');
}

export async function loadWorkerArchive(): Promise<void> {
  entries.clear();
  archived.clear();
  if (!filePath) return;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { entries?: unknown; archived?: unknown };
    for (const raw of Array.isArray(parsed.entries) ? parsed.entries : []) {
      const value = raw as Partial<Entry>;
      const id = cleanId(value.conversationId);
      if (!id) continue;
      // A lease never outlives the process that took it. Version 1 files only held archives.
      entries.set(id, {
        conversationId: id, archive: value.archive !== false, queuedAt: count(value.queuedAt), dueAt: count(value.dueAt),
        attempts: count(value.attempts), notBefore: 0, leased: false, rearchive: value.rearchive === true
      });
    }
    for (const raw of Array.isArray(parsed.archived) ? parsed.archived : []) {
      const value = raw as { conversationId?: unknown; at?: unknown };
      const id = cleanId(value.conversationId);
      if (id) archived.set(id, count(value.at));
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
    const saved = [...entries.values()].map(({ notBefore: _notBefore, leased: _leased, ...entry }) => entry);
    const known = [...archived].map(([conversationId, at]) => ({ conversationId, at }));
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ version: 2, entries: saved, archived: known }), 'utf8');
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

function rememberArchived(id: string, now: number): void {
  archived.delete(id);
  archived.set(id, now);
  for (const [old, at] of archived) {
    if (archived.size <= MAX_ARCHIVED && now - at <= ARCHIVED_KEEP_MS) break;
    archived.delete(old);
  }
}

/**
 * Queues worker chats to archive, when the setting is on: those of a run that just ended, or
 * (with `delayMs`) one whose worker just reported its task done. The delay lets that worker's
 * last answer finish, and lets a wake that follows at once simply drop the entry.
 */
export function queueWorkerArchives(conversationIds: readonly string[], now = Date.now(), delayMs = 0): void {
  if (!enabled()) return;
  let added = 0;
  let changed = false;
  for (const value of conversationIds) {
    const id = cleanId(value);
    if (!id) continue;
    const entry = entries.get(id);
    if (entry && !entry.archive) {
      // A wake is restoring this chat, and now its run is over after all.
      if (entry.leased) entry.rearchive = true;
      else {
        entries.delete(id);
        gaveWay.delete(id);
        release(id);
      }
      changed = true;
      continue;
    }
    if (entry || archived.has(id) || entries.size >= MAX_ENTRIES) continue;
    entries.set(id, {
      conversationId: id, archive: true, queuedAt: now, dueAt: now + delayMs, attempts: 0, notBefore: 0, leased: false, rearchive: false
    });
    added += 1;
  }
  if (added) logInfo(`worker archive: queued ${added} worker chat(s)`);
  if (added || changed) persist();
}

/**
 * Whether a chat can be typed into now: a wake of its worker, or a message you send it. A queued
 * archive that has not started is simply dropped. A chat archived here (or being archived) is
 * unarchived first: the answer is false until then, and {@link onWorkerChatReady} names the chat
 * once it may go ahead. After {@link WORKER_UNARCHIVE_HOLD_MS} it goes ahead anyway.
 */
export function readyForWake(conversationId: string, now = Date.now()): boolean {
  const id = cleanId(conversationId);
  if (!id) return true;
  const entry = entries.get(id);
  if (entry?.archive && !entry.leased) {
    entries.delete(id);
    persist();
    return true;
  }
  if (!entry && !archived.has(id)) return true;
  if (gaveWay.has(id)) return true;
  if (!entry || entry.archive || entry.rearchive) {
    if (!entry) {
      entries.set(id, {
        conversationId: id, archive: false, queuedAt: now, dueAt: 0, attempts: 0, notBefore: 0, leased: false, rearchive: false
      });
    } else {
      // Being archived right now: restore it as soon as that settles.
      if (entry.archive) entry.attempts = 0;
      entry.archive = false;
      entry.rearchive = false;
    }
    logInfo(`worker archive: unarchiving ${id} before it is typed into`);
    persist();
  }
  if (!held.has(id)) {
    const timer = setTimeout(() => {
      if (!held.has(id)) return;
      logWarn(`worker archive: ${id} is not unarchived yet; going ahead anyway`);
      gaveWay.add(id);
      release(id);
    }, WORKER_UNARCHIVE_HOLD_MS);
    timer.unref?.();
    held.set(id, timer);
  }
  return false;
}

/** Called with a chat whose held wake may now go ahead. */
export function onWorkerChatReady(listener: (conversationId: string) => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

function release(id: string): void {
  const timer = held.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  held.delete(id);
  for (const listener of readyListeners) listener(id);
}

/** The next job, leased to the caller; null when nothing is due. Restores go first. */
export function nextWorkerArchive(now = Date.now()): WorkerArchiveJob | null {
  let dropped = false;
  let next: Entry | null = null;
  for (const entry of entries.values()) {
    if (entry.archive && now - entry.queuedAt > MAX_WAIT_MS) {
      entries.delete(entry.conversationId);
      logWarn(`worker archive: gave up on ${entry.conversationId} after a week`);
      dropped = true;
      continue;
    }
    if (entry.notBefore > now || entry.dueAt > now || (entry.archive && !enabled())) continue;
    if (!entry.archive) { next = entry; break; }
    next ??= entry;
  }
  if (dropped) persist();
  if (!next) return null;
  next.notBefore = now + WORKER_ARCHIVE_LEASE_MS;
  next.leased = true;
  return { conversationId: next.conversationId, archive: next.archive };
}

/** What the browser reported for one leased job. */
export function settleWorkerArchive(conversationId: string, outcome: WorkerArchiveOutcome, now = Date.now()): void {
  const id = cleanId(conversationId);
  const entry = id ? entries.get(id) : undefined;
  if (!entry) return;
  entry.leased = false;
  if (outcome === 'deferred') {
    // No ChatGPT tab to do it from: try again on a later pass, without spending an attempt.
    entry.notBefore = 0;
    return;
  }
  if (outcome === 'archived') {
    rememberArchived(entry.conversationId, now);
    if (entry.archive) {
      entries.delete(entry.conversationId);
      logInfo(`worker archive: archived ${entry.conversationId}`);
    } else {
      // A wake came while it was being archived: restore it straight away.
      entry.notBefore = 0;
    }
  } else if (outcome === 'unarchived') {
    archived.delete(entry.conversationId);
    gaveWay.delete(entry.conversationId);
    logInfo(`worker archive: unarchived ${entry.conversationId}`);
    if (entry.rearchive) {
      Object.assign(entry, { archive: true, queuedAt: now, dueAt: now, attempts: 0, notBefore: 0, rearchive: false });
    } else entries.delete(entry.conversationId);
    release(entry.conversationId);
  } else {
    entry.attempts += 1;
    if (entry.attempts >= WORKER_ARCHIVE_MAX_ATTEMPTS) {
      entries.delete(entry.conversationId);
      logWarn(`worker archive: gave up ${entry.archive ? 'archiving' : 'unarchiving'} ${entry.conversationId} after ${entry.attempts} attempts`);
      gaveWay.delete(entry.conversationId);
      release(entry.conversationId);
    } else {
      entry.notBefore = now + (entry.archive ? FIRST_BACKOFF_MS : FIRST_UNARCHIVE_BACKOFF_MS) * 2 ** (entry.attempts - 1);
    }
  }
  persist();
}

export function resetWorkerArchiveForTests(): void {
  entries.clear();
  archived.clear();
  for (const timer of held.values()) clearTimeout(timer);
  held.clear();
  gaveWay.clear();
}
