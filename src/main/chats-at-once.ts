import { getConfig } from './config.js';
import { readDurable, writeDurableNow } from './durable.js';
import { logInfo, logWarn } from './logger.js';

/**
 * "Chats working at once" (#1694, design reviewed by Haz): at most this many chats work at the
 * same time, counting workers. Only messages the app sends by itself wait their turn: Goal and Loop
 * steps, automatic Continue, the fresh turn, scheduled runs and a finish's own checkpoints. A
 * message the person sends, Stop and approvals never wait.
 *
 * This is one gate inside the existing send paths, not a scheduler: each path keeps its own queue,
 * order and no-duplicate safeguards and asks here whether it may go now. What counts as working is
 * the app's own record (bridge.ts installs it): a turn the page reports, or a running tool call.
 * Nothing here releases a running turn on a timer; only the recovery system's own states do.
 */
let workingChats: () => ReadonlySet<string> = () => new Set();
export function setWorkingChatsSource(source: () => ReadonlySet<string>): void { workingChats = source; }
export function workingChatsSourceForTests(): () => ReadonlySet<string> { return workingChats; }

/** A waiter that stopped asking this long ago has left the line (its send went another way or was cancelled). */
const WAITER_GONE_MS = 2 * 60_000;
/** An admitted send holds its slot until its chat is seen working, at most this long. */
const ADMISSION_HOLD_MS = 2 * 60_000;
/**
 * A worker's reservation, while the worker is still starting or waking, holds at most this long:
 * a delivery-proven revival may take up to REVIVAL_ACTIVITY_MS (bridge.ts, 3 + 3 minutes) before its
 * chat shows as working (CodeRabbit on #2051). A worker that ended, failed or stayed asleep frees
 * its slot at once through setWorkerSlotSource, so this bound only covers a worker really on its way.
 */
export const WORKER_ADMISSION_HOLD_MS = 6 * 60_000;
/** Two chats showing ChatGPT's limit within this window make the pause account-wide. */
const SHARED_LIMIT_WINDOW_MS = 10 * 60_000;
/** The pause when ChatGPT names no time. */
const DEFAULT_PAUSE_MS = 15 * 60_000;
const STATE = 'chats-at-once';

/**
 * What became of a worker a slot was reserved for (agents.ts installs it, Haz on #2051): still
 * starting, working in its own chat, or over (failed, finished, refused, or a wake that did not go).
 */
export type WorkerSlotState = { kind: 'pending' } | { kind: 'over' } | { kind: 'chat'; conversationId: string };
let workerSlotState: (worker: string, reservedAt: number, now: number) => WorkerSlotState = () => ({ kind: 'pending' });
export function setWorkerSlotSource(source: (worker: string, reservedAt: number, now: number) => WorkerSlotState): void { workerSlotState = source; }

