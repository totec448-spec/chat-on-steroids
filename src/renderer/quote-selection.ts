import { el, icon, toast } from './dom.js';
import { t } from './i18n.js';
import { draftWithTerminalBlock, limitedSelection } from './terminal-selection.js';

/**
 * Quote a selection into the composer: select words in a message of the open chat and a Quote
 * button appears under them. It adds them to the draft as a Markdown quote, after what is already
 * typed, and leaves the caret below it for the question. Nothing is sent.
 */

/** Elements that start a line of their own; the paragraph-like ones are set apart by an empty line. */
const BLOCK = 'p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, tr, dt, dd, div';
const PARAGRAPH = new Set(['P', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
/** The app's own controls among the words, such as a code or writing panel's name and Copy button. */
const CONTROLS = '.tool-output-header, button';

/**
 * The words of `range` as the message shows them: a line per paragraph, list item and row, code
 * and plain messages with their own line breaks, a formula as its TeX, and without the panels'
 * controls or anything hidden. The selection's own text would carry "Code Copy" into the quote.
 */
export function selectedText(range: Range): string {
  const root = range.commonAncestorContainer;
  // Text, and the <br> elements that break its lines.
  const walker = document.createTreeWalker(root.nodeType === 3 ? root.parentNode ?? root : root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    { acceptNode: node => node.nodeType === 3 || (node as Element).tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
  const shown = new Map<Element, { visible: boolean; verbatim: boolean }>();
  const look = (element: Element) => {
    let seen = shown.get(element);
    if (!seen) {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
      seen = {
        visible: !element.closest(CONTROLS) && (typeof element.checkVisibility !== 'function' || element.checkVisibility()),
        verbatim: !!element.closest('pre') || /^pre/.test(style?.whiteSpace ?? '')
      };
      shown.set(element, seen);
    }
    return seen;
  };
  let text = '';
  let block: Element | null | undefined;
  let cell: Element | null = null;
  let formula: Element | null = null;
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    if (!range.intersectsNode(next)) continue;
    if (next.nodeType !== 3) {
      if (text && look(next as Element).visible) text = `${text.trimEnd()}
`;
      continue;
    }
    const node = next as Text;
    const parent = node.parentElement;
    if (!parent) continue;
    const math = parent.closest('.katex');
    const { visible, verbatim } = look(math ?? parent);
    if (!visible) continue;
    const data = node.data.slice(node === range.startContainer ? range.startOffset : 0, node === range.endContainer ? range.endOffset : undefined);
    // The range only touches this node's edge, as a triple-click ending at offset 0 of the next paragraph does: none of it is selected.
    if (!data && node.data) continue;
    if (!verbatim && !math && !data.trim()) { if (text && !/\s$/.test(text)) text += ' '; continue; }
    const owner = parent.closest(BLOCK);
    if (block !== undefined && owner !== block) {
      text = text.trimEnd() + (PARAGRAPH.has(owner?.tagName ?? '') || PARAGRAPH.has(block?.tagName ?? '') ? '\n\n' : '\n');
    } else if (cell && parent.closest('td, th') !== cell) text = `${text.trimEnd()} | `;
    block = owner;
    cell = parent.closest('td, th');
    const lineStart = !text || text.endsWith('\n');
    if (math) {
      // KaTeX draws a formula twice, for the eye and for screen readers; its TeX says it once.
      const fence = math.closest('.katex-display') ? '$$' : '$';
      if (math !== formula) text += `${fence}${math.querySelector('annotation')?.textContent?.trim() ?? ''}${fence}`;
      formula = math;
    } else if (verbatim) text += data;
    else text += lineStart ? data.replace(/\s+/g, ' ').trimStart() : data.replace(/\s+/g, ' ');
  }
  return text;
}

/**
 * The selected words as a Markdown quote: every line marked, blank lines at the ends dropped. A
 * selection over the terminal block's caps keeps its last lines, with the same line above it that
 * says how much is left out.
 */
export function markdownQuote(selected: string): string {
  const lines: string[] = [];
  for (const line of selected.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').split('\n').map(line => line.trimEnd())) {
    // One blank line keeps two paragraphs apart; a run of them says nothing more.
    if (line || (lines.length && lines[lines.length - 1])) lines.push(line);
  }
  const limited = limitedSelection(lines.join('\n'));
  if (!limited) return '';
  const quote = limited.text.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
  return limited.note ? `${limited.note}\n\n${quote}` : quote;
}

/** The draft with the quote after what is typed and an empty line under it: the terminal block's own insert. */
export const draftWithQuote = draftWithTerminalBlock;

export interface QuoteSelectionDeps {
  /** The open chat's timeline: only words in its messages are offered. */
  timeline: HTMLElement;
  /** The composer the quote goes into. */
  input: HTMLTextAreaElement;
  /** True while Send would submit something other than the composer text, such as a prepared plan: the quote would sit there unsent. */
  blocked?: () => boolean;
}

export interface QuoteSelection {
  /** Forget the quote, hide the button and drop a selection in the timeline: the chat or view it was taken in is gone. */
  reset(): void;
}

export function initQuoteSelection({ timeline, input, blocked }: QuoteSelectionDeps): QuoteSelection {
  const button = el('button', 'quote-selection') as HTMLButtonElement;
  button.type = 'button';
  button.hidden = true;
  button.append(icon('i-quote'), el('span', '', () => t('Quote')));
  document.body.append(button);
  // The quote of the current selection, read again only when the selection changes.
  let quote = '';
  let stale = true;
  let pressed = false;
  let frame = 0;

  const hide = (): void => { button.hidden = true; quote = ''; stale = true; };
  /** The message text a selection end is in, never its labels, receipts or the rows between messages. */
  const messageOf = (node: Node | null): Element | null => {
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement ?? null;
    const message = element?.closest('.said .msg') ?? null;
    return message && timeline.contains(message) && !element!.closest('button, input, textarea') ? message : null;
  };
  const update = (): void => {
    frame = 0;
    const selection = document.getSelection();
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || pressed || input.closest('[hidden]') || !messageOf(selection!.anchorNode) || messageOf(selection!.anchorNode) !== messageOf(selection!.focusNode)) { hide(); return; }
    if (stale) { quote = markdownQuote(selectedText(range)); stale = false; }
    // The button sits under the selection's last line, while that line is in view.
    const end = quote && typeof range.getClientRects === 'function' ? [...range.getClientRects()].filter(rect => rect.width || rect.height).at(-1) : undefined;
    if (!end) { hide(); return; }
    const view = (timeline.closest('.scroll') ?? timeline).getBoundingClientRect();
    if (end.bottom < view.top || end.top > view.bottom) { hide(); return; }
    button.hidden = false;
    const width = button.offsetWidth, height = button.offsetHeight;
    const below = end.bottom + 6;
    const top = below + height <= view.bottom ? below : Math.max(view.top, end.top - height - 6);
    const left = Math.max(view.left + 4, Math.min(end.right - width / 2, view.right - width - 4));
    button.style.top = `${Math.round(top)}px`;
    button.style.left = `${Math.round(left)}px`;
  };
  const schedule = (): void => { if (!frame) frame = window.requestAnimationFrame(update); };
  const reread = (): void => { stale = true; schedule(); };

  document.addEventListener('selectionchange', reread);
  // A new press starts a new selection: the button waits until the pointer is up again.
  document.addEventListener('pointerdown', event => {
    if (button.contains(event.target as Node)) return;
    pressed = true;
    hide();
  }, true);
  const release = (): void => { pressed = false; reread(); };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  // Pressing the button must not take the selection away before the click reads it.
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    // Read the selection again: the chat or view it was taken in may be gone.
    stale = true;
    update();
    if (button.hidden || !quote) return;
    if (blocked?.()) { toast(t('Start or cancel the prepared plan first, then quote again.')); return; }
    input.value = draftWithQuote(input.value, quote);
    document.getSelection()?.removeAllRanges();
    hide();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return {
    reset() {
      // A pointerup just before the switch may have scheduled an update: it must not offer the old chat's words again.
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      hide();
      const selection = document.getSelection();
      if (selection?.anchorNode && timeline.contains(selection.anchorNode)) selection.removeAllRanges();
    }
  };
}
