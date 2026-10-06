/**
 * Searching chats (#1117, #1120): by title, and by what was said in them.
 *
 * The search lives in a dialog, opened with ⌘K / Ctrl+K, the View menu or the magnifier beside the
 * app name, so the sidebar keeps its room for the chats themselves. Before anything is typed it
 * lists the most recent chats; while typing, the matches. The main process owns the search
 * (session/search.ts) because the sidebar holds only the newest page of chats. Until every chat's
 * words are indexed, the results say so and fill in as indexing goes on.
 */
import type { SessionSearchReply } from '../shared/session.js';
import { $, el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';
import { isMac, primaryShortcut } from './shortcuts.js';

const api = window.api;
const TYPING_PAUSE_MS = 150;
const INDEXING_RECHECK_MS = 700;
const REFRESH_MS = 3000;
/** Enough to fill the dialog; the rest scroll. */
const RECENT_CHATS = 30;

export interface ChatSearch {
  /** Chats changed: an open search runs again, so new words and titles are found. */
  refresh(): void;
  /** The search dialog is open with a query and its results are shown. */
  readonly active: boolean;
}

export interface ChatSearchOptions {
  /** Opens a chat; `match` is the query when the result matched by what was said, to open at that message. */
  select(id: string, match?: string): void;
  selectedId(): string | null;
  /** The newest chats, newest first, offered before anything is typed. */
  recent(): Array<{ id: string; title: string }>;
}

export function initChatSearch(options: ChatSearchOptions): ChatSearch {
  const dialog = $<HTMLDialogElement>('searchDialog');
  const field = $<HTMLInputElement>('chatSearch');
  const clear = $<HTMLButtonElement>('chatSearchClear');
  const results = $('searchResults');
  const opener = $<HTMLButtonElement>('searchChatsButton');
  let generation = 0;
  let typingTimer = 0;
  let recheckTimer = 0;
  let last: SessionSearchReply | null = null;
  let searchedAt = 0;

  const query = (): string => field.value.trim();

  /**
   * Closes after the exit animation, so the box fades out instead of vanishing. With no animation
   * (reduced motion, or no stylesheet) it closes at once.
   */
  const close = (): void => {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    const finish = (): void => {
      if (!dialog.classList.contains('is-closing')) return;
      dialog.classList.remove('is-closing');
      dialog.close();
    };
    const animation = window.getComputedStyle(dialog).animationName;
    if (!animation || animation === 'none') { finish(); return; }
    dialog.addEventListener('animationend', function ended(event) {
      if (event.target !== dialog) return;
      dialog.removeEventListener('animationend', ended);
      finish();
    });
    // Never left half closed if the animation is skipped (a hidden window does not run it).
    window.setTimeout(finish, 300);
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

  /** One result row: the chat's title, and the passage that matched when the match is in the text. */
  const row = (id: string, title: HTMLElement, snippet?: HTMLElement, match?: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `search-result${id === options.selectedId() ? ' is-sel' : ''}`;
    button.dataset.searchId = id;
    button.setAttribute('role', 'listitem');
    button.append(title);
    if (snippet) button.append(snippet);
    button.addEventListener('click', () => {
      close();
      options.select(id, match);
    });
    return button;
  };

  const list = (rows: HTMLElement[]): HTMLElement => {
    const box = el('div', 'search-list');
    box.setAttribute('role', 'list');
    box.append(...rows);
    return box;
  };

  const paint = (): void => {
    results.replaceChildren();
    if (!query()) {
      const recent = options.recent().slice(0, RECENT_CHATS);
      if (!recent.length) return;
      results.append(el('p', 'search-heading', () => t("Recent")),
        list(recent.map(chat => row(chat.id, marked('b', '', chat.title || t("Untitled session"))))));
      return;
    }
    const reply = last;
    if (!reply) return;
    results.append(list(reply.results.map(result => row(result.id,
      result.title ? marked('b', '', result.title, result.titleMatches) : marked('b', '', t("Untitled session")),
      result.snippet ? marked('span', 'search-snippet', result.snippet.text, result.snippet.matches) : undefined,
      result.snippet ? query() : undefined))));
    if (reply.indexed < reply.total) {
      results.append(el('p', 'search-status', () => t("Searching message text… {0} of {1} chats", [reply.indexed, reply.total])));
    } else if (!reply.results.length) {
      results.append(el('p', 'empty search-status', () => t("No chats match")));
    } else if (reply.limited) {
      results.append(el('p', 'search-status', () => t("Showing the first {0} matches. Add a word to narrow them down.", [reply.results.length])));
    }
  };

  const search = async (): Promise<void> => {
    window.clearTimeout(recheckTimer);
    const text = query();
    const mine = ++generation;
    clear.hidden = !field.value;
    if (!text) { last = null; paint(); return; }
    searchedAt = Date.now();
    const reply = await run(api.searchSessions(text));
    if (mine !== generation || !reply || !dialog.open) return;
    last = reply;
    paint();
    // Words of chats not indexed yet can still match: ask again until indexing is done.
    if (reply.indexed < reply.total) recheckTimer = window.setTimeout(() => { if (mine === generation) void search(); }, INDEXING_RECHECK_MS);
  };

  const later = (): void => {
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => void search(), TYPING_PAUSE_MS);
  };

  const open = (): void => {
    dialog.classList.remove('is-closing');
    if (!dialog.open) dialog.showModal();
    field.focus();
    field.select();
    void search();
  };

  ui(field, 'placeholder', () => t("Search chats"));
  ui(field, 'aria-label', () => t("Search chats"));
  ui(dialog, 'aria-label', () => t("Search chats"));
  ui(clear, 'title', () => t("Clear search"));
  ui(clear, 'aria-label', () => t("Clear search"));
  ui(opener, 'title', () => `${t("Search chats")} (${primaryShortcut('K')})`);
  ui(opener, 'aria-label', () => t("Search chats"));
  if (!clear.firstChild) clear.append(icon('i-x'));
  field.addEventListener('input', () => { clear.hidden = !field.value; later(); });
  field.addEventListener('keydown', (event) => {
    // A search field clears itself on Escape; here Escape closes the dialog, as in ChatGPT.
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowDown') {
      const first = results.querySelector<HTMLElement>('.search-result');
      if (first) { event.preventDefault(); first.focus(); }
    } else if (event.key === 'Enter') {
      const first = results.querySelector<HTMLElement>('.search-result');
      if (first) { event.preventDefault(); first.click(); }
    }
  });
  clear.addEventListener('click', () => { field.value = ''; field.focus(); void search(); });
  // ⌘K on macOS, Ctrl+K elsewhere, as in ChatGPT. Not inside the terminal, where Ctrl+K deletes
  // to the end of the line.
  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'k' || event.shiftKey || event.altKey || event.repeat) return;
    if (isMac() ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    if ((event.target as Element | null)?.closest?.('.xterm')) return;
    event.preventDefault();
    open();
  });
  $('searchMenuItem').addEventListener('click', open);
  opener.addEventListener('click', open);
  // A click on the backdrop lands on the dialog itself, never on its contents.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  // Escape anywhere in the dialog: the same animated close instead of the instant native one.
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => {
    // The close event arrives after the fact: when the dialog was opened again meanwhile, the
    // search typed into it is current and must not be cancelled.
    if (dialog.open) return;
    window.clearTimeout(typingTimer);
    window.clearTimeout(recheckTimer);
    generation++;
  });
  results.addEventListener('keydown', (event) => {
    const rows = [...results.querySelectorAll<HTMLElement>('.search-result')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    if (event.key === 'ArrowDown' && at < rows.length - 1) { event.preventDefault(); rows[at + 1]!.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); (at > 0 ? rows[at - 1]! : field).focus(); }
  });

  return {
    // Chats change many times a second while they run; a running search catches up at most every
    // few seconds instead of re-reading the busy chat on every change.
    refresh: () => { if (dialog.open && query() && Date.now() - searchedAt > REFRESH_MS) later(); },
    get active() { return dialog.open && Boolean(query()); }
  };
}
