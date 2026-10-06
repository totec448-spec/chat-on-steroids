/**
 * The one menu behind a sidebar row's "⋯" button and its right click: a project's or a chat's
 * actions, with submenus (a project's color). It lives in the document body, outside the sidebar
 * the activity repaints many times a second, so a repaint never closes or rebuilds it; it finds
 * its row's button again by `owner` to place itself and to give focus back.
 *
 * One menu is open at a time. It stays inside the window, opening upwards or leftwards when there
 * is no room, and a submenu opens beside its item. Keyboard: arrows move, Right opens a submenu,
 * Left or Escape closes it, Escape closes the menu and returns focus to the row's button, Tab and
 * a click elsewhere close it.
 */
import { el, icon } from './dom.js';
import { ui } from './i18n.js';

export interface RowMenuItem {
  /** Stable name of the action (`data-row-action`), for focus and tests. */
  action: string;
  label: () => string;
  icon?: string;
  /** A longer explanation, as the item's tooltip. */
  title?: () => string;
  danger?: boolean;
  /** A choice among several (menuitemradio): whether it is the current one. */
  checked?: boolean;
  /** A color dot before the label (`data-color`); an empty string draws the empty dot. */
  swatch?: string;
  disabled?: boolean;
  /** Items of a submenu, opened beside this item. */
  submenu?: () => RowMenuItem[];
  /** Runs after the menu has closed. */
  run?: () => void;
  /** Starts a group: a separator line above this item. */
  separated?: boolean;
  /** Data attributes for the item's button, e.g. `newProject` for `data-new-project`. */
  data?: Record<string, string>;
}

export interface RowMenuOptions {
  /** Which row's menu this is, e.g. `project:<id>`; one row has one menu. */
  owner: string;
  /** The row's "⋯" button as it is now; repaints replace it. */
  anchor: () => HTMLElement | null;
  label: () => string;
  items: () => RowMenuItem[];
  /** A right click opens the menu at the pointer instead of beside the button. */
  at?: { x: number; y: number };
}

const EDGE = 8;
const SUBMENU_DELAY_MS = 120;

let current: { options: RowMenuOptions; levels: HTMLElement[]; openTimer: number } | null = null;
const listeners = new Set<() => void>();

/** Whether the menu of this row is open; rows paint their button's expanded state from it. */
export function rowMenuOpenFor(owner: string): boolean {
  return current?.options.owner === owner;
}

/** Called when a menu opens or closes, so the sidebar can repaint its buttons' state. */
export function onRowMenuChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const changed = (): void => { for (const listener of listeners) listener(); };

/** Closes every level; with `restoreFocus`, focus goes back to the row's button. */
export function closeRowMenu(restoreFocus = false): void {
  if (!current) return;
  const { options, levels, openTimer } = current;
  window.clearTimeout(openTimer);
  current = null;
  for (const level of levels) leave(level);
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('scroll', scrolled, true);
  window.removeEventListener('resize', resized);
  window.removeEventListener('blur', resized);
  options.anchor()?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) options.anchor()?.focus({ preventScroll: true });
  changed();
}

/** Opens the row's menu, or closes it when it is already open from the same button. */
export function toggleRowMenu(options: RowMenuOptions): void {
  if (rowMenuOpenFor(options.owner) && !options.at) { closeRowMenu(true); return; }
  openRowMenu(options);
}

export function openRowMenu(options: RowMenuOptions): void {
  closeRowMenu();
  current = { options, levels: [], openTimer: 0 };
  // Marked open first: a row shows its button only while hovered, focused or open, and a menu
  // opened from the keyboard must measure the button where it is, not where it is hidden.
  options.anchor()?.setAttribute('aria-expanded', 'true');
  const menu = level(options.items(), options.label, 0);
  document.body.append(menu);
  current.levels.push(menu);
  if (options.at) placeAt(menu, options.at.x, options.at.y);
  else {
    const anchor = options.anchor();
    const box = anchor?.getBoundingClientRect();
    if (box && box.width > 0) placeBeside(menu, box, 'below'); else placeAt(menu, EDGE, EDGE);
  }
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('scroll', scrolled, true);
  window.addEventListener('resize', resized);
  window.addEventListener('blur', resized);
  focusItem(menu, 0);
  changed();
}

