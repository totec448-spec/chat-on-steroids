/**
 * App-owned Chromium host.
 *
 * ChatGPT runs in Electron's own Chromium rather than in an installed browser. Every logical
 * tab is a WebContentsView on one persistent Session, so cookies/login and the companion MV3
 * extension are shared while background workers can stay alive without a visible OS window.
 * Once the app window exists, every live tab stays mounted with real layout geometry: the
 * selected tab occupies the dock while it is open and every other tab is parked offscreen.
 */
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, session, shell, WebContentsView, type Session } from 'electron';
import { z } from 'zod';
import type { InternalBrowserBounds, InternalBrowserDockState, InternalBrowserTabState } from '../shared/internal-browser.js';
import { extensionDir } from './extension-path.js';
import { logInfo, logWarn } from './logger.js';
import { wakeBrowserWork } from './browser-wake.js';

const PARTITION = 'persist:cos-browser';
const WINDOW_ID = 1;
const MAX_EVENTS = 512;
const HOME_URL = 'https://chatgpt.com/';
const CHATGPT_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);

type TabStatus = 'loading' | 'complete';

interface HostedTab {
  view: WebContentsView;
  id: number;
  active: boolean;
  /** User-visible browser tabs are protected from the extension's idle-page recycling. */
  userHeld: boolean;
  autoDiscardable: boolean;
  status: TabStatus;
  url: string;
  pendingUrl?: string;
  title: string;
  lastAccessed: number;
  openerId: number | null;
  retired: boolean;
}

interface BrowserHostEvent {
  seq: number;
  type: 'updated' | 'removed';
  tabId: number;
  changeInfo?: Record<string, unknown>;
}

interface BrowserTabView {
  active: boolean;
  autoDiscardable: boolean;
  discarded: false;
  frozen: false;
  groupId: -1;
  highlighted: boolean;
  id: number;
  incognito: false;
  index: number;
  lastAccessed: number;
  mutedInfo: { muted: false };
  pendingUrl?: string;
  pinned: boolean;
  selected: boolean;
  status: TabStatus;
  title: string;
  url: string;
  windowId: number;
}

let browserSession: Session | null = null;
let ready: Promise<void> | null = null;
let owner: BrowserWindow | null = null;
let tabs = new Map<number, HostedTab>();
let activeTabId: number | null = null;
let attachedTabIds = new Set<number>();
let dockOpen = false;
let dockBounds: InternalBrowserBounds | null = null;
let eventSeq = 0;
let events: BrowserHostEvent[] = [];
let generation = randomUUID();
let prewarmTabId: number | null = null;
let prewarming: Promise<number> | null = null;

const hostRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('query'), query: z.object({
    active: z.boolean().optional(),
    lastFocusedWindow: z.boolean().optional(),
    windowId: z.number().int().positive().optional(),
    url: z.union([z.string(), z.array(z.string()).max(32)]).optional()
  }).strict().default({}) }).strict(),
  z.object({ action: z.literal('get'), tabId: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('create'), create: z.object({
    url: z.string().url(),
    active: z.boolean().optional(),
    // Successor/worker placement still speaks the chrome.tabs.create shape. Keep the logical
    // window/index fields even though embedded Chromium owns only one native window.
    windowId: z.number().int().optional(),
    index: z.number().int().nonnegative().max(10_000).optional()
  }).strict() }).strict(),
  z.object({ action: z.literal('update'), tabId: z.number().int().positive(), update: z.object({
    url: z.string().url().optional(), active: z.boolean().optional(), autoDiscardable: z.boolean().optional()
  }).strict() }).strict(),
  z.object({ action: z.literal('remove'), tabId: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('reload'), tabId: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('events'), generation: z.string().uuid().optional(), after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
]);

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch { return false; }
}

function isChatGptUrl(value: string): boolean {
  try { return CHATGPT_ORIGINS.has(new URL(value).origin); }
  catch { return false; }
}

/** Chrome match-pattern subset used by this extension (scheme + host + `*` path). */
export function internalBrowserUrlMatches(url: string, pattern: string): boolean {
  if (pattern === '<all_urls>') return isWebUrl(url);
  try {
    const candidate = new URL(url);
    const marker = pattern.indexOf('://');
    if (marker <= 0) return false;
    const scheme = pattern.slice(0, marker);
    const remainder = pattern.slice(marker + 3);
    const slash = remainder.indexOf('/');
    if (slash < 0) return false;
    const host = remainder.slice(0, slash);
    const pathname = `/${remainder.slice(slash + 1)}`;
    if (scheme !== '*' && `${scheme}:` !== candidate.protocol) return false;
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      if (candidate.hostname !== base && !candidate.hostname.endsWith(`.${base}`)) return false;
    } else if (host !== '*' && candidate.hostname !== host) return false;
    const escaped = pathname.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(candidate.pathname + candidate.search + candidate.hash);
  } catch { return false; }
}

