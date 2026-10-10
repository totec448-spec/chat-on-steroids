import { continuationMarkerOf, workSequence, type SessionEvent, type StoredText } from './session.js';

/* Copy and Markdown export of what was said in a chat. Selection is pure so the renderer (which
   decides where the actions appear) and main (which reads full texts and writes files) agree on
   exactly which messages a turn's answer or a session transcript contains. */

export type TranscriptEntry = { role: 'user' | 'assistant'; stored: StoredText; turnId: string | null; seq: number };

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
  // A revision replaces a message's text but not its place: order by where the message first
  // appeared (the store's origin when it kept one), read the text from its latest revision.
  const messages = new Map<string, { latest: Said; place: number }>();
  let anonymous = 0;
  for (const event of events) {
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message') continue;
    if (event.kind === 'assistant_message' && !event.final) continue;
    const id = event.messageId ? `${event.kind}\u0000${event.messageId}` : `anonymous\u0000${anonymous++}`;
    const previous = messages.get(id);
    const place = Math.min(previous?.place ?? Number.POSITIVE_INFINITY, workSequence(event));
    messages.set(id, { latest: !previous || event.seq > previous.latest.seq ? event : previous.latest, place });
  }
  return [...messages.values()]
    .filter(({ latest }) => !continuationMarkerOf(latest.message.text) && spoken(latest).text.trim())
    .sort((a, b) => a.place - b.place || a.latest.seq - b.latest.seq)
    .map(({ latest }) => ({ role: latest.kind === 'user_message' ? 'user' as const : 'assistant' as const,
      stored: spoken(latest), turnId: latest.turnId ?? null, seq: latest.seq }));
}

/** Turns the page reported as completed; only these offer copy and export. */
export function completedTurnIds(events: readonly SessionEvent[]): Set<string> {
  const done = new Set<string>();
  for (const event of events) {
    if (event.kind === 'turn_end' && event.turnId) {
      if (event.outcome === 'completed') done.add(event.turnId); else done.delete(event.turnId);
    }
  }
  return done;
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

/** One answer as Markdown: its messages as written, separated by blank lines. */
export function answerMarkdown(texts: readonly string[]): string {
  return `${texts.map(text => text.trim()).filter(Boolean).join('\n\n')}\n`;
}

/** A readable transcript: the chat title, then each message under who said it. */
export function sessionMarkdown(title: string, entries: readonly { role: 'user' | 'assistant'; text: string }[],
  labels: { user: string; assistant: string } = { user: 'You', assistant: 'ChatGPT' }): string {
  const parts = [`# ${title.trim() || 'Chat'}`];
  for (const entry of entries) {
    const text = entry.text.trim();
    if (text) parts.push(`## ${entry.role === 'user' ? labels.user : labels.assistant}\n\n${text}`);
  }
  return `${parts.join('\n\n')}\n`;
}

/** A file name from a chat title that every desktop file system accepts. */
export function markdownFileName(title: string, suffix = ''): string {
  // The 80-unit limit must not leave half a surrogate pair in the saved filename.
  const base = title.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '').slice(0, 80).replace(/[\uD800-\uDBFF]$/, '').trim() || 'chat';
  return `${base}${suffix}.md`;
}
