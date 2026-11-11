import { describe, expect, it } from 'vitest';
import { hiddenCount, transcriptHtml } from '../src/shared/html-export.js';

const body = (html: string) => html.slice(html.indexOf('<main>'), html.indexOf('</main>'));

it('saves a chat as one page that runs no script and loads nothing', () => {
  const html = transcriptHtml('Plan <draft>', [
    { role: 'user', text: 'Explain **this**\n<script>alert(1)</script>' },
    { role: 'assistant', text: '## Steps\n\nRun `npm test`.\n\n```js\nconst a = "<b>";\n```' }
  ]);
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"`);
  expect(html).toContain('<title>Plan &lt;draft&gt;</title>');
  expect(html).not.toMatch(/<script|<link|<img|<[a-z][^>]*\ssrc=/i);
  // A person's text is shown as written; an answer is drawn from its Markdown.
  expect(body(html)).toContain('<h2>You</h2><p class="said" dir="auto">Explain **this**\n&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  expect(body(html)).toContain('<h2>Steps</h2>');
  expect(body(html)).toContain('<code>npm test</code>');
  expect(body(html)).toContain('const a = &quot;&lt;b&gt;&quot;;');
});

it('shows markup inside an answer as text and keeps only web and mail links', () => {
  const html = body(transcriptHtml('Chat', [{ role: 'assistant', text: [
    'Inline <img src=x onerror=alert(1)> tag.',
    '<iframe src="https://example.com/frame"></iframe>',
    '[docs](https://example.com/a?b=1&c=2 "Guide") [mail](mailto:you@example.com) [run](javascript:alert(1)) [file](file:///C:/Users/you/notes.txt)',
    '![diagram](https://example.com/diagram.png)'
  ].join('\n\n') }]));
  expect(html).not.toMatch(/<img|<iframe|<[a-z][^>]*\ssrc=|href="(?:javascript|file):/i);
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).toContain('&lt;iframe src=&quot;https://example.com/frame&quot;&gt;&lt;/iframe&gt;');
  expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" title="Guide" rel="noreferrer">docs</a>');
  expect(html).toContain('<a href="mailto:you@example.com" rel="noreferrer">mail</a>');
  expect(html).toContain('run file');
  // A picture would load from its host when the page opens: it becomes a link to it instead.
  expect(html).toContain('<a href="https://example.com/diagram.png" rel="noreferrer">diagram</a>');
});

it('names an untitled chat and leaves out empty messages', () => {
  const html = transcriptHtml('  ', [{ role: 'user', text: '  ' }, { role: 'assistant', text: 'Done.' }]);
  expect(html).toContain('<h1>Chat</h1>');
  expect(html).not.toContain('<h2>You</h2>');
  expect(html).toContain('<h2>ChatGPT</h2>');
});

it('keeps the lines of a block of markup, and names a picture without a description by its address', () => {
  const html = body(transcriptHtml('Chat', [{ role: 'assistant', text: '<div>\n<b>one</b>\n</div>\n\n![](https://example.com/p.png)' }]));
  expect(html).toContain('<p>&lt;div&gt;<br>\n&lt;b&gt;one&lt;/b&gt;<br>\n&lt;/div&gt;</p>');
  expect(html).toContain('<a href="https://example.com/p.png" rel="noreferrer">https://example.com/p.png</a>');
});

it('states its language, the date and where it came from, and names an untitled chat as asked', () => {
  const html = transcriptHtml(' ', [{ role: 'user', text: 'Hi' }], { user: 'Du', assistant: 'ChatGPT' },
    { lang: 'de', date: '24. Oktober 2026', footer: 'Geteilt aus Chat On Steroids', untitled: 'Neuer Chat' });
  expect(html).toContain('<html lang="de">');
  expect(html).toContain('<title>Neuer Chat</title>');
  expect(html).toContain('<h1>Neuer Chat</h1>\n<p class="date">24. Oktober 2026</p>');
  expect(html).toContain('<footer>Geteilt aus Chat On Steroids</footer>');
});

describe('hidden details', () => {
  const page = (title: string, text: string) => transcriptHtml(title, [{ role: 'user', text: 'x' }, { role: 'assistant', text }],
    { user: 'You', assistant: 'ChatGPT' }, { hidden: 'hidden' });

  it('shows each one as a mark in the interface language, and counts them', () => {
    const html = page('Key [redacted]', 'Use `[redacted]` and\n\n-----BEGIN KEY-----\n[redacted private key]');
    expect(html).toContain('<title>Key hidden</title>');
    expect(html).toContain('<h1>Key <span class="hidden">hidden</span></h1>');
    expect(html).toContain('<code><span class="hidden">hidden</span></code>');
    expect(html.match(/class="hidden"/g)).toHaveLength(3);
    expect(hiddenCount(html)).toBe(3);
  });

  it('never puts one inside a link, where its address would carry it', () => {
    const html = body(page('Chat', '[write](mailto:[redacted]) and [docs](https://example.com "for [redacted]")'));
    expect(html).toContain('write and <a href="https://example.com/" rel="noreferrer">docs</a>');
    expect(html).not.toContain('title=');
  });

  it('leaves the words alone when the page is not asked to mark them', () => {
    expect(body(transcriptHtml('Chat', [{ role: 'assistant', text: 'a [redacted] b' }]))).toContain('a [redacted] b');
  });
});
