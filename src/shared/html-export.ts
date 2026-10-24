import { Marked } from 'marked';

/* A chat transcript as one HTML page that opens in any browser and needs nothing else: the styles
   are inline, and the page loads no script, font, image or other address. Its policy forbids them
   too, so even markup that got past the escaping below could not run or call home. */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char]!);
}

/** Web and mail links only; a file, script or app address keeps its text and loses the link. */
function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

// An answer is Markdown, drawn as the timeline draws it (single line breaks kept). Markup inside
// it is shown as written, never interpreted, and an image keeps its description, not its address.
const answers = new Marked({ gfm: true, breaks: true, renderer: {
  html({ text }) { return escapeHtml(text); },
  image({ text }) { return escapeHtml(text); },
  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    const target = safeHref(href);
    return target ? `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''} rel="noreferrer">${label}</a>` : label;
  }
} });

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
`;

/** A whole chat as one HTML file: the title, then each message under who said it. */
export function transcriptHtml(title: string, entries: readonly { role: 'user' | 'assistant'; text: string }[],
  labels: { user: string; assistant: string } = { user: 'You', assistant: 'ChatGPT' }): string {
  const heading = escapeHtml(title.trim() || 'Chat');
  // What a person wrote is plain text, as the timeline shows it; only answers are Markdown.
  const sections = entries.map(entry => ({ role: entry.role, text: entry.text.trim() })).filter(entry => entry.text).map(entry =>
    entry.role === 'user'
      ? `<section class="user"><h2>${escapeHtml(labels.user)}</h2><p class="said" dir="auto">${escapeHtml(entry.text)}</p></section>`
      : `<section class="assistant"><h2>${escapeHtml(labels.assistant)}</h2><div class="answer" dir="auto">\n${answerHtml(entry.text)}</div></section>`);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${heading}</h1>
${sections.join('\n')}
</main>
</body>
</html>
`;
}
