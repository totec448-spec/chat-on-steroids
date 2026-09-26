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
import sharp from 'sharp';
import type {
  BrowserUseBounds,
  BrowserUseDesignContext,
  BrowserUseDesignSelection,
  BrowserUseDesignSourceCandidate,
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
const DOCUMENT_COMMAND_TIMEOUT_MS = 8_000;

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
  snapshotViewport: { width: number; height: number } | null;
  executionContextId: number | null;
  executionContextEpoch: number;
  documentLifetime: AbortController;
  ready: Promise<void>;
}

interface PendingPermission {
  tabId: number;
  request: BrowserUsePermission;
  provisionalTab: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface BrowserUseDesignOutlineState {
  backendNodeId: number;
  previous: {
    outline: string;
    outlinePriority: string;
    outlineOffset: string;
    outlineOffsetPriority: string;
  };
}

interface BrowserUseDesignInspection {
  tabId: number;
  navigationEpoch: number;
  generation: number;
  selection: BrowserUseDesignSelection | null;
  selectedBackendNodeId: number | null;
  outline: BrowserUseDesignOutlineState | null;
  cssEnabled: boolean;
  styleSheets: Map<string, {
    sourceURL: string;
    startLine: number;
    startColumn: number;
  }>;
  capture: {
    selectionId: number;
    crop: BrowserUseBounds;
    viewport: { width: number; height: number };
  } | null;
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
const activePointerGestures = new Map<number, AbortController>();
let agentMissionActive = false;
let agentMissionIdleTimer: ReturnType<typeof setTimeout> | null = null;
let designInspection: BrowserUseDesignInspection | null = null;
let designInspectionGeneration = 0;
let nextDesignSelectionId = 1;

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
    permission: pendingPermission?.request ?? null,
    design: {
      active: designInspection !== null,
      tabId: designInspection?.tabId ?? null,
      selection: designInspection?.selection ?? null
    }
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

/** Reprojects the one pending human decision without exposing its renderer-only request id. */
export function browserUseAgentPendingApproval(): Record<string, unknown> | null {
  if (!pendingPermission) return null;
  return {
    status: 'approval_required',
    origin: pendingPermission.request.origin,
    tab_id: pendingPermission.tabId,
    retry: { action: 'navigate', tab_id: pendingPermission.tabId, url: pendingPermission.request.url },
    message: `Approve ${pendingPermission.request.origin} in the Browser panel, then retry the supplied navigation.`
  };
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
 * Browser Use visual ownership is a mission, not one MCP call. A control action starts it;
 * passive list/state observations may refresh an existing mission but never create a new one.
 * `browser done` ends it explicitly. This keeps glow and cursor stable while the model reasons
 * between steps without making a post-completion inspection look like resumed work.
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
  tab.snapshotViewport = null;
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

const DESIGN_HIGHLIGHT_CONFIG = {
  showInfo: true,
  showAccessibilityInfo: true,
  contentColor: { r: 76, g: 139, b: 245, a: 0.12 },
  paddingColor: { r: 76, g: 139, b: 245, a: 0.18 },
  borderColor: { r: 99, g: 157, b: 255, a: 0.9 },
  marginColor: { r: 99, g: 157, b: 255, a: 0.08 }
};
const DESIGN_STYLE_PROPERTIES = [
  'display',
  'position',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'border-radius',
  'gap',
  'opacity',
  'z-index'
] as const;
const DESIGN_STYLE_PROPERTY_SET = new Set<string>(DESIGN_STYLE_PROPERTIES);
const DESIGN_CONTEXT_CROP_WIDTH = 640;
const DESIGN_CONTEXT_CROP_HEIGHT = 360;
const DESIGN_CONTEXT_OUTPUT_WIDTH = 560;
const DESIGN_CONTEXT_OUTPUT_HEIGHT = 320;
const DESIGN_CONTEXT_IMAGE_BYTES = 512 * 1024;
const DESIGN_SOURCE_CANDIDATES = 5;

function designContextCrop(summary: {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  viewportWidth?: unknown;
  viewportHeight?: unknown;
}): BrowserUseBounds | null {
  const bounded = (value: unknown, minimum: number, maximum: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(minimum, Math.min(maximum, value))
      : minimum;
  const viewportWidth = bounded(summary.viewportWidth, 0, 100_000);
  const viewportHeight = bounded(summary.viewportHeight, 0, 100_000);
  if (viewportWidth < 1 || viewportHeight < 1) return null;
  const x = bounded(summary.x, -100_000, 100_000);
  const y = bounded(summary.y, -100_000, 100_000);
  const width = bounded(summary.width, 0, 100_000);
  const height = bounded(summary.height, 0, 100_000);
  const left = Math.max(0, Math.min(viewportWidth, x - 12));
  const top = Math.max(0, Math.min(viewportHeight, y - 12));
  const right = Math.max(left, Math.min(viewportWidth, x + width + 12));
  const bottom = Math.max(top, Math.min(viewportHeight, y + height + 12));
  const cropWidth = Math.min(DESIGN_CONTEXT_CROP_WIDTH, right - left);
  const cropHeight = Math.min(DESIGN_CONTEXT_CROP_HEIGHT, bottom - top);
  if (cropWidth < 1 || cropHeight < 1) return null;
  const centerX = Math.max(0, Math.min(viewportWidth, x + width / 2));
  const centerY = Math.max(0, Math.min(viewportHeight, y + height / 2));
  return {
    x: Math.round(Math.max(0, Math.min(viewportWidth - cropWidth, centerX - cropWidth / 2))),
    y: Math.round(Math.max(0, Math.min(viewportHeight - cropHeight, centerY - cropHeight / 2))),
    width: Math.max(1, Math.round(cropWidth)),
    height: Math.max(1, Math.round(cropHeight))
  };
}

async function stopDesignInspectionOnPage(
  tab: BrowserUseTab,
  inspection: BrowserUseDesignInspection | null = designInspection
): Promise<void> {
  if (tab.retired || tab.view.webContents.isDestroyed()) return;
  await tab.ready;
  let outlineRemoved = false;
  if (inspection?.tabId === tab.id) {
    try {
      await restoreDesignSelectionOutline(tab, inspection);
      outlineRemoved = true;
    } catch (error) {
      logWarn(`browser use design outline cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Overlay.disable is the backend's teardown boundary: it clears inspect mode, destroys the
  // overlay page and releases unbuffered input. Merely hiding the highlight can leave the page
  // intercepting pointer input while the renderer already claims inspection is off.
  try {
    await tab.view.webContents.debugger.sendCommand('Overlay.disable');
  } catch (error) {
    // An explicit toggle-off remains visibly active if native teardown fails. Restore the
    // selected contour too so renderer and page continue to project that truthful state.
    if (outlineRemoved && inspection && currentDesignInspection(tab, inspection) &&
        typeof inspection.selectedBackendNodeId === 'number') {
      try {
        await applyDesignSelectionOutline(tab, inspection, inspection.selectedBackendNodeId);
      } catch { /* Preserve the original teardown error. */ }
    }
    throw error;
  }
  if (inspection?.cssEnabled && !tab.view.webContents.isDestroyed()) {
    try {
      await tab.view.webContents.debugger.sendCommand('CSS.disable');
      inspection.cssEnabled = false;
      inspection.styleSheets.clear();
    } catch (error) {
      logWarn(`browser use design CSS cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function retireDesignInspection(tabId?: number, publish = true): BrowserUseTab | null {
  const current = designInspection;
  if (!current || (tabId !== undefined && current.tabId !== tabId)) return null;
  designInspectionGeneration += 1;
  designInspection = null;
  const tab = tabs.get(current.tabId);
  if (publish) publishState();
  return tab ?? null;
}

function clearDesignInspection(tabId?: number, publish = true): void {
  const inspection = designInspection;
  const tab = retireDesignInspection(tabId, publish);
  // Lifecycle edges such as navigation can destroy the target before cleanup completes. They
  // retire ownership synchronously and make native teardown best-effort; explicit toggle-off
  // uses the strict awaited path in setBrowserUseDesignMode instead.
  if (tab && inspection) void stopDesignInspectionOnPage(tab, inspection).catch(() => undefined);
}

function currentDesignInspection(
  tab: BrowserUseTab,
  expected: BrowserUseDesignInspection
): boolean {
  return designInspection === expected &&
    expected.tabId === tab.id &&
    expected.navigationEpoch === tab.navigationEpoch &&
    expected.generation === designInspectionGeneration &&
    !tab.retired;
}

const DESIGN_SELECTION_OUTLINE_FUNCTION = String.raw`function () {
  const style = this && this.style;
  if (!style || typeof style.setProperty !== 'function') return null;
  const previous = {
    outline: style.getPropertyValue('outline'),
    outlinePriority: style.getPropertyPriority('outline'),
    outlineOffset: style.getPropertyValue('outline-offset'),
    outlineOffsetPriority: style.getPropertyPriority('outline-offset')
  };
  style.setProperty('outline', '2px solid rgb(99, 157, 255)', 'important');
  style.setProperty('outline-offset', '2px', 'important');
  return previous;
}`;

const DESIGN_SELECTION_RESTORE_FUNCTION = String.raw`function (outline, outlinePriority, outlineOffset, outlineOffsetPriority) {
  const style = this && this.style;
  if (!style || typeof style.setProperty !== 'function') return false;
  const restore = (property, value, priority) => value
    ? style.setProperty(property, value, priority || '')
    : style.removeProperty(property);
  restore('outline', outline, outlinePriority);
  restore('outline-offset', outlineOffset, outlineOffsetPriority);
  return true;
}`;

async function applyDesignSelectionOutline(
  tab: BrowserUseTab,
  inspection: BrowserUseDesignInspection,
  backendNodeId: number
): Promise<void> {
  if (!currentDesignInspection(tab, inspection)) return;
  if (inspection.outline?.backendNodeId === backendNodeId) return;
  if (inspection.outline) await restoreDesignSelectionOutline(tab, inspection);
  const resolved = await runDocumentCommand(tab, inspection.navigationEpoch, () =>
    tab.view.webContents.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId,
      objectGroup: 'cos-browser-use-design-outline'
    })
  ) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId || !currentDesignInspection(tab, inspection)) return;
  try {
    const reply = await runDocumentCommand(tab, inspection.navigationEpoch, () =>
      tab.view.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: DESIGN_SELECTION_OUTLINE_FUNCTION,
        returnByValue: true
      })
    ) as { result?: { value?: BrowserUseDesignOutlineState['previous'] | null } };
    const previous = reply.result?.value;
    if (!previous || !currentDesignInspection(tab, inspection)) {
      throw new Error('The selected element cannot display an outline.');
    }
    inspection.outline = { backendNodeId, previous };
  } finally {
    if (!tab.view.webContents.isDestroyed()) {
      void tab.view.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }
}

async function restoreDesignSelectionOutline(
  tab: BrowserUseTab,
  inspection: BrowserUseDesignInspection
): Promise<void> {
  const outline = inspection.outline;
  if (!outline) return;
  if (inspection.navigationEpoch !== tab.navigationEpoch || tab.retired ||
      tab.view.webContents.isDestroyed()) {
    inspection.outline = null;
    return;
  }
  const resolved = await runDocumentCommand(tab, inspection.navigationEpoch, () =>
    tab.view.webContents.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId: outline.backendNodeId,
      objectGroup: 'cos-browser-use-design-outline'
    })
  ) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    inspection.outline = null;
    return;
  }
  try {
    const previous = outline.previous;
    await runDocumentCommand(tab, inspection.navigationEpoch, () =>
      tab.view.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: DESIGN_SELECTION_RESTORE_FUNCTION,
        arguments: [
          { value: previous.outline },
          { value: previous.outlinePriority },
          { value: previous.outlineOffset },
          { value: previous.outlineOffsetPriority }
        ],
        returnByValue: true
      })
    );
    if (inspection.outline === outline) inspection.outline = null;
  } finally {
    if (!tab.view.webContents.isDestroyed()) {
      void tab.view.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }
}

