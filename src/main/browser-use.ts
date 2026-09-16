/**
 * General-purpose browser controlled by the current ChatGPT agent.
 *
 * This is deliberately separate from internal-browser.ts. The internal browser is transport
 * infrastructure for ChatGPT itself; this service is an ordinary tool target. It has its own
 * persistent Session, no companion extension, no recorder/recovery authority and no bridge
 * participation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, session, View, WebContentsView, type Session } from 'electron';
import type {
  BrowserUseBounds,
  BrowserUseObservation,
  BrowserUsePermission,
  BrowserUseState,
  BrowserUseTabState
} from '../shared/browser-use.js';
import { logInfo, logWarn } from './logger.js';

const PARTITION = 'persist:cos-web';
const WORLD = 'cos-browser-use';
const MAX_ELEMENTS = 240;
const MAX_TEXT = 40_000;
const MAX_TABS = 12;
const DEFAULT_PAGE = 'https://www.google.com/';
const CURSOR_MARKER = 'data-cos-browser-use-agent-cursor';

interface BrowserUseTab {
  id: number;
  view: WebContentsView;
  loading: boolean;
  title: string;
  url: string;
  pendingUrl?: string;
  retired: boolean;
  navigationEpoch: number;
  snapshotId: number;
  snapshotEpoch: number;
  snapshotLayoutEpoch: number;
  snapshotOrigin: string | null;
  executionContextId: number | null;
  executionContextEpoch: number;
  ready: Promise<void>;
}

interface PendingPermission {
  tabId: number;
  request: BrowserUsePermission;
  promise: Promise<void>;
  allow(always: boolean): void;
  deny(reason?: string): void;
}

let owner: BrowserWindow | null = null;
let browserSession: Session | null = null;
let ready: Promise<void> | null = null;
let tabs = new Map<number, BrowserUseTab>();
let activeTabId: number | null = null;
let panelOpen = false;
let panelBounds: BrowserUseBounds | null = null;
let panelLayoutEpoch = 0;
let viewportHost: View | null = null;
let viewportHostOwner: BrowserWindow | null = null;
let attachedTabIds = new Set<number>();
let pendingPermission: PendingPermission | null = null;
let nextSnapshotId = 1;
const transientOrigins = new Map<number, string>();
const persistentOrigins = new Set<string>();
const agentCursorTabs = new Set<number>();
const agentCursorPositions = new Map<number, { x: number; y: number }>();
const agentCursorPendingCompletion = new Set<number>();
let agentMissionActive = false;
let agentMissionIdleTimer: ReturnType<typeof setTimeout> | null = null;

const AGENT_MISSION_IDLE_TIMEOUT_MS = 5 * 60_000;
const AGENT_MISSION_FINISH_GRACE_MS = 360;

function preferencesFile(): string {
  return path.join(app.getPath('userData'), 'browser-use', 'preferences.json');
}

function loadPreferences(): void {
  try {
    const file = preferencesFile();
    if (!fs.existsSync(file) || fs.statSync(file).size > 64 * 1024) return;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const origins = (parsed as { allowedOrigins?: unknown }).allowedOrigins;
    if (!Array.isArray(origins)) return;
    for (const entry of origins.slice(0, 500)) {
      if (typeof entry !== 'string') continue;
      try {
        const origin = new URL(entry).origin;
        if (origin === entry && /^https?:$/.test(new URL(entry).protocol)) {
          persistentOrigins.add(origin);
        }
      } catch { /* Ignore damaged preference rows. */ }
    }
  } catch (error) {
    logWarn(`browser use preferences: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function savePreferences(): void {
  try {
    const file = preferencesFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ allowedOrigins: [...persistentOrigins].sort() }, null, 2) + '\n');
    fs.renameSync(temporary, file);
  } catch (error) {
    logWarn(`browser use preferences save: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function normalizeBrowserUseTarget(value: string): string {
  const input = value.trim();
  if (!input || input.length > 4096) throw new Error('Enter a web address or search query.');
  if (input === 'about:blank') return input;
  let target = input;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(target)) target = `http://${target}`;
  else if (!/^[a-z][a-z\d+.-]*:/i.test(target)) {
    if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(target)) target = `https://${target}`;
    else target = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
  }
  let url: URL;
  try { url = new URL(target); }
  catch { throw new Error('That is not a valid web address.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Browser Use accepts only http and https pages.');
  return url.toString();
}

function targetOrigin(value: string): string | null {
  try { return permissionFor(normalizeBrowserUseTarget(value)); }
  catch { return null; }
}

function clearTransientTrustOnOriginChange(tab: BrowserUseTab, value: string): void {
  const trusted = transientOrigins.get(tab.id);
  if (!trusted) return;
  if (targetOrigin(value) !== trusted) transientOrigins.delete(tab.id);
}

function tabState(tab: BrowserUseTab): BrowserUseTabState {
  const history = tab.view.webContents.navigationHistory;
  return {
    id: tab.id,
    active: tab.id === activeTabId,
    loading: tab.loading,
    title: tab.title,
    url: tab.pendingUrl || tab.url,
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward()
  };
}

export function browserUseState(): BrowserUseState {
  return {
    open: panelOpen,
    ready: ready !== null,
    agentActive: agentMissionActive,
    activeTabId,
    tabs: [...tabs.values()].filter(tab => !tab.retired).map(tabState),
    permission: pendingPermission?.request ?? null
  };
}

/** Model-facing tab catalogue. Unapproved documents expose only the origin needed to ask for consent. */
export function browserUseAgentTabs(): Array<Record<string, unknown>> {
  return [...tabs.values()].filter(tab => !tab.retired).map(tab => {
    const base = { id: tab.id, active: tab.id === activeTabId, loading: tab.loading };
    if (pendingPermission?.tabId === tab.id) {
      return { ...base, approval_required: pendingPermission.request.origin };
    }
    try {
      const origin = currentTabOrigin(tab);
      if (!originAuthorized(tab, origin)) return { ...base, approval_required: origin ?? true };
      const state = tabState(tab);
      return {
        ...base,
        title: state.title,
        url: state.url,
        can_go_back: state.canGoBack,
        can_go_forward: state.canGoForward
      };
    } catch {
      return { ...base, approval_required: true };
    }
  });
}

/** Cheap model-facing overview for hot-path binding without rebuilding renderer state. */
export function browserUseAgentOverview(): {
  tabs: Array<Record<string, unknown>>;
  activeTabId: number | null;
  agentActive: boolean;
} {
  return { tabs: browserUseAgentTabs(), activeTabId, agentActive: agentMissionActive };
}

function currentOwner(): BrowserWindow | null {
  return owner && !owner.isDestroyed() ? owner : null;
}

function publishState(): void {
  const win = currentOwner();
  if (win && !win.webContents.isDestroyed()) win.webContents.send('browserUse:stateChanged', browserUseState());
}

function cancelBrowserUseMissionTimeout(): void {
  if (agentMissionIdleTimer) clearTimeout(agentMissionIdleTimer);
  agentMissionIdleTimer = null;
}

function armBrowserUseMissionTimeout(): void {
  cancelBrowserUseMissionTimeout();
  if (!agentMissionActive) return;
  agentMissionIdleTimer = setTimeout(() => {
    agentMissionIdleTimer = null;
    void finishBrowserUseAgentMission({ graceMs: 0 });
  }, AGENT_MISSION_IDLE_TIMEOUT_MS);
}

/**
 * Browser Use visual ownership is a mission, not one MCP call. The first agent action starts it;
 * state/click/type/navigation/wait calls merely refresh it; `browser done` ends it explicitly.
 * This keeps glow and cursor stable while the model reasons between steps.
 */
export function beginBrowserUseAgentMission(): void {
  const changed = !agentMissionActive;
  agentMissionActive = true;
  armBrowserUseMissionTimeout();
  if (changed) publishState();
  // The hot path calls this for every Browser Use action. Re-evaluating the exact same glow
  // script on an already-owned page is pure CDP latency, so only repair visuals when a mission
  // starts or navigation replaced the document and dropped our injected overlay.
  const activeNeedsVisual = activeTabId !== null && !agentCursorTabs.has(activeTabId);
  if (changed || activeNeedsVisual) void setActivePageGlow(true);
}

export function touchBrowserUseAgentMission(): void {
  if (agentMissionActive) armBrowserUseMissionTimeout();
}

export async function finishBrowserUseAgentMission(options: { graceMs?: number } = {}): Promise<void> {
  cancelBrowserUseMissionTimeout();
  const graceMs = Math.max(0, Math.min(1000, options.graceMs ?? AGENT_MISSION_FINISH_GRACE_MS));
  const hadMission = agentMissionActive || agentCursorTabs.size > 0;
  agentMissionActive = false;
  publishState();
  if (hadMission && graceMs > 0) await new Promise(resolve => setTimeout(resolve, graceMs));
  // A fresh browser call may have started a new mission during the completion grace window.
  // Never let the previous `done` clear that new mission's cursor/glow.
  if (agentMissionActive) return;
  await clearAgentCursorOverlays(true);
}

/** One agent step inside the current Browser Use mission. Errors do not end the mission. */
export async function withBrowserUseAgentActivity<T>(work: () => Promise<T> | T): Promise<T> {
  beginBrowserUseAgentMission();
  try {
    return await work();
  } finally {
    touchBrowserUseAgentMission();
  }
}

/** A manual browser-chrome action immediately hands control back to the user. */
export function noteBrowserUseUserTakeover(): void {
  cancelBrowserUseMissionTimeout();
  agentMissionActive = false;
  publishState();
  void clearAgentCursorOverlays(true);
}

function ensureViewportHost(): View {
  if (viewportHost) return viewportHost;
  const host = new View();
  host.setBackgroundColor('#00000000');
  host.setVisible(false);
  viewportHost = host;
  return host;
}

function attachViewportHost(win: BrowserWindow): View {
  const host = ensureViewportHost();
  if (viewportHostOwner === win) return host;
  if (viewportHostOwner && !viewportHostOwner.isDestroyed()) {
    try { viewportHostOwner.contentView.removeChildView(host); } catch { /* Window teardown may already own it. */ }
  }
  win.contentView.addChildView(host);
  viewportHostOwner = win;
  return host;
}

function applyPanel(): void {
  const win = currentOwner();
  if (!win) return;
  const host = attachViewportHost(win);
  for (const tab of tabs.values()) {
    if (tab.retired || tab.view.webContents.isDestroyed()) continue;
    if (!attachedTabIds.has(tab.id)) {
      host.addChildView(tab.view);
      attachedTabIds.add(tab.id);
    }
    const visible = panelOpen && !!panelBounds && tab.id === activeTabId;
    if (visible && panelBounds) {
      tab.view.setBounds({ x: 0, y: 0, width: panelBounds.width, height: panelBounds.height });
    }
    tab.view.setVisible(visible);
  }
  if (panelOpen && panelBounds) {
    host.setBounds(panelBounds);
    host.setVisible(true);
  } else {
    host.setVisible(false);
  }
}

function detachViewportHost(win: BrowserWindow | null = viewportHostOwner): void {
  if (viewportHost && win && !win.isDestroyed()) {
    try { win.contentView.removeChildView(viewportHost); } catch { /* Teardown may already own it. */ }
  }
  if (viewportHostOwner === win) viewportHostOwner = null;
}

function detachAll(): void {
  if (viewportHost) {
    for (const id of attachedTabIds) {
      const tab = tabs.get(id);
      if (!tab) continue;
      try { viewportHost.removeChildView(tab.view); } catch { /* Teardown may already own it. */ }
    }
  }
  attachedTabIds.clear();
}

function invalidate(tab: BrowserUseTab): void {
  tab.snapshotId = 0;
  tab.snapshotEpoch = -1;
  tab.snapshotLayoutEpoch = -1;
  tab.snapshotOrigin = null;
}

function setPanelBounds(bounds: BrowserUseBounds): void {
  const sizeChanged = panelBounds === null ||
    panelBounds.width !== bounds.width || panelBounds.height !== bounds.height;
  panelBounds = bounds;
  if (!sizeChanged) return;
  panelLayoutEpoch += 1;
  // DOM refs and their coordinates are viewport-relative. A width/height change can reflow the
  // page without a navigation, so every snapshot made against the old viewport is stale.
  for (const tab of tabs.values()) invalidate(tab);
}

async function initializeTab(tab: BrowserUseTab): Promise<void> {
  const contents = tab.view.webContents;
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
  await contents.debugger.sendCommand('Page.enable');
  await contents.debugger.sendCommand('Runtime.enable');
  await contents.debugger.sendCommand('DOM.enable');
  await contents.debugger.sendCommand('Accessibility.enable');
  await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
}

function setActive(tab: BrowserUseTab): void {
  if (tab.retired) return;
  // Most agent steps stay on one tab. Re-applying the native view tree and publishing an
  // identical renderer state on every state/click/type call used to add work with no semantic
  // effect. Layout changes and window recreation already call applyPanel() at their own edges.
  if (activeTabId === tab.id) return;
  const previous = activeTabId === null ? null : tabs.get(activeTabId) ?? null;
  activeTabId = tab.id;
  applyPanel();
  publishState();
  if (agentMissionActive) {
    if (previous && previous.id !== tab.id) void setAgentGlow(previous, false);
    void restoreAgentMissionVisuals(tab);
  }
}

function retireTab(tab: BrowserUseTab): void {
  if (tab.retired) return;
  tab.retired = true;
  agentCursorTabs.delete(tab.id);
  agentCursorPositions.delete(tab.id);
  agentCursorPendingCompletion.delete(tab.id);
  transientOrigins.delete(tab.id);
  if (pendingPermission?.tabId === tab.id) {
    pendingPermission.deny('Browser Use permission was cancelled because the tab closed.');
  }
  if (attachedTabIds.has(tab.id)) {
    if (viewportHost) try { viewportHost.removeChildView(tab.view); } catch { /* window teardown */ }
    attachedTabIds.delete(tab.id);
  }
  tabs.delete(tab.id);
  if (activeTabId === tab.id) {
    activeTabId = [...tabs.keys()].at(-1) ?? null;
  }
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  applyPanel();
  publishState();
}

function wireTab(tab: BrowserUseTab): void {
  const contents = tab.view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    try { normalizeBrowserUseTarget(url); }
    catch { return { action: 'deny' }; }
    if (tabs.size >= MAX_TABS) return { action: 'deny' };
    return {
      action: 'allow',
      outlivesOpener: true,
      createWindow: () => {
        const child = createBrowserUseTab('about:blank', true, false);
        // A page-created popup is not user consent for the popup's origin. Electron must
        // create the WebContents synchronously here, so let Chromium complete the popup
        // navigation but keep its origin untrusted. The next agent state/action on that tab
        // runs through authorizeAgentTab() and surfaces the same in-app approval as any other
        // cross-origin navigation. This prevents an allowed site from laundering access to an
        // arbitrary second origin with window.open().
        return child.view.webContents;
      }
    };
  });
  contents.on('did-start-loading', () => {
    if (tab.retired) return;
    tab.loading = true;
    invalidate(tab);
    publishState();
  });
  contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
    if (tab.retired || !mainFrame || inPlace) return;
    agentCursorTabs.delete(tab.id);
    tab.executionContextId = null;
    tab.executionContextEpoch = -1;
    tab.navigationEpoch += 1;
    clearTransientTrustOnOriginChange(tab, url);
    tab.pendingUrl = url;
    invalidate(tab);
    publishState();
  });
  contents.on('did-navigate', (_event, url) => {
    if (tab.retired) return;
    clearTransientTrustOnOriginChange(tab, url);
    tab.url = url;
    tab.pendingUrl = undefined;
    invalidate(tab);
  });
  contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
    if (tab.retired || !mainFrame) return;
    tab.navigationEpoch += 1;
    tab.executionContextId = null;
    tab.executionContextEpoch = -1;
    clearTransientTrustOnOriginChange(tab, url);
    tab.url = url;
    tab.pendingUrl = undefined;
    invalidate(tab);
    publishState();
  });
  contents.on('did-stop-loading', () => {
    if (tab.retired) return;
    tab.loading = false;
    tab.url = contents.getURL() || tab.url;
    tab.pendingUrl = undefined;
    tab.title = contents.getTitle();
    publishState();
    if (agentMissionActive && tab.id === activeTabId) void restoreAgentMissionVisuals(tab);
  });
  contents.on('dom-ready', () => {
    if (tab.retired || !agentMissionActive || tab.id !== activeTabId) return;
    void restoreAgentMissionVisuals(tab);
  });
  contents.on('page-title-updated', (_event, title) => {
    if (tab.retired) return;
    tab.title = title;
    publishState();
  });
  contents.once('destroyed', () => { if (!tab.retired) retireTab(tab); });
}

