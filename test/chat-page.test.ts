import { describe, expect, it } from 'vitest';
import { chatPageHtml, hideForSharing, type ChatPageLabels } from '../src/main/session/chat-page.js';

const labels: ChatPageLabels = { you: 'You', assistant: 'ChatGPT', hidden: 'hidden', footer: 'Shared from Chat On Steroids' };
const at = new Date(Date.UTC(2026, 9, 24, 12));
const page = (messages: { role: 'user' | 'assistant'; text: string }[], hide = false, title = 'Plan the trip') =>
  chatPageHtml({ title, messages, hide, lang: 'en', labels, now: at });

describe('the shared chat page', () => {
  it('is one self-contained page with a policy that loads and runs nothing', () => {
    const { html } = page([{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello **there**' }]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('<title>Plan the trip</title>');
    expect(html).toContain('<strong>there</strong>');
    expect(html).toContain('October 24, 2026');
    expect(html).not.toMatch(/<script|<link |<img |src=/i);
  });

  it('shows what the person wrote as text and what ChatGPT wrote as Markdown', () => {
    const { html } = page([{ role: 'user', text: '**not bold** <b>x</b>\nnext' }, { role: 'assistant', text: '# Head\n\n- one\n- two' }]);
    expect(html).toContain('**not bold** &lt;b&gt;x&lt;/b&gt;\nnext');
    expect(html).toContain('<h1>Head</h1>');
    expect(html).toContain('<li>one</li>');
  });

  it('never lets an answer or a title carry markup, scripts or unsafe links', () => {
    const { html } = page([{ role: 'assistant', text: [
      '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[click](javascript:alert(1))',
      '[mail](mailto:a@example.com) [site](https://example.com/a?b=1&c=2 "T")', '![pic](https://example.com/p.png)',
      '<a href="https://example.com">raw</a>'
    ].join('\n\n') }], false, '</title><script>x</script>');
    expect(html).not.toMatch(/<script|<img|href="javascript:|<a href="https:\/\/example.com">raw/i);
    expect(html).toContain('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).toContain('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>');
    expect(html).toContain('click');
    expect(html).toContain('<a href="mailto:a@example.com" rel="noopener noreferrer nofollow">mail</a>');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer nofollow" title="T">site</a>');
    // A picture would load from its host when the page opens: it becomes a link to it instead.
    expect(html).toContain('<a href="https://example.com/p.png" rel="noopener noreferrer nofollow">pic</a>');
  });

  it('keeps code exactly as written', () => {
    const { html } = page([{ role: 'assistant', text: '```js\nif (a < b && c) { x = "<y>"; }\n```' }]);
    expect(html).toContain('<pre><code class="language-js">if (a &lt; b &amp;&amp; c) { x = &quot;&lt;y&gt;&quot;; }\n</code></pre>');
  });

  it('follows the reader’s light or dark setting and reads right to left where the text does', () => {
    const { html } = page([{ role: 'user', text: 'مرحبا' }]);
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('<div class="body" dir="auto">');
  });

  it('hides nothing unless asked', () => {
    const text = 'Key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 mail ana@example.com in /Users/ana/x';
    const result = page([{ role: 'user', text }]);
    expect(result.hidden).toBe(0);
    expect(result.html).toContain('ana@example.com');
    expect(result.html).toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('when asked, hides keys, email addresses and user names in folder paths, and counts them', () => {
    const text = 'Key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789, mail ana@example.com, in /Users/ana/x and C:\\Users\\Ana Lee\\y';
    const result = page([{ role: 'user', text }, { role: 'assistant', text: 'Run `/home/bo/app` with\n\n```\nAPI_TOKEN=abc123def\n```' }], true, 'For ana@example.com');
    // Six in the messages and one in the title.
    expect(result.hidden).toBe(7);
    for (const secret of ['ana@', 'sk-proj', '/Users/ana', 'Ana Lee', '/home/bo', 'abc123def']) expect(result.html).not.toContain(secret);
    expect(result.html).toContain('/Users/<span class="hidden">hidden</span>/x');
    expect(result.html).toContain('C:\\Users\\<span class="hidden">hidden</span>\\y');
    expect(result.html).toContain('<code>/home/<span class="hidden">hidden</span>/app</code>');
    expect(result.html).toContain('<title>For hidden</title>');
    expect(result.html).toContain('<h1 dir="auto">For <span class="hidden">hidden</span></h1>');
  });

  it('never puts a hidden detail inside a link, which would show it in the address', () => {
    const result = page([{ role: 'assistant', text: '[write to me](mailto:ana@example.com) and [files](file:///Users/ana/a)' }], true);
    expect(result.html).not.toContain('ana');
    expect(result.html).not.toContain('<a ');
    expect(result.html).toContain('write to me and files');
  });
});

describe('hiding details for sharing', () => {
  const mark = '\uE000';
  it('keeps shared system folders, which name no person', () => {
    expect(hideForSharing('/Users/Shared/a C:\\Users\\Public\\b /home/ c:/users/default/d').hidden).toBe(0);
  });

  it('finds every kind once and leaves ordinary text alone', () => {
    expect(hideForSharing('Version 1.2.3 at 10:30, commit 3f9a2b1, ana@example and @handle').hidden).toBe(0);
    const twice = hideForSharing('a@b.io and a@b.io');
    expect(twice).toEqual({ text: `${mark} and ${mark}`, hidden: 2 });
  });

  it('drops the marker character from the text first, so text cannot fake a hidden detail', () => {
    expect(hideForSharing(`x${mark}y`)).toEqual({ text: 'xy', hidden: 0 });
  });
});
