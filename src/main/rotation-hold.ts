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
const holds = new Map<string, { calls: number; work: Promise<void> | null }>();

/** Opens a hold for one call of this chat; the returned close waits for any work attached meanwhile. */
export function openCallHold(conversationId: string): () => Promise<void> {
  const hold = holds.get(conversationId) ?? { calls: 0, work: null };
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

/** Test seam. */
export function resetCallHoldsForTests(): void {
  holds.clear();
}
