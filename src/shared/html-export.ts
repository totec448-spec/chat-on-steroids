import { Marked, type Tokens } from 'marked';

/* A chat transcript as one HTML page that opens in any browser and needs nothing else: the styles
   are inline, and the page loads no script, font, image or other address. Its policy forbids them
   too, so even markup that got past the escaping below could not run or call home. */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char]!);
}

/**
 * What the main process's redaction leaves where it took a detail out ("[redacted]", "[redacted private
 * key]"). With `hidden` set, the page shows each as one small mark in the interface language.
 */
const REDACTED = /\[redacted(?: private key)?\]/g;
/** The same in an address: marked percent-encodes the brackets of a link target. */
const REDACTED_ADDRESS = /\[redacted|%5Bredacted/i;

/** Web and mail links only; a file, script or app address keeps its text and loses the link. */
function safeHref(href: string): string | null {
  // A hidden detail in an address would put it back in the page, under the link.
  if (REDACTED_ADDRESS.test(href)) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

function link(href: string, title: string | null | undefined, label: string): string {
  const target = safeHref(href);
  const titled = title && !REDACTED_ADDRESS.test(title) ? ` title="${escapeHtml(title)}"` : '';
  return target ? `<a href="${escapeHtml(target)}"${titled} rel="noreferrer">${label}</a>` : label;
}

// An answer is Markdown, drawn as the timeline draws it (single line breaks kept). Markup inside
// it is shown as written, never interpreted; a block of it keeps its paragraph and its lines. A
// picture becomes a link to it, named by its description or else its address, so nothing loads.
const answers = new Marked({
  gfm: true,
  breaks: true,
  walkTokens(token) {
    // A code block's language becomes a class name; a hidden mark has no place in an attribute.
    if (token.type === 'code' && (token as Tokens.Code).lang) (token as Tokens.Code).lang = (token as Tokens.Code).lang!.replace(REDACTED, '');
  },
  renderer: {
    html(token) {
      const block = 'block' in token && token.block;
      return block ? `<p>${escapeHtml(token.text.trim()).replace(/\n/g, '<br>\n')}</p>\n` : escapeHtml(token.text);
    },
    image({ href, title, text }) { return link(href, title, escapeHtml(text || href)); },
    link({ href, title, tokens }) { return link(href, title, this.parser.parseInline(tokens)); }
  }
});

function answerHtml(text: string): string {
  try {
    return answers.parse(text, { async: false });
  } catch {
    return `<p class="said">${escapeHtml(text)}</p>`;
  }
}

const POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const STYLE = `
:root { color-scheme: light dark; --ink: #1f1f1f; --muted: #6b6b6b; --page: #ffffff; --card: #f3f3f3; --edge: #e2e2e2; --link: #0b62c4; }
@media (prefers-color-scheme: dark) { :root { --ink: #ececec; --muted: #9a9a9a; --page: #0d0d0d; --card: #1a1a1a; --edge: #2c2c2c; --link: #7ab4ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 40px 16px 64px; }
h1 { font-size: 1.6rem; line-height: 1.3; margin: 0 0 32px; overflow-wrap: anywhere; }
h1:has(+ .date) { margin-bottom: 4px; }
.date { margin: 0 0 32px; color: var(--muted); font-size: 0.875rem; }
section { margin: 0 0 28px; }
section > h2 { margin: 0 0 6px; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.02em; color: var(--muted); }
.said { white-space: pre-wrap; overflow-wrap: anywhere; }
.user .said { margin: 0; padding: 10px 14px; border-radius: 12px; background: var(--card); }
.answer h1, .answer h2, .answer h3, .answer h4 { font-size: 1.05rem; margin: 1.2em 0 0.4em; }
a { color: var(--link); }
pre { padding: 12px 14px; border: 1px solid var(--edge); border-radius: 10px; background: var(--card); overflow-x: auto; }
code { font: 0.9em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:not(pre) > code { padding: 1px 5px; border-radius: 5px; background: var(--card); }
blockquote { margin: 0; padding-left: 14px; border-left: 3px solid var(--edge); color: var(--muted); }
table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; }
th, td { padding: 6px 10px; border: 1px solid var(--edge); text-align: left; vertical-align: top; }
hr { border: 0; border-top: 1px solid var(--edge); }
.hidden { padding: 0 2px; border-radius: 3px; background: var(--card); color: var(--muted); font-size: 0.85em; font-style: italic; white-space: nowrap; }
footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--edge); color: var(--muted); font-size: 0.8rem; }
`;

export type TranscriptHtmlOptions = {
  /** The interface language, as the page's `lang`. */
  lang?: string;
  /** The day the page was made, already written out in that language. */
  date?: string;
  /** A line at the end saying where the page came from. */
  footer?: string;
  /** The title of a chat that has none. */
  untitled?: string;
  /** The word for a hidden detail; set, every "[redacted]" in the page becomes a mark with it. */
  hidden?: string;
};

/** How many hidden details a page made with `hidden` shows. */
export function hiddenCount(html: string): number {
  return html.match(/<span class="hidden">/g)?.length ?? 0;
}

/** A whole chat as one HTML file: the title, then each message under who said it. */
export function transcriptHtml(title: string, entries: readonly { role: 'user' | 'assistant'; text: string }[],
  labels: { user: string; assistant: string } = { user: 'You', assistant: 'ChatGPT' }, options: TranscriptHtmlOptions = {}): string {
  const named = title.trim() || options.untitled || 'Chat';
  const mark = options.hidden === undefined ? null : `<span class="hidden">${escapeHtml(options.hidden)}</span>`;
  const marked = (html: string) => mark ? html.replace(REDACTED, mark) : html;
  // What a person wrote is plain text, as the timeline shows it; only answers are Markdown.
  const sections = entries.map(entry => ({ role: entry.role, text: entry.text.trim() })).filter(entry => entry.text).map(entry =>
    entry.role === 'user'
      ? `<section class="user"><h2>${escapeHtml(labels.user)}</h2><p class="said" dir="auto">${marked(escapeHtml(entry.text))}</p></section>`
      : `<section class="assistant"><h2>${escapeHtml(labels.assistant)}</h2><div class="answer" dir="auto">\n${marked(answerHtml(entry.text))}</div></section>`);
  const titleText = options.hidden === undefined ? named : named.replace(REDACTED, options.hidden);
  return `<!doctype html>
<html${options.lang ? ` lang="${escapeHtml(options.lang)}"` : ''}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(titleText)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${marked(escapeHtml(named))}</h1>${options.date ? `\n<p class="date">${escapeHtml(options.date)}</p>` : ''}
${sections.join('\n')}${options.footer ? `\n<footer>${escapeHtml(options.footer)}</footer>` : ''}
</main>
</body>
</html>
`;
}
