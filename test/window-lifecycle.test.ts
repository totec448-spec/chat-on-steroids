import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  createWindowActivationGate,
  ownsAppRuntime,
  registerNativeWindowActivation,
  shouldBeginAppBootstrap
} from '../src/main/window-lifecycle.js';

describe('native window activation', () => {
  it('launches through the same maximized presentation as native reopen and preserves explicit fullscreen', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const present = source.slice(source.indexOf('function showWindow()'), source.indexOf('\nsetFinishNotifier(', source.indexOf('function showWindow()'))).replace('function showWindow(): void', 'function showWindow()');
    const operations: string[] = [];
    const state = { minimized: false, fullscreen: false };
    const native = { isMinimized: () => state.minimized, isFullScreen: () => state.fullscreen,
      restore: () => operations.push('restore'), maximize: () => operations.push('maximize'),
      show: () => operations.push('show'), focus: () => operations.push('focus') };
    const createWindow = vi.fn();
    const context = vm.createContext({ window: native, quitting: false, createWindow });
    vm.runInContext(present + '\nshowWindow();', context);
    expect(operations.splice(0)).toEqual(['show', 'maximize', 'focus']);
    context.window = null;
    context.createWindow = vi.fn(() => { context.window = native; });
    vm.runInContext('showWindow()', context);
    expect(context.createWindow).toHaveBeenCalledTimes(1);
    expect(operations.splice(0)).toEqual(['show', 'maximize', 'focus']);
    state.minimized = true;
    vm.runInContext('showWindow()', context);
    expect(operations.splice(0)).toEqual(['restore', 'show', 'maximize', 'focus']);
    state.minimized = false; state.fullscreen = true;
    vm.runInContext('showWindow()', context);
    expect(operations.splice(0)).toEqual(['show', 'focus']);
    context.quitting = true;
    vm.runInContext('showWindow()', context);
    expect(operations).toEqual([]);

    // BrowserWindow itself starts hidden so renderer readiness cannot race presentation. Once
    // startup owns the tray and activation gate, every primary process launch explicitly opens it.
    expect(source).toContain('show: false');
    expect(source).not.toContain("window.once('ready-to-show'");
    expect(source).toContain("tray.on('click', windowActivation.request)");
    const startupCreate = source.indexOf('  createWindow();', source.indexOf('tray = new Tray('));
    const startupShow = source.indexOf('  windowActivation.request();', startupCreate);
    expect(startupCreate).toBeGreaterThan(-1);
    expect(startupShow).toBeGreaterThan(startupCreate);

    // Closing the control panel is never process quit: it is always intercepted and hidden.
    const close = source.slice(source.indexOf("  window.on('close'"), source.indexOf("  window.on('closed'"));
    expect(close).toContain('if (!quitting)');
    expect(close).toContain('event.preventDefault();');
    expect(close).toContain('window?.hide();');
  });
  it('starts background catalog discovery on each actual show, including tray reopen, and never during quit', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const listener = source.slice(source.indexOf("  window.on('show'"), source.indexOf('  // The desktop window is a control panel'));
    let show!: () => void;
    const start = vi.fn(async () => ({}));
    const context = vm.createContext({ window: { on: (event: string, callback: () => void) => {
      expect(event).toBe('show'); show = callback;
    } }, quitting: false, startChatModelDiscovery: start, logWarn: vi.fn() });
    vm.runInContext(listener, context);
    show(); await Promise.resolve();
    show(); await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(2);
    context.quitting = true;
    show();
    expect(start).toHaveBeenCalledTimes(2);
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
    // restoring state. Startup itself opens the control panel only after bootstrap, so an early
    // second-instance request must not create or reveal one before security/IPC is ready.
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
    // reactivate native/second-instance/tray presentation.
    expect(gate.isDisabled()).toBe(true);
    gate.enable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('reopens the app from the macOS native activation event', () => {
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

});
