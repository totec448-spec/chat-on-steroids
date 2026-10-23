/**
 * Fresh turns for long work (#1402).
 *
 * Measured over a 24-hour run and reproduced on another account: turns up to about 35 minutes
 * ended cleanly, turns that ran 37–64 minutes almost always broke (stream lost, "Message delivery
 * timed out", stalls), and every break then cost reloads and history limits. What worked by hand
 * every time was Stop and "continue". So once a turn has run `ui.rotateTurnMinutes` (default 30),
 * the next attributed tool result files one automatic continue into that turn: a native send there
 * ends it as interrupted and carries on in a fresh one, the call in flight keeping its result.
 *
 * Decided per attributed tool call while that call's answer is still held (rotation-hold.ts), so the
 * continue goes in while ChatGPT still sees the call running, never in the middle of answer text. One rotation per turn; a refused filing is tried again after a minute, a
 * filed one the page did not take after five, and a turn is left alone after two filings it did
 * not take (2026-10-15: seven unsent continues in two turns of one chat, each shown as not sent).
 *
 * A continue the page declined because ChatGPT offered no Send (it showed Stop at that tool result,
 * 2026-10-20) is different: it never reached ChatGPT, and a later tool result usually comes without
 * Stop. It is tried again after a minute, does not count towards those two, and a turn is left
 * alone after six such declines.
 */
export interface RotationDeps {
  now(): number;
  /** Minutes before a turn is rotated; 0 is off. */
  minutes(): number;
  /** When this exact turn started, or null when that is not known. */
  turnStartedAt(sessionId: string, turnId: string): Promise<number | null>;
  /** Files the automatic continue into exactly this running turn; null when the outbox refused. */
  file(sessionId: string, turnId: string): Promise<unknown | null>;
  log(message: string): void;
}

const REFUSED_RETRY_MS = 60_000;
const UNTAKEN_RETRY_MS = 5 * 60_000;
const MAX_FILED_PER_TURN = 2;
const MAX_DECLINED_PER_TURN = 6;
const attempts = new Map<string, { turnId: string; at: number; filed: boolean; filings: number; declines?: number; gaveUp?: boolean; stopped?: boolean }>();
/** With `ui.rotateStopFallback`, after this many continues ChatGPT offered no Send for, the turn is stopped instead. */
export const STOP_FALLBACK_AFTER_DECLINES = 2;
const inFlight = new Set<string>();

export async function considerTurnRotation(conversationId: string, sessionId: string, turnId: string, deps: RotationDeps): Promise<boolean> {
  const minutes = deps.minutes();
  if (!(minutes > 0) || inFlight.has(conversationId)) return false;
  const now = deps.now();
  const last = attempts.get(conversationId);
  if (last?.turnId === turnId && (last.gaveUp || now - last.at < (last.filed ? UNTAKEN_RETRY_MS : REFUSED_RETRY_MS))) return false;
  if (last?.turnId === turnId && (last.declines ?? 0) >= MAX_DECLINED_PER_TURN) {
    attempts.set(conversationId, { ...last, gaveUp: true });
    deps.log(`turn rotation: ${conversationId} — giving up on fresh turns for turn ${turnId}; ChatGPT offered no Send for ${last.declines} automatic continues`);
    return false;
  }
  if (last?.turnId === turnId && last.filings >= MAX_FILED_PER_TURN) {
    attempts.set(conversationId, { ...last, gaveUp: true });
    deps.log(`turn rotation: ${conversationId} — giving up on fresh turns for turn ${turnId}; the page did not take ${last.filings} automatic continues`);
    return false;
  }
  inFlight.add(conversationId);
  try {
    const startedAt = await deps.turnStartedAt(sessionId, turnId);
    if (startedAt === null || now - startedAt < minutes * 60_000) return false;
    const row = await deps.file(sessionId, turnId);
    const filings = (last?.turnId === turnId ? last.filings : 0) + (row !== null ? 1 : 0);
    attempts.set(conversationId, { turnId, at: now, filed: row !== null, filings, declines: last?.turnId === turnId ? last.declines ?? 0 : 0 });
    if (attempts.size > 500) attempts.delete(attempts.keys().next().value!);
    if (row === null) return false;
    deps.log(`turn rotation: ${conversationId} has worked ${Math.round((now - startedAt) / 60_000)} minutes in turn ${turnId} — continuing in a fresh turn after this tool result`);
    return true;
  } finally {
    inFlight.delete(conversationId);
  }
}

/**
 * Whether this turn should now be stopped after its result rather than given another continue: the
 * opt-in fallback, once ChatGPT offered no Send twice in this turn, once per turn, and not before a
 * minute after the last decline (the same pace as a retried continue).
 */
export function stopFallbackDue(conversationId: string, turnId: string, enabled: boolean, now: number): boolean {
  const last = attempts.get(conversationId);
  return enabled && last?.turnId === turnId && !last.stopped && (last.declines ?? 0) >= STOP_FALLBACK_AFTER_DECLINES &&
    now - last.at >= REFUSED_RETRY_MS;
}

/** The fallback was used for this turn: no more continues into it. */
export function noteStopFallback(conversationId: string, turnId: string, now: number): void {
  const last = attempts.get(conversationId);
  attempts.set(conversationId, { turnId, at: now, filed: false, filings: last?.turnId === turnId ? last.filings : 0,
    declines: last?.turnId === turnId ? last.declines ?? 0 : 0, gaveUp: true, stopped: true });
}

/**
 * The page declined this turn's continue because ChatGPT offered no Send: it was never sent, so it
 * does not spend one of the turn's filings, and the next tool result a minute on may try again.
 */
export function noteRotationDeclined(conversationId: string, turnId: string): void {
  const last = attempts.get(conversationId);
  if (!last || last.turnId !== turnId || !last.filed) return;
  attempts.set(conversationId, { ...last, filed: false, filings: Math.max(0, last.filings - 1), declines: (last.declines ?? 0) + 1 });
}

/** Test seam: forgets every attempt. */
export function resetTurnRotationForTests(): void {
  attempts.clear();
  inFlight.clear();
}
