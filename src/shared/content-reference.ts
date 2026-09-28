/**
 * ChatGPT can answer with `::chatgpt-content-reference{index="0" source_message_id="…"}` on a line
 * of its own: a pointer to another message's content that its page shows in place (#574). For some
 * accounts every reply arrives this way, so anything that reads the reply as text (Goal's context,
 * a worker's final report) would see only the pointer. The recorded capture of the message is the
 * page's own rendering and holds the resolved content.
 */
const POINTER_LINE = /^[ \t]*::chatgpt-content-reference\{[^}\n]*\}[ \t]*$/gm;

export function hasContentReference(text: string): boolean {
  POINTER_LINE.lastIndex = 0;
  return POINTER_LINE.test(text);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Plain text of captured message HTML: block ends become line breaks, tags go, entities decode. */
export function plainTextOfHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|pre|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (entity, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith('#') && name !== '#39') return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The reply as a model should read it: the resolved content when the raw text is only pointers. */
export function modelFacingText(text: string, capture?: { text: string; truncated?: boolean } | null): string {
  if (!hasContentReference(text)) return text;
  const rest = text.replace(POINTER_LINE, '').trim();
  if (capture?.text && !capture.truncated && !capture.text.includes('::chatgpt-content-reference')) {
    const resolved = plainTextOfHtml(capture.text);
    if (resolved) return resolved;
  }
  return rest || '[This reply points to content from another message that was not recorded.]';
}
