import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The built-in browser is opt-in. With another browser selected nothing of it loads or runs; once
 * chosen it loads, starts and is painted with what is already true, ready to use.
 */
const app = vi.hoisted(() => {
  const ipc = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => void>();
  return {
    config: { ui: { chatBrowser: 'chrome' as string } },
    ipc,
    bridgeListeners: [] as Array<() => void>,
    sessionListeners: [] as Array<() => void>,
    bridgeStatus: vi.fn(async () => ({ present: true })),
    liveConversations: vi.fn(() => [{ conversationId: 'chat-a', generating: true }, { conversationId: 'chat-b', generating: false }]),
    moduleLoads: 0,
    assets: null as null | { preloadDir: string; rendererDir: string },
    browser: {
      running: false,
      start: vi.fn(async () => { app.browser.running = true; }),
      stop: vi.fn(() => { app.browser.running = false; }),
      setAppConnected: vi.fn(),
      setGeneratingConversations: vi.fn(),
      toolbarAction: vi.fn(),
      signInAction: vi.fn()
    }
  };
});

vi.mock('electron', () => ({
  app: { getAppPath: () => '/fixture/app' },
  ipcMain: { on: (channel: string, listener: any) => app.ipc.set(channel, listener) }
}));
vi.mock('../src/main/config.js', () => ({ getConfig: () => app.config }));
vi.mock('../src/main/logger.js', () => ({ logWarn: vi.fn() }));
vi.mock('../src/main/bridge.js', () => ({
  bridgeStatus: app.bridgeStatus,
  onBridgeChange: (listener: () => void) => { app.bridgeListeners.push(listener); }
}));
vi.mock('../src/main/session/recorder.js', () => ({
  liveConversations: app.liveConversations,
  onSessionChange: (listener: () => void) => { app.sessionListeners.push(listener); }
}));
vi.mock('../src/main/cos-browser/host.js', () => ({
  CosBrowser: class {
    constructor(assets: { preloadDir: string; rendererDir: string }) { app.moduleLoads++; app.assets = assets; }
    running() { return app.browser.running; }
    start() { return app.browser.start(); }
    stop() { app.browser.stop(); }
    setAppConnected(value: boolean) { app.browser.setAppConnected(value); }
    setGeneratingConversations(ids: ReadonlySet<string>) { app.browser.setGeneratingConversations(ids); }
    toolbarAction(...args: unknown[]) { app.browser.toolbarAction(...args); }
    signInAction(...args: unknown[]) { app.browser.signInAction(...args); }
  }
}));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  app.config.ui.chatBrowser = 'chrome';
  app.ipc.clear();
  app.bridgeListeners.length = 0;
  app.sessionListeners.length = 0;
  app.moduleLoads = 0;
  app.browser.running = false;
  for (const mock of [app.bridgeStatus, app.liveConversations, app.browser.start, app.browser.stop, app.browser.setAppConnected,
    app.browser.setGeneratingConversations, app.browser.toolbarAction, app.browser.signInAction]) mock.mockClear();
});
afterEach(() => { vi.resetModules(); });

describe('with another browser selected', () => {
  it.each(['chrome', 'edge', 'brave'])('never loads, starts or hooks the built-in browser (%s)', async browser => {
    app.config.ui.chatBrowser = browser;
    const selection = await import('../src/main/cos-browser/selection.js');
    const loaded = vi.fn();
    selection.onCosBrowserLoaded(loaded);
    await selection.syncCosBrowser();
    await selection.syncCosBrowser();
    expect(app.moduleLoads).toBe(0);
    expect(selection.loadedCosBrowser()).toBeNull();
    expect(loaded).not.toHaveBeenCalled();
    // No hook, no IPC channel, no work on bridge or session changes.
    expect(app.bridgeListeners).toHaveLength(0);
    expect(app.sessionListeners).toHaveLength(0);
    expect(app.ipc.size).toBe(0);
    expect(app.browser.start).not.toHaveBeenCalled();
  });

  it('is not imported statically by the app shell, its IPC or the browser opener', () => {
    // A static import would load the module, and with it its hooks, on the default path.
    for (const file of ['src/main/index.ts', 'src/main/ipc.ts', 'src/main/browser.ts', 'src/main/bridge.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/^import [^;]*from '\.\/cos-browser\/(index|host)\.js'/m);
    }
  });
});

describe('with the built-in browser selected', () => {
  it('loads, starts and paints the current companion and generating state at once', async () => {
    app.config.ui.chatBrowser = 'cos';
    const selection = await import('../src/main/cos-browser/selection.js');
    const loaded = vi.fn();
    selection.onCosBrowserLoaded(loaded);
    await selection.syncCosBrowser();
    await settle();
    expect(app.moduleLoads).toBe(1);
    expect(loaded).toHaveBeenCalledExactlyOnceWith(selection.loadedCosBrowser());
    // Its preloads and pages from the app root: as an on-demand chunk it no longer sits in out/main.
    expect(app.assets!.preloadDir.replace(/\\/g, '/')).toBe('/fixture/app/out/preload');
    expect(app.assets!.rendererDir.replace(/\\/g, '/')).toBe('/fixture/app/out/renderer');
    expect(app.browser.start).toHaveBeenCalledTimes(1);
    // Ready on its first frame, not after the next bridge or session change.
    expect(app.browser.setAppConnected).toHaveBeenCalledWith(true);
    expect(app.browser.setGeneratingConversations).toHaveBeenCalledWith(new Set(['chat-a']));
    // Its hooks work while it runs.
    app.browser.setGeneratingConversations.mockClear();
    for (const listener of app.sessionListeners) listener();
    expect(app.browser.setGeneratingConversations).toHaveBeenCalledTimes(1);
    app.ipc.get('cos-browser:toolbar')!({ sender: 'toolbar' }, 'reload', 7);
    expect(app.browser.toolbarAction).toHaveBeenCalledWith('toolbar', 'reload', 7);
  });

  it('switching away stops it and returns its hooks to doing nothing', async () => {
    app.config.ui.chatBrowser = 'cos';
    const selection = await import('../src/main/cos-browser/selection.js');
    await selection.syncCosBrowser();
    await settle();
    app.config.ui.chatBrowser = 'chrome';
    await selection.syncCosBrowser();
    expect(app.browser.stop).toHaveBeenCalledTimes(1);
    for (const mock of [app.bridgeStatus, app.liveConversations, app.browser.setAppConnected, app.browser.setGeneratingConversations]) mock.mockClear();
    for (const listener of [...app.bridgeListeners, ...app.sessionListeners]) listener();
    app.ipc.get('cos-browser:toolbar')!({ sender: 'toolbar' }, 'reload', 7);
    app.ipc.get('cos-browser:sign-in')!({ sender: 'card' }, 'cancel');
    await settle();
    expect(app.bridgeStatus).not.toHaveBeenCalled();
    expect(app.liveConversations).not.toHaveBeenCalled();
    expect(app.browser.toolbarAction).not.toHaveBeenCalled();
    expect(app.browser.signInAction).not.toHaveBeenCalled();
  });
});
