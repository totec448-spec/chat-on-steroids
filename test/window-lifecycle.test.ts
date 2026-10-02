import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  applyLoginStartup,
  isBackgroundLaunch,
  supportsLoginStartup,
  createWindowActivationGate,
  ownsAppRuntime,
  registerNativeWindowActivation,
  trackNormalWindowBounds,
  shouldBeginAppBootstrap,
  shouldQuitOnWindowAllClosed
} from '../src/main/window-lifecycle.js';

describe('native window activation', () => {
  it.each(['darwin', 'win32', 'linux'])('keeps native fullscreen available on macOS (%s)', (platform) => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const constructor = source.slice(source.indexOf('  window = new BrowserWindow({'), source.indexOf("  if (process.platform === 'win32') window.removeMenu();"))
      .replaceAll(' as const', '');
    let options: Record<string, unknown> | undefined;
    vm.runInNewContext(constructor, {
      BrowserWindow: function (value: Record<string, unknown>) { options = value; },
      layout: {}, icon: null, process: { platform },
      titleBarOverlayForTheme: () => ({}), windowBackgroundForTheme: () => '#181818', getConfig: () => ({ ui: { theme: 'dark' } }),
      UI_BASE_ZOOM: 1, path: { join: () => 'preload.js' }, __dirname: '/app'
    });
    expect(options?.fullscreenable).toBe(platform === 'darwin');
    expect(options?.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    // macOS and Windows draw the app's own top bar as the title bar; Linux keeps its native frame.
    expect(options?.titleBarStyle).toBe(platform === 'linux' ? undefined : 'hidden');
    if (platform === 'darwin') expect(options?.titleBarOverlay).toBe(true);
  });

  it('maximizes only without remembered geometry and preserves user-sized geometry on reopen', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const present = source.slice(source.indexOf('function showWindow()'), source.indexOf('\nsetFinishNotifier(', source.indexOf('function showWindow()'))).replace('function showWindow(): void', 'function showWindow()');
    const operations: string[] = [];
    const state = { minimized: false };
    const native = { isMinimized: () => state.minimized, isFullScreen: () => false,
      maximize: () => operations.push('maximize'),
      restore: () => operations.push('restore'),
      show: () => operations.push('show'), focus: () => operations.push('focus') };
    const createWindow = vi.fn();
    const context = vm.createContext({ window: native, quitting: false, createWindow });
    vm.runInContext(present + '\nshowWindow();', context);
    expect(operations.splice(0)).toEqual(['show', 'focus']);
    state.minimized = true;
    vm.runInContext('showWindow()', context);
    expect(operations.splice(0)).toEqual(['restore', 'show', 'focus']);
    context.quitting = true;
    vm.runInContext('showWindow()', context);
    expect(operations).toEqual([]);

    let ready!: () => void;
    const startup = source.slice(source.indexOf("  window.once('ready-to-show'"), source.indexOf('  // A renderer that fails', source.indexOf("  window.once('ready-to-show'")));
    const startupOperations: string[] = [];
    const startupState = { fullscreen: false };
    const showWindow = vi.fn(() => startupOperations.push('showWindow'));
    const trackNormalWindowBounds = vi.fn(() => startupOperations.push('track'));
    const launch = vm.createContext({ window: {
      once: (_event: string, listener: () => void) => { ready = listener; },
      isFullScreen: () => startupState.fullscreen,
      maximize: () => startupOperations.push('maximize')
    }, owner: {}, quitting: false, restored: false, restoreMaximized: false, showWindow, trackNormalWindowBounds });
    vm.runInContext(startup, launch);
    ready();
    expect(startupOperations.splice(0)).toEqual(['maximize', 'showWindow', 'track']);
    launch.restored = true;
    ready();
    expect(startupOperations.splice(0)).toEqual(['showWindow', 'track']);
    launch.restoreMaximized = true;
    ready();
    expect(startupOperations.splice(0)).toEqual(['maximize', 'showWindow', 'track']);
    launch.restored = false;
    launch.restoreMaximized = false;
    startupState.fullscreen = true;
    ready();
    expect(startupOperations.splice(0)).toEqual(['showWindow', 'track']);
    launch.quitting = true;
    ready();
    expect(showWindow).toHaveBeenCalledTimes(4);
    expect(trackNormalWindowBounds).toHaveBeenCalledTimes(4);
  });
  it('passively observes on first visible use without opening a browser, never on repeat show or quit', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const listener = source.slice(source.indexOf("  window.on('show'"), source.indexOf("  window.once('ready-to-show'"));
    let show!: () => void;
    let state = 'ready';
    const start = vi.fn(async () => { state = 'pending'; return {}; });
    const context = vm.createContext({ window: { on: (event: string, callback: () => void) => {
      expect(event).toBe('show'); show = callback;
    } }, quitting: false, getChatModels: () => ({ state }), startChatModelDiscovery: start, logWarn: vi.fn() });
    vm.runInContext(listener, context);
    show(); await Promise.resolve(); expect(start).not.toHaveBeenCalled();
    state = 'unknown';
    show(); await Promise.resolve();
    show(); await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(false);
    state = 'unavailable';
    show(); await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    state = 'unknown';
    context.quitting = true;
    show();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('never bootstraps shared state from a secondary or already-quitting process', () => {
    expect(ownsAppRuntime(true)).toBe(true);
    expect(ownsAppRuntime(false)).toBe(false);
    expect(shouldBeginAppBootstrap(true, false)).toBe(true);
    expect(shouldBeginAppBootstrap(false, false)).toBe(false);
    expect(shouldBeginAppBootstrap(false, true)).toBe(false);
    expect(shouldBeginAppBootstrap(true, true)).toBe(false);
  });

  it('drops second-instance focus requests until renderer security and IPC startup are ready', () => {
    const show = vi.fn();
    const gate = createWindowActivationGate(show);

    // Electron can emit second-instance after its `ready` event while our async startup is still
    // restoring state. The initial startup path will show a window itself, so this early request
    // must not create one before CSP/permission/IPC setup is complete.
    gate.request();
    expect(show).not.toHaveBeenCalled();

    gate.enable();
    expect(show).not.toHaveBeenCalled();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);

    // `before-quit` closes the gate again while bounded teardown drains. Native activation or a
    // second launch in that window must not resurrect application UI during shutdown.
    gate.disable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);

    // Startup is async. A continuation that resumes after `before-quit` can still execute its
    // old enable() call; shutdown must be a one-way boundary so that stale continuation cannot
    // reactivate Dock/second-instance/tray presentation.
    expect(gate.isDisabled()).toBe(true);
    gate.enable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('reopens the app from the macOS Dock activation event', () => {
    const listeners = new Map<string, () => void>();
    const source = { on: vi.fn((event: 'activate', listener: () => void) => listeners.set(event, listener)) };
    const show = vi.fn();
    registerNativeWindowActivation(source, show, 'darwin');

    expect(source.on).toHaveBeenCalledWith('activate', show);
    listeners.get('activate')!();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it.each(['win32', 'linux'] as const)('does not add a foreign activation contract on %s', (platform) => {
    const source = { on: vi.fn() };
    registerNativeWindowActivation(source, vi.fn(), platform);
    expect(source.on).not.toHaveBeenCalled();
  });

  it('keeps a macOS app alive after its last window closes, regardless of close-to-tray preference', () => {
    expect(shouldQuitOnWindowAllClosed('darwin', true)).toBe(false);
    expect(shouldQuitOnWindowAllClosed('darwin', false)).toBe(false);
  });

  it.each(['win32', 'linux'] as const)('keeps close-to-tray semantics on %s', (platform) => {
    expect(shouldQuitOnWindowAllClosed(platform, true)).toBe(false);
    expect(shouldQuitOnWindowAllClosed(platform, false)).toBe(true);
  });

  it('persists normal bounds plus maximized presentation and ignores other transient native states', () => {
    const listeners = new Map<'move' | 'resize' | 'maximize' | 'unmaximize', () => void>();
    const normal = { x: 120, y: 80, width: 1100, height: 720 };
    const state = {
      destroyed: false,
      maximized: false,
      minimized: false,
      fullscreen: false,
      bounds: { ...normal }
    };
    const owner = {
      on: (event: 'move' | 'resize' | 'maximize' | 'unmaximize', listener: () => void) => { listeners.set(event, listener); },
      isDestroyed: () => state.destroyed,
      isMaximized: () => state.maximized,
      isMinimized: () => state.minimized,
      isFullScreen: () => state.fullscreen,
      getNormalBounds: () => ({ ...state.bounds })
    };
    const save = vi.fn();

    trackNormalWindowBounds(owner, save);
    listeners.get('move')!();
    expect(save).toHaveBeenLastCalledWith({ bounds: normal, maximized: false });

    // Electron's getNormalBounds retains the user-sized rectangle while maximized.
    state.maximized = true;
    listeners.get('maximize')!();
    expect(save).toHaveBeenLastCalledWith({ bounds: normal, maximized: true });

    // Native maximize geometry churn must not replace the remembered normal rectangle.
    state.bounds = { x: 0, y: 0, width: 1920, height: 1040 };
    listeners.get('resize')!();
    expect(save).toHaveBeenCalledTimes(2);

    state.maximized = false;
    state.bounds = { ...normal };
    listeners.get('unmaximize')!();
    expect(save).toHaveBeenLastCalledWith({ bounds: normal, maximized: false });

    state.minimized = true;
    listeners.get('move')!();
    state.minimized = false;
    state.fullscreen = true;
    listeners.get('resize')!();
    state.fullscreen = false;
    state.destroyed = true;
    listeners.get('move')!();

    expect(save).toHaveBeenCalledTimes(3);
  });

  it('wires remembered bounds through dedicated durable state instead of shared settings', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');

    expect(source).toContain("const WINDOW_BOUNDS_STATE = 'window-bounds';");
    expect(source).toContain('savedWindowBounds = await readDurable<unknown>(WINDOW_BOUNDS_STATE);');
    expect(source).toContain('const restoreMaximized = windowPlacementWasMaximized(savedWindowBounds);');
    expect(source).toContain('trackNormalWindowBounds(owner, (placement) => {');
    expect(source).toContain('writeDurableSoon(WINDOW_BOUNDS_STATE, placement);');
  });
});

describe('Windows login startup', () => {
  it('writes only packaged Windows login settings and supports turning the same entry off', () => {
    const app = { isPackaged: true, setLoginItemSettings: vi.fn() };
    applyLoginStartup(app, true, 'win32', 'C:/Program Files/Chat On Steroids/app.exe');
    applyLoginStartup(app, false, 'win32', 'C:/Program Files/Chat On Steroids/app.exe');
    expect(app.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true, path: 'C:/Program Files/Chat On Steroids/app.exe', args: ['--background'] }],
      [{ openAtLogin: false, path: 'C:/Program Files/Chat On Steroids/app.exe', args: ['--background'] }]
    ]);
    for (const platform of ['darwin', 'linux'] as const) applyLoginStartup(app, true, platform);
    app.isPackaged = false;
    applyLoginStartup(app, true, 'win32');
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(supportsLoginStartup('win32', false)).toBe(false);
  });
  it('ignores background second-instance launches while ordinary launches still focus', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.on('second-instance'");
    const handler = source.slice(start, source.indexOf('\n});', start) + 4);
    let received!: (event: unknown, argv: string[]) => void;
    const request = vi.fn();
    vm.runInNewContext(handler, { app: { on: (_: string, listener: typeof received) => { received = listener; } }, windowActivation: { request }, isBackgroundLaunch });
    received({}, ['app.exe', '--background']);
    expect(request).not.toHaveBeenCalled();
    received({}, ['app.exe']);
    expect(request).toHaveBeenCalledOnce();
    expect(isBackgroundLaunch(['app.exe', '--background=false'])).toBe(false);
    expect(source).toContain('if (!isBackgroundLaunch(process.argv)) windowActivation.request();');
  });
});
