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

/**
 * Hold-to-talk in the message box. Only Windows gets the chord, and only Windows names it. There
 * Ctrl+Space toggles Chinese IMEs, Shift+Space switches their character width and Alt+Space opens
 * the window menu, while Ctrl+Shift+Space is no Windows or IME default (pressing Space cancels a
 * Ctrl+Shift layout switch, as with the docks' Ctrl+Shift+1–4). macOS owns Ctrl+Space,
 * Ctrl+Option+Space, Cmd+Space and Ctrl+Cmd+Space, and IBus/Fcitx own Super+Space and Ctrl+Space
 * on Linux; dictation is Windows-only today, so those platforms would need their own pick.
 */
export function holdToTalkSupported(): boolean {
  return /^Win/.test(navigator.platform);
}

/** "Ctrl+Shift+Space" (or "Strg+Umschalt+Leertaste"): Ctrl on every system, as the chord is handled. */
export function holdToTalkShortcut(): string {
  return `${t('Ctrl')}+${t('Shift')}+${t('Space')}`;
}

/** A key that is Control on every system: "⌃⇧1" on macOS, "Ctrl+Shift+1" (or "Strg+Umschalt+1") elsewhere. */
export function controlShiftShortcut(key: string): string {
  return isMac() ? `⌃⇧${key}` : `${t('Ctrl')}+${t('Shift')}+${key}`;
}