/** Fades a level out, then removes it; at once when no animation runs. */
function leave(level: HTMLElement): void {
  // No longer a menu: nothing finds it as one while it fades.
  level.className = 'row-menu-leaving';
  level.removeAttribute('role');
  const animation = window.getComputedStyle(level).animationName;
  if (!animation || animation === 'none') { level.remove(); return; }
  level.addEventListener('animationend', () => level.remove(), { once: true });
  window.setTimeout(() => level.remove(), 200);
}

function outside(event: PointerEvent): void {
  if (!current) return;
  const target = event.target as Node | null;
  if (target && current.levels.some(level => level.contains(target))) return;
  // The row's own button toggles the menu itself.
  if (target && current.options.anchor()?.contains(target)) return;
  closeRowMenu();
}

function scrolled(event: Event): void {
  if (!current) return;
  const target = event.target as Node | null;
  if (target && current.levels.some(level => level.contains(target))) return;
  closeRowMenu();
}

function resized(): void { closeRowMenu(); }

/** One level of the menu: its items, separators and keyboard. */
function level(items: RowMenuItem[], label: () => string, depth: number): HTMLElement {
  const menu = el('div', 'row-menu');
  menu.setAttribute('role', 'menu');
  menu.dataset.depth = String(depth);
  ui(menu, 'aria-label', label);
  for (const item of items) {
    if (item.separated && menu.childElementCount) menu.append(el('div', 'row-menu-separator'));
    menu.append(itemButton(item, menu, depth));
  }
  menu.addEventListener('keydown', event => keyboard(event, menu, depth));
  return menu;
}

function itemButton(item: RowMenuItem, menu: HTMLElement, depth: number): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `row-menu-item${item.danger ? ' is-danger' : ''}`;
  button.dataset.rowAction = item.action;
  for (const [key, value] of Object.entries(item.data ?? {})) button.dataset[key] = value;
  button.tabIndex = -1;
  button.disabled = item.disabled === true;
  button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
  if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
  if (item.swatch !== undefined) {
    const dot = el('span', 'row-menu-swatch');
    dot.dataset.color = item.swatch;
    button.append(dot);
  } else if (item.icon) button.append(icon(item.icon));
  else button.append(el('span', 'row-menu-gap'));
  const text = el('span', 'row-menu-label', item.label);
  button.append(text);
  if (item.title) ui(button, 'title', item.title);
  if (item.submenu) {
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.append(icon('i-page-next', 'ico row-menu-chevron'));
    button.addEventListener('click', event => { event.stopPropagation(); openSubmenu(item, button, depth, true); });
    button.addEventListener('pointerenter', () => {
      if (!current) return;
      window.clearTimeout(current.openTimer);
      current.openTimer = window.setTimeout(() => openSubmenu(item, button, depth, false), SUBMENU_DELAY_MS);
    });
  } else {
    if (item.checked) button.append(icon('i-check', 'ico row-menu-check'));
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (button.disabled) return;
      // Focus goes back to the row's button first: an action that moves it (renaming, a new
      // chat's field) still does, and one that repaints the sidebar finds it there to keep.
      closeRowMenu(true);
      item.run?.();
    });
    // Moving onto a plain item closes a deeper submenu, as in any menu.
    button.addEventListener('pointerenter', () => {
      if (!current) return;
      window.clearTimeout(current.openTimer);
      closeLevelsBelow(depth);
    });
  }
  button.addEventListener('pointermove', () => { if (document.activeElement !== button && !button.disabled) button.focus({ preventScroll: true }); });
  void menu;
  return button;
}

