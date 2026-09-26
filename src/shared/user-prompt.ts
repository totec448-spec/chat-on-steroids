/** Transport framing, not a second prompt source. Length keeps marker-like user text literal. */
export const MAX_CHATGPT_MESSAGE_CHARS = 96_000;
const continuation = (text: string): string => /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(text)?.[0] ?? '';
/** Concealment only, never a receipt or a parsed frame. Kept in sync with the isolated DOM reader. */
export function userPromptFrameHint(value: string, rendered = false): boolean {
  // Only inspect the reserved header's bounded neighbourhood. This does not
  // decode a message or grant receipt authority; the exact frame parser stays exact.
  const normalized = value.replace(/\r\n?/g, '\n').trimStart().slice(0, 400)
    .replace(/\\\n/g, '\n').replace(/\\([!-/:-@[-`{-~])/g, '$1');
  const identity = rendered
    ? /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\](?:\\?\s)*/.exec(normalized)?.[0] ?? ''
    : continuation(normalized);
  const header = /^\[\[COS_CONTEXT:\d{1,6}\]\]/.exec(normalized.slice(identity.length));
  return Boolean(header && (rendered || /^(?:\n|$)/.test(normalized.slice(identity.length + header[0].length))));
}
export function userPromptText(text: string): string | null {
  text = text.replace(/\r\n?/g, '\n');
  const identity = continuation(text);
  const header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(text.slice(identity.length));
  if (!header) return null;
  const end = identity.length + header[0].length + Number(header[1]);
  const boundary = '\n[[/COS_CONTEXT]]\n\n';
  return text.startsWith(boundary, end) ? identity + text.slice(end + boundary.length) : null;
}

export function prependUserPrompt(text: string, instructions: string): string {
  text = text.replace(/\r\n?/g, '\n');
  instructions = instructions.replace(/\r\n?/g, '\n');
  const authored = userPromptText(text) ?? text;
  const identity = continuation(authored);
  return `${identity}[[COS_CONTEXT:${instructions.length}]]\n${instructions}\n[[/COS_CONTEXT]]\n\n${authored.slice(identity.length)}`;
}
