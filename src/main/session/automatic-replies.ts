/**
 * Goal and Loop follow-ups, by the text their page will type (#1655).
 *
 * The page types a follow-up itself, so it reaches ChatGPT with no outbox row and comes back as an
 * ordinary sent message; prompt recall then brought it back as if the person had typed it. The app
 * notes each follow-up it hands out, and the recorder marks the one message that returns with that
 * text in that chat as `automatic`. ChatGPT stores text a page inserted with its Markdown escaped,
 * so both sides are compared without escapes and with whitespace folded.
 */
const KEEP_MS = 60 * 60_000;
const PER_CHAT = 4;
const handed = new Map<string, Array<{ text: string; at: number }>>();

function comparable(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1').replace(/\s+/g, ' ').trim();
}

/** A Goal or Loop follow-up for this chat is ready for its page to type. */
export function noteAutomaticReply(conversationId: string, text: string, now = Date.now()): void {
  const value = comparable(text);
  if (!value) return;
  const kept = (handed.get(conversationId) ?? []).filter(entry => now - entry.at < KEEP_MS && entry.text !== value);
  kept.push({ text: value, at: now });
  handed.delete(conversationId);
  handed.set(conversationId, kept.slice(-PER_CHAT));
  if (handed.size > 200) handed.delete(handed.keys().next().value!);
}

/** Whether this sent message is a noted follow-up; a match is used up, so the same text later is the person's. */
export function takeAutomaticReply(conversationId: string, text: string, now = Date.now()): boolean {
  const kept = handed.get(conversationId);
  if (!kept) return false;
  const value = comparable(text);
  const at = kept.findIndex(entry => entry.text === value && now - entry.at < KEEP_MS);
  if (at < 0) return false;
  kept.splice(at, 1);
  if (!kept.length) handed.delete(conversationId);
  return true;
}

export function resetAutomaticRepliesForTests(): void {
  handed.clear();
}
