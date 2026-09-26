/** Native desktop host for Pets. Package state stays in pet-library; the overlay renderer owns animation. */
import path from 'node:path';
import { BrowserWindow, ipcMain, screen } from 'electron';
import { defaultAppearance } from '../shared/appearance.js';
import type { PetActivity, PetOverlayBounds, PetOverlayControlState, PetOverlayHitRegion, PetOverlayPointer, PetOverlaySnapshot } from '../shared/pets.js';
import { highestPetActivityLevel, petActivityForAgent, petActivityForSession, petTaskSessionId } from '../shared/pet-activity.js';
import { getConfig } from './config.js';
import { logWarn } from './logger.js';
import { onPetLibraryChange, petLibraryState } from './pet-library.js';
import { activeSessionId, onSessionChange, sessionIdForConversation } from './session/recorder.js';
import { getSession } from './session/store.js';
import { blockedChatIds } from './session/blocked-chats.js';
import { onSwarmChange, swarmState } from './agents.js';
import { sessionActivityExpiresAt } from './bridge.js';

const MAX_ACTIVITIES = 8;
const POINTER_INTERVAL_MS = 50;
// Electron's Windows forwarding path lets both the ignored overlay and the window beneath it
// publish a cursor for one physical mouse move. Keep one owner there: native polling discovers
// proximity, and only the interactive overlay receives renderer mouse events.
const FORWARDS_IGNORED_MOUSE_MOVES = process.platform === 'darwin';
const SUPPORTS_WINDOW_SHAPE = process.platform === 'win32' || process.platform === 'linux';
const MAX_HIT_REGIONS = 64;

let ownerWindow: (() => BrowserWindow | null) | null = null;
let activateOwner: (() => void) | null = null;
let overlay: BrowserWindow | null = null;
let overlayReady = false;
let overlayInteractive: boolean | null = null;
let globallyVisible = true;
const dismissedPetIds = new Set<string>();
let activities: PetActivity[] = [];
let pointerTimer: NodeJS.Timeout | null = null;
let expiryTimer: NodeJS.Timeout | null = null;
let refreshPending = false;
let refreshAgain = false;
let started = false;
let ipcRegistered = false;
let stopLibrary: (() => void) | null = null;
let stopSessions: (() => void) | null = null;
let stopSwarm: (() => void) | null = null;
let lastSnapshotSent: string | null = null;
let lastControlSent: PetOverlayControlState | null = null;

function activePets(): number { return petLibraryState().pets.filter(pet => pet.enabled).length; }
function shouldShow(): boolean { return globallyVisible && petLibraryState().pets.some(pet => pet.enabled && !dismissedPetIds.has(pet.id)); }

export function petOverlayControlState(): PetOverlayControlState {
  return { visible: shouldShow(), ready: !shouldShow() || overlayReady, activeCount: activePets(), activityCount: activities.length };
}

function snapshot(): PetOverlaySnapshot {
  const config = getConfig();
  return {
    visible: shouldShow(),
    dismissedPetIds: [...dismissedPetIds],
    level: highestPetActivityLevel(activities),
    activities,
    theme: config.ui.theme,
    appearance: config.ui.appearance ?? defaultAppearance()
  };
}

function sendControl(force = false): void {
  const owner = ownerWindow?.() ?? null;
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return;
  const next = petOverlayControlState();
  if (!force && lastControlSent
    && next.visible === lastControlSent.visible
    && next.ready === lastControlSent.ready
    && next.activeCount === lastControlSent.activeCount
    && next.activityCount === lastControlSent.activityCount) return;
  lastControlSent = next;
  owner.webContents.send('pet-overlay:stateChanged', next);
}
function sendSnapshot(force = false): void {
  if (!overlay || overlay.isDestroyed() || !overlayReady) return;
  const next = snapshot();
  const serialized = JSON.stringify(next);
  if (!force && serialized === lastSnapshotSent) return;
  lastSnapshotSent = serialized;
  overlay.webContents.send('pet-overlay:snapshot', next);
}
function sendLibrary(): void {
  if (overlay && !overlay.isDestroyed() && overlayReady) overlay.webContents.send('pet-overlay:libraryChanged', petLibraryState());
}
function bounds(): PetOverlayBounds {
  const display = screen.getPrimaryDisplay();
  return { width: display.workArea.width, height: display.workArea.height, scaleFactor: display.scaleFactor };
}

