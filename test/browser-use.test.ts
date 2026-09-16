import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  let nextId = 100;
  const views: any[] = [];
  const hosts: any[] = [];
  const contents = new Map<number, any>();
  let partition = '';
  let currentSnapshot = 0;
  let onSnapshotEvaluate: (() => void) | null = null;
  let onCapturePage: (() => void) | null = null;
  let onKeyDown: (() => void) | null = null;

  const browserSession = {
    getUserAgent: vi.fn(() => 'Fake Electron/44.3.0'),
    setUserAgent: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn()
  };

  class FakeDebugger {
    attached = false;
    calls: Array<[string, any]> = [];
    constructor(private owner: { url: string; title: string }) {}
    isAttached(): boolean { return this.attached; }
    attach(): void { this.attached = true; }
    async sendCommand(method: string, params: any = {}): Promise<any> {
      this.calls.push([method, params]);
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') onKeyDown?.();
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression ?? '');
        if (expression.includes('const maxElements')) {
          const match = /snapshotId:\s*(\d+)/.exec(expression);
          currentSnapshot = Number(match?.[1] ?? 0);
          onSnapshotEvaluate?.();
          return { result: { value: {
            url: this.owner.url || 'about:blank', title: this.owner.title, viewport: { width: 800, height: 600 },
            text: expression.includes("text: '', elements") ? '' : 'Example page',
            elements: [{ ref: 'e1', tag: 'button', role: 'button', name: 'Save', disabled: false, x: 20, y: 30, width: 80, height: 28 }]
          } } };
        }
        if (expression.includes('store.refs.get')) {
          const match = /store\.snapshotId !== (\d+)/.exec(expression);
          if (Number(match?.[1] ?? -1) !== currentSnapshot) return { exceptionDetails: { text: 'STALE_BROWSER_STATE' } };
          return { result: { value: { x: 20, y: 30, width: 80, height: 28 } } };
        }
        if (expression.includes('innerWidth / 2')) return { result: { value: { x: 400, y: 300 } } };
        return { result: { value: null } };
      }
      return {};
    }
  }

  class FakeWebContents {
    id = nextId++;
    session = browserSession;
    debugger: FakeDebugger;
    destroyed = false;
    url = '';
    title = '';
    openHandler: ((details: any) => any) | null = null;
    listeners = new Map<string, Set<Listener>>();
    userAgent = 'Fake Electron/44.3.0';
    history = ['about:blank'];
    historyIndex = 0;
    navigationHistory = {
      canGoBack: () => this.historyIndex > 0,
      canGoForward: () => this.historyIndex < this.history.length - 1,
      canGoToOffset: (offset: number) => {
        const next = this.historyIndex + offset;
        return next >= 0 && next < this.history.length;
      },
      getActiveIndex: () => this.historyIndex,
      getEntryAtIndex: (index: number) => index >= 0 && index < this.history.length
        ? { url: this.history[index], title: '' }
        : null,
      goBack: () => { if (this.historyIndex > 0) { this.historyIndex--; this.navigateHistory(); } },
      goForward: () => { if (this.historyIndex < this.history.length - 1) { this.historyIndex++; this.navigateHistory(); } }
    };

    constructor() { this.debugger = new FakeDebugger(this); contents.set(this.id, this); }
    on(name: string, listener: Listener): this {
      const bucket = this.listeners.get(name) ?? new Set<Listener>();
      bucket.add(listener); this.listeners.set(name, bucket); return this;
    }
    once(name: string, listener: Listener): this {
      const wrapped: Listener = (...args) => { this.listeners.get(name)?.delete(wrapped); listener(...args); };
      return this.on(name, wrapped);
    }
    emit(name: string, ...args: any[]): void { for (const listener of [...(this.listeners.get(name) ?? [])]) listener(...args); }
    setWindowOpenHandler(handler: (details: any) => any): void { this.openHandler = handler; }
    getUserAgent(): string { return this.userAgent; }
    setUserAgent(value: string): void { this.userAgent = value; }
    getURL(): string { return this.url; }
    getTitle(): string { return this.title; }
    isDestroyed(): boolean { return this.destroyed; }
    async loadURL(url: string): Promise<void> {
      this.emit('did-start-loading');
      this.emit('did-start-navigation', {}, url, false, true);
      this.url = url; this.title = url === 'about:blank' ? '' : 'Example';
      if (this.history[this.historyIndex] !== url) {
        this.history = this.history.slice(0, this.historyIndex + 1); this.history.push(url); this.historyIndex++;
      }
      this.emit('did-navigate', {}, url);
      this.emit('did-stop-loading');
    }
    navigateHistory(): void {
      this.url = this.history[this.historyIndex]!;
      this.emit('did-start-loading'); this.emit('did-navigate', {}, this.url); this.emit('did-stop-loading');
    }
    reload(): void { this.emit('did-start-loading'); this.emit('did-stop-loading'); }
    capturePage(): Promise<{ toPNG(): Buffer }> {
      onCapturePage?.();
      return Promise.resolve({ toPNG: () => Buffer.from('fake-png') });
    }
    close(): void { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed'); } }
  }

  class FakeView {
    children: any[] = [];
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
    addChildView = vi.fn((view: any) => { if (!this.children.includes(view)) this.children.push(view); });
    removeChildView = vi.fn((view: any) => { this.children = this.children.filter(child => child !== view); });
    constructor() { hosts.push(this); }
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents();
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor(_options?: unknown) { views.push(this); }
  }

  class FakeBrowserWindow {
    destroyed = false;
    webContents = { send: vi.fn(), isDestroyed: () => false };
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    closed: (() => void) | null = null;
    isDestroyed(): boolean { return this.destroyed; }
    once(name: string, listener: () => void): void { if (name === 'closed') this.closed = listener; }
  }

  return {
    browserSession, views, hosts, contents, FakeBrowserWindow, FakeView, FakeWebContentsView,
    setPartition(value: string): void { partition = value; },
    setSnapshotHook(value: (() => void) | null): void { onSnapshotEvaluate = value; },
    setCaptureHook(value: (() => void) | null): void { onCapturePage = value; },
    setKeyDownHook(value: (() => void) | null): void { onKeyDown = value; },
    get partition(): string { return partition; },
    reset(): void {
      views.length = 0; hosts.length = 0; contents.clear(); partition = ''; currentSnapshot = 0;
      onSnapshotEvaluate = null; onCapturePage = null; onKeyDown = null;
      browserSession.setUserAgent.mockClear(); browserSession.setPermissionCheckHandler.mockClear(); browserSession.setPermissionRequestHandler.mockClear();
    }
  };
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => path.join(process.cwd(), '.dev-sandbox', 'browser-use-test-user-data')) },
  BrowserWindow: fake.FakeBrowserWindow,
  View: fake.FakeView,
  WebContentsView: fake.FakeWebContentsView,
  session: { fromPartition: vi.fn((name: string) => { fake.setPartition(name); return fake.browserSession; }) }
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

