/**
 * Push manual session renames from this app to ChatGPT Web (`PATCH /backend-api/conversation/<id>`).
 *
 * Manual renames made directly by the user (`renameSession(..., 'manual')`) and sessions carrying
 * a user-set manual title into newly bound or Compact & Resume chats (`rebindSession`) are queued
 * durably in `state/chat-title-sync.json` when `sessions.syncManualChatTitles` is enabled (off by
 * default).
 *
 * Newer ChatGPT Web titles are never overwritten: the app keeps the last known provider title
 * (`expectedRemoteTitle`) per conversation, the extension runs a `GET /backend-api/conversation/<id>`
 * pre-check before `PATCH`, and any divergence from `expectedRemoteTitle` drops the push (including
 * any superseded queued rename waiting behind an in-flight conflict) as a newer-remote-title conflict
 * without ever converting a remote Web change into permission for another push.
 *
 * Rate & burst behavior:
 * - Same-conversation renames coalesce to the latest title; the queue is capped at 200 entries.
 * - At most 1 job is leased at a time with a 2 s minimum interval between ChatGPT requests
 *   (<= 30 conversations/minute in a burst; <= 1 GET + 1 PATCH per conversation).
 * - HTTP 429 imposes a global queue cooldown honoring `Retry-After` (default 60 s).
 * - Every decision emits one structured log line (`queued`, `leased`, `deferred`, `sent`, `failed`, `dropped`).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { wakeBrowserWork } from './browser-wake.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';

export type ChatTitleSyncOutcome = 'synced' | 'failed' | 'deferred' | 'conflict';
export type ChatTitleSyncReason = 'manual-rename' | 'rebind' | 'drift-repair';
export type ChatTitleSyncJob = {
  conversationId: string;
  title: string;
  expectedRemoteTitle?: string;
};

type Entry = {
  conversationId: string;
  title: string;
  reason: ChatTitleSyncReason;
  expectedRemoteTitle?: string;
  queuedAt: number;
  attempts: number;
  notBefore: number;
  leased: boolean;
  leasedUntil: number;
};

export const CHAT_TITLE_SYNC_LEASE_MS = 60_000;
export const CHAT_TITLE_SYNC_RETRY_BASE_MS = 5_000;
export const CHAT_TITLE_SYNC_MAX_WAIT_MS = 7 * 24 * 60 * 60_000;
export const CHAT_TITLE_SYNC_MAX_ATTEMPTS = 5;
export const CHAT_TITLE_SYNC_MAX_ENTRIES = 200;
export const CHAT_TITLE_SYNC_MIN_INTERVAL_MS = 2_000;
export const CHAT_TITLE_SYNC_RATE_LIMIT_MS = 60_000;
const MAX_KNOWN_TITLES = 500;
const MAX_RATE_LIMIT_MS = 15 * 60_000;
const MIN_RATE_LIMIT_MS = 5_000;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let filePath = '';
const entries = new Map<string, Entry>();
const knownTitles = new Map<string, string>();
let writing: Promise<void> = Promise.resolve();
let pending = false;
let nextDispatchAt = 0;
let cooldownUntil = 0;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

function enabled(): boolean {
  return getConfig().sessions.syncManualChatTitles === true;
}

function cleanId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CONVERSATION_ID.test(id) ? id : null;
}

export function cleanSyncedChatTitle(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim()
    : '';
}

function nonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clampRateLimitMs(retryAfterMs?: number): number {
  const raw = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : CHAT_TITLE_SYNC_RATE_LIMIT_MS;
  return Math.min(MAX_RATE_LIMIT_MS, Math.max(MIN_RATE_LIMIT_MS, Math.round(raw)));
}

function rememberKnownTitle(id: string, title: string): void {
  const clean = cleanSyncedChatTitle(title);
  if (!clean) return;
  knownTitles.delete(id);
  knownTitles.set(id, clean);
  while (knownTitles.size > MAX_KNOWN_TITLES) {
    const oldest = knownTitles.keys().next();
    if (oldest.done) break;
    knownTitles.delete(oldest.value);
  }
}

function clearWakeTimer(): void {
  if (!wakeTimer) return;
  clearTimeout(wakeTimer);
  wakeTimer = null;
}

function scheduleWake(now = Date.now()): void {
  clearWakeTimer();
  if (!enabled() || entries.size === 0) return;
  let earliest = Infinity;
  let anyLeased = false;
  for (const entry of entries.values()) {
    if (entry.leased) {
      anyLeased = true;
      if (entry.leasedUntil < earliest) earliest = entry.leasedUntil;
      continue;
    }
    const readyAt = Math.max(entry.notBefore, nextDispatchAt, cooldownUntil);
    if (readyAt < earliest) earliest = readyAt;
  }
  if (!Number.isFinite(earliest)) return;
  if (anyLeased && earliest <= now) return;
  const delayMs = Math.max(0, earliest - now);
  if (delayMs === 0) return;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    if (hasDueChatTitleSync()) wakeBrowserWork('wake');
  }, delayMs);
  wakeTimer.unref?.();
}

export function initChatTitleSyncPath(userDataDir: string): void {
  filePath = path.join(userDataDir, 'state', 'chat-title-sync.json');
}

export async function loadChatTitleSync(): Promise<void> {
  entries.clear();
  knownTitles.clear();
  clearWakeTimer();
  nextDispatchAt = 0;
  cooldownUntil = 0;
  if (!filePath) return;
  const now = Date.now();
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      entries?: unknown;
      knownTitles?: unknown;
    };
    if (parsed.knownTitles && typeof parsed.knownTitles === 'object' && !Array.isArray(parsed.knownTitles)) {
      for (const [rawId, rawTitle] of Object.entries(parsed.knownTitles as Record<string, unknown>)) {
        const id = cleanId(rawId);
        const title = cleanSyncedChatTitle(rawTitle);
        if (id && title) rememberKnownTitle(id, title);
      }
    }
    for (const raw of Array.isArray(parsed.entries) ? parsed.entries : []) {
      const value = raw as Partial<Entry>;
      const id = cleanId(value.conversationId);
      const title = cleanSyncedChatTitle(value.title);
      if (!id || !title) continue;
      const queuedAt = nonNegative(value.queuedAt, now);
      const reason: ChatTitleSyncReason =
        value.reason === 'rebind' || value.reason === 'drift-repair' ? value.reason : 'manual-rename';
      const expectedRemoteTitle = cleanSyncedChatTitle(value.expectedRemoteTitle) || undefined;
      entries.set(id, {
        conversationId: id,
        title,
        reason,
        ...(expectedRemoteTitle ? { expectedRemoteTitle } : {}),
        queuedAt,
        attempts: nonNegative(value.attempts),
        notBefore: nonNegative(value.notBefore),
        // After a restart no browser pass holds a lease any more; try on next wake.
        leased: false,
        leasedUntil: 0
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn(`Chat title sync queue unreadable: ${(error as Error).message}`);
    }
  }
  scheduleWake(now);
}

function persist(): void {
  if (!filePath) return;
  pending = true;
  writing = writing.then(async () => {
    if (!pending || !filePath) return;
    pending = false;
    const payload = {
      entries: [...entries.values()].map(entry => ({
        conversationId: entry.conversationId,
        title: entry.title,
        reason: entry.reason,
        ...(entry.expectedRemoteTitle ? { expectedRemoteTitle: entry.expectedRemoteTitle } : {}),
        queuedAt: entry.queuedAt,
        attempts: entry.attempts,
        notBefore: entry.notBefore
      })),
      knownTitles: Object.fromEntries(knownTitles)
    };
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fs.rename(tmp, filePath);
    } catch (error) {
      logWarn(`Chat title sync queue not saved: ${(error as Error).message}`);
    }
  });
}

export async function chatTitleSyncWritten(): Promise<void> {
  await writing;
}

export function queueChatTitleSync(
  conversationId: string | null | undefined,
  title: string,
  options: { reason?: ChatTitleSyncReason; expectedRemoteTitle?: string | null } = {}
): boolean {
  if (!enabled()) return false;
  const id = cleanId(conversationId);
  const clean = cleanSyncedChatTitle(title);
  if (!id || !clean) return false;
  const reason: ChatTitleSyncReason = options.reason ?? 'manual-rename';
  const providedExpected = cleanSyncedChatTitle(options.expectedRemoteTitle);
  const now = Date.now();
  const existing = entries.get(id);
  if (!existing && entries.size >= CHAT_TITLE_SYNC_MAX_ENTRIES) {
    logWarn(`chat title sync: dropped ${id} (queue-full:${CHAT_TITLE_SYNC_MAX_ENTRIES})`);
    return false;
  }
  if (reason === 'manual-rename') {
    if (providedExpected && !knownTitles.has(id)) rememberKnownTitle(id, providedExpected);
  }
  const expectedRemoteTitle = reason === 'rebind'
    ? knownTitles.get(id)
    : (knownTitles.get(id) ?? existing?.expectedRemoteTitle ?? (providedExpected || undefined));
  entries.set(id, {
    conversationId: id,
    title: clean,
    reason,
    ...(expectedRemoteTitle ? { expectedRemoteTitle } : {}),
    queuedAt: now,
    attempts: 0,
    notBefore: 0,
    leased: existing?.leased ?? false,
    leasedUntil: existing?.leasedUntil ?? 0
  });
  persist();
  logInfo(`chat title sync: queued ${id} (${reason})`);
  if (nextDispatchAt <= now && cooldownUntil <= now && !existing?.leased) {
    wakeBrowserWork('wake');
  } else {
    scheduleWake(now);
  }
  return true;
}

export function cancelChatTitleSync(
  conversationId: string | null | undefined,
  reason = 'cancelled'
): boolean {
  const id = cleanId(conversationId);
  if (!id) return false;
  if (!entries.delete(id)) return false;
  persist();
  scheduleWake();
  logInfo(`chat title sync: dropped ${id} (${reason})`);
  return true;
}

export function cancelAllChatTitleSync(reason = 'setting-disabled'): number {
  if (entries.size === 0) return 0;
  const ids = [...entries.keys()];
  entries.clear();
  clearWakeTimer();
  persist();
  for (const id of ids) {
    logInfo(`chat title sync: dropped ${id} (${reason})`);
  }
  return ids.length;
}

/**
 * Reconciles an observed ChatGPT Web provider title against any pending manual title push:
 * - Newer remote edits detected while a sync is queued drop the pending push rather than overwriting Web.
 * - Any remote title observed after a push settles (including after Compact & Resume) is recorded as
 *   the latest known remote title without converting it into permission to push again.
 */
