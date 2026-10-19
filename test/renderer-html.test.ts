import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageReference, StoredText } from '../src/shared/session.js';

let dom: JSDOM;
let renderedMessage: (html: StoredText | null | undefined, fallback: string) => HTMLElement;
let renderedMarkdown: (text: string, capture?: StoredText, references?: readonly MessageReference[]) => HTMLElement;
let finishedBlocks: (text: string) => string;

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
  ({ renderedMessage, renderedMarkdown, finishedBlocks } = await import('../src/renderer/chat.js'));
});

afterAll(() => {
  dom.window.close();
});

describe('captured ChatGPT rendered HTML', () => {
  it('keeps the matching examples in the screenshot structured as Markdown, including the two warnings', () => {
    const answer = '## Examples from sample data\n\n' +
      '✅ **Strong matching candidate**\n\nCSV: `Sample product 20mg 30 tablets`\n\n' +
      'Existing: `SAMPLE PRODUCT 20MG 30 TABLETS`\n\n98% name similarity.\n\n---\n\n' +
      '⚠️ **Must not merge automatically**\n\nCSV: `Example product 70mg 60 tablets`\n\n' +
      'Existing: `EXAMPLE PRODUCT 50MG 60 TABLETS`\n\nStrength differs.';
    const rendered = renderedMarkdown(answer);
    expect(rendered.querySelector('h2')?.textContent).toBe('Examples from sample data');
    expect(rendered.querySelectorAll('strong')).toHaveLength(2);
    expect(rendered.querySelectorAll('code')).toHaveLength(4);
    expect(rendered.querySelector('hr')).not.toBeNull();
    expect(rendered.textContent).toContain('⚠️ Must not merge automatically');
  });

  it('shows a provider-rendered form as a safe read-only question with the choices and no live controls', () => {
    const pointer = '::chatgpt-content-reference{index="0" source_message_id="same-message"}';
    const capture = whole('<div><p>Review these candidates.</p><form>' +
      '<fieldset><legend>How should I proceed?</legend>' +
      '<label><input type="radio" name="choice" value="safe">Merge strong matches only</label>' +
      '<label><input type="radio" name="choice" value="review">Review all matches</label>' +
      '<button type="submit" onclick="alert(1)">Continue</button></fieldset></form></div>');
    const rendered = renderedMarkdown(pointer, capture);
    expect(rendered.textContent).toContain('Review these candidates.');
    expect(rendered.textContent).toContain('How should I proceed?');
    expect(rendered.textContent).toContain('Merge strong matches only');
    expect(rendered.textContent).toContain('Review all matches');
    expect(rendered.querySelector('.native-prompt-readonly')?.textContent).not.toContain('Continue');
    expect(rendered.textContent).toContain('Answer this prompt in ChatGPT');
    expect(rendered.querySelector('.native-prompt-readonly')).not.toBeNull();
    expect(rendered.querySelector('form, input, button, fieldset')).toBeNull();
    expect(rendered.querySelector('[onclick]')).toBeNull();
  });

  it('mirrors an anchored native choice prompt alongside the canonical Markdown without mirroring unrelated controls', () => {
    const capture = whole('<div><p>Which option should we use?</p>' +
      '<div role="radiogroup" aria-label="Which option should we use?">' +
      '<div role="radio" aria-checked="false">Keep the original</div>' +
      '<div role="radio" aria-checked="false">Merge the records</div></div>' +
      '<button aria-label="Copy">Copy</button></div>');
    const rendered = renderedMarkdown('**Which option should we use?**', capture);
    expect(rendered.textContent).toContain('Keep the original');
    expect(rendered.textContent).toContain('Merge the records');
    expect(rendered.textContent?.match(/Which option should we use\?/g)).toHaveLength(1);
    expect(rendered.textContent).toContain('Answer this prompt in ChatGPT');
    expect(rendered.textContent).not.toContain('Copy');
    expect(rendered.querySelector('[role="radio"], button')).toBeNull();
    expect(renderedMarkdown('An unrelated newer reply.', capture).textContent).not.toContain('Merge the records');
    // A long introduction must not hide a legitimately matching prompt at the end.
    const later = renderedMarkdown('Background. '.repeat(40) + '\n\n**Which option should we use?**', capture);
    expect(later.textContent).toContain('Keep the original');
    // A malicious or escaped sample of a form is not an interactive prompt.
    const unsafe = whole('<pre><form><p>Which option should we use?</p><button>Fake choice</button></form></pre>');
    expect(renderedMarkdown('**Which option should we use?**', unsafe).textContent).not.toContain('Fake choice');
  });
  it('renders ChatGPT\'s writing block as a titled quote instead of its raw directive', () => {
    const rendered = renderedMarkdown(':::writing{variant="standard" id="58321" title="Clear <rewrite>"}\nWe want the app to be **faster**.\n:::\n\nAfter the block.');
    const quote = rendered.querySelector('blockquote')!;
    expect(rendered.querySelector('.markdown-writing .tool-output-header strong')?.textContent).toBe('Clear <rewrite>');
    expect(quote.textContent).toContain('We want the app to be faster.');
    expect(quote.querySelectorAll('strong')).toHaveLength(1);
    expect(rendered.textContent).not.toContain(':::');
    expect(rendered.textContent).toContain('After the block.');
    // A block still streaming, or an answer stopped inside it, has no closing `:::` yet. ChatGPT
    // draws it as the block to the end of the message; it showed here as its raw directive.
    const open = renderedMarkdown(':::writing{variant="document" title="The Keeper"}\nElias kept the light.\n\nThen Mara came.');
    expect(open.querySelector('.markdown-writing .tool-output-header strong')?.textContent).toBe('The Keeper');
    expect(open.querySelector('blockquote')?.textContent).toContain('Then Mara came.');
    expect(open.textContent).not.toContain(':::writing');
  });

  // #1477: ChatGPT gives a writing block its own Copy button; the app showed a quote with nothing to copy it by.
  it('gives a writing block a Copy button that copies the block\'s own text, Markdown included', async () => {
    const writeClipboard = vi.fn(async () => ({ ok: true, data: true }));
    // chat.ts holds the api object it found at import; give that object the call.
    Object.assign((dom.window as unknown as { api: object }).api, { writeClipboard });
    const rendered = renderedMarkdown('Here is the email.\n\n:::writing{id="48317" variant="email" subject="New release is out"}\nHi, the new release is **out**.\n\n- Notes are online\n:::\n\nAnything else?');
    const panels = rendered.querySelectorAll('.markdown-writing');
    expect(panels).toHaveLength(1);
    expect(panels[0]!.querySelector('.tool-output-header strong')?.textContent).toBe('New release is out');
    const copy = panels[0]!.querySelector<HTMLButtonElement>('.tool-copy')!;
    expect(copy.textContent).toBe('Copy');
    copy.click();
    await vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('Hi, the new release is **out**.\n\n- Notes are online'));
    expect(rendered.textContent).toContain('Here is the email.');
    expect(rendered.textContent).toContain('Anything else?');
    expect(rendered.textContent).not.toContain(':::');
    // An untitled block still gets the panel, named by what it is.
    const plain = renderedMarkdown(':::writing{variant="standard"}\nJust text.\n:::');
    expect(plain.querySelector('.markdown-writing .tool-output-header strong')?.textContent).toBe('Text');
  });

  it('names a code block by its language, wraps its long lines on request and saves it with that language\'s extension', async () => {
    const saveCode = vi.fn(async () => ({ ok: true, data: { done: 'saved', name: 'snippet.ts' } }));
    Object.assign((dom.window as unknown as { api: object }).api, { saveCode });
    const rendered = renderedMarkdown('Here it is.\n\n```typescript\nconst answer = 42;\n```\n\n```\nplain words\n```');
    const [typed, plain] = [...rendered.querySelectorAll('.markdown-code')];
    expect(typed!.querySelector('.tool-output-header strong')?.textContent).toBe('typescript');
    expect(plain!.querySelector('.tool-output-header strong')?.textContent).toBe('Code');
    expect([...typed!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Copy', 'Wrap', 'Save']);
    const wrap = typed!.querySelector<HTMLButtonElement>('.code-wrap')!;
    wrap.click();
    expect(typed!.classList.contains('is-wrapped')).toBe(true);
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    expect(plain!.classList.contains('is-wrapped')).toBe(false);
    wrap.click();
    expect(typed!.classList.contains('is-wrapped')).toBe(false);
    expect(wrap.getAttribute('aria-pressed')).toBe('false');
    typed!.querySelector<HTMLButtonElement>('.code-save')!.click();
    await vi.waitFor(() => expect(saveCode).toHaveBeenCalledWith({ text: 'const answer = 42;\n', name: 'snippet.ts' }));
    plain!.querySelector<HTMLButtonElement>('.code-save')!.click();
    await vi.waitFor(() => expect(saveCode).toHaveBeenLastCalledWith({ text: 'plain words\n', name: 'snippet.txt' }));
    // A class that is not a plain language name names nothing, and its file is text.
    const odd = renderedMessage(whole('<pre><code class="language-../../x">x</code></pre>'), 'x');
    expect(odd.querySelector('.tool-output-header strong')?.textContent).toBe('Code');
    odd.querySelector<HTMLButtonElement>('.code-save')!.click();
    await vi.waitFor(() => expect(saveCode).toHaveBeenLastCalledWith({ text: 'x', name: 'snippet.txt' }));
    // A language that happens to name a member every object has is still just a language.
    const member = renderedMarkdown('```constructor\ny\n```');
    expect(member.querySelector('.tool-output-header strong')?.textContent).toBe('constructor');
    member.querySelector<HTMLButtonElement>('.code-save')!.click();
    await vi.waitFor(() => expect(saveCode).toHaveBeenLastCalledWith({ text: 'y\n', name: 'snippet.txt' }));
  });

  it('shows the page\'s resolved content for a content-reference reply instead of the raw pointer (#574)', () => {
    const pointer = '::chatgpt-content-reference{index="0" source_message_id="d2b82e00-509e-4a87-aa93-00bcde251680"}';
    // The page resolved the pointer: its capture is this message's faithful presentation.
    const resolved = renderedMarkdown(pointer, whole('<p>Hi! How can I help you today?</p>'));
    expect(resolved.textContent?.trim()).toBe('Hi! How can I help you today?');
    expect(resolved.textContent).not.toContain('chatgpt-content-reference');
    // Without a usable capture the pointer is dropped, and an otherwise empty reply says why.
    expect(renderedMarkdown(pointer).textContent?.trim()).toBe('This reply points to content from another message that was not recorded.');
    expect(renderedMarkdown(pointer, whole(`<p>${pointer}</p>`)).textContent).not.toContain('chatgpt-content-reference');
    expect(renderedMarkdown(`Before\n${pointer}\nAfter`).textContent).toMatch(/Before[\s\S]*After/);
    expect(renderedMarkdown(`Before\n${pointer}\nAfter`).textContent).not.toContain('chatgpt-content-reference');
    // Quoted inside code it is text, not a pointer.
    expect(renderedMarkdown(`Use \`${pointer}\` in docs.`).textContent).toContain('chatgpt-content-reference');
  });

  // 2.1.41 bug hunt: ChatGPT draws an answer's paragraphs with white-space: pre-line, so a poem's single
  // line breaks stay lines there. Here the three lines ran together as one sentence.
  it('keeps an answer\'s single line breaks as ChatGPT shows them, inside paragraphs and list items', () => {
    const rendered = renderedMarkdown('The river weaves its silver dreams,\nAnd carries whispered secrets.\nThe River\'s Song\n\n- first line\n  continued\n- second');
    const paragraph = rendered.querySelector('p')!;
    expect(paragraph.querySelectorAll('br')).toHaveLength(2);
    expect(paragraph.innerHTML.split('<br>').map(line => line.trim())).toEqual(['The river weaves its silver dreams,', 'And carries whispered secrets.', 'The River\'s Song']);
    expect(rendered.querySelector('li')!.querySelectorAll('br')).toHaveLength(1);
    // A blank line is still a new paragraph, and code keeps its own lines without breaks added.
    const code = renderedMarkdown('One\n\nTwo\n\n```\na\nb\n```');
    expect(code.querySelectorAll('p')).toHaveLength(2);
    expect(code.querySelector('pre')!.querySelectorAll('br')).toHaveLength(0);
  });

  it('never shows an unknown ChatGPT directive as raw text', () => {
    const leaf = '::chatgpt-entity{type="place" id="42"}';
    expect(renderedMarkdown(leaf, whole('<p>Berlin</p>')).textContent?.trim()).toBe('Berlin');
    expect(renderedMarkdown(`Intro\n${leaf}`).textContent).not.toContain('::chatgpt-entity');
    expect(renderedMarkdown(':::canvas{title="Plan"}\nStep one\n:::').textContent).toContain('Step one');
    expect(renderedMarkdown(':::canvas{title="Plan"}\nStep one\n:::').textContent).not.toContain(':::');
  });

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
  it('recovers a later hydrated occurrence when the same citation marker appears twice', () => {
    const marker = '\uE200cite\uE202turn-repeat-search0\uE201';
    const firstPrefix = 'First claim. ';
    const middle = ' Later claim. ';
    const secondStart = [...firstPrefix + marker + middle].length;
    const source = firstPrefix + marker + middle + marker;
    const capture = whole(
      `<p>${firstPrefix}<span data-content-reference-start="${[...firstPrefix].length}" data-content-reference-end="${[...firstPrefix].length + [...marker].length}"></span>` +
      `${middle}<span data-content-reference-start="${secondStart}" data-content-reference-end="${secondStart + [...marker].length}">` +
      '<a href="https://example.com/later">Later source</a></span></p>'
    );
    const rendered = renderedMarkdown(source, capture);
    expect([...rendered.querySelectorAll('a')].map(anchor => anchor.getAttribute('href'))).toEqual([
      'https://example.com/later',
      'https://example.com/later'
    ]);
  });
  it('draws an inline content-reference directive as the source pill ChatGPT rendered for it', () => {
    // Live shape: the directive ends a sentence; the page renders a pill with the source, its URL and a count.
    const source = 'Splitting prefill and decode uses the hardware better. :chatgpt-content-reference{index="0"}\n\nThe file is written.';
    const pill = (href: string, name: string, more: string) => `<span data-state="closed"><span><a data-testid="chatgpt-citation" aria-label="${name}: A paper title, ${href}, 2 additional sources" href="${href}"><span><span><img alt="" src="https://icons.example/x.png"></span><span>${name}</span></span><span aria-hidden="true">${more}</span></a></span></span>`;
    const capture = whole(`<p>Splitting prefill and decode uses the hardware better. ${pill('https://arxiv.org/abs/2609.00001', 'arXiv', '+2')}</p><p>The file is written.</p>`);
    const rendered = renderedMarkdown(source, capture);
    const link = rendered.querySelector<HTMLAnchorElement>('a.citation-pill')!;
    expect(link.getAttribute('href')).toBe('https://arxiv.org/abs/2609.00001');
    expect(link.textContent).toBe('arXiv+2');
    // The card shows what the page recorded: the source's title, and that two more were not recorded.
    const card = rendered.querySelector<HTMLElement>('.citation-card')!;
    card.parentElement!.dispatchEvent(new window.FocusEvent('focusin'));
    expect(card.querySelector('a.citation-card-title')?.textContent).toBe('A paper title');
    expect(card.querySelector('.citation-card-note')?.textContent).toBe('2 more sources were not recorded with this reply.');
    expect(card.querySelector('.citation-card-nav')).toBeNull();
    expect(rendered.querySelector('img')).toBeNull();
    expect(rendered.textContent).not.toContain('chatgpt-content-reference');
    expect(rendered.textContent).not.toMatch(/[\uE000\uE001]/);
    // Prose that no longer matches proves nothing: the directive is dropped, never shown raw or guessed.
    const stale = renderedMarkdown(source, whole(capture.text.replace('Splitting', 'Merging')));
    expect(stale.querySelector('a')).toBeNull();
    expect(stale.textContent).not.toContain('chatgpt-content-reference');
    const unrecorded = renderedMarkdown(source);
    expect(unrecorded.textContent).toContain('uses the hardware better.');
    expect(unrecorded.textContent).not.toContain('chatgpt-content-reference');
    // A literal example in code stays literal.
    expect(renderedMarkdown('`:chatgpt-content-reference{index="0"}`').querySelector('code')?.textContent).toBe(':chatgpt-content-reference{index="0"}');
  });

  it('draws a recorded reference by its index, and shows ChatGPT’s source card on hover, paging through every source', () => {
    vi.useFakeTimers();
    const source = 'First claim. :chatgpt-content-reference{index="1"}\n\nSecond claim. :chatgpt-content-reference{index="7"}';
    const references = [{ index: 1, sources: [
      { title: 'A report', url: 'https://news.example.com/report', source: 'Example News', date: Date.UTC(2026, 8, 28, 12), snippet: 'A short summary.' },
      { title: 'Project details', url: 'https://scans.example.org/project', source: 'Example Scans' },
      { title: 'A release', url: 'https://www.wire.example.com/release' }
    ] }];
    const rendered = renderedMarkdown(source, undefined, references);
    document.body.append(rendered);
    const pill = rendered.querySelector<HTMLAnchorElement>('a.citation-pill')!;
    expect(pill.textContent).toBe('Example News+2');
    expect(pill.getAttribute('href')).toBe('https://news.example.com/report');
    // An index the reply does not hold proves nothing and is dropped.
    expect(rendered.querySelectorAll('a.citation-pill')).toHaveLength(1);
    expect(rendered.textContent).not.toContain('chatgpt-content-reference');
    const card = rendered.querySelector<HTMLElement>('.citation-card')!;
    expect(card.hidden).toBe(true);
    // It holds buttons and a link, so it is not a tooltip.
    expect(card.hasAttribute('role')).toBe(false);
    pill.parentElement!.dispatchEvent(new window.Event('pointerenter'));
    vi.advanceTimersByTime(200);
    expect(card.hidden).toBe(false);
    const read = () => [card.querySelector('.citation-card-count')?.textContent, card.querySelector('.citation-card-site')?.textContent,
      card.querySelector('a.citation-card-title')?.getAttribute('href'), card.querySelector('.citation-card-detail')?.textContent ?? ''];
    expect(read()).toEqual(['1/3', 'Example News', 'https://news.example.com/report', expect.stringContaining('A short summary.')]);
    const [previous, next] = card.querySelectorAll<HTMLButtonElement>('.citation-card-step');
    // Paging keeps the clicked arrow itself, focused: rebuilding it moved focus away and closed the card.
    next!.focus(); next!.click(); next!.click();
    expect(read()).toEqual(['3/3', 'wire.example.com', 'https://www.wire.example.com/release', '']);
    expect(card.querySelectorAll('.citation-card-step')[1]).toBe(next);
    expect(document.activeElement).toBe(next);
    previous!.click();
    expect(read()[0]).toBe('2/3');
    // Focus leaving for the page while the pointer is on the card (a click on its words) keeps it open.
    next!.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    vi.advanceTimersByTime(50);
    expect(card.hidden).toBe(false);
    pill.parentElement!.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(250);
    expect(card.hidden).toBe(true);
    rendered.remove();
    vi.useRealTimers();
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
    // Only the app's own controls: ChatGPT's Copy and Edit are gone.
    expect([...rendered.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Copy', 'Wrap', 'Save']);
    expect(rendered.querySelector('.markdown-code .tool-output-header strong')?.textContent).toBe('bash');
    expect(rendered.querySelector('.markdown-code .tool-copy')?.textContent).toBe('Copy');
    expect(rendered.textContent).not.toContain('Edit');
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

describe('formulas', () => {
  // The shapes ChatGPT wrote on 2026-10-08: \( \) inline, \[ \] in its own block, escaped prose around it.
  const answer = String.raw`**Fórmula de Bhaskara\:**

\[
x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}
\]

A identidade de Euler é \(e^{i\pi}+1=0\)\.

\[
A=\begin{pmatrix}
a & b\\
c & d
\end{pmatrix}
\]`;

  it('draws inline and block LaTeX as formulas, not as their source', () => {
    const rendered = renderedMarkdown(answer);
    const blocks = rendered.querySelectorAll('.math-display .katex-display');
    expect(blocks).toHaveLength(2);
    expect(rendered.querySelector('.math-inline .katex')).not.toBeNull();
    // What is drawn, not the source KaTeX keeps for screen readers.
    const shown = [...rendered.querySelectorAll('.katex-html')].map(node => node.textContent).join(' ');
    expect(shown).toContain('±');
    expect(shown).not.toContain(String.raw`\frac`);
    expect(rendered.querySelector('.math-inline')!.parentElement!.textContent).not.toContain(String.raw`\(`);
    // A block formula is its own block, not a paragraph holding one.
    expect(rendered.querySelector('p > .math-display')).toBeNull();
    // The prose around it keeps its Markdown.
    expect(rendered.querySelector('strong')!.textContent).toBe('Fórmula de Bhaskara:');
  });

  it('leaves prices, code and LaTeX it cannot draw as written', () => {
    const rendered = renderedMarkdown('Custa $5 e $10.\n\n`' + String.raw`\(x\)` + '` fica no código.\n\n' + String.raw`\(\frac{1}{\)`);
    expect(rendered.querySelector('.katex')).toBeNull();
    expect(rendered.textContent).toContain('$5 e $10');
    expect(rendered.querySelector('code')!.textContent).toBe(String.raw`\(x\)`);
    expect(rendered.querySelector('.math-inline.is-source')!.textContent).toBe(String.raw`\(\frac{1}{\)`);
  });

  it('keeps a formula from adding links, classes or styles of its own', () => {
    const rendered = renderedMarkdown(String.raw`\(\href{javascript:alert(1)}{x} \htmlClass{evil}{y} \htmlStyle{color:red}{z}\)`);
    expect(rendered.querySelector('.katex')).not.toBeNull();
    expect(rendered.querySelector('a, .evil, [style*="color:red"]')).toBeNull();
  });

  it.each([
    ['right after a line of text', "Using:\n\\[\n-\\frac{\\hbar^2}{2m}\\psi\n=\nE\\psi\n\\]\n\nAnd:\n$$\n-\\frac{\\hbar^2}{2m}\\psi\n=\nE\\psi\n$$\n"],
    ['right after a list item\'s text', "1. Using `\\[ ... \\]` syntax\n   \\[\n   -\\frac{\\hbar^2}{2m}\\psi\n   =\n   E\\psi\n   \\]\n2. Using `$$ ... $$` syntax\n   $$\n   -\\frac{\\hbar^2}{2m}\\psi\n   =\n   E\\psi\n   $$\n"],
    ['as recorded from GPT-6, beside the same source in code fences', "The 3D time-independent Schrödinger equation explicitly expands the Laplacian over \\(x,y,z\\).\n\nUsing `\\[ ... \\]`:\n\n```latex\n\\[\n-\\frac{\\hbar^2}{2m}\n\\left(\n\\frac{\\partial^2 \\psi}{\\partial x^2}\n+\n\\frac{\\partial^2 \\psi}{\\partial y^2}\n+\n\\frac{\\partial^2 \\psi}{\\partial z^2}\n\\right)\n+\nV(x,y,z)\\psi(x,y,z)\n=\nE\\psi(x,y,z)\n\\]\n```\n\nRendered:\n\n\\[\n-\\frac{\\hbar^2}{2m}\n\\left(\n\\frac{\\partial^2 \\psi}{\\partial x^2}\n+\n\\frac{\\partial^2 \\psi}{\\partial y^2}\n+\n\\frac{\\partial^2 \\psi}{\\partial z^2}\n\\right)\n+\nV(x,y,z)\\psi(x,y,z)\n=\nE\\psi(x,y,z)\n\\]\n\nUsing `$$ ... $$`:\n\n```latex\n$$\n-\\frac{\\hbar^2}{2m}\n\\left(\n\\frac{\\partial^2 \\psi}{\\partial x^2}\n+\n\\frac{\\partial^2 \\psi}{\\partial y^2}\n+\n\\frac{\\partial^2 \\psi}{\\partial z^2}\n\\right)\n+\nV(x,y,z)\\psi(x,y,z)\n=\nE\\psi(x,y,z)\n$$\n```\n\nRendered:\n\n$$\n-\\frac{\\hbar^2}{2m}\n\\left(\n\\frac{\\partial^2 \\psi}{\\partial x^2}\n+\n\\frac{\\partial^2 \\psi}{\\partial y^2}\n+\n\\frac{\\partial^2 \\psi}{\\partial z^2}\n\\right)\n+\nV(x,y,z)\\psi(x,y,z)\n=\nE\\psi(x,y,z)\n$$"]
  ])('draws a display formula spread over several lines with a lone = line, %s (#1342)', (_case, text) => {
    // A formula opened on the line after prose was read as part of the paragraph, and its bare "="
    // line turned the paragraph into a large heading: the backslash of \[ was lost and nothing drew.
    const rendered = renderedMarkdown(text);
    expect(rendered.querySelectorAll('.math-display .katex-display')).toHaveLength(2);
    expect(rendered.querySelector('h1, h2')).toBeNull();
    const shown = [...rendered.querySelectorAll('.math-display .katex-html')].map(node => node.textContent).join(' ');
    expect(shown).toContain('ℏ');
    expect(shown).not.toContain(String.raw`\frac`);
    // Source in code fences stays source.
    for (const code of rendered.querySelectorAll('pre code')) expect(code.querySelector('.katex')).toBeNull();
  });

  it('separates only an opening display line, never a closing one or one inside a code fence', async () => {
    const { separateDisplayMath } = await import('../src/renderer/math.js');
    expect(separateDisplayMath('A:\n$$\nx\n=\ny\n$$\nB')).toBe('A:\n\n$$\nx\n=\ny\n$$\nB');
    expect(separateDisplayMath('```\ntext\n$$\n```\nC:\n\\[\nz\n\\]')).toBe('```\ntext\n$$\n```\nC:\n\n\\[\nz\n\\]');
    expect(separateDisplayMath('Price $5 and $6.')).toBe('Price $5 and $6.');
  });

  it('draws a GPT-6 answer read from its fallback text: aligned blocks, \\\\[10pt] and inline formulas (#1342)', () => {
    // The reply as the extension hands it over once formulas keep their LaTeX (recorded 2026-10-12).
    const rendered = renderedMarkdown("The Lindhard dielectric function, as discussed in *Solid State Physics* by Ashcroft and Mermin, describes the electronic screening response of a noninteracting electron gas.\n\n\\[\n\\begin{aligned}\n\\varepsilon(\\mathbf{q},\\omega)\n\\\\\n=\n\\\\\n1-\\frac{4\\pi e^2}{q^2}\n\\frac{2}{V}\n\\sum_{\\mathbf{k}}\n\\frac{\nf\\!\\left(\\epsilon_{\\mathbf{k}+\\mathbf{q}}\\right)\n-\nf\\!\\left(\\epsilon_{\\mathbf{k}}\\right)\n}{\n\\epsilon_{\\mathbf{k}+\\mathbf{q}}\n-\n\\epsilon_{\\mathbf{k}}\n-\n\\hbar(\\omega+i0^+)\n}\n\\end{aligned}\n\\]\n\nHere, \\(\\mathbf{q}\\) is the wave vector of the perturbation, with magnitude \\(q=|\\mathbf{q}|\\).\n\n\\[\n\\begin{aligned}\n\\epsilon_{\\mathbf{k}} &= \\frac{\\hbar^2 k^2}{2m}\n\\\\[10pt]\nf(\\epsilon) &= \\frac{1}{e^{(\\epsilon-\\mu)/(k_B T)}+1}\n\\end{aligned}\n\\]\n\n[ok] 2^10 = 1024 a_b *star*");
    expect(rendered.querySelectorAll('.math-display .katex-display')).toHaveLength(2);
    expect(rendered.querySelectorAll('.math-inline .katex')).toHaveLength(2);
    expect(rendered.querySelector('h1, h2, .is-source')).toBeNull();
    // What is drawn, not the source KaTeX keeps for screen readers.
    const shown = [...rendered.querySelectorAll('.katex-html')].map(node => node.textContent).join(' ');
    expect(shown).toContain('ℏ');
    expect(shown).not.toContain(String.raw`\frac`);
    expect(rendered.querySelector('p:last-of-type')!.textContent).toContain('[ok] 2^10 = 1024 a_b');
  });

  it.each([
    ['before', 'The area is \\(\\pi r^2\\).\n\n:::writing{variant="standard" title="Note"}\nArea is \\(\\pi r^2\\) for **any** circle.\n:::'],
    ['after', ':::writing{variant="standard" title="Note"}\nArea is \\(\\pi r^2\\) for **any** circle.\n:::\n\nThe area is \\(\\pi r^2\\).']
  ])('keeps a writing panel and its formulas apart, with a formula %s the panel', async (_order, text) => {
    // Both used to mark their place with the same two characters: the panel's marker drew as a formula.
    const writeClipboard = vi.fn(async () => ({ ok: true, data: true }));
    Object.assign((dom.window as unknown as { api: object }).api, { writeClipboard });
    const rendered = renderedMarkdown(text);
    const panel = rendered.querySelector('.markdown-writing')!;
    expect(panel.querySelector('.tool-output-header strong')?.textContent).toBe('Note');
    expect(rendered.querySelectorAll('.math-inline .katex')).toHaveLength(2);
    expect(panel.querySelectorAll('.math-inline .katex')).toHaveLength(1);
    expect(rendered.textContent).not.toMatch(/[-]/);
    panel.querySelector<HTMLButtonElement>('.tool-copy')!.click();
    await vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('Area is \\(\\pi r^2\\) for **any** circle.'));
  });

  it('shows the name of a person or place ChatGPT links, instead of dropping it', () => {
    const rendered = renderedMarkdown('No \uE200entity\uE202["place","Antigo Egito"]\uE201, \uE200entity\uE202["people","René \\"Descartes\\"","filósofo"]\uE201 estudou.');
    expect(JSON.stringify(rendered.textContent!.trim())).toBe(JSON.stringify('No Antigo Egito, René "Descartes" estudou.'));
  });
});

/** A revision on screen keeps every leading block equal to the one drawn again (the timeline's streaming). */
describe('an answer drawn again', () => {
  const report = (snippet: string) => [{ index: 1, sources: [{ title: 'A report', url: 'https://news.example.com/report', source: 'Example News', snippet }] }];

  it('renders the same markdown twice as equal blocks', () => {
    const sources = [String.raw`Inline \(x^2\) with a source. :chatgpt-content-reference{index="1"}` +
      '\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n' + String.raw`\[
y=mx+b
\]`, ':::writing{title="Note"}\nDear team\n:::'];
    const drawn = sources.map(source => [renderedMarkdown(source, undefined, report('A')), renderedMarkdown(source, undefined, report('A'))]);
    for (const part of ['.math-inline .katex', '.math-display .katex', '.citation', '.markdown-code', '.markdown-table', '.markdown-writing']) {
      expect(drawn.some(([first]) => first!.querySelector(part)), part).toBe(true);
    }
    for (const [first, second] of drawn) {
      expect(first!.childNodes).toHaveLength(second!.childNodes.length);
      expect([...first!.childNodes].every((node, index) => node.isEqualNode(second!.childNodes[index]!))).toBe(true);
    }
  });

  it('tells apart citation pills that look the same but hold different sources', () => {
    const source = 'A claim. :chatgpt-content-reference{index="1"}';
    const [first, second] = [renderedMarkdown(source, undefined, report('First')), renderedMarkdown(source, undefined, report('Second'))];
    expect(first.querySelector('a.citation-pill')!.isEqualNode(second.querySelector('a.citation-pill'))).toBe(true);
    expect(first.querySelector('.citation')!.isEqualNode(second.querySelector('.citation'))).toBe(false);
  });

  it('cuts an answer being written after its last finished block', () => {
    expect(finishedBlocks('Alpha.\r\n\r\nBeta')).toBe('Alpha.\r\n\r\n');
    expect(finishedBlocks('Alpha.\n\n')).toBe('Alpha.\n\n');
    expect(finishedBlocks('Alpha.')).toBe('');
    // A fence closes only on its own character, at least as long; a writing block or formula on its end.
    expect(finishedBlocks('```\na\n\n~~~\nb\n```\nAfter')).toBe('```\na\n\n~~~\nb\n```\n');
    expect(finishedBlocks('Intro.\n\n:::writing{title="Note"}\nDear team,\n\nThanks\n')).toBe('Intro.\n\n');
    expect(finishedBlocks(':::writing\nDear team,\n\nThanks\n:::\nAfter')).toBe(':::writing\nDear team,\n\nThanks\n:::\n');
    expect(finishedBlocks('$$\na\n\nb\n$$\n\nAfter')).toBe('$$\na\n\nb\n$$\n\n');
  });

  it('holds a list back until a finished line ends it, so it never turns loose on screen', () => {
    // A blank line between items makes the whole list loose once the next item arrives.
    expect(finishedBlocks('Intro.\n\n- a\n- b\n\n- c')).toBe('Intro.\n\n');
    expect(finishedBlocks('Intro.\n\n- a\n- b\n\n- c\n\n1')).toBe('Intro.\n\n');
    expect(finishedBlocks('Intro.\n\n- a\n- b\n\n- c\n\nAfter.\n')).toBe('Intro.\n\n- a\n- b\n\n- c\n\n');
    // An indented line after a blank one continues the item.
    expect(finishedBlocks('1. a\n\n   more')).toBe('');
    expect(finishedBlocks('1. a\n\n   more\n\n2) b\n\nNext.\n\nEn')).toBe('1. a\n\n   more\n\n2) b\n\nNext.\n\n');
    // A fence inside an item, at any indent, neither cuts the item nor ends the list when it closes.
    expect(finishedBlocks('- a\n    ```\n    x\n\n    y')).toBe('');
    expect(finishedBlocks('- a\n    ```\n    x\n\n    y\n    ```\n\nAfter.\n')).toBe('- a\n    ```\n    x\n\n    y\n    ```\n\n');
    expect(finishedBlocks('- a\n  ```\n  x\n  ```\n- b')).toBe('');
  });

  it('ends a list as soon as the line being written cannot continue it', () => {
    expect(finishedBlocks('- a\n\n- b\n\nThe next')).toBe('- a\n\n- b\n\n');
    expect(finishedBlocks('- a\n\n- b\n\n# Next')).toBe('- a\n\n- b\n\n');
    // A digit, a marker or an indent may still become an item.
    expect(finishedBlocks('- a\n\n- b\n\n2')).toBe('');
    expect(finishedBlocks('- a\n\n- b\n\n-')).toBe('');
    expect(finishedBlocks('- a\n\n- b\n\n  mo')).toBe('');
    expect(finishedBlocks('- a\n\n- b\n')).toBe('');
  });

  it('opens a list or a display formula only where Markdown would', () => {
    // Indented four spaces after a paragraph's line, "- option" continues the paragraph.
    expect(finishedBlocks('Para\n    - option\n\n  Next.\n')).toBe('Para\n    - option\n\n');
    // A display formula opens at the start of its line, as the math tokenizer reads it; in a list, inside its item.
    expect(finishedBlocks('Alpha.\n\n  $$ x\n\nNext.\n')).toBe('Alpha.\n\n  $$ x\n\n');
    expect(finishedBlocks('- a\n\n  $$\n  x\n\n  y\n  $$\n\nNext.\n')).toBe('- a\n\n  $$\n  x\n\n  y\n  $$\n\n');
    expect(finishedBlocks('- a\n\n  $$\n  x\n\n  y')).toBe('');
  });

  it('finishes a display formula on its closing line, as it does a fence', () => {
    expect(finishedBlocks('Intro.\n\n$$\nx\n$$\nThen prose')).toBe('Intro.\n\n$$\nx\n$$\n');
    expect(finishedBlocks('Intro.\n\n\\[\nx\n\\]\nThen prose')).toBe('Intro.\n\n\\[\nx\n\\]\n');
    // Inside a list the list still decides.
    expect(finishedBlocks('- a\n\n  $$\n  x\n  $$\n  Then')).toBe('');
  });

  it('holds an indented code block back until a line after it is not indented', () => {
    expect(finishedBlocks('Alpha.\n\n    one\n\n    two')).toBe('Alpha.\n\n');
    expect(finishedBlocks('Alpha.\n\n    one\n\n    two\n\n  ')).toBe('Alpha.\n\n');
    expect(finishedBlocks('Alpha.\n\n    one\n\n    two\n\nNext')).toBe('Alpha.\n\n    one\n\n    two\n\n');
    expect(finishedBlocks('\tone\n\n\ttwo\n\nNext.\n')).toBe('\tone\n\n\ttwo\n\n');
    // An item's indented line is the item's, not code.
    expect(finishedBlocks('- a\n\n    more\n\nNext.\n')).toBe('- a\n\n    more\n\n');
  });

  it('opens a writing block only on the line ChatGPT opens one with', () => {
    expect(finishedBlocks(':::writing example\n\nNext.\n\nMo')).toBe(':::writing example\n\nNext.\n\n');
    expect(finishedBlocks(':::writing{title="Note"} \nDear team,\n\nThanks')).toBe('');
  });

  it('reads triple backticks inside a line as inline code, not as a fence', () => {
    expect(finishedBlocks('```code``` is odd.\n\nNext para.')).toBe('```code``` is odd.\n\n');
    expect(finishedBlocks('~~~ a`b\nx\n\ny')).toBe('');
  });

  it('tells apart writing panels that read the same but copy different Markdown', () => {
    const [first, second] = ['*a*', '_a_'].map(text => renderedMarkdown(`:::writing\n${text}\n:::`));
    expect(first!.querySelector('blockquote')!.isEqualNode(second!.querySelector('blockquote'))).toBe(true);
    expect(first!.querySelector('.markdown-writing')!.isEqualNode(second!.querySelector('.markdown-writing'))).toBe(false);
  });
});
