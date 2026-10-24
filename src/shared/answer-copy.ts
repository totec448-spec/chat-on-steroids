import { Marked } from 'marked';
import { markdownVisibleText, tokensVisibleText } from './markdown-text.js';

/* Copy as: an answer's Markdown turned into what another app pastes best. Plain text reads as the
   timeline draws it (bullets, numbers and table columns kept, no Markdown markers); formatted
   text is HTML for Word, Outlook and mail, with the plain text beside it for apps without HTML. */

export type CopyFormat = 'markdown' | 'text' | 'text-no-code' | 'formatted';

// A ChatGPT writing block, read as the timeline reads it (chat.ts writingBlock): a block ChatGPT
// never closed runs to the end of the answer. The lexer finds it only where a block can start, so
// the same lines inside a code example stay as written.
const writing = new Marked({ extensions: [{
  name: 'writingBlock', level: 'block',
  start: value => value.match(/^:::writing\b/m)?.index,
  tokenizer(value) {
    const match = value.match(/^:::writing(\{[^}\n]*\})?[ \t]*\n([\s\S]*?)(?:\n:::[ \t]*(?:\n|$)|$)/);
    return match ? { type: 'writingBlock', raw: match[0], text: match[2] ?? '' } : undefined;
  },
  renderer: () => ''
}] });

/** A writing block shows its words as a panel; outside the timeline only the words remain. */
function unwrapWritingBlocks(markdown: string): string {
  if (!/^:::writing\b/m.test(markdown)) return markdown;
  try {
    return writing.lexer(markdown).map(token => token.type === 'writingBlock' ? `${token.text}\n${token.raw.endsWith('\n') ? '\n' : ''}` : token.raw).join('');
  } catch {
    return markdown;
  }
}

/** The answer as plain text; `codeBlocks: false` leaves fenced code out. */
export function answerPlainText(markdown: string, options: { codeBlocks?: boolean } = {}): string {
  return markdownVisibleText(unwrapWritingBlocks(markdown), { codeBlocks: options.codeBlocks, layout: true, tidy: true });
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => ESCAPES[char]!);

/** Web and mail links only; a file, script or app address keeps its words and loses the link. */
function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

// Drawn as the timeline draws it (single line breaks kept). Markup the answer contains is pasted
// as the words it is, never as markup, and an image keeps its description, not its address.
const formatted = new Marked({ gfm: true, breaks: true, renderer: {
  html({ text }) { return escapeHtml(text); },
  image({ text, tokens }) { return escapeHtml(tokens?.length ? tokensVisibleText(tokens, { layout: true }) : text); },
  // A box drawn as a character: Word would paste a form field for a disabled checkbox input.
  checkbox({ checked }) { return checked ? '☑ ' : '☐ '; },
  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    const target = safeHref(href);
    return target ? `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>` : label;
  }
} });

/** The answer as an HTML fragment for the clipboard. */
export function answerHtml(markdown: string): string {
  const source = unwrapWritingBlocks(markdown);
  try {
    return formatted.parse(source, { async: false }).trim();
  } catch {
    return `<p>${escapeHtml(source.trim()).replace(/\n/g, '<br>')}</p>`;
  }
}
