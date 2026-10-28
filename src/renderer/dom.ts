import { ageOf, compactCount, type AgeUnit } from '../shared/age.js';
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
  'i-arrow-up': 'arrow-up',
  'i-arrow-left': 'arrow-left',
  'i-arrow-right': 'arrow-right',
  'i-back': 'arrow-left',
  'i-ban': 'prohibit',
  'i-bolt': 'lightning',
  'i-bookmark': 'bookmark-simple',
  'i-bookmark-fill': 'fill:bookmark-simple',
  'i-browser': 'browser',
  'i-chart': 'chart-line',
  'i-chat': 'chat-circle',
  'i-check': 'check',
  'i-check-circle': 'check-circle',
  'i-checks': 'checks',
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
  'i-group': 'folder-simple',
  'i-git-branch': 'git-branch',
  'i-git-diff': 'git-diff',
  'i-globe': 'globe-hemisphere-west',
  'i-home': 'house',
  'i-image': 'image',
  'i-keyboard': 'keyboard',
  'i-lock': 'lock-key',
  'i-unlink': 'link-break',
  'i-swap': 'arrows-left-right',
  'i-loop': 'arrows-clockwise',
  'i-monitor': 'monitor',
  'i-more': 'dots-three',
  'i-more-vertical': 'dots-three-vertical',
  'i-out': 'arrow-square-out',
  'i-panel-bottom': 'fill:square-half-bottom',
  'i-panel-right': 'fill:square-half',
  'i-palette': 'palette',
  'i-paw': 'paw-print',
  'i-phone': 'device-mobile',
  'i-page-next': 'caret-right',
  'i-page-previous': 'caret-left',
  'i-pencil': 'pencil-simple',
  'i-pin': 'push-pin-simple',
  'i-pinned': 'fill:push-pin-simple',
  'i-plug': 'plug',
  'i-play': 'play',
  'i-plus': 'plus',
  'i-power': 'power',
  'i-pulse': 'activity',
  'i-quote': 'quotes',
  'i-retry': 'arrow-clockwise',
  'i-restore': 'arrow-counter-clockwise',
  'i-search': 'magnifying-glass',
  'i-shield': 'shield-check',
  'i-skill': 'cube',
  'i-sparkle': 'sparkle',
  'i-star': 'star',
  'i-star-fill': 'fill:star',
  'i-steps': 'list-checks', 'i-stop': 'stop-circle',
  'i-sun': 'sun',
  'i-target': 'target',
  'i-terminal': 'terminal-window',
  'i-zoom-in': 'magnifying-glass-plus',
  'i-zoom-out': 'magnifying-glass-minus',
  'i-zoom-reset': 'arrow-counter-clockwise',
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

let toastTimer: number | undefined;
let toastWatch: ResizeObserver | undefined;

export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  toastWatch?.disconnect();
  const node = el('div', 'toast', message);
  node.setAttribute('role', 'status');
  document.body.append(node);
  placeToast(node);
  // The composer and its dock can grow or the window resize while the toast shows: it follows.
  toastWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (node.isConnected) placeToast(node); }) : undefined;
  for (const target of document.querySelectorAll('main, .card.is-session > .composer, .card.is-session > .composer-dock')) toastWatch?.observe(target);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { node.remove(); toastWatch?.disconnect(); }, 3200);
}

/** Shown over the content it is about: centred on the open chat's composer and just above it and
 *  its dock, so it never covers the draft or its controls; elsewhere centred on the main pane
 *  instead of the window, which put it half over the sidebar. */
function placeToast(node: HTMLElement): void {
  const visible = (target: Element | null | undefined): DOMRect | null => {
    const box = target?.getBoundingClientRect();
    return box && box.width > 0 && box.height > 0 ? box : null;
  };
  const composer = visible(document.querySelector('.card.is-session > .composer'));
  const area = composer ?? visible(document.querySelector('main'));
  if (!area) return;
  node.style.left = `${area.left + area.width / 2}px`;
  node.style.maxWidth = `${Math.max(160, Math.min(560, area.width - 32))}px`;
  if (!composer) return;
  const dock = document.querySelector('.card.is-session > .composer-dock');
  const dockBox = dock && getComputedStyle(dock).opacity !== '0' ? visible(dock) : null;
  node.style.bottom = `${Math.max(12, window.innerHeight - Math.min(composer.top, dockBox?.top ?? Infinity) + 12)}px`;
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
  const age = ageOf(atMs, Date.now());
  if (!age) return t("just now");
  if (age.unit === 'second') return t("{0}s ago", [age.value]);
  if (age.unit === 'minute') return t("{0}m ago", [age.value]);
  if (age.unit === 'hour') return t("{0}h ago", [age.value]);
  // Days and longer in the person's language (2.1.47 round: the chat list said "389h ago"). English
  // reads "2d ago" beside "3h ago"; elsewhere the narrow style can drop the word "ago" for a minus
  // sign ("-16 j"), so those use the short one ("il y a 16 j", "vor 16 Tagen").
  const language = currentLanguage();
  return new Intl.RelativeTimeFormat(language, { numeric: 'always', style: /^en\b/i.test(language) ? 'narrow' : 'short' })
    .format(-age.value, age.unit);
}

/**
 * The same age as one glanceable token in the person's language: "8s", "2m", "3d", "2w", "4mo" in
 * English, "—" when there is nothing. The catalogs, not the platform's narrow units: those write
 * four months as "4m" beside four minutes in English, Spanish and Japanese (CodeRabbit on #1902).
 */
export function shortAgo(atMs: number | null): string {
  if (atMs === null) return '—';
  const age = ageOf(atMs, Date.now());
  return age ? compactAgeText(age.value, age.unit) : t("now");
}

/** One age as a compact token from the catalogs: "45s", "4m", "5h", "3d", "2w", "4mo", "2y" in English. */
export function compactAgeText(value: number, unit: AgeUnit): string {
  const key = { second: "{0}s", minute: "{0}m", hour: "{0}h", day: "{0}d", week: "{0}w", month: "{0}mo", year: "{0}y" }[unit];
  return t(key, [value]);
}

/** A clock time for one event in a timeline. */
export function clockTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(currentLanguage());
}

/** "1.2k", "3.4M" — for token and character counts that get large. */
/** A count in a few characters: "999", "1.0k", "12k", "1.3M", "2.0B" (never "1000k" or "2000.0M"). */
export function compactNumber(value: number): string {
  return compactCount(value);
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
