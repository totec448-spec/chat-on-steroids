import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserPanel } from '../src/renderer/browser-panel.js';
import type { BrowserUseBounds, BrowserUseRequest, BrowserUseState } from '../src/shared/browser-use.js';

let dom: JSDOM;
let host: HTMLElement;
let toggle: HTMLButtonElement;
let stateListener: ((state: BrowserUseState) => void) | null;
let showListener: (() => void) | null;
let state: BrowserUseState;
let browserUseLayout: ReturnType<typeof vi.fn>;
let browserUseLayoutSync: ReturnType<typeof vi.fn>;

const tick = async (): Promise<void> => {
  await Promise.resolve(); await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
};

beforeEach(() => {
  dom = new JSDOM('<body><section id="host"></section><button id="toggle"></button></body>', {
    url: 'https://cos.local/', pretendToBeVisual: true
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLButtonElement', dom.window.HTMLButtonElement);
  vi.stubGlobal('HTMLFormElement', dom.window.HTMLFormElement);
  vi.stubGlobal('ResizeObserver', undefined);
  host = document.getElementById('host')!;
  toggle = document.getElementById('toggle') as HTMLButtonElement;
  stateListener = null; showListener = null;
  state = { open: false, ready: false, agentActive: false, activeTabId: null, tabs: [], permission: null };

  const browserUse = vi.fn(async (request: BrowserUseRequest) => {
    if (request.action === 'query') return { ok: true as const, data: state };
    if (request.action === 'show') state = { ...state, open: true, ready: true };
    if (request.action === 'hide') state = { ...state, open: false };
    if (request.action === 'create') {
      state = { ...state, open: true, ready: true, activeTabId: 11, tabs: [{
        id: 11, active: true, loading: false, title: 'New tab', url: 'about:blank', canGoBack: false, canGoForward: false
      }] };
    }
    if (request.action === 'navigate') {
      state = { ...state, tabs: state.tabs.map(tab => tab.id === request.tabId ? { ...tab, url: 'https://example.com/', title: 'Example' } : tab) };
    }
    if (request.action === 'approve') state = { ...state, permission: null };
    return { ok: true as const, data: state };
  });
  browserUseLayout = vi.fn();
  browserUseLayoutSync = vi.fn(() => true);
  Object.assign(dom.window, {
    api: {
      browserUse,
      browserUseLayout,
      browserUseLayoutSync,
      onBrowserUseShowRequested: vi.fn((listener: () => void) => { showListener = listener; return () => undefined; }),
      onBrowserUseStateChanged: vi.fn((listener: (next: BrowserUseState) => void) => { stateListener = listener; return () => undefined; })
    }
  });
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

it('uses the existing work-panel slot and sends only the page surface rectangle to main', async () => {
  const onShow = vi.fn();
  createBrowserPanel({ host, toggle, onShow });
  await tick();
  expect(host.querySelector('.browser-use-header')).toBeNull();
  const tabBar = host.querySelector<HTMLElement>('.browser-use-tabbar')!;
  const tabs = tabBar.querySelector<HTMLElement>('.browser-use-tabs')!;
  const add = tabBar.querySelector<HTMLButtonElement>('.browser-use-add')!;
  expect(add).not.toBeNull();
  expect(tabs.contains(add)).toBe(false);
  expect(host.querySelector('.browser-use-nav .browser-use-add')).toBeNull();
  const resize = host.querySelector('.browser-use-panel .work-panel-resize')!;
  expect(resize.classList.contains('is-native-boundary')).toBe(true);
  expect(resize.querySelector('.work-panel-resize-rail')).not.toBeNull();
  const surface = host.querySelector<HTMLElement>('.browser-use-surface')!;
  surface.getBoundingClientRect = () => ({ x: 400, y: 120, width: 600, height: 700, top: 120, left: 400, right: 1000, bottom: 820, toJSON: () => ({}) });

  toggle.click(); await tick();
  expect(onShow).toHaveBeenCalledTimes(1);
  expect(host.classList.contains('has-browser-panel')).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect((window.api.browserUse as any)).toHaveBeenCalledWith({ action: 'show', bounds: { x: 400, y: 120, width: 600, height: 700 } });

  host.querySelector<HTMLButtonElement>('.browser-use-close')!.click(); await tick();
  expect(host.classList.contains('has-browser-panel')).toBe(false);
  expect((window.api.browserUse as any)).toHaveBeenCalledWith({ action: 'hide' });
});

it('renders exact tab state and navigates the selected Browser Use tab from its own address bar', async () => {
  createBrowserPanel({ host, toggle }); await tick();
  const next: BrowserUseState = { open: true, ready: true, agentActive: false, activeTabId: 7, permission: null, tabs: [{
    id: 7, active: true, loading: false, title: 'Docs', url: 'https://docs.example/', canGoBack: true, canGoForward: false
  }] };
  state = next; stateListener?.(next); await tick();

  expect(host.querySelector('[data-browser-tab-id="7"]')?.textContent).toContain('Docs');
  expect(host.querySelector<HTMLInputElement>('.browser-use-address')?.value).toBe('https://docs.example/');
  expect(host.querySelector<HTMLButtonElement>('.browser-use-nav button')?.disabled).toBe(false);

  const address = host.querySelector<HTMLInputElement>('.browser-use-address')!;
  address.value = 'example.com';
  address.closest('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  expect((window.api.browserUse as any)).toHaveBeenCalledWith({ action: 'navigate', tabId: 7, url: 'example.com' });
});

it('shows a pending origin approval in-app and forwards only the exact permission id', async () => {
  createBrowserPanel({ host, toggle }); await tick();
  const permission = { id: '11111111-1111-4111-8111-111111111111', origin: 'https://example.com', url: 'https://example.com/private' };
  const next: BrowserUseState = { open: true, ready: true, agentActive: false, activeTabId: null, tabs: [], permission };
  stateListener?.(next); await tick();

  const banner = host.querySelector<HTMLElement>('.browser-use-permission')!;
  expect(banner.hidden).toBe(false);
  expect(banner.textContent).toContain('https://example.com');
  const always = [...banner.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Always allow')!;
  always.click(); await tick();
  expect((window.api.browserUse as any)).toHaveBeenCalledWith({ action: 'approve', id: permission.id, decision: 'always' });
});

it('opens the same panel when an agent tool asks for Browser Use presentation', async () => {
  createBrowserPanel({ host, toggle }); await tick();
  const surface = host.querySelector<HTMLElement>('.browser-use-surface')!;
  surface.getBoundingClientRect = () => ({ x: 300, y: 90, width: 500, height: 600, top: 90, left: 300, right: 800, bottom: 690, toJSON: () => ({}) });
  showListener?.(); await tick();
  expect(host.classList.contains('has-browser-panel')).toBe(true);
  expect((window.api.browserUse as any)).toHaveBeenCalledWith({ action: 'show', bounds: { x: 300, y: 90, width: 500, height: 600 } });
});

it('shows the Browser Use driving glow without changing the native viewport geometry', async () => {
  createBrowserPanel({ host, toggle }); await tick();
  const pane = host.querySelector<HTMLElement>('.browser-use-panel')!;
  const surface = host.querySelector<HTMLElement>('.browser-use-surface')!;
  surface.getBoundingClientRect = () => ({ x: 100, y: 50, width: 400, height: 300, top: 50, left: 100, right: 500, bottom: 350, toJSON: () => ({}) });
  toggle.click(); await tick();
  expect(pane.classList.contains('is-agent-active')).toBe(false);
  browserUseLayout.mockClear();

  stateListener?.({ ...state, agentActive: true }); await tick();
  expect(pane.classList.contains('is-agent-active')).toBe(true);
  expect(browserUseLayout).not.toHaveBeenCalled();

  stateListener?.({ ...state, agentActive: false }); await tick();
  expect(pane.classList.contains('is-agent-active')).toBe(false);
  expect(browserUseLayout).not.toHaveBeenCalled();
});

it('pushes native Browser Use bounds from the same pointer move that resizes the work slot', async () => {
  createBrowserPanel({ host, toggle }); await tick();
  const surface = host.querySelector<HTMLElement>('.browser-use-surface')!;
  surface.getBoundingClientRect = () => {
    const width = Number.parseFloat(host.style.getPropertyValue('--work-panel-width')) || 400;
    return { x: 1000 - width, y: 50, width, height: 500, top: 50, left: 1000 - width, right: 1000, bottom: 550, toJSON: () => ({}) };
  };
  toggle.click(); await tick();
  browserUseLayout.mockClear();
  browserUseLayoutSync.mockClear();

  const handle = host.querySelector<HTMLElement>('.browser-use-panel .work-panel-resize')!;
  Object.assign(handle, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn()
  });
  const pointer = (type: string, x: number) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    return event;
  };
  handle.dispatchEvent(pointer('pointerdown', 600));
  handle.dispatchEvent(pointer('pointermove', 560));

  expect(browserUseLayout).not.toHaveBeenCalled();
  expect(browserUseLayoutSync).toHaveBeenCalledTimes(1);
  const immediate = browserUseLayoutSync.mock.calls[0]![0] as BrowserUseBounds;
  expect(immediate.width).toBe(Number.parseFloat(host.style.getPropertyValue('--work-panel-width')));
  expect(immediate.x + immediate.width).toBe(1000);
});

it('falls back to ordinary layout reconciliation if the synchronous drag transaction is refused', async () => {
  createBrowserPanel({ host, toggle }); await tick();
  const surface = host.querySelector<HTMLElement>('.browser-use-surface')!;
  surface.getBoundingClientRect = () => {
    const width = Number.parseFloat(host.style.getPropertyValue('--work-panel-width')) || 400;
    return { x: 1000 - width, y: 50, width, height: 500, top: 50, left: 1000 - width, right: 1000, bottom: 550, toJSON: () => ({}) };
  };
  toggle.click(); await tick();
  browserUseLayout.mockClear();
  browserUseLayoutSync.mockClear();
  browserUseLayoutSync.mockReturnValueOnce(false);

  const handle = host.querySelector<HTMLElement>('.browser-use-panel .work-panel-resize')!;
  Object.assign(handle, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn()
  });
  const pointer = (type: string, x: number) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
    Object.defineProperty(event, 'pointerId', { value: 9 });
    return event;
  };
  handle.dispatchEvent(pointer('pointerdown', 600));
  handle.dispatchEvent(pointer('pointermove', 540));
  await tick();

  expect(browserUseLayoutSync).toHaveBeenCalledTimes(1);
  expect(browserUseLayout).toHaveBeenCalledWith(browserUseLayoutSync.mock.calls[0]![0]);
});
