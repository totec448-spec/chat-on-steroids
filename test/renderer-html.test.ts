import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredText } from '../src/shared/session.js';

let dom: JSDOM;
let renderedMessage: (html: StoredText | null | undefined, fallback: string) => HTMLElement;

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
  ({ renderedMessage } = await import('../src/renderer/chat.js'));
});

afterAll(() => {
  dom.window.close();
});

describe('captured ChatGPT rendered HTML', () => {
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
});
