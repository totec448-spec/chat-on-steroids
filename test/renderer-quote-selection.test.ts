import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<main><div class="scroll" id="chatBody"><div id="timeline">' +
    '<div class="said"><b>ChatGPT</b><div class="msg rich"><p>The loader reads <code>config.port</code> first.</p><p>Then it checks the file.</p></div></div>' +
    '<p class="meta" id="note">Worked for 2m</p>' +
    '<div class="said is-user"><p class="msg user-message-text">Thanks</p><span class="message-edited">Edited version</span></div></div></div>' +
    '<form id="composer"><textarea id="chatInput"></textarea></form></main>', { url: 'https://local.test/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'Event'] as const) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  // jsdom lays nothing out: every selected line is one 20px row inside a 600px view.
  dom.window.Range.prototype.getClientRects = () => [{ top: 100, bottom: 120, left: 40, right: 300, width: 260, height: 20 }] as unknown as DOMRectList;
  dom.window.Element.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 }) as DOMRect;
});
afterEach(() => { vi.unstubAllGlobals(); dom.window.close(); });

const select = (start: Node, startOffset: number, end: Node, endOffset: number): void => {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  document.dispatchEvent(new dom.window.Event('selectionchange'));
};
const button = () => document.querySelector<HTMLButtonElement>('.quote-selection')!;
const frame = () => new Promise(resolve => dom.window.requestAnimationFrame(resolve));

it('marks every selected line as a quote and leaves a line under it to write on', async () => {
  const { draftWithQuote, markdownQuote } = await import('../src/renderer/quote-selection.js');
  expect(markdownQuote('\n\nfirst line  \r\nsecond\u00a0line\n\n\n\nnext paragraph\n\n')).toBe('> first line\n> second line\n>\n> next paragraph');
  expect(markdownQuote('   \n\n')).toBe('');
  expect(draftWithQuote('', '> a')).toBe('> a\n\n');
  expect(draftWithQuote('Why?  ', '> a')).toBe('Why?  \n\n> a\n\n');
  expect(draftWithQuote('Why?  \n \n', '> a')).toBe('Why?  \n\n> a\n\n');
  expect(draftWithQuote(' \n ', '> a')).toBe('> a\n\n');
  expect(draftWithQuote('Why is that?\n\n\n', '> a')).toBe('Why is that?\n\n> a\n\n');
});

