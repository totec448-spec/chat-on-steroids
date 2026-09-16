/** Bounded native emoji metadata, never HTML or a message-routing hint. */
const emojiSegments = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function messageReaction(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 &&
    /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[\u200d\ufe0f\u20e3\u{e0020}-\u{e007f}0-9#*])+$/u.test(value) &&
    /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value) &&
    [...emojiSegments.segment(value)].length === 1 ? value : undefined;
}

const PREFIX = '\uE200message_reaction\uE202';

/** Presentation only. Preserve canonical bytes and literal examples in prose/code. */
export function withoutMessageReaction(source: string): string {
  const start = source.trimStart();
  // A streaming prefix must never flash its private-use delimiters in the answer.
  if (start && PREFIX.startsWith(start)) return '';
  if (!start.startsWith(PREFIX)) return source;
  const end = start.indexOf('\uE201', PREFIX.length);
  if (end < 0) return start.length <= PREFIX.length + 32 ? '' : source;
  if (!messageReaction(start.slice(PREFIX.length, end))) return source;
  return start.slice(end + 1).replace(/^[\t ]*(?:\r?\n)?/, '');
}