function validHitRegions(value: unknown, win: BrowserWindow): PetOverlayHitRegion[] {
  if (!Array.isArray(value)) return [];
  const area = win.getContentBounds();
  const regions: PetOverlayHitRegion[] = [];
  for (const raw of value.slice(0, MAX_HIT_REGIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    const x = candidate.x, y = candidate.y, width = candidate.width, height = candidate.height;
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y) ||
        typeof width !== 'number' || !Number.isFinite(width) || typeof height !== 'number' || !Number.isFinite(height)) continue;
    const left = Math.max(0, Math.min(area.width, Math.floor(x)));
    const top = Math.max(0, Math.min(area.height, Math.floor(y)));
    const right = Math.max(left, Math.min(area.width, Math.ceil(x + width)));
    const bottom = Math.max(top, Math.min(area.height, Math.ceil(y + height)));
    if (right > left && bottom > top) regions.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return regions;
}

function setInteractive(interactive: boolean, requestedRegions?: unknown): void {
  const win = overlay;
  if (!win || win.isDestroyed()) return;
  const changed = overlayInteractive !== interactive;
  const regions = validHitRegions(requestedRegions, win);
  if (interactive) {
    // Never expose the full transparent desktop surface to native hit-testing. On Windows that
    // surface is treated as an occluding fullscreen window and Chromium pauses/compositor-drops
    // the main app and video behind it as soon as the pointer reaches a pet.
    if (SUPPORTS_WINDOW_SHAPE) {
      if (regions.length === 0) return;
      win.setShape(regions);
    }
    if (changed) win.setIgnoreMouseEvents(false);
    overlayInteractive = true;
  } else {
    // Restore click-through before the full visual shape. On Windows this deliberately omits
    // `forward`: forwarding makes the overlay and the underlying app race to set the OS cursor.
    if (changed) {
      if (FORWARDS_IGNORED_MOUSE_MOVES) win.setIgnoreMouseEvents(true, { forward: true });
      else win.setIgnoreMouseEvents(true);
    }
    if (SUPPORTS_WINDOW_SHAPE) {
      const area = win.getContentBounds();
      win.setShape([{ x: 0, y: 0, width: area.width, height: area.height }]);
    }
    overlayInteractive = false;
  }
  // macOS forwarding parks the native poll while ignored. Windows/Linux keep one native cursor
  // owner; shaped interactive windows also poll so leaving the shape restores click-through.
  if (changed && shouldShow() && overlayReady) startPointerTracking(interactive);
}

function stopPointerTracking(): void {
  if (pointerTimer) clearInterval(pointerTimer);
  pointerTimer = null;
}
function startPointerTracking(pollForwarded = false): void {
  stopPointerTracking();
  let previous: (PetOverlayPointer & { at: number }) | null = null;
  const sample = (): void => {
    const win = overlay;
    if (!win || win.isDestroyed() || !overlayReady || !shouldShow()) return;
    try {
      const cursor = screen.getCursorScreenPoint();
      const area = win.getContentBounds();
      const zoom = win.webContents.getZoomFactor();
      if (!Number.isFinite(zoom) || zoom <= 0) return;
      const point = { x: (cursor.x - area.x) / zoom, y: (cursor.y - area.y) / zoom };
      const now = Date.now();
      if (previous && previous.x === point.x && previous.y === point.y && now - previous.at < 250) return;
      previous = { ...point, at: now };
      win.webContents.send('pet-overlay:pointer', point);
    } catch { /* display configuration can change between reads */ }
  };
  // macOS can forward mousemove through a click-through window. Windows intentionally does not:
  // two Chromium surfaces setting a cursor for one physical move produces visible flicker.
  // Linux and Windows retain the bounded native poll.
  sample();
  if (FORWARDS_IGNORED_MOUSE_MOVES && !pollForwarded) return;
  pointerTimer = setInterval(sample, POINTER_INTERVAL_MS);
  pointerTimer.unref?.();
}

function fitOverlay(): void {
  const win = overlay;
  if (!win || win.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height }, false);
  if (overlayReady) win.webContents.send('pet-overlay:bounds', bounds());
}

