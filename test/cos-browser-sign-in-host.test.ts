import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  const fakeContents = () => Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(), loadURL: vi.fn(async () => {}), loadFile: vi.fn(async () => {}), send: vi.fn(),
    focus: vi.fn(), close: vi.fn(), isDestroyed: () => false
  });
  const panels: Array<{ webContents: ReturnType<typeof fakeContents> }> = [];
  class WebContentsView {
    webContents = fakeContents();
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor() { panels.push(this); }
  }
  const swSession = {
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    registerPreloadScript: vi.fn(),
    clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    clearCodeCaches: vi.fn(async () => undefined),
    cookies: { get: vi.fn(async () => []), on: vi.fn() },
    serviceWorkers: {
      on: vi.fn(),
      getAllRunning: () => ({}),
      getWorkerFromVersionID: () => undefined,
      startWorkerForScope: vi.fn(async () => undefined)
    },
    extensions: {
      loadExtension: vi.fn(async () => ({ id: 'ext-cos-123', version: '2.1.53' })),
      removeExtension: vi.fn()
    }
  };
  return {
    panels, WebContentsView, open: vi.fn(async () => 'edge'),
    userDataDir: '', extDir: '', swSession,
    icon: vi.fn(async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AA==' })),
    thumbnail: vi.fn(async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AA==' }))
  };
});
vi.mock('electron', () => ({ BaseWindow: class {}, BrowserWindow: class {}, WebContentsView: native.WebContentsView, nativeTheme: { shouldUseDarkColors: false },
  app: { getFileIcon: native.icon, getPath: () => native.userDataDir, once: vi.fn(), userAgentFallback: 'Chrome/130' },
  nativeImage: { createThumbnailFromPath: native.thumbnail },
  session: { fromPartition: vi.fn(() => native.swSession) },
  shell: {} }));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => native.extDir || null }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { chatBrowser: 'cos', language: 'pt-BR' } }) }));
