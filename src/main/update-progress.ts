/**
 * The small "Installing" window, shown from the quit that installs an update until the installer
 * takes over (2.1.38). Before it, the app vanished on "Restart and install" and nothing was on
 * screen until the new version opened, about 100 s later on Windows.
 *
 * Every other window is gone by the time `will-quit` runs, so this is its own window. It holds no
 * preload and no Node: it only shows texts the main process gives it, in the app's colors.
 */
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { getConfig } from './config.js';
import { mainText } from './main-texts.js';
import { defaultAppearance } from '../shared/appearance.js';
import type { UpdateHandoffStep } from './update.js';

let progress: BrowserWindow | null = null;

const stepText = (step: UpdateHandoffStep): string => step === 'permission'
  ? mainText('Waiting for your permission in Windows…')
  : mainText('Starting the installer. Chat On Steroids opens again by itself.');

export function showUpdateProgress(version: string): void {
  if (progress && !progress.isDestroyed()) return;
  const ui = getConfig().ui;
  const theme = ui.theme === 'dark' ? 'dark' : 'light';
  const palette = (ui.appearance ?? defaultAppearance())[theme];
  const win = new BrowserWindow({
    // On top: the main window is already gone, and on Windows another app has the foreground by
    // then, so a plain window opened behind it (measured on the VM, 2026-10-15).
    width: 420, height: 176, frame: false, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
    fullscreenable: false, show: false, center: true, title: 'Chat On Steroids', backgroundColor: palette.background,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  progress = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => { if (progress === win && !win.isDestroyed()) { win.show(); win.moveTop(); } });
  win.on('closed', () => { if (progress === win) progress = null; });
  const query = {
    version, title: mainText('Updating Chat On Steroids'), step: mainText('Saving your work…'),
    theme, background: palette.background, accent: palette.accent, lang: ui.language ?? 'en'
  };
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}/`;
    const url = new URL('update-progress.html', base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void win.loadURL(url.toString()).catch(() => undefined);
  } else void win.loadFile(path.join(__dirname, '../renderer/update-progress.html'), { query }).catch(() => undefined);
}

/**
 * Resolves once the installer has taken over. In update mode it closes the running app (taskkill)
 * when its own progress page shows, which closes this window; a silent or failed installer never
 * does, so the wait is bounded.
 */
export function untilInstallerTakesOver(timeoutMs = 90_000): Promise<void> {
  const win = progress;
  if (!win || win.isDestroyed()) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    win.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

/** Says the handoff's current step in the open window; without one there is nothing to say. */
export function setUpdateProgressStep(step: UpdateHandoffStep): void {
  if (!progress || progress.isDestroyed()) return;
  // Once the installer runs, its own pages and messages must not sit behind this window.
  if (step === 'installer') progress.setAlwaysOnTop(false);
  void progress.webContents.executeJavaScript(`window.cosUpdateStep?.(${JSON.stringify(stepText(step))})`).catch(() => undefined);
}

export function resetUpdateProgressForTests(): void {
  progress = null;
}