it('holds a long quote to the terminal selection caps and inserts it the way that block is inserted', async () => {
  const { draftWithQuote, markdownQuote } = await import('../src/renderer/quote-selection.js');
  const { draftWithTerminalBlock, MAX_TERMINAL_LINES } = await import('../src/renderer/terminal-selection.js');
  const lines = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}`);
  const quote = markdownQuote(lines.join('\n'));
  const [note, body] = quote.split('\n\n');
  expect(note).toBe(`Only the end of the selection is here: the last ${MAX_TERMINAL_LINES} of 1,000 lines.`);
  expect(body!.split('\n')).toHaveLength(MAX_TERMINAL_LINES);
  expect(body!.startsWith('> line 601\n')).toBe(true);
  expect(body!.endsWith('> line 1000')).toBe(true);
  // A short quote carries no note.
  expect(markdownQuote('one\ntwo')).toBe('> one\n> two');
  expect(draftWithQuote('Why?', quote)).toBe(draftWithTerminalBlock('Why?', quote));
});

it('reads the selected words as the message shows them, without the code panel controls', async () => {
  // Chromium's own selection text carried a code panel's "Code" and "Copy" into the quote, and a
  // formula twice: once drawn, once for screen readers.
  const { selectedText } = await import('../src/renderer/quote-selection.js');
  const box = document.createElement('div');
  box.className = 'said';
  box.innerHTML = '<div class="msg rich"><p>Before   the\ncode.</p>\n<div class="markdown-code"><div class="tool-output-header"><strong>Code</strong><button>Copy</button></div>' +
    '<pre><code>const a = 1;\n  return a;\n</code></pre></div>\n<ul>\n<li>one <strong>item</strong></li>\n<li>two</li>\n</ul>\n' +
    '<table><tr><td>name</td><td>size</td></tr><tr><td>a.txt</td><td>2 KB</td></tr></table>' +
    '<p>Area <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>r</mi></mrow><annotation encoding="application/x-tex">\\pi r^2</annotation></semantics></math></span>' +
    '<span class="katex-html" aria-hidden="true">πr2</span></span> it is.</p></div>';
  document.getElementById('timeline')!.append(box);
  const [first, last] = [box.querySelector('p')!.firstChild!, box.querySelectorAll('p')[1]!.lastChild!];
  const range = document.createRange();
  range.setStart(first, 9);
  range.setEnd(last, 3);
  expect(selectedText(range)).toBe('the code.\n\nconst a = 1;\n  return a;\n\none item\ntwo\nname | size\na.txt | 2 KB\n\nArea $\\pi r^2$ it');

  const typed = document.createElement('p');
  typed.className = 'msg user-message-text';
  typed.style.whiteSpace = 'pre-wrap';
  typed.textContent = 'first line\n  indented line';
  document.getElementById('timeline')!.append(typed);
  range.selectNodeContents(typed);
  expect(selectedText(range)).toBe('first line\n  indented line');
});

it('keeps a line break the message draws with <br>', async () => {
  const { selectedText } = await import('../src/renderer/quote-selection.js');
  const box = document.createElement('div');
  box.className = 'said';
  box.innerHTML = '<div class="msg rich"><p>Roses are red,<br>violets are blue,<br><strong>sugar</strong> is sweet</p></div>';
  document.getElementById('timeline')!.append(box);
  const range = document.createRange();
  range.selectNodeContents(box.querySelector('p')!);
  expect(selectedText(range)).toBe('Roses are red,\nviolets are blue,\nsugar is sweet');
});

it('leaves out a formula the range only touches the start of, as a triple-click ends on the next paragraph', async () => {
  const { selectedText } = await import('../src/renderer/quote-selection.js');
  const box = document.createElement('div');
  box.className = 'said';
  box.innerHTML = '<div class="msg rich"><p>First paragraph.</p><p><span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math></span>' +
    '<span class="katex-html" aria-hidden="true">x</span></span> comes next.</p></div>';
  document.getElementById('timeline')!.append(box);
  const [first, second] = box.querySelectorAll('p');
  // Chromium ends a triple-click at offset 0 of the next paragraph's first text node.
  const range = document.createRange();
  range.setStart(first!.firstChild!, 0);
  range.setEnd(second!.querySelector('mi')!.firstChild!, 0);
  expect(selectedText(range)).toBe('First paragraph.');
  // A selection that really reaches into the formula still quotes it.
  range.setEnd(second!.lastChild!, 5);
  expect(selectedText(range)).toBe('First paragraph.\n\n$x$ come');
});

it('quotes the words selected in an answer into the composer, after what is typed, without sending', async () => {
  const { initQuoteSelection } = await import('../src/renderer/quote-selection.js');
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Look at this:';
  const typed = vi.fn();
  input.addEventListener('input', typed);
  const submitted = vi.fn();
  document.getElementById('composer')!.addEventListener('submit', submitted);
  initQuoteSelection({ timeline: document.getElementById('timeline')!, input });
  expect(button().hidden).toBe(true);

  const [first, second] = document.querySelectorAll('.msg p');
  select(first!.firstChild!, 4, second!.firstChild!, 8);
  await frame();
  expect(button().hidden).toBe(false);
  expect(button().textContent).toBe('Quote');
  expect(button().style.top).toBe('126px');

  button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  expect(input.value).toBe('Look at this:\n\n> loader reads config.port first.\n>\n> Then it\n\n');
  expect(input.selectionStart).toBe(input.value.length);
  expect(document.activeElement).toBe(input);
  expect(typed).toHaveBeenCalledTimes(1);
  expect(submitted).not.toHaveBeenCalled();
  expect(document.getSelection()!.isCollapsed).toBe(true);
  expect(button().hidden).toBe(true);
});

it('offers nothing outside a message or while the selection is still being dragged', async () => {
  const { initQuoteSelection } = await import('../src/renderer/quote-selection.js');
  initQuoteSelection({ timeline: document.getElementById('timeline')!, input: document.getElementById('chatInput') as HTMLTextAreaElement });
  const note = document.getElementById('note')!.firstChild!;
  select(note, 0, note, 6);
  await frame();
  expect(button().hidden).toBe(true);

  // A selection from one message into the next carries the status rows between them; a label
  // inside a message's row is not its text.
  const words = document.querySelector('.msg p')!.firstChild!;
  const thanks = document.querySelector('.user-message-text')!.firstChild!;
  select(words, 0, thanks, 3);
  await frame();
  expect(button().hidden).toBe(true);
  const edited = document.querySelector('.message-edited')!.firstChild!;
  select(edited, 0, edited, 6);
  await frame();
  expect(button().hidden).toBe(true);
  select(thanks, 0, thanks, 6);
  await frame();
  expect(button().hidden).toBe(false);

  document.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  select(words, 0, words, 10);
  await frame();
  expect(button().hidden).toBe(true);
  document.dispatchEvent(new dom.window.Event('pointerup', { bubbles: true }));
  await frame();
  expect(button().hidden).toBe(false);
});

it('forgets the quote when the chat or view it was taken in goes away', async () => {
  const { initQuoteSelection } = await import('../src/renderer/quote-selection.js');
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Look at this:';
  const quote = initQuoteSelection({ timeline: document.getElementById('timeline')!, input });
  const words = document.querySelector('.msg p')!.firstChild!;
  select(words, 4, words, 10);
  await frame();
  expect(button().hidden).toBe(false);

  // Settings hides the composer; the button of the cached quote is still clickable.
  document.getElementById('composer')!.hidden = true;
  button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  expect(input.value).toBe('Look at this:');
  expect(button().hidden).toBe(true);

  // Switching chat or starting a new one resets it, whatever the selection still says.
  document.getElementById('composer')!.hidden = false;
  select(words, 4, words, 10);
  await frame();
  expect(button().hidden).toBe(false);
  quote.reset();
  expect(button().hidden).toBe(true);
  await frame();
  // A new selection quotes again, from a fresh read.
  select(words, 0, words, 3);
  await frame();
  button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  expect(input.value).toBe('Look at this:\n\n> The\n\n');
});

it('does not offer the old words when a pointerup just before the chat switch scheduled the update', async () => {
  const { initQuoteSelection } = await import('../src/renderer/quote-selection.js');
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'New chat draft';
  const quote = initQuoteSelection({ timeline: document.getElementById('timeline')!, input });
  const words = document.querySelector('.msg p')!.firstChild!;
  select(words, 4, words, 10);
  // The sidebar click's pointerup schedules the update, then the chat switch resets before it runs.
  document.dispatchEvent(new dom.window.Event('pointerup', { bubbles: true }));
  quote.reset();
  await frame();
  await frame();
  expect(button().hidden).toBe(true);
  button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  expect(input.value).toBe('New chat draft');
});

it('leaves the composer alone and says to start or cancel the plan first while a prepared plan waits', async () => {
  // Send submits the prepared plan, so a quote dropped into the composer would never be sent.
  const { initQuoteSelection } = await import('../src/renderer/quote-selection.js');
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Look at this:';
  const typed = vi.fn();
  input.addEventListener('input', typed);
  let plan = true;
  initQuoteSelection({ timeline: document.getElementById('timeline')!, input, blocked: () => plan });
  const words = document.querySelector('.msg p')!.firstChild!;
  select(words, 4, words, 10);
  await frame();
  expect(button().hidden).toBe(false);

  button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  expect(input.value).toBe('Look at this:');
  expect(typed).not.toHaveBeenCalled();
  expect(document.querySelector('.toast')?.textContent).toBe('Start or cancel the prepared plan first, then quote again.');

  // With the plan started or cancelled, the same button quotes.
  plan = false;
  document.querySelector('.toast')?.remove();
  button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  expect(input.value).toBe('Look at this:\n\n> loader\n\n');
  expect(document.querySelector('.toast')).toBeNull();
});