const browser = await import('../src/main/browser-use.js');

afterEach(async () => {
  await browser.shutdownBrowserUse();
  fake.reset();
});

it('normalizes only ordinary web targets and never admits host/file/javascript URLs', () => {
  expect(browser.normalizeBrowserUseTarget('example.com/docs')).toBe('https://example.com/docs');
  expect(browser.normalizeBrowserUseTarget('localhost:5173')).toBe('http://localhost:5173/');
  expect(browser.normalizeBrowserUseTarget('browser use architecture')).toContain('https://www.google.com/search?q=browser%20use%20architecture');
  expect(() => browser.normalizeBrowserUseTarget('file:///C:/secret.txt')).toThrow(/only http and https/i);
  expect(() => browser.normalizeBrowserUseTarget('javascript:alert(1)')).toThrow(/only http and https/i);
});

it('owns a distinct persist:cos-web session with no companion-extension dependency', async () => {
  expect(browser.isBrowserUseSession(fake.browserSession as any)).toBe(false);
  await browser.ensureBrowserUseReady();
  expect(fake.partition).toBe('persist:cos-web');
  expect(browser.isBrowserUseSession(fake.browserSession as any)).toBe(true);
  expect(browser.isBrowserUseSession({} as any)).toBe(false);
  expect('extensions' in fake.browserSession).toBe(false);
});

