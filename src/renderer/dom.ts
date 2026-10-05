import { currentLanguage, t, ui } from './i18n.js';
/**
 * The handful of DOM helpers both panels need.
 *
 * Nothing here knows about app state, and nothing here uses innerHTML — every node is
 * built from text, so a session title or a tool argument can never become markup.
 */

/**
 * The app's icon vocabulary, drawn with the bundled Phosphor font (icons.css).
 *
 * Call sites name what an icon means (`i-retry`); this map alone decides which glyph draws it.
 * `fill:` selects Phosphor's filled family. The dock toggles use the filled half-square that
 * shows the edge they open: drawn upright (no rotation), it stays crisp at fractional scales.
 */
const ICONS: Readonly<Record<string, string>> = {
  'i-agents': 'robot',
  'i-arrow-down': 'arrow-down',
  'i-arrow-left': 'arrow-left',
  'i-arrow-right': 'arrow-right',
  'i-back': 'arrow-left',
  'i-ban': 'prohibit',
  'i-bolt': 'lightning',
  'i-chart': 'chart-line',
  'i-chat': 'chat-circle',
  'i-check': 'check',
  'i-check-circle': 'check-circle',
  'i-clock': 'clock',
  'i-copy': 'copy',
  'i-dock-expand': 'corners-out',
  'i-dock-restore': 'corners-in',
  'i-export': 'download-simple',
  'i-eye': 'eye',
  'i-file': 'file',
  'i-file-text': 'file-text',
  'i-folder': 'folder',
  'i-gear': 'gear-six',
  'i-git-diff': 'git-diff',
  'i-globe': 'globe-hemisphere-west',
  'i-home': 'house',
  'i-image': 'image',
  'i-lock': 'lock-key',
  'i-loop': 'arrows-clockwise',
  'i-monitor': 'monitor',
  'i-more': 'dots-three',
  'i-out': 'arrow-square-out',
  'i-panel-bottom': 'fill:square-half-bottom',
  'i-panel-right': 'fill:square-half',
  'i-paw': 'paw-print',
  'i-page-next': 'caret-right',
  'i-page-previous': 'caret-left',
  'i-pencil': 'pencil-simple',
  'i-pin': 'push-pin-simple',
  'i-pinned': 'fill:push-pin-simple',
  'i-play': 'play',
  'i-plus': 'plus',
  'i-power': 'power',
  'i-pulse': 'activity',
  'i-retry': 'arrow-clockwise',
  'i-search': 'magnifying-glass',
  'i-skill': 'cube',
  'i-star': 'star',
  'i-star-fill': 'fill:star',
  'i-steps': 'list-checks',
  'i-sun': 'sun',
  'i-target': 'target',
  'i-terminal': 'terminal-window',
  'i-zoom-in': 'magnifying-glass-plus',
  'i-zoom-out': 'magnifying-glass-minus',
  'i-trash': 'trash',
  'i-warning': 'warning',
  'i-x': 'x'
};

function iconClasses(name: string): string {
  const glyph = ICONS[name];
  if (!glyph) throw new Error(`unknown icon ${name}`);
  return glyph.startsWith('fill:') ? `ph-fill ph-${glyph.slice(5)}` : `ph ph-${glyph}`;
}

/** One icon glyph at the shared optical size (`.ico`), hidden from assistive technology. */
export function icon(name: string, className = 'ico'): HTMLElement {
  const node = document.createElement('i');
  node.setAttribute('aria-hidden', 'true');
  setIcon(node, name, className);
  return node;
}

/**
 * A disclosure indicator with geometry that rotates around its actual visual center.
 *
 * Font carets sit on a text baseline, so their ink appears to jump while rotating even
 * when the element's box stays put. Keep every animated disclosure on this authored SVG;
 * directional action icons continue to use the Phosphor icon helper.
 */
export function disclosureChevron(className = ''): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('class', `disclosure-chevron${className ? ` ${className}` : ''}`);
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 3.5 10.5 8 6 12.5');
  node.append(path);
  return node;
}

/** Redraws an existing icon, e.g. a toggle whose meaning flipped. */
export function setIcon(node: Element, name: string, className = 'ico'): void {
  node.className = `${className} ${iconClasses(name)}`;
}

export function el(tag: string, className = '', text: string | (() => string) = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === 'function') ui(node, 'textContent', text);
  else if (text) node.textContent = text;
  return node;
}

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Filter complete settings sections so headings, controls and their context stay together. */
export function filterSettingsSections(view: HTMLElement, search: string): void {
  const fold = (text: string) => text.toLocaleLowerCase(currentLanguage());
  const query = fold(search.trim());
  let matches = 0;
  for (const heading of view.querySelectorAll<HTMLElement>('.automation-section-head')) {
    const pane = heading.nextElementSibling as HTMLElement | null;
    if (!pane?.classList.contains('pane')) continue;
    const visible = !query || fold(`${heading.textContent} ${pane.textContent}`).includes(query);
    heading.hidden = pane.hidden = !visible;
    if (visible) matches++;
  }
  const empty = view.querySelector<HTMLElement>('#settingsSearchEmpty');
  if (empty) empty.hidden = !query || matches > 0;
}

let toastTimer: number | undefined;

export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const node = el('div', 'toast', message);
  document.body.append(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), 3200);
}

/** Unwraps IPC replies, translating known app errors and preserving unknown error text. */
export async function run<T>(
  promise: Promise<{ ok: true; data: T } | { ok: false; error: string }>
): Promise<T | null> {
  const reply = await promise;
  if (!reply.ok) {
    toast(t(reply.error));
    return null;
  }
  return reply.data;
}

/** "12s ago" for a timestamp the main process vouched for, "never" for null. */
export function ago(atMs: number | null): string {
  if (atMs === null) return t("never");
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (seconds < 3) return t("just now");
  if (seconds < 90) return t("{0}s ago", [seconds]);
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? t("{0}m ago", [minutes]) : t("{0}h ago", [Math.round(minutes / 60)]);
}

/** The same age as one glanceable token: "8s", "2m", "—" when there is nothing. */
export function shortAgo(atMs: number | null): string {
  if (atMs === null) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (seconds < 3) return t("now");
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** A clock time for one event in a timeline. */
export function clockTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(currentLanguage());
}

/** "1.2k", "3.4M" — for token and character counts that get large. */
export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

const cardMenuDocuments = new WeakSet<Document>();

/** Closes open card menus on an outside click, on an action inside one, and on Escape. */
export function initCardMenuDismissal(doc: Document = document): void {
  if (cardMenuDocuments.has(doc)) return;
  cardMenuDocuments.add(doc);
  doc.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const menu = typeof target?.closest === 'function' ? target.closest('.plugin-menu') : null;
    const action = typeof target?.closest === 'function' ? target.closest('.plugin-menu-actions') : null;
    for (const open of doc.querySelectorAll<HTMLDetailsElement>('.plugin-menu[open]')) {
      if (open !== menu || action) open.open = false;
    }
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const open of doc.querySelectorAll<HTMLDetailsElement>('.plugin-menu[open]')) open.open = false;
  });
}