function createBrowserUseTab(url = 'about:blank', active = true, navigate = true): BrowserUseTab {
  if (!browserSession) throw new Error('Browser Use is not ready.');
  if (tabs.size >= MAX_TABS) throw new Error(`Browser Use supports up to ${MAX_TABS} tabs. Close one before opening another.`);
  const view = new WebContentsView({ webPreferences: {
    session: browserSession,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    backgroundThrottling: false,
    spellcheck: true
  } });
  // WebContentsView defaults to an opaque white backing surface. Make it transparent so any
  // sub-pixel compositor seam at the native-view boundary reveals the panel beneath instead of
  // drawing a permanent white frame around the website.
  view.setBackgroundColor('#00000000');
  const contents = view.webContents;
  contents.setUserAgent(contents.getUserAgent().replace(/\sElectron\/\S+/i, ''));
  const tab: BrowserUseTab = {
    id: contents.id,
    view,
    loading: url !== 'about:blank',
    title: '',
    url: url === 'about:blank' ? url : '',
    ...(url === 'about:blank' ? {} : { pendingUrl: url }),
    retired: false,
    navigationEpoch: 0,
    snapshotId: 0,
    snapshotEpoch: -1,
    snapshotLayoutEpoch: -1,
    snapshotOrigin: null,
    executionContextId: null,
    executionContextEpoch: -1,
    ready: Promise.resolve()
  };
  tabs.set(tab.id, tab);
  wireTab(tab);
  tab.ready = initializeTab(tab).catch(error => {
    logWarn(`browser use tab ${tab.id} debugger: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });
  if (active || activeTabId === null) activeTabId = tab.id;
  applyPanel();
  publishState();
  if (navigate && url !== 'about:blank') void contents.loadURL(url).catch(error => {
    if (!tab.retired) logWarn(`browser use navigation: ${error instanceof Error ? error.message : String(error)}`);
  });
  logInfo(`browser use: tab ${tab.id} created ${url}`);
  return tab;
}

export class BrowserUseProtocolError extends Error {
  constructor(readonly code: 'STALE_TAB', message: string) {
    super(message);
    this.name = 'BrowserUseProtocolError';
  }
}

function staleTabError(id: number): BrowserUseProtocolError {
  return new BrowserUseProtocolError(
    'STALE_TAB',
    `Browser Use tab ${id} is no longer available. Observe the current active tab before continuing.`
  );
}

function requireTab(id: number): BrowserUseTab {
  const tab = tabs.get(id);
  if (!tab || tab.retired || tab.view.webContents.isDestroyed()) {
    throw staleTabError(id);
  }
  return tab;
}

export async function ensureBrowserUseReady(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const ses = session.fromPartition(PARTITION);
    browserSession = ses;
    ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/[^\s]+/i, ''));
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    loadPreferences();
  })().catch(error => {
    ready = null;
    browserSession = null;
    throw error;
  });
  return ready;
}

/** Exact-session exemption for the shell navigation lockdown. */
export function isBrowserUseSession(candidate: Session): boolean {
  return browserSession !== null && candidate === browserSession;
}

export function attachBrowserUseWindow(win: BrowserWindow): void {
  if (owner === win) { applyPanel(); return; }
  detachViewportHost(owner);
  owner = win;
  win.once('closed', () => {
    if (owner !== win) return;
    detachViewportHost(win);
    owner = null;
  });
  applyPanel();
}

export function requestBrowserUsePanel(): void {
  const changed = !panelOpen;
  panelOpen = true;
  if (!changed) return;
  // setActive() intentionally no-ops for the already-active tab, so the closed -> open edge
  // owns the one native layout application needed to make an existing viewport visible again.
  applyPanel();
  const win = currentOwner();
  if (win) win.webContents.send('browserUse:showRequested');
  publishState();
  if (agentMissionActive) void setActivePageGlow(true);
}

export async function showBrowserUsePanel(bounds: BrowserUseBounds): Promise<BrowserUseState> {
  await ensureBrowserUseReady();
  panelOpen = true;
  setPanelBounds(bounds);
  if (activeTabId === null) {
    const tab = createBrowserUseTab();
    await navigateBrowserUseTab(tab.id, DEFAULT_PAGE, 'user');
  }
  applyPanel();
  publishState();
  return browserUseState();
}

export function layoutBrowserUsePanel(bounds: BrowserUseBounds): BrowserUseState {
  setPanelBounds(bounds);
  applyPanel();
  return browserUseState();
}

export function hideBrowserUsePanel(): BrowserUseState {
  panelOpen = false;
  cancelBrowserUseMissionTimeout();
  agentMissionActive = false;
  void clearAgentCursorOverlays(true);
  applyPanel();
  publishState();
  return browserUseState();
}

export function selectBrowserUseTab(tabId: number): BrowserUseState {
  setActive(requireTab(tabId));
  return browserUseState();
}

export function closeBrowserUseTab(tabId: number): BrowserUseState {
  retireTab(requireTab(tabId));
  return browserUseState();
}

function permissionFor(url: string): string | null {
  if (url === 'about:blank') return null;
  return new URL(url).origin;
}

function currentTabUrl(tab: BrowserUseTab): string {
  return tab.pendingUrl || tab.url || tab.view.webContents.getURL() || 'about:blank';
}

function currentTabOrigin(tab: BrowserUseTab): string | null {
  return permissionFor(normalizeBrowserUseTarget(currentTabUrl(tab)));
}

function originAuthorized(tab: BrowserUseTab, origin: string | null): boolean {
  return origin === null || persistentOrigins.has(origin) || transientOrigins.get(tab.id) === origin;
}

function trustTabOrigin(tab: BrowserUseTab, origin: string | null): void {
  if (origin) transientOrigins.set(tab.id, origin);
  else transientOrigins.delete(tab.id);
}

async function authorizeAgentNavigation(tab: BrowserUseTab, url: string): Promise<void> {
  const origin = permissionFor(url);
  if (!origin || originAuthorized(tab, origin)) return;
  if (pendingPermission) {
    if (pendingPermission.tabId === tab.id && pendingPermission.request.origin === origin) return pendingPermission.promise;
    throw new Error(`Finish the pending Browser Use permission for ${pendingPermission.request.origin} first.`);
  }
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const request = { id: randomUUID(), origin, url };
  const timer = setTimeout(() => {
    if (pendingPermission?.request.id !== request.id) return;
    pendingPermission = null;
    publishState();
    reject(new Error(`Browser Use permission for ${origin} expired.`));
  }, 60_000);
  pendingPermission = {
    tabId: tab.id,
    request,
    promise,
    allow(always) {
      clearTimeout(timer);
      if (always) {
        persistentOrigins.add(origin);
        savePreferences();
      } else {
        trustTabOrigin(tab, origin);
      }
      pendingPermission = null;
      publishState();
      resolve();
    },
    deny(reason) {
      clearTimeout(timer);
      pendingPermission = null;
      publishState();
      reject(new Error(reason || `Browser Use permission for ${origin} was declined.`));
    }
  };
  requestBrowserUsePanel();
  publishState();
  return promise;
}

async function authorizeAgentTab(tab: BrowserUseTab): Promise<void> {
  const current = currentTabUrl(tab);
  if (!current || current === 'about:blank') return;
  await authorizeAgentNavigation(tab, normalizeBrowserUseTarget(current));
}

export function settleBrowserUsePermission(id: string, decision: 'once' | 'always' | 'deny'): BrowserUseState {
  if (!pendingPermission || pendingPermission.request.id !== id) return browserUseState();
  if (decision === 'deny') pendingPermission.deny();
  else pendingPermission.allow(decision === 'always');
  return browserUseState();
}

function isAbortedNavigation(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ERR_ABORTED') return true;
  return error instanceof Error && /\bERR_ABORTED\b/.test(error.message);
}

function ordinaryLoadedUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export async function navigateBrowserUseTab(tabId: number, value: string, source: 'user' | 'agent'): Promise<BrowserUseState> {
  await ensureBrowserUseReady();
  const tab = requireTab(tabId);
  const url = normalizeBrowserUseTarget(value);
  const origin = permissionFor(url);
  if (source === 'agent') await authorizeAgentNavigation(tab, url);
  else trustTabOrigin(tab, origin);
  setActive(tab);
  tab.pendingUrl = url;
  tab.loading = true;
  invalidate(tab);
  publishState();
  const contents = tab.view.webContents;
  const epochBeforeLoad = tab.navigationEpoch;
  const previousUrl = ordinaryLoadedUrl(contents.getURL());
  try {
    await contents.loadURL(url);
  } catch (error) {
    // Closing/retiring a tab aborts its pending load in Chromium, often as ERR_FAILED (-2).
    // That is a lifecycle result, not a network failure. A user-owned navigation that loses
    // this race should quietly settle to the current Browser Use state; an agent action must
    // remain bound to its original tab and fail as STALE_TAB rather than being retargeted.
    if (tab.retired) {
      if (source === 'agent') throw staleTabError(tabId);
      return browserUseState();
    }
    if (!isAbortedNavigation(error)) throw error;
    // Electron rejects loadURL with ERR_ABORTED when another main-frame navigation wins the
    // race. That is normal for redirects/SPAs and must not become a raw toast. Only accept the
    // abort when there is positive evidence of a replacement navigation; a user stop or a real
    // failed load still rejects normally.
    const pendingReplacement = tab.pendingUrl ? ordinaryLoadedUrl(tab.pendingUrl) : null;
    const liveUrl = ordinaryLoadedUrl(contents.getURL());
    const superseded =
      tab.navigationEpoch > epochBeforeLoad + 1 ||
      (pendingReplacement !== null && pendingReplacement !== url) ||
      (liveUrl !== null && liveUrl !== previousUrl && liveUrl !== url);
    if (!superseded) throw error;
  }
  return browserUseState();
}

export async function openBrowserUseTab(value?: string, source: 'user' | 'agent' = 'user'): Promise<BrowserUseState> {
  await ensureBrowserUseReady();
  requestBrowserUsePanel();
  const tab = createBrowserUseTab();
  return navigateBrowserUseTab(tab.id, value?.trim() || DEFAULT_PAGE, source);
}

function historyTarget(tab: BrowserUseTab, action: 'back' | 'forward' | 'reload'): string | null {
  if (action === 'reload') return tab.pendingUrl || tab.url || tab.view.webContents.getURL() || null;
  const history = tab.view.webContents.navigationHistory;
  const offset = action === 'back' ? -1 : 1;
  if (!history.canGoToOffset(offset)) return null;
  return history.getEntryAtIndex(history.getActiveIndex() + offset)?.url ?? null;
}

export async function browserUseHistory(
  tabId: number,
  action: 'back' | 'forward' | 'reload',
  source: 'user' | 'agent' = 'user'
): Promise<BrowserUseState> {
  const tab = requireTab(tabId);
  const target = historyTarget(tab, action);
  if (source === 'agent') {
    if (action !== 'reload' && target === null) return browserUseState();
    if (target) await authorizeAgentNavigation(tab, normalizeBrowserUseTarget(target));
    else await authorizeAgentTab(tab);
  } else if (target) {
    try {
      const origin = permissionFor(normalizeBrowserUseTarget(target));
      trustTabOrigin(tab, origin);
    } catch { /* User-owned history may contain Chromium error pages; do not broaden agent trust. */ }
  }
  invalidate(tab);
  if (action === 'reload') tab.view.webContents.reload();
  else if (action === 'back' && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
  else if (action === 'forward' && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
  return browserUseState();
}

async function isolatedContext(tab: BrowserUseTab): Promise<number> {
  await tab.ready;
  if (tab.executionContextId !== null && tab.executionContextEpoch === tab.navigationEpoch) {
    return tab.executionContextId;
  }
  const epoch = tab.navigationEpoch;
  const tree = await tab.view.webContents.debugger.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } };
  const world = await tab.view.webContents.debugger.sendCommand('Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id,
    worldName: WORLD
  }) as { executionContextId: number };
  if (tab.navigationEpoch !== epoch) throw browserStateChanged();
  tab.executionContextId = world.executionContextId;
  tab.executionContextEpoch = epoch;
  return world.executionContextId;
}

async function evaluate<T>(tab: BrowserUseTab, expression: string): Promise<T> {
  const contextId = await isolatedContext(tab);
  const reply = await tab.view.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || 'Page script failed.');
  return reply.result?.value as T;
}

function agentVisualScript(options: {
  glow?: boolean;
  point?: { x: number; y: number };
  from?: { x: number; y: number };
  kind?: 'click' | 'type' | 'scroll' | 'hover';
  durationMs?: number;
  complete?: boolean;
}): string {
  const point = options.point;
  const from = options.from ?? point;
  const left = Math.round(point?.x ?? 0);
  const top = Math.round(point?.y ?? 0);
  const fromLeft = Math.round(from?.x ?? left);
  const fromTop = Math.round(from?.y ?? top);
  const duration = options.durationMs === 0
    ? 0
    : Math.max(120, Math.min(1050, Math.round(options.durationMs ?? 320)));
  const hasPoint = !!point;
  return `(() => {
    const marker = ${JSON.stringify(CURSOR_MARKER)};
    let visual = globalThis.__cosBrowserUseAgentVisual;
    if (!visual?.host?.isConnected) {
      for (const stale of document.querySelectorAll('[' + marker + ']')) stale.remove();
      const host = document.createElement('div');
      host.setAttribute(marker, '');
      host.style.cssText = 'all:initial;display:block;position:fixed;inset:0;pointer-events:none!important;z-index:2147483647;contain:layout style paint;';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<style>:host,*{pointer-events:none!important;box-sizing:border-box}.glow{position:fixed;inset:0;opacity:0;box-shadow:inset 0 0 0 3px #287cff,inset 0 0 22px 3px rgb(40 124 255 / 48%);transition:opacity 70ms linear}.cursor{position:fixed;left:0;top:0;width:30px;height:34px;opacity:0;transform:translate3d(-80px,-80px,0);filter:drop-shadow(0 2px 3px #0007);will-change:transform;transition-property:transform,opacity;transition-timing-function:cubic-bezier(.22,.61,.36,1),linear}svg{display:block;width:23px;height:27px}.badge{position:absolute;left:14px;top:16px;min-width:16px;height:16px;padding:0 3px;border:1px solid #fff;border-radius:999px;background:#287cff;color:#fff;font:700 8px/14px system-ui,sans-serif;text-align:center;box-shadow:0 0 9px #287cff99;transition:background .12s ease,box-shadow .12s ease}.badge.done{background:#22c55e;box-shadow:0 0 10px #22c55e99}.pulse{position:absolute;left:-8px;top:-8px;width:18px;height:18px;border:2px solid #287cff;border-radius:50%;opacity:0}.pulse.run{animation:pulse .36s ease-out}@keyframes pulse{0%{transform:scale(.35);opacity:.95}100%{transform:scale(1.9);opacity:0}}</style><div class="glow"></div><div class="cursor"><svg viewBox="0 0 24 28" aria-hidden="true"><path d="M2 1.8v20.1l5.2-5.1 3.7 8.2 4.1-1.9-3.6-7.8h7.5z" fill="#287cff" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><span class="badge">AI</span><span class="pulse"></span></div>';
      (document.documentElement || document.body).appendChild(host);
      visual = { host, shadow, cursorReady: false };
      globalThis.__cosBrowserUseAgentVisual = visual;
    }
    const glow = visual.shadow.querySelector('.glow');
    if (${options.glow === undefined ? 'null' : JSON.stringify(options.glow) } !== null) glow.style.opacity = ${options.glow ? "'1'" : "'0'"};
    const cursor = visual.shadow.querySelector('.cursor');
    if (${JSON.stringify(hasPoint)}) {
      cursor.style.transitionDuration = '${duration}ms,55ms';
      if (!visual.cursorReady) {
        cursor.style.transitionProperty = 'none';
        cursor.style.transform = 'translate3d(${fromLeft}px,${fromTop}px,0)';
        cursor.style.opacity = '1';
        void cursor.offsetWidth;
        cursor.style.transitionProperty = 'transform,opacity';
        visual.cursorReady = true;
      } else {
        cursor.style.opacity = '1';
      }
      requestAnimationFrame(() => { cursor.style.transform = 'translate3d(${left}px,${top}px,0)'; });
    }
    if (${JSON.stringify(!!options.complete)}) {
      const pulse = visual.shadow.querySelector('.pulse');
      pulse.classList.remove('run'); void pulse.offsetWidth; pulse.classList.add('run');
      const badge = visual.shadow.querySelector('.badge');
      badge.textContent = '✓'; badge.classList.add('done');
      clearTimeout(visual.doneTimer);
      visual.doneTimer = setTimeout(() => { badge.textContent = 'AI'; badge.classList.remove('done'); }, 320);
    }
    return true;
  })()`;
}

async function showAgentCursor(
  tab: BrowserUseTab,
  snapshotId: number,
  point: { x: number; y: number },
  kind: 'click' | 'type' | 'scroll' | 'hover'
): Promise<{ previous: { x: number; y: number }; durationMs: number }> {
  requireSnapshot(tab, snapshotId);
  const previous = agentCursorPositions.get(tab.id) ?? (panelBounds
    ? { x: panelBounds.width / 2, y: panelBounds.height / 2 }
    : point);
  const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
  const durationMs = distance < 4 ? 0 : Math.max(260, Math.min(1000, 260 + distance * 1.25));
  await evaluate(tab, agentVisualScript({ glow: true, point, from: previous, kind, durationMs }));
  requireSnapshot(tab, snapshotId);
  agentCursorTabs.add(tab.id);
  return { previous, durationMs };
}

async function signalAgentCursorComplete(tab: BrowserUseTab): Promise<boolean> {
  if (tab.retired || tab.view.webContents.isDestroyed()) return false;
  try {
    await evaluate(tab, agentVisualScript({ complete: true }));
    return true;
  } catch {
    // Navigation may replace the document before completion feedback can render. The pending
    // completion is replayed when the authorized replacement document restores mission visuals.
    return false;
  }
}

async function restoreAgentCursor(tab: BrowserUseTab): Promise<void> {
  const point = agentCursorPositions.get(tab.id);
  if (!point || tab.retired || tab.view.webContents.isDestroyed()) return;
  let origin: string | null;
  try { origin = currentTabOrigin(tab); }
  catch { return; }
  if (!originAuthorized(tab, origin)) return;
  try {
    await evaluate(tab, agentVisualScript({
      glow: agentMissionActive,
      point,
      from: point,
      durationMs: 0
    }));
    agentCursorTabs.add(tab.id);
  } catch { /* Page may still be replacing its execution context. */ }
}

async function restoreAgentMissionVisuals(tab: BrowserUseTab): Promise<void> {
  if (!agentMissionActive || tab.retired || tab.id !== activeTabId || tab.view.webContents.isDestroyed()) return;
  if (agentCursorPositions.has(tab.id)) await restoreAgentCursor(tab);
  else await setAgentGlow(tab, true);
  if (agentCursorPendingCompletion.has(tab.id) && await signalAgentCursorComplete(tab)) {
    agentCursorPendingCompletion.delete(tab.id);
  }
}

async function setAgentGlow(tab: BrowserUseTab, visible: boolean): Promise<void> {
  if (tab.retired || tab.view.webContents.isDestroyed()) return;
  let origin: string | null;
  try { origin = currentTabOrigin(tab); }
  catch { return; }
  if (!originAuthorized(tab, origin)) return;
  if (visible) agentCursorTabs.add(tab.id);
  try {
    await evaluate(tab, agentVisualScript({ glow: visible }));
  } catch { /* Navigation may invalidate the visual context between tool lifecycle edges. */ }
}

async function setActivePageGlow(visible: boolean): Promise<void> {
  const tab = activeTabId === null ? null : tabs.get(activeTabId);
  if (tab) await setAgentGlow(tab, visible);
}

async function hideAgentCursor(tab: BrowserUseTab): Promise<void> {
  if (tab.retired || tab.view.webContents.isDestroyed()) return;
  let origin: string | null;
  try { origin = currentTabOrigin(tab); }
  catch { return; }
  if (!originAuthorized(tab, origin)) return;
  await evaluate(tab, `(() => {
    const marker = ${JSON.stringify(CURSOR_MARKER)};
    const visual = globalThis.__cosBrowserUseAgentVisual;
    if (visual?.shadow) {
      const cursor = visual.shadow.querySelector('.cursor');
      const glow = visual.shadow.querySelector('.glow');
      if (cursor) cursor.style.opacity = '0';
      if (glow) glow.style.opacity = '0';
    }
    setTimeout(() => {
      for (const host of document.querySelectorAll('[' + marker + ']')) host.remove();
      delete globalThis.__cosBrowserUseAgentVisual;
    }, 90);
    return true;
  })()`);
}

async function clearAgentCursorOverlays(clearPositions = false): Promise<void> {
  const ids = [...agentCursorTabs];
  agentCursorTabs.clear();
  if (clearPositions) {
    agentCursorPositions.clear();
    agentCursorPendingCompletion.clear();
  }
  await Promise.allSettled(ids.map(async id => {
    const tab = tabs.get(id);
    if (tab) await hideAgentCursor(tab);
  }));
}

function snapshotScript(snapshotId: number, includeText: boolean): string {
  return `(() => {
    const maxElements = ${MAX_ELEMENTS};
    const maxText = ${MAX_TEXT};
    const store = globalThis.__cosBrowserUse = { snapshotId: ${snapshotId}, refs: new Map() };
    const visible = el => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    };
    const name = el => {
      const labelled = el.getAttribute('aria-labelledby');
      if (labelled) {
        const text = labelled.split(/\\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
        if (text) return text;
      }
      const safeValue = ('value' in el && typeof el.value === 'string' && el.type !== 'password') ? el.value : '';
      return (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') ||
        safeValue || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 240);
    };
    const role = el => el.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT: el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox',TEXTAREA:'textbox',SELECT:'combobox',SUMMARY:'button'}[el.tagName] || '');
    const query = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[contenteditable="true"],[onclick]';
    const elements = [];
    for (const el of document.querySelectorAll(query)) {
      if (elements.length >= maxElements || !visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
      const ref = 'e' + (elements.length + 1);
      store.refs.set(ref, el);
      const item = { ref, tag: el.tagName.toLowerCase(), role: role(el), name: name(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      if ('value' in el && typeof el.value === 'string' && el.type !== 'password') item.value = el.value.slice(0, 500);
      if ('checked' in el && typeof el.checked === 'boolean') item.checked = el.checked;
      elements.push(item);
    }
    return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight },
      text: ${includeText ? "(document.body?.innerText || '').replace(/\\n{4,}/g, '\\n\\n\\n').slice(0, maxText)" : "''"}, elements };
  })()`;
}

export async function observeBrowserUseTab(tabId: number, includeScreenshot = true, includeText = true): Promise<BrowserUseObservation> {
  await ensureBrowserUseReady();
  const tab = requireTab(tabId);
  await authorizeAgentTab(tab);
  requestBrowserUsePanel();
  setActive(tab);
  const binding = { epoch: tab.navigationEpoch, layoutEpoch: panelLayoutEpoch, origin: currentTabOrigin(tab) };
  assertDocumentBinding(tab, binding);
  const snapshotId = nextSnapshotId++;
  const observed = await evaluate<Omit<BrowserUseObservation, 'tabId' | 'snapshotId' | 'loading' | 'screenshot'>>(tab, snapshotScript(snapshotId, includeText));
  assertDocumentBinding(tab, binding);
  const observedOrigin = permissionFor(normalizeBrowserUseTarget(observed.url));
  if (observedOrigin !== binding.origin) throw browserStateChanged();
  let screenshot: string | undefined;
  if (includeScreenshot) {
    assertDocumentBinding(tab, binding);
    const png = (await tab.view.webContents.capturePage()).toPNG();
    assertDocumentBinding(tab, binding);
    screenshot = png.toString('base64');
  }
  tab.snapshotId = snapshotId;
  tab.snapshotEpoch = binding.epoch;
  tab.snapshotLayoutEpoch = binding.layoutEpoch;
  tab.snapshotOrigin = binding.origin;
  return { tabId, snapshotId, loading: tab.loading, ...observed, ...(screenshot ? { screenshot } : {}) };
}

function browserStateChanged(): Error {
  return new Error('STALE_BROWSER_STATE: the page changed while Browser Use was observing it. Call state again before interacting.');
}

function assertDocumentBinding(tab: BrowserUseTab, binding: { epoch: number; layoutEpoch: number; origin: string | null }): void {
  if (tab.retired || tab.view.webContents.isDestroyed() ||
      tab.navigationEpoch !== binding.epoch || panelLayoutEpoch !== binding.layoutEpoch) throw browserStateChanged();
  let origin: string | null;
  try { origin = currentTabOrigin(tab); }
  catch { throw browserStateChanged(); }
  if (origin !== binding.origin || !originAuthorized(tab, origin)) throw browserStateChanged();
}

function requireSnapshot(tab: BrowserUseTab, snapshotId: number): void {
  if (!Number.isSafeInteger(snapshotId) || snapshotId <= 0 || tab.snapshotId !== snapshotId) {
    throw new Error('STALE_BROWSER_STATE: observe this tab again and use refs from the new snapshot.');
  }
  if (tab.snapshotEpoch < 0 || tab.snapshotLayoutEpoch < 0) throw browserStateChanged();
  assertDocumentBinding(tab, {
    epoch: tab.snapshotEpoch,
    layoutEpoch: tab.snapshotLayoutEpoch,
    origin: tab.snapshotOrigin
  });
}

async function refBox(tab: BrowserUseTab, snapshotId: number, ref: string, focus = false, select = false): Promise<{ x: number; y: number; width: number; height: number }> {
  requireSnapshot(tab, snapshotId);
  const box = await evaluate<{ x: number; y: number; width: number; height: number }>(tab, `(() => {
    const store = globalThis.__cosBrowserUse;
    if (!store || store.snapshotId !== ${snapshotId}) throw new Error('STALE_BROWSER_STATE');
    const el = store.refs.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) throw new Error('STALE_BROWSER_REF');
    ${focus ? "el.focus({ preventScroll: false });" : ''}
    ${select ? "if (typeof el.select === 'function') el.select(); else { const s=getSelection(); const r=document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }" : ''}
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x:r.x, y:r.y, width:r.width, height:r.height };
  })()`);
  requireSnapshot(tab, snapshotId);
  return box;
}

async function focusBrowserUseRef(tab: BrowserUseTab, snapshotId: number, ref: string, select = false): Promise<void> {
  requireSnapshot(tab, snapshotId);
  await evaluate(tab, `(() => {
    const store = globalThis.__cosBrowserUse;
    if (!store || store.snapshotId !== ${snapshotId}) throw new Error('STALE_BROWSER_STATE');
    const el = store.refs.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) throw new Error('STALE_BROWSER_REF');
    el.focus({ preventScroll: true });
    ${select ? "if (typeof el.select === 'function') el.select(); else { const s=getSelection(); const r=document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }" : ''}
    return true;
  })()`);
  requireSnapshot(tab, snapshotId);
}

async function moveAgentPointer(
  tab: BrowserUseTab,
  snapshotId: number,
  x: number,
  y: number,
  from: { x: number; y: number },
  durationMs: number
): Promise<void> {
  await tab.ready;
  const debuggerApi = tab.view.webContents.debugger;
  requireSnapshot(tab, snapshotId);
  const distance = Math.hypot(x - from.x, y - from.y);
  const steps = durationMs <= 0 || distance < 4
    ? 1
    : Math.max(6, Math.min(14, Math.round(durationMs / 70)));
  // CDP mouseMoved itself has measurable per-call latency. Budget for it instead of
  // blindly sleeping duration/steps, otherwise long moves exceed the requested wall time.
  const stepDelay = steps <= 1 ? 0 : Math.max(10, Math.round(durationMs / Math.max(1, steps - 1)) - 8);
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const eased = t * t * (3 - 2 * t);
    const nextX = from.x + (x - from.x) * eased;
    const nextY = from.y + (y - from.y) * eased;
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nextX, y: nextY });
    requireSnapshot(tab, snapshotId);
    if (step < steps && stepDelay > 0) await new Promise(resolve => setTimeout(resolve, stepDelay));
  }
  agentCursorPositions.set(tab.id, { x, y });
}

async function sendMouseClick(
  tab: BrowserUseTab,
  snapshotId: number,
  x: number,
  y: number,
  clickCount: number,
  motion: { previous: { x: number; y: number }; durationMs: number }
): Promise<void> {
  await moveAgentPointer(tab, snapshotId, x, y, motion.previous, motion.durationMs);
  const debuggerApi = tab.view.webContents.debugger;
  requireSnapshot(tab, snapshotId);
  agentCursorPendingCompletion.add(tab.id);
  try {
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
    try { requireSnapshot(tab, snapshotId); }
    catch (error) {
      try { await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0, clickCount }); } catch { /* Best-effort input cleanup. */ }
      throw error;
    }
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
    if (await signalAgentCursorComplete(tab)) agentCursorPendingCompletion.delete(tab.id);
  } catch (error) {
    agentCursorPendingCompletion.delete(tab.id);
    throw error;
  }
}

export async function clickBrowserUseRef(tabId: number, snapshotId: number, ref: string): Promise<void> {
  const tab = requireTab(tabId);
  requireSnapshot(tab, snapshotId);
  requestBrowserUsePanel(); setActive(tab);
  const box = await refBox(tab, snapshotId, ref);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const motion = await showAgentCursor(tab, snapshotId, point, 'click');
  await sendMouseClick(tab, snapshotId, point.x, point.y, 1, motion);
  invalidate(tab);
}

export async function hoverBrowserUseRef(tabId: number, snapshotId: number, ref: string): Promise<void> {
  const tab = requireTab(tabId);
  requireSnapshot(tab, snapshotId);
  requestBrowserUsePanel(); setActive(tab);
  const box = await refBox(tab, snapshotId, ref);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const motion = await showAgentCursor(tab, snapshotId, point, 'hover');
  await moveAgentPointer(tab, snapshotId, point.x, point.y, motion.previous, motion.durationMs);
  agentCursorPendingCompletion.add(tab.id);
  if (await signalAgentCursorComplete(tab)) agentCursorPendingCompletion.delete(tab.id);
  invalidate(tab);
}

export async function typeBrowserUseRef(tabId: number, snapshotId: number, ref: string, text: string, replace = true): Promise<void> {
  const tab = requireTab(tabId);
  requireSnapshot(tab, snapshotId);
  if (text.length > 20_000) throw new Error('Browser typing is limited to 20,000 characters per call.');
  requestBrowserUsePanel(); setActive(tab);
  const box = await refBox(tab, snapshotId, ref);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const motion = await showAgentCursor(tab, snapshotId, point, 'type');
  await moveAgentPointer(tab, snapshotId, point.x, point.y, motion.previous, motion.durationMs);
  await focusBrowserUseRef(tab, snapshotId, ref, replace);
  await tab.ready;
  requireSnapshot(tab, snapshotId);
  agentCursorPendingCompletion.add(tab.id);
  try {
    await tab.view.webContents.debugger.sendCommand('Input.insertText', { text });
    if (await signalAgentCursorComplete(tab)) agentCursorPendingCompletion.delete(tab.id);
  } catch (error) {
    agentCursorPendingCompletion.delete(tab.id);
    throw error;
  }
  invalidate(tab);
}

function keyParts(value: string): { key: string; modifiers: number } {
  const parts = value.split('+').map(part => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 5) throw new Error('Use a key such as Enter, Escape, Tab, ArrowDown, or Ctrl+A.');
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const key = part.toLowerCase();
    if (key === 'alt') modifiers |= 1;
    else if (key === 'ctrl' || key === 'control') modifiers |= 2;
    else if (key === 'meta' || key === 'cmd' || key === 'command') modifiers |= 4;
    else if (key === 'shift') modifiers |= 8;
    else throw new Error(`Unsupported modifier ${part}.`);
  }
  const aliases: Record<string, string> = { return: 'Enter', esc: 'Escape', space: ' ', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  const last = parts.at(-1)!;
  return { key: aliases[last.toLowerCase()] ?? (last.length === 1 ? last : last), modifiers };
}

export async function keyBrowserUseTab(tabId: number, snapshotId: number, keyValue: string, ref?: string): Promise<void> {
  const tab = requireTab(tabId);
  requireSnapshot(tab, snapshotId);
  requestBrowserUsePanel(); setActive(tab);
  if (ref) {
    const box = await refBox(tab, snapshotId, ref);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const motion = await showAgentCursor(tab, snapshotId, point, 'type');
    await moveAgentPointer(tab, snapshotId, point.x, point.y, motion.previous, motion.durationMs);
    await focusBrowserUseRef(tab, snapshotId, ref);
  }
  const { key, modifiers } = keyParts(keyValue);
  await tab.ready;
  requireSnapshot(tab, snapshotId);
  const text = key.length === 1 && modifiers === 0 ? key : undefined;
  await tab.view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers, ...(text ? { text } : {}) });
  // A keydown handler can navigate synchronously. Never deliver the matching keyup into a
  // replacement document whose origin/snapshot was not authorized; synthetic CDP input does
  // not need OS-level key-state cleanup across documents.
  requireSnapshot(tab, snapshotId);
  agentCursorPendingCompletion.add(tab.id);
  try {
    await tab.view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers });
    if (await signalAgentCursorComplete(tab)) agentCursorPendingCompletion.delete(tab.id);
  } catch (error) {
    agentCursorPendingCompletion.delete(tab.id);
    throw error;
  }
  invalidate(tab);
}

export async function scrollBrowserUseTab(tabId: number, snapshotId: number, deltaY: number, ref?: string): Promise<void> {
  const tab = requireTab(tabId);
  requireSnapshot(tab, snapshotId);
  requestBrowserUsePanel(); setActive(tab);
  let point = agentCursorPositions.get(tab.id);
  if (!point) {
    point = await evaluate<{ x: number; y: number }>(tab, '({x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2)})');
    requireSnapshot(tab, snapshotId);
  }
  if (ref) {
    const box = await refBox(tab, snapshotId, ref);
    point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }
  const motion = await showAgentCursor(tab, snapshotId, point, 'scroll');
  await moveAgentPointer(tab, snapshotId, point.x, point.y, motion.previous, motion.durationMs);
  await tab.ready;
  requireSnapshot(tab, snapshotId);
  agentCursorPendingCompletion.add(tab.id);
  try {
    await tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY });
    if (await signalAgentCursorComplete(tab)) agentCursorPendingCompletion.delete(tab.id);
  } catch (error) {
    agentCursorPendingCompletion.delete(tab.id);
    throw error;
  }
  invalidate(tab);
}

export async function shutdownBrowserUse(): Promise<void> {
  pendingPermission?.deny('Browser Use stopped because Chat On Steroids is shutting down.');
  pendingPermission = null;
  panelOpen = false;
  detachAll();
  detachViewportHost(owner);
  const current = [...tabs.values()];
  tabs = new Map();
  activeTabId = null;
  for (const tab of current) {
    tab.retired = true;
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }
  owner = null;
  viewportHost = null;
  viewportHostOwner = null;
  browserSession = null;
  ready = null;
  panelBounds = null;
  panelLayoutEpoch = 0;
  cancelBrowserUseMissionTimeout();
  agentMissionActive = false;
  agentCursorTabs.clear();
  agentCursorPositions.clear();
  agentCursorPendingCompletion.clear();
  transientOrigins.clear();
  persistentOrigins.clear();
}
