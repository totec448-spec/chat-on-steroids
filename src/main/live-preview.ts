/**
 * The newest sentence a running turn shows before ChatGPT publishes its message (#942).
 *
 * In a new chat's first turn ChatGPT keeps the model's in-between sentences out of its page model
 * until it fetches the chat's history again, so they cannot be recorded with their own ids while
 * the turn runs. The page reports the newest one as a caption instead. It lives here, in memory
 * only, and is never written to a chat's history: the sentence is recorded the ordinary way once
 * ChatGPT publishes it.
 */
const previews = new Map<string, { text: string; at: number }>();
/** A turn that stopped reporting without clearing its caption (a closed tab) loses it. */
const STALE_MS = 10 * 60_000;

export function setLivePreview(conversationId: string, text: string | null, now = Date.now()): void {
  if (text) previews.set(conversationId, { text, at: now });
  else previews.delete(conversationId);
}

/** The newest caption among a chat's conversations, or null. */
export function livePreview(conversationIds: readonly string[], now = Date.now()): string | null {
  let newest: { text: string; at: number } | null = null;
  for (const id of conversationIds) {
    const entry = previews.get(id);
    if (!entry) continue;
    if (now - entry.at > STALE_MS) { previews.delete(id); continue; }
    if (!newest || entry.at >= newest.at) newest = entry;
  }
  return newest?.text ?? null;
}