export function noteProviderChatTitle(
  conversationId: string | null | undefined,
  observedTitle: string
): boolean {
  const id = cleanId(conversationId);
  const observedClean = cleanSyncedChatTitle(observedTitle);
  if (!id || !observedClean) return false;
  rememberKnownTitle(id, observedClean);
  if (!enabled()) return false;

  const existing = entries.get(id);
  if (!existing) return false;
  if (observedClean === existing.title) return false;
  if (existing.expectedRemoteTitle && observedClean !== existing.expectedRemoteTitle) {
    entries.delete(id);
    persist();
    scheduleWake();
    logInfo(`chat title sync: dropped ${id} (newer-remote-title)`);
    return false;
  }
  if (existing.reason === 'rebind' && !existing.expectedRemoteTitle) {
    existing.expectedRemoteTitle = observedClean;
    persist();
  }
  return false;
}

function pruneExpired(now: number): boolean {
  let dirty = false;
  for (const [id, entry] of entries) {
    if (now - entry.queuedAt > CHAT_TITLE_SYNC_MAX_WAIT_MS) {
      entries.delete(id);
      dirty = true;
      logWarn(`chat title sync: dropped ${entry.conversationId} (expired)`);
    } else if (entry.leased && now >= entry.leasedUntil) {
      entry.leased = false;
      entry.leasedUntil = 0;
    }
  }
  return dirty;
}

