/**
 * Searching Settings from the sidebar: every page's settings by name, description and section.
 *
 * Settings are the pages' own markup, so the search reads them where they are, in the current
 * language, and finds only what the page would show (a row hidden because it does not apply is not
 * offered). While typing, the page list steps aside for the results, as chat search does; picking a
 * result opens its page, brings the setting into view, briefly marks it and focuses its control.
 */
import { $, el, icon } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';
import { isMac } from './shortcuts.js';

const MAX_RESULTS = 12;
const MARK_MS = 1600;
const TEXT_NODE = 3;

export interface SettingEntry {
  /** The sidebar tab that shows it. */
  tab: string;
  page: string;
  section: string;
  title: string;
  detail: string;
  target: HTMLElement;
}

/** Case and accents fold away (in the interface language, so Turkish İ/ı pair up). */
export function foldSearchText(text: string, language = currentLanguage()): string {
  return text.toLocaleLowerCase(language).normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
}

const words = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** The tab's own label, without a count badge. */
const tabLabel = (button: HTMLElement): string =>
  [...button.childNodes].filter(node => node.nodeType === TEXT_NODE || (node as Element).tagName === 'SPAN' && !(node as Element).classList.contains('badge'))
    .map(node => node.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();

/** Shown when its page is: nothing between it and the page is hidden, and no closed wizard step holds it. */
function offered(node: HTMLElement, page: HTMLElement): boolean {
  for (let at: HTMLElement | null = node; at && at !== page; at = at.parentElement) {
    if (at.hidden) return false;
    if (at.classList.contains('step') && at.parentElement?.classList.contains('wizard') && !at.classList.contains('is-open')) return false;
  }
  return true;
}

/** Every searchable setting, in page order. */
export function collectSettings(root: ParentNode = document): SettingEntry[] {
  const entries: SettingEntry[] = [];
  for (const button of root.querySelectorAll<HTMLElement>('#tabs button[data-tab]')) {
    const tab = button.dataset.tab!;
    const page = root.querySelector<HTMLElement>(tab === 'settings' ? '[data-view="settings"]' : `[data-panel="${tab}"]`);
    if (!page) continue;
    const pageName = tabLabel(button);
    let section = '';
    // Setup's steps are found by name; opening one goes to that step.
    for (const step of page.querySelectorAll<HTMLElement>('.setup-rail button[data-rail-step]')) {
      const title = words(step.querySelector('.setup-rail-label'));
      if (title && offered(step, page)) entries.push({ tab, page: pageName, section: '', title, detail: '', target: step });
    }
    for (const node of page.querySelectorAll<HTMLElement>('.settings-section-head, .setting, .field > label, .perm-main')) {
      if (node.classList.contains('settings-section-head')) {
        section = words(node.querySelector('h2'));
        if (section && offered(node, page)) entries.push({ tab, page: pageName, section: '', title: section, detail: words(node.querySelector('p')), target: node });
        continue;
      }
      if (!offered(node, page)) continue;
      const field = node.matches('.field > label');
      const title = field ? words(node) : words(node.querySelector('.setting-text > b, b'));
      if (!title) continue;
      const detail = field ? '' : words(node.querySelector('.setting-text > em, em'));
      const target = field ? node.parentElement! : node.closest<HTMLElement>('.perm') ?? node;
      entries.push({ tab, page: pageName, section, title, detail, target });
    }
  }
  return entries;
}

/**
 * Settings whose name, description, section or page hold every word of the query. Name matches
 * come first (a name that starts with the query before one that only contains it), then section
 * or page matches, then description matches; page order breaks ties.
 */
export function searchSettings(entries: SettingEntry[], query: string, language = currentLanguage()): SettingEntry[] {
  const wanted = foldSearchText(query, language);
  if (!wanted) return [];
  const terms = wanted.split(' ');
  const scored: Array<{ entry: SettingEntry; rank: number; at: number }> = [];
  entries.forEach((entry, at) => {
    const title = foldSearchText(entry.title, language);
    const place = foldSearchText(`${entry.page} ${entry.section}`, language);
    const all = `${title} ${foldSearchText(entry.detail, language)} ${place}`;
    if (!terms.every(term => all.includes(term))) return;
    const rank = title.startsWith(wanted) ? 0 : terms.every(term => title.includes(term)) ? 1
      : terms.every(term => `${title} ${place}`.includes(term)) ? 2 : 3;
    scored.push({ entry, rank, at });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.at - b.at).slice(0, MAX_RESULTS).map(({ entry }) => entry);
}

export interface SettingsSearch {
  /** Empties the field and brings the page list back. */
  reset(): void;
}

export function initSettingsSearch(options: { open(tab: string): void; shown(): boolean }): SettingsSearch {
  const field = $<HTMLInputElement>('settingsFind');
  const clear = $<HTMLButtonElement>('settingsFindClear');
  const results = $('settingsFindResults');
  const pages = $('tabs');
  let marked: HTMLElement | null = null;
  let markTimer = 0;

  const show = (searching: boolean): void => {
    results.hidden = !searching;
    pages.hidden = searching || !options.shown();
    clear.hidden = !field.value;
  };

  /** The title with each query word marked where it first occurs. */
  const titled = (title: string, query: string): HTMLElement => {
    const node = el('b');
    node.dir = 'auto';
    const lower = title.toLocaleLowerCase(currentLanguage());
    const ranges = query.toLocaleLowerCase(currentLanguage()).split(/\s+/).filter(Boolean)
      .map(term => [lower.indexOf(term), term.length] as const).filter(([start]) => start >= 0)
      .map(([start, length]) => [start, start + length] as const).sort((a, b) => a[0] - b[0]);
    let at = 0;
    for (const [start, end] of ranges) {
      if (start < at) continue;
      if (start > at) node.append(title.slice(at, start));
      node.append(el('mark', '', title.slice(start, end)));
      at = end;
    }
    if (at < title.length) node.append(title.slice(at));
    return node;
  };

  const open = (entry: SettingEntry): void => {
    reset();
    options.open(entry.tab);
    if (entry.target.matches('[data-rail-step]')) entry.target.click();
    for (let details = entry.target.parentElement?.closest('details'); details; details = details.parentElement?.closest('details')) details.open = true;
    // The page is laid out once it shows; scroll and focus after that frame.
    window.requestAnimationFrame(() => {
      entry.target.scrollIntoView({ block: 'center' });
      window.clearTimeout(markTimer);
      marked?.classList.remove('is-found');
      marked = entry.target;
      marked.classList.add('is-found');
      markTimer = window.setTimeout(() => { marked?.classList.remove('is-found'); marked = null; }, MARK_MS);
      entry.target.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, button')?.focus({ preventScroll: true });
    });
  };

  const paint = (): void => {
    results.replaceChildren();
    const query = field.value.trim();
    show(Boolean(query));
    if (!query) return;
    const found = searchSettings(collectSettings(), query);
    const list = el('div', 'search-list');
    list.setAttribute('role', 'list');
    for (const entry of found) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-result';
      row.setAttribute('role', 'listitem');
      row.append(titled(entry.title, query), el('span', 'search-snippet', entry.section ? `${entry.page} › ${entry.section}` : entry.page));
      row.addEventListener('click', () => open(entry));
      list.append(row);
    }
    results.append(list);
    if (!found.length) results.append(el('p', 'empty search-status', () => t("No settings match your search.")));
  };

  const reset = (): void => {
    field.value = '';
    paint();
  };

  ui(field, 'placeholder', () => t("Search settings…"));
  ui(field, 'aria-label', () => t("Search settings"));
  ui(clear, 'title', () => t("Clear search"));
  ui(clear, 'aria-label', () => t("Clear search"));
  if (!clear.firstChild) clear.append(icon('i-x'));
  field.addEventListener('input', paint);
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
  // ⌘F on macOS, Ctrl+F elsewhere, while Settings are open. Not inside the terminal.
  document.addEventListener('keydown', (event) => {
    if (!options.shown() || event.key.toLowerCase() !== 'f' || event.shiftKey || event.altKey || event.repeat) return;
    if (isMac() ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    if ((event.target as Element | null)?.closest?.('.xterm')) return;
    event.preventDefault();
    field.focus();
    field.select();
  });
  show(false);
  return { reset };
}