it('keeps Browser Use tabs inside one native viewport host and hides the host with the panel', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab(undefined, 'user');
  const view = fake.views[0]!;
  const host = fake.hosts[0]!;
  expect(browser.browserUseState().tabs[0]?.url).toBe('https://www.google.com/');
  expect(view.setBackgroundColor).toHaveBeenCalledWith('#00000000');
  expect(host.setBackgroundColor).toHaveBeenCalledWith('#00000000');
  expect(owner.contentView.addChildView).toHaveBeenCalledWith(host);
  expect(host.addChildView).toHaveBeenCalledWith(view);
  await browser.showBrowserUsePanel({ x: 200, y: 80, width: 600, height: 500 });
  expect(host.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 80, width: 600, height: 500 });
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 600, height: 500 });
  expect(host.setVisible).toHaveBeenLastCalledWith(true);
  expect(view.setVisible).toHaveBeenLastCalledWith(true);
  browser.hideBrowserUsePanel();
  expect(host.setVisible).toHaveBeenLastCalledWith(false);
  expect(owner.contentView.removeChildView).not.toHaveBeenCalled();
});

it('reparents one native viewport host across window recreation without promoting remote tabs to window children', async () => {
  await browser.ensureBrowserUseReady();
  const firstOwner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(firstOwner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  await browser.showBrowserUsePanel({ x: 200, y: 80, width: 600, height: 500 });
  const host = fake.hosts[0]!;
  const view = fake.views[0]!;

  const replacement = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(replacement as any);

  expect(firstOwner.contentView.removeChildView).toHaveBeenCalledWith(host);
  expect(replacement.contentView.addChildView).toHaveBeenCalledWith(host);
  expect(replacement.contentView.addChildView).not.toHaveBeenCalledWith(view);
  expect(host.children).toContain(view);
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 600, height: 500 });
});

it('keeps inactive tabs clipped in the native host and only the active tab fills its local viewport', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/one', 'user');
  const first = fake.views[0]!;
  await browser.openBrowserUseTab('https://example.com/two', 'user');
  const second = fake.views[1]!;
  const host = fake.hosts[0]!;

  await browser.showBrowserUsePanel({ x: 300, y: 90, width: 500, height: 420 });
  expect(host.children).toEqual([first, second]);
  expect(first.setVisible).toHaveBeenLastCalledWith(false);
  expect(second.setVisible).toHaveBeenLastCalledWith(true);
  expect(second.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 500, height: 420 });

  browser.layoutBrowserUsePanel({ x: 220, y: 90, width: 580, height: 420 });
  expect(host.setBounds).toHaveBeenLastCalledWith({ x: 220, y: 90, width: 580, height: 420 });
  expect(second.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 580, height: 420 });
});

it('rebinds the agent overview to a newly active tab and marks the closed id as STALE_TAB', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/one', 'user');
  const firstId = browser.browserUseAgentOverview().activeTabId!;

  browser.closeBrowserUseTab(firstId);
  await browser.openBrowserUseTab('https://example.com/two', 'user');
  const overview = browser.browserUseAgentOverview();

  expect(overview.activeTabId).not.toBe(firstId);
  expect(overview.tabs).toEqual([
    expect.objectContaining({ id: overview.activeTabId, active: true, url: 'https://example.com/two' })
  ]);
  await expect(browser.observeBrowserUseTab(firstId, false)).rejects.toMatchObject({
    name: 'BrowserUseProtocolError',
    code: 'STALE_TAB'
  });
});

