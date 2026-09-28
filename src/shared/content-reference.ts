/**
 * ChatGPT's own Markdown directives, which its page renders and plain Markdown does not.
 *
 * `::chatgpt-content-reference{index="0" source_message_id="…"}` points at another message's
 * content (#574); for some accounts every reply arrives that way. `:::writing{…}` is a card the
 * renderer draws itself. Any other directive is unknown to this app, and ChatGPT keeps adding them
 * per account, so instead of shipping one fix per new name: a leaf directive line or an unknown
 * container is replaced by the page's own recorded rendering, and dropped from text otherwise.
 */
const LEAF_DIRECTIVE = /^[ \t]*::[a-z][\w-]*(?:\{[^}\n]*\})?[ \t]*$/gim;
const CONTAINER_OPEN = /^[ \t]*:::(?!writing\b)[a-z][\w-]*(?:\{[^}\n]*\})?[ \t]*$/gim;
const CONTAINER_CLOSE = /^[ \t]*:::[ \t]*$/gm;
const ANY_DIRECTIVE_TEXT = /(^|\n)[ \t]*:{2,3}[a-z][\w-]*(?:\{[^}\n]*\})?[ \t]*(?=\n|$)/i;

/** True when the text carries a directive this app cannot render itself. */
export function hasProviderDirective(text: string): boolean {
  LEAF_DIRECTIVE.lastIndex = 0; CONTAINER_OPEN.lastIndex = 0;
  return LEAF_DIRECTIVE.test(text) || CONTAINER_OPEN.test(text);
}

/** The text without unknown directive lines; an unknown container keeps its inner text. */
export function withoutProviderDirectives(text: string): string {
  const hadContainer = (CONTAINER_OPEN.lastIndex = 0, CONTAINER_OPEN.test(text));
  let result = text.replace(LEAF_DIRECTIVE, '').replace(CONTAINER_OPEN, '');
  if (hadContainer) result = result.replace(CONTAINER_CLOSE, '');
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/** A recorded page rendering that shows content, not the same raw directives. */
export function resolvedCapture(capture?: { text: string; truncated?: boolean } | null): capture is { text: string; truncated?: boolean } {
  return !!capture?.text && !capture.truncated && !ANY_DIRECTIVE_TEXT.test(plainTextOfHtml(capture.text));
}

export function hasContentReference(text: string): boolean {
  return hasProviderDirective(text);
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

/** The reply as a model should read it: the page's resolved content when directives replaced it. */
export function modelFacingText(text: string, capture?: { text: string; truncated?: boolean } | null): string {
  if (!hasProviderDirective(text)) return text;
  if (resolvedCapture(capture)) {
    const resolved = plainTextOfHtml(capture.text);
    if (resolved) return resolved;
  }
  return withoutProviderDirectives(text) || '[This reply points to content from another message that was not recorded.]';
}
