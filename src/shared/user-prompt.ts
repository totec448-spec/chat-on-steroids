/** Transport framing, not a second prompt source. Length keeps marker-like user text literal. */
export const MAX_CHATGPT_MESSAGE_CHARS = 96_000;
const continuation = (text: string): string => /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(text)?.[0] ?? '';
/**
 * The same bytes as the composer hands them back.
 *
 * ChatGPT's editor treats what it is given as Markdown source and escapes it on readback: a
 * backslash before ASCII punctuation, and a backslash before a newline for a hard line break.
 * The frame is punctuation and newlines almost entirely, so an escaped readback matches none of
 * it — and the declared instruction length stops matching too, because escaping adds characters.
 *
 * Measured from a page readback in issue #374: `[[COS_CONTEXT:45]]` came back as
 * `\[\[COS\_CONTEXT\:45\]\]\` and the closing boundary as `\[\[/COS\_CONTEXT\]\]\`.
 * Read exactly, the whole frame then belongs to the message: the app shows the internal
 * instructions as if the user had typed them, the page keeps them visible and titles the
 * conversation with them, and the recorder files the framed text as a second user message
 * beside the authored one.
 *
 * Same rule as `unescapeMarkdown()` in shared/session.ts, which readers of the continuation
 * marker already follow: try the exact text first, and only then this.
 */
function asTyped(text: string): string {
  return text.replace(/\\\n/g, '\n').replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

function readFrame(text: string): string | null {
  const identity = continuation(text);
  const header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(text.slice(identity.length));
  if (!header) return null;
  const end = identity.length + header[0].length + Number(header[1]);
  const boundary = '\n[[/COS_CONTEXT]]\n\n';
  return text.startsWith(boundary, end) ? identity + text.slice(end + boundary.length) : null;
}

export function userPromptText(text: string): string | null {
  text = text.replace(/\r\n?/g, '\n');
  // Exact first: authored text that happens to contain a backslash keeps it, and only a frame
  // that cannot be read as sent is read as one the page escaped.
  const exact = readFrame(text);
  if (exact !== null) return exact;
  const typed = asTyped(text);
  return typed === text ? null : readFrame(typed);
}

export function prependUserPrompt(text: string, instructions: string): string {
  text = text.replace(/\r\n?/g, '\n');
  instructions = instructions.replace(/\r\n?/g, '\n');
  const authored = userPromptText(text) ?? text;
  const identity = continuation(authored);
  return `${identity}[[COS_CONTEXT:${instructions.length}]]\n${instructions}\n[[/COS_CONTEXT]]\n\n${authored.slice(identity.length)}`;
}
