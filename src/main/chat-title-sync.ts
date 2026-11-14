/**
 * Synchronizes user-chosen manual chat titles from CoS to ChatGPT Web.
 *
 * Manual renames (`sessions:rename`) and newly bound / Compact & Resume manually named
 * chats (`rebindSession`) are queued durably in `state/chat-title-sync.json` and pushed
 * by the browser extension via `PATCH /backend-api/conversation/<id>` `{ title }`.
 *
 * When ChatGPT Web asynchronously auto-generates a different title (`gen_title`) shortly
 * after creation or compaction, `noteProviderChatTitle` re-queues the app's manual name a
 * bounded number of times so it sticks without looping.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { wakeBrowserWork } from './browser-wake.js';
import { logInfo, logWarn } from './logger.js';

export type ChatTitleSyncOutcome = 'synced' | 'failed' | 'deferred';
export type ChatTitleSyncReason = 'manual-rename' | 'rebind' | 'drift-repair';
export type ChatTitleSyncJob = { conversationId: string; title: string };

type Entry = {
  conversationId: string;
  title: string;
  queuedAt: number;
  attempts: number;
  notBefore: number;
  leased: boolean;
};

type DriftGuard = { title: string; until: number; repairs: number };

export const CHAT_TITLE_SYNC_LEASE_MS = 2 * 60_000;
export const CHAT_TITLE_SYNC_MAX_ATTEMPTS = 6;
const FIRST_BACKOFF_MS = 5_000;
const MAX_WAIT_MS = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 500;
const DRIFT_GUARD_MS = 30 * 60_000;
const MAX_DRIFT_REPAIRS = 2;
const MAX_DRIFT_GUARDS = 1_000;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let filePath = '';
const entries = new Map<string, Entry>();
const driftGuards = new Map<string, DriftGuard>();
let writing: Promise<void> = Promise.resolve();
let pending = false;

function cleanId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CONVERSATION_ID.test(id) ? id : null;
}

/** Single-line cleaned chat title matching `cleanSessionName` limits. */
export function cleanSyncedChatTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
  return clean || null;
}

function nonNeg(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function setGuard(id: string, title: string, until: number, repairs: number): void {
  driftGuards.delete(id);
  driftGuards.set(id, { title, until, repairs });
  if (driftGuards.size > MAX_DRIFT_GUARDS) driftGuards.delete(driftGuards.keys().next().value!);
}

export function initChatTitleSyncPath(userDataDir: string): void {
  filePath = path.join(userDataDir, 'state', 'chat-title-sync.json');
}

export async function loadChatTitleSync(): Promise<void> {
  entries.clear();
  driftGuards.clear();
  if (!filePath) return;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { entries?: unknown };
    for (const raw of Array.isArray(parsed.entries) ? parsed.entries : []) {
      const value = raw as Partial<Entry>;
      const id = cleanId(value.conversationId);
      const title = cleanSyncedChatTitle(value.title);
      if (!id || !title) continue;
      // Leases never outlive the process that issued them.
      entries.set(id, { conversationId: id, title, queuedAt: nonNeg(value.queuedAt), attempts: nonNeg(value.attempts), notBefore: 0, leased: false });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logWarn(`Chat title sync queue unreadable: ${(error as Error).message}`);
  }
}

function persist(): void {
  if (!filePath || pending) return;
  pending = true;
  writing = writing.then(async () => {
    pending = false;
    const temporary = `${filePath}.tmp`;
    const saved = [...entries.values()].map(({ notBefore: _nb, leased: _l, ...entry }) => entry);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries: saved }), 'utf8');
      await fs.rename(temporary, filePath);
    } catch (error) {
      logWarn(`Chat title sync queue not saved: ${(error as Error).message}`);
    }
  });
}

/** Resolves once every pending queue change so far has been written to disk. */
export function chatTitleSyncWritten(): Promise<void> {
  return writing;
}

/** Queues a manual chat title to push to ChatGPT Web; latest name replaces older pending names. */
export function queueChatTitleSync(
  conversationId: string,
  title: string,
  options: { reason?: ChatTitleSyncReason; now?: number } = {}
): boolean {
  const id = cleanId(conversationId);
  const cleanTitle = cleanSyncedChatTitle(title);
  if (!id || !cleanTitle) return false;
  const now = options.now ?? Date.now();
  const reason = options.reason ?? 'manual-rename';
  const existing = entries.get(id);
  if (!existing && entries.size >= MAX_ENTRIES) {
    logWarn(`chat title sync: queue full (${MAX_ENTRIES}); skipped ${id}`);
    return false;
  }
  entries.set(id, {
    conversationId: id,
    title: cleanTitle,
    queuedAt: existing ? existing.queuedAt : now,
    attempts: 0,
    notBefore: existing?.leased ? existing.notBefore : 0,
    leased: existing?.leased === true
  });
  const previousGuard = driftGuards.get(id);
  const repairs = reason === 'drift-repair' && previousGuard?.title === cleanTitle ? previousGuard.repairs : 0;
  setGuard(id, cleanTitle, now + DRIFT_GUARD_MS, repairs);
  logInfo(`chat title sync: queued ${id} (${reason})`);
  persist();
  wakeBrowserWork('wake');
  return true;
}

