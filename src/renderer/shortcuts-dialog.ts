/**
 * The keyboard shortcuts dialog: ⌘/ on macOS, Ctrl+/ elsewhere, or View → Keyboard shortcuts.
 *
 * It lists only keys the app already handles, labelled as this keyboard prints them (shortcuts.ts),
 * and the message box's Enter rows follow the Enter setting. Each row names the file whose handler
 * owns the key (`source`), and test/renderer-shortcuts-dialog.test.ts fails when a renderer file
 * handles modifier keys that no row names, so a new shortcut is added here in the same change.
 */
import { $, el } from './dom.js';
import { t, ui } from './i18n.js';
import { closeRowMenu } from './row-menu.js';
import { controlShiftShortcut, holdToTalkShortcut, holdToTalkSupported, isMac, primaryShiftShortcut, primaryShortcut } from './shortcuts.js';

export interface ShortcutRow {
  label: () => string;
  keys: () => string[];
  /** The file under src/ whose handler owns these keys. */
  source: string;
  /** Rows that exist on some systems only. */
  shown?: () => boolean;
}
/** `column` is where the group sits once the dialog is wide enough for two. */
export interface ShortcutGroup { title: () => string; column: 1 | 2; rows: ShortcutRow[] }

const shift = (key: string): string => isMac() ? `⇧${key}` : `${t('Shift')}+${key}`;
const alt = (key: string): string => isMac() ? `⌥${key}` : `Alt+${key}`;
/** Control on every system, as the chord is handled: "⌃Tab" on macOS, as the empty side panel prints
 * its keys; elsewhere the key names follow the UI language ("Strg"). */
const ctrl = (key: string): string => isMac() ? `⌃${key}` : `${t('Ctrl')}+${key}`;
const ctrlShift = controlShiftShortcut;

/** The shortcuts, grouped as the dialog shows them; `enterSends` is the Enter key setting. */
export function shortcutGroups(enterSends: () => boolean): ShortcutGroup[] {
  return [
    {
      title: () => t('General'), column: 1,
      rows: [
        { label: () => t('Search chats'), keys: () => [primaryShortcut('K')], source: 'renderer/chat-search.ts' },
        { label: () => t('New chat'), keys: () => [primaryShortcut('N')], source: 'renderer/app-shortcuts.ts' },
        { label: () => t('Settings'), keys: () => [primaryShortcut(',')], source: 'renderer/app-shortcuts.ts' },
        // Ctrl on every system, macOS included, as in browsers.
        { label: () => t('Next chat'), keys: () => [ctrl('Tab')], source: 'renderer/chat-cycle.ts' },
        { label: () => t('Previous chat'), keys: () => [ctrlShift('Tab')], source: 'renderer/chat-cycle.ts' },
        { label: () => t('Find in chat'), keys: () => [primaryShortcut('F')], source: 'renderer/chat-find.ts' },
        { label: () => t('Search settings'), keys: () => [primaryShortcut('F')], source: 'renderer/settings-search.ts' },
        { label: () => t('Toggle sidebar'), keys: () => [primaryShortcut('B')], source: 'renderer/sidebar-resize.ts' },
        { label: () => t('Zoom in'), keys: () => [primaryShortcut('+')], source: 'renderer/main.ts' },
        { label: () => t('Zoom out'), keys: () => [primaryShortcut('−')], source: 'renderer/main.ts' },
        { label: () => t('Actual size'), keys: () => [primaryShortcut('0')], source: 'renderer/main.ts' },
        // F11 is Show Desktop on a Mac and never reaches the window, so there it is Electron's default View menu: ⌃⌘F.
        { label: () => t('Full screen'), keys: () => [isMac() ? '⌃⌘F' : 'F11'], source: 'main/index.ts' },
        { label: () => t('Keyboard shortcuts'), keys: () => [primaryShortcut('/')], source: 'renderer/shortcuts-dialog.ts' }
      ]
    },
    {
      title: () => t('Sidebar'), column: 1,
      rows: [
        { label: () => t('Move the focused chat or project'), keys: () => [alt('↑'), alt('↓')], source: 'renderer/sidebar-order.ts' }
      ]
    },
    {
      title: () => t('Message box'), column: 2,
      rows: [
        { label: () => t('Send'), keys: () => [enterSends() ? t('Enter') : primaryShortcut(t('Enter'))], source: 'renderer/chat.ts' },
        { label: () => t('New line'), keys: () => [enterSends() ? shift(t('Enter')) : t('Enter')], source: 'renderer/chat.ts' },
        { label: () => t('Send the other way while ChatGPT works'), keys: () => [primaryShiftShortcut(t('Enter'))], source: 'renderer/chat.ts' },
        { label: () => t('Earlier messages, in an empty message box'), keys: () => ['↑', '↓'], source: 'renderer/chat.ts' },
        { label: () => t('Stop the turn, twice in an empty message box'), keys: () => ['Esc', 'Esc'], source: 'renderer/chat.ts' },
        // Windows only: see holdToTalkSupported.
        { label: () => t('Hold to dictate'), keys: () => [holdToTalkShortcut()], source: 'renderer/chat.ts', shown: holdToTalkSupported },
        { label: () => t('Move a queued task'), keys: () => [alt('↑'), alt('↓')], source: 'renderer/chat.ts' }
      ]
    },
    {
      // workspace-docks.ts: Ctrl on every system, so the label is the docks' own.
      title: () => t('Workspace panels'), column: 2,
      rows: [
        { label: () => t('Toggle bottom panel'), keys: () => [ctrl('`')], source: 'renderer/workspace-docks.ts' },
        { label: () => t('Review'), keys: () => [ctrlShift('1')], source: 'renderer/workspace-docks.ts' },
        { label: () => t('Terminal'), keys: () => [ctrlShift('2')], source: 'renderer/workspace-docks.ts' },
        { label: () => t('Files'), keys: () => [ctrlShift('3')], source: 'renderer/workspace-docks.ts' },
        { label: () => t('Sub-agents'), keys: () => [ctrlShift('4')], source: 'renderer/workspace-docks.ts' },
        { label: () => t('Move the focused tab'), keys: () => [ctrlShift('←'), ctrlShift('→')], source: 'renderer/tab-reorder.ts' },
        { label: () => t('Save the file being edited'), keys: () => [primaryShortcut('S')], source: 'renderer/file-panel.ts' }
      ]
    },
    {
      title: () => t('Terminal'), column: 1,
      rows: [
        { label: () => t('Copy the selection'), keys: () => [ctrlShift('C')], source: 'renderer/workspace-terminal.ts' },
        { label: () => t('Send to chat'), keys: () => [primaryShiftShortcut(t('Enter'))], source: 'renderer/workspace-terminal.ts' }
      ]
    }
  ];
}

