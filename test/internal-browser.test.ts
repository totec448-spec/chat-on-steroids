import { afterEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  let nextId = 10;
  const contents = new Map<number, any>();
  const views: any[] = [];
  const browserSession = {
    getUserAgent: vi.fn(() => 'Fake Electron/44.3.0'),
    setUserAgent: vi.fn(),
    extensions: { loadExtension: vi.fn(async () => ({ version: 'test' })) }
  };

  class FakeWebContents {
    id = nextId++;
    session = browserSession;
    destroyed = false;
    url = '';
    title = '';
    openHandler: ((details: any) => any) | null = null;
    listeners = new Map<string, Set<Listener>>();

    constructor() { contents.set(this.id, this); }
    on(name: string, listener: Listener): this {
      const bucket = this.listeners.get(name) ?? new Set<Listener>();
      bucket.add(listener);
      this.listeners.set(name, bucket);
      return this;
    }
    once(name: string, listener: Listener): this {
      const wrapped: Listener = (...args) => {
        this.listeners.get(name)?.delete(wrapped);
        listener(...args);
      };
      return this.on(name, wrapped);
    }
    emit(name: string, ...args: any[]): void {
      for (const listener of [...(this.listeners.get(name) ?? [])]) listener(...args);
    }
    setWindowOpenHandler(handler: (details: any) => any): void { this.openHandler = handler; }
    async loadURL(url: string): Promise<void> {
      this.emit('did-start-loading');
      this.emit('did-start-navigation', {}, url, false, true);
      this.url = url;
      this.emit('did-navigate', {}, url);
      this.emit('did-stop-loading');
    }
    getURL(): string { return this.url; }
    getTitle(): string { return this.title; }
    isDestroyed(): boolean { return this.destroyed; }
    close(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('destroyed');
    }
    reload(): void {}
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents();
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor(_options?: unknown) { views.push(this); }
  }

  class FakeBrowserWindow {
    destroyed = false;
    webContents = { send: vi.fn() };
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    closed: (() => void) | null = null;
    isDestroyed(): boolean { return this.destroyed; }
    once(name: string, listener: () => void): void { if (name === 'closed') this.closed = listener; }
  }

  return {
    browserSession,
    contents,
    views,
    FakeBrowserWindow,
    FakeWebContentsView,
    clear(): void {
      contents.clear();
      views.length = 0;
      browserSession.extensions.loadExtension.mockClear();
      browserSession.setUserAgent.mockClear();
    }
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: fake.FakeBrowserWindow,
  WebContentsView: fake.FakeWebContentsView,
  session: { fromPartition: vi.fn(() => fake.browserSession) },
  shell: { openExternal: vi.fn() }
}));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => 'C:\\fake-extension' }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: vi.fn() }));

const browser = await import('../src/main/internal-browser.js');

afterEach(async () => {
  await browser.shutdownInternalBrowser();
  fake.clear();
});

it('matches the ChatGPT patterns used by the companion without widening hosts', () => {
  expect(browser.internalBrowserUrlMatches('https://chatgpt.com/c/abc?x=1', 'https://chatgpt.com/*')).toBe(true);
  expect(browser.internalBrowserUrlMatches('https://chat.openai.com/', 'https://chat.openai.com/*')).toBe(true);
  expect(browser.internalBrowserUrlMatches('https://evil.example/chatgpt.com/', 'https://chatgpt.com/*')).toBe(false);
  expect(browser.internalBrowserUrlMatches('http://chatgpt.com/', 'https://chatgpt.com/*')).toBe(false);
});

it('supports wildcard subdomains without treating sibling domains as matches', () => {
  expect(browser.internalBrowserUrlMatches('https://a.example.com/path', 'https://*.example.com/*')).toBe(true);
  expect(browser.internalBrowserUrlMatches('https://example.com/path', 'https://*.example.com/*')).toBe(true);
  expect(browser.internalBrowserUrlMatches('https://notexample.com/path', 'https://*.example.com/*')).toBe(false);
});

it('prewarms one real hidden ChatGPT document and reuses it across concurrent startup calls', async () => {
  const [first, second] = await Promise.all([
    browser.prewarmInternalBrowser(),
    browser.prewarmInternalBrowser()
  ]);

  expect(first).toBe(second);
  expect(fake.views).toHaveLength(1);
  expect(fake.browserSession.extensions.loadExtension).toHaveBeenCalledTimes(1);
  expect(browser.internalBrowserDockState()).toMatchObject({
    open: false,
    ready: true,
    tabId: first,
    tabs: [{ id: first, active: true, status: 'complete', url: 'https://chatgpt.com/' }]
  });
});