function tabView(tab: HostedTab): BrowserTabView {
  const index = [...tabs.keys()].indexOf(tab.id);
  return {
    active: tab.active,
    autoDiscardable: tab.autoDiscardable,
    discarded: false,
    frozen: false,
    groupId: -1,
    highlighted: tab.active,
    id: tab.id,
    incognito: false,
    index: Math.max(0, index),
    lastAccessed: tab.lastAccessed,
    mutedInfo: { muted: false },
    ...(tab.pendingUrl ? { pendingUrl: tab.pendingUrl } : {}),
    // The extension already treats Chrome-pinned tabs as user-owned: it will neither recycle
    // nor idle-prune them. Mirror that semantic for tabs the user has actually viewed/asked to
    // open, without changing any of the author's recovery/attribution policy.
    pinned: tab.userHeld,
    selected: tab.active,
    status: tab.status,
    title: tab.title,
    url: tab.url,
    windowId: WINDOW_ID
  };
}

function publishEvent(type: BrowserHostEvent['type'], tabId: number, changeInfo?: Record<string, unknown>): void {
  events.push({ seq: ++eventSeq, type, tabId, ...(changeInfo ? { changeInfo } : {}) });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  wakeBrowserWork();
  notifyDockState();
}

function currentOwner(): BrowserWindow | null {
  return owner && !owner.isDestroyed() ? owner : null;
}

function notifyDockState(): void {
  const win = currentOwner();
  if (win) win.webContents.send('internalBrowser:stateChanged', internalBrowserDockState());
}

function parkedBounds(): InternalBrowserBounds {
  const width = Math.max(420, dockBounds?.width ?? 0);
  const height = Math.max(720, dockBounds?.height ?? 0);
  return { x: -width, y: 0, width, height };
}

function detachTab(tab: HostedTab, win: BrowserWindow | null = currentOwner()): void {
  if (!attachedTabIds.has(tab.id)) return;
  if (win && !win.isDestroyed()) {
    try { win.contentView.removeChildView(tab.view); } catch { /* Window teardown owns the native view now. */ }
  }
  attachedTabIds.delete(tab.id);
}

function detachAllAttached(win: BrowserWindow | null = owner): void {
  if (win && !win.isDestroyed()) {
    for (const tabId of attachedTabIds) {
      const tab = tabs.get(tabId);
      if (!tab) continue;
      try { win.contentView.removeChildView(tab.view); } catch { /* Window teardown owns the native view now. */ }
    }
  }
  attachedTabIds.clear();
}

function applyDock(): void {
  const win = currentOwner();
  if (!win) return;
  const parked = parkedBounds();
  for (const tab of tabs.values()) {
    if (tab.retired || tab.view.webContents.isDestroyed()) continue;
    if (!attachedTabIds.has(tab.id)) {
      win.contentView.addChildView(tab.view);
      attachedTabIds.add(tab.id);
    }
    const visibleBounds = dockOpen && tab.id === activeTabId ? dockBounds : null;
    tab.view.setBounds(visibleBounds ?? parked);
    tab.view.setVisible(true);
  }
}

function setActive(tab: HostedTab): void {
  if (activeTabId === tab.id && tab.active) {
    tab.lastAccessed = Date.now();
    applyDock();
    notifyDockState();
    return;
  }
  const previous = activeTabId === null ? null : tabs.get(activeTabId);
  if (previous && previous.id !== tab.id) {
    previous.active = false;
    publishEvent('updated', previous.id, { active: false });
  }
  activeTabId = tab.id;
  tab.active = true;
  tab.lastAccessed = Date.now();
  publishEvent('updated', tab.id, { active: true });
  applyDock();
}

function retireTab(tab: HostedTab): void {
  if (tab.retired) return;
  tab.retired = true;
  if (prewarmTabId === tab.id) prewarmTabId = null;
  detachTab(tab);
  tabs.delete(tab.id);
  const wasActive = activeTabId === tab.id;
  if (wasActive) activeTabId = null;
  publishEvent('removed', tab.id);
  if (wasActive) {
    const opener = tab.openerId === null ? null : tabs.get(tab.openerId);
    const next = opener ?? [...tabs.values()].sort((a, b) => b.lastAccessed - a.lastAccessed)[0] ?? null;
    if (next) setActive(next);
  }
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
}

