import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PetLibraryState } from '../src/shared/pets.js';

const mocks = vi.hoisted(() => ({
  library: { pets: [] } as PetLibraryState,
  read: vi.fn(),
  publish: null as ((state: PetLibraryState) => void) | null,
  windows: [] as any[],
  ipc: new Map<string, (...args: any[]) => void>(),
  cursor: vi.fn(() => ({ x: 20, y: 20 }))
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    visible = false;
    dead = false;
    webContents = Object.assign(new EventEmitter(), {
      id: 42, isDestroyed: () => false, send: vi.fn(), getZoomFactor: () => 1,
      setWindowOpenHandler: vi.fn()
    });
    constructor(readonly options: { focusable: boolean; skipTaskbar: boolean }) { super(); mocks.windows.push(this); }
    isDestroyed() { return this.dead; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.dead = true; this.emit('closed'); }
    getContentBounds() { return { x: 0, y: 0, width: 1200, height: 800 }; }
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setShape = vi.fn();
    async loadFile() { this.webContents.emit('did-finish-load'); }
  }
  return {
    BrowserWindow: Window,
    ipcMain: { on: (name: string, listener: (...args: any[]) => void) => mocks.ipc.set(name, listener) },
    screen: Object.assign(new EventEmitter(), {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 }, scaleFactor: 1 }),
      getCursorScreenPoint: mocks.cursor
    })
  };
});
vi.mock('../src/main/pet-library.js', () => ({
  petLibraryState: () => { mocks.read(); return mocks.library; },
  onPetLibraryChange: (listener: (state: PetLibraryState) => void) => {
    mocks.publish = listener; return () => { mocks.publish = null; };
  }
}));
vi.mock('../src/main/pet-window-focus.js', () => ({ windowsPetFocus: vi.fn(async () => ({ release: vi.fn(), dispose: vi.fn() })) }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { theme: 'dark' } }) }));
vi.mock('../src/main/logger.js', () => ({ logWarn: vi.fn() }));
vi.mock('../src/main/agents.js', () => ({ onSwarmChange: () => vi.fn(), swarmState: () => ({ agents: [] }) }));
vi.mock('../src/main/bridge.js', () => ({ sessionActivityExpiresAt: () => null }));
vi.mock('../src/main/session/store.js', () => ({ getSession: async () => null }));
vi.mock('../src/main/session/blocked-chats.js', () => ({ blockedChatIds: () => [] }));
vi.mock('../src/main/session/recorder.js', () => ({
  activeSessionId: () => null, onSessionChange: () => vi.fn(), sessionIdForConversation: () => null
}));
import { petOverlayControlState, refreshPetOverlayActivities, setPetOverlayVisible, shutdownPetOverlay, startPetOverlay } from '../src/main/pet-overlay.js';
import { windowsPetFocus } from '../src/main/pet-window-focus.js';

function state(...ids: string[]): PetLibraryState {
  return { pets: ids.map(id => ({ id, displayName: id, description: '', kind: 'cos', enabled: true, favorite: false })) };
}
async function publish(next: PetLibraryState): Promise<void> {
  mocks.library = next;
  mocks.publish!(next);
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.read.mockClear(); mocks.cursor.mockClear(); mocks.windows.length = 0;
  mocks.library = state('capy');
  vi.mocked(windowsPetFocus).mockClear();
});
afterEach(async () => { await shutdownPetOverlay(); vi.useRealTimers(); });

