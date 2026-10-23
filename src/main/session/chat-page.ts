import { Marked, type Tokens } from 'marked';
import { maskSecrets } from '../secrets-shield.js';

/**
 * A chat as one web page to share: a single HTML file that needs nothing else, opens in any browser
 * and runs nothing. Its own policy forbids scripts, frames, forms and every remote load, so a page
 * saved from any chat is safe to open even if an answer held markup. Pictures become links for the
 * same reason (a remote picture would tell its host who opened the page).
 *
 * Hiding details is optional: keys and passwords, email addresses and the user name in home-folder
 * paths. Each hidden detail shows as one "hidden" mark, and the count tells the person how many.
 */

export type ChatPageLabels = { you: string; assistant: string; hidden: string; footer: string };
export type ChatPageMessage = { role: 'user' | 'assistant'; text: string };
export type ChatPageRequest = {
  title: string; messages: readonly ChatPageMessage[]; hide: boolean; lang: string; labels: ChatPageLabels; now: Date;
};

/** Where a hidden detail was. A private-use character: it cannot come from the chat (it is dropped first). */
const HIDDEN = '\uE000';
const HIDDEN_ALL = /\uE000/g;
const SHIELD_MARKER = /\[[A-Za-z ]{1,40} hidden by Chat On Steroids\]/g;
const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
/** `/Users/<name>` (macOS) and `/home/<name>` (Linux). */
const UNIX_HOME = /(?<![\w.])(\/(?:Users|home)\/)([^/\s"'`<>()[\]]+)/g;
/** `C:\Users\<name>`; a Windows user name may hold spaces, so a spaced one must end at a separator. */
const WINDOWS_HOME = /(?<![\w])([A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)([^\\/\r\n"*:<>?|`]+?(?=[\\/])|[^\\/\s"*:<>?|`()[\]]+)/gi;
/** Folders every system has; they name no person. */
const SHARED_HOMES = /^(?:shared|public|default|default user|all users)$/i;

/** The text with the chosen details replaced by the hidden mark, and how many it holds. */
export function hideForSharing(text: string): { text: string; hidden: number } {
  let out = maskSecrets(text.replace(HIDDEN_ALL, '')).text.replace(SHIELD_MARKER, HIDDEN);
  out = out.replace(EMAIL, HIDDEN);
  const home = (whole: string, prefix: string, name: string): string => SHARED_HOMES.test(name) ? whole : prefix + HIDDEN;
  out = out.replace(UNIX_HOME, home).replace(WINDOWS_HOME, home);
  return { text: out, hidden: out.match(HIDDEN_ALL)?.length ?? 0 };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** Only web and mail links stay links: a relative or `file:` link leads nowhere for whoever opens the page. */
function safeHref(href: string): string | null {
  if (href.includes(HIDDEN)) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
  } catch { return null; }
}

function link(href: string, title: string | null | undefined, inner: string): string {
  const safe = safeHref(href);
  if (!safe) return inner;
  const titled = title && !title.includes(HIDDEN) ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow"${titled}>${inner}</a>`;
}

const markdown = new Marked({
  gfm: true,
  breaks: true,
  walkTokens(token) {
    if (token.type === 'code' && (token as Tokens.Code).lang) (token as Tokens.Code).lang = (token as Tokens.Code).lang!.replace(HIDDEN_ALL, '');
  },
  renderer: {
    // Markup in an answer is shown as the text it is; a block of it keeps its own paragraph and lines.
    html(token) {
      const block = 'block' in token && token.block;
      return block ? `<p>${escapeHtml(token.text.trim()).replace(/\n/g, '<br>\n')}</p>\n` : escapeHtml(token.text);
    },
    link({ href, title, tokens }) { return link(href, title, this.parser.parseInline(tokens)); },
    image({ href, title, text }) { return link(href, title, escapeHtml(text || href)); }
  }
});

const STYLE = `
:root { color-scheme: light dark; --page: #fff; --ink: #1f1f1f; --soft: #5d5d5d; --edge: #e3e3e3; --bubble: #f2f2f2; --code: #f6f6f6; --link: #0b62c4; --mark: #ececec; }
@media (prefers-color-scheme: dark) {
  :root { --page: #1e1e1e; --ink: #ececec; --soft: #a8a8a8; --edge: #3a3a3a; --bubble: #2f2f2f; --code: #262626; --link: #7cb7ff; --mark: #3a3a3a; }
}
* { box-sizing: border-box; }
html { background: var(--page); color: var(--ink); }
body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; overflow-wrap: anywhere; }
main { max-width: 760px; margin: 0 auto; padding: 40px 20px 32px; }
header { padding-bottom: 20px; margin-bottom: 28px; border-bottom: 1px solid var(--edge); }
h1 { margin: 0 0 4px; font-size: 26px; line-height: 1.3; font-weight: 650; }
.date { margin: 0; color: var(--soft); font-size: 14px; }
.message { margin: 0 0 28px; }
.who { margin-bottom: 6px; color: var(--soft); font-size: 13px; font-weight: 600; }
.user { display: flex; flex-direction: column; align-items: flex-end; }
.user .body { max-width: 85%; padding: 10px 16px; border-radius: 18px; background: var(--bubble); white-space: pre-wrap; }
.assistant .body > :first-child { margin-top: 0; }
.assistant .body > :last-child { margin-bottom: 0; }
h2, h3, h4 { line-height: 1.35; margin: 1.4em 0 0.5em; }
.body h1 { font-size: 22px; margin: 1.4em 0 0.5em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
a { color: var(--link); }
blockquote { padding-inline-start: 14px; border-inline-start: 3px solid var(--edge); color: var(--soft); }
code { padding: 1px 5px; border-radius: 5px; background: var(--code); font: 0.9em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { padding: 12px 14px; border: 1px solid var(--edge); border-radius: 10px; background: var(--code); overflow-x: auto; }
pre code { padding: 0; background: none; white-space: pre; overflow-wrap: normal; }
table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; }
th, td { padding: 6px 10px; border: 1px solid var(--edge); text-align: start; }
hr { border: 0; border-top: 1px solid var(--edge); margin: 1.5em 0; }
.hidden { padding: 0 4px; border-radius: 4px; background: var(--mark); color: var(--soft); font-size: 0.85em; font-style: italic; white-space: nowrap; }
footer { padding-top: 16px; border-top: 1px solid var(--edge); color: var(--soft); font-size: 13px; }
`.trim();

const POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

function longDate(lang: string, now: Date): string {
  try { return new Intl.DateTimeFormat(lang, { dateStyle: 'long' }).format(now); }
  catch { return new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(now); }
}

/** The page, and how many details it hides (always 0 unless `hide`). */
export function chatPageHtml(request: ChatPageRequest): { html: string; hidden: number } {
  const { labels } = request;
  let hidden = 0;
  const prepare = (text: string): string => {
    if (!request.hide) return text;
    const result = hideForSharing(text);
    hidden += result.hidden;
    return result.text;
  };
  const mark = `<span class="hidden">${escapeHtml(labels.hidden)}</span>`;
  const shown = (html: string): string => request.hide ? html.replace(HIDDEN_ALL, mark) : html;
  const title = prepare(request.title);
  const messages = request.messages.map(message => {
    const text = prepare(message.text);
    const body = message.role === 'user' ? escapeHtml(text) : markdown.parse(text, { async: false });
    return `<section class="message ${message.role}">\n<div class="who">${escapeHtml(message.role === 'user' ? labels.you : labels.assistant)}</div>\n` +
      `<div class="body" dir="auto">${shown(body)}</div>\n</section>`;
  });
  const titleText = request.hide ? title.replace(HIDDEN_ALL, labels.hidden) : title;
  const html = [
    '<!doctype html>',
    `<html lang="${escapeHtml(request.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(titleText)}</title>`,
    `<style>\n${STYLE}\n</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<header>\n<h1 dir="auto">${shown(escapeHtml(title))}</h1>\n<p class="date">${escapeHtml(longDate(request.lang, request.now))}</p>\n</header>`,
    ...messages,
    `<footer>${escapeHtml(labels.footer)}</footer>`,
    '</main>',
    '</body>',
    '</html>',
    ''
  ].join('\n');
  return { html, hidden };
}
