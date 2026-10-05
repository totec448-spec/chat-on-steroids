/**
 * Searching chats from the sidebar (#1107): by title, and by what was said in them.
 *
 * The main process owns the search (session/search.ts) because the sidebar holds only the newest
 * page of chats. While typing, the Projects and Chats lists step aside for the results; clearing the
 * field (× or Escape) brings them back. Until every chat's words are indexed, the results say so
 * and fill in as indexing goes on.
 */
import type { SessionSearchReply } from '../shared/session.js';
import { $, el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';

const api = window.api;
const TYPING_PAUSE_MS = 150;
const INDEXING_RECHECK_MS = 700;
const REFRESH_MS = 3000;

export interface ChatSearch {
  /** Chats changed: an open search runs again, so new words and titles are found. */
  refresh(): void;
  /** The search field holds a query and its results are shown. */
  readonly active: boolean;
}

export function initChatSearch(options: { select(id: string): void; selectedId(): string | null }): ChatSearch {
  const field = $<HTMLInputElement>('chatSearch');
  const clear = $<HTMLButtonElement>('chatSearchClear');
  const results = $('searchResults');
  const lists = $('sessionList');
  let generation = 0;
  let typingTimer = 0;
  let recheckTimer = 0;
  let last: SessionSearchReply | null = null;
  let searchedAt = 0;

  const query = (): string => field.value.trim();

  const show = (searching: boolean): void => {
    results.hidden = !searching;
    lists.hidden = searching;
    clear.hidden = !field.value;
  };

  /** `text` in a node of its own, with the given ranges marked. */
  const marked = (tag: 'b' | 'span', className: string, text: string, matches: Array<[number, number]> = []): HTMLElement => {
    const node = el(tag, className);
    node.dir = 'auto';
    let at = 0;
    for (const [start, end] of matches) {
      if (start < at) continue;
      if (start > at) node.append(text.slice(at, start));
      node.append(el('mark', '', text.slice(start, end)));
      at = end;
    }
    if (at < text.length) node.append(text.slice(at));
    return node;
  };

  const paint = (): void => {
    const reply = last;
    results.replaceChildren();
    if (!reply || !query()) return;
    const list = el('div', 'search-list');
    list.setAttribute('role', 'list');
    for (const result of reply.results) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `search-result${result.id === options.selectedId() ? ' is-sel' : ''}`;
      row.dataset.searchId = result.id;
      row.setAttribute('role', 'listitem');
      row.append(result.title ? marked('b', '', result.title, result.titleMatches) : marked('b', '', t("Untitled session")));
      if (result.snippet) row.append(marked('span', 'search-snippet', result.snippet.text, result.snippet.matches));
      row.addEventListener('click', () => {
        for (const other of results.querySelectorAll('.search-result.is-sel')) other.classList.remove('is-sel');
        row.classList.add('is-sel');
        options.select(result.id);
      });
      list.append(row);
    }
    results.append(list);
    if (reply.indexed < reply.total) {
      results.append(el('p', 'search-status', () => t("Searching message text… {0} of {1} chats", [reply.indexed, reply.total])));
    } else if (!reply.results.length) {
      results.append(el('p', 'empty search-status', () => t("No chats match")));
    }
  };

  const search = async (): Promise<void> => {
    window.clearTimeout(recheckTimer);
    const text = query();
    const mine = ++generation;
    show(Boolean(text));
    if (!text) { last = null; results.replaceChildren(); return; }
    searchedAt = Date.now();
    const reply = await run(api.searchSessions(text));
    if (mine !== generation || !reply) return;
    last = reply;
    paint();
    // Words of chats not indexed yet can still match: ask again until indexing is done.
    if (reply.indexed < reply.total) recheckTimer = window.setTimeout(() => { if (mine === generation) void search(); }, INDEXING_RECHECK_MS);
  };

  const later = (): void => {
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => void search(), TYPING_PAUSE_MS);
  };

  const reset = (): void => {
    field.value = '';
    window.clearTimeout(typingTimer);
    void search();
  };

  ui(field, 'placeholder', () => t("Search chats"));
  ui(field, 'aria-label', () => t("Search chats"));
  ui(clear, 'title', () => t("Clear search"));
  ui(clear, 'aria-label', () => t("Clear search"));
  if (!clear.firstChild) clear.append(icon('i-x'));
  field.addEventListener('input', () => { clear.hidden = !field.value; later(); });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && field.value) { event.preventDefault(); event.stopPropagation(); reset(); }
    else if (event.key === 'ArrowDown') {
      const first = results.querySelector<HTMLElement>('.search-result');
      if (first) { event.preventDefault(); first.focus(); }
    } else if (event.key === 'Enter') {
      const first = results.querySelector<HTMLElement>('.search-result');
      if (first) { event.preventDefault(); first.click(); }
    }
  });
  clear.addEventListener('click', () => { reset(); field.focus(); });
  results.addEventListener('keydown', (event) => {
    const rows = [...results.querySelectorAll<HTMLElement>('.search-result')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    if (event.key === 'ArrowDown' && at < rows.length - 1) { event.preventDefault(); rows[at + 1]!.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); (at > 0 ? rows[at - 1]! : field).focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); field.focus(); }
  });
  show(false);

  return {
    // Chats change many times a second while they run; a running search catches up at most every
    // few seconds instead of re-reading the busy chat on every change.
    refresh: () => { if (query() && Date.now() - searchedAt > REFRESH_MS) later(); },
    get active() { return Boolean(query()); }
  };
}
