import { currentLanguage, t, ui } from './i18n.js';
/**
 * The handful of DOM helpers both panels need.
 *
 * Nothing here knows about app state, and nothing here uses innerHTML — every node is
 * built from text, so a session title or a tool argument can never become markup.
 */

const ICON_NAMES: Readonly<Record<string, string>> = {
  'i-ban': 'prohibit',
  'i-agent': 'robot',
  'i-attach': 'paperclip',
  'i-back': 'arrow-left',
  'i-bolt': 'lightning',
  'i-chat': 'chat-circle',
  'i-check': 'check',
  'i-chev': 'caret-right',
  'i-clock': 'clock',
  'i-copy': 'copy',
  'i-eye': 'eye',
  'i-file': 'file',
  'i-file-add': 'file-plus',
  'i-file-text': 'file-text',
  'i-files': 'tree-structure',
  'i-fit': 'arrows-out-line-horizontal',
  'i-folder': 'folder',
  'i-folder-add': 'folder-plus',
  'i-folder-open': 'folder-open',
  'i-gear': 'gear-six',
  'i-globe': 'globe-hemisphere-west',
  'i-home': 'house',
  'i-image': 'image',
  'i-inspect': 'corners-out',
  'i-key': 'key',
  'i-lock': 'lock-key',
  'i-loop': 'arrows-clockwise',
  'i-monitor': 'monitor',
  'i-minus': 'minus',
  'i-more': 'dots-three',
  'i-out': 'arrow-square-out',
  'i-paw': 'paw-print',
  'i-pencil': 'pencil-simple',
  'i-play': 'play',
  'i-plus': 'plus',
  'i-power': 'power',
  'i-pulse': 'activity',
  'i-retry': 'arrow-clockwise',
  'i-save': 'floppy-disk',
  'i-search': 'magnifying-glass',
  'i-skill': 'cube',
  'i-star': 'star',
  'i-steps': 'list-checks',
  'i-sun': 'sun',
  'i-target': 'target',
  'i-terminal': 'terminal-window',
  'i-trash': 'trash',
  'i-x': 'x'
};

/** One Phosphor icon with the app's shared optical size. */
export function icon(name: string, className = 'ico'): HTMLElement {
  const node = document.createElement('i');
  node.className = `${className} ph ph-${ICON_NAMES[name] ?? name.replace(/^i-/, '')}`;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/**
 * A disclosure indicator with geometry that rotates around its actual visual center.
 *
 * Font carets sit on a text baseline, so their ink appears to jump while rotating even
 * when the element's box stays put. Keep every animated disclosure on this authored SVG;
 * directional action icons continue to use the regular Phosphor icon helper.
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

export function el(tag: string, className = '', text: string | (() => string) = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === 'function') ui(node, 'textContent', text);
  else if (text) node.textContent = text;
  return node;
}

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const cardMenuDocuments = new WeakSet<Document>();

/** Card action menus share one outside-click and Escape boundary across Pets and Plugins. */
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
let toastDismiss: (() => void) | undefined;

function dismissToast(): void {
  document.querySelector('.toast')?.remove();
  window.clearTimeout(toastTimer);
  toastTimer = undefined;
  const dismiss = toastDismiss;
  toastDismiss = undefined;
  dismiss?.();
}

export function toast(message: string, onDismiss?: () => void): void {
  dismissToast();
  const node = el('div', 'toast', message);
  document.body.append(node);
  toastDismiss = onDismiss;
  toastTimer = window.setTimeout(dismissToast, 3200);
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
  return new Date(atMs).toLocaleTimeString();
}

/** "1.2k", "3.4M" — for token and character counts that get large. */
export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
