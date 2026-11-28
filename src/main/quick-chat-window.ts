import path from 'node:path';
import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import { getConfig } from './config.js';
import { getSession } from './session/store.js';
import { shownTheme } from './theme.js';
import { logInfo, logWarn } from './logger.js';
import { quickChatBounds, QUICK_CHAT_PARTITION } from '../shared/quick-chat.js';
import { initializeQuickChatShortcut, disposeQuickChatShortcut } from './quick-chat-shortcut.js';
import { defaultAppearance, effectivePalette } from '../shared/appearance.js';
import { isUnattributedSession } from '../shared/session.js';

/** One auxiliary window; the outbox and session store remain the only execution owners. */
export function createQuickChat(options: { hasWorkspace(): boolean; workspaceContents?(): Electron.WebContents | null; openWorkspace(id: string | null): boolean }) {
  let win: BrowserWindow | null = null;
  let active = false;
  let lastBounds: Electron.Rectangle | null = null;
  let awaitingReady: BrowserWindow | null = null;
  let requestedSession: string | null = null;
  const live = () => win && !win.isDestroyed() ? win : null;
  const keepResident = () => process.platform === 'darwin' || getConfig().ui.minimizeToTray || options.hasWorkspace();
  const hide = (owner: BrowserWindow): void => { requestedSession = null; if (keepResident()) owner.hide(); else owner.destroy(); };
  const notify = (channel: string, ...args: unknown[]): void => {
    if (!['session:changed', 'chatModels:changed', 'state:changed', 'sessions:backgroundExecChanged', 'swarm:changed', 'task:progress'].includes(channel)) return;
    const target = live();
    if (target?.isVisible() && !target.webContents.isDestroyed()) {
      try { target.webContents.send(channel, ...args); }
      catch { logWarn('quick chat: renderer update could not be delivered'); }
    }
  };
  const showPanel = (owner: BrowserWindow): void => {
    if (requestedSession !== null) { owner.webContents.send('session:write', requestedSession); requestedSession = null; }
    if (!owner.isVisible()) owner.show();
    else owner.webContents.send('quick-chat:shown');
    owner.focus();
  };
  const toggleWindow = (sessionId?: string): boolean => {
    if (!active || awaitingReady) { logWarn('quick chat: open skipped because the controller is inactive or the renderer is initializing'); return false; }
    const existing = live();
    if (!sessionId && existing?.isVisible() && existing.isFocused()) { hide(existing); return true; }
    requestedSession = sessionId ?? null;
    const config = getConfig();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const bounds = existing?.isVisible() ? existing.getBounds() : quickChatBounds(area, lastBounds);
    if (existing) {
      if (!existing.isVisible()) {
        const previous = existing.getBounds();
        if (previous.x !== bounds.x || previous.y !== bounds.y || previous.width !== bounds.width || previous.height !== bounds.height) existing.setBounds(bounds);
      }
      showPanel(existing); return true;
    }
    const owner = new BrowserWindow({ ...bounds, minWidth: Math.min(360, area.width), minHeight: Math.min(380, area.height),
      show: false, frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true,
      fullscreenable: false, maximizable: false, minimizable: false,
      backgroundColor: effectivePalette(config.ui.appearance ?? defaultAppearance(), shownTheme(config.ui.theme)).background,
      webPreferences: { preload: path.join(__dirname, '../preload/index.js'), partition: QUICK_CHAT_PARTITION, contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false } });
    win = owner;
    awaitingReady = owner;
    logInfo('quick chat: waiting for compact renderer readiness before showing the panel');
    const startupDeadline = setTimeout(() => {
      if (awaitingReady === owner && !owner.isDestroyed()) { logWarn('quick chat: renderer initialization timed out'); owner.destroy(); }
    }, 10000);
    owner.webContents.setWindowOpenHandler(() => { logWarn('quick chat: new renderer window refused'); return { action: 'deny' }; });
    owner.webContents.on('will-navigate', event => { event.preventDefault(); logWarn('quick chat: renderer navigation refused'); });
    owner.webContents.on('will-redirect', event => { event.preventDefault(); logWarn('quick chat: renderer redirect refused'); });
    owner.webContents.on('will-attach-webview', event => { event.preventDefault(); logWarn('quick chat: renderer webview refused'); });
    owner.on('close', event => { if (active && keepResident()) { event.preventDefault(); hide(owner); } });
    owner.on('hide', () => { if (!owner.isDestroyed()) lastBounds = owner.getBounds(); requestedSession = null; });
    owner.on('closed', () => { clearTimeout(startupDeadline); if (awaitingReady === owner) awaitingReady = null; if (win === owner) { win = null; requestedSession = null; } });
    owner.on('show', () => { if (live() === owner && owner.isVisible()) owner.webContents.send('quick-chat:shown'); });
    const load = process.env.ELECTRON_RENDERER_URL
      ? owner.loadURL(new URL('quick-chat.html', process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : process.env.ELECTRON_RENDERER_URL + '/').toString())
      : owner.loadFile(path.join(__dirname, '../renderer/quick-chat.html'));
    void load.catch(() => { logWarn('quick chat: renderer could not load'); if (!owner.isDestroyed()) owner.destroy(); });
    return true;
  };
  const toggle = (): void => { try { toggleWindow(); } catch { logWarn('quick chat: could not open panel'); } };
  const owns = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const owner = live();
    if (!active || !owner || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) {
      logWarn('quick chat: window action refused because the sender is not the compact main frame');
      throw new Error('Quick chat is not available');
    }
    return owner;
  };
  const channels = ['quick-chat:hide', 'quick-chat:pin', 'quick-chat:expand', 'quick-chat:ready', 'quick-chat:open-session'];
  const register = (): void => {
    if (active) return;
    active = true;
    ipcMain.handle('quick-chat:hide', event => hide(owns(event)));
    ipcMain.handle('quick-chat:pin', (event, pinned: unknown) => {
      const owner = owns(event);
      if (typeof pinned !== 'boolean') { logWarn('quick chat: pin refused because the value is invalid'); throw new Error('Invalid pin value'); }
      owner.setAlwaysOnTop(pinned);
      const actual = owner.isAlwaysOnTop();
      if (actual !== pinned) logWarn('quick chat: the window manager did not accept the pin preference');
      return actual;
    });
    ipcMain.handle('quick-chat:expand', async (event, id: unknown) => {
      const owner = owns(event);
      if (id !== null && (typeof id !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(id) || !await getSession(id))) { logWarn('quick chat: expand refused because the chat is unavailable'); return false; }
      if (live() !== owner || !active || event.senderFrame !== owner.webContents.mainFrame) { logWarn('quick chat: expand refused because window ownership changed'); return false; }
      if (!options.openWorkspace(id as string | null)) { logWarn('quick chat: expand refused because Workspace could not be opened'); return false; }
      owner.hide(); return true;
    });
    ipcMain.handle('quick-chat:ready', event => {
      const owner = owns(event);
      if (awaitingReady !== owner) { logWarn('quick chat: duplicate renderer readiness ignored'); return; }
      awaitingReady = null;
      showPanel(owner);
    });
    ipcMain.handle('quick-chat:open-session', async (event, id: unknown) => {
      const unavailable = () => ({ ok: false, error: 'Quick chat is not available' });
      const notFound = () => ({ ok: false, error: 'Chat not found' });
      const workspace = options.workspaceContents?.();
      if (!active || !workspace || event.sender !== workspace || event.senderFrame !== workspace.mainFrame) { logWarn('quick chat: open-session refused because the sender is not the Workspace main frame'); return unavailable(); }
      if (typeof id !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(id)) { logWarn('quick chat: open-session refused because the chat id is invalid'); return notFound(); }
      const target = await getSession(id);
      if (!target || isUnattributedSession(target)) { logWarn('quick chat: open-session refused because the chat is missing or unattributed'); return notFound(); }
      if (!active || options.workspaceContents?.() !== workspace || workspace.isDestroyed() || event.senderFrame !== workspace.mainFrame || awaitingReady) { logWarn('quick chat: open-session refused because the Workspace changed or the panel is initializing'); return unavailable(); }
      return toggleWindow(id) ? { ok: true, data: true } : unavailable();
    });
    initializeQuickChatShortcut(globalShortcut, toggle, getConfig().ui);
  };
  const dispose = (): void => {
    if (!active) return;
    active = false;
    requestedSession = null;
    disposeQuickChatShortcut();
    for (const channel of channels) ipcMain.removeHandler(channel);
    live()?.destroy();
  };
  const workspaceClosed = (): void => { const owner = live(); if (owner && !owner.isVisible() && !keepResident()) owner.destroy(); };
  return { register, toggle, notify, dispose, workspaceClosed };
}
