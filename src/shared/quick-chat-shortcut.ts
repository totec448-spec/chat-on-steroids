import { QUICK_CHAT_SHORTCUT } from './quick-chat.js';
export { QUICK_CHAT_SHORTCUT };

export interface QuickChatShortcutPreference {
  quickChatShortcutEnabled?: boolean;
  quickChatShortcut?: string;
}

export type QuickChatShortcutStatus = 'registered' | 'disabled' | 'unavailable' | 'pending';

const modifiers = new Map([
  ['commandorcontrol', 'CommandOrControl'], ['cmdorctrl', 'CommandOrControl'],
  ['control', 'Control'], ['ctrl', 'Control'], ['command', 'Command'], ['cmd', 'Command'],
  ['alt', 'Alt'], ['option', 'Alt'], ['shift', 'Shift'], ['super', 'Super'], ['meta', 'Super']
]);
const keys = ['Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Plus'];

/** A deliberately bounded subset of Electron accelerators; never reserve a plain typing key. */
export function normalizeQuickChatShortcut(value: string): string | null {
  if (value.length > 100) return null;
  const parts = value.split('+').map(part => part.trim().toLowerCase());
  const keyPart = parts.pop() ?? '';
  const key = /^[a-z0-9]$|^f(?:[1-9]|1[0-9]|2[0-4])$/.test(keyPart)
    ? keyPart.toUpperCase() : keys.find(candidate => candidate.toLowerCase() === keyPart);
  const mods = parts.map(part => modifiers.get(part));
  if (!key || mods.some(mod => !mod) || new Set(mods).size !== mods.length || !mods.some(mod => mod !== 'Shift')) return null;
  if (mods.includes('CommandOrControl') && (mods.includes('Command') || mods.includes('Control'))) return null;
  return [...['CommandOrControl', 'Control', 'Command', 'Super', 'Alt', 'Shift'].filter(mod => mods.includes(mod)), key].join('+');
}

export function isQuickChatShortcut(value: string): boolean {
  return normalizeQuickChatShortcut(value) !== null;
}

export function configuredQuickChatShortcut(prefs: QuickChatShortcutPreference): string {
  return normalizeQuickChatShortcut(prefs.quickChatShortcut ?? QUICK_CHAT_SHORTCUT) ?? QUICK_CHAT_SHORTCUT;
}