it('recognizes only the exact app-owned browser session', async () => {
  expect(browser.isInternalBrowserSession(fake.browserSession as any)).toBe(false);
  await browser.ensureInternalBrowserReady();
  expect(browser.isInternalBrowserSession(fake.browserSession as any)).toBe(true);
  expect(browser.isInternalBrowserSession({} as any)).toBe(false);
});

it('keeps browser-created child tabs alive in the background without requesting the dock', async () => {
  await browser.ensureInternalBrowserReady();
  const created = await browser.handleInternalBrowserHostRequest({
    action: 'create',
    create: { url: 'https://chatgpt.com/', active: true }
  }) as { tab: { id: number } };
  const owner = new fake.FakeBrowserWindow();
  browser.attachInternalBrowserWindow(owner as any);
  const parent = fake.contents.get(created.tab.id)!;
  const decision = parent.openHandler!({ url: 'https://chatgpt.com/c/child' });
  decision.createWindow();

  expect(browser.internalBrowserDockState().open).toBe(false);
  expect(browser.internalBrowserDockState().tabs).toHaveLength(2);
  expect(owner.webContents.send.mock.calls.some(call => call[0] === 'internalBrowser:showRequested')).toBe(false);
});

it('keeps background host creation hidden while an explicit user open may reveal the dock', async () => {
  await browser.prewarmInternalBrowser();
  await browser.handleInternalBrowserHostRequest({
    action: 'create',
    create: { url: 'https://chatgpt.com/c/worker', active: false, windowId: 1, index: 1 }
  });
  expect(browser.internalBrowserDockState().open).toBe(false);

  const owner = new fake.FakeBrowserWindow();
  browser.attachInternalBrowserWindow(owner as any);
  await browser.openInternalBrowserUrl('https://chatgpt.com/c/user-open', { active: true, reveal: true });
  expect(browser.internalBrowserDockState().open).toBe(true);
  expect(owner.webContents.send).toHaveBeenCalledWith('internalBrowser:showRequested');
});

it('keeps every live view mounted with real offscreen geometry while the dock is hidden', async () => {
  const prewarm = await browser.prewarmInternalBrowser();
  const owner = new fake.FakeBrowserWindow();
  browser.attachInternalBrowserWindow(owner as any);

  const activeView = fake.views[0]!;
  expect(owner.contentView.addChildView).toHaveBeenCalledWith(activeView);
  expect(activeView.setVisible).toHaveBeenLastCalledWith(true);
  const activeParked = activeView.setBounds.mock.calls.at(-1)?.[0] as {
    x: number; y: number; width: number; height: number;
  };
  expect(activeParked.x).toBeLessThan(0);
  expect(activeParked.width).toBeGreaterThanOrEqual(420);
  expect(activeParked.height).toBeGreaterThanOrEqual(720);

  const created = await browser.handleInternalBrowserHostRequest({
    action: 'create',
    create: { url: 'https://chatgpt.com/c/worker', active: false }
  }) as { tab: { id: number } };
  const backgroundView = fake.views[1]!;
  expect(created.tab.id).not.toBe(prewarm);
  expect(owner.contentView.addChildView).toHaveBeenCalledWith(backgroundView);
  expect(backgroundView.setVisible).toHaveBeenLastCalledWith(true);
  const backgroundParked = backgroundView.setBounds.mock.calls.at(-1)?.[0] as {
    x: number; y: number; width: number; height: number;
  };
  expect(backgroundParked.x).toBeLessThan(0);
  expect(backgroundParked.width).toBeGreaterThanOrEqual(420);
  expect(backgroundParked.height).toBeGreaterThanOrEqual(720);
  expect(browser.internalBrowserDockState().open).toBe(false);

  const bounds = { x: 80, y: 24, width: 560, height: 840 };
  await browser.showInternalBrowserDock(bounds);
  expect(activeView.setBounds).toHaveBeenLastCalledWith(bounds);
  expect(backgroundView.setBounds).toHaveBeenLastCalledWith({ x: -560, y: 0, width: 560, height: 840 });

  owner.contentView.removeChildView.mockClear();
  browser.hideInternalBrowserDock();
  expect(activeView.setBounds).toHaveBeenLastCalledWith({ x: -560, y: 0, width: 560, height: 840 });
  expect(activeView.setVisible).toHaveBeenLastCalledWith(true);
  expect(backgroundView.setBounds).toHaveBeenLastCalledWith({ x: -560, y: 0, width: 560, height: 840 });
  expect(owner.contentView.removeChildView).not.toHaveBeenCalled();
});