function wireTab(tab: HostedTab): void {
  const contents = tab.view.webContents;
  contents.setWindowOpenHandler((details) => {
    if (!isWebUrl(details.url)) {
      if (/^(?:mailto|tel):/i.test(details.url)) void shell.openExternal(details.url).catch(() => {});
      return { action: 'deny' };
    }
    // Electron's createWindow hook keeps window.opener semantics (important for OAuth), but the
    // returned WebContents belongs to another WebContentsView instead of a BrowserWindow.
    return {
      action: 'allow',
      createWindow: () => {
        const child = createHostedTab('', true, tab.id, false);
        return child.view.webContents;
      }
    };
  });
  // Chrome's tabs.onUpdated status="loading" follows the tab loading indicator, not every
  // navigation attempt. Electron exposes that exact boundary as did-start-loading. Keep the
  // destination bookkeeping on did-start-navigation, but never turn redirects/restarts inside
  // one spinner cycle into extra document-terminal events: doing so can stamp a replacement
  // content-script document terminal after it already registered and temporarily black out its
  // exact request-id evidence.
  contents.on('did-start-loading', () => {
    if (tab.retired) return;
    tab.status = 'loading';
    publishEvent('updated', tab.id, {
      ...(tab.pendingUrl ? { url: tab.pendingUrl } : {}),
      status: 'loading'
    });
  });
  contents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame || tab.retired || isInPlace) return;
    tab.pendingUrl = url;
    // Chrome may expose a URL update while the tab is already loading. The extension uses URL
    // changes to detect a real departure, but only status="loading" is a document boundary.
    publishEvent('updated', tab.id, { url });
  });
  contents.on('did-navigate', (_event, url) => {
    if (tab.retired) return;
    tab.url = url;
    tab.pendingUrl = undefined;
  });
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame || tab.retired) return;
    tab.url = url;
    tab.pendingUrl = undefined;
    publishEvent('updated', tab.id, { url });
  });
  contents.on('did-stop-loading', () => {
    if (tab.retired) return;
    tab.url = contents.getURL() || tab.url;
    tab.pendingUrl = undefined;
    tab.status = 'complete';
    tab.title = contents.getTitle();
    publishEvent('updated', tab.id, { status: 'complete' });
  });
  contents.on('page-title-updated', (_event, title) => {
    if (tab.retired) return;
    tab.title = title;
    publishEvent('updated', tab.id, { title });
  });
  contents.once('destroyed', () => { if (!tab.retired) retireTab(tab); });
}

function insertHostedTab(tab: HostedTab, index?: number): void {
  if (index === undefined || index >= tabs.size) {
    tabs.set(tab.id, tab);
    return;
  }
  const ordered = [...tabs.entries()];
  const next = new Map<number, HostedTab>();
  for (let cursor = 0; cursor < ordered.length; cursor++) {
    if (cursor === index) next.set(tab.id, tab);
    const [id, existing] = ordered[cursor]!;
    next.set(id, existing);
  }
  tabs = next;
}

function createHostedTab(
  url: string,
  active: boolean,
  openerId: number | null = null,
  navigate = true,
  index?: number,
  userHeld = false
): HostedTab {
  if (!browserSession) throw new Error('Internal browser is not ready');
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  const tab: HostedTab = {
    view,
    id: view.webContents.id,
    active: false,
    userHeld,
    autoDiscardable: false,
    status: url ? 'loading' : 'complete',
    url: '',
    ...(url ? { pendingUrl: url } : {}),
    title: '',
    lastAccessed: Date.now(),
    openerId,
    retired: false
  };
  insertHostedTab(tab, index);
  wireTab(tab);
  // Chrome windows always have one active tab. `active: false` means "leave the current
  // active tab alone", not "create an inactive-only window". When this is the first tab,
  // it therefore becomes active logically even if the caller asked for background creation.
  // This does not reveal the dock; attachment/visibility is a separate app concern.
  if (active || activeTabId === null) setActive(tab);
  else {
    applyDock();
    notifyDockState();
  }
  logInfo(`internal browser: tab ${tab.id} created${active ? ' active' : ' background'} ${url || '(pending window.open)'}`);
  if (navigate && url) void view.webContents.loadURL(url).catch(error => {
    if (!tab.retired) logWarn(`internal browser navigation failed: ${error.message}`);
  });
  return tab;
}

