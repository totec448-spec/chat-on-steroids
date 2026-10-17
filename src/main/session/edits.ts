import { getSession, readEvents } from './store.js';

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
  const questions = await readEvents(sessionId, { kinds: ['user_message'] });
  if (questions.some(event => event.kind === 'user_message' && event.messageId === messageId && event.replaces)) return {};
  const firstSeen = new Map<string, { at: number; parentId?: string; time: number }>();
  for (const event of questions) {
    if (event.kind !== 'user_message' || !event.messageId || event.messageId === messageId) continue;
    const known = firstSeen.get(event.messageId);
    const at = event.origin ?? event.seq;
    firstSeen.set(event.messageId, { at: Math.min(known?.at ?? at, at), parentId: known?.parentId ?? event.parentId, time: Math.min(known?.time ?? event.time, event.time) });
  }
  let replaced: { id: string; at: number } | null = null;
  for (const [id, seen] of firstSeen) {
    if (seen.parentId !== parentId || seen.time < since) continue;
    if (!replaced || seen.at > replaced.at) replaced = { id, at: seen.at };
  }
  return replaced ? { replaces: replaced.id } : {};
}