function paint(list: HTMLElement, groups: ShortcutGroup[]): void {
  list.replaceChildren(...([1, 2] as const).map(column => {
    const side = el('div', 'shortcuts-column');
    side.append(...groups.filter(group => group.column === column).map(group => {
      const section = el('section', 'shortcuts-group');
      const rows = el('dl', 'shortcuts-rows');
      for (const row of group.rows.filter(row => !row.shown || row.shown())) {
        const keys = el('dd', 'shortcuts-keys');
        keys.append(...row.keys().map(key => el('kbd', '', key)));
        rows.append(el('dt', '', row.label), keys);
      }
      section.append(el('h3', '', group.title), rows);
      return section;
    }));
    return side;
  }));
}

export function initShortcutsDialog(options: { enterSends(): boolean }): { open(viaKeyboard?: boolean): void } {
  const dialog = $<HTMLDialogElement>('shortcutsDialog');
  const list = $('shortcutsList');
  const groups = shortcutGroups(options.enterSends);
  ui($('shortcutsTitle'), 'textContent', () => t('Keyboard shortcuts'));
  // Worded like every other dialog's Close.
  ui($('shortcutsClose'), 'textContent', () => t('Close'));

  // Where the keyboard was when the dialog opened (the message box, the View button): focus goes
  // back there on close, never to the page body.
  let opener: HTMLElement | null = null;
  const close = (): void => {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    const finish = (): void => {
      if (!dialog.classList.contains('is-closing')) return;
      dialog.classList.remove('is-closing');
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      opener = null;
    };
    const animation = window.getComputedStyle(dialog).animationName;
    if (!animation || animation === 'none') { finish(); return; }
    dialog.addEventListener('animationend', finish, { once: true });
    window.setTimeout(finish, 200);
  };
  const open = (viaKeyboard: boolean): void => {
    dialog.classList.remove('is-closing');
    // The keys can open it over the View menu, from one of its items. The item leaves with the menu,
    // so the menu hands the keyboard back to its button first and the dialog returns it there.
    closeRowMenu(Boolean((document.activeElement as Element | null)?.closest?.('[role="menu"]')));
    if (!dialog.open) opener = document.activeElement === document.body ? null : document.activeElement as HTMLElement | null;
    // Painted on each open: the Enter setting or the language may have changed since the last one.
    paint(list, groups);
    if (!dialog.open) dialog.showModal();
    // The focus ring shows when the keys opened it, so the keyboard can see where focus went; a
    // click on the View menu leaves it off.
    $('shortcutsClose').focus({ focusVisible: viaKeyboard } as FocusOptions);
  };

  $('shortcutsClose').addEventListener('click', close);
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  // ⌘/ on macOS, Ctrl+/ elsewhere; the same keys close it. Keyboards that need Shift for "/"
  // (German, French) still give "/" as the key. The terminal keeps its keys, and so does the file
  // editor, where the same keys comment a line out.
  document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.altKey || event.repeat) return;
    if (isMac() ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    if ((event.target as Element | null)?.closest?.('.xterm, .cm-editor')) return;
    if (dialog.open) { event.preventDefault(); close(); return; }
    // Another dialog keeps the screen: a <dialog> (search, What's New), or a picker (role="dialog"
    // div) holding the keyboard. The context meter and connection popover keep a role="dialog"
    // element in the page while closed, so only one the keyboard is inside counts.
    if (document.querySelector('dialog[open]') || (event.target as Element | null)?.closest?.('[role="dialog"]')) return;
    event.preventDefault();
    open(true);
  });
  return { open: (viaKeyboard = false) => open(viaKeyboard) };
}