function requireTab(id: number): HostedTab {
  const tab = tabs.get(id);
  if (!tab || tab.retired || tab.view.webContents.isDestroyed()) throw new Error(`No internal browser tab with id ${id}`);
  return tab;
}

async function loadCompanionExtension(ses: Session): Promise<void> {
  const directory = !app.isPackaged && process.env.COS_DEV_EXTENSION_DIR?.trim()
    ? process.env.COS_DEV_EXTENSION_DIR.trim()
    : extensionDir();
  if (!directory) throw new Error('The bundled Chat On Steroids companion extension is missing');
  const extension = await ses.extensions.loadExtension(directory);
  logInfo(`internal browser: companion extension ${extension.version} loaded`);
}

export async function ensureInternalBrowserReady(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const ses = session.fromPartition(PARTITION);
    browserSession = ses;
    // Present as Chromium rather than advertising the Electron shell to provider web code.
    ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/[^\s]+/i, ''));
    await loadCompanionExtension(ses);
  })().catch(error => {
    ready = null;
    browserSession = null;
    throw error;
  });
  return ready;
}

/** Only the app-owned ChatGPT partition may bypass the app shell's navigation lockdown. */
export function isInternalBrowserSession(candidate: Session): boolean {
  return browserSession !== null && candidate === browserSession;
}

/**
 * Start the app-owned browser before the desktop shell is shown.
 *
 * Before the desktop BrowserWindow exists, the first ChatGPT document can remain unattached while
 * it wakes the bundled extension and establishes the signed-in page/session. As soon as an owner
 * exists it is mounted offscreen like every other background tab. Repeated startup callers share
 * the same tab, and dock visibility remains a renderer/user decision.
 */
export async function prewarmInternalBrowser(): Promise<number> {
  await ensureInternalBrowserReady();
  const existing = prewarmTabId === null ? null : tabs.get(prewarmTabId) ?? null;
  if (existing && !existing.retired && !existing.view.webContents.isDestroyed()) return existing.id;
  if (prewarming) return prewarming;

  const work = (async () => {
    const tab = createHostedTab(HOME_URL, true, null, false);
    prewarmTabId = tab.id;
    try {
      // `loadURL` resolves only after the initial document finishes loading. Holding first-window
      // activation until this point avoids the old "click ChatGPT once to wake the extension"
      // race. If the BrowserWindow already exists, host layout keeps this view parked offscreen.
      await tab.view.webContents.loadURL(HOME_URL);
      return tab.id;
    } catch (error) {
      if (!tab.retired) retireTab(tab);
      throw error;
    }
  })();
  prewarming = work;
  try { return await work; }
  finally { if (prewarming === work) prewarming = null; }
}

export function attachInternalBrowserWindow(win: BrowserWindow): void {
  if (owner === win) {
    applyDock();
    return;
  }
  detachAllAttached(owner);
  owner = win;
  win.once('closed', () => {
    if (owner !== win) return;
    detachAllAttached(win);
    owner = null;
  });
  applyDock();
}

export function requestInternalBrowserDock(): void {
  dockOpen = true;
  const win = currentOwner();
  if (win) win.webContents.send('internalBrowser:showRequested');
  notifyDockState();
}

export async function showInternalBrowserDock(bounds: InternalBrowserBounds): Promise<InternalBrowserDockState> {
  await ensureInternalBrowserReady();
  dockOpen = true;
  dockBounds = bounds;
  if (activeTabId === null) createHostedTab(HOME_URL, true);
  else {
    const active = tabs.get(activeTabId);
    if (active) active.userHeld = true;
  }
  applyDock();
  return internalBrowserDockState();
}

export function layoutInternalBrowserDock(bounds: InternalBrowserBounds): InternalBrowserDockState {
  dockBounds = bounds;
  applyDock();
  return internalBrowserDockState();
}

export function hideInternalBrowserDock(): InternalBrowserDockState {
  dockOpen = false;
  applyDock();
  notifyDockState();
  return internalBrowserDockState();
}

export function internalBrowserDockState(): InternalBrowserDockState {
  const visibleTabs: InternalBrowserTabState[] = [...tabs.values()]
    .filter(tab => !tab.retired)
    .map(tab => ({
      id: tab.id,
      active: tab.id === activeTabId,
      status: tab.status,
      title: tab.title,
      url: tab.pendingUrl || tab.url
    }));
  return { open: dockOpen, ready: ready !== null, tabId: activeTabId, tabs: visibleTabs };
}

