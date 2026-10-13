import { $ } from './dom.js';
import { t, ui } from './i18n.js';
import { isMac } from './shortcuts.js';
import type { SessionSearchLocation } from '../shared/session.js';

/**
 * Find in chat, as in Codex: ⌘F (Ctrl+F elsewhere) opens a bar above the open chat. Matches come
 * from the chat's whole recording (`sessions:find`), so a passage far above the loaded page is
 * found too; stepping to one loads the page around it. The newest match comes first, Enter goes
 * on to the next newer one, Shift+Enter back, Escape closes. Matches in the loaded rows are
 * marked with the CSS Custom Highlight API, which leaves the messages' own markup untouched.
 */

export interface ChatFindDeps {
  /** The open chat, or null in New Chat and other screens. */
  selectedId(): string | null;
  find(id: string, query: string): Promise<SessionSearchLocation[] | null>;
  /** Scrolls to the message, loading the history page around it when needed. */
  reveal(id: string, location: SessionSearchLocation): Promise<void>;
}

const ALL = 'chat-find';
const CURRENT = 'chat-find-current';

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function' ? css.highlights : null;
}

/** The timeline row of one message, by the key the timeline gives it. */
function rowOf(location: SessionSearchLocation): HTMLElement | null {
  const key = location.messageId !== null ? `message:${location.kind} ${location.messageId}` : null;
  if (!key) return null;
  return [...$('timeline').querySelectorAll<HTMLElement>('[data-timeline-key]')].find(row => row.dataset.timelineKey === key) ?? null;
}

/** Every occurrence of `phrase` inside the message text of `root`, ignoring case. */
function rangesIn(root: ParentNode, phrase: string): Range[] {
  const ranges: Range[] = [];
  for (const said of root.querySelectorAll('.said')) {
    const walker = document.createTreeWalker(said, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue ?? '').toLocaleLowerCase();
      for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + phrase.length)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + phrase.length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

export function initChatFind(deps: ChatFindDeps): { selectionChanged(): void } {
  const bar = $('chatFind');
  const field = $<HTMLInputElement>('chatFindField');
  const count = $('chatFindCount');
  let matches: SessionSearchLocation[] = [];
  let index = -1;
  let searchedFor: { id: string; query: string } | null = null;
  let generation = 0;
  let typing = 0;
  let frame = 0;

  const phrase = (): string => field.value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const paintCount = (): void => {
    ui(count, 'textContent', () => !searchedFor ? '' : matches.length ? t('{0} of {1}', [index + 1, matches.length]) : t('No matches'));
    for (const id of ['chatFindPrev', 'chatFindNext']) $<HTMLButtonElement>(id).disabled = matches.length < 2;
  };
  const highlight = (): void => {
    const highlights = registry();
    if (!highlights) return;
    const wanted = phrase();
    if (bar.hidden || !wanted) { highlights.delete(ALL); highlights.delete(CURRENT); return; }
    const Highlight = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
    const current = index >= 0 && matches[index] ? rowOf(matches[index]!) : null;
    highlights.set(ALL, new Highlight(...rangesIn($('timeline'), wanted)));
    highlights.set(CURRENT, new Highlight(...(current ? rangesIn(current, wanted) : [])));
  };
  // Live answers and paging replace rows; the marks follow the text that is on screen.
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (frame || bar.hidden) return;
    frame = window.requestAnimationFrame(() => { frame = 0; highlight(); });
  }) : null;

  const go = async (): Promise<void> => {
    const id = searchedFor?.id;
    const location = matches[index];
    paintCount();
    if (!id || !location) { highlight(); return; }
    const run = generation;
    await deps.reveal(id, location);
    if (run === generation) highlight();
  };
  const search = async (): Promise<void> => {
    const id = deps.selectedId();
    const query = field.value.replace(/\s+/g, ' ').trim();
    const run = ++generation;
    if (!id || !query) { matches = []; index = -1; searchedFor = null; paintCount(); highlight(); return; }
    const found = await deps.find(id, query);
    if (run !== generation || bar.hidden) return;
    matches = found ?? [];
    index = matches.length - 1;
    searchedFor = { id, query };
    await go();
  };
  const step = (by: number): void => {
    if (!matches.length) return;
    index = (index + by + matches.length) % matches.length;
    void go();
  };
  const open = (): void => {
    bar.hidden = false;
    field.focus();
    field.select();
    observer?.observe($('timeline'), { childList: true, subtree: true, characterData: true });
    if (field.value.trim()) void search();
  };
  const close = (): void => {
    if (bar.hidden) return;
    bar.hidden = true;
    generation++;
    window.clearTimeout(typing);
    observer?.disconnect();
    matches = []; index = -1; searchedFor = null;
    paintCount();
    highlight();
  };

  field.addEventListener('input', () => {
    window.clearTimeout(typing);
    typing = window.setTimeout(() => void search(), 200);
  });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    // A changed query is searched first; Enter then means "go there".
    const query = field.value.replace(/\s+/g, ' ').trim();
    if (searchedFor?.query !== query || searchedFor.id !== deps.selectedId()) { window.clearTimeout(typing); void search(); return; }
    step(event.shiftKey ? -1 : 1);
  });
  $('chatFindPrev').addEventListener('click', () => step(-1));
  $('chatFindNext').addEventListener('click', () => step(1));
  $('chatFindClose').addEventListener('click', close);
  // ⌘F on macOS, Ctrl+F elsewhere, while a chat is open. Settings has its own ⌘F; the terminal keeps its keys.
  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'f' || event.shiftKey || event.altKey || event.repeat) return;
    if (isMac() ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    if ((event.target as Element | null)?.closest?.('.xterm')) return;
    if (document.querySelector<HTMLElement>('.app')?.dataset.screen !== 'chat' || !deps.selectedId()) return;
    event.preventDefault();
    open();
  });
  paintCount();
  return { selectionChanged: close };
}
