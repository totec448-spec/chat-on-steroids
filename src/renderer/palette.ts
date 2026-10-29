/**
 * ⌘K / Ctrl+K also runs actions (#1884, Haz's review): the chat search stays first and unchanged
 * while nothing is typed; typing adds a short, curated Actions section (and Settings matches) under
 * the chats. An action is one the app's menus and shortcuts already offer, named as they name it,
 * and nothing runs without Enter or a click.
 */

export interface PaletteAction {
  /** The name, in the interface language (the menus' and shortcuts' own string). */
  label(): string;
  /** Its keyboard shortcut as the shortcuts dialog prints it, if it has one. */
  keys?(): string[];
  /** Whether it applies right now (a chat open, a project chosen); left out when not. */
  available?(): boolean;
  run(): void;
}

/** Few enough that the chats stay the point of the dialog. */
export const MAX_ACTIONS = 4;

/** Case and accents fold away, so "Ubersicht" finds "Übersicht". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
}

/** Whether every word typed starts a word of the name ("rev" finds "Review", "review" not "Preview"). */
export function matchesWords(name: string, query: string): boolean {
  const typed = fold(query).split(/\s+/).filter(Boolean);
  if (!typed.length) return false;
  const words = fold(name).split(/[\s\-/›·,.:;()]+/).filter(Boolean);
  return typed.every(part => words.some(word => word.startsWith(part)));
}

/** The actions whose name matches every word typed, in their own order; none before anything is typed. */
export function matchActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  return actions.filter(action => (!action.available || action.available()) && matchesWords(action.label(), query)).slice(0, MAX_ACTIONS);
}