it('blocks an agent on a new origin until the user approves that exact origin', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  const opening = browser.openBrowserUseTab('https://example.com/', 'agent');
  await vi.waitFor(() => expect(browser.browserUseState().permission?.origin).toBe('https://example.com'));
  const permission = browser.browserUseState().permission!;
  expect(owner.webContents.send).toHaveBeenCalledWith('browserUse:showRequested');
  browser.settleBrowserUsePermission(permission.id, 'once');
  await opening;
  expect(browser.browserUseState().tabs[0]?.url).toBe('https://example.com/');
  expect(browser.browserUseState().permission).toBeNull();
});

it('treats ERR_ABORTED as benign only when another main-frame navigation superseded the requested load', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/start', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  const contents = fake.contents.get(tabId)!;

  contents.loadURL = vi.fn(async (url: string) => {
    contents.emit('did-start-loading');
    contents.emit('did-start-navigation', {}, url, false, true);
    const replacement = 'https://example.com/replacement';
    contents.emit('did-start-navigation', {}, replacement, false, true);
    contents.url = replacement;
    contents.title = 'Replacement';
    contents.emit('did-navigate', {}, replacement);
    contents.emit('did-stop-loading');
    throw Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED' });
  });

  await expect(browser.navigateBrowserUseTab(tabId, 'https://example.com/requested', 'user')).resolves.toEqual(
    expect.objectContaining({ activeTabId: tabId })
  );
  expect(browser.browserUseState().tabs[0]?.url).toBe('https://example.com/replacement');
});

it('keeps ERR_ABORTED visible when a requested navigation was not superseded', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/start', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  const contents = fake.contents.get(tabId)!;

  contents.loadURL = vi.fn(async (url: string) => {
    contents.emit('did-start-loading');
    contents.emit('did-start-navigation', {}, url, false, true);
    throw Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED' });
  });

  await expect(browser.navigateBrowserUseTab(tabId, 'https://example.com/requested', 'user')).rejects.toThrow('ERR_ABORTED');
});

it('does not surface a close-induced ERR_FAILED to a user navigation promise', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/start', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  const contents = fake.contents.get(tabId)!;
  let rejectLoad!: (error: Error) => void;

  contents.loadURL = vi.fn((url: string) => {
    contents.emit('did-start-loading');
    contents.emit('did-start-navigation', {}, url, false, true);
    return new Promise<void>((_resolve, reject) => { rejectLoad = reject; });
  });

  const navigating = browser.navigateBrowserUseTab(tabId, 'https://example.com/requested', 'user');
  await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalled());
  browser.closeBrowserUseTab(tabId);
  rejectLoad(Object.assign(new Error('ERR_FAILED (-2)'), { code: 'ERR_FAILED' }));

  await expect(navigating).resolves.toEqual(expect.objectContaining({ activeTabId: null }));
});

it('maps a close-induced navigation failure to STALE_TAB for an agent action', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/start', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  const contents = fake.contents.get(tabId)!;
  let rejectLoad!: (error: Error) => void;

  contents.loadURL = vi.fn((url: string) => {
    contents.emit('did-start-loading');
    contents.emit('did-start-navigation', {}, url, false, true);
    return new Promise<void>((_resolve, reject) => { rejectLoad = reject; });
  });

  const navigating = browser.navigateBrowserUseTab(tabId, 'https://example.com/requested', 'agent');
  await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalled());
  browser.closeBrowserUseTab(tabId);
  rejectLoad(Object.assign(new Error('ERR_FAILED (-2)'), { code: 'ERR_FAILED' }));

  await expect(navigating).rejects.toMatchObject({ name: 'BrowserUseProtocolError', code: 'STALE_TAB' });
});

it('keeps ERR_FAILED visible when the tab was not intentionally retired', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/start', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  const contents = fake.contents.get(tabId)!;

  contents.loadURL = vi.fn(async (url: string) => {
    contents.emit('did-start-loading');
    contents.emit('did-start-navigation', {}, url, false, true);
    throw Object.assign(new Error('ERR_FAILED (-2)'), { code: 'ERR_FAILED' });
  });

  await expect(browser.navigateBrowserUseTab(tabId, 'https://example.com/requested', 'user')).rejects.toThrow('ERR_FAILED (-2)');
});

