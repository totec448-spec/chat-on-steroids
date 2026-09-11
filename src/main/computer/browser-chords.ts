/**
 * Keyboard chords that manage a browser's tabs or windows rather than the page inside them.
 *
 * Pure and host-agnostic on purpose: the desktop tool decides which window the keys would
 * reach; this only says whether the chord is one a browser takes for itself, and whether a
 * process is a browser. The chord list is Chrome's, which Edge, Brave, Safari and the rest
 * share, in both its Windows/Linux (ctrl/alt) and its macOS (command/option) spelling. Both
 * spellings are refused on every host: the model's key names decide, not the host, and a
 * ctrl+tab still switches tabs in a Mac browser.
 */

const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'cmd']);

const KEY_ALIASES: Record<string, string> = {
  control: 'ctrl',
  control_l: 'ctrl',
  control_r: 'ctrl',
  ctrl_l: 'ctrl',
  ctrl_r: 'ctrl',
  shift_l: 'shift',
  shift_r: 'shift',
  alt_l: 'alt',
  alt_r: 'alt',
  super_l: 'cmd',
  super_r: 'cmd',
  meta_l: 'cmd',
  meta_r: 'cmd',
  option: 'alt',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  windows: 'cmd',
  pgup: 'pageup',
  page_up: 'pageup',
  prior: 'pageup',
  kp_prior: 'pageup',
  numpad_prior: 'pageup',
  pgdn: 'pagedown',
  page_down: 'pagedown',
  next: 'pagedown',
  kp_next: 'pagedown',
  numpad_next: 'pagedown',
  kp_left: 'left',
  numpad_left: 'left',
  kp_right: 'right',
  numpad_right: 'right',
  kp_home: 'home',
  numpad_home: 'home',
  arrowleft: 'left',
  arrowright: 'right',
  bracketleft: '[',
  bracketright: ']'
};

const BROWSER_TAB_CHORDS = new Set([
  // Windows / Linux
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
  'alt+left',
  'alt+right',
  'alt+home',
  ...Array.from({ length: 9 }, (_, index) => `ctrl+${index + 1}`),
  // macOS — close/quit/hide, new tab/window, switch tab, history
  'cmd+w',
  'cmd+shift+w',
  'cmd+q',
  'cmd+h',
  'cmd+alt+h',
  'cmd+t',
  'cmd+shift+t',
  'cmd+n',
  'cmd+shift+n',
  'cmd+shift+]',
  'cmd+shift+[',
  'cmd+alt+left',
  'cmd+alt+right',
  'cmd+[',
  'cmd+]',
  ...Array.from({ length: 9 }, (_, index) => `cmd+${index + 1}`)
]);

/**
 * Process names as Windows reports them (image name, `.exe` stripped) and as macOS reports them
 * (the window owner's application name: "Google Chrome", "Brave Browser", "Safari").
 */
export const BROWSER_PROCESS_PATTERN =
  /(^|[\s_-])(chrome|chromium|msedge|edge|firefox|brave|opera|vivaldi|arc|safari)([\s_-]|$)/;

/** The normalized chord when it is one a browser takes for tab or window management, else null. */
export function browserTabChord(keys: readonly string[]): string | null {
  const parts = keys
    .map((key) => key.trim().toLowerCase())
    .map((key) => KEY_ALIASES[key] ?? key)
    .filter(Boolean);
  const modifiers = new Set(parts.filter((key) => MODIFIERS.has(key)));
  const rest = parts.filter((key) => !MODIFIERS.has(key));
  if (rest.length !== 1) return null;
  const chord = [
    modifiers.has('cmd') && 'cmd',
    modifiers.has('ctrl') && 'ctrl',
    modifiers.has('alt') && 'alt',
    modifiers.has('shift') && 'shift',
    rest[0]
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('+');
  return BROWSER_TAB_CHORDS.has(chord) ? chord : null;
}

/** Whether a window's process name is a web browser. */
export function isBrowserProcess(process: string): boolean {
  return BROWSER_PROCESS_PATTERN.test(process.trim().toLowerCase().replace(/\.exe$/, ''));
}