function openSubmenu(item: RowMenuItem, button: HTMLButtonElement, depth: number, focusFirst: boolean): void {
  if (!current || !item.submenu) return;
  window.clearTimeout(current.openTimer);
  const open = current.levels[depth + 1];
  if (open?.dataset.parentAction === item.action) {
    if (focusFirst) focusItem(open, checkedIndex(open));
    return;
  }
  closeLevelsBelow(depth);
  const submenu = level(item.submenu(), item.label, depth + 1);
  submenu.dataset.parentAction = item.action;
  document.body.append(submenu);
  current.levels.push(submenu);
  button.setAttribute('aria-expanded', 'true');
  placeBeside(submenu, button.getBoundingClientRect(), 'right');
  if (focusFirst) focusItem(submenu, checkedIndex(submenu));
}

function closeLevelsBelow(depth: number): void {
  if (!current) return;
  for (const extra of current.levels.splice(depth + 1)) leave(extra);
  current.levels[depth]?.querySelectorAll('[aria-haspopup="menu"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
}

const enabledItems = (menu: HTMLElement): HTMLButtonElement[] =>
  [...menu.querySelectorAll<HTMLButtonElement>('.row-menu-item:not(:disabled)')];

function checkedIndex(menu: HTMLElement): number {
  const index = enabledItems(menu).findIndex(button => button.getAttribute('aria-checked') === 'true');
  return Math.max(0, index);
}

function focusItem(menu: HTMLElement, index: number): void {
  const items = enabledItems(menu);
  items[Math.min(Math.max(0, index), items.length - 1)]?.focus({ preventScroll: true });
}

function keyboard(event: KeyboardEvent, menu: HTMLElement, depth: number): void {
  if (!current) return;
  const items = enabledItems(menu);
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const move = (index: number): void => { event.preventDefault(); items[(index + items.length) % items.length]?.focus({ preventScroll: true }); };
  switch (event.key) {
    case 'ArrowDown': return move(at + 1);
    case 'ArrowUp': return move(at < 0 ? items.length - 1 : at - 1);
    case 'Home': return move(0);
    case 'End': return move(items.length - 1);
    case 'ArrowRight': {
      const button = items[at];
      if (button?.getAttribute('aria-haspopup') === 'menu') { event.preventDefault(); button.click(); }
      return;
    }
    case 'ArrowLeft':
    case 'Escape': {
      event.preventDefault(); event.stopPropagation();
      if (depth > 0) {
        const parent = current.levels[depth - 1];
        const action = menu.dataset.parentAction;
        closeLevelsBelow(depth - 1);
        parent?.querySelector<HTMLElement>(`[data-row-action="${action}"]`)?.focus({ preventScroll: true });
      } else if (event.key === 'Escape') closeRowMenu(true);
      return;
    }
    case 'Tab': closeRowMenu(); return;
  }
}

/** At a point (a right click), kept inside the window. */
function placeAt(menu: HTMLElement, x: number, y: number): void {
  // Its layout size: the opening animation must not make it look smaller than it is.
  const width = menu.offsetWidth, height = menu.offsetHeight;
  menu.style.left = `${Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE))}px`;
  menu.style.top = `${Math.max(EDGE, y + height > window.innerHeight - EDGE ? y - height : y)}px`;
}

/** Below a button (opening upwards without room), or beside a submenu's item, inside the window. */
function placeBeside(menu: HTMLElement, box: DOMRect, side: 'below' | 'right'): void {
  // Its layout size: the opening animation must not make it look smaller than it is.
  const width = menu.offsetWidth, height = menu.offsetHeight;
  let left: number, top: number;
  if (side === 'below') {
    left = box.left;
    top = box.bottom + 4;
    if (top + height > window.innerHeight - EDGE) top = box.top - height - 4;
  } else {
    left = box.right + 2;
    if (left + width > window.innerWidth - EDGE) left = box.left - width - 2;
    top = box.top - 5;
  }
  menu.style.left = `${Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE))}px`;
  menu.style.top = `${Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE))}px`;
}
