/**
 * The CoS browser: app-owned Chromium windows that run the companion extension unchanged.
 *
 * The extension talks to the bridge exactly as it does from Chrome. Its tab and window
 * orchestration lands in `TabModel` through the worker preload and `chrome-api.ts`; this module
 * performs the native side of it with Electron windows and views and feeds every page event back
 * into the model. Windows belong to the app, so a window the extension keeps in the background is
 * simply never shown: nothing appears in a taskbar or dock on any platform.
 */
import { BaseWindow, BrowserWindow, WebContentsView, app, session, shell, type Session, type WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultAppearance, paletteTokens } from '../../shared/appearance.js';
import { getConfig } from '../config.js';
import { extensionDir } from '../extension-path.js';
import { logInfo, logWarn } from '../logger.js';
import { callChromeApi, type BrowserControl, type DebuggerTarget } from './chrome-api.js';
import { ExtensionWorkerLink, type WorkerRegistry } from './extension-worker.js';
import { CHATGPT_SESSION_COOKIE, setCosBrowserSignedIn, signInAgent } from './sign-in.js';
import { opensInCosBrowser } from '../../shared/cos-browser-sites.js';
import { TabModel, WINDOW_ID_NONE, type ModelEvent, type WindowState } from './tab-model.js';

const PARTITION = 'persist:cos-browser';
const TOOLBAR_HEIGHT = 40;
const HOME_URL = 'https://chatgpt.com/';
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
/** COS_BROWSER_TRACE=1 logs every extension call and event: names, ids and errors, never page content. */
const TRACE = process.env.COS_BROWSER_TRACE === '1';

function traceIds(args: unknown[]): string {
  return args.map(arg => typeof arg === 'number' ? String(arg)
    : arg && typeof arg === 'object' && 'tabId' in arg ? `tab ${String((arg as { tabId: unknown }).tabId)}`
      : arg && typeof arg === 'object' && 'id' in arg ? `#${String((arg as { id: unknown }).id)}`
        : typeof arg).join(', ');
}

interface Frame {
  id: number;
  base: BaseWindow;
  toolbar: WebContentsView;
  shown: boolean;
  /** The bar color the title bar overlay was last painted with. */
  overlay: string;
}

/** What one window's toolbar draws. Built here, painted by src/renderer/cos-browser.ts. */
export interface CosBrowserToolbarState {
  tabs: Array<{ id: number; title: string; url: string; favicon: string | null; active: boolean; loading: boolean; working: boolean }>;
  navigation: { back: boolean; forward: boolean; loading: boolean };
  /** Whether the companion in this browser reaches the app; null before it was ever known. */
  connected: boolean | null;
  companionIcon: string | null;
  tokens: Record<string, string>;
  /** Room left for the system window controls drawn over the toolbar. */
  insets: { left: number; right: number };
}

/** The app's own palette for the bar: the sidebar color, its accent and contrast. */
function barTokens(): Record<string, string> {
  const ui = getConfig().ui;
  const palette = (ui.appearance ?? defaultAppearance())[ui.theme === 'light' ? 'light' : 'dark'];
  return paletteTokens(palette.sidebar, palette.accent, palette.contrast);
}

/** The conversation a ChatGPT tab shows, from its `/c/<id>` path. */
function conversationOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'chatgpt.com' && parsed.hostname !== 'chat.openai.com') return null;
    return /^\/(?:g\/[^/]+\/)?c\/([0-9a-z-]+)/i.exec(parsed.pathname)?.[1] ?? null;
  } catch { return null; }
}

/** macOS draws its traffic lights at the left of a hidden title bar; Windows and Linux draw caption buttons at the right. */
const WINDOW_CONTROLS = process.platform === 'darwin' ? { left: 78, right: 8 } : { left: 8, right: 138 };

/** Chromium's own user agent: some sign-in providers refuse one that names an embedder. */
function chromiumUserAgent(agent: string): string {
  return agent.replace(/\s(?:Electron|chat-on-steroids|Chat On Steroids)\/\S+/gi, '');
}

