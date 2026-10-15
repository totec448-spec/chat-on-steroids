import { beforeEach, expect, it, vi } from 'vitest';

/**
 * 2026-10-15: after "Restart and install" the app vanished and nothing was on screen until the
 * new version opened, about 100 s later on Windows. A small window in the app's own look now
 * says what is happening, from the quit until the installer takes over.
 */
const windows = vi.hoisted(() => [] as Array<{ options: Record<string, any>; loaded: { file: string; query: Record<string, string> } | null;
  scripts: string[]; shown: boolean; handlers: Record<string, () => void> }>);
vi.mock('electron', () => ({
  BrowserWindow: class {
    record: (typeof windows)[number];
    webContents: Record<string, unknown>;
    constructor(options: Record<string, any>) {
      this.record = { options, loaded: null, scripts: [], shown: false, handlers: {} };
      windows.push(this.record);
      const record = this.record;
      this.webContents = {
        executeJavaScript: async (code: string) => { record.scripts.push(code); },
        setWindowOpenHandler: () => undefined,
        on: () => undefined
      };
    }
    loadFile(file: string, options: { query: Record<string, string> }) { this.record.loaded = { file, query: options.query }; return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
    once(event: string, handler: () => void) { this.record.handlers[event] = handler; }
    on() { return this; }
    show() { this.record.shown = true; }
    isDestroyed() { return false; }
  }
}));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { theme: 'dark', language: 'de',
  appearance: { light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
    dark: { background: '#101418', sidebar: '#1a2129', accent: '#c0d0ee', contrast: 60 }, font: 'system', fontSize: 14, translucentSidebar: true } } }) }));
vi.mock('../src/main/main-texts.js', () => ({ mainText: (text: string) => `[${text}]` }));

const { showUpdateProgress, setUpdateProgressStep, resetUpdateProgressForTests } = await import('../src/main/update-progress.js');

beforeEach(() => { windows.length = 0; resetUpdateProgressForTests(); });

it('opens a small window in the app\'s own colors and language, isolated like every other page', async () => {
  showUpdateProgress('2.1.39');
  expect(windows).toHaveLength(1);
  const { options, loaded } = windows[0]!;
  expect(options).toMatchObject({ frame: false, resizable: false, show: false, backgroundColor: '#101418', title: 'Chat On Steroids' });
  expect(options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
  expect(options.webPreferences.preload).toBeUndefined();
  expect(loaded!.file).toMatch(/renderer[\\/]update-progress\.html$/);
  expect(loaded!.query).toEqual({ version: '2.1.39', title: '[Updating Chat On Steroids]', step: '[Saving your work…]',
    theme: 'dark', background: '#101418', accent: '#c0d0ee', lang: 'de' });
  windows[0]!.handlers['ready-to-show']!();
  expect(windows[0]!.shown).toBe(true);
  // A second quit request keeps the one window.
  showUpdateProgress('2.1.39');
  expect(windows).toHaveLength(1);
});

it('says each step of the handoff in the open window', async () => {
  setUpdateProgressStep('permission');
  expect(windows).toHaveLength(0);
  showUpdateProgress('2.1.39');
  setUpdateProgressStep('permission');
  setUpdateProgressStep('installer');
  await Promise.resolve();
  expect(windows[0]!.scripts).toEqual([
    `window.cosUpdateStep?.(${JSON.stringify('[Waiting for your permission in Windows…]')})`,
    `window.cosUpdateStep?.(${JSON.stringify('[Starting the new version. Chat On Steroids opens again by itself.]')})`
  ]);
});