it('detaches mounted views only for retirement, owner replacement, and shutdown', async () => {
  const first = await browser.prewarmInternalBrowser();
  const owner = new fake.FakeBrowserWindow();
  browser.attachInternalBrowserWindow(owner as any);
  const second = await browser.handleInternalBrowserHostRequest({
    action: 'create',
    create: { url: 'https://chatgpt.com/c/background', active: false }
  }) as { tab: { id: number } };

  const replacement = new fake.FakeBrowserWindow();
  browser.attachInternalBrowserWindow(replacement as any);
  expect(owner.contentView.removeChildView).toHaveBeenCalledTimes(2);
  expect(replacement.contentView.addChildView).toHaveBeenCalledTimes(2);

  await browser.handleInternalBrowserHostRequest({ action: 'remove', tabId: second.tab.id });
  expect(replacement.contentView.removeChildView).toHaveBeenCalledWith(fake.views[1]);

  replacement.contentView.removeChildView.mockClear();
  await browser.shutdownInternalBrowser();
  expect(replacement.contentView.removeChildView).toHaveBeenCalledWith(fake.views[0]);
  expect(fake.contents.get(first)?.isDestroyed()).toBe(true);
});

it('presents user-held tabs as pinned so opening another recorded chat cannot idle-prune the current one', async () => {
  await browser.ensureInternalBrowserReady();
  const first = await browser.openInternalBrowserUrl('https://chatgpt.com/c/prime', { active: true });
  const owner = new fake.FakeBrowserWindow();
  browser.attachInternalBrowserWindow(owner as any);

  await browser.showInternalBrowserDock({ x: 0, y: 0, width: 300, height: 600 });
  const second = await browser.openInternalBrowserUrl('https://chatgpt.com/c/history', {
    active: true,
    reveal: true,
    retain: true
  });

  const prime = await browser.handleInternalBrowserHostRequest({ action: 'get', tabId: first }) as { tab: { pinned: boolean } };
  const history = await browser.handleInternalBrowserHostRequest({ action: 'get', tabId: second }) as { tab: { pinned: boolean } };
  expect(prime.tab.pinned).toBe(true);
  expect(history.tab.pinned).toBe(true);
  expect(browser.internalBrowserDockState().tabs.map(tab => tab.id)).toEqual([first, second]);
});

it('emits one loading document boundary for one Electron loading cycle even if navigation starts again', async () => {
  await browser.ensureInternalBrowserReady();
  const created = await browser.handleInternalBrowserHostRequest({
    action: 'create',
    create: { url: 'https://chatgpt.com/', active: true }
  }) as { tab: { id: number } };
  const contents = fake.contents.get(created.tab.id)!;
  // Ignore the create navigation itself; this assertion is about a later single spinner cycle.
  const before = await browser.handleInternalBrowserHostRequest({ action: 'events', after: 0 }) as {
    cursor: number;
    generation: string;
  };

  contents.emit('did-start-loading');
  contents.emit('did-start-navigation', {}, 'https://chatgpt.com/', false, true);
  contents.emit('did-start-navigation', {}, 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', false, true);
  contents.url = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  contents.emit('did-navigate', {}, contents.url);
  contents.emit('did-stop-loading');

  const lifecycle = await browser.handleInternalBrowserHostRequest({
    action: 'events',
    generation: before.generation,
    after: before.cursor
  }) as {
    events: Array<{ type: string; tabId: number; changeInfo?: { url?: string; status?: string } }>;
  };
  const updates = lifecycle.events.filter(event => event.type === 'updated' && event.tabId === created.tab.id);
  expect(updates.filter(event => event.changeInfo?.status === 'loading')).toHaveLength(1);
  expect(updates.filter(event => event.changeInfo?.status === 'complete')).toHaveLength(1);
  expect(updates.filter(event => event.changeInfo?.url)).toEqual(expect.arrayContaining([
    expect.objectContaining({ changeInfo: { url: 'https://chatgpt.com/' } }),
    expect.objectContaining({ changeInfo: { url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } })
  ]));
});
