import { settledPositionOf } from '../../shared/chronology.js';
import type { SessionEvent } from '../../shared/session.js';
import { getSession, readEvents, upsertMessageEvent } from './store.js';

/**
 * Edit & resubmit (#365): the question an edited one replaced.
 *
 * ChatGPT keeps an edited question as a new version beside the old one, under the same parent in its
 * message tree, and draws its versions control on that turn. Given that proof, the replaced question
 * is the newest version recorded before it under the same parent in the session's current chat (a
 * chat left through Compact & Resume has its own tree). The newest by first sight: an edit of an edit
 * replaces the later version, and a re-observed old version does not become newer than the edit.
 */
export async function replacedQuestion(sessionId: string, messageId: string, parentId: string): Promise<{ replaces?: string }> {
  const summary = await getSession(sessionId);
  const since = Math.max(0, ...Object.values(summary?.retiredChatAt ?? {}));
  const events = await readEvents(sessionId, { kinds: ['user_message', 'assistant_message'] });
  if (events.some(event => event.kind === 'user_message' && event.messageId === messageId && event.replaces)) return {};
  let parentSettledAt = 0;
  const firstSeen = new Map<string, { at: number; parentId?: string; time: number }>();
  for (const event of events) {
    if (event.kind === 'assistant_message') {
      if ((event.messageId === parentId || event.providerMessageId === parentId) &&
          (event.final === true || event.state === 'final')) {
        parentSettledAt = Math.max(parentSettledAt, settledPositionOf(event) ?? 0);
      }
      continue;
    }
    if (event.kind !== 'user_message' || !event.messageId) continue;
    const known = firstSeen.get(event.messageId);
    const at = event.origin ?? event.seq;
    firstSeen.set(event.messageId, { at: Math.min(known?.at ?? at, at), parentId: known?.parentId ?? event.parentId, time: Math.min(known?.time ?? event.time, event.time) });
  }
  // A message already recorded can only have replaced a question seen before it.
  // An assistant parent that finished after a steered question answered that question;
  // the next turn's question under that consolidated parent follows it rather than replacing it.
  const own = firstSeen.get(messageId);
  let replaced: { id: string; at: number } | null = null;
  for (const [id, seen] of firstSeen) {
    if (id === messageId || seen.parentId !== parentId || seen.time < since || (own && seen.at >= own.at)) continue;
    if (parentSettledAt > seen.at && (!own || parentSettledAt < own.at)) continue;
    if (!replaced || seen.at > replaced.at) replaced = { id, at: seen.at };
  }
  return replaced ? { replaces: replaced.id } : {};
}

/** Edits the app delivered, by the new question's id: known at the page's acknowledgement. */
const delivered = new Map<string, string>();

/** The question an app-delivered edit replaced, while this run remembers it. */
export function editReplacement(messageId: string): string | undefined {
  return delivered.get(messageId);
}

/**
 * The page acknowledged an edit the app delivered as question `messageId`: it replaces `replaced`.
 * Marked on the recorded question now, or when the page reports it, before ChatGPT draws its
 * versions control (and in a layout that never shows one).
 */
export async function noteEditReplacement(sessionId: string, messageId: string, replaced: string): Promise<void> {
  await noteEditReplacements(sessionId, [{ messageId, replaced }]);
}

/** Restore a session's receipts from one history read; pending native echoes retain their cache entry. */
export async function noteEditReplacements(
  sessionId: string,
  replacements: ReadonlyArray<{ messageId: string; replaced: string }>,
  onError?: (messageId: string, error: unknown) => void
): Promise<void> {
  const pending: Array<{ messageId: string; replaced: string }> = [];
  const wanted = new Set<string>();
  for (const replacement of replacements) {
    const { messageId, replaced } = replacement;
    if (messageId === replaced) continue;
    delivered.set(messageId, replaced);
    if (delivered.size > 256) delivered.delete(delivered.keys().next().value!);
    pending.push(replacement);
    wanted.add(messageId);
  }
  if (!pending.length) return;
  const recorded = new Map<string, Extract<SessionEvent, { kind: 'user_message' }>>();
  for (const event of await readEvents(sessionId, { kinds: ['user_message'] })) {
    if (event.kind === 'user_message' && event.messageId && wanted.has(event.messageId)) recorded.set(event.messageId, event);
  }
  for (const { messageId, replaced } of pending) {
    const previous = recorded.get(messageId);
    if (!previous || (previous.replacesConfirmed === true && previous.replaces === replaced)) continue;
    try {
      const { seq: _seq, ...event } = previous;
      const written = await upsertMessageEvent(sessionId, { ...event, replaces: replaced, replacesConfirmed: true }, { replacementOnly: true });
      if (written.event.kind === 'user_message') recorded.set(messageId, written.event);
    } catch (error) {
      if (!onError) throw error;
      onError(messageId, error);
    }
  }
}

export function resetEditsForTests(): void {
  delivered.clear();
}