vi.mock('../src/main/browser.js', () => ({
  installedSignInBrowsers: () => process.platform === 'darwin'
    ? [{ browser: 'chrome', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { browser: 'edge', executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' }]
    : [{ browser: 'chrome', executable: 'chrome.exe' }, { browser: 'edge', executable: 'msedge.exe' }],
  openBrowserSignIn: native.open, EXTERNAL_BROWSER_LABELS: { chrome: 'Chrome', edge: 'Edge', brave: 'Brave' }
}));
const { CosBrowser, browserIcon } = await import('../src/main/cos-browser/host.js');
const { cosSignInTransfer } = await import('../src/main/cos-browser/sign-in-transfer.js');
const { cosBrowserSignedIn, setCosBrowserSignedIn, onCosBrowserSignInChange } = await import('../src/main/cos-browser/sign-in.js');

afterEach(() => {
  cosSignInTransfer.cancel();
  native.open.mockReset();
  native.open.mockImplementation(async () => 'edge');
  native.panels.length = 0;
  native.icon.mockClear();
  native.thumbnail.mockClear();
  setCosBrowserSignedIn(null);
});

it('takes a browser\'s icon from its app bundle on macOS, where the file icon call ends the app', async () => {
  // macOS 27: app.getFileIcon traps on a worker thread and the whole app quits (any path).
  await browserIcon('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'darwin');
  expect(native.thumbnail).toHaveBeenCalledWith('/Applications/Google Chrome.app', { width: 64, height: 64 });
  await browserIcon('/Users/someone/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'darwin');
  expect(native.thumbnail).toHaveBeenLastCalledWith('/Users/someone/Applications/Brave Browser.app', { width: 64, height: 64 });
  await expect(browserIcon('/usr/local/bin/chromium', 'darwin')).rejects.toThrow('not inside an app bundle');
  expect(native.icon).not.toHaveBeenCalled();
  // Elsewhere the file icon stays: it is what the taskbar shows.
  await browserIcon('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'win32');
  expect(native.icon).toHaveBeenCalledWith('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', { size: 'large' });
  expect(native.thumbnail).toHaveBeenCalledTimes(2);
});

function browserFixture(url = 'https://auth.openai.com/log-in') {
  const host = new CosBrowser({ preloadDir: 'unused', rendererUrl: () => null, rendererDir: 'unused' }) as any;
  const windowId = host.model.createWindow({ type: 'normal', state: 'normal' });
  const base = {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }),
    isDestroyed: () => false, isMinimized: () => false, isMaximized: () => false, isFocused: () => false, isVisible: () => true,
    show: vi.fn(), showInactive: vi.fn(), focus: vi.fn(), restore: vi.fn(), setTitle: vi.fn(), destroy: vi.fn()
  };
  host.frames.set(windowId, { id: windowId, base, toolbar: { setBounds: vi.fn(), webContents: { isDestroyed: () => true, close: vi.fn() } }, shown: false, overlay: '' });
  const contents = Object.assign(new EventEmitter(), { id: 41, isDestroyed: (): boolean => false,
    debugger: Object.assign(new EventEmitter(), { isAttached: () => false }),
    loadURL: vi.fn(async () => {}), setWindowOpenHandler: vi.fn(), focus: vi.fn(), getURL: () => url });
  host.ses = { cookies: {} };
  host.views.set(contents.id, { webContents: contents, setBounds: vi.fn(), setVisible: vi.fn() });
  host.model.addTab(contents.id, windowId, { url, active: true });
  return { host, contents, base };
}

/** The last state the panel page was sent. */
const panelState = (panel = native.panels.at(-1)!) => panel.webContents.send.mock.calls.at(-1)?.[1];
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it('covers the Google tab with one CoS panel and opens only the browser the person chose', async () => {
  const { host, contents, base } = browserFixture();
  host.wire(contents);
  const event = { preventDefault: vi.fn(), isMainFrame: true };
  contents.emit('will-redirect', event, 'https://accounts.google.com/v3/signin/identifier');
  contents.emit('will-navigate', event, 'https://accounts.google.com/v3/signin/identifier');
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(native.panels).toHaveLength(1);
  const [panel] = native.panels;
  expect(base.contentView.addChildView).toHaveBeenCalledWith(panel);
  expect(panel!.webContents.loadFile).toHaveBeenCalledWith(expect.stringContaining('cos-browser-sign-in.html'));
  // Nothing opens, and no offer exists, until the person picks a browser.
  expect(native.open).not.toHaveBeenCalled();
  expect(cosSignInTransfer.pending()).toBeNull();
  await settle();
  expect(panelState()).toMatchObject({ phase: 'choose', language: 'pt-BR',
    browsers: [{ id: 'chrome', label: 'Chrome', icon: 'data:image/png;base64,AA==' }, { id: 'edge', label: 'Edge' }] });

  host.signInAction(contents, 'choose', 'edge');
  host.signInAction(panel!.webContents, 'choose', 'brave');
  expect(native.open).not.toHaveBeenCalled();
  host.signInAction(panel!.webContents, 'choose', 'edge');
  await settle();
  expect(native.open).toHaveBeenCalledExactlyOnceWith('edge');
  expect(cosSignInTransfer.pending()?.browser).toBe('edge');
  expect(panelState()).toMatchObject({ phase: 'waiting', browser: 'edge', launching: false, notice: null });

  // Opening again keeps the same offer; a later redirect finds the panel already open.
  const offer = cosSignInTransfer.pending()!.id;
  host.signInAction(panel!.webContents, 'reopen');
  await settle();
  expect(native.open).toHaveBeenCalledTimes(2);
  expect(cosSignInTransfer.pending()?.id).toBe(offer);
  contents.emit('will-redirect', event, 'https://accounts.google.com/');
  expect(native.panels).toHaveLength(1);
});

it('leaves lookalikes and iframe redirects alone and revokes the offer with its tab', async () => {
  const { host, contents } = browserFixture();
  host.wire(contents);
  const event = { preventDefault: vi.fn(), isMainFrame: false };
  contents.emit('will-redirect', event, 'https://accounts.google.com/');
  contents.emit('will-navigate', { ...event, isMainFrame: true }, 'https://accounts.google.com.evil.test/');
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(native.panels).toHaveLength(0);
  host.googleSignIn(contents);
  host.signInAction(native.panels[0]!.webContents, 'choose', 'chrome');
  await settle();
  expect(cosSignInTransfer.pending()).not.toBeNull();
  contents.emit('destroyed');
  expect(cosSignInTransfer.pending()).toBeNull();
  expect(native.panels[0]!.webContents.close).toHaveBeenCalled();
  expect(host.signIn).toBeNull();
});

it('returns to the choice when the browser cannot open or the offer is revoked, and closes once imported', async () => {
  const { host, contents } = browserFixture();
  host.googleSignIn(contents);
  const panel = native.panels[0]!;
  native.open.mockRejectedValueOnce(new Error('missing'));
  host.signInAction(panel.webContents, 'choose', 'chrome');
  await settle();
  expect(panelState()).toMatchObject({ phase: 'choose', notice: 'launch_failed' });
  expect(cosSignInTransfer.pending()).toBeNull();

  host.signInAction(panel.webContents, 'choose', 'chrome');
  await settle();
  cosSignInTransfer.cancel();
  expect(panelState()).toMatchObject({ phase: 'choose', notice: 'ended' });

  host.signInAction(panel.webContents, 'choose', 'edge');
  await settle();
  host.importSignIn = vi.fn(async () => {});
  const offer = cosSignInTransfer.pending()!;
  await cosSignInTransfer.accept(offer.id, 'browser-a', [{ name: '__Secure-next-auth.session-token', value: 'synthetic',
    domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax' }]);
  // The card confirms the sign-in, then plays its exit before its view goes.
  expect(panelState()).toMatchObject({ phase: 'done' });
  expect(cosSignInTransfer.pending()).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 1200));
  expect(host.signIn).toBeNull();
  expect(panel.webContents.send).toHaveBeenCalledWith('cos-browser-sign-in:leave');
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(panel.webContents.close).toHaveBeenCalled();
  // The receipt survives the panel: a retried POST of the same transfer still succeeds.
  await expect(cosSignInTransfer.accept(offer.id, 'browser-a', [])).resolves.toBeUndefined();
});

it('puts ChatGPT login back under the card, and cancelling leaves it there', async () => {
  const { host, contents } = browserFixture('');
  host.googleSignIn(contents);
  expect(contents.loadURL).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com/auth/login');
  host.signInAction(native.panels[0]!.webContents, 'choose', 'edge');
  await settle();
  host.signInAction(native.panels[0]!.webContents, 'cancel');
  expect(cosSignInTransfer.pending()).toBeNull();
  expect(host.signIn).toBeNull();
  expect(contents.loadURL).toHaveBeenCalledTimes(1);
});

const cookie = (index: number, value: string) => ({ name: `__Secure-next-auth.session-token.${index}`, value,
  domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax' });

function cookieFixture() {
  const { host, contents } = browserFixture();
  const old = [cookie(0, 'synthetic-old-0'), cookie(1, 'synthetic-old-1')];
  const jar = new Map(old.map(cookie => [cookie.name, cookie]));
  const api = {
    get: vi.fn(async () => [...jar.values()]),
    remove: vi.fn(async (_url: string, name: string) => { jar.delete(name); }),
    set: vi.fn(async (input: any) => { jar.set(input.name, input); void host.readSignIn(host.ses); }),
    flushStore: vi.fn(async () => {})
  };
  host.ses.cookies = api;
  return { host, contents, api, jar, old };
}

it('replaces old chunks, flushes and reads them back before loading ChatGPT, with no partial sign-in publication', async () => {
  const { host, contents, api, jar } = cookieFixture();
  setCosBrowserSignedIn(false);
  const observed: Array<boolean | null> = [];
  const off = onCosBrowserSignInChange(() => observed.push(cosBrowserSignedIn()));
  try {
    await host.importSignIn(host.ses, contents, [cookie(0, 'synthetic-new-0')], () => true);
    expect([...jar.values()].map(cookie => cookie.value)).toEqual(['synthetic-new-0']);
    expect(api.flushStore).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([true]);
    expect(contents.loadURL).toHaveBeenCalledWith('https://chatgpt.com/');
  } finally { off(); }
});

it('restores the previous token if writing a chunk fails, and refuses transfers during live work', async () => {
  const { host, contents, api, jar, old } = cookieFixture();
  api.set.mockImplementation(async input => {
    if (input.value === 'synthetic-new-1') throw new Error('Synthetic cookie write failure');
    jar.set(input.name, input);
  });
  await expect(host.importSignIn(host.ses, contents,
    [cookie(0, 'synthetic-new-0'), cookie(1, 'synthetic-new-1')], () => true)).rejects.toThrow('Synthetic cookie write failure');
  expect([...jar.values()].map(cookie => cookie.value)).toEqual(old.map(cookie => cookie.value));
  expect(contents.loadURL).not.toHaveBeenCalled();
  api.get.mockClear();
  host.generating = new Set(['synthetic-running-chat']);
  await expect(host.importSignIn(host.ses, contents, [cookie(0, 'synthetic-new-0')], () => true)).rejects.toThrow('transfer_busy');
  expect(api.get).not.toHaveBeenCalled();
});

it('sends a signed-out sign-in click to ChatGPT login in the open ChatGPT tab, and only shows a signed-in browser', async () => {
  const { host, contents } = browserFixture('https://chatgpt.com/');
  host.startPromise = Promise.resolve();
  const navigate = vi.spyOn(host.control, 'navigate').mockImplementation(() => {});
  const show = vi.spyOn(host, 'show').mockResolvedValue(undefined);
  setCosBrowserSignedIn(false);
  await host.showSignIn();
  expect(navigate).toHaveBeenCalledExactlyOnceWith(contents.id, 'https://chatgpt.com/auth/login');
  setCosBrowserSignedIn(true);
  await host.showSignIn();
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(show).toHaveBeenCalledTimes(1);
});

it('tells its owner when the user puts a shown window away, never when the app hides it', () => {
  const onUserHide = vi.fn();
  const host = new CosBrowser({ preloadDir: 'unused', rendererUrl: () => null, rendererDir: 'unused', onUserHide }) as any;
  const windowId = host.model.createWindow({ type: 'normal', state: 'normal' });
  let visible = true;
  const base = { hide: vi.fn(() => { visible = false; }), isVisible: () => visible, isFocused: () => false };
  host.frames.set(windowId, { id: windowId, base, shown: true });
  // The extension or the app minimizing it is not the user closing it: no notice.
  host.hideWindow(windowId);
  expect(onUserHide).not.toHaveBeenCalled();
  // Closing a window already put away says nothing either.
  host.userHide(windowId);
  expect(onUserHide).not.toHaveBeenCalled();
  visible = true;
  host.frames.get(windowId).shown = true;
  host.userHide(windowId);
  expect(base.hide).toHaveBeenCalledTimes(2);
  expect(onUserHide).toHaveBeenCalledTimes(1);
});

it('keeps a window the user minimizes in the taskbar, and reports it minimized until restored (#1464)', () => {
  const onUserHide = vi.fn();
  const host = new CosBrowser({ preloadDir: 'unused', rendererUrl: () => null, rendererDir: 'unused', onUserHide }) as any;
  const windowId = host.model.createWindow({ type: 'normal', state: 'normal' });
  let maximized = false;
  const base = { hide: vi.fn(), isVisible: () => true, isFocused: () => false, isMaximized: () => maximized,
    isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) };
  host.frames.set(windowId, { id: windowId, base, toolbar: { setBounds: vi.fn() }, shown: true });
  host.userMinimize(windowId);
  // A minimized window stays where the user can restore it: not hidden, no "brought back from the tray" notice.
  expect(base.hide).not.toHaveBeenCalled();
  expect(onUserHide).not.toHaveBeenCalled();
  expect(host.frames.get(windowId).shown).toBe(true);
  expect(host.model.window(windowId)?.state).toBe('minimized');
  host.userRestore(windowId);
  expect(host.model.window(windowId)?.state).toBe('normal');
  maximized = true;
  host.userMinimize(windowId);
  host.userRestore(windowId);
  expect(host.model.window(windowId)?.state).toBe('maximized');
});

// The maintainer's idea (2026-10-14): let people choose where a minimized built-in browser goes.
it('hides a window the user minimizes to the tray when that is the chosen place, and keeps it in the taskbar otherwise', () => {
  let place: 'taskbar' | 'tray' = 'tray';
  const onUserHide = vi.fn();
  const host = new CosBrowser({ preloadDir: 'unused', rendererUrl: () => null, rendererDir: 'unused', onUserHide,
    minimizeTo: () => place }) as any;
  const windowId = host.model.createWindow({ type: 'normal', state: 'normal' });
  const base = { hide: vi.fn(), isVisible: () => true, isFocused: () => false, isMaximized: () => false,
    isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) };
  host.frames.set(windowId, { id: windowId, base, toolbar: { setBounds: vi.fn() }, shown: true });
  host.userMinimize(windowId);
  expect(base.hide).toHaveBeenCalledTimes(1);
  expect(onUserHide).toHaveBeenCalledTimes(1);
  expect(host.frames.get(windowId).shown).toBe(false);
  expect(host.model.window(windowId)?.state).toBe('minimized');

  place = 'taskbar';
  host.frames.get(windowId).shown = true;
  host.userMinimize(windowId);
  expect(base.hide).toHaveBeenCalledTimes(1);
  expect(host.frames.get(windowId).shown).toBe(true);
});

it('loads only web pages and the empty page into a tab, whatever the extension asks', () => {
  const { host, contents } = browserFixture('https://chatgpt.com/');
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'chrome://settings', 'not a url']) host.control.navigate(contents.id, url);
  expect(contents.loadURL).not.toHaveBeenCalled();
  host.control.navigate(contents.id, 'https://chatgpt.com/c/abc');
  host.control.navigate(contents.id, 'about:blank');
  expect((contents.loadURL.mock.calls as unknown as string[][]).map(call => call[0])).toEqual(['https://chatgpt.com/c/abc', 'about:blank']);
});

it('clears stale Service Worker script cache when extension scripts change while preserving storage', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cos-browser-sw-'));
  try {
    const userData = path.join(tmp, 'userData');
    const ext = path.join(tmp, 'extension');
    const swCache = path.join(userData, 'Partitions', 'cos-browser', 'Service Worker', 'ScriptCache');
    const extSettings = path.join(userData, 'Partitions', 'cos-browser', 'Local Extension Settings', 'ext-cos-123');
    mkdirSync(swCache, { recursive: true });
    mkdirSync(extSettings, { recursive: true });
    mkdirSync(path.join(ext, 'icons'), { recursive: true });
    writeFileSync(path.join(swCache, 'stale_0'), 'old-worker');
    writeFileSync(path.join(extSettings, '000003.log'), 'keep-settings');
    writeFileSync(path.join(ext, 'manifest.json'), '{"manifest_version":3,"version":"2.1.53"}');
    writeFileSync(path.join(ext, 'background.js'), '// v1');
    writeFileSync(path.join(ext, 'build-stamp.txt'), '111111111111\n');
    writeFileSync(path.join(ext, 'icons', 'icon32.png'), '');

    native.userDataDir = userData;
    native.extDir = ext;
    native.swSession.clearStorageData.mockClear();
    native.swSession.clearCache.mockClear();
    native.swSession.clearCodeCaches.mockClear();

    const first = new CosBrowser({ preloadDir: tmp, rendererUrl: () => null, rendererDir: tmp });
    await first.start();
    expect(existsSync(path.join(userData, 'Partitions', 'cos-browser', 'Service Worker'))).toBe(false);
    expect(existsSync(path.join(extSettings, '000003.log'))).toBe(true);
    expect(native.swSession.clearStorageData).toHaveBeenCalledWith({ storages: ['serviceworkers', 'cachestorage'] });
    expect(native.swSession.clearCache).toHaveBeenCalledTimes(1);
    expect(native.swSession.clearCodeCaches).toHaveBeenCalledTimes(1);
    first.stop();

    // Same scripts -> no repeat Service Worker cache clear.
    const second = new CosBrowser({ preloadDir: tmp, rendererUrl: () => null, rendererDir: tmp });
    await second.start();
    expect(native.swSession.clearStorageData).toHaveBeenCalledTimes(1);
    second.stop();

    // Script edits with unchanged manifest version -> clears cache again.
    writeFileSync(path.join(ext, 'background.js'), '// v2 with wantGemini');
    const third = new CosBrowser({ preloadDir: tmp, rendererUrl: () => null, rendererDir: tmp });
    await third.start();
    expect(native.swSession.clearStorageData).toHaveBeenCalledTimes(2);
    third.stop();
  } finally {
    native.userDataDir = '';
    native.extDir = '';
    rmSync(tmp, { recursive: true, force: true });
  }
});