/** Drops any pending manual-title sync when the user clears the manual name or removes the chat. */
export function cancelChatTitleSync(conversationId: string | null | undefined): void {
  const id = cleanId(conversationId);
  if (!id) return;
  driftGuards.delete(id);
  if (!entries.delete(id)) return;
  logInfo(`chat title sync: cancelled pending sync for ${id}`);
  persist();
}

/** Re-queues the manual title a bounded number of times if ChatGPT auto-titling overwrites it. */
export function noteProviderChatTitle(
  conversationId: string | null | undefined,
  observedTitle: string,
  manualTitle: string,
  now = Date.now()
): boolean {
  const id = cleanId(conversationId);
  const observed = cleanSyncedChatTitle(observedTitle);
  const expected = cleanSyncedChatTitle(manualTitle);
  if (!id || !observed || !expected || observed === expected) return false;
  const guard = driftGuards.get(id);
  if (!guard || guard.title !== expected || guard.until <= now || guard.repairs >= MAX_DRIFT_REPAIRS) return false;
  const pendingEntry = entries.get(id);
  if (pendingEntry && pendingEntry.title === expected && !pendingEntry.leased) return false;
  setGuard(id, expected, Math.max(guard.until, now + DRIFT_GUARD_MS), guard.repairs + 1);
  logInfo(`chat title sync: ChatGPT title drifted for ${id}; re-queuing manual title`);
  return queueChatTitleSync(id, expected, { reason: 'drift-repair', now });
}

function nextDueEntry(now: number): { entry: Entry | null; dropped: boolean } {
  let dropped = false;
  for (const entry of entries.values()) {
    if (now - entry.queuedAt > MAX_WAIT_MS) {
      entries.delete(entry.conversationId);
      logWarn(`chat title sync: gave up on ${entry.conversationId} after a week`);
      dropped = true;
      continue;
    }
    if (entry.notBefore <= now) return { entry, dropped };
  }
  return { entry: null, dropped };
}

export function hasDueChatTitleSync(now = Date.now()): boolean {
  const { entry, dropped } = nextDueEntry(now);
  if (dropped) persist();
  return entry !== null;
}

/** Leases one due title sync job to the extension; returns null when none are due. */
export function nextChatTitleSync(now = Date.now()): ChatTitleSyncJob | null {
  const { entry, dropped } = nextDueEntry(now);
  if (dropped) persist();
  if (!entry) return null;
  entry.notBefore = now + CHAT_TITLE_SYNC_LEASE_MS;
  entry.leased = true;
  return { conversationId: entry.conversationId, title: entry.title };
}

/** Records the extension's result for one leased title sync job. */
export function settleChatTitleSync(
  conversationId: string,
  title: string,
  outcome: ChatTitleSyncOutcome,
  now = Date.now()
): void {
  const id = cleanId(conversationId);
  const reportedTitle = cleanSyncedChatTitle(title);
  const entry = id && reportedTitle ? entries.get(id) : undefined;
  if (!entry) return;
  entry.leased = false;
  // A newer rename superseded the leased title while the browser was applying the older one.
  if (entry.title !== reportedTitle) {
    entry.notBefore = 0;
    entry.attempts = 0;
    persist();
    wakeBrowserWork('wake');
    return;
  }
  if (outcome === 'deferred') {
    entry.notBefore = 0;
    return;
  }
  if (outcome === 'synced') {
    entries.delete(id!);
    const guard = driftGuards.get(id!);
    setGuard(id!, entry.title, Math.max(guard?.until ?? 0, now + DRIFT_GUARD_MS), guard?.title === entry.title ? guard.repairs : 0);
    logInfo(`chat title sync: synced ${id}`);
  } else if (++entry.attempts >= CHAT_TITLE_SYNC_MAX_ATTEMPTS) {
    entries.delete(id!);
    logWarn(`chat title sync: gave up on ${id} after ${entry.attempts} attempts`);
  } else {
    entry.notBefore = now + FIRST_BACKOFF_MS * 2 ** (entry.attempts - 1);
  }
  persist();
}

export function resetChatTitleSyncForTests(): void {
  entries.clear();
  driftGuards.clear();
}
