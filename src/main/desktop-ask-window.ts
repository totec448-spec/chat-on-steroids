/**
 * The ask-before-mouse-and-keyboard question on screen (#1804, Haz's review): one compact panel
 * in the top-right corner of the screen with the pointer, above other windows, that never takes
 * the focus from what the person is doing. It shows the step in words, the app it goes to when
 * the step names it, and the chat; Go ahead or Not now, and no answer in 60 s is Not now.
 *
 * Also the gate's real inputs: the setting, the system's idle time, and the asking chat's name.
 */
import path from 'node:path';
import { BrowserWindow, ipcMain, powerMonitor, screen } from 'electron';
import { getConfig } from './config.js';
import { mainText } from './main-texts.js';
import { currentCaller } from './mcp/call-context.js';
import { findSessionByConversation, getSession } from './session/store.js';
import { createDesktopAsk, type DesktopAskCaller, type DesktopAskPrompt, type DesktopStepWords } from './desktop-ask.js';
import { ASK_ANSWER_MS, type DesktopAskMode } from '../shared/desktop-ask.js';
import { defaultAppearance } from '../shared/appearance.js';
import type { MainText } from '../shared/main-texts.js';

const WIDTH = 360;
const HEIGHT = 118;
const MARGIN = 16;

const STEP_TEXT: Record<DesktopStepWords, MainText> = {
  click: 'Click', 'double-click': 'Double-click', type: 'Type', keys: 'Press keys', scroll: 'Scroll', drag: 'Drag',
  move: 'Move the pointer', focus: 'Switch windows', launch: 'Open an app', input: 'Use the mouse and keyboard'
};

/** The step in words, with its app when the step names one: "Click in Notepad". */
export function stepLine(prompt: Pick<DesktopAskPrompt, 'words' | 'app'>): string {
  const step = mainText(STEP_TEXT[prompt.words]);
  return prompt.app ? mainText('{0} in {1}').replace('{0}', step).replace('{1}', prompt.app.slice(0, 80)) : step;
}

export function showDesktopAskPrompt(prompt: DesktopAskPrompt): Promise<'go' | 'not-now' | 'timeout'> {
  const ui = getConfig().ui;
  const theme = ui.theme === 'dark' ? 'dark' : 'light';
  const palette = (ui.appearance ?? defaultAppearance())[theme];
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const win = new BrowserWindow({
    x: Math.round(area.x + area.width - WIDTH - MARGIN), y: Math.round(area.y + MARGIN), width: WIDTH, height: HEIGHT,
    frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, show: false, title: 'Chat On Steroids', backgroundColor: palette.background,
    // Never takes the focus: a non-activating panel on macOS, a window that is not activated by a click on Windows.
    ...(process.platform === 'darwin' ? { type: 'panel' } : { focusable: false }),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, preload: path.join(__dirname, '../preload/desktop-ask.js') }
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  return new Promise(resolve => {
    let settled = false;
    const finish = (answer: 'go' | 'not-now' | 'timeout'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener('desktop-ask:answer', onAnswer);
      if (!win.isDestroyed()) win.destroy();
      resolve(answer);
    };
    const onAnswer = (event: Electron.IpcMainEvent, choice: unknown): void => {
      if (win.isDestroyed() || event.sender !== win.webContents) return;
      finish(choice === 'go' ? 'go' : 'not-now');
    };
    const timer = setTimeout(() => finish('timeout'), ASK_ANSWER_MS);
    ipcMain.on('desktop-ask:answer', onAnswer);
    // Closed some other way (the system, a crash): nothing was allowed.
    win.on('closed', () => finish('not-now'));
    win.webContents.on('render-process-gone', () => finish('not-now'));
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
    const query = {
      title: mainText('Chat On Steroids wants to use your mouse and keyboard'), step: stepLine(prompt), chat: (prompt.chat ?? '').slice(0, 120),
      go: mainText('Go ahead'), notNow: mainText('Not now'),
      theme, background: palette.background, accent: palette.accent, lang: ui.language ?? 'en'
    };
    if (process.env.ELECTRON_RENDERER_URL) {
      const base = process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}/`;
      const url = new URL('desktop-ask.html', base);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      void win.loadURL(url.toString()).catch(() => finish('not-now'));
    } else void win.loadFile(path.join(__dirname, '../renderer/desktop-ask.html'), { query }).catch(() => finish('not-now'));
  });
}

/** The setting where the app can tell idle time and drive input; elsewhere it never asks. */
function desktopAskMode(): DesktopAskMode {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'off';
  return getConfig().ui.desktopAsk ?? 'off';
}

function systemIdle(): { lastInputAt: number | null; locked: boolean } {
  try {
    const state = powerMonitor.getSystemIdleState(1);
    if (state === 'unknown') return { lastInputAt: null, locked: false };
    return { lastInputAt: Date.now() - powerMonitor.getSystemIdleTime() * 1000, locked: state === 'locked' };
  } catch {
    return { lastInputAt: null, locked: false };
  }
}

async function chatName(caller: DesktopAskCaller): Promise<string | null> {
  const summary = caller.sessionId ? await getSession(caller.sessionId)
    : caller.conversationId ? await findSessionByConversation(caller.conversationId, { requireUnique: true }) : null;
  return summary?.title ?? null;
}

let gate: ReturnType<typeof createDesktopAsk> | null = null;
const desktopAsk = (): ReturnType<typeof createDesktopAsk> => gate ??= createDesktopAsk({
  mode: desktopAskMode, now: Date.now, idle: systemIdle, prompt: showDesktopAskPrompt, chatName
});

/**
 * Before a desktop step that takes the real mouse or keyboard: null when it may run, else the
 * refusal to return instead. Call desktopStepEnded() once the step is over.
 */
export function askBeforeDesktopStep(words: DesktopStepWords, app: string | null): Promise<string | null> {
  const caller = currentCaller();
  return desktopAsk().admit({ words, app }, { sessionId: caller.sessionId ?? null, conversationId: caller.conversationId, transportKey: caller.transportKey });
}

export function desktopStepEnded(): void {
  gate?.stepEnded();
}