export function selectInternalBrowserTab(tabId: number): InternalBrowserDockState {
  const tab = requireTab(tabId);
  tab.userHeld = true;
  setActive(tab);
  return internalBrowserDockState();
}

export function closeInternalBrowserTab(tabId: number): InternalBrowserDockState {
  retireTab(requireTab(tabId));
  return internalBrowserDockState();
}

export async function openInternalBrowserUrl(
  url: string,
  options: { active?: boolean; reveal?: boolean; retain?: boolean } = {}
): Promise<number> {
  if (!isChatGptUrl(url)) throw new Error('Internal browser orchestration only opens ChatGPT URLs');
  await ensureInternalBrowserReady();
  const active = options.active ?? true;
  const retain = options.retain === true;
  // An explicit "open this recorded chat" is browser-tab semantics, not navigation semantics.
  // Preserve the tab the user is leaving before the new active tab can trigger maintenance.
  if (retain && active && activeTabId !== null) {
    const current = tabs.get(activeTabId);
    if (current) current.userHeld = true;
  }
  const existing = [...tabs.values()].find(tab => !tab.retired && (tab.url === url || tab.pendingUrl === url));
  const tab = existing ?? createHostedTab(url, active, null, true, undefined, retain);
  if (retain) tab.userHeld = true;
  if (existing && active) setActive(existing);
  if (options.reveal) requestInternalBrowserDock();
  return tab.id;
}

function queryTabs(query: { active?: boolean; lastFocusedWindow?: boolean; windowId?: number; url?: string | string[] }): BrowserTabView[] {
  if (query.windowId !== undefined && query.windowId !== WINDOW_ID) return [];
  const patterns = query.url === undefined ? null : Array.isArray(query.url) ? query.url : [query.url];
  return [...tabs.values()]
    .filter(tab => !tab.retired)
    .filter(tab => query.active === undefined || tab.active === query.active)
    .filter(tab => !patterns || patterns.some(pattern => internalBrowserUrlMatches(tab.pendingUrl || tab.url, pattern)))
    .map(tabView);
}

export async function handleInternalBrowserHostRequest(raw: unknown): Promise<unknown> {
  await ensureInternalBrowserReady();
  const request = hostRequest.parse(raw);
  if (request.action === 'query') return { tabs: queryTabs(request.query) };
  if (request.action === 'get') return { tab: tabView(requireTab(request.tabId)) };
  if (request.action === 'create') {
    if (!isChatGptUrl(request.create.url)) throw new Error('Extension may only create ChatGPT tabs');
    if (request.create.windowId !== undefined && request.create.windowId !== WINDOW_ID) {
      throw new Error(`No internal browser window with id ${request.create.windowId}`);
    }
    const tab = createHostedTab(
      request.create.url,
      request.create.active !== false,
      null,
      true,
      request.create.index
    );
    return { tab: tabView(tab) };
  }
  if (request.action === 'remove') {
    retireTab(requireTab(request.tabId));
    return { ok: true };
  }
  if (request.action === 'reload') {
    const tab = requireTab(request.tabId);
    tab.view.webContents.reload();
    return { ok: true };
  }
  if (request.action === 'update') {
    const tab = requireTab(request.tabId);
    if (request.update.autoDiscardable !== undefined) tab.autoDiscardable = request.update.autoDiscardable;
    if (request.update.active === true) setActive(tab);
    if (request.update.url !== undefined) {
      if (!isChatGptUrl(request.update.url)) throw new Error('Extension may only navigate tabs to ChatGPT');
      tab.pendingUrl = request.update.url;
      tab.status = 'loading';
      void tab.view.webContents.loadURL(request.update.url).catch(error => logWarn(`internal browser navigation failed: ${error.message}`));
    }
    return { tab: tabView(tab) };
  }
  const sameGeneration = request.generation === generation;
  const after = sameGeneration ? request.after : 0;
  const first = events[0]?.seq ?? eventSeq + 1;
  return {
    generation,
    cursor: eventSeq,
    reset: !sameGeneration || after < first - 1,
    events: events.filter(event => event.seq > after)
  };
}

export async function shutdownInternalBrowser(): Promise<void> {
  dockOpen = false;
  detachAllAttached(owner);
  const current = [...tabs.values()];
  tabs = new Map();
  activeTabId = null;
  for (const tab of current) {
    tab.retired = true;
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }
  owner = null;
  browserSession = null;
  ready = null;
  events = [];
  eventSeq = 0;
  generation = randomUUID();
  prewarmTabId = null;
  prewarming = null;
}
