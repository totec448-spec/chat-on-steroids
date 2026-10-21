/**
 * App-wide shortcuts, as in Codex: ⌘N on macOS, Ctrl+N elsewhere, starts a new chat, and ⌘, or
 * Ctrl+, opens Settings. They press the sidebar's own buttons, so they do exactly what a click does,
 * and those buttons name them in their tooltips.
 *
 * Not inside the terminal or the file editor, which keep their keys, and not in an open dialog or
 * picker (`role="dialog"`), where the chat behind it must not change.
 */
import { t, ui } from './i18n.js';
import { isMac, primaryShortcut } from './shortcuts.js';

export interface AppShortcutOptions {
  newChat: HTMLElement;
  settings: HTMLElement;
  /** Whether Settings are already open: ⌘, then leaves the page being read where it is. */
  settingsShown(): boolean;
}

export function initAppShortcuts(options: AppShortcutOptions): void {
  ui(options.newChat, 'title', () => `${t('New chat')} (${primaryShortcut('N')})`);
  ui(options.settings, 'title', () => `${t('Settings')} (${primaryShortcut(',')})`);
  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if ((key !== 'n' && key !== ',') || event.shiftKey || event.altKey || event.isComposing) return;
    if (isMac() ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    if ((event.target as Element | null)?.closest?.('.xterm, .cm-editor, dialog, [role="dialog"]')) return;
    event.preventDefault();
    // Held down, the key starts one chat, not one per repeat.
    if (event.repeat) return;
    if (key === 'n') options.newChat.click();
    else if (!options.settingsShown()) options.settings.click();
  });
}