it('reads the catalog once; polling, activity, hover and controls use its published projection', async () => {
  await startPetOverlay(() => null, () => undefined);
  const win = mocks.windows[0];
  expect(win.options.focusable).toBe(process.platform === 'win32');
  expect(win.options.skipTaskbar).toBe(true);
  // macOS forwards ignored mouse moves instead of polling. Enter interaction
  // before measuring the native poll shared by all three platforms.
  mocks.ipc.get('pet-overlay:interactive')!({ sender: win.webContents }, {
    interactive: true, regions: [{ x: 10, y: 10, width: 160, height: 160 }]
  });
  await vi.advanceTimersByTimeAsync(1100);
  for (let i = 0; i < 20; i++) {
    petOverlayControlState(); refreshPetOverlayActivities();
    mocks.ipc.get('pet-overlay:interactive')!({ sender: win.webContents }, {
      interactive: true, regions: [{ x: 10, y: 10, width: 160, height: 160 }]
    });
  }
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.cursor.mock.calls.length).toBeGreaterThan(10);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
});

it('switches pets and hides/restores the overlay without stale membership or another disk scan', async () => {
  await startPetOverlay(() => null, () => undefined);
  const win = mocks.windows[0];
  await publish(state());
  expect(win.isVisible()).toBe(false);
  const samples = mocks.cursor.mock.calls.length;
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.cursor).toHaveBeenCalledTimes(samples);
  await publish(state('hammy'));
  expect(win.isVisible()).toBe(true);
  expect(win.webContents.send).toHaveBeenCalledWith('pet-overlay:libraryChanged', state('hammy'));
  expect(petOverlayControlState().activeCount).toBe(1);
  await setPetOverlayVisible(false); await setPetOverlayVisible(true);
  expect(win.isVisible()).toBe(true);
  await publish(state('hammy', 'capy'));
  expect(petOverlayControlState().activeCount).toBe(2);
  expect(mocks.read).toHaveBeenCalledTimes(1);
});

it('starts empty without an overlay and accepts the first published enabled pet', async () => {
  mocks.library = state();
  await startPetOverlay(() => null, () => undefined);
  expect(mocks.windows).toHaveLength(0);
  await publish(state('capy'));
  expect(mocks.windows).toHaveLength(1);
  expect(mocks.windows[0].isVisible()).toBe(true);
  await shutdownPetOverlay();
  expect(petOverlayControlState().activeCount).toBe(0);
});

it('keeps Windows pets when the native focus binding cannot load', async () => {
  // A quarantined or damaged binding used to destroy the overlay, so no pet appeared at all.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    vi.mocked(windowsPetFocus).mockRejectedValueOnce(new Error('koffi.node was not found'));
    await startPetOverlay(() => null, () => undefined);
    const win = mocks.windows[0];
    expect(win.isDestroyed()).toBe(false);
    expect(win.isVisible()).toBe(true);
    expect(petOverlayControlState().activeCount).toBe(1);
    expect(() => mocks.ipc.get('pet-overlay:releaseFocus')!({ sender: win.webContents })).not.toThrow();
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

it.runIf(process.platform === 'win32')('only lets the current overlay release native focus', async () => {
  await startPetOverlay(() => null, () => undefined);
  const focus = await vi.mocked(windowsPetFocus).mock.results[0]!.value;
  mocks.ipc.get('pet-overlay:releaseFocus')!({ sender: { id: -1 } });
  expect(focus.release).not.toHaveBeenCalled();
  mocks.ipc.get('pet-overlay:releaseFocus')!({ sender: mocks.windows[0].webContents });
  expect(focus.release).toHaveBeenCalledOnce();
  await shutdownPetOverlay();
  expect(focus.dispose).toHaveBeenCalledOnce();
  expect(focus.release).toHaveBeenCalledOnce();
});

it.runIf(process.platform === 'win32')('disposes a native initialization that finishes after shutdown', async () => {
  const focus = { release: vi.fn(), dispose: vi.fn() };
  let complete!: (value: typeof focus) => void;
  vi.mocked(windowsPetFocus).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const starting = startPetOverlay(() => null, () => undefined);
  await shutdownPetOverlay();
  complete(focus);
  await starting;
  expect(mocks.windows[0].isDestroyed()).toBe(true);
  expect(mocks.windows[0].isVisible()).toBe(false);
  expect(focus.dispose).toHaveBeenCalledOnce();
  expect(focus.release).not.toHaveBeenCalled();
});
