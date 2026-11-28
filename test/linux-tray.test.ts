import { expect, it, vi } from 'vitest';
import { closeActionForWindow } from '../src/main/window-lifecycle.js';
import { parseNameHasOwner, linuxTrayReachable } from '../src/main/linux-tray.js';

// Found while reading the Linux close path: with "minimize to tray" on (the default), closing the window hides it. A stock
// GNOME session has no tray, so the window then has no way back and the app looks gone while it keeps running. With no tray
// reachable the window is minimized instead; with one, or when that cannot be told, nothing changes.
const base = { platform: 'linux' as NodeJS.Platform, minimizeToTray: true, quitting: false, trayReachable: true as boolean | null };
it('hides to the tray when one is reachable, and when that cannot be told', () => {
  expect(closeActionForWindow(base)).toBe('hide');
  expect(closeActionForWindow({ ...base, trayReachable: null })).toBe('hide');
});
it('minimizes instead of hiding on Linux when no tray is reachable', () => {
  expect(closeActionForWindow({ ...base, trayReachable: false })).toBe('minimize');
});
it('still closes when quitting or when close-to-tray is off, and never changes Windows or macOS', () => {
  expect(closeActionForWindow({ ...base, quitting: true, trayReachable: false })).toBe('close');
  expect(closeActionForWindow({ ...base, minimizeToTray: false, trayReachable: false })).toBe('close');
  expect(closeActionForWindow({ ...base, platform: 'win32', trayReachable: false })).toBe('hide');
  expect(closeActionForWindow({ ...base, platform: 'darwin', trayReachable: false })).toBe('hide');
});
it('reads dbus-send replies for NameHasOwner', () => {
  expect(parseNameHasOwner('method return time=1 sender=:1.1 -> destination=:1.2 serial=3 reply_serial=2\n   boolean true\n')).toBe(true);
  expect(parseNameHasOwner('method return time=1\n   boolean false\n')).toBe(false);
  expect(parseNameHasOwner('')).toBeNull();
  expect(parseNameHasOwner('Error org.freedesktop.DBus.Error.NoServer')).toBeNull();
});
it('finds a tray when either watcher name has an owner, and none when both are free', async () => {
  const answer = (owned: string[]) => vi.fn(async (name: string) => `   boolean ${owned.includes(name)}`);
  expect(await linuxTrayReachable(answer(['org.kde.StatusNotifierWatcher']))).toBe(true);
  expect(await linuxTrayReachable(answer(['org.freedesktop.StatusNotifierWatcher']))).toBe(true);
  expect(await linuxTrayReachable(answer([]))).toBe(false);
});
it('says it cannot tell when the bus tool fails or answers nonsense', async () => {
  expect(await linuxTrayReachable(async () => { throw new Error('ENOENT'); })).toBeNull();
  expect(await linuxTrayReachable(async () => 'garbage')).toBeNull();
  // One answer is enough to be sure of a tray, but "no" needs both names asked and answered.
  expect(await linuxTrayReachable(async name => { if (name.startsWith('org.kde')) return 'boolean false'; throw new Error('x'); })).toBeNull();
});
