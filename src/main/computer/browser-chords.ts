/**
 * Keyboard chords that manage a browser's tabs or windows rather than the page inside them.
 *
 * Pure and Windows-agnostic on purpose: the desktop tool decides which window the keys would
 * reach; this only says whether the chord is one a browser takes for itself, and whether a
 * process is a browser. The chord list is Chrome's, which Edge, Brave and the rest share.
 */

const MODIFIERS = new Set(['ctrl', 'shift', 'alt']);

const KEY_ALIASES: Record<string, string> = {
  control: 'ctrl',
  pgup: 'pageup',
  page_up: 'pageup',
  pgdn: 'pagedown',
  page_down: 'pagedown',
  arrowleft: 'left',
  arrowright: 'right'
};

const BROWSER_TAB_CHORDS = new Set([
  'ctrl+w',
  'ctrl+shift+w',
  'ctrl+f4',
  'alt+f4',
  'ctrl+t',
  'ctrl+shift+t',
  'ctrl+n',
  'ctrl+shift+n',
  'ctrl+tab',
  'ctrl+shift+tab',
  'ctrl+pageup',
  'ctrl+pagedown',
  'ctrl+shift+q',
  'ctrl+l',
  'alt+d',
  'alt+left',
  'alt+right',
  'alt+home',
  ...Array.from({ length: 9 }, (_, index) => `ctrl+${index + 1}`)
]);

const BROWSER_PROCESSES = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium', 'arc']);

/** The normalized chord when it is one a browser takes for tab or window management, else null. */
export function browserTabChord(keys: readonly string[]): string | null {
  const parts = keys
    .map((key) => key.trim().toLowerCase())
    .map((key) => KEY_ALIASES[key] ?? key)
    .filter(Boolean);
  const modifiers = new Set(parts.filter((key) => MODIFIERS.has(key)));
  const rest = parts.filter((key) => !MODIFIERS.has(key));
  if (rest.length !== 1) return null;
  const chord = [modifiers.has('ctrl') && 'ctrl', modifiers.has('alt') && 'alt', modifiers.has('shift') && 'shift', rest[0]]
    .filter((part): part is string => typeof part === 'string')
    .join('+');
  return BROWSER_TAB_CHORDS.has(chord) ? chord : null;
}

/** Whether a window's process name is a web browser. */
export function isBrowserProcess(process: string): boolean {
  return BROWSER_PROCESSES.has(process.trim().toLowerCase().replace(/\.exe$/, ''));
}
