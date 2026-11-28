import path from 'node:path';
import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import { effectiveCapabilities, getConfig } from './config.js';
import { getSession } from './session/store.js';
import { shownTheme } from './theme.js';
import { logWarn } from './logger.js';
import { createQuickChatContext } from './quick-chat-context.js';
import { buildSessionMarkdown } from './session/markdown-export.js';
import { quickChatBounds, QUICK_CHAT_PARTITION } from '../shared/quick-chat.js';
import { initializeQuickChatShortcut, disposeQuickChatShortcut } from './quick-chat-shortcut.js';
import { createQuickChatEffect } from './quick-chat-effect.js';
import type { QuickChatCapture } from '../shared/quick-chat.js';
import { defaultAppearance, effectivePalette } from '../shared/appearance.js';
import { isUnattributedSession } from '../shared/session.js';

/** One auxiliary window; the outbox and session store remain the only execution owners. */
export function createQuickChat(options: { hasWorkspace(): boolean; workspaceContents?(): Electron.WebContents | null; openWorkspace(id: string | null): void }) {
  let win: BrowserWindow | null = null;
  let active = false;
  let lastBounds: Electron.Rectangle | null = null;
  const context = createQuickChatContext();
  const effect = createQuickChatEffect();
  let automatic: { epoch: number; capture: Promise<QuickChatCapture | null>; claimed: boolean; control: boolean } | null = null;
  let contextEpoch = 0;
  let opening = false;
  let awaitingReady: BrowserWindow | null = null;
  let replacing = false;
  let requestedSession: string | null = null;
  let directOpen = false;
  const invalidateContext = (): void => { ++contextEpoch; context.clear(); automatic = null; requestedSession = null; directOpen = false; effect.clear(); };
  const live = () => win && !win.isDestroyed() ? win : null;
  const nativeHandle = (owner: BrowserWindow): number => {
    const handle = owner.getNativeWindowHandle();
    const id = handle.length >= 8 ? Number(handle.readBigUInt64LE()) : handle.readUInt32LE();
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Quick Chat window identity is unavailable');
    return id;
  };
  const keepResident = () => process.platform === 'darwin' || getConfig().ui.minimizeToTray || options.hasWorkspace();
  const hide = (owner: BrowserWindow): void => { invalidateContext(); if (keepResident()) owner.hide(); else owner.destroy(); };
  const notify = (channel: string, ...args: unknown[]): void => {
    if (!['session:changed', 'chatModels:changed', 'state:changed', 'sessions:backgroundExecChanged', 'swarm:changed', 'task:progress'].includes(channel)) return;
    if (channel === 'state:changed' && getConfig().ui.quickChatAutoCapture === false && automatic) {
      automatic = null; effect.clear();
    }
    const target = live();
    if (target?.isVisible() && !target.webContents.isDestroyed()) {
      try { target.webContents.send(channel, ...args); }
      catch { logWarn('quick chat: renderer update could not be delivered'); }
    }
  };
  const toggle = (): void => { void toggleWindow().catch(() => logWarn('quick chat: could not open panel')); };
  const showPanel = (owner: BrowserWindow): void => {
    if (requestedSession !== null) { owner.webContents.send('session:write', requestedSession); requestedSession = null; }
    if (!owner.isVisible()) owner.show();
    else owner.webContents.send('quick-chat:shown', contextEpoch, automatic !== null, directOpen);
    owner.focus();
  };
  const toggleWindow = async (sessionId?: string): Promise<void> => {
    if (!active || opening || replacing || awaitingReady) return;
    const existing = live();
    if (!sessionId && existing?.isVisible() && existing.isFocused()) { hide(existing); return; }
    opening = true;
    invalidateContext();
    const epoch = contextEpoch;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // A busy or unavailable desktop helper must not hold the ordinary chat window hostage.
      if (!sessionId) await Promise.race([context.remember(), new Promise<void>(resolve => {
        deadline = setTimeout(() => { context.seal(); resolve(); }, 1500);
      })]);
    } catch { context.seal(); }
    finally { if (deadline) clearTimeout(deadline); opening = false; }
    if (!active || contextEpoch !== epoch) return;
    requestedSession = sessionId ?? null;
    directOpen = sessionId !== undefined;
    const source = context.sourceWindow();
    // The shortcut itself requests context. Start the bounded observation before
    // moving focus, but do not hold the chat window open on a slow provider.
    const config = getConfig(), caps = effectiveCapabilities(config);
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const bounds = existing?.isVisible() ? existing.getBounds() : quickChatBounds(area, lastBounds);
    if (!sessionId && config.ui.quickChatAutoCapture !== false && caps.screen) {
      automatic = { epoch, claimed: false, control: caps.control, capture: source ? context.capture('screenshot').catch(() => null) : Promise.resolve(null) };
      void effect.show(source, bounds).catch(() => undefined);
    }
    if (existing) {
      if (existing.isDestroyed()) return;
      if (!existing.isVisible()) {
        const previous = existing.getBounds();
        if (previous.x !== bounds.x || previous.y !== bounds.y || previous.width !== bounds.width || previous.height !== bounds.height) existing.setBounds(bounds);
      }
      showPanel(existing); return;
    }
    const owner = new BrowserWindow({ ...bounds, minWidth: Math.min(360, area.width), minHeight: Math.min(380, area.height),
      show: false, frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true,
      fullscreenable: false, maximizable: false, minimizable: false,
      backgroundColor: effectivePalette(config.ui.appearance ?? defaultAppearance(), shownTheme(config.ui.theme)).background,
      webPreferences: { preload: path.join(__dirname, '../preload/index.js'), partition: QUICK_CHAT_PARTITION, contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false } });
    win = owner;
    awaitingReady = owner;
    const startupDeadline = setTimeout(() => {
      if (awaitingReady === owner && !owner.isDestroyed()) { logWarn('quick chat: renderer initialization timed out'); owner.destroy(); }
    }, 10000);
    owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    owner.webContents.on('will-navigate', event => event.preventDefault());
    owner.webContents.on('will-redirect', event => event.preventDefault());
    owner.webContents.on('will-attach-webview', event => event.preventDefault());
    owner.on('close', event => { if (active && keepResident()) { event.preventDefault(); hide(owner); } });
    owner.on('hide', () => { if (!owner.isDestroyed()) lastBounds = owner.getBounds(); if (!replacing) invalidateContext(); });
    owner.on('closed', () => { clearTimeout(startupDeadline); if (awaitingReady === owner) awaitingReady = null; if (win === owner) { win = null; invalidateContext(); } });
    const announce = () => { if (live() === owner && owner.isVisible()) owner.webContents.send('quick-chat:shown', automatic?.epoch ?? contextEpoch, automatic !== null && getConfig().ui.quickChatAutoCapture !== false, directOpen); };
    owner.on('show', announce);
    const load = process.env.ELECTRON_RENDERER_URL
      ? owner.loadURL(new URL('index.html?surface=quick-chat', process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}/`).toString())
      : owner.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { surface: 'quick-chat' } });
    void load.catch(() => { logWarn('quick chat: renderer could not load'); if (!owner.isDestroyed()) owner.destroy(); });
  };
  const owns = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const owner = live();
    if (!active || !owner || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame)
      throw new Error('Quick chat is not available');
    return owner;
  };
  const channels = ['quick-chat:hide', 'quick-chat:pin', 'quick-chat:expand', 'quick-chat:capture', 'quick-chat:answer', 'quick-chat:replace', 'quick-chat:automatic', 'quick-chat:ready', 'quick-chat:open-session'];
  const register = (): void => {
    if (active) return;
    active = true;
    ipcMain.handle(channels[0]!, event => hide(owns(event)));
    ipcMain.handle(channels[1]!, (event, pinned: unknown) => {
      const owner = owns(event);
      if (typeof pinned !== 'boolean') throw new Error('Invalid pin value');
      owner.setAlwaysOnTop(pinned); return owner.isAlwaysOnTop();
    });
    ipcMain.handle(channels[2]!, async (event, id: unknown) => {
      const owner = owns(event);
      if (id !== null && (typeof id !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(id) || !await getSession(id))) return false;
      if (live() !== owner || !active) return false;
      options.openWorkspace(id as string | null); owner.hide(); return true;
    });
    const current = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
      const owner = owns(event);
      if (!owner.isVisible() || !owner.isFocused() || opening || replacing) throw new Error('Quick Chat is not focused');
      return owner;
    };
    ipcMain.handle(channels[3]!, async (event, kind: unknown) => {
      const owner = current(event);
      if (kind !== 'selection' && kind !== 'screenshot') throw new Error('Invalid context capture');
      if (kind === 'selection') ++contextEpoch;
      const epoch = contextEpoch;
      const result = await context.capture(kind, kind === 'selection' && process.platform === 'win32' ? nativeHandle(owner) : undefined);
      if (current(event) !== owner || epoch !== contextEpoch) throw new Error('The source window changed');
      if (kind === 'screenshot') void effect.show(context.sourceWindow(), owner.getBounds()).catch(() => undefined);
      return result;
    });
    ipcMain.handle(channels[4]!, async (event, value: unknown) => {
      const owner = current(event), epoch = contextEpoch;
      const source = context.replacementSource();
      if (!source) throw new Error('Capture an editable selection first');
      if (!value || typeof value !== 'object') throw new Error('Invalid answer');
      const { id, turnId, messageId } = value as Record<string, unknown>;
      if (typeof id !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(id) ||
          (turnId !== undefined && (typeof turnId !== 'string' || !turnId || turnId.length > 256)) ||
          (messageId !== undefined && (typeof messageId !== 'string' || !messageId || messageId.length > 256)) ||
          !!turnId === !!messageId) throw new Error('Invalid answer');
      const { markdown } = await buildSessionMarkdown({ id, scope: 'answer', turnId: turnId as string | undefined, messageId: messageId as string | undefined });
      if (current(event) !== owner || epoch !== contextEpoch) throw new Error('The source window changed');
      if (!markdown.trim() || markdown.length > 64_000) throw new Error('The answer is too long or empty');
      return { text: markdown, epoch, source };
    });
    ipcMain.handle(channels[5]!, async (event, value: unknown) => {
      const owner = current(event);
      if (!value || typeof value !== 'object') throw new Error('Invalid replacement');
      const { text, epoch } = value as Record<string, unknown>;
      if (typeof text !== 'string' || !text.trim() || text.length > 64_000 || epoch !== contextEpoch) throw new Error('The source window changed or the text is invalid');
      replacing = true;
      try {
        if (process.platform !== 'win32') throw new Error('Native text replacement is currently available on Windows only');
        await context.replace(text, nativeHandle(owner)); hide(owner);
      }
      finally { replacing = false; invalidateContext(); }
    });
    ipcMain.handle(channels[6]!, async (event, epoch: unknown) => {
      const owner = owns(event), pending = automatic;
      if (!owner.isVisible() || !pending || pending.claimed || epoch !== pending.epoch || pending.epoch !== contextEpoch || getConfig().ui.quickChatAutoCapture === false) return null;
      pending.claimed = true;
      const result = await pending.capture;
      const caps = effectiveCapabilities(getConfig());
      return live() === owner && owner.isVisible() && pending === automatic && pending.epoch === contextEpoch && getConfig().ui.quickChatAutoCapture !== false && caps.screen && (!pending.control || caps.control) ? result : null;
    });
    ipcMain.handle(channels[7]!, event => {
      const owner = owns(event);
      if (awaitingReady !== owner) return;
      awaitingReady = null;
      showPanel(owner);
    });
    ipcMain.handle(channels[8]!, async (event, id: unknown) => {
      const workspace = options.workspaceContents?.();
      if (!active || !workspace || event.sender !== workspace || event.senderFrame !== workspace.mainFrame) return { ok: false, error: 'Quick chat is not available' };
      if (typeof id !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(id)) return { ok: false, error: 'Chat not found' };
      const target = await getSession(id);
      if (!target || isUnattributedSession(target)) return { ok: false, error: 'Chat not found' };
      if (!active || options.workspaceContents?.() !== workspace || workspace.isDestroyed() || event.senderFrame !== workspace.mainFrame || opening || replacing || awaitingReady) return { ok: false, error: 'Quick chat is not available' };
      await toggleWindow(id);
      return { ok: true, data: true };
    });
    initializeQuickChatShortcut(globalShortcut, toggle, getConfig().ui);
  };
  const dispose = (): void => {
    if (!active) return;
    active = false;
    invalidateContext();
    disposeQuickChatShortcut();
    for (const channel of channels) ipcMain.removeHandler(channel);
    live()?.destroy();
  };
  const workspaceClosed = (): void => { const owner = live(); if (owner && !owner.isVisible() && !keepResident()) owner.destroy(); };
  return { register, toggle, notify, dispose, workspaceClosed };
}