it('keeps one agent mission active across tool calls until done or manual takeover', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  const running = browser.withBrowserUseAgentActivity(() => gate);
  await vi.waitFor(() => expect(browser.browserUseState().agentActive).toBe(true));
  expect(owner.webContents.send).toHaveBeenCalledWith('browserUse:stateChanged', expect.objectContaining({ agentActive: true }));

  release();
  await running;
  expect(browser.browserUseState().agentActive).toBe(true);

  await expect(browser.withBrowserUseAgentActivity(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(browser.browserUseState().agentActive).toBe(true);

  await browser.finishBrowserUseAgentMission({ graceMs: 0 });
  expect(browser.browserUseState().agentActive).toBe(false);

  await browser.withBrowserUseAgentActivity(async () => undefined);
  expect(browser.browserUseState().agentActive).toBe(true);

  browser.noteBrowserUseUserTakeover();
  expect(browser.browserUseState().agentActive).toBe(false);
});

it('skips redundant renderer and glow work on the steady-state agent hot path', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  const contents = fake.contents.get(tabId)!;

  owner.webContents.send.mockClear();
  contents.debugger.calls.length = 0;

  browser.beginBrowserUseAgentMission();
  await vi.waitFor(() => {
    const visualEvaluations = contents.debugger.calls.filter(
      ([method, params]: [string, { expression?: string }]) =>
        method === 'Runtime.evaluate' && String(params.expression).includes('data-cos-browser-use-agent-cursor')
    );
    expect(visualEvaluations).toHaveLength(1);
  });
  owner.webContents.send.mockClear();

  // Re-entering the same mission and repeatedly observing the same active tab should not
  // re-send showRequested/stateChanged, rebuild the native view tree, or inject the glow again.
  browser.beginBrowserUseAgentMission();
  await browser.observeBrowserUseTab(tabId, false);
  await browser.observeBrowserUseTab(tabId, false);

  const visualEvaluations = contents.debugger.calls.filter(
    ([method, params]: [string, { expression?: string }]) =>
      method === 'Runtime.evaluate' && String(params.expression).includes('data-cos-browser-use-agent-cursor')
  );
  expect(visualEvaluations).toHaveLength(1);
  expect(owner.webContents.send).not.toHaveBeenCalledWith('browserUse:showRequested');
  expect(owner.webContents.send).not.toHaveBeenCalledWith('browserUse:stateChanged', expect.anything());
});

it('scopes Allow once to one tab visit instead of trusting that origin process-wide', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);

  const first = browser.openBrowserUseTab('https://example.com/', 'agent');
  await vi.waitFor(() => expect(browser.browserUseState().permission?.origin).toBe('https://example.com'));
  browser.settleBrowserUsePermission(browser.browserUseState().permission!.id, 'once');
  await first;

  const second = browser.openBrowserUseTab('https://example.com/private', 'agent');
  await vi.waitFor(() => expect(browser.browserUseState().permission?.origin).toBe('https://example.com'));
  const active = browser.browserUseState().activeTabId!;
  const projected = browser.browserUseAgentTabs().find(tab => tab.id === active)!;
  expect(projected).toMatchObject({ id: active, approval_required: 'https://example.com' });
  expect(projected).not.toHaveProperty('url');
  expect(projected).not.toHaveProperty('title');
  browser.settleBrowserUsePermission(browser.browserUseState().permission!.id, 'deny');
  await expect(second).rejects.toThrow(/declined/i);
});

it('treats user navigation as consent for that origin, but a redirect needs fresh agent approval', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tab = browser.browserUseState().tabs[0]!;
  expect(browser.browserUseState().permission).toBeNull();

  const contents = fake.contents.get(tab.id)!;
  contents.url = 'https://other.example/path';
  contents.emit('did-navigate', {}, contents.url);
  const state = browser.observeBrowserUseTab(tab.id, false);
  await vi.waitFor(() => expect(browser.browserUseState().permission?.origin).toBe('https://other.example'));
  browser.settleBrowserUsePermission(browser.browserUseState().permission!.id, 'once');
  await state;
});

