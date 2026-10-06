/**
 * The title bar's View menu: one icon button opening the same menu as a sidebar row's (its look,
 * motion and keyboard), with each action's icon and shortcut. Zoom steps keep it open, their value
 * updating in place once the zoom is applied (`refresh`). Show browser (the built-in CoS browser,
 * as the tray says it) is there only while that browser is the one ChatGPT runs in.
 */
import { t, ui } from './i18n.js';
import { refreshRowMenu, rowMenuOpenFor, toggleRowMenu, type RowMenuItem } from './row-menu.js';
import { primaryShortcut } from './shortcuts.js';

export interface ViewMenuActions {
  search(): void;
  /** Whether the built-in CoS browser is the selected ChatGPT browser. */
  cosBrowser(): boolean;
  showCosBrowser(): void;
  pets: { toggle(): void; visible(): boolean };
  zoom: { step(delta: number): Promise<void>; reset(): Promise<void>; percent(): number };
}

const OWNER = 'view-menu';

export function initViewMenu(actions: ViewMenuActions): { refresh(): void } {
  const button = document.getElementById('viewMenu') as HTMLButtonElement;
  ui(button, 'title', () => t('View'));
  ui(button, 'aria-label', () => t('View'));
  // The sidebar's own toggle sits right beside this button, so it is not repeated here. Search is:
  // its button lives in the sidebar, which may be hidden.
  const items = (): RowMenuItem[] => [
    { action: 'search', icon: 'i-search', shortcut: () => primaryShortcut('K'), label: () => t('Search chats'), run: actions.search },
    ...(actions.cosBrowser() ? [{
      action: 'cos-browser', icon: 'i-browser', separated: true,
      label: () => t('Show browser'), run: actions.showCosBrowser
    }] : []),
    {
      action: 'pets', icon: 'i-paw', separated: !actions.cosBrowser(),
      label: () => actions.pets.visible() ? t('Hide desktop pets') : t('Show desktop pets'),
      run: actions.pets.toggle
    },
    {
      action: 'zoom-in', icon: 'i-zoom-in', separated: true, keepOpen: true,
      shortcut: () => primaryShortcut('+'), label: () => t('Zoom in'), run: () => void actions.zoom.step(.1)
    },
    {
      action: 'zoom-out', icon: 'i-zoom-out', keepOpen: true,
      shortcut: () => primaryShortcut('−'), label: () => t('Zoom out'), run: () => void actions.zoom.step(-.1)
    },
    {
      action: 'zoom-reset', icon: 'i-zoom-reset', keepOpen: true,
      shortcut: () => primaryShortcut('0'), label: () => t('Actual size'),
      hint: () => `${Math.round(actions.zoom.percent())}%`, run: () => void actions.zoom.reset()
    }
  ];
  button.addEventListener('click', () => toggleRowMenu({ owner: OWNER, anchor: () => button, label: () => t('View'), items }));
  // Keyboard users open it from the button with the arrows too, as with any menu button.
  button.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' || rowMenuOpenFor(OWNER)) return;
    event.preventDefault();
    button.click();
  });
  return {
    // A zoom made with the keyboard while the menu is open shows in its Actual size value too.
    refresh: () => { if (rowMenuOpenFor(OWNER)) refreshRowMenu(); }
  };
}
