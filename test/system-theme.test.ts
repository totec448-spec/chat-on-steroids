import { beforeEach, expect, it, vi } from 'vitest';

/**
 * #1914: with the System theme, the parts Electron draws (window background, Windows title bar,
 * the pets) follow the operating system when it switches, not only after the next settings save.
 */
const system = vi.hoisted(() => ({ dark: false, listeners: [] as Array<() => void> }));
vi.mock('electron', () => ({
  nativeTheme: {
    get shouldUseDarkColors() { return system.dark; },
    on: (_event: string, listener: () => void) => { system.listeners.push(listener); },
    off: (_event: string, listener: () => void) => { system.listeners = system.listeners.filter(entry => entry !== listener); }
  }
}));
const pets = { refreshed: 0 };

const { shownTheme, watchSystemTheme } = await import('../src/main/theme.js');
const { windowBackgroundForTheme } = await import('../src/main/window-layout.js');
const { defaultAppearance } = await import('../src/shared/appearance.js');

beforeEach(() => { system.dark = false; system.listeners = []; pets.refreshed = 0; });

const switchTo = (dark: boolean) => { system.dark = dark; for (const listener of system.listeners) listener(); };

it('shows the system\'s theme for System, and the chosen one otherwise', () => {
  system.dark = true;
  expect(shownTheme('system')).toBe('dark');
  expect(shownTheme('light')).toBe('light');
  system.dark = false;
  expect(shownTheme('system')).toBe('light');
  expect(shownTheme('dark')).toBe('dark');
});

it('repaints the window and the pets when the system switches, only while the choice is System', () => {
  let ui = { theme: 'system' as 'system' | 'light' | 'dark', appearance: defaultAppearance() };
  const win = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false };
  const stop = watchSystemTheme(() => ui as never, () => win as never, () => { pets.refreshed++; });
  switchTo(true);
  expect(win.setBackgroundColor).toHaveBeenLastCalledWith(windowBackgroundForTheme('dark', ui.appearance));
  expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(process.platform === 'win32' ? 1 : 0);
  switchTo(false);
  expect(win.setBackgroundColor).toHaveBeenLastCalledWith(windowBackgroundForTheme('light', ui.appearance));
  expect(pets.refreshed).toBe(2);
  // A fixed theme stays as chosen.
  ui = { ...ui, theme: 'dark' };
  switchTo(true);
  expect(win.setBackgroundColor).toHaveBeenCalledTimes(2);
  // A closed window is left alone; the watch ends when asked.
  ui = { ...ui, theme: 'system' };
  win.isDestroyed = () => true;
  switchTo(false);
  expect(win.setBackgroundColor).toHaveBeenCalledTimes(2);
  expect(pets.refreshed).toBe(3);
  stop();
  expect(system.listeners).toHaveLength(0);
});
