import { execFile } from 'node:child_process';

/**
 * Whether anything on the session bus will show a tray icon. Linux has no tray of its own: the desktop must run a
 * StatusNotifier watcher (KDE, Cinnamon, XFCE and GNOME with the AppIndicator extension do; stock GNOME does not). Electron
 * creates the icon either way and cannot say whether anyone can see it, so a window hidden "to the tray" on such a desktop
 * could never be brought back.
 */
const WATCHERS = ['org.kde.StatusNotifierWatcher', 'org.freedesktop.StatusNotifierWatcher'] as const;

/** `true`/`false` from a `dbus-send ... NameHasOwner` reply; null for anything else. */
export function parseNameHasOwner(reply: string): boolean | null {
  const match = /boolean (true|false)/.exec(reply);
  return match ? match[1] === 'true' : null;
}

type AskBus = (name: string) => Promise<string>;

const dbusSend: AskBus = name => new Promise((resolve, reject) => {
  execFile('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
    'org.freedesktop.DBus.NameHasOwner', `string:${name}`], { timeout: 3000, windowsHide: true }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

/** true: a watcher owns a name. false: both names asked and free. null: could not tell (no tool, no bus, odd reply). */
export async function linuxTrayReachable(ask: AskBus = dbusSend): Promise<boolean | null> {
  const answers = await Promise.all(WATCHERS.map(name => ask(name).then(parseNameHasOwner, () => null)));
  if (answers.includes(true)) return true;
  return answers.every(answer => answer === false) ? false : null;
}
