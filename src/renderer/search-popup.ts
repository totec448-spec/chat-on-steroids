/**
 * A small searchable picker that drops from a trigger button: a search field over a list of
 * choices. The file panel's base branch and the inbox sidebar's project filter both use it.
 *
 * The keyboard follows one pattern: Down from the field moves to the first choice, Enter in the
 * field picks the first one (a fallback choice only when nothing else matches), Up/Down move
 * between choices, Escape closes and gives focus back to the trigger. A pointer press outside, or a window resize, closes it too. The trigger is read
 * through a function because a repaint may replace it while the popup is open.
 */
import { el, icon } from './dom.js';
import { foldSearchText } from './settings-search.js';

export interface SearchPopupChoice {
  /** What the choice says, and what the search matches. */
  label: string;
  title?: string;
  /** The current choice: marked with a check and `aria-selected`. */
  selected?: boolean;
  /** Drawn before the label, such as a color mark. */
  lead?: Node;
  /** A small note after the label. */
  hint?: string;
  /** Shown but not choosable, such as a ChatGPT Project another project already uses. */
  disabled?: boolean;
  /** Enter in the search field picks this one only when no other choice matches. */
  fallback?: boolean;
  pick: () => void;
}

export interface SearchPopupOptions {
  trigger: () => HTMLElement | null;
  /** Class prefix of the popup's parts: `-menu`, `-search`, `-items`, `-option`, `-hint`, `-notes`, `-empty`. */
  className: string;
  /** Extra classes on the popup itself. */
  extraClass?: string;
  label: () => string;
  placeholder: () => string;
  choices: () => SearchPopupChoice[];
  empty: () => string;
  /** Lines under the choices, such as a note that the list is incomplete. */
  notes?: () => string[];
  /** A visible title above the search, when the popup opens without the person asking for it. */
  heading?: () => string;
  /** Closed without a choice: Escape, a press outside, or a resize. */
  onDismiss?: () => void;
}

export interface SearchPopup {
  readonly open: boolean;
  show(): void;
  close(restoreFocus?: boolean): void;
}

let listboxIds = 0;

export function createSearchPopup(options: SearchPopupOptions): SearchPopup {
  let menu: HTMLElement | null = null;
  let picked = false;
  const part = (name: string): string => `${options.className}-${name}`;

  function close(restoreFocus = false): void {
    if (!menu) return;
    const leaving = menu; menu = null;
    const dismissed = !picked; picked = false;
    // Leave like the other menus: a short fade while it stops taking input, then removal.
    leaving.inert = true; leaving.classList.add('is-leaving');
    const motion = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches && typeof leaving.animate === 'function';
    const fade = motion ? leaving.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 120, easing: 'ease-in' }) : null;
    if (fade?.finished) void fade.finished.catch(() => undefined).then(() => leaving.remove());
    else leaving.remove();
    document.removeEventListener('pointerdown', dismiss, true);
    document.removeEventListener('keydown', keydown, true);
    window.removeEventListener('resize', dismissOnResize);
    const trigger = options.trigger();
    trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus();
    if (dismissed) options.onDismiss?.();
  }
  function dismiss(event: PointerEvent): void {
    const trigger = options.trigger();
    if (menu && !menu.contains(event.target as Node) && !trigger?.contains(event.target as Node)) close();
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  }
  function dismissOnResize(): void { close(); }

  function show(): void {
    const trigger = options.trigger();
    if (menu || !trigger) return;
    const popup = el('div', [part('menu'), options.extraClass].filter(Boolean).join(' '));
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', options.label());
    const search = el('input', part('search')) as HTMLInputElement;
    search.type = 'search'; search.placeholder = options.placeholder();
    search.setAttribute('aria-label', options.placeholder());
    const items = el('div', part('items'));
    items.id = `search-popup-${++listboxIds}`;
    items.setAttribute('role', 'listbox');
    items.setAttribute('aria-label', options.label());
    search.setAttribute('aria-controls', items.id);
    // The empty line and the notes are not choices, so they sit beside the listbox, not in it.
    const notes = el('div', part('notes'));
    const renderItems = (): void => {
      items.replaceChildren();
      notes.replaceChildren();
      const query = foldSearchText(search.value);
      for (const choice of options.choices().filter(entry => foldSearchText(entry.label).includes(query))) {
        const option = el('button', part('option')) as HTMLButtonElement;
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(!!choice.selected));
        if (choice.title) option.title = choice.title;
        if (choice.lead) option.append(choice.lead);
        option.append(el('span', '', choice.label));
        if (choice.hint) option.append(el('span', part('hint'), choice.hint));
        if (choice.selected) option.append(icon('i-check'));
        option.disabled = !!choice.disabled;
        if (choice.fallback) option.dataset.fallback = 'true';
        // The chosen option is about to leave the page, so focus goes back to the trigger first.
        option.addEventListener('click', () => { picked = true; close(true); choice.pick(); });
        items.append(option);
      }
      if (!items.childElementCount) notes.append(el('p', part('empty'), options.empty()));
      // A note is a short secondary line, set apart from the empty state above it; its whole text
      // stays readable on hover when a narrow popup cuts it.
      for (const note of options.notes?.() ?? []) { const line = el('p', part('note'), note); line.title = note; notes.append(line); }
      notes.hidden = !notes.childElementCount;
    };
    search.addEventListener('input', renderItems);
    search.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); items.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }
      if (event.key === 'Enter') {
        event.preventDefault();
        (items.querySelector<HTMLButtonElement>('button:not(:disabled):not([data-fallback])') ?? items.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.click();
      }
    });
    items.addEventListener('keydown', event => {
      const buttons = [...items.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      }
    });
    if (options.heading) popup.append(el('p', part('heading'), options.heading()));
    popup.append(search, items, notes);
    const rect = trigger.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;
    popup.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 270))}px`;
    document.body.append(popup); menu = popup;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', dismissOnResize);
    renderItems(); search.focus();
  }

  return { get open() { return menu !== null; }, show, close };
}
