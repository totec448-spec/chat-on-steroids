import { beforeEach, expect, it, vi } from 'vitest';

/**
 * CodeRabbit on #1864 (Haz's keyboard condition): the corner panel never takes the focus, so Tab
 * cannot reach it. While it waits, the app's own window shows the same question, which a keyboard
 * or screen-reader user can switch to and answer; an answer in either place closes both.
 */
const electron = vi.hoisted(() => ({ windows: [] as any[], answerListeners: [] as Array<(event: unknown, choice: unknown) => void>, nativeTheme: { shouldUseDarkColors: false }, theme: 'dark' }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    dead = false;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => {}, executeJavaScript: async () => 118 });
    constructor(readonly options: Record<string, unknown>) { super(); electron.windows.push(this); }
    setAlwaysOnTop() {} showInactive() {}
    workspaces = 0;
    setVisibleOnAllWorkspaces() { this.workspaces++; }
    getBounds() { return { x: 0, y: 0, width: 360, height: 118 }; } setBounds() {}
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    loadFile() { return Promise.resolve(); } loadURL() { return Promise.resolve(); }
  }
  return {
    BrowserWindow: Window,
    nativeTheme: electron.nativeTheme,
    ipcMain: { on: (_channel: string, listener: any) => electron.answerListeners.push(listener),
      removeListener: (_channel: string, listener: any) => { electron.answerListeners = electron.answerListeners.filter(entry => entry !== listener); } },
    powerMonitor: { getSystemIdleState: () => 'active', getSystemIdleTime: () => 0 },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }) }
  };
});
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { theme: electron.theme, language: 'en', desktopAsk: 'always' } }) }));
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCaller: () => ({}) }));
vi.mock('../src/main/session/store.js', () => ({ getSession: async () => null, findSessionByConversation: async () => null }));

const { answerDesktopAsk, currentDesktopAsk, mirrorDesktopAsk, showDesktopAskPrompt } = await import('../src/main/desktop-ask-window.js');

const shown: unknown[] = [];
beforeEach(() => { electron.windows.length = 0; shown.length = 0; mirrorDesktopAsk(pending => shown.push(pending)); });

it('shows the waiting question in the app too, and an answer there closes the corner panel', async () => {
  const answer = showDesktopAskPrompt({ words: 'launch', app: 'notepad.exe', chat: 'Release notes' });
  expect(shown).toEqual([{ id: expect.any(String), title: 'Chat On Steroids wants to use your mouse and keyboard', step: 'Open notepad.exe', chat: 'Release notes' }]);
  const { id } = shown[0] as { id: string };
  expect(currentDesktopAsk()).toEqual(shown[0]);
  // CodeRabbit on #1864: a macOS panel is on every space already; the extra call made the Dock flicker.
  expect(electron.windows[0].workspaces).toBe(0);
  expect(answerDesktopAsk(id, 'go')).toBe(true);
  expect(await answer).toBe('go');
  expect(electron.windows[0].dead).toBe(true);
  expect(shown.at(-1)).toBeNull();
  expect(currentDesktopAsk()).toBeNull();
  // A late or repeated answer changes nothing.
  expect(answerDesktopAsk(id, 'not-now')).toBe(false);
});

it('takes Not now from the app, and an answer in the corner panel clears the app\'s question', async () => {
  const declined = showDesktopAskPrompt({ words: 'click', app: null, chat: null });
  const { id } = shown[0] as { id: string };
  expect(answerDesktopAsk(id, 'not-now')).toBe(true);
  expect(await declined).toBe('not-now');
  const allowed = showDesktopAskPrompt({ words: 'type', app: null, chat: null });
  const panel = electron.windows.at(-1);
  for (const listener of [...electron.answerListeners]) listener({ sender: panel.webContents }, 'go');
  expect(await allowed).toBe('go');
  expect(shown.at(-1)).toBeNull();
  // An id that was never asked, or anything else, answers nothing.
  expect(answerDesktopAsk('nope', 'go')).toBe(false);
});

// #1914: with Same as system, the corner question uses the theme the system shows now.
it('draws the corner question in the system\'s theme with Same as system', async () => {
  const { desktopAskColors } = await import('../src/shared/desktop-ask.js');
  const { defaultAppearance } = await import('../src/shared/appearance.js');
  electron.theme = 'system';
  for (const dark of [true, false]) {
    electron.nativeTheme.shouldUseDarkColors = dark;
    const answer = showDesktopAskPrompt({ words: 'click', app: null, chat: null });
    expect(electron.windows.at(-1).options.backgroundColor).toBe(desktopAskColors(defaultAppearance(), dark ? 'dark' : 'light').background);
    answerDesktopAsk((shown.at(-1) as { id: string }).id, 'not-now');
    await answer;
  }
  electron.theme = 'dark'; electron.nativeTheme.shouldUseDarkColors = false;
});
