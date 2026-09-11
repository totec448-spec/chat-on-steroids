import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StoredText } from '../src/shared/session.js';

let dom: JSDOM;
let renderedMessage: (html: StoredText | null | undefined, fallback: string) => HTMLElement;
let renderedMarkdown: (text: string, capture?: StoredText) => HTMLElement;

/** A whole capture, as the store holds one. */
const whole = (text: string): StoredText => ({ text, truncated: false, chars: text.length });

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/' });
  Object.defineProperty(dom.window, 'api', { value: {}, configurable: true });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node
  });
  ({ renderedMessage, renderedMarkdown } = await import('../src/renderer/chat.js'));
});

afterAll(() => {
  dom.window.close();
});

describe('captured ChatGPT rendered HTML', () => {
  it('renders the recorded native URL token as its authored label and opens it through validated IPC', () => {
    const openLink = vi.fn(async () => ({ ok: true, data: true }));
    (dom.window as any).api.openLink = openLink;
    const source = '\uE200url\uE202Dummerspast39 on X\uE202https://x.com/Dummerspast39\uE201';
    const rendered = renderedMarkdown(source);
    const link = rendered.querySelector('a')!;
    expect(rendered.textContent?.trim()).toBe('Dummerspast39 on X');
    expect(link.getAttribute('href')).toBe('https://x.com/Dummerspast39');
    const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openLink).toHaveBeenCalledWith('https://x.com/Dummerspast39');
  });
  it('opens ordinary Markdown links on nested text clicks and middle clicks without renderer navigation', () => {
    const openLink = vi.fn(async () => ({ ok: true, data: true }));
    (dom.window as any).api.openLink = openLink;
    const rendered = renderedMarkdown('[**Project**](https://example.com/project)');
    rendered.querySelector('strong')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    rendered.querySelector('a')!.dispatchEvent(new dom.window.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    expect(openLink.mock.calls).toEqual([['https://example.com/project'], ['https://example.com/project']]);
  });
  it('keeps native URL labels text-only, removes unsafe destinations and preserves literal token code examples', () => {
    const unsafe = '\uE200url\uE202<img src=x onerror=alert(1)>\uE202javascript:alert(1)\uE201';
    const rendered = renderedMarkdown(unsafe);
    expect(rendered.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(rendered.querySelector('img')).toBeNull();
    expect(rendered.textContent?.trim()).toBe('<img src=x onerror=alert(1)>');
    const literal = '\uE200url\uE202Example\uE202https://example.com\uE201';
    const code = renderedMarkdown('`' + literal + '`\n\n```text\n' + literal + '\n```');
    expect(code.querySelectorAll('a')).toHaveLength(0);
    expect(code.querySelector('code')?.textContent).toBe(literal);
  });
  it('recovers a native citation URL by exact source range while preserving the complete canonical revision', () => {
    const marker = '\uE200cite\uE202turn12search0\uE201';
    const source = 'Evidence. ' + marker + '\n\nThe rest of the new canonical answer is not painted yet.';
    const capture = whole(`<p>Evidence. <span data-content-reference-start="10" data-content-reference-end="${10 + marker.length}"><a href="https://example.com/source">Original source</a></span></p>`);
    const rendered = renderedMarkdown(source, capture);
    expect(rendered.querySelector('a')?.getAttribute('href')).toBe('https://example.com/source');
    expect(rendered.textContent).toContain('The rest of the new canonical answer');
    expect(rendered.textContent).not.toMatch(/[\uE200-\uE202]/);
    const stale = renderedMarkdown(source, whole(capture.text.replace('Evidence.', 'Different.')));
    expect(stale.querySelector('a')).toBeNull();
    expect(stale.textContent).toContain('[source link unavailable]');
  });
  it('shows exact uploaded-file citation names as text and omits missing or stale file references', () => {
    const marker = '\uE200filecite\uE202turn0file0\uE201';
    const source = 'See the plan. ' + marker + '\n\nContinue here.';
    const capture = whole(`<p>See the plan. <span data-content-reference-start="14" data-content-reference-end="${14 + marker.length}"><span data-file-citation-primary-file-id="file_example"><button><svg></svg><p>PLAN-round2</p></button></span></span></p>`);
    const rendered = renderedMarkdown(source, capture);
    expect(rendered.textContent).toContain('(PLAN-round2)');
    expect(rendered.querySelector('a, button, svg')).toBeNull();
    expect(rendered.textContent).toContain('Continue here.');
    for (const absent of [undefined, whole(capture.text.replace('See the plan.', 'Old version.'))]) {
      const text = renderedMarkdown(source, absent).textContent!;
      expect(text).not.toMatch(/unavailable|PLAN-round2|[\uE200-\uE202]/);
      expect(text).toContain('Continue here.');
    }
    const unsafe = renderedMarkdown(source, whole(capture.text.replace('PLAN-round2', '&lt;img src=x onerror=alert(1)&gt;')));
    expect(unsafe.querySelector('img')).toBeNull();
    expect(unsafe.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(renderedMarkdown('`' + marker + '`').querySelector('code')?.textContent).toBe(marker);
  });
  it('matches provider Unicode ranges after emoji and normalizes native list hard breaks', () => {
    const marker = '\uE200filecite\uE202turn0file0\uE201';
    const prefix = '1. **Plan 😅**  \n   Read it. ';
    const start = [...prefix].length;
    const capture = whole(`<ol><li><p><strong>Plan 😅</strong><br>Read it. <span data-content-reference-start="${start}" data-content-reference-end="${start + [...marker].length}"><span data-file-citation-primary-file-id="file_example"><button><p>Plan document</p></button></span></span></p></li></ol>`);
    const rendered = renderedMarkdown(prefix + marker, capture);
    expect(rendered.textContent).toContain('(Plan document)');
    expect(rendered.querySelector('a')).toBeNull();
    const stale = renderedMarkdown(prefix + marker, whole(capture.text.replace('Read it.', 'Read that.')));
    expect(stale.textContent).not.toContain('Plan document');
  });
  it('contains authored and captured tables without discarding cell text or trusting page styles', () => {
    for (const rendered of [
      renderedMarkdown('| Area | Details |\n| --- | --- |\n| Great Hall | ' + 'Longunbrokenfilename'.repeat(20) + ' |'),
      renderedMessage(whole('<table style="width:9999px"><tr><td colspan="2" style="white-space:nowrap">All details remain readable</td></tr></table>'), '')
    ]) {
      const table = rendered.querySelector('table')!;
      expect(table.parentElement?.className).toBe('markdown-table');
      expect(table.parentElement?.tabIndex).toBe(0);
      expect(table.querySelector('td')?.textContent).toBeTruthy();
      expect(table.querySelector('[style]')).toBeNull();
      expect(table.getAttribute('style')).toBeNull();
    }
  });
  it('renders the complete canonical Markdown revision with formatting and sanitized HTML', () => {
    const rendered = renderedMarkdown('1. Rain begins when **water condenses**.\n\n2. The final paragraph. COS-0606-FINAL-A\n\n```js\nconst rain = true;\n```\n<script>alert(1)</script>');
    expect(rendered.querySelectorAll('li')).toHaveLength(2);
    expect(rendered.querySelector('strong')?.textContent).toBe('water condenses');
    expect(rendered.querySelector('pre code')?.textContent).toContain('const rain = true;');
    expect(rendered.textContent).toContain('COS-0606-FINAL-A');
    expect(rendered.querySelector('script')).toBeNull();
  });
  it('keeps semantic Markdown structure while stripping executable attributes and unsafe links', () => {
    const rendered = renderedMessage(
      whole(
        '<h2 onclick="alert(1)">Heading</h2><p><strong>bold</strong> and <em>italic</em></p>' +
          '<pre><code class="language-ts">const x = 1;</code></pre>' +
          '<a href="javascript:alert(1)" title="unsafe">bad link</a>' +
          '<a href="https://example.com/path" onclick="alert(2)">good link</a>'
      ),
      'fallback'
    );

    expect(rendered.querySelector('h2')?.textContent).toBe('Heading');
    expect(rendered.querySelector('strong')?.textContent).toBe('bold');
    expect(rendered.querySelector('pre code')?.textContent).toBe('const x = 1;');
    expect(rendered.querySelector('code')?.getAttribute('class')).toBeNull();
    const links = rendered.querySelectorAll('a');
    expect(links[0]?.getAttribute('href')).toBeNull();
    expect(links[1]?.getAttribute('href')).toBe('https://example.com/path');
    expect(links[1]?.getAttribute('onclick')).toBeNull();
    expect(links[1]?.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('drops SVG and MathML namespace content instead of letting it bypass the sanitizer', () => {
    const rendered = renderedMessage(
      whole(
        '<p>before</p>' +
          '<svg onload="alert(1)"><foreignObject><p>svg payload</p></foreignObject></svg>' +
          '<math><mtext>math payload</mtext></math>' +
          '<script>alert(2)</script><p>after</p>'
      ),
      'fallback'
    );

    expect(rendered.querySelector('svg')).toBeNull();
    expect(rendered.querySelector('math')).toBeNull();
    expect(rendered.querySelector('script')).toBeNull();
    expect(rendered.textContent).toBe('beforeafter');
  });
});

/**
 * The boxed-prose bug, from the shape that caused it.
 *
 * ChatGPT wraps every code block in several hundred characters of chrome — a language label,
 * a sticky Copy/Edit toolbar, three nested layout divs — around a few lines of code. A capture
 * bounded by a character count therefore lands inside one routinely, and what came out the
 * other side was markup that stopped mid-element: the prose after the block was gone, and the
 * remainder of the message ended inside an unclosed `<pre>`, which this renderer draws as a
 * bordered monospace box. The message looked like one big code box with its text missing.
 */
describe('a capture that could not be carried whole', () => {
  const CODE_BLOCK =
    '<p>Run the suite before pushing.</p>' +
    '<pre class="overflow-visible!"><div class="contain-inline-size rounded-2xl relative">' +
    '<div class="flex items-center px-4 py-2 text-xs select-none">bash</div>' +
    '<div class="sticky top-9"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2">' +
    '<button class="flex gap-1 items-center select-none py-1" aria-label="Copy">Copy</button>' +
    '<button class="flex items-center gap-1 py-1 select-none">Edit</button>' +
    '</div></div>' +
    '<div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! language-bash">npm run verify</code></div>' +
    '</div></pre>' +
    '<p>Then open a pull request.</p>';
  const MARKDOWN = 'Run the suite before pushing.\n\n```bash\nnpm run verify\n```\n\nThen open a pull request.';

  it('renders a whole capture as blocks, with ChatGPT’s toolbar chrome removed', () => {
    const rendered = renderedMessage(whole(CODE_BLOCK), MARKDOWN);

    expect(rendered.classList.contains('rich')).toBe(true);
    expect(rendered.querySelector('pre code')?.textContent).toBe('npm run verify');
    // The prose either side of the block is prose, not part of the box.
    const paragraphs = [...rendered.querySelectorAll('p')].map((node) => node.textContent);
    expect(paragraphs).toEqual(['Run the suite before pushing.', 'Then open a pull request.']);
    expect(rendered.querySelector('button')).toBeNull();
    expect(rendered.textContent).not.toContain('Copy');
  });

  it('shows the whole message as markdown rather than a cut capture ending inside a code box', () => {
    // Cut inside the block's chrome, exactly where a character budget lands on real markup.
    const cutAt = CODE_BLOCK.indexOf('<code class=') + 20;
    const cut: StoredText = {
      text: CODE_BLOCK.slice(0, cutAt),
      truncated: true,
      chars: CODE_BLOCK.length
    };

    // Proof of the failure this replaces: that markup, rendered, is a box that swallowed the
    // message and lost the prose after it.
    const boxed = renderedMessage(whole(cut.text), MARKDOWN);
    expect(boxed.querySelector('pre')).not.toBeNull();
    expect(boxed.textContent).not.toContain('Then open a pull request.');

    const rendered = renderedMessage(cut, MARKDOWN);
    expect(rendered.classList.contains('rich')).toBe(false);
    expect(rendered.querySelector('pre')).toBeNull();
    expect(rendered.textContent).toBe(MARKDOWN);
  });

  it('lays the markdown source out as text, so a brief keeps its lines', () => {
    const rendered = renderedMessage(null, MARKDOWN);

    // `msg` is pre-wrap and `msg.rich` is `white-space: normal`. Flowing plain markdown runs
    // every heading, list item and paragraph of a handoff brief into one block of prose.
    expect(rendered.className).toBe('msg');
    expect(rendered.classList.contains('rich')).toBe(false);
    expect(rendered.textContent).toBe(MARKDOWN);
  });

  it('falls back to the markdown when the capture sanitizes away to nothing', () => {
    const rendered = renderedMessage(whole('<svg><foreignObject>only unsafe content</foreignObject></svg>'), MARKDOWN);

    expect(rendered.classList.contains('rich')).toBe(false);
    expect(rendered.textContent).toBe(MARKDOWN);
  });

  it('reads a right-to-left answer in its own direction', () => {
    // Nothing in the recording says which way this runs, and the stylesheet is left-to-right
    // throughout, so the container has to resolve it from the text itself.
    expect(renderedMarkdown('مرحبا بالعالم').getAttribute('dir')).toBe('auto');
  });

  it('resolves separate Markdown prose blocks without letting an English introduction or code set their direction', () => {
    const rendered = renderedMarkdown('English introduction.\n\nمرحبا بالعالم 123.\n\nשלום עולם!\n\n- خطوة أولى\n- خطوة ثانية\n\n> اقتباس عربي\n\n```js\nconst name = "مرحبا";\n```');
    expect([...rendered.querySelectorAll(':scope > p, ul, blockquote')].map(node => node.getAttribute('dir')))
      .toEqual(['auto', 'auto', 'auto', 'auto', 'auto']);
    // The list/quote owns its subtree; nested auto scopes would remove its text from
    // the browser's first-strong scan and put the marker/border on the wrong side.
    expect(rendered.querySelector('blockquote p')?.hasAttribute('dir')).toBe(false);
    expect(rendered.querySelector('pre')?.getAttribute('dir')).toBe('ltr');
    expect(rendered.querySelector('code')?.getAttribute('dir')).toBe('ltr');
    const table = renderedMarkdown('| English | العربية |\n| --- | --- |\n| Hello | مرحبا |');
    expect([...table.querySelectorAll('th, td')].every(node => node.getAttribute('dir') === 'auto')).toBe(true);
  });

  it('respects an explicit ancestor direction while isolating code from RTL prose', () => {
    const rendered = renderedMessage(whole('<div dir="rtl"><p>English inside an explicitly RTL block.</p><pre><code>const x = 1;</code></pre></div>'), '');
    expect(rendered.querySelector('div')?.getAttribute('dir')).toBe('rtl');
    expect(rendered.querySelector('p')?.hasAttribute('dir')).toBe(false);
    expect(rendered.querySelector('pre')?.getAttribute('dir')).toBe('ltr');
  });

  it('keeps the direction ChatGPT marked on a mixed-language answer', () => {
    // One first strong character cannot describe two paragraphs that run opposite ways, so
    // where the capture carried the answer, sanitisation has to leave it there.
    const rendered = renderedMessage(whole('<p dir="rtl">مرحبا بالعالم</p><p dir="ltr">Hello world</p>'), 'fallback');

    expect([...rendered.querySelectorAll('p')].map((node) => node.getAttribute('dir'))).toEqual(['rtl', 'ltr']);
  });

  it('drops a direction value that is not one of the three', () => {
    const rendered = renderedMessage(whole('<p dir="javascript:alert(1)">text</p>'), 'fallback');

    expect(rendered.querySelector('p')!.getAttribute('dir')).toBe('auto');
  });
});
