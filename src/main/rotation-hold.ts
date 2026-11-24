/**
 * Holds a tool call's answer while its chat continues in a fresh turn (#1402, #1662).
 *
 * A fresh-turn continue is sent into the running turn. Measured on 2026-10-18: sent while one of
 * the chat's tool calls was still running, ChatGPT ended the turn and carried on in a fresh one
 * that used the call's result, every time (6 of 6). Sent in the gap after a call's result it was
 * sometimes queued behind the answer instead and left unanswered, and a Stop while a call ran
 * made the model run the call again. So the call whose result is due for a rotation keeps its
 * answer back until the continue is in: from ChatGPT's side that call is still running.
 *
 * The MCP kernel opens a hold around recording a call it can attribute; the rotation decision,
 * made while that call is recorded, attaches its delivery wait to the hold. Closing the hold
 * waits for that work, which is bounded by its owner.
 */
type Hold = { calls: number; work: Promise<void> | null; after: Array<() => void> };
import { logInfo } from './logger.js';
const holds = new Map<string, Hold>();
/** The longest work registered for after the answers waits, so overlapping calls cannot hold it back for ever. */
export const AFTER_ANSWERS_MAX_MS = 10_000;

/** Opens a hold for one call of this chat; the returned close waits for any work attached meanwhile. */
export function openCallHold(conversationId: string): () => Promise<void> {
  const hold = holds.get(conversationId) ?? { calls: 0, work: null, after: [] };
  hold.calls += 1;
  holds.set(conversationId, hold);
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    try {
      if (hold.work) await hold.work;
    } finally {
      hold.calls -= 1;
      if (hold.calls <= 0 && holds.get(conversationId) === hold) holds.delete(conversationId);
      if (hold.calls <= 0) for (const run of hold.after.splice(0)) run();
    }
  };
}

/** Whether a call of this chat is still being answered, so a continue can go in while it runs. */
export function callHoldOpen(conversationId: string): boolean {
  return (holds.get(conversationId)?.calls ?? 0) > 0;
}

/** Makes every open call of this chat wait for `work` before it answers. Errors are the owner's. */
export function holdCalls(conversationId: string, work: Promise<unknown>): boolean {
  const hold = holds.get(conversationId);
  if (!hold || hold.calls <= 0) return false;
  const settled = work.then(() => undefined, () => undefined);
  hold.work = hold.work ? Promise.all([hold.work, settled]).then(() => undefined) : settled;
  return true;
}

/**
 * Runs `work` once no call of this chat is being answered any more (#2238), and at the latest after
 * AFTER_ANSWERS_MAX_MS. False when no call is open: nothing to wait for, so the caller runs it itself.
 * A Stop sent while a call still runs makes the model run that call again, so a Stop that follows a
 * result starts only after the answers have gone out.
 */
export function afterCallsAnswered(conversationId: string, work: () => void): boolean {
  const hold = holds.get(conversationId);
  if (!hold || hold.calls <= 0) return false;
  let done = false;
  const once = () => { if (done) return; done = true; clearTimeout(timer); work(); };
  const timer = setTimeout(() => {
    const at = hold.after.indexOf(once);
    if (at !== -1) hold.after.splice(at, 1);
    // Said so that a Stop which follows a call that was never answered can be explained from the log.
    logInfo(`rotation hold: ${conversationId} — a call answer is still held after ${AFTER_ANSWERS_MAX_MS / 1000} s; going ahead without waiting for it`);
    once();
  }, AFTER_ANSWERS_MAX_MS);
  timer.unref?.();
  hold.after.push(once);
  logInfo(`rotation hold: ${conversationId} — work waits for ${hold.calls} call answer(s) to go out`);
  return true;
}
/** Test seam. */
export function resetCallHoldsForTests(): void {
  holds.clear();
}
