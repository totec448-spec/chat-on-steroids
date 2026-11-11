import { chronological, positionOf } from './chronology.js';
import { continuationMarkerOf, type SessionEvent, type StoredText } from './session.js';

/* Copy and Markdown export of what was said in a chat. Selection is pure so the renderer (which
   decides where the actions appear) and main (which reads full texts and writes files) agree on
   exactly which messages a turn's answer or a session transcript contains. */

/** `html`: an answer's recorded drawing, which can hold what its Markdown left out (#1477). */
export type TranscriptEntry = { role: 'user' | 'assistant'; stored: StoredText; turnId: string | null; messageId: string | null; seq: number; html?: StoredText };

type Said = Extract<SessionEvent, { kind: 'user_message' | 'assistant_message' }>;

/** The text a person wrote, without transport-only control instructions when they were recorded. */
function spoken(event: Said): StoredText {
  if (event.kind === 'user_message' && typeof event.authoredText === 'string' && event.authoredText.trim()) {
    return { text: event.authoredText, truncated: false, chars: event.authoredText.length };
  }
  return event.message;
}

/**
 * Your messages and ChatGPT's final answers, in conversation order: the latest revision of each
 * message, without partial answers and without the prompts Compact & Resume types itself.
 */
export function transcriptEntries(events: readonly SessionEvent[]): TranscriptEntry[] {
  // A revision replaces a message's text but not its place: messages come in the order the chat
  // shows them (the shared reading order), the text from each one's latest revision. A later work
  // stamp on a revision, such as a delivery confirmed after the answer, does not move it.
  // Revisions are collapsed first, to the latest one at the message's first position, so an older
  // final snapshot of an answer (legacy journals kept several) cannot lift it above a later message.
  const revisions = new Map<string, Said[]>();
  let anonymous = 0;
  for (const event of events) {
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message') continue;
    if (event.kind === 'assistant_message' && !event.final) continue;
    const id = event.messageId ? `${event.kind}\u0000${event.messageId}` : `anonymous\u0000${anonymous++}`;
    revisions.set(id, [...(revisions.get(id) ?? []), event]);
  }
  const collapsed = [...revisions.values()].map(list => {
    const latest = list.reduce((newest, event) => event.seq > newest.seq ? event : newest);
    return { latest, placed: { ...latest, origin: Math.min(...list.map(positionOf)) } as Said };
  });
  const place = new Map<SessionEvent, number>();
  const others = events.filter(event => event.kind !== 'user_message' && event.kind !== 'assistant_message');
  chronological([...others, ...collapsed.map(entry => entry.placed)]).forEach((event, index) => place.set(event, index));
  const messages = collapsed.map(({ latest, placed }) => ({ latest, place: place.get(placed)! }));
  return messages
    .filter(({ latest }) => !continuationMarkerOf(latest.message.text) && spoken(latest).text.trim())
    .sort((a, b) => a.place - b.place || a.latest.seq - b.latest.seq)
    .map(({ latest }) => ({ role: latest.kind === 'user_message' ? 'user' as const : 'assistant' as const,
      stored: spoken(latest), turnId: latest.turnId ?? null, messageId: latest.messageId ?? null, seq: latest.seq,
      ...(latest.kind === 'assistant_message' && latest.renderedHtml ? { html: latest.renderedHtml } : {}) }));
}

/** Turns whose latest boundary is completed; a new start revokes that completion. */
export function completedTurnIds(events: readonly SessionEvent[]): Set<string> {
  const boundaries = new Map<string, Extract<SessionEvent, { kind: 'turn_start' | 'turn_end' }>>();
  for (const event of events) {
    if ((event.kind !== 'turn_start' && event.kind !== 'turn_end') || !event.turnId) continue;
    const previous = boundaries.get(event.turnId);
    // Display chronology can place a repeated start beside the original start. The immutable
    // sequence, not its position on screen, tells whether this turn has reopened since its end.
    if (!previous || event.seq > previous.seq) boundaries.set(event.turnId, event);
  }
  return new Set([...boundaries].filter(([, event]) => event.kind === 'turn_end' && event.outcome === 'completed').map(([turnId]) => turnId));
}

