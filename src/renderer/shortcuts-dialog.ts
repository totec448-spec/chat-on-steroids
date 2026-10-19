/**
 * The keyboard shortcuts dialog: ⌘/ on macOS, Ctrl+/ elsewhere, or View → Keyboard shortcuts.
 *
 * It lists only keys the app already handles, labelled as this keyboard prints them (shortcuts.ts),
 * and the message box's Enter rows follow the Enter setting. Each row names the module whose
 * handler owns the key, so a new shortcut is added here in the same change as its handler.
 */
import { $, el } from './dom.js';
import { t, ui } from './i18n.js';
import { closeRowMenu } from './row-menu.js';
import { isMac, primaryShiftShortcut, primaryShortcut } from './shortcuts.js';

export interface ShortcutRow { label: () => string; keys: () => string[] }
/** `column` is where the group sits once the dialog is wide enough for two. */
export interface ShortcutGroup { title: () => string; column: 1 | 2; rows: ShortcutRow[] }

const shift = (key: string): string => isMac() ? `⇧${key}` : `${t('Shift')}+${key}`;
const alt = (key: string): string => isMac() ? `⌥${key}` : `Alt+${key}`;

/** The shortcuts, grouped as the dialog shows them; `enterSends` is the Enter key setting. */
export function shortcutGroups(enterSends: () => boolean): ShortcutGroup[] {
  return [
    {
      title: () => t('General'), column: 1,
      rows: [
        { label: () => t('Search chats'), keys: () => [primaryShortcut('K')] }, // chat-search.ts
        { label: () => t('Find in chat'), keys: () => [primaryShortcut('F')] }, // chat-find.ts
        { label: () => t('Search settings'), keys: () => [primaryShortcut('F')] }, // settings-search.ts
        { label: () => t('Toggle sidebar'), keys: () => [primaryShortcut('B')] }, // sidebar-resize.ts
        { label: () => t('Zoom in'), keys: () => [primaryShortcut('+')] }, // main.ts
        { label: () => t('Zoom out'), keys: () => [primaryShortcut('−')] },
        { label: () => t('Actual size'), keys: () => [primaryShortcut('0')] },
        { label: () => t('Keyboard shortcuts'), keys: () => [primaryShortcut('/')] }
      ]
    },
    {
      title: () => t('Sidebar'), column: 1,
      rows: [
        { label: () => t('Move the focused chat or project'), keys: () => [alt('↑'), alt('↓')] } // sidebar-order.ts
      ]
    },
    {
      // chat.ts: the composer's keydown and recallPrompt.
      title: () => t('Message box'), column: 2,
      rows: [
        { label: () => t('Send'), keys: () => [enterSends() ? t('Enter') : primaryShortcut(t('Enter'))] },
        { label: () => t('New line'), keys: () => [enterSends() ? shift(t('Enter')) : t('Enter')] },
        { label: () => t('Send the other way while ChatGPT works'), keys: () => [primaryShiftShortcut(t('Enter'))] },
        { label: () => t('Earlier messages, in an empty message box'), keys: () => ['↑', '↓'] }
      ]
    },
    {
      // workspace-docks.ts: Ctrl on every system, so the label is the docks' own.
      title: () => t('Workspace panels'), column: 2,
      rows: [
        { label: () => t('Toggle bottom panel'), keys: () => ['Ctrl+`'] },
        { label: () => t('Review'), keys: () => ['Ctrl+Shift+1'] },
        { label: () => t('Terminal'), keys: () => ['Ctrl+Shift+2'] },
        { label: () => t('Files'), keys: () => ['Ctrl+Shift+3'] },
        { label: () => t('Sub-agents'), keys: () => ['Ctrl+Shift+4'] }
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
      for (const row of group.rows) {
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

export function initShortcutsDialog(options: { enterSends(): boolean }): { open(): void } {
  const dialog = $<HTMLDialogElement>('shortcutsDialog');
  const list = $('shortcutsList');
  const groups = shortcutGroups(options.enterSends);
  ui($('shortcutsTitle'), 'textContent', () => t('Keyboard shortcuts'));
  ui($('shortcutsClose'), 'title', () => t('Close'));
  ui($('shortcutsClose'), 'aria-label', () => t('Close'));

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
    dialog.addEventListener('animationend', finish, { once: true });
    window.setTimeout(finish, 200);
  };
  const open = (): void => {
    dialog.classList.remove('is-closing');
    closeRowMenu();
    // Painted on each open: the Enter setting or the language may have changed since the last one.
    paint(list, groups);
    if (!dialog.open) dialog.showModal();
    $('shortcutsClose').focus({ focusVisible: false } as FocusOptions);
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
    // Another dialog (search, What's New) keeps the screen.
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    open();
  });
  return { open };
}