const waiting = new Map<string, { since: number; asked: number }>();
const admitted = new Map<string, { conversationId: string | null; at: number; seen: boolean; worker?: string }>();
const limitSeen = new Map<string, { at: number; retryAt: number | null }>();
let pauseUntil: number | null = null;
/** When the person last pressed Resume now: a limit notice seen before it is not new evidence. */
let resumedAt = 0;
const listeners = new Set<() => void>();
export function onChatsAtOnceChange(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
function changed(): void { for (const listener of listeners) listener(); }

export function chatsAtOnceLimit(): number {
  const limit = getConfig().multiAgent.chatsAtOnce ?? 0;
  return Number.isInteger(limit) && limit > 0 ? limit : 0;
}

function activePause(now: number): number | null {
  if (pauseUntil !== null && pauseUntil <= now) {
    pauseUntil = null;
    logInfo('chats at once: the pause ChatGPT asked for is over; automatic messages go out again');
    void writeDurableNow(STATE, { version: 1, pauseUntil: null }).catch(() => undefined);
    changed();
  }
  return chatsAtOnceLimit() ? pauseUntil : null;
}

/** The slots taken: working chats, plus admitted sends whose chat has not shown up as working yet. */
function occupied(now: number): Set<string> {
  const working = new Set(workingChats());
  const taken = new Set<string>(working);
  for (const [key, entry] of admitted) {
    // A worker's reservation follows its worker: once its chat is known it is that chat's slot, so a
    // running worker counts once; a worker that ended or never started gives its slot back at once.
    if (entry.worker) {
      const state = workerSlotState(entry.worker, entry.at, now);
      if (state.kind === 'over') { admitted.delete(key); continue; }
      if (state.kind === 'chat') entry.conversationId = state.conversationId;
    }
    const isWorking = entry.conversationId !== null && working.has(entry.conversationId);
    if (isWorking) { entry.seen = true; continue; }
    if (entry.seen || now - entry.at > (entry.worker ? WORKER_ADMISSION_HOLD_MS : ADMISSION_HOLD_MS)) { admitted.delete(key); continue; }
    taken.add(`admitted:${key}`);
  }
  return taken;
}

/**
 * Null when this automatic send may go now; otherwise why it waits, in words for the log and the
 * chat. `key` names the waiting send (its input id, a Goal turn, a worker); `conversationId` the
 * chat it goes to, null for a chat not opened yet.
 */
export function automaticSendRefusal(key: string, conversationId: string | null, now = Date.now()): string | null {
  const limit = chatsAtOnceLimit();
  if (!limit) { waiting.clear(); admitted.clear(); return null; }
  const pause = activePause(now);
  if (pause !== null) {
    note(key, now);
    return `ChatGPT asked to slow down; automatic messages resume at ${new Date(pause).toISOString()}`;
  }
  const taken = occupied(now);
  // Already admitted and not yet seen working: its slot is its own (the page asks again on every poll).
  if (admitted.has(key)) return null;
  // A chat already working takes no new slot: this is its own next step.
  if (conversationId !== null && workingChats().has(conversationId)) { waiting.delete(key); return null; }
  for (const [other, entry] of waiting) if (now - entry.asked > WAITER_GONE_MS) waiting.delete(other);
  note(key, now);
  const free = limit - taken.size;
  if (free <= 0) return `${taken.size} chats are working (limit ${limit})`;
  const line = [...waiting].sort((a, b) => a[1].since - b[1].since).map(([waiter]) => waiter);
  const place = line.indexOf(key);
  if (place >= free) return `waiting for a free slot (${place + 1} in line, limit ${limit})`;
  waiting.delete(key);
  admitted.set(key, { conversationId, at: now, seen: false });
  return null;
}

/**
 * Only ChatGPT's account-wide pause, for a send that already has its slot: rechecked right before
 * Send, since a pause can start between the offer and the click (CodeRabbit on #2051).
 */
export function automaticPauseRefusal(now = Date.now()): string | null {
  if (!chatsAtOnceLimit()) return null;
  const pause = activePause(now);
  return pause === null ? null : `ChatGPT asked to slow down; automatic messages resume at ${new Date(pause).toISOString()}`;
}

function note(key: string, now: number): void {
  const entry = waiting.get(key);
  if (entry) entry.asked = now;
  else waiting.set(key, { since: now, asked: now });
}

/**
 * Room for workers a prime starts or wakes (#1694): null when all fit, else why not. The calling
 * prime's own slot passes to its workers, since it delegates and then ends its turn; the others'
 * slots stay theirs. On success each worker holds a slot until its own chat shows as working; `workers` names them
 * (see setWorkerSlotSource), so the slot follows the worker rather than a timer.
 * Refused rather than queued, like the other worker limits: no second scheduler (Haz on #1694).
 */
export function workerSlotsRefusal(callerConversationId: string | null, workers: readonly string[], now = Date.now()): string | null {
  const limit = chatsAtOnceLimit();
  const count = workers.length;
  if (!limit || count <= 0) return null;
  const pause = activePause(now);
  if (pause !== null) return `ChatGPT asked to slow down; automatic work resumes at ${new Date(pause).toISOString()}`;
  const taken = occupied(now);
  if (callerConversationId) taken.delete(callerConversationId);
  if (taken.size + count > limit) return `${taken.size} other chats are working and the limit is ${limit}`;
  // Each worker its own reservation, named after it: two spawns in the same millisecond never share one.
  for (const worker of workers) admitted.set(`worker:${worker}`, { conversationId: null, at: now, seen: false, worker });
  return null;
}

/**
 * ChatGPT showed its limit message in a chat (a blocking access-limit notice, with or without a
 * retry time). One chat is that chat's limit, already held there. A second chat within ten minutes
 * is evidence the limit is the account's, and then every chat's automatic sends wait until the
 * time ChatGPT named, or 15 minutes when it named none.
 *
 * `observedAt` is when the page saw the notice: a replayed old notice, or one from before the
 * person's Resume now, is not new evidence (CodeRabbit on #2051).
 */
export function noteChatLimit(conversationId: string, retryAt: number | null, observedAt: number, now = Date.now()): void {
  if (!chatsAtOnceLimit()) return;
  if (!Number.isFinite(observedAt) || observedAt <= resumedAt || now - observedAt > SHARED_LIMIT_WINDOW_MS || observedAt > now + 60_000) return;
  const previous = limitSeen.get(conversationId);
  if (previous && previous.at >= observedAt) return;
  limitSeen.set(conversationId, { at: Math.min(observedAt, now), retryAt: retryAt !== null && retryAt > now ? retryAt : null });
  for (const [id, seen] of limitSeen) if (now - seen.at > SHARED_LIMIT_WINDOW_MS) limitSeen.delete(id);
  if (limitSeen.size < 2) return;
  const until = Math.max(...[...limitSeen.values()].map(seen => seen.retryAt ?? seen.at + DEFAULT_PAUSE_MS));
  if (pauseUntil !== null && pauseUntil >= until) return;
  pauseUntil = until;
  logWarn(`chats at once: ChatGPT showed its limit in ${limitSeen.size} chats within 10 minutes; automatic messages in every chat wait until ${new Date(until).toISOString()}`);
  void writeDurableNow(STATE, { version: 1, pauseUntil }).catch(error =>
    logWarn(`chats at once: the pause could not be saved: ${error instanceof Error ? error.message : String(error)}`));
  changed();
}

/**
 * The person's Resume now: automatic messages go out again at once, at the risk of the limit
 * returning. The cleared pause is saved before this answers, so a restart cannot bring back a pause
 * the screen already said was over (CodeRabbit on #2051); if saving fails, the pause stays.
 */
export async function resumeAutomaticSends(now = Date.now()): Promise<boolean> {
  if (pauseUntil === null || pauseUntil <= now) return false;
  try {
    await writeDurableNow(STATE, { version: 1, pauseUntil: null });
  } catch (error) {
    logWarn(`chats at once: Resume now could not be saved, so the pause stays: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error('Resume now could not be saved. Automatic messages stay paused.');
  }
  pauseUntil = null;
  limitSeen.clear();
  resumedAt = now;
  logInfo('chats at once: the person resumed automatic messages before ChatGPT\'s time');
  changed();
  return true;
}

export function chatsAtOnceStatus(now = Date.now()): { limit: number; working: number; pauseUntil: number | null; waiting: number } {
  const limit = chatsAtOnceLimit();
  return { limit, working: limit ? workingChats().size : 0, pauseUntil: activePause(now), waiting: limit ? waiting.size : 0 };
}

export async function restoreChatsAtOnce(now = Date.now()): Promise<void> {
  const saved = await readDurable<{ version?: number; pauseUntil?: unknown }>(STATE).catch(() => null);
  const until = saved?.version === 1 && typeof saved.pauseUntil === 'number' && Number.isFinite(saved.pauseUntil) ? saved.pauseUntil : null;
  // A damaged or far-off value is not ChatGPT's: at most a day ahead is kept.
  pauseUntil = until !== null && until > now && until - now <= 24 * 60 * 60_000 ? until : null;
}

export function resetChatsAtOnceForTests(): void {
  waiting.clear(); admitted.clear(); limitSeen.clear(); pauseUntil = null; resumedAt = 0; workingChats = () => new Set();
}
