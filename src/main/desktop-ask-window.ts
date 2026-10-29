/**
 * The ask-before-mouse-and-keyboard question on screen (#1804, Haz's review): one compact panel
 * in the top-right corner of the screen with the pointer, above other windows, that never takes
 * the focus from what the person is doing. It shows the step in words, the app it goes to when
 * the step names it, and the chat; Go ahead or Not now, and no answer in 60 s is Not now.
 *
 * Also the gate's real inputs: the setting, the system's idle time, and the asking chat's name.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserWindow, ipcMain, powerMonitor, screen } from 'electron';
import { getConfig } from './config.js';
import { mainText } from './main-texts.js';
import { currentCaller } from './mcp/call-context.js';
import { findSessionByConversation, getSession } from './session/store.js';
import { createDesktopAsk, stepLine, type DesktopAskCaller, type DesktopAskPrompt, type DesktopStepWords } from './desktop-ask.js';
import { ASK_ANSWER_MS, desktopAskColors, type DesktopAskMode, type DesktopAskPending } from '../shared/desktop-ask.js';
import { defaultAppearance } from '../shared/appearance.js';
import { shownTheme } from './theme.js';

const WIDTH = 360;
const HEIGHT = 118;
const MAX_HEIGHT = 240;
const MARGIN = 16;

/**
 * The panel never takes the focus, so Tab cannot reach it. While it waits, the app's own window shows
 * the same question (Haz's keyboard condition): a keyboard or screen-reader user switches to the app
 * and answers there. One question at a time (the gate queues them); an answer in either place ends it.
 */
let mirror: (pending: DesktopAskPending | null) => void = () => {};
let waiting: { pending: DesktopAskPending; answer(choice: 'go' | 'not-now'): void } | null = null;

/** Where the app's window learns of the waiting question, and of its end (null). */
export function mirrorDesktopAsk(show: (pending: DesktopAskPending | null) => void): void { mirror = show; }

/** The question waiting now, for a window that opens or reloads while it waits. */
export function currentDesktopAsk(): DesktopAskPending | null { return waiting?.pending ?? null; }

/** The app window's answer to the waiting question; false when that question is no longer waiting. */
export function answerDesktopAsk(id: string, choice: 'go' | 'not-now'): boolean {
  if (!waiting || waiting.pending.id !== id) return false;
  waiting.answer(choice);
  return true;
}

export function showDesktopAskPrompt(prompt: DesktopAskPrompt): Promise<'go' | 'not-now' | 'timeout'> {
  const ui = getConfig().ui;
  // Same as system (#1914) is the theme the system shows now.
  const theme = shownTheme(ui.theme);
  const palette = desktopAskColors(ui.appearance ?? defaultAppearance(), theme);
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
  // No setVisibleOnAllWorkspaces: a macOS panel is on every space already, and the call changes the
  // process type, which made the Dock flicker each time (CodeRabbit). Windows has no workspaces to join.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  return new Promise(resolve => {
    let settled = false;
    const finish = (answer: 'go' | 'not-now' | 'timeout'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener('desktop-ask:answer', onAnswer);
      if (waiting?.pending.id === pending.id) { waiting = null; mirror(null); }
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
    // As tall as its words, then shown without taking the focus.
    win.webContents.once('did-finish-load', () => {
      void win.webContents.executeJavaScript('document.querySelector(".desktop-ask").getBoundingClientRect().height')
        .catch(() => HEIGHT)
        .then(height => {
          if (win.isDestroyed()) return;
          win.setBounds({ ...win.getBounds(), height: Math.min(MAX_HEIGHT, Math.max(HEIGHT, Math.ceil(Number(height) || HEIGHT))) });
          win.showInactive();
        });
    });
    const pending: DesktopAskPending = { id: randomUUID(), title: mainText('Chat On Steroids wants to use your mouse and keyboard'),
      step: stepLine(prompt, mainText), chat: (prompt.chat ?? '').slice(0, 120) };
    waiting = { pending, answer: finish };
    mirror(pending);
    const query = {
      title: pending.title, step: pending.step, chat: pending.chat,
      go: mainText('Go ahead'), notNow: mainText('Not now'),
      theme, background: palette.background, accent: palette.accent, ink: palette.ink, soft: palette.soft, edge: palette.edge,
      hover: palette.hover, lang: ui.language ?? 'en'
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