async function currentActivities(): Promise<{ rows: PetActivity[]; nextAt: number | null }> {
  const now = Date.now();
  const blocked = new Set(blockedChatIds());
  const agents = swarmState().agents;
  const rows = agents.filter(agent => agent.role !== 'prime').map(agent => petActivityForAgent(
    agent,
    sessionIdForConversation(agent.conversationId),
    !!agent.conversationId && blocked.has(agent.conversationId)
  ));
  const sessionIds = new Set(agents.filter(agent => agent.role === 'prime')
    .map(agent => sessionIdForConversation(agent.conversationId))
    .filter((id): id is string => !!id));
  const activeId = activeSessionId();
  if (activeId) {
    const active = await getSession(activeId).catch(() => null);
    const taskId = active && petTaskSessionId(active);
    if (taskId) sessionIds.add(taskId);
  }
  let nextAt: number | null = null;
  const sessionRows: PetActivity[] = [];
  for (const id of sessionIds) {
    const session = await getSession(id).catch(() => null);
    // Worker lifecycle is already projected by its exact AgentInfo. Re-projecting whichever
    // worker happened to write last made it replace the Prime task after a parallel run.
    if (!session || session.origin?.kind === 'helper' || session.origin?.kind === 'worker') continue;
    const projected = petActivityForSession(
      { ...session, activityExpiresAt: sessionActivityExpiresAt(session) },
      !!session.conversationId && blocked.has(session.conversationId),
      now
    );
    if (!projected) continue;
    sessionRows.push(projected.activity);
    if (projected.nextAt !== null) nextAt = nextAt === null
      ? projected.nextAt
      : Math.min(nextAt, projected.nextAt);
  }
  return { rows: [...sessionRows, ...rows].slice(0, MAX_ACTIVITIES), nextAt };
}

