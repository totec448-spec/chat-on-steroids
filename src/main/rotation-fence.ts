import { readDurable, writeDurableNow } from './durable.js';
import { logWarn } from './logger.js';

/**
 * A turn the app is stopping so the work continues in a fresh one (`ui.rotateStopFallback`, the
 * opt-in fallback for chats where ChatGPT offers no Send for a fresh-turn continue at a tool result).
 *
 * From the decision until ChatGPT shows the turn stopped, a tool call of that chat is refused, not
 * run: a Stop that lands while a call runs can make the model run that call again (measured
 * 2026-10-18, #1662). A refused call never ran, so making it again in the fresh turn is safe.
 * The fence lifts when the stop shows, when its Stop command ends without showing it, or when that
 * command's own 120 s budget has run out (plus a margin): a fence shorter than the Stop it protects
 * let a call run while the Stop could still land (CodeRabbit on #1954).
 */
export const FENCE_MS = 120_000 + 15_000;
const fences = new Map<string, { turnId: string; until: number; timer: ReturnType<typeof setTimeout> }>();

/**
 * Fences are kept on disk too: an app that restarts after ChatGPT accepted the Stop but before its
 * stopped end arrived would otherwise forget both the fence and the continue that end files
 * (CodeRabbit on #1954). `restoreRotationFences` brings back what is left of each.
 */
const FENCES_STATE = 'rotation-fences';
function persist(): Promise<boolean> {
  const rows = [...fences].map(([conversationId, fence]) => ({ conversationId, turnId: fence.turnId, until: fence.until }));
  return writeDurableNow(FENCES_STATE, rows).then(() => true, error => {
    logWarn(`turn rotation: could not save the fresh-turn fences — ${String(error)}`);
    return false;
  });
}

export const ROTATION_FENCE_REFUSAL =
  'TURN_CONTINUING: Chat On Steroids is continuing this task in a fresh turn, so this call was not run. ' +
  'Do not retry it in this turn: the next message continues the task, and you can make the call there.';

/** Resolves once the fence is on disk (false when it could not be saved): the Stop waits for it. */
export function armRotationFence(conversationId: string, turnId: string, ms = FENCE_MS): Promise<boolean> {
  const previous = fences.get(conversationId);
  if (previous) clearTimeout(previous.timer);
  const wait = Math.min(FENCE_MS, Math.max(0, ms));
  const timer = setTimeout(() => { if (fences.get(conversationId)?.timer === timer) { fences.delete(conversationId); void persist(); } }, wait);
  timer.unref?.();
  fences.set(conversationId, { turnId, until: Date.now() + wait, timer });
  return persist();
}

/** Brings back the fences of the previous run, each for what is left of it (never longer than `FENCE_MS`). */
export async function restoreRotationFences(now = Date.now()): Promise<number> {
  const rows = await readDurable<unknown>(FENCES_STATE).catch(() => null);
  let restored = 0;
  if (Array.isArray(rows)) for (const row of rows.slice(0, 500)) {
    const { conversationId, turnId, until } = (row ?? {}) as { conversationId?: unknown; turnId?: unknown; until?: unknown };
    if (typeof conversationId !== 'string' || typeof turnId !== 'string' || typeof until !== 'number' || !Number.isFinite(until)) continue;
    if (conversationId.length > 200 || turnId.length > 200 || until <= now || fences.has(conversationId)) continue;
    void armRotationFence(conversationId, turnId, until - now);
    restored++;
  }
  if (!restored) void persist();
  return restored;
}

export function rotationFenced(conversationId: string | null | undefined): boolean {
  return !!conversationId && fences.has(conversationId);
}

/** The turn being stopped, for the end that lifts the fence. */
export function rotationFenceTurn(conversationId: string): string | null {
  return fences.get(conversationId)?.turnId ?? null;
}

/** Resolves once the cleared state is on disk (false when it could not be saved; true when there was none). */
export function clearRotationFence(conversationId: string): Promise<boolean> {
  const fence = fences.get(conversationId);
  if (!fence) return Promise.resolve(true);
  clearTimeout(fence.timer);
  fences.delete(conversationId);
  return persist();
}

export function resetRotationFencesForTests(): void {
  for (const fence of fences.values()) clearTimeout(fence.timer);
  fences.clear();
}