it('does not let an allowed page launder a new popup origin into agent trust', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const parent = fake.contents.get(browser.browserUseState().activeTabId!)!;
  const decision = parent.openHandler!({ url: 'https://other.example/popup' });
  expect(decision.action).toBe('allow');
  const child = decision.createWindow();
  await child.loadURL('https://other.example/popup');

  const observing = browser.observeBrowserUseTab(child.id, false);
  await vi.waitFor(() => expect(browser.browserUseState().permission?.origin).toBe('https://other.example'));
  browser.settleBrowserUsePermission(browser.browserUseState().permission!.id, 'once');
  await observing;
});

it('authorizes an agent history jump before crossing to a different origin', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  await browser.navigateBrowserUseTab(tabId, 'https://other.example/', 'user');

  const goingBack = browser.browserUseHistory(tabId, 'back', 'agent');
  await vi.waitFor(() => expect(browser.browserUseState().permission?.origin).toBe('https://example.com'));
  browser.settleBrowserUsePermission(browser.browserUseState().permission!.id, 'once');
  await goingBack;
  expect(browser.browserUseState().tabs[0]?.url).toBe('https://example.com/');
});

it('rejects an observation if the top-level document changes during DOM evaluation', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  const contents = fake.contents.get(tabId)!;
  fake.setSnapshotHook(() => {
    fake.setSnapshotHook(null);
    const next = 'https://other.example/redirected';
    contents.emit('did-start-navigation', {}, next, false, true);
    contents.url = next; contents.title = 'Other';
    contents.emit('did-navigate', {}, next);
  });

  await expect(browser.observeBrowserUseTab(tabId, false)).rejects.toThrow(/STALE_BROWSER_STATE/);
  expect(browser.browserUseAgentTabs()[0]).toMatchObject({ approval_required: 'https://other.example' });
});

it('discards a screenshot if navigation races capture after a valid DOM snapshot', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  const contents = fake.contents.get(tabId)!;
  fake.setCaptureHook(() => {
    fake.setCaptureHook(null);
    const next = 'https://other.example/capture-race';
    contents.emit('did-start-navigation', {}, next, false, true);
    contents.url = next; contents.title = 'Other';
    contents.emit('did-navigate', {}, next);
  });

  await expect(browser.observeBrowserUseTab(tabId, true)).rejects.toThrow(/STALE_BROWSER_STATE/);
});

it('invalidates refs when the Browser Use viewport changes size without a navigation', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  await browser.showBrowserUsePanel({ x: 200, y: 80, width: 600, height: 500 });
  const snapshot = await browser.observeBrowserUseTab(tabId, false);

  browser.layoutBrowserUsePanel({ x: 160, y: 80, width: 640, height: 500 });

  await expect(browser.clickBrowserUseRef(tabId, snapshot.snapshotId, 'e1')).rejects.toThrow(/STALE_BROWSER_STATE/);
});

it('rejects an observation when resize reflows the viewport during DOM evaluation', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  await browser.showBrowserUsePanel({ x: 200, y: 80, width: 600, height: 500 });
  fake.setSnapshotHook(() => {
    fake.setSnapshotHook(null);
    browser.layoutBrowserUsePanel({ x: 180, y: 80, width: 620, height: 500 });
  });

  await expect(browser.observeBrowserUseTab(tabId, false)).rejects.toThrow(/STALE_BROWSER_STATE/);
});