export function refreshPetOverlayActivities(): void {
  if (activePets() === 0) {
    activities = [];
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    sendSnapshot(); sendControl();
    return;
  }
  if (refreshPending) { refreshAgain = true; return; }
  refreshPending = true;
  queueMicrotask(() => {
    void currentActivities().then(({ rows, nextAt }) => {
      const hasActivePets = activePets() > 0;
      activities = hasActivePets ? rows : [];
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = null;
      if (hasActivePets && nextAt !== null) {
        expiryTimer = setTimeout(refreshPetOverlayActivities, Math.max(50, nextAt - Date.now() + 50));
        expiryTimer.unref?.();
      }
      sendSnapshot(); sendControl();
    }).catch(error => logWarn(`pet overlay activity refresh: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        refreshPending = false;
        if (refreshAgain) { refreshAgain = false; refreshPetOverlayActivities(); }
      });
  });
}

function validSender(id: number): boolean { return !!overlay && !overlay.isDestroyed() && overlay.webContents.id === id; }
function focusOwner(): BrowserWindow | null {
  activateOwner?.();
  const owner = ownerWindow?.() ?? null;
  if (!owner || owner.isDestroyed()) return null;
  if (owner.isMinimized()) owner.restore();
  if (!owner.isVisible()) owner.show();
  owner.focus(); owner.webContents.focus();
  return owner;
}
function showOwner(screenName: 'chat' | 'pets', sessionId?: string): void {
  const owner = focusOwner();
  if (!owner) return;
  const send = (): void => {
    if (owner.isDestroyed() || owner.webContents.isDestroyed()) return;
    owner.webContents.send('pet-overlay:openOwner', screenName);
    if (sessionId) owner.webContents.send('session:write', sessionId);
  };
  if (owner.webContents.isLoadingMainFrame()) owner.webContents.once('did-finish-load', send); else send();
}

function registerOverlayIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.on('pet-overlay:interactive', (event, value: unknown) => {
    if (!validSender(event.sender.id) || !value || typeof value !== 'object') return;
    const request = value as Record<string, unknown>;
    setInteractive(request.interactive === true, request.regions);
  });
  ipcMain.on('pet-overlay:focusOwner', event => { if (validSender(event.sender.id)) focusOwner(); });
  ipcMain.on('pet-overlay:openLibrary', event => { if (validSender(event.sender.id)) showOwner('pets'); });
  ipcMain.on('pet-overlay:hidePet', (event, id: unknown) => {
    if (!validSender(event.sender.id) || typeof id !== 'string') return;
    if (!petLibraryState().pets.some(pet => pet.id === id && pet.enabled)) return;
    dismissedPetIds.add(id);
    void syncVisibility();
  });
  ipcMain.on('pet-overlay:openActivity', (event, value: unknown) => {
    if (!validSender(event.sender.id) || !value || typeof value !== 'object') return;
    const sessionId = (value as Record<string, unknown>).sessionId;
    if (typeof sessionId === 'string' && /^[0-9a-z-]{8,64}$/i.test(sessionId)) showOwner('chat', sessionId);
  });
}

async function ensureOverlay(): Promise<BrowserWindow> {
  if (overlay && !overlay.isDestroyed()) return overlay;
  const area = screen.getPrimaryDisplay().workArea;
  overlayReady = false;
  const win = new BrowserWindow({
    x: area.x, y: area.y, width: area.width, height: area.height,
    acceptFirstMouse: true, backgroundColor: '#00000000', focusable: false, frame: false,
    fullscreenable: false, hasShadow: false, maximizable: false, minimizable: false, movable: false,
    resizable: false, show: false, skipTaskbar: true, title: 'Pets', transparent: true,
    webPreferences: {
      backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true,
      // Pets own their saved desktop positions and must keep them across app restarts.
      // A private persistent session also keeps the main window's origin zoom out of this surface.
      partition: 'persist:cos-pet-overlay',
      zoomFactor: 1,
      preload: path.join(__dirname, '../preload/pet-overlay.js'), webSecurity: true
    }
  });
  overlay = win;
  win.setAlwaysOnTop(true, 'floating');
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* unsupported */ }
  setInteractive(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-redirect', event => event.preventDefault());
  win.webContents.once('did-finish-load', () => {
    if (overlay !== win || win.isDestroyed()) return;
    overlayReady = true;
    lastSnapshotSent = null;
    win.webContents.send('pet-overlay:bounds', bounds());
    sendLibrary(); sendSnapshot(true);
    if (shouldShow()) { win.showInactive(); startPointerTracking(overlayInteractive === true); }
    sendControl(true);
  });
  const gone = (): void => {
    if (overlay !== win) return;
    stopPointerTracking(); overlayReady = false; overlayInteractive = null; overlay = null; lastSnapshotSent = null; sendControl();
  };
  win.on('closed', gone);
  win.webContents.on('render-process-gone', gone);
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}/`;
    await win.loadURL(new URL('pet-overlay.html', base).toString());
  } else await win.loadFile(path.join(__dirname, '../renderer/pet-overlay.html'));
  return win;
}

async function syncVisibility(): Promise<void> {
  if (!shouldShow()) {
    stopPointerTracking(); setInteractive(false);
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    sendSnapshot(); sendControl();
    return;
  }
  try {
    const win = await ensureOverlay();
    if (!shouldShow()) return void syncVisibility();
    sendLibrary(); sendSnapshot();
    if (overlayReady && !win.isVisible()) win.showInactive();
    startPointerTracking(overlayInteractive === true); sendControl();
  } catch (error) { logWarn(`pet overlay: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function setPetOverlayVisible(visible: boolean, restoreDismissed = true): Promise<PetOverlayControlState> {
  globallyVisible = visible === true;
  if (globallyVisible && restoreDismissed) dismissedPetIds.clear();
  await syncVisibility();
  return petOverlayControlState();
}
export function refreshPetOverlayAppearance(): void { sendSnapshot(); }

export async function startPetOverlay(getOwner: () => BrowserWindow | null, requestOwner: () => void): Promise<void> {
  if (started) return;
  started = true; ownerWindow = getOwner; activateOwner = requestOwner;
  registerOverlayIpc();
  stopLibrary = onPetLibraryChange(state => {
    const active = new Set(state.pets.filter(pet => pet.enabled).map(pet => pet.id));
    for (const id of dismissedPetIds) if (!active.has(id)) dismissedPetIds.delete(id);
    sendLibrary();
    if (active.size > 0) refreshPetOverlayActivities();
    else { activities = []; sendSnapshot(); sendControl(); }
    void syncVisibility();
  });
  stopSessions = onSessionChange(refreshPetOverlayActivities);
  stopSwarm = onSwarmChange(refreshPetOverlayActivities);
  screen.on('display-metrics-changed', fitOverlay);
  screen.on('display-added', fitOverlay);
  screen.on('display-removed', fitOverlay);
  refreshPetOverlayActivities();
  await syncVisibility();
}

export async function shutdownPetOverlay(): Promise<void> {
  stopPointerTracking();
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  stopLibrary?.(); stopSessions?.(); stopSwarm?.();
  stopLibrary = null; stopSessions = null; stopSwarm = null;
  screen.removeListener('display-metrics-changed', fitOverlay);
  screen.removeListener('display-added', fitOverlay);
  screen.removeListener('display-removed', fitOverlay);
  const win = overlay; overlay = null; overlayReady = false; overlayInteractive = null;
  if (win && !win.isDestroyed()) win.destroy();
  dismissedPetIds.clear();
  lastSnapshotSent = null; lastControlSent = null;
  ownerWindow = null; activateOwner = null; started = false;
}