const DESIGN_NODE_SUMMARY_FUNCTION = String.raw`function () {
  const element = this instanceof Element ? this : this && this.parentElement;
  if (!element) return null;
  const escape = value => globalThis.CSS && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, character => '\\' + character);
  const segment = node => {
    const tag = node.tagName.toLowerCase();
    if (node.id) return '#' + escape(node.id);
    const classes = Array.from(node.classList).filter(Boolean).slice(0, 2);
    let value = tag + classes.map(name => '.' + escape(name)).join('');
    const parent = node.parentElement;
    if (parent) {
      const peers = Array.from(parent.children).filter(child => child.tagName === node.tagName);
      if (peers.length > 1) value += ':nth-of-type(' + (peers.indexOf(node) + 1) + ')';
    }
    return value;
  };
  const parts = [];
  let cursor = element;
  while (cursor && parts.length < 6) {
    const part = segment(cursor);
    parts.unshift(part);
    if (part.startsWith('#')) break;
    cursor = cursor.parentElement;
  }
  const rect = element.getBoundingClientRect();
  const computed = getComputedStyle(element);
  const edge = properties => properties.map(property => computed.getPropertyValue(property).trim().slice(0, 80));
  const margin = edge(['margin-top', 'margin-right', 'margin-bottom', 'margin-left']);
  const border = edge(['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']);
  const padding = edge(['padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
  const pixels = value => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const styleProperties = __STYLE_PROPERTIES__;
  const sources = [];
  const pushSource = (framework, label, fileName, lineNumber, columnNumber) => {
    if (typeof fileName !== 'string' || !fileName.trim() || sources.length >= 4) return;
    sources.push({
      framework,
      label: typeof label === 'string' ? label : '',
      fileName,
      lineNumber,
      columnNumber
    });
  };
  try {
    const fiberKey = Object.getOwnPropertyNames(element).find(key =>
      key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
    );
    const descriptor = fiberKey ? Object.getOwnPropertyDescriptor(element, fiberKey) : null;
    let fiber = descriptor && 'value' in descriptor ? descriptor.value : null;
    for (let depth = 0; fiber && depth < 16 && sources.length < 3; depth += 1, fiber = fiber.return) {
      const source = fiber._debugSource;
      const type = fiber.elementType || fiber.type;
      const label = typeof type === 'string' ? type
        : type && (type.displayName || type.name) || fiber._debugOwner?.elementType?.displayName || '';
      if (source && typeof source === 'object') {
        pushSource('React', label, source.fileName, source.lineNumber, source.columnNumber);
      }
    }
  } catch { /* Framework metadata is optional and never blocks selection. */ }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(element, '__vueParentComponent');
    let instance = descriptor && 'value' in descriptor ? descriptor.value : null;
    for (let depth = 0; instance && depth < 12 && sources.length < 4; depth += 1, instance = instance.parent) {
      const type = instance.type;
      if (type && typeof type === 'object') {
        pushSource('Vue', type.name || type.__name || '', type.__file, null, null);
      }
    }
  } catch { /* Framework metadata is optional and never blocks selection. */ }
  return {
    tag: element.tagName.toLowerCase().slice(0, 64),
    explicitRole: (element.getAttribute('role') || '').trim().slice(0, 80),
    selector: parts.join(' > ').slice(0, 512),
    classes: Array.from(element.classList).slice(0, 16).map(value => value.slice(0, 80)),
    width: Math.round(rect.width * 10) / 10,
    height: Math.round(rect.height * 10) / 10,
    x: Math.round(rect.x * 10) / 10,
    y: Math.round(rect.y * 10) / 10,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    boxModel: {
      margin,
      border,
      padding,
      contentWidth: Math.max(0, Math.round((rect.width - pixels(border[1]) - pixels(border[3]) - pixels(padding[1]) - pixels(padding[3])) * 10) / 10),
      contentHeight: Math.max(0, Math.round((rect.height - pixels(border[0]) - pixels(border[2]) - pixels(padding[0]) - pixels(padding[2])) * 10) / 10)
    },
    styles: styleProperties.map(property => ({
      property,
      value: computed.getPropertyValue(property).trim().replace(/\s+/g, ' ').slice(0, 160)
    })),
    sources
  };
}`.replace('__STYLE_PROPERTIES__', JSON.stringify(DESIGN_STYLE_PROPERTIES));