it('does not send keyUp into a replacement document if keyDown triggers navigation', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  const snapshot = await browser.observeBrowserUseTab(tabId, false);
  const contents = fake.contents.get(tabId)!;
  fake.setKeyDownHook(() => {
    fake.setKeyDownHook(null);
    const next = 'https://other.example/key-race';
    contents.emit('did-start-navigation', {}, next, false, true);
    contents.url = next; contents.title = 'Other';
    contents.emit('did-navigate', {}, next);
  });

  await expect(browser.keyBrowserUseTab(tabId, snapshot.snapshotId, 'Enter')).rejects.toThrow(/STALE_BROWSER_STATE/);
  const keyEvents = contents.debugger.calls.filter(([method]: [string]) => method === 'Input.dispatchKeyEvent');
  expect(keyEvents.map(([, params]: [string, { type: string }]) => params.type)).toEqual(['keyDown']);
});

it('issues exact snapshot refs and rejects them after one action changes the page state', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  await browser.showBrowserUsePanel({ x: 200, y: 80, width: 600, height: 500 });
  const state = await browser.observeBrowserUseTab(tabId, false);
  expect(state).toMatchObject({ tabId, url: 'https://example.com/', title: 'Example' });
  expect(state.elements[0]).toMatchObject({ ref: 'e1', role: 'button', name: 'Save' });
  await browser.clickBrowserUseRef(tabId, state.snapshotId, 'e1');
  await expect(browser.clickBrowserUseRef(tabId, state.snapshotId, 'e1')).rejects.toThrow(/STALE_BROWSER_STATE/);
  const evaluations = fake.contents.get(tabId)!.debugger.calls
    .filter(([method]: [string]) => method === 'Runtime.evaluate')
    .map(([, params]: [string, { expression: string }]) => params.expression);
  expect(evaluations.some((expression: string) => expression.includes("el.type !== 'password'"))).toBe(true);
  const cursor = evaluations.find((expression: string) => expression.includes('data-cos-browser-use-agent-cursor'))!;
  expect(cursor).toContain('pointer-events:none!important');
  expect(cursor).toContain('AI');
  expect(cursor).toContain('inset 0 0 0 3px #287cff');
  expect(cursor).toContain('requestAnimationFrame');
  const mouseMoves = fake.contents.get(tabId)!.debugger.calls
    .filter(([method, params]: [string, { type?: string }]) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved');
  expect(mouseMoves.length).toBeGreaterThanOrEqual(6);
  expect(mouseMoves.length).toBeLessThanOrEqual(14);
  expect(evaluations.some((expression: string) => expression.includes("badge.textContent = '✓'"))).toBe(true);
});

