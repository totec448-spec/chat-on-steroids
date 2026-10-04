import { EventEmitter } from 'node:events';
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
  return { panels, WebContentsView, open: vi.fn(async () => 'edge'),
    icon: vi.fn(async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AA==' })) };
});
vi.mock('electron', () => ({ BaseWindow: class {}, BrowserWindow: class {}, WebContentsView: native.WebContentsView,
  app: { getFileIcon: native.icon }, session: {}, shell: {} }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { chatBrowser: 'cos', language: 'pt-BR' } }) }));
vi.mock('../src/main/browser.js', () => ({
  installedSignInBrowsers: () => [{ browser: 'chrome', executable: 'chrome.exe' }, { browser: 'edge', executable: 'msedge.exe' }],
  openBrowserSignIn: native.open, EXTERNAL_BROWSER_LABELS: { chrome: 'Chrome', edge: 'Edge', brave: 'Brave' }
}));
const { CosBrowser } = await import('../src/main/cos-browser/host.js');
const { cosSignInTransfer } = await import('../src/main/cos-browser/sign-in-transfer.js');
const { cosBrowserSignedIn, setCosBrowserSignedIn, onCosBrowserSignInChange } = await import('../src/main/cos-browser/sign-in.js');

afterEach(() => {
  cosSignInTransfer.cancel();
  native.open.mockReset();
  native.open.mockImplementation(async () => 'edge');
  native.panels.length = 0;
  setCosBrowserSignedIn(null);
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