function boundedDesignSourceCandidates(value: unknown): BrowserUseDesignSourceCandidate[] {
  if (!Array.isArray(value)) return [];
  const result: BrowserUseDesignSourceCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const framework = record.framework === 'React' || record.framework === 'Vue' || record.framework === 'CSS'
      ? record.framework
      : null;
    const urlValue = typeof record.url === 'string' ? record.url : record.fileName;
    const url = typeof urlValue === 'string' ? urlValue.trim().replace(/[\r\n\t]/g, '').slice(0, 2048) : '';
    if (!framework || !url) continue;
    const position = (candidate: unknown, maximum: number): number | null =>
      typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 1
        ? Math.min(candidate, maximum)
        : null;
    const line = position(record.line ?? record.lineNumber, 10_000_000);
    const column = position(record.column ?? record.columnNumber, 1_000_000);
    const label = typeof record.label === 'string'
      ? record.label.trim().replace(/\s+/g, ' ').slice(0, 120)
      : '';
    const kind = framework === 'CSS' ? 'style' : 'component';
    const key = `${kind}\0${url}\0${line ?? ''}\0${column ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind, framework, label, url, line, column });
    if (result.length >= DESIGN_SOURCE_CANDIDATES) break;
  }
  return result;
}

async function matchedDesignStyleSources(
  tab: BrowserUseTab,
  inspection: BrowserUseDesignInspection,
  objectId: string
): Promise<BrowserUseDesignSourceCandidate[]> {
  if (!inspection.cssEnabled || !currentDesignInspection(tab, inspection)) return [];
  try {
    const requested = await runDocumentCommand(tab, inspection.navigationEpoch, () =>
      tab.view.webContents.debugger.sendCommand('DOM.requestNode', { objectId })
    ) as { nodeId?: unknown };
    if (typeof requested.nodeId !== 'number' || !Number.isInteger(requested.nodeId) || requested.nodeId < 1) return [];
    const matched = await runDocumentCommand(tab, inspection.navigationEpoch, () =>
      tab.view.webContents.debugger.sendCommand('CSS.getMatchedStylesForNode', { nodeId: requested.nodeId })
    ) as {
      matchedCSSRules?: Array<{
        rule?: {
          origin?: unknown;
          styleSheetId?: unknown;
          selectorList?: { text?: unknown };
          style?: {
            styleSheetId?: unknown;
            range?: { startLine?: unknown; startColumn?: unknown };
          };
        };
      }>;
    };
    const raw: Array<Record<string, unknown>> = [];
    for (const match of matched.matchedCSSRules ?? []) {
      const rule = match.rule;
      if (!rule || rule.origin !== 'regular') continue;
      const styleSheetId = typeof rule.styleSheetId === 'string'
        ? rule.styleSheetId
        : typeof rule.style?.styleSheetId === 'string' ? rule.style.styleSheetId : '';
      const header = inspection.styleSheets.get(styleSheetId);
      const range = rule.style?.range;
      if (!header || !range || typeof range.startLine !== 'number' || typeof range.startColumn !== 'number') continue;
      const sourceURL = header.sourceURL || tab.url;
      if (!sourceURL) continue;
      const lineOffset = Math.max(0, Math.trunc(range.startLine));
      raw.push({
        framework: 'CSS',
        label: typeof rule.selectorList?.text === 'string' ? rule.selectorList.text : '',
        url: sourceURL,
        line: header.startLine + lineOffset + 1,
        column: (lineOffset === 0 ? header.startColumn : 0) + Math.max(0, Math.trunc(range.startColumn)) + 1
      });
      if (raw.length >= DESIGN_SOURCE_CANDIDATES) break;
    }
    return boundedDesignSourceCandidates(raw);
  } catch {
    // Source hints are optional evidence and must never make selection itself fail.
    return [];
  }
}

async function captureDesignSelection(
  tab: BrowserUseTab,
  inspection: BrowserUseDesignInspection,
  backendNodeId: number
): Promise<void> {
  const epoch = inspection.navigationEpoch;
  let objectId: string | undefined;
  try {
    const [ax, resolved] = await Promise.all([
      runDocumentCommand(tab, epoch, () =>
        tab.view.webContents.debugger.sendCommand('Accessibility.getPartialAXTree', {
          backendNodeId,
          fetchRelatives: false
        })
      ) as Promise<{ nodes?: Array<{ role?: { value?: unknown }; name?: { value?: unknown } }> }>,
      runDocumentCommand(tab, epoch, () =>
        tab.view.webContents.debugger.sendCommand('DOM.resolveNode', {
          backendNodeId,
          objectGroup: 'cos-browser-use-design'
        })
      ) as Promise<{ object?: { objectId?: string } }>
    ]);
    objectId = resolved.object?.objectId;
    if (!objectId || !currentDesignInspection(tab, inspection)) return;
    const summaryReply = await runDocumentCommand(tab, epoch, () =>
      tab.view.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: DESIGN_NODE_SUMMARY_FUNCTION,
        returnByValue: true
      })
    ) as {
      result?: {
        value?: {
          tag?: unknown;
          explicitRole?: unknown;
          selector?: unknown;
          classes?: unknown;
          width?: unknown;
          height?: unknown;
          x?: unknown;
          y?: unknown;
          viewportWidth?: unknown;
          viewportHeight?: unknown;
          boxModel?: {
            margin?: unknown;
            border?: unknown;
            padding?: unknown;
            contentWidth?: unknown;
            contentHeight?: unknown;
          } | null;
          styles?: unknown;
          sources?: unknown;
        } | null;
      };
    };
    const summary = summaryReply.result?.value;
    if (!summary || !currentDesignInspection(tab, inspection)) return;
    const crop = designContextCrop(summary);
    const sources = boundedDesignSourceCandidates(summary.sources);
    const styleSources = await matchedDesignStyleSources(tab, inspection, objectId);
    if (!currentDesignInspection(tab, inspection)) return;
    const selectionId = nextDesignSelectionId++;
    const axNode = ax.nodes?.[0];
    const role = typeof axNode?.role?.value === 'string'
      ? axNode.role.value
      : typeof summary.explicitRole === 'string' ? summary.explicitRole : '';
    const name = typeof axNode?.name?.value === 'string' ? axNode.name.value : '';
    const dimension = (value: unknown): number => typeof value === 'number' && Number.isFinite(value)
      ? Math.round(Math.max(0, Math.min(100_000, value)) * 10) / 10
      : 0;
    const edge = (value: unknown): [string, string, string, string] => {
      const entries = Array.isArray(value) ? value : [];
      return [0, 1, 2, 3].map(index => typeof entries[index] === 'string'
        ? entries[index].trim().replace(/\s+/g, ' ').slice(0, 80)
        : '0px') as [string, string, string, string];
    };
    const boxModel = summary.boxModel;
    inspection.selection = {
      id: selectionId,
      tag: typeof summary.tag === 'string' ? summary.tag : '',
      role: role.slice(0, 80),
      name: name.trim().replace(/\s+/g, ' ').slice(0, 240),
      selector: typeof summary.selector === 'string' ? summary.selector.slice(0, 512) : '',
      classes: Array.isArray(summary.classes) ? summary.classes
        .filter((value): value is string => typeof value === 'string')
        .slice(0, 16)
        .map(value => value.trim().slice(0, 80))
        .filter(Boolean) : [],
      width: dimension(summary.width),
      height: dimension(summary.height),
      boxModel: {
        margin: edge(boxModel?.margin),
        border: edge(boxModel?.border),
        padding: edge(boxModel?.padding),
        contentWidth: dimension(boxModel?.contentWidth),
        contentHeight: dimension(boxModel?.contentHeight)
      },
      styles: Array.isArray(summary.styles) ? summary.styles.flatMap(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const property = 'property' in entry && typeof entry.property === 'string' ? entry.property : '';
        const value = 'value' in entry && typeof entry.value === 'string' ? entry.value : '';
        if (!DESIGN_STYLE_PROPERTY_SET.has(property)) return [];
        return [{ property, value: value.trim().replace(/\s+/g, ' ').slice(0, 160) }];
      }).slice(0, DESIGN_STYLE_PROPERTIES.length) : [],
      sources: boundedDesignSourceCandidates([...sources, ...styleSources])
    };
    const viewportWidth = dimension(summary.viewportWidth);
    const viewportHeight = dimension(summary.viewportHeight);
    inspection.capture = crop && viewportWidth > 0 && viewportHeight > 0
      ? { selectionId, crop, viewport: { width: viewportWidth, height: viewportHeight } }
      : null;
    inspection.selectedBackendNodeId = backendNodeId;
    await applyDesignSelectionOutline(tab, inspection, backendNodeId);
    if (!currentDesignInspection(tab, inspection)) return;
    publishState();
  } catch (error) {
    if (currentDesignInspection(tab, inspection)) {
      logWarn(`browser use design selection: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (objectId && !tab.view.webContents.isDestroyed()) {
      void tab.view.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }
}