it('moves the pointer to a field before focusing and typing into it', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  await browser.showBrowserUsePanel({ x: 200, y: 80, width: 600, height: 500 });
  const state = await browser.observeBrowserUseTab(tabId, false);
  const contents = fake.contents.get(tabId)!;
  contents.debugger.calls.length = 0;

  await browser.beginBrowserUseAgentMission();
  await browser.typeBrowserUseRef(tabId, state.snapshotId, 'e1', 'hello');

  const calls = contents.debugger.calls as Array<[string, any]>;
  const firstMove = calls.findIndex(([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved');
  const focus = calls.findIndex(([method, params]) => method === 'Runtime.evaluate' && String(params.expression).includes('el.focus({ preventScroll: true })'));
  const insert = calls.findIndex(([method]) => method === 'Input.insertText');
  expect(firstMove).toBeGreaterThanOrEqual(0);
  expect(focus).toBeGreaterThan(firstMove);
  expect(insert).toBeGreaterThan(focus);
});

it('supports hover without clicking and scrolls from the cursor current position', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  await browser.showBrowserUsePanel({ x: 200, y: 80, width: 600, height: 500 });
  browser.beginBrowserUseAgentMission();
  const first = await browser.observeBrowserUseTab(tabId, false);
  const contents = fake.contents.get(tabId)!;
  contents.debugger.calls.length = 0;

  await browser.hoverBrowserUseRef(tabId, first.snapshotId, 'e1');
  const hoverCalls = contents.debugger.calls as Array<[string, any]>;
  expect(hoverCalls.some(([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved')).toBe(true);
  expect(hoverCalls.some(([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed')).toBe(false);

  const second = await browser.observeBrowserUseTab(tabId, false);
  contents.debugger.calls.length = 0;
  await browser.scrollBrowserUseTab(tabId, second.snapshotId, 240);
  const wheel = (contents.debugger.calls as Array<[string, any]>).find(
    ([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel'
  );
  expect(wheel?.[1]).toMatchObject({ x: 60, y: 44, deltaY: 240 });
});

it('keeps cursor position and mission visuals across same-origin navigation', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  await browser.showBrowserUsePanel({ x: 200, y: 80, width: 600, height: 500 });
  await browser.beginBrowserUseAgentMission();
  const state = await browser.observeBrowserUseTab(tabId, false);
  await browser.clickBrowserUseRef(tabId, state.snapshotId, 'e1');

  const contents = fake.contents.get(tabId)!;
  contents.debugger.calls.length = 0;
  await browser.navigateBrowserUseTab(tabId, 'https://example.com/next', 'agent');

  expect(browser.browserUseState().agentActive).toBe(true);
  await vi.waitFor(() => {
    const visualEvaluations = contents.debugger.calls
      .filter(([method]: [string]) => method === 'Runtime.evaluate')
      .map(([, params]: [string, { expression: string }]) => params.expression)
      .filter((expression: string) => expression.includes('data-cos-browser-use-agent-cursor'));
    expect(visualEvaluations.length).toBeGreaterThan(0);
  });
  await browser.finishBrowserUseAgentMission({ graceMs: 0 });
  expect(browser.browserUseState().agentActive).toBe(false);
});

it('reuses one isolated execution context across actions until navigation changes the document', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;
  const contents = fake.contents.get(tabId)!;
  const state = await browser.observeBrowserUseTab(tabId, false);
  await browser.typeBrowserUseRef(tabId, state.snapshotId, 'e1', 'hello');
  const createsBeforeNavigation = contents.debugger.calls.filter(([method]: [string]) => method === 'Page.createIsolatedWorld').length;
  expect(createsBeforeNavigation).toBe(1);

  await browser.navigateBrowserUseTab(tabId, 'https://example.com/next', 'user');
  await browser.observeBrowserUseTab(tabId, false);
  const createsAfterNavigation = contents.debugger.calls.filter(([method]: [string]) => method === 'Page.createIsolatedWorld').length;
  expect(createsAfterNavigation).toBe(2);
});

it('can refresh refs without collecting full page text for fast composed missions', async () => {
  await browser.ensureBrowserUseReady();
  const owner = new fake.FakeBrowserWindow();
  browser.attachBrowserUseWindow(owner as any);
  await browser.openBrowserUseTab('https://example.com/', 'user');
  const tabId = browser.browserUseState().activeTabId!;

  const compact = await browser.observeBrowserUseTab(tabId, false, false);
  expect(compact.text).toBe('');
  expect(compact.elements[0]).toMatchObject({ ref: 'e1', role: 'button', name: 'Save' });

  const evaluation = fake.contents.get(tabId)!.debugger.calls
    .filter(([method]: [string]) => method === 'Runtime.evaluate')
    .map(([, params]: [string, { expression: string }]) => params.expression)
    .find((expression: string) => expression.includes('const maxElements'))!;
  expect(evaluation).toContain("text: '', elements");
  expect(evaluation).not.toContain("document.body?.innerText || '').replace");
});

it('is a vertical subsystem and has no dependency on Internal Chromium, bridge or recorder ownership', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'browser-use.ts'), 'utf8');
  expect(source).toContain("const PARTITION = 'persist:cos-web'");
  expect(source).not.toMatch(/from ['"].*internal-browser/);
  expect(source).not.toMatch(/from ['"].*bridge/);
  expect(source).not.toMatch(/from ['"].*session\/recorder/);
  const internalPath = path.join(process.cwd(), 'src', 'main', 'internal-browser.ts');
  const internal = await fs.readFile(internalPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (internal !== null) {
    expect(internal).not.toContain('browser-use');
    expect(internal).toContain("const PARTITION = 'persist:cos-browser'");
  }
});