export function hasDueChatTitleSync(now = Date.now()): boolean {
  if (pruneExpired(now)) persist();
  if (!enabled()) return false;
  if (now < nextDispatchAt || now < cooldownUntil) return false;
  for (const entry of entries.values()) {
    if (entry.leased) return false;
  }
  for (const entry of entries.values()) {
    if (entry.notBefore <= now) return true;
  }
  return false;
}

export function nextChatTitleSync(now = Date.now()): ChatTitleSyncJob | null {
  if (pruneExpired(now)) persist();
  if (!enabled()) return null;
  if (now < nextDispatchAt || now < cooldownUntil) return null;
  for (const entry of entries.values()) {
    if (entry.leased) return null;
  }
  for (const entry of entries.values()) {
    if (entry.notBefore > now) continue;
    entry.leased = true;
    entry.leasedUntil = now + CHAT_TITLE_SYNC_LEASE_MS;
    logInfo(`chat title sync: leased ${entry.conversationId} (${entry.reason})`);
    return {
      conversationId: entry.conversationId,
      title: entry.title,
      ...(entry.expectedRemoteTitle ? { expectedRemoteTitle: entry.expectedRemoteTitle } : {})
    };
  }
  return null;
}

export function settleChatTitleSync(
  conversationId: string,
  title: string,
  outcome: ChatTitleSyncOutcome,
  details: { status?: number; retryAfterMs?: number; remoteTitle?: string; alreadyMatched?: boolean } = {}
): boolean {
  const id = cleanId(conversationId);
  const clean = cleanSyncedChatTitle(title);
  if (!id || !clean) return false;
  const entry = entries.get(id);
  if (!entry) return false;

  const now = Date.now();
  if (outcome !== 'deferred') {
    nextDispatchAt = Math.max(nextDispatchAt, now + CHAT_TITLE_SYNC_MIN_INTERVAL_MS);
  }

  if (outcome === 'synced') {
    rememberKnownTitle(id, clean);
  } else if (outcome === 'conflict') {
    const cleanRemote = cleanSyncedChatTitle(details.remoteTitle);
    if (cleanRemote) rememberKnownTitle(id, cleanRemote);
  }

  if (entry.title !== clean) {
    // A newer manual title was queued while this request was in flight.
    entry.leased = false;
    entry.leasedUntil = 0;
    if (outcome === 'conflict') {
      entries.delete(id);
      persist();
      scheduleWake(now);
      logInfo(`chat title sync: dropped ${id} (newer-remote-title, superseded)`);
      return true;
    }
    if (outcome === 'synced') entry.expectedRemoteTitle = clean;
    if (outcome === 'failed' && details.status === 429) {
      const waitMs = clampRateLimitMs(details.retryAfterMs);
      cooldownUntil = Math.max(cooldownUntil, now + waitMs);
    }
    persist();
    scheduleWake(now);
    if (outcome === 'synced') {
      logInfo(`chat title sync: sent ${id} (${details.alreadyMatched ? 'already-matched' : 'patched'})`);
    } else if (outcome === 'deferred') {
      logInfo(`chat title sync: deferred ${id} (no active ChatGPT tab)`);
    } else {
      logWarn(`chat title sync: failed ${id} (superseded${details.status ? `, status=${details.status}` : ''})`);
    }
    return true;
  }

  entry.leased = false;
  entry.leasedUntil = 0;

  if (outcome === 'deferred') {
    logInfo(`chat title sync: deferred ${id} (no active ChatGPT tab)`);
    scheduleWake(now);
    return true;
  }

  if (outcome === 'synced') {
    entries.delete(id);
    logInfo(`chat title sync: sent ${id} (${details.alreadyMatched ? 'already-matched' : 'patched'})`);
    persist();
    scheduleWake(now);
    return true;
  }

  if (outcome === 'conflict') {
    entries.delete(id);
    logInfo(`chat title sync: dropped ${id} (newer-remote-title)`);
    persist();
    scheduleWake(now);
    return true;
  }

  entry.attempts += 1;
  const backoffMs = CHAT_TITLE_SYNC_RETRY_BASE_MS * 2 ** (entry.attempts - 1);
  if (details.status === 429) {
    const waitMs = clampRateLimitMs(details.retryAfterMs);
    cooldownUntil = Math.max(cooldownUntil, now + waitMs);
  }
  const effectiveWaitMs = Math.max(backoffMs, Math.max(0, cooldownUntil - now));
  const statusPart = details.status ? `, status=${details.status}` : '';
  if (entry.attempts >= CHAT_TITLE_SYNC_MAX_ATTEMPTS) {
    entries.delete(id);
    logWarn(`chat title sync: failed ${id} (attempt ${entry.attempts}/${CHAT_TITLE_SYNC_MAX_ATTEMPTS}${statusPart})`);
    logWarn(`chat title sync: dropped ${id} (max-attempts:${entry.attempts})`);
  } else {
    entry.notBefore = now + backoffMs;
    logWarn(
      `chat title sync: failed ${id} (attempt ${entry.attempts}/${CHAT_TITLE_SYNC_MAX_ATTEMPTS}${statusPart}, retry=${Math.round(effectiveWaitMs / 1000)}s)`
    );
  }
  persist();
  scheduleWake(now);
  return true;
}

/** Test seam: forgets queued jobs without touching disk. */
export function resetChatTitleSyncForTests(): void {
  clearWakeTimer();
  entries.clear();
  knownTitles.clear();
  nextDispatchAt = 0;
  cooldownUntil = 0;
  pending = false;
  writing = Promise.resolve();
}
