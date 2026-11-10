import { logInfo, logWarn } from './logger.js';

/**
 * The Continue a fresh turn is owed after the app's own rotation Stop (`ui.rotateStopFallback`, #2131).
 *
 * The Continue used to be filed once, when the stopped turn first ended. If the page refused it before
 * Send ("The composer changed; your draft was preserved", half a second after the Stop) it was recorded as
 * not sent and nothing filed it again; and when ChatGPT kept running the stopped request, the answers
 * never became final, so Goal had nothing to reply to and the chat sat idle until somebody wrote.
 *
 * Now the Continue stays owed until it is sent, the person moves the chat on, or the chat is gone. It is
 * filed again once the chat has been quiet for `OWED_QUIET_MS` (page and call activity restart that wait),
 * at most `OWED_MAX_ATTEMPTS` times in all and for at most `OWED_MAX_MS`.
 */
export const OWED_QUIET_MS = 45_000;
let quietMs = OWED_QUIET_MS;
/** Test seam: a shorter quiet wait (omit to restore). */
export function setOwedQuietForTests(ms = OWED_QUIET_MS): void { quietMs = ms; }
export const OWED_MAX_ATTEMPTS = 4;
export const OWED_MAX_MS = 2 * 60 * 60_000;

/** Where the owed Continue stands, read from the session and its inputs at the time of the check. */
export type OwedState = 'delivered' | 'moved' | 'gone' | 'busy' | 'open';

export interface OwedDeps {
  /** `delivered`: the Continue was sent. `moved`: a newer message of the person, or another chat. `busy`: a turn is running. */
  state(sessionId: string, conversationId: string, since: number): Promise<OwedState>;
  /** Files the Continue again; null when something else is waiting or the chat is busy or blocked. */
  file(sessionId: string, turnId: string): Promise<unknown | null>;
  now(): number;
}

interface Owed { sessionId: string; turnId: string; since: number; attempts: number; timer: ReturnType<typeof setTimeout> | null; deps: OwedDeps }
const owed = new Map<string, Owed>();

function arm(conversationId: string, entry: Owed): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { entry.timer = null; void check(conversationId, entry); }, quietMs);
  entry.timer.unref?.();
}

function drop(conversationId: string, entry: Owed): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (owed.get(conversationId) === entry) owed.delete(conversationId);
}

async function check(conversationId: string, entry: Owed): Promise<void> {
  if (owed.get(conversationId) !== entry) return;
  try {
    if (entry.deps.now() - entry.since > OWED_MAX_MS) {
      drop(conversationId, entry);
      logWarn(`turn rotation: ${conversationId} — the Continue after turn ${entry.turnId}'s Stop was never sent within 2 hours; giving up`);
      return;
    }
    const state = await entry.deps.state(entry.sessionId, conversationId, entry.since);
    if (owed.get(conversationId) !== entry) return;
    if (state === 'delivered' || state === 'moved' || state === 'gone') {
      drop(conversationId, entry);
      if (state !== 'delivered') logInfo(`turn rotation: ${conversationId} — the Continue after turn ${entry.turnId}'s Stop is no longer owed (${state === 'moved' ? 'the chat moved on' : 'the chat is gone'})`);
      return;
    }
    if (state === 'busy') { arm(conversationId, entry); return; }
    if (entry.attempts >= OWED_MAX_ATTEMPTS) {
      drop(conversationId, entry);
      logWarn(`turn rotation: ${conversationId} — the Continue after turn ${entry.turnId}'s Stop was not sent after ${entry.attempts} tries; the chat needs a message or Continue`);
      return;
    }
    const row = await entry.deps.file(entry.sessionId, entry.turnId);
    if (owed.get(conversationId) !== entry) return;
    if (row) {
      entry.attempts++;
      logInfo(`turn rotation: ${conversationId} — the Continue after turn ${entry.turnId}'s Stop was not sent and the chat is quiet; filing it again (try ${entry.attempts} of ${OWED_MAX_ATTEMPTS})`);
    }
    arm(conversationId, entry);
  } catch (error) {
    logWarn(`turn rotation: ${conversationId} — could not check the owed Continue: ${String(error)}`);
    if (owed.get(conversationId) === entry) arm(conversationId, entry);
  }
}

/** The first Continue of a stopped turn was just filed: it stays owed until it is sent. */
export function noteOwedContinue(conversationId: string, sessionId: string, turnId: string, deps: OwedDeps): void {
  const previous = owed.get(conversationId);
  if (previous) drop(conversationId, previous);
  const entry: Owed = { sessionId, turnId, since: deps.now(), attempts: 1, timer: null, deps };
  owed.set(conversationId, entry);
  arm(conversationId, entry);
}

/** The chat did something (a page report, a tool call): the quiet wait starts over. */
export function noteOwedActivity(conversationId: string): void {
  const entry = owed.get(conversationId);
  if (entry) arm(conversationId, entry);
}

/** A person's Stop, or anything else that ends the obligation. */
export function clearOwedContinue(conversationId: string): void {
  const entry = owed.get(conversationId);
  if (entry) drop(conversationId, entry);
}

export function owedContinueFor(conversationId: string): { attempts: number } | null {
  const entry = owed.get(conversationId);
  return entry ? { attempts: entry.attempts } : null;
}

/** Test seam: whether a check is booked for this chat (none is once the obligation ended). */
export function owedTimerPendingForTests(conversationId: string): boolean {
  return owed.get(conversationId)?.timer != null;
}

export function resetOwedContinuesForTests(): void {
  quietMs = OWED_QUIET_MS;
  for (const [id, entry] of [...owed]) drop(id, entry);
}
