/**
 * A turn the app is stopping so the work continues in a fresh one (`ui.rotateStopFallback`, the
 * opt-in fallback for chats where ChatGPT offers no Send for a fresh-turn continue at a tool result).
 *
 * From the decision until ChatGPT shows the turn stopped, a tool call of that chat is refused, not
 * run: a Stop that lands while a call runs can make the model run that call again (measured
 * 2026-10-18, #1662). A refused call never ran, so making it again in the fresh turn is safe.
 * The fence lifts when the stop shows, or after a minute when it never does.
 */
const FENCE_MS = 60_000;
const fences = new Map<string, { turnId: string; timer: ReturnType<typeof setTimeout> }>();

export const ROTATION_FENCE_REFUSAL =
  'TURN_CONTINUING: Chat On Steroids is continuing this task in a fresh turn, so this call was not run. ' +
  'Do not retry it in this turn: the next message continues the task, and you can make the call there.';

export function armRotationFence(conversationId: string, turnId: string): void {
  clearRotationFence(conversationId);
  const timer = setTimeout(() => { if (fences.get(conversationId)?.timer === timer) fences.delete(conversationId); }, FENCE_MS);
  timer.unref?.();
  fences.set(conversationId, { turnId, timer });
}

export function rotationFenced(conversationId: string | null | undefined): boolean {
  return !!conversationId && fences.has(conversationId);
}

/** The turn being stopped, for the end that lifts the fence. */
export function rotationFenceTurn(conversationId: string): string | null {
  return fences.get(conversationId)?.turnId ?? null;
}

export function clearRotationFence(conversationId: string): void {
  const fence = fences.get(conversationId);
  if (fence) clearTimeout(fence.timer);
  fences.delete(conversationId);
}

export function resetRotationFencesForTests(): void {
  for (const fence of fences.values()) clearTimeout(fence.timer);
  fences.clear();
}
