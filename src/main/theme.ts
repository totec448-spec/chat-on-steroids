import { nativeTheme, type BrowserWindow } from 'electron';
import { resolveTheme, type AppearanceTheme, type ThemeChoice } from '../shared/appearance.js';
import type { UiPrefs } from '../shared/types.js';
import { titleBarOverlayForTheme, windowBackgroundForTheme } from './window-layout.js';

/**
 * The theme the app shows now (#1914). "System" follows the operating system: Electron's own
 * `nativeTheme` says which, since `themeSource` is set to the same choice.
 */
export function shownTheme(choice: ThemeChoice | undefined): AppearanceTheme {
  return resolveTheme(choice, nativeTheme.shouldUseDarkColors === true);
}

/** The parts Electron draws in the theme shown now: window background and Windows title bar. */
export function paintWindowTheme(ui: UiPrefs, win: BrowserWindow | null): void {
  const theme = shownTheme(ui.theme);
  if (win && !win.isDestroyed()) {
    if (process.platform === 'win32') win.setTitleBarOverlay(titleBarOverlayForTheme(theme, ui.appearance));
    // BrowserWindow's native backing color is fixed at construction unless updated explicitly. An
    // old opposite background otherwise flashes behind the renderer while it paints again.
    win.setBackgroundColor(windowBackgroundForTheme(theme, ui.appearance));
  }
}

/** With "System", repaints the window, and `also` the rest, when the operating system switches. */
export function watchSystemTheme(ui: () => UiPrefs, win: () => BrowserWindow | null, also: () => void = () => {}): () => void {
  const changed = (): void => {
    const current = ui();
    if (current.theme !== 'system') return;
    paintWindowTheme(current, win());
    also();
  };
  nativeTheme.on('updated', changed);
  return () => { nativeTheme.off('updated', changed); };
}