export class CosBrowser {
  private ses: Session | null = null;
  private extensionId = '';
  // Before `control`, which reads it: field initializers run in declaration order.
  private readonly model = new TabModel(event => this.onModelEvent(event));
  private readonly frames = new Map<number, Frame>();
  private readonly views = new Map<number, WebContentsView>();
  private link: ExtensionWorkerLink | null = null;
  /** The session outlives a stop: its preload and listeners are installed once per process. */
  private configured: Session | null = null;
  private readonly listeners = new Set<() => void>();
  private popup: BrowserWindow | null = null;
  private readonly favicons = new Map<number, string>();
  /** Favicons as data URLs by source URL: the toolbar has no network access of its own. */
  private readonly faviconCache = new Map<string, string | null>();
  private appConnected: boolean | null = null;
  /** ChatGPT conversations with a turn open right now, from the app's recorder. */
  private generating: ReadonlySet<string> = new Set();
  private companionIcon: string | null = null;
  private stopping = false;
  /** Set once the app quits: a window must close then, never hide and hold the quit back. */
  private quitting = false;
  /** Tabs whose debugger the extension itself detached: Chrome reports no onDetach for those. */
  private readonly detaching = new Set<number>();
  private startPromise: Promise<void> | null = null;

  constructor(private readonly assets: { preloadDir: string; rendererUrl: () => string | null; rendererDir: string }) {}

  running(): boolean {
    return this.ses !== null && !this.stopping;
  }

  /**
   * Whether these contents are pages of this browser: they navigate and follow redirects as in any
   * browser (every sign-in is a chain of them), so the app-wide no-navigation guard skips them.
   */
  browses(contents: WebContents): boolean {
    return this.configured !== null && contents.session === this.configured;
  }

  /** Whether any CoS browser window is on screen. */
  visible(): boolean {
    return [...this.frames.values()].some(frame => frame.shown);
  }

  /** The bridge's view of the companion; shown as the dot on the toolbar's companion button. */
  setAppConnected(connected: boolean): void {
    if (this.appConnected === connected) return;
    this.appConnected = connected;
    for (const id of this.frames.keys()) this.paintToolbar(id);
  }