/** Capture is deliberately user-triggered. Selection itself stays cheap and the renderer never
 * receives screenshot bytes until the user explicitly asks to prepare agent context. */
export async function captureBrowserUseDesignContext(
  tabId: number,
  selectionId: number
): Promise<BrowserUseDesignContext> {
  const tab = requireTab(tabId);
  const inspection = designInspection;
  if (!inspection || inspection.tabId !== tabId || inspection.navigationEpoch !== tab.navigationEpoch ||
      inspection.selection?.id !== selectionId) {
    throw new Error('The selected element changed. Select it again before asking the agent.');
  }
  if (!inspection.capture || inspection.capture.selectionId !== selectionId) {
    throw new Error('The selected element is outside the visible page. Select a visible element before asking the agent.');
  }
  if (activeTabId !== tabId) throw new Error('Select the inspected tab before asking the agent.');
  const selection = inspection.selection;
  const capture = inspection.capture;
  const backendNodeId = inspection.selectedBackendNodeId;
  const current = (): boolean => currentDesignInspection(tab, inspection) &&
    inspection.selection?.id === selectionId && inspection.capture?.selectionId === selectionId;
  try {
    await restoreDesignSelectionOutline(tab, inspection);
    await runDocumentCommand(tab, inspection.navigationEpoch, () =>
      tab.view.webContents.debugger.sendCommand('Overlay.hideHighlight')
    );
    let image = await runDocumentCommand(tab, inspection.navigationEpoch, () =>
      tab.view.webContents.capturePage(capture.crop)
    );
    if (!current()) throw new Error('The selected element changed while its context was being prepared.');
    const size = image.getSize();
    const scale = Math.min(
      1,
      DESIGN_CONTEXT_OUTPUT_WIDTH / Math.max(1, size.width),
      DESIGN_CONTEXT_OUTPUT_HEIGHT / Math.max(1, size.height)
    );
    if (scale < 1) {
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'good'
      });
    }
    const outputSize = image.getSize();
    const webp = await sharp(image.toPNG(), {
      limitInputPixels: DESIGN_CONTEXT_OUTPUT_WIDTH * DESIGN_CONTEXT_OUTPUT_HEIGHT,
      animated: false
    }).webp({ quality: 80 }).toBuffer();
    if (webp.length > DESIGN_CONTEXT_IMAGE_BYTES) {
      throw new Error('The selected element preview is too large to attach. Select a smaller element.');
    }
    if (!current()) throw new Error('The selected element changed while its context was being prepared.');
    return {
      tabId,
      selectionId,
      url: tab.url,
      title: tab.title,
      viewport: capture.viewport,
      selection,
      screenshot: {
        name: `browser-selection-${selection.tag || 'element'}.webp`,
        dataUrl: `data:image/webp;base64,${webp.toString('base64')}`,
        width: outputSize.width,
        height: outputSize.height
      }
    };
  } finally {
    // Keep the selection visually anchored after preparing context, but never burn our own
    // inline contour into the screenshot sent to the composer.
    if (backendNodeId !== null && current()) {
      try {
        await applyDesignSelectionOutline(tab, inspection, backendNodeId);
      } catch (error) {
        if (current()) {
          logWarn(`browser use design outline restore: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
}

export async function setBrowserUseDesignMode(
  tabId: number,
  enabled: boolean
): Promise<BrowserUseState> {
  const tab = requireTab(tabId);
  if (!enabled) {
    const inspection = designInspection;
    if (!inspection || inspection.tabId !== tabId) return browserUseState();
    await stopDesignInspectionOnPage(tab, inspection);
    if (designInspection === inspection) retireDesignInspection(tabId);
    return browserUseState();
  }
  if (activeTabId !== tabId) throw new Error('Select the tab before inspecting its design.');
  if (designInspection?.tabId === tabId && designInspection.navigationEpoch === tab.navigationEpoch) {
    return browserUseState();
  }
  clearDesignInspection(undefined, false);
  const generation = ++designInspectionGeneration;
  const inspection: BrowserUseDesignInspection = {
    tabId,
    navigationEpoch: tab.navigationEpoch,
    generation,
    selection: null,
    selectedBackendNodeId: null,
    outline: null,
    cssEnabled: false,
    styleSheets: new Map(),
    capture: null
  };
  try {
    await tab.ready;
    if (generation !== designInspectionGeneration || activeTabId !== tabId ||
        tab.navigationEpoch !== inspection.navigationEpoch) return browserUseState();
    designInspection = inspection;
    try {
      await runDocumentCommand(tab, inspection.navigationEpoch, () =>
        tab.view.webContents.debugger.sendCommand('CSS.enable')
      );
      inspection.cssEnabled = true;
    } catch {
      // Component metadata still provides useful source candidates when a page has no CSS model.
    }
    await runDocumentCommand(tab, inspection.navigationEpoch, () =>
      tab.view.webContents.debugger.sendCommand('Overlay.enable')
    );
    if (generation !== designInspectionGeneration || activeTabId !== tabId) return browserUseState();
    await runDocumentCommand(tab, inspection.navigationEpoch, () =>
      tab.view.webContents.debugger.sendCommand('Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: DESIGN_HIGHLIGHT_CONFIG
      })
    );
    if (!currentDesignInspection(tab, inspection)) {
      void stopDesignInspectionOnPage(tab, inspection).catch(() => undefined);
      return browserUseState();
    }
    publishState();
    return browserUseState();
  } catch (error) {
    if (designInspection === inspection) {
      designInspection = null;
      designInspectionGeneration += 1;
      publishState();
    }
    void stopDesignInspectionOnPage(tab, inspection).catch(() => undefined);
    throw error;
  }
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
  clearDesignInspection(undefined, false);
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
  clearDesignInspection(tab.id, false);
  tab.retired = true;
  tab.documentLifetime.abort();
  agentCursorTabs.delete(tab.id);
  agentCursorPositions.delete(tab.id);
  agentCursorPendingCompletion.delete(tab.id);
  activePointerGestures.get(tab.id)?.abort();
  activePointerGestures.delete(tab.id);
  transientOrigins.delete(tab.id);
  if (pendingPermission?.tabId === tab.id) {
    clearPendingPermission(pendingPermission.request.id);
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
  contents.debugger.on('message', (_event, method, params) => {
    if (method === 'CSS.styleSheetAdded') {
      const inspection = designInspection;
      const header = (params as { header?: Record<string, unknown> } | undefined)?.header;
      if (!inspection || inspection.tabId !== tab.id || inspection.navigationEpoch !== tab.navigationEpoch ||
          !header || typeof header.styleSheetId !== 'string') return;
      inspection.styleSheets.set(header.styleSheetId, {
        sourceURL: typeof header.sourceURL === 'string' ? header.sourceURL.slice(0, 2048) : '',
        startLine: typeof header.startLine === 'number' ? Math.max(0, Math.trunc(header.startLine)) : 0,
        startColumn: typeof header.startColumn === 'number' ? Math.max(0, Math.trunc(header.startColumn)) : 0
      });
      return;
    }
    if (method === 'Overlay.inspectModeCanceled') {
      // Chromium owns picker cancellation; our owner still removes the selected inline contour.
      clearDesignInspection(tab.id);
      return;
    }
    if (method !== 'Overlay.inspectNodeRequested') return;
    const inspection = designInspection;
    const backendNodeId = (params as { backendNodeId?: unknown } | undefined)?.backendNodeId;
    if (!inspection || inspection.tabId !== tab.id || inspection.navigationEpoch !== tab.navigationEpoch ||
      typeof backendNodeId !== 'number' || !Number.isInteger(backendNodeId) || backendNodeId < 1) return;
    void captureDesignSelection(tab, inspection, backendNodeId);
  });
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
    clearDesignInspection(tab.id, false);
    tab.documentLifetime.abort();
    tab.documentLifetime = new AbortController();
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
    clearDesignInspection(tab.id, false);
    tab.documentLifetime.abort();
    tab.documentLifetime = new AbortController();
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
    snapshotViewport: null,
    executionContextId: null,
    executionContextEpoch: -1,
    documentLifetime: new AbortController(),
    ready: Promise.resolve()
  };
  tabs.set(tab.id, tab);
  wireTab(tab);
  tab.ready = initializeTab(tab).catch(error => {
    logWarn(`browser use tab ${tab.id} debugger: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });
  if (active || activeTabId === null) {
    if (activeTabId !== tab.id) clearDesignInspection(undefined, false);
    activeTabId = tab.id;
  }
  applyPanel();
  publishState();
  if (navigate && url !== 'about:blank') void contents.loadURL(url).catch(error => {
    if (!tab.retired) logWarn(`browser use navigation: ${error instanceof Error ? error.message : String(error)}`);
  });
  logInfo(`browser use: tab ${tab.id} created ${url}`);
  return tab;
}

export type BrowserUseProtocolErrorCode =
  | 'STALE_TAB'
  | 'STALE_BROWSER_STATE'
  | 'BROWSER_STATE_TIMEOUT'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_PENDING';

export class BrowserUseProtocolError extends Error {
  constructor(
    readonly code: BrowserUseProtocolErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
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
  clearDesignInspection(undefined, false);
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

function permissionError(tab: BrowserUseTab, request: BrowserUsePermission): BrowserUseProtocolError {
  return new BrowserUseProtocolError(
    'APPROVAL_REQUIRED',
    `Browser Use needs approval for ${request.origin}. Approve it in the Browser panel, then retry the navigation.`,
    {
      status: 'approval_required',
      origin: request.origin,
      tab_id: tab.id,
      retry: { action: 'navigate', tab_id: tab.id, url: request.url }
    }
  );
}

function pendingPermissionError(): BrowserUseProtocolError {
  const pending = pendingPermission!;
  const tab = requireTab(pending.tabId);
  return permissionError(tab, pending.request);
}

function clearPendingPermission(id: string): PendingPermission | null {
  if (!pendingPermission || pendingPermission.request.id !== id) return null;
  const pending = pendingPermission;
  pendingPermission = null;
  clearTimeout(pending.timer);
  publishState();
  return pending;
}

function retireUnusedProvisionalTab(pending: PendingPermission): void {
  if (!pending.provisionalTab) return;
  const tab = tabs.get(pending.tabId);
  if (!tab || tab.retired || currentTabUrl(tab) !== 'about:blank') return;
  retireTab(tab);
}

function authorizeAgentNavigation(tab: BrowserUseTab, url: string, provisionalTab = false): void {
  const origin = permissionFor(url);
  if (!origin || originAuthorized(tab, origin)) return;
  if (pendingPermission) {
    if (pendingPermission.tabId === tab.id && pendingPermission.request.origin === origin) {
      throw permissionError(tab, pendingPermission.request);
    }
    throw new BrowserUseProtocolError(
      'APPROVAL_PENDING',
      `Approve or deny ${pendingPermission.request.origin} in the Browser panel before requesting another origin.`,
      {
        status: 'approval_required',
        origin: pendingPermission.request.origin,
        tab_id: pendingPermission.tabId
      }
    );
  }
  const request = { id: randomUUID(), origin, url };
  const timer = setTimeout(() => {
    const expired = clearPendingPermission(request.id);
    if (expired) retireUnusedProvisionalTab(expired);
  }, 60_000);
  pendingPermission = { tabId: tab.id, request, provisionalTab, timer };
  requestBrowserUsePanel();
  publishState();
  throw permissionError(tab, request);
}

function authorizeAgentTab(tab: BrowserUseTab): void {
  const current = currentTabUrl(tab);
  if (!current || current === 'about:blank') return;
  authorizeAgentNavigation(tab, normalizeBrowserUseTarget(current));
}

export function settleBrowserUsePermission(id: string, decision: 'once' | 'always' | 'deny'): BrowserUseState {
  const pending = clearPendingPermission(id);
  if (!pending) return browserUseState();
  const tab = tabs.get(pending.tabId);
  if (decision === 'deny') {
    retireUnusedProvisionalTab(pending);
    return browserUseState();
  }
  if (decision === 'always') {
    persistentOrigins.add(pending.request.origin);
    savePreferences();
  } else if (tab && !tab.retired) {
    trustTabOrigin(tab, pending.request.origin);
  }
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

export async function navigateBrowserUseTab(
  tabId: number,
  value: string,
  source: 'user' | 'agent',
  options: { provisionalTab?: boolean } = {}
): Promise<BrowserUseState> {
  await ensureBrowserUseReady();
  const tab = requireTab(tabId);
  clearDesignInspection(tab.id, false);
  const url = normalizeBrowserUseTarget(value);
  const origin = permissionFor(url);
  if (source === 'agent') authorizeAgentNavigation(tab, url, options.provisionalTab === true);
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
  // One consent request owns the only provisional tab. Repeated model `open` calls while the
  // user is deciding must project that same request, never manufacture more blank tabs.
  if (source === 'agent' && pendingPermission) throw pendingPermissionError();
  const tab = createBrowserUseTab();
  return navigateBrowserUseTab(tab.id, value?.trim() || DEFAULT_PAGE, source, { provisionalTab: source === 'agent' });
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
  clearDesignInspection(tab.id, false);
  const target = historyTarget(tab, action);
  if (source === 'agent') {
    if (action !== 'reload' && target === null) return browserUseState();
    if (target) authorizeAgentNavigation(tab, normalizeBrowserUseTarget(target));
    else authorizeAgentTab(tab);
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

/**
 * Waits for Chromium's own loading boundary instead of guessing with a sleep. The timeout is
 * caller-bounded and reports an observation state; it never retries navigation or input.
 */
export async function waitForBrowserUseTab(tabId: number, timeoutMs: number): Promise<'settled' | 'timeout'> {
  const tab = requireTab(tabId);
  if (!tab.loading) return 'settled';
  const contents = tab.view.webContents;
  return new Promise(resolve => {
    let finished = false;
    const settle = (result: 'settled' | 'timeout') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      contents.removeListener('did-stop-loading', onSettled);
      contents.removeListener('destroyed', onDestroyed);
      resolve(result);
    };
    const onSettled = () => settle('settled');
    const onDestroyed = () => settle('settled');
    contents.once('did-stop-loading', onSettled);
    contents.once('destroyed', onDestroyed);
    const timer = setTimeout(() => settle('timeout'), Math.max(50, Math.min(5000, timeoutMs)));
    // Loading may have stopped between the first check and listener registration.
    if (!tab.loading || tab.retired || contents.isDestroyed()) settle('settled');
  });
}

async function isolatedContext(tab: BrowserUseTab): Promise<number> {
  await tab.ready;
  if (tab.executionContextId !== null && tab.executionContextEpoch === tab.navigationEpoch) {
    return tab.executionContextId;
  }
  const epoch = tab.navigationEpoch;
  const tree = await runDocumentCommand(tab, epoch, () =>
    tab.view.webContents.debugger.sendCommand('Page.getFrameTree')
  ) as { frameTree: { frame: { id: string } } };
  const world = await runDocumentCommand(tab, epoch, () =>
    tab.view.webContents.debugger.sendCommand('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: WORLD
    })
  ) as { executionContextId: number };
  if (tab.navigationEpoch !== epoch) throw browserStateChanged();
  tab.executionContextId = world.executionContextId;
  tab.executionContextEpoch = epoch;
  return world.executionContextId;
}

function browserStateTimeout(): BrowserUseProtocolError {
  return new BrowserUseProtocolError(
    'BROWSER_STATE_TIMEOUT',
    `Browser Use stopped observing because the document did not respond within ${DOCUMENT_COMMAND_TIMEOUT_MS / 1000} seconds. Observe the tab again.`,
    { status: 'timeout', next: 'state' }
  );
}

/**
 * A CDP read belongs to one top-level document. Chromium does not cancel an outstanding
 * Runtime.evaluate when navigation replaces that document, so race it against the tab's exact
 * document lifetime and a bound below code-mode's 60 second budget. The late CDP settlement is
 * still consumed by Promise.race, but it can no longer hold the caller or publish stale state.
 */
async function runDocumentCommand<T>(tab: BrowserUseTab, epoch: number, command: () => Promise<T>): Promise<T> {
  if (tab.retired || tab.view.webContents.isDestroyed()) throw staleTabError(tab.id);
  if (tab.navigationEpoch !== epoch || tab.documentLifetime.signal.aborted) throw browserStateChanged();
  const signal = tab.documentLifetime.signal;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const boundary = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(browserStateChanged());
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(browserStateTimeout()), DOCUMENT_COMMAND_TIMEOUT_MS);
  });
  try {
    const value = await Promise.race([Promise.resolve().then(command), boundary]);
    if (tab.navigationEpoch !== epoch || signal.aborted) throw browserStateChanged();
    return value;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function evaluate<T>(tab: BrowserUseTab, expression: string): Promise<T> {
  const epoch = tab.navigationEpoch;
  const contextId = await isolatedContext(tab);
  let reply: { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  try {
    reply = await runDocumentCommand(tab, epoch, () =>
      tab.view.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression,
        contextId,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      })
    ) as typeof reply;
  } catch (error) {
    if (tab.retired || tab.view.webContents.isDestroyed()) throw staleTabError(tab.id);
    if (tab.navigationEpoch !== epoch) throw browserStateChanged();
    throw error;
  }
  if (tab.navigationEpoch !== epoch) throw browserStateChanged();
  if (reply.exceptionDetails) {
    const detail = reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || 'Page script failed.';
    if (/STALE_BROWSER_(?:STATE|REF)/.test(detail)) throw browserStateChanged();
    throw new Error(detail);
  }
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
    const ariaBoolean = (el, attribute) => {
      const value = el.getAttribute(attribute);
      return value === 'true' ? true : value === 'false' ? false : undefined;
    };
    const ariaTristate = (el, attribute) => {
      const value = el.getAttribute(attribute);
      return value === 'mixed' ? 'mixed' : value === 'true' ? true : value === 'false' ? false : undefined;
    };
    const query = 'a[href],button,input,textarea,select,summary,option,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="option"],[role="menuitem"],[contenteditable="true"],[onclick]';
    const elements = [];
    for (const el of document.querySelectorAll(query)) {
      if (elements.length >= maxElements || !visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
      const ref = 'e' + (elements.length + 1);
      store.refs.set(ref, el);
      const item = { ref, tag: el.tagName.toLowerCase(), role: role(el), name: name(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      if (el instanceof HTMLAnchorElement) {
        try { const href = new URL(el.href, location.href); if (/^https?:$/.test(href.protocol)) item.href = href.href.slice(0, 2048); } catch {}
      }
      const contextRoot = el.closest('li,tr,article,[role="listitem"],[role="row"]');
      if (contextRoot) {
        const context = (contextRoot.innerText || contextRoot.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 360);
        if (context && context !== item.name) item.context = context;
      }
      if ('value' in el && typeof el.value === 'string' && el.type !== 'password') item.value = el.value.slice(0, 500);
      const nativeCheckable = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
      const checked = nativeCheckable && el.type === 'checkbox' && el.indeterminate === true ? 'mixed' :
        nativeCheckable ? el.checked : ariaTristate(el, 'aria-checked');
      const expanded = ariaBoolean(el, 'aria-expanded');
      const pressed = ariaTristate(el, 'aria-pressed');
      const selected = 'selected' in el && typeof el.selected === 'boolean' ? el.selected : ariaBoolean(el, 'aria-selected');
      if (checked !== undefined) item.checked = checked;
      if (expanded !== undefined) item.expanded = expanded;
      if (pressed !== undefined) item.pressed = pressed;
      if (selected !== undefined) item.selected = selected;
      elements.push(item);
    }
    return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight },
      text: ${includeText ? "(document.body?.innerText || '').replace(/\\n{4,}/g, '\\n\\n\\n').slice(0, maxText)" : "''"}, elements };
  })()`;
}

export async function observeBrowserUseTab(tabId: number, includeScreenshot = true, includeText = true): Promise<BrowserUseObservation> {
  await ensureBrowserUseReady();
  const tab = requireTab(tabId);
  authorizeAgentTab(tab);
  requestBrowserUsePanel();
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
    const png = (await runDocumentCommand(tab, binding.epoch, () => tab.view.webContents.capturePage())).toPNG();
    assertDocumentBinding(tab, binding);
    screenshot = png.toString('base64');
  }
  tab.snapshotId = snapshotId;
  tab.snapshotEpoch = binding.epoch;
  tab.snapshotLayoutEpoch = binding.layoutEpoch;
  tab.snapshotOrigin = binding.origin;
  tab.snapshotViewport = observed.viewport;
  return { tabId, snapshotId, loading: tab.loading, ...observed, ...(screenshot ? { screenshot } : {}) };
}

function browserStateChanged(): BrowserUseProtocolError {
  return new BrowserUseProtocolError(
    'STALE_BROWSER_STATE',
    'STALE_BROWSER_STATE: the page changed while Browser Use was observing it. Observe the tab again before interacting.',
    { status: 'target_lost', next: 'state' }
  );
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
    throw browserStateChanged();
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

export type BrowserUsePointerTarget = { ref: string } | { x: number; y: number };
export type BrowserUsePointerAction =
  | { kind: 'move'; target: BrowserUsePointerTarget; durationMs?: number }
  | { kind: 'click'; target: BrowserUsePointerTarget; count?: 1 | 2; pointer?: 'mouse' | 'touch' }
  | { kind: 'drag'; from: BrowserUsePointerTarget; to: BrowserUsePointerTarget; durationMs?: number; pointer?: 'mouse' | 'touch' }
  | { kind: 'swipe'; from: BrowserUsePointerTarget; to: BrowserUsePointerTarget; durationMs?: number; pointer?: 'mouse' | 'touch' }
  | { kind: 'long_press'; target: BrowserUsePointerTarget; durationMs?: number; pointer?: 'mouse' | 'touch' };

function gestureCancelled(): Error {
  return new Error('BROWSER_GESTURE_CANCELLED: a newer input or page change cancelled this gesture. Observe again before retrying.');
}

function assertGesture(signal: AbortSignal): void {
  if (signal.aborted) throw gestureCancelled();
}

async function gestureDelay(ms: number, signal: AbortSignal): Promise<void> {
  assertGesture(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(gestureCancelled());
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

async function pointerTargetPoint(
  tab: BrowserUseTab,
  snapshotId: number,
  target: BrowserUsePointerTarget
): Promise<{ x: number; y: number }> {
  requireSnapshot(tab, snapshotId);
  if ('ref' in target) {
    const box = await refBox(tab, snapshotId, target.ref);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  const viewport = tab.snapshotViewport;
  if (!viewport || !Number.isFinite(target.x) || !Number.isFinite(target.y) ||
      target.x < 0 || target.y < 0 || target.x > viewport.width || target.y > viewport.height) {
    throw new Error('INVALID_BROWSER_COORDINATES: x and y must be CSS pixels inside the observed viewport.');
  }
  return { x: target.x, y: target.y };
}

async function withPointerGesture<T>(tab: BrowserUseTab, snapshotId: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  activePointerGestures.get(tab.id)?.abort();
  const controller = new AbortController();
  activePointerGestures.set(tab.id, controller);
  try {
    requireSnapshot(tab, snapshotId);
    return await work(controller.signal);
  } finally {
    if (activePointerGestures.get(tab.id) === controller) activePointerGestures.delete(tab.id);
  }
}

async function moveAgentPointer(
  tab: BrowserUseTab,
  snapshotId: number,
  x: number,
  y: number,
  from: { x: number; y: number },
  durationMs: number,
  options: { signal?: AbortSignal; buttons?: number } = {}
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
    if (options.signal) assertGesture(options.signal);
    const t = step / steps;
    const eased = t * t * (3 - 2 * t);
    const nextX = from.x + (x - from.x) * eased;
    const nextY = from.y + (y - from.y) * eased;
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: nextX, y: nextY,
      ...(options.buttons === undefined ? {} : { buttons: options.buttons })
    });
    requireSnapshot(tab, snapshotId);
    if (step < steps && stepDelay > 0) {
      if (options.signal) await gestureDelay(stepDelay, options.signal);
      else await new Promise(resolve => setTimeout(resolve, stepDelay));
    }
  }
  agentCursorPositions.set(tab.id, { x, y });
}

async function sendMouseClick(
  tab: BrowserUseTab,
  snapshotId: number,
  x: number,
  y: number,
  clickCount: 1 | 2,
  motion: { previous: { x: number; y: number }; durationMs: number },
  signal?: AbortSignal
): Promise<void> {
  await moveAgentPointer(tab, snapshotId, x, y, motion.previous, motion.durationMs, { signal });
  const debuggerApi = tab.view.webContents.debugger;
  requireSnapshot(tab, snapshotId);
  agentCursorPendingCompletion.add(tab.id);
  try {
    for (let count = 1; count <= clickCount; count += 1) {
      if (signal) assertGesture(signal);
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: count });
      try {
        requireSnapshot(tab, snapshotId);
        if (signal) assertGesture(signal);
      } catch (error) {
        try { await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: -1, y: -1, button: 'left', buttons: 0, clickCount: count }); } catch { /* Best-effort input cleanup. */ }
        throw error;
      }
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: count });
    }
    if (await signalAgentCursorComplete(tab)) agentCursorPendingCompletion.delete(tab.id);
  } catch (error) {
    agentCursorPendingCompletion.delete(tab.id);
    throw error;
  }
}

async function sendTouchTap(
  tab: BrowserUseTab,
  snapshotId: number,
  point: { x: number; y: number },
  count: 1 | 2,
  signal: AbortSignal
): Promise<void> {
  const debuggerApi = tab.view.webContents.debugger;
  for (let index = 0; index < count; index += 1) {
    assertGesture(signal);
    await debuggerApi.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 0 }] });
    try {
      requireSnapshot(tab, snapshotId);
      assertGesture(signal);
      await debuggerApi.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } catch (error) {
      try { await debuggerApi.sendCommand('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); } catch { /* Best-effort input cleanup. */ }
      throw error;
    }
  }
}

async function sendPointerPath(
  tab: BrowserUseTab,
  snapshotId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number,
  pointer: 'mouse' | 'touch',
  signal: AbortSignal
): Promise<void> {
  const debuggerApi = tab.view.webContents.debugger;
  const steps = Math.max(3, Math.min(30, Math.round(durationMs / 32)));
  let pressed = false;
  try {
    if (pointer === 'mouse') {
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    } else {
      await debuggerApi.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 0 }] });
    }
    pressed = true;
    for (let step = 1; step <= steps; step += 1) {
      assertGesture(signal);
      const progress = step / steps;
      const eased = progress * progress * (3 - 2 * progress);
      const x = from.x + (to.x - from.x) * eased;
      const y = from.y + (to.y - from.y) * eased;
      if (pointer === 'mouse') {
        await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      } else {
        await debuggerApi.sendCommand('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 0 }] });
      }
      requireSnapshot(tab, snapshotId);
      if (step < steps) await gestureDelay(Math.max(8, Math.round(durationMs / steps)), signal);
    }
    // A second mouse move at the destination makes HTML dragover/drop reliable across Chromium
    // sites that do not accept the first move after mousedown.
    if (pointer === 'mouse') {
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left', buttons: 1 });
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    } else {
      await debuggerApi.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    pressed = false;
  } finally {
    if (pressed) {
      try {
        if (pointer === 'mouse') await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
        else await debuggerApi.sendCommand('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      } catch { /* Cleanup is best-effort after navigation, cancellation or tab teardown. */ }
    }
  }
}

async function sendLongPress(
  tab: BrowserUseTab,
  snapshotId: number,
  point: { x: number; y: number },
  durationMs: number,
  pointer: 'mouse' | 'touch',
  signal: AbortSignal
): Promise<void> {
  const debuggerApi = tab.view.webContents.debugger;
  let pressed = false;
  try {
    if (pointer === 'mouse') await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    else await debuggerApi.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 0 }] });
    pressed = true;
    await gestureDelay(durationMs, signal);
    requireSnapshot(tab, snapshotId);
    if (pointer === 'mouse') await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    else await debuggerApi.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    pressed = false;
  } finally {
    if (pressed) {
      try {
        if (pointer === 'mouse') await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
        else await debuggerApi.sendCommand('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      } catch { /* Cleanup is best-effort after navigation, cancellation or tab teardown. */ }
    }
  }
}

export async function performBrowserUsePointerAction(tabId: number, snapshotId: number, action: BrowserUsePointerAction): Promise<void> {
  const tab = requireTab(tabId);
  requireSnapshot(tab, snapshotId);
  requestBrowserUsePanel(); setActive(tab);
  await withPointerGesture(tab, snapshotId, async signal => {
    const first = await pointerTargetPoint(tab, snapshotId, 'target' in action ? action.target : action.from);
    const motion = await showAgentCursor(tab, snapshotId, first, action.kind === 'move' ? 'hover' : 'click');
    await moveAgentPointer(tab, snapshotId, first.x, first.y, motion.previous, motion.durationMs, { signal });
    if (action.kind === 'move') {
      agentCursorPendingCompletion.add(tab.id);
      if (await signalAgentCursorComplete(tab)) agentCursorPendingCompletion.delete(tab.id);
      return;
    }
    if (action.kind === 'click') {
      if ((action.pointer ?? 'mouse') === 'touch') await sendTouchTap(tab, snapshotId, first, action.count ?? 1, signal);
      else await sendMouseClick(tab, snapshotId, first.x, first.y, action.count ?? 1, { previous: first, durationMs: 0 }, signal);
    } else if (action.kind === 'long_press') {
      await sendLongPress(tab, snapshotId, first, Math.max(300, Math.min(3000, action.durationMs ?? 650)), action.pointer ?? 'touch', signal);
    } else {
      const second = await pointerTargetPoint(tab, snapshotId, action.to);
      await sendPointerPath(tab, snapshotId, first, second, Math.max(120, Math.min(5000, action.durationMs ?? 650)), action.pointer ?? (action.kind === 'swipe' ? 'touch' : 'mouse'), signal);
      agentCursorPositions.set(tab.id, second);
    }
    agentCursorPendingCompletion.add(tab.id);
    if (await signalAgentCursorComplete(tab)) agentCursorPendingCompletion.delete(tab.id);
  });
  invalidate(tab);
}

export async function clickBrowserUseRef(tabId: number, snapshotId: number, ref: string): Promise<void> {
  return performBrowserUsePointerAction(tabId, snapshotId, { kind: 'click', target: { ref } });
}

export async function hoverBrowserUseRef(tabId: number, snapshotId: number, ref: string): Promise<void> {
  return performBrowserUsePointerAction(tabId, snapshotId, { kind: 'move', target: { ref } });
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
  clearDesignInspection(undefined, false);
  for (const controller of activePointerGestures.values()) controller.abort();
  activePointerGestures.clear();
  if (pendingPermission) clearPendingPermission(pendingPermission.request.id);
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
  designInspection = null;
  designInspectionGeneration = 0;
  nextDesignSelectionId = 1;
  transientOrigins.clear();
  persistentOrigins.clear();
}
