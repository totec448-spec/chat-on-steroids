/**
 * Keyboard shortcut labels as this computer's keyboard prints them.
 *
 * The app's primary shortcuts (sidebar, zoom, search) accept Ctrl or ⌘, so macOS shows ⌘ and
 * other systems show the keyboard's Ctrl key in the UI language ("Strg" in German). The workspace
 * panels' Ctrl+Shift+1–4 really are Control everywhere, so a Mac shows them as ⌃⇧.
 */
import { t } from './i18n.js';

export function isMac(): boolean {
  return /^Mac/.test(navigator.platform);
}

/** "⌘K" on macOS, "Ctrl+K" (or "Strg+K") elsewhere. */
export function primaryShortcut(key: string): string {
  return isMac() ? `⌘${key}` : `${t('Ctrl')}+${key}`;
}

/** "⌘⇧Enter" on macOS, "Ctrl+Shift+Enter" (or "Strg+Umschalt+Enter") elsewhere. */
export function primaryShiftShortcut(key: string): string {
  return isMac() ? `⌘⇧${key}` : `${t('Ctrl')}+${t('Shift')}+${key}`;
}

/** A key that is Control on every system: "⌃⇧1" on macOS, "Ctrl+Shift+1" (or "Strg+Umschalt+1") elsewhere. */
export function controlShiftShortcut(key: string): string {
  return isMac() ? `⌃⇧${key}` : `${t('Ctrl')}+${t('Shift')}+${key}`;
}
