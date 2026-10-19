import { expect, it } from 'vitest';
import { transcriptHtml } from '../src/shared/html-export.js';

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
  expect(html).toContain('<p>diagram</p>');
});

it('names an untitled chat and leaves out empty messages', () => {
  const html = transcriptHtml('  ', [{ role: 'user', text: '  ' }, { role: 'assistant', text: 'Done.' }]);
  expect(html).toContain('<h1>Chat</h1>');
  expect(html).not.toContain('<h2>You</h2>');
  expect(html).toContain('<h2>ChatGPT</h2>');
});