/** The answer of a completed turn: its final assistant messages, in order. */
export function turnAnswerEntries(events: readonly SessionEvent[], turnId: string): TranscriptEntry[] {
  return transcriptEntries(events).filter(entry => entry.role === 'assistant' && entry.turnId === turnId);
}

/** For each completed turn, the sequence number of the answer message that carries the actions. */
export function answerAnchors(events: readonly SessionEvent[]): Map<string, number> {
  const done = completedTurnIds(events);
  const anchors = new Map<string, number>();
  for (const entry of transcriptEntries(events)) {
    if (entry.role === 'assistant' && entry.turnId && done.has(entry.turnId)) anchors.set(entry.turnId, entry.seq);
  }
  return anchors;
}

/**
 * Final answers recorded outside any turn, by message id, with the sequence number that carries
 * their actions: the history ChatGPT copied into a branch, an adopted chat's earlier answers and
 * replies to messages typed in the ChatGPT tab. A turn's answers keep their turn's actions instead.
 */
export function messageAnswerAnchors(events: readonly SessionEvent[]): Map<string, number> {
  const anchors = new Map<string, number>();
  for (const entry of transcriptEntries(events)) {
    if (entry.role === 'assistant' && !entry.turnId && entry.messageId) anchors.set(entry.messageId, entry.seq);
  }
  return anchors;
}

/** The chat's newest answer that offers copy (`/copy`): a completed turn's, or one recorded outside any turn. */
export function latestAnswer(events: readonly SessionEvent[]): { turnId?: string; messageId?: string } | null {
  const done = completedTurnIds(events);
  const last = transcriptEntries(events)
    .filter(entry => entry.role === 'assistant' && (entry.turnId ? done.has(entry.turnId) : !!entry.messageId)).at(-1);
  return !last ? null : last.turnId ? { turnId: last.turnId } : { messageId: last.messageId! };
}

/** The answer a turnless message holds, at its latest revision; none for a turn's own answer. */
export function messageAnswerEntries(events: readonly SessionEvent[], messageId: string): TranscriptEntry[] {
  return transcriptEntries(events).filter(entry => entry.role === 'assistant' && !entry.turnId && entry.messageId === messageId);
}

/** Remove surrounding blank lines without deleting meaningful first-line code indentation. */
export function trimMarkdown(text: string): string {
  return text.trimEnd().replace(/^(?:[ \t]*\r?\n)+/, '');
}

/** One answer as Markdown, keeping a following message's indented code outside the previous block. */
export function answerMarkdown(texts: readonly string[]): string {
  return `${texts.map(trimMarkdown).filter(Boolean).reduce((answer, text, index) => {
    // Blank lines alone let a list/paragraph consume the next message's indented code.
    const separator = /^(?: {4}| {0,3}\t)/.test(text) ? '\n\n<!-- -->\n\n' : '\n\n';
    return answer + (index ? separator : '') + text;
  }, '')}\n`;
}

/** A readable transcript: the chat title, then each message under who said it. */
export function sessionMarkdown(title: string, entries: readonly { role: 'user' | 'assistant'; text: string }[],
  labels: { user: string; assistant: string } = { user: 'You', assistant: 'ChatGPT' }): string {
  const parts = [`# ${title.trim() || 'Chat'}`];
  for (const entry of entries) {
    const text = entry.role === 'assistant' ? trimMarkdown(entry.text) : entry.text.trim();
    if (text) parts.push(`## ${entry.role === 'user' ? labels.user : labels.assistant}\n\n${text}`);
  }
  return `${parts.join('\n\n')}\n`;
}

/** A file name from a chat title that every desktop file system accepts. */
export function markdownFileName(title: string, suffix = '', extension = 'md'): string {
  // The 80-unit limit must not leave half a surrogate pair in the saved filename.
  const base = title.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '').slice(0, 80).replace(/[\uD800-\uDBFF]$/, '').trim() || 'chat';
  return `${base}${suffix}.${extension}`;
}