  /** Which conversations are answering; their tabs show the working pulse. */
  setGeneratingConversations(ids: ReadonlySet<string>): void {
    if (ids.size === this.generating.size && [...ids].every(id => this.generating.has(id))) return;
    this.generating = new Set(ids);
    for (const id of this.frames.keys()) this.paintToolbar(id);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Loads the extension into the browser's own session. Idempotent while running. */
  start(): Promise<void> {
    this.startPromise ??= this.boot().catch(error => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  private async boot(): Promise<void> {
    const dir = extensionDir();
    if (!dir) throw new Error('The CoS browser needs the bundled extension folder, which is missing from this installation.');
    this.stopping = false;
    const ses = session.fromPartition(PARTITION);
    this.configure(ses);
    this.ses = ses;
    const extension = await ses.extensions.loadExtension(dir);
    this.extensionId = extension.id;
    try { this.companionIcon = `data:image/png;base64,${readFileSync(path.join(dir, 'icons', 'icon32.png')).toString('base64')}`; }
    catch { this.companionIcon = null; }
    this.link = new ExtensionWorkerLink(ses.serviceWorkers as unknown as WorkerRegistry, `chrome-extension://${extension.id}/`,
      (name, args) => this.answer(name, args), logWarn);
    // Chrome tells an extension the browser started; Electron loads it without that event, and
    // the companion first looks for the app on it.
    this.toWorker('runtime.onStartup', []);
    logInfo(`cos browser: started with extension ${extension.version} from ${dir}`);
    void this.readSignIn(ses);
    this.notify();
  }

  /** Setup's first step is done once ChatGPT has a session in this browser. */
  private async readSignIn(ses: Session): Promise<void> {
    try {
      const cookies = await ses.cookies.get({ url: HOME_URL });
      if (this.ses === ses) setCosBrowserSignedIn(cookies.some(cookie => CHATGPT_SESSION_COOKIE.test(cookie.name)));
    } catch (error) {
      logWarn(`cos browser: could not read the ChatGPT sign-in: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private configure(ses: Session): void {
    if (this.configured === ses) return;
    this.configured = ses;
    app.once('before-quit', () => { this.quitting = true; });
    ses.setUserAgent(chromiumUserAgent(app.userAgentFallback));
    // The request a navigation is already sending can still carry the old agent and Chromium's
    // client hints; Google's sign-in hosts get the same agent their pages see, and no hints.
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*', 'https://accounts.youtube.com/*'] }, (details, callback) => {
      const headers: Record<string, string> = { ...details.requestHeaders, 'User-Agent': signInAgent(details.url, chromiumUserAgent(app.userAgentFallback)) };
      for (const name of Object.keys(headers)) if (/^sec-ch-ua/i.test(name)) delete headers[name];
      callback({ requestHeaders: headers });
    });
    ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
    ses.registerPreloadScript({ type: 'service-worker', filePath: path.join(this.assets.preloadDir, 'cos-browser-worker.js') });
    ses.registerPreloadScript({ type: 'frame', filePath: path.join(this.assets.preloadDir, 'cos-browser-sign-in.js') });
    // Signing in or out of ChatGPT, read again from the jar rather than from the one event: the
    // session cookie comes in numbered chunks, and replacing one removes it before setting it.
    ses.cookies.on('changed', (_event, cookie) => {
      if (/(^|\.)chatgpt\.com$/.test(cookie.domain ?? '') && CHATGPT_SESSION_COOKIE.test(cookie.name)) void this.readSignIn(ses);
    });
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (TRACE) logInfo(`cos browser trace: worker ${versionId} ${runningStatus}`);
      this.link?.statusChanged(versionId, runningStatus);
    });
    if (TRACE) {
      ses.serviceWorkers.on('console-message', (_event, details) => {
        logInfo(`cos browser trace: worker console ${details.level ?? ''}: ${String(details.message).slice(0, 400)}`);
      });
    }
  }

  /** One `chrome.*` call from the extension worker. */
  private async answer(name: string, args: unknown): Promise<unknown> {
    const label = TRACE ? `${name}(${Array.isArray(args) ? traceIds(args) : ''})` : '';
    const late = TRACE ? setTimeout(() => logWarn(`cos browser trace: ${label} still pending after 10 s`), 10_000) : null;
    try {
      const reply = await callChromeApi(this.control, name, args);
      if (TRACE) logInfo(`cos browser trace: ${label} ${reply.ok ? 'ok' : `failed: ${reply.message}`}`);
      return reply;
    } finally {
      if (late) clearTimeout(late);
    }
  }

  /** Closes every window and unloads the extension. Chats in it end, as when Chrome quits. */
  stop(): void {
    if (!this.ses) return;
    this.stopping = true;
    for (const id of [...this.frames.keys()]) this.control.closeWindow(id);
    this.popup?.destroy();
    this.popup = null;
    this.link?.close();
    this.link = null;
    try { if (this.extensionId) this.ses.extensions.removeExtension(this.extensionId); } catch { /* already gone */ }
    this.ses = null;
    this.startPromise = null;
    setCosBrowserSignedIn(null);
    this.notify();
  }

  /**
   * Opens a URL the app chose. `reveal` is for an explicit user action such as "open this chat":
   * the window comes forward. Anything else opens in a background window that stays hidden.
   */
  async open(url: string, options: { reveal: boolean }): Promise<void> {
    await this.start();
    if (options.reveal) {
      const existing = this.model.query({}).find(tab => tab.url === url || tab.pendingUrl === url);
      if (existing) {
        this.model.activate(existing.id);
        this.showWindow(existing.windowId, true);
        return;
      }
      const windowId = this.frames.has(this.model.lastFocusedWindow()) ? this.model.lastFocusedWindow() : null;
      if (windowId === null) this.control.createWindow({ url, focused: true, state: 'normal', type: 'normal' });
      else { this.control.createTab(windowId, url, { active: true }); this.showWindow(windowId, true); }
      return;
    }
    this.control.createWindow({ url, focused: false, state: 'minimized', type: 'normal' });
  }

  /** Tray "Show browser": the last used window, or a new one on ChatGPT for signing in. */
  async show(): Promise<void> {
    await this.start();
    const windowId = this.frames.has(this.model.lastFocusedWindow()) ? this.model.lastFocusedWindow() : [...this.frames.keys()].at(-1);
    if (windowId === undefined) this.control.createWindow({ url: HOME_URL, focused: true, state: 'normal', type: 'normal' });
    else this.showWindow(windowId, true);
  }

  /** Tray "Hide browser": every window leaves the screen; its pages keep running. */
  hide(): void {
    for (const id of this.frames.keys()) this.hideWindow(id);
  }

  // ---- extension worker ----------------------------------------------------------------------

  private toWorker(name: string, args: unknown[]): void {
    if (TRACE && name !== 'debugger.onEvent') {
      const change = name === 'tabs.onUpdated' ? ` ${JSON.stringify(Object.keys(args[1] as object))}` : '';
      logInfo(`cos browser trace: event ${name}(${traceIds(args.slice(0, 1))})${change}`);
    }
    this.link?.send(name, args);
  }

  // ---- model ---------------------------------------------------------------------------------

  private onModelEvent(event: ModelEvent): void {
    if (this.stopping) return;
    this.toWorker(event.name, event.args);
    if (event.name === 'tabs.onActivated') this.layout(event.args[0].windowId);
    if (event.name === 'windows.onRemoved') this.destroyFrame(event.args[0]);
    const windowId = event.name.startsWith('tabs.') ? this.windowOfEvent(event) : null;
    if (windowId !== null) this.paintToolbar(windowId);
  }

  private windowOfEvent(event: ModelEvent): number | null {
    switch (event.name) {
      case 'tabs.onCreated': return event.args[0].windowId;
      case 'tabs.onUpdated': return event.args[2].windowId;
      case 'tabs.onActivated': return event.args[0].windowId;
      case 'tabs.onMoved': return event.args[1].windowId;
      case 'tabs.onAttached': return event.args[1].newWindowId;
      case 'tabs.onDetached': return event.args[1].oldWindowId;
      case 'tabs.onRemoved': return event.args[1].windowId;
      default: return null;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  // ---- windows -------------------------------------------------------------------------------

  private createFrame(id: number): Frame {
    const tokens = barTokens();
    const base = new BaseWindow({
      width: 1180, height: 820, minWidth: 480, minHeight: 360, show: false, title: 'Chat On Steroids browser',
      backgroundColor: tokens['--page'],
      // The tab strip is the title bar, as in the app's own window: no native title row above it.
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 14, y: 13 } }
        : { titleBarOverlay: { color: tokens['--page']!, symbolColor: tokens['--ink']!, height: TOOLBAR_HEIGHT } })
    });
    if (process.platform !== 'darwin') base.removeMenu();
    const toolbar = new WebContentsView({
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        preload: path.join(this.assets.preloadDir, 'cos-browser.js')
      }
    });
    toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    toolbar.webContents.on('will-navigate', event => event.preventDefault());
    toolbar.webContents.on('did-finish-load', () => this.paintToolbar(id));
    base.contentView.addChildView(toolbar);
    const frame: Frame = { id, base, toolbar, shown: false, overlay: tokens['--page']! };
    this.frames.set(id, frame);
    const rendererUrl = this.assets.rendererUrl();
    void (rendererUrl
      ? toolbar.webContents.loadURL(new URL('cos-browser.html', rendererUrl.endsWith('/') ? rendererUrl : `${rendererUrl}/`).toString())
      : toolbar.webContents.loadFile(path.join(this.assets.rendererDir, 'cos-browser.html'))).catch(() => undefined);
    base.on('resize', () => this.layout(id));
    base.on('focus', () => this.model.focusWindow(id));
    base.on('blur', () => {
      if (![...this.frames.values()].some(other => other.base.isFocused())) this.model.focusWindow(WINDOW_ID_NONE);
    });
    // The window belongs to the tray: closing or minimizing it hides it, and its chats go on.
    base.on('close', event => {
      if (this.stopping || this.quitting) return;
      event.preventDefault();
      this.hideWindow(id);
    });
    base.on('minimize', () => this.hideWindow(id));
    this.layout(id);
    return frame;
  }

  private destroyFrame(id: number): void {
    const frame = this.frames.get(id);
    if (!frame) return;
    this.frames.delete(id);
    frame.toolbar.webContents.close();
    if (!frame.base.isDestroyed()) frame.base.destroy();
    this.notify();
  }

  private showWindow(id: number, focus: boolean): void {
    const frame = this.frames.get(id);
    if (!frame) return;
    if (frame.base.isMinimized()) frame.base.restore();
    if (focus) frame.base.show(); else frame.base.showInactive();
    if (focus) {
      frame.base.focus();
      // Keys go to the page the user came for, not to the toolbar's first button.
      const active = this.model.activeTab(id);
      if (active !== null) this.views.get(active)?.webContents.focus();
    }
    frame.shown = true;
    this.model.setWindowState(id, frame.base.isMaximized() ? 'maximized' : 'normal');
    this.layout(id);
    this.notify();
  }

  private hideWindow(id: number): void {
    const frame = this.frames.get(id);
    if (!frame || (!frame.shown && !frame.base.isVisible())) return;
    frame.base.hide();
    frame.shown = false;
    this.model.setWindowState(id, 'minimized');
    if (frame.base.isFocused() || this.model.lastFocusedWindow() === id) this.model.focusWindow(WINDOW_ID_NONE);
    this.notify();
  }

  private layout(id: number): void {
    const frame = this.frames.get(id);
    if (!frame || frame.base.isDestroyed()) return;
    const { width, height } = frame.base.getContentBounds();
    frame.toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
    const active = this.model.activeTab(id);
    for (const tabId of this.model.tabsOf(id)) {
      const view = this.views.get(tabId);
      if (!view) continue;
      view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
      view.setVisible(tabId === active);
    }
  }

  private paintToolbar(id: number): void {
    const frame = this.frames.get(id);
    if (!frame || frame.toolbar.webContents.isDestroyed()) return;
    const activeId = this.model.activeTab(id);
    const tabs = this.model.tabsOf(id).map(tabId => {
      const tab = this.model.tab(tabId)!;
      return {
        id: tab.id, title: tab.title || tab.pendingUrl || tab.url || 'New tab', url: tab.url || tab.pendingUrl || '',
        favicon: this.favicons.get(tabId) ?? null, active: tab.active, loading: tab.status === 'loading',
        // Answering, or being sent to: the companion holds a tab's debugger while it sends.
        working: this.generating.has(conversationOf(tab.url) ?? '') || this.views.get(tabId)?.webContents.debugger.isAttached() === true
      };
    });
    const history = activeId === null ? null : this.views.get(activeId)?.webContents.navigationHistory;
    const tokens = barTokens();
    const state: CosBrowserToolbarState = {
      tabs,
      navigation: {
        back: history?.canGoBack() === true, forward: history?.canGoForward() === true,
        loading: tabs.find(tab => tab.active)?.loading === true
      },
      connected: this.appConnected, companionIcon: this.companionIcon, tokens, insets: WINDOW_CONTROLS
    };
    frame.toolbar.webContents.send('cos-browser:state', state);
    if (frame.base.isDestroyed()) return;
    const active = tabs.find(tab => tab.active);
    frame.base.setTitle(active ? `${active.title} — Chat On Steroids browser` : 'Chat On Steroids browser');
    if (process.platform !== 'darwin' && frame.overlay !== tokens['--page']) {
      frame.overlay = tokens['--page']!;
      frame.base.setTitleBarOverlay({ color: tokens['--page']!, symbolColor: tokens['--ink']!, height: TOOLBAR_HEIGHT });
    }
  }

  /** Toolbar actions, accepted only from this window's own toolbar and for its own tabs. */
  toolbarAction(sender: WebContents, action: string, tabId: unknown): void {
    const frame = [...this.frames.values()].find(candidate => candidate.toolbar.webContents === sender);
    if (!frame) return;
    if (action === 'extension') { this.openExtensionPopup(frame); return; }
    if (typeof tabId !== 'number' || this.model.tab(tabId)?.windowId !== frame.id) return;
    if (action === 'activate') this.model.activate(tabId);
    else if (action === 'close') this.control.closeTab(tabId);
    else if (action === 'reload') this.control.reload(tabId, false);
    else if (action === 'stop') this.views.get(tabId)?.webContents.stop();
    else if (action === 'back') this.views.get(tabId)?.webContents.navigationHistory.goBack();
    else if (action === 'forward') this.views.get(tabId)?.webContents.navigationHistory.goForward();
  }

  /** The extension's action popup, as Chrome shows it under the toolbar button. */
  private openExtensionPopup(frame: Frame): void {
    if (!this.ses || !this.extensionId) return;
    this.popup?.destroy();
    const bounds = frame.base.getContentBounds();
    const popup = new BrowserWindow({
      parent: frame.base, x: bounds.x + bounds.width - 396, y: bounds.y + TOOLBAR_HEIGHT, width: 380, height: 540,
      frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, show: false,
      webPreferences: { session: this.ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    this.popup = popup;
    popup.on('blur', () => { if (!popup.isDestroyed()) popup.destroy(); });
    popup.on('closed', () => { if (this.popup === popup) this.popup = null; });
    popup.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
    // The companion's own page, not a website: it stays put, as the app-wide guard keeps every other.
    popup.webContents.on('will-navigate', event => event.preventDefault());
    popup.webContents.on('will-redirect', event => event.preventDefault());
    popup.once('ready-to-show', () => popup.show());
    void popup.loadURL(`chrome-extension://${this.extensionId}/popup.html`).catch(() => undefined);
  }

  // ---- tabs ----------------------------------------------------------------------------------

  private wire(contents: WebContents): void {
    const id = contents.id;
    // A tab presents Firefox while it is on a sign-in page (see signInAgent). The agent changes
    // only once a document has committed: changing it while a navigation is in flight aborts that
    // navigation and takes the whole browser down. A page that committed with the wrong agent is
    // loaded once more with the right one, which happens on entering and on leaving the sign-in.
    const chromium = chromiumUserAgent(app.userAgentFallback);
    contents.on('did-navigate', (_event, url) => {
      const agent = signInAgent(url, chromium);
      if (contents.getUserAgent() === agent) return;
      contents.setUserAgent(agent);
      setImmediate(() => { if (!contents.isDestroyed()) contents.reload(); });
    });
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) this.model.navigationStarted(id, details.url);
    });
    contents.on('did-navigate', (_event, url) => this.model.navigationCommitted(id, url));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) this.model.sameDocumentNavigated(id, url); });
    contents.on('did-stop-loading', () => this.model.loadingStopped(id));
    contents.on('page-title-updated', (_event, title) => this.model.titleChanged(id, title));
    contents.on('page-favicon-updated', (_event, favicons) => {
      const source = favicons.find(url => /^(https:|data:image\/)/.test(url));
      if (!source) return;
      void this.faviconData(source).then(icon => {
        if (!icon || this.favicons.get(id) === icon || !this.views.has(id)) return;
        this.favicons.set(id, icon);
        this.repaintTab(id);
      });
    });
    // A page that closes itself (window.close) is a closed tab.
    contents.once('destroyed', () => {
      this.views.delete(id);
      this.favicons.delete(id);
      if (!this.stopping) this.model.removeTab(id);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (opensInCosBrowser(url)) {
        // ChatGPT, OpenAI and sign-in links open as tabs of this browser, beside their opener.
        const windowId = this.model.tab(id)?.windowId;
        if (windowId !== undefined) this.control.createTab(windowId, url, { active: true, openerTabId: id });
      } else if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.debugger.on('message', (_event, method, params, sessionId) => {
      this.toWorker('debugger.onEvent', [{ tabId: id, ...(sessionId ? { sessionId } : {}) }, method, params]);
    });
    contents.debugger.on('detach', (_event, reason) => {
      this.repaintTab(id);
      if (this.detaching.delete(id)) return;
      this.toWorker('debugger.onDetach', [{ tabId: id }, /closed/i.test(reason) ? 'target_closed' : 'canceled_by_user']);
    });
  }

  /** A page's favicon, fetched with the page's own session and handed to the toolbar inline. */
  private async faviconData(source: string): Promise<string | null> {
    if (source.startsWith('data:image/')) return source.length <= 96 * 1024 ? source : null;
    if (this.faviconCache.has(source)) return this.faviconCache.get(source)!;
    let icon: string | null = null;
    try {
      const response = await this.ses?.fetch(source);
      const type = response?.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (response?.ok && /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|webp|gif|jpeg)$/.test(type)) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length <= 64 * 1024) icon = `data:${type};base64,${bytes.toString('base64')}`;
      }
    } catch { /* No icon: the tab shows its generic glyph. */ }
    if (this.faviconCache.size >= 64) this.faviconCache.clear();
    this.faviconCache.set(source, icon);
    return icon;
  }

  private repaintTab(tabId: number): void {
    const windowId = this.model.tab(tabId)?.windowId;
    if (windowId !== undefined) this.paintToolbar(windowId);
  }

  private contentsOf(tabId: number): WebContents {
    const view = this.views.get(tabId);
    if (!view || view.webContents.isDestroyed()) throw new Error(`No tab with id: ${tabId}.`);
    return view.webContents;
  }

  /** The native side of the extension's tab and window calls. */
  readonly control: BrowserControl = {
    model: this.model,

    createWindow: ({ url, focused, state, type }) => {
      const id = this.model.createWindow({ type, state: focused ? (state === 'minimized' ? 'normal' : state) : 'minimized' });
      this.createFrame(id);
      if (url !== undefined) this.control.createTab(id, url, { active: true });
      if (focused) this.showWindow(id, true);
      this.notify();
      return id;
    },

    createTab: (windowId, url, options) => {
      const frame = this.frames.get(windowId);
      if (!frame || !this.ses) throw new Error(`No window with id: ${windowId}.`);
      const view = new WebContentsView({
        webPreferences: { session: this.ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
      });
      const id = view.webContents.id;
      this.views.set(id, view);
      this.wire(view.webContents);
      frame.base.contentView.addChildView(view);
      this.model.addTab(id, windowId, { url, ...options });
      this.layout(windowId);
      void view.webContents.loadURL(url).catch(() => undefined);
      return id;
    },

    navigate: (tabId, url) => { void this.contentsOf(tabId).loadURL(url).catch(() => undefined); },

    reload: (tabId, bypassCache) => {
      const contents = this.contentsOf(tabId);
      if (bypassCache) contents.reloadIgnoringCache(); else contents.reload();
    },

    activate: tabId => this.model.activate(tabId),

    closeTab: tabId => {
      const view = this.views.get(tabId);
      const windowId = this.model.tab(tabId)?.windowId;
      if (view && windowId !== undefined) this.frames.get(windowId)?.base.contentView.removeChildView(view);
      this.views.delete(tabId);
      // Report the removal before the page is gone, as Chrome does for an extension's tabs.remove.
      this.model.removeTab(tabId);
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    },

    moveTab: (tabId, windowId, index) => {
      const view = this.views.get(tabId);
      const from = this.model.tab(tabId)?.windowId;
      const target = this.frames.get(windowId);
      if (!view || from === undefined || !target) throw new Error(`No tab with id: ${tabId}.`);
      if (from !== windowId) {
        this.frames.get(from)?.base.contentView.removeChildView(view);
        target.base.contentView.addChildView(view);
      }
      this.model.move(tabId, windowId, index);
      this.layout(windowId);
      if (from !== windowId) this.layout(from);
    },

    closeWindow: windowId => {
      const tabs = this.model.tabsOf(windowId);
      this.model.removeWindow(windowId);
      for (const tabId of tabs) {
        const view = this.views.get(tabId);
        this.views.delete(tabId);
        if (view && !view.webContents.isDestroyed()) view.webContents.close();
      }
      this.destroyFrame(windowId);
    },

    presentWindow: (windowId, change: { state?: WindowState; focused?: boolean }) => {
      const frame = this.frames.get(windowId);
      if (!frame) return;
      if (change.state === 'minimized') { this.hideWindow(windowId); return; }
      if (change.state === 'maximized') frame.base.maximize();
      if (change.state === 'fullscreen') frame.base.setFullScreen(true);
      if (change.state === 'normal' && frame.base.isMaximized()) frame.base.unmaximize();
      if (change.state !== undefined || change.focused === true) this.showWindow(windowId, change.focused === true);
    },

    debuggerAttach: async (tabId, version) => {
      const contents = this.contentsOf(tabId);
      if (contents.debugger.isAttached()) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
      this.detaching.delete(tabId);
      contents.debugger.attach(version);
      this.repaintTab(tabId);
    },

    debuggerDetach: async tabId => {
      const contents = this.contentsOf(tabId);
      if (!contents.debugger.isAttached()) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
      // Cleared by the detach event this causes, or by the next attach if none arrives.
      this.detaching.add(tabId);
      contents.debugger.detach();
    },

    debuggerSend: async (tabId, method, params, sessionId) => {
      const contents = this.contentsOf(tabId);
      if (!contents.debugger.isAttached()) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
      return contents.debugger.sendCommand(method, params, sessionId);
    },

    debuggerTargets: (): DebuggerTarget[] => this.model.query({}).map(tab => ({
      type: 'page', id: String(tab.id), tabId: tab.id, title: tab.title, url: tab.url,
      attached: this.views.get(tab.id)?.webContents.debugger.isAttached() === true
    }))
  };
}
