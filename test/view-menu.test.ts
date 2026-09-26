import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  let nextId = 700;
  const views: any[] = [];
  const ipcOn = new Map<string, Listener>();

  class FakeWebContents {
    id = nextId++;
    destroyed = false;
    listeners = new Map<string, Set<Listener>>();
    send = vi.fn();
    setZoomFactor = vi.fn();
    focus = vi.fn();
    setWindowOpenHandler = vi.fn();
    loadFile = vi.fn(async () => undefined);
    loadURL = vi.fn(async () => undefined);
    executeJavaScript = vi.fn(async () => undefined);
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
    isDestroyed(): boolean { return this.destroyed; }
    close(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('destroyed');
    }
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
    closed: (() => void) | null = null;
    webListeners = new Map<string, Set<Listener>>();
    webContents = {
      send: vi.fn(),
      getZoomFactor: vi.fn(() => 0.975),
      on: vi.fn((name: string, listener: Listener) => {
        const bucket = this.webListeners.get(name) ?? new Set<Listener>();
        bucket.add(listener);
        this.webListeners.set(name, bucket);
      }),
      off: vi.fn((name: string, listener: Listener) => {
        this.webListeners.get(name)?.delete(listener);
      }),
      emit: (name: string, ...args: any[]): void => {
        for (const listener of [...(this.webListeners.get(name) ?? [])]) listener(...args);
      }
    };
    contentView = {
      children: [] as any[],
      addChildView: vi.fn((view: any) => { if (!this.contentView.children.includes(view)) this.contentView.children.push(view); }),
      removeChildView: vi.fn((view: any) => { this.contentView.children = this.contentView.children.filter(child => child !== view); })
    };
    getContentBounds = vi.fn(() => ({ x: 0, y: 0, width: 640, height: 480 }));
    isDestroyed(): boolean { return this.destroyed; }
    once(name: string, listener: () => void): void { if (name === 'closed') this.closed = listener; }
  }

  return {
    views,
    ipcOn,
    FakeWebContentsView,
    FakeBrowserWindow,
    reset(): void { views.length = 0; }
  };
});

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeBrowserWindow,
  WebContentsView: fake.FakeWebContentsView,
  ipcMain: { on: vi.fn((channel: string, listener: (...args: any[]) => void) => fake.ipcOn.set(channel, listener)) }
}));

const menu = await import('../src/main/view-menu.js');

function snapshot() {
  return {
    petVisible: false,
    petReady: true,
    sidebarCollapsed: false,
    zoomPercent: 100,
    theme: 'dark' as const,
    language: 'en' as const,
    appearance: {
      light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
      dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
      font: 'system' as const,
      fontSize: 14,
      translucentSidebar: true
    },
    labels: {
      pet: 'Desktop pets',
      sidebar: 'Toggle Sidebar',
      zoomIn: 'Zoom In',
      zoomOut: 'Zoom Out',
      actualSize: 'Actual Size'
    }
  };
}

afterEach(async () => {
  await menu.shutdownViewMenu();
  fake.reset();
});

it('starts with Pets and exposes no Internal Chromium browser command', () => {
  const html = readFileSync(new URL('../src/renderer/view-menu.html', import.meta.url), 'utf8');
  const document = new JSDOM(html).window.document;
  expect([...document.querySelectorAll<HTMLButtonElement>('[data-command]')].map(button => button.dataset.command))
    .toEqual(['pet', 'sidebar', 'zoom-in', 'zoom-out', 'zoom-reset']);
  expect(document.getElementById('viewBrowser')).toBeNull();
  expect(document.querySelector('#viewPet .ph-paw-print')).not.toBeNull();
  expect(document.querySelector('#viewSidebar .ph-sidebar-simple')).not.toBeNull();
  expect(document.querySelector('#viewZoomIn .ph-magnifying-glass-plus')).not.toBeNull();
  expect(document.querySelector('#viewZoomOut .ph-magnifying-glass-minus')).not.toBeNull();
  expect(document.querySelector('#viewActualSize .ph-corners-out')).not.toBeNull();
  expect(document.querySelectorAll('.menu-check.ph-check')).toHaveLength(2);
  expect(document.querySelector('.view-menu-surface svg')).toBeNull();
});

it('renders as the last native child and remains inside the owner window', async () => {
  const owner = new fake.FakeBrowserWindow() as any;
  menu.attachViewMenuWindow(owner);
  const state = await menu.toggleViewMenu({
    anchor: { x: 630, y: 470, width: 30, height: 28 },
    snapshot: snapshot()
  });
  expect(state.open).toBe(true);
  const view = fake.views.at(-1)!;
  expect(owner.contentView.addChildView).toHaveBeenCalledWith(view);
  expect(view.webContents.setZoomFactor).toHaveBeenCalledWith(0.975);
  const bounds = view.setBounds.mock.calls.at(-1)![0];
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(632);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(472);
  expect(view.webContents.send).toHaveBeenCalledWith('viewMenu:snapshot', snapshot());
  expect(view.setVisible).toHaveBeenLastCalledWith(true);
});

it('prewarms the hidden renderer so the first toggle only attaches and reveals it', async () => {
  const owner = new fake.FakeBrowserWindow() as any;
  menu.attachViewMenuWindow(owner);

  await menu.prewarmViewMenu();
  const view = fake.views.at(-1)!;
  expect(fake.views).toHaveLength(1);
  expect(view.webContents.loadFile).toHaveBeenCalledOnce();
  expect(view.webContents.executeJavaScript).toHaveBeenCalledOnce();
  expect(view.webContents.executeJavaScript).toHaveBeenCalledWith('document.fonts.ready');
  expect(view.webContents.executeJavaScript.mock.calls[0]?.[0]).not.toContain('requestAnimationFrame');
  expect(view.setVisible).toHaveBeenLastCalledWith(false);
  expect(owner.contentView.addChildView).not.toHaveBeenCalled();

  expect(await menu.toggleViewMenu({
    anchor: { x: 40, y: 0, width: 30, height: 28 },
    snapshot: snapshot()
  })).toEqual({ open: true });
  expect(fake.views).toHaveLength(1);
  expect(view.webContents.loadFile).toHaveBeenCalledOnce();
  expect(view.webContents.executeJavaScript).toHaveBeenCalledOnce();
  expect(owner.contentView.addChildView).toHaveBeenCalledOnce();
  expect(view.setVisible).toHaveBeenLastCalledWith(true);
});

it('closes on a second toggle instead of reopening or reattaching', async () => {
  const owner = new fake.FakeBrowserWindow() as any;
  menu.attachViewMenuWindow(owner);
  const request = { anchor: { x: 40, y: 0, width: 30, height: 28 }, snapshot: snapshot() };

  expect(await menu.toggleViewMenu(request)).toEqual({ open: true });
  const view = fake.views.at(-1)!;
  expect(await menu.toggleViewMenu(request)).toEqual({ open: false });
  expect(menu.viewMenuState()).toEqual({ open: false });
  expect(owner.contentView.addChildView).toHaveBeenCalledTimes(1);
  expect(view.setVisible).toHaveBeenLastCalledWith(false);
});

it('accepts only its own narrow preload and rejects the Internal Chromium browser command', async () => {
  const owner = new fake.FakeBrowserWindow() as any;
  menu.attachViewMenuWindow(owner);
  await menu.toggleViewMenu({ anchor: { x: 40, y: 0, width: 30, height: 28 }, snapshot: snapshot() });
  const view = fake.views.at(-1)!;
  const command = fake.ipcOn.get('viewMenu:command')!;

  command({ sender: { id: view.webContents.id + 1 } }, 'pet');
  command({ sender: { id: view.webContents.id } }, 'browser');
  expect(owner.webContents.send).not.toHaveBeenCalledWith('viewMenu:command', 'pet');
  expect(owner.webContents.send).not.toHaveBeenCalledWith('viewMenu:command', 'browser');

  command({ sender: { id: view.webContents.id } }, 'pet');
  expect(owner.webContents.send).toHaveBeenCalledWith('viewMenu:command', 'pet');
  expect(view.setVisible).toHaveBeenLastCalledWith(false);
});

it('closes when focus moves to another native surface', async () => {
  const owner = new fake.FakeBrowserWindow() as any;
  menu.attachViewMenuWindow(owner);
  await menu.toggleViewMenu({ anchor: { x: 40, y: 0, width: 30, height: 28 }, snapshot: snapshot() });
  const view = fake.views.at(-1)!;
  view.webContents.emit('blur');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(menu.viewMenuState()).toEqual({ open: false });
  expect(view.setVisible).toHaveBeenLastCalledWith(false);
  expect(owner.webContents.send).toHaveBeenCalledWith('viewMenu:openChanged', false);
});

it('consumes the owner trigger press after native blur so the same click cannot reopen it', async () => {
  const owner = new fake.FakeBrowserWindow() as any;
  menu.attachViewMenuWindow(owner);
  await menu.toggleViewMenu({ anchor: { x: 40, y: 0, width: 30, height: 28 }, snapshot: snapshot() });
  const view = fake.views.at(-1)!;
  const down = { preventDefault: vi.fn() };
  const up = { preventDefault: vi.fn() };

  // Native focus moves first. The generic blur close is deferred until the current input gesture
  // finishes, allowing the owner WebContents to identify that the pointer is on the same trigger.
  view.webContents.emit('blur');
  owner.webContents.emit('before-mouse-event', down, {
    type: 'mouseDown', button: 'left', x: 50, y: 10, globalX: 50, globalY: 10
  });
  expect(down.preventDefault).toHaveBeenCalledOnce();
  expect(menu.viewMenuState()).toEqual({ open: false });

  owner.webContents.emit('before-mouse-event', up, {
    type: 'mouseUp', button: 'left', x: 50, y: 10, globalX: 50, globalY: 10
  });
  expect(up.preventDefault).toHaveBeenCalledOnce();
  expect(owner.webContents.send).toHaveBeenCalledWith('viewMenu:openChanged', false);
});

it('does not let a missing trigger mouse-up suppress a later click elsewhere', async () => {
  const owner = new fake.FakeBrowserWindow() as any;
  menu.attachViewMenuWindow(owner);
  await menu.toggleViewMenu({ anchor: { x: 40, y: 0, width: 30, height: 28 }, snapshot: snapshot() });
  const triggerDown = { preventDefault: vi.fn() };
  const laterDown = { preventDefault: vi.fn() };
  const laterUp = { preventDefault: vi.fn() };

  owner.webContents.emit('before-mouse-event', triggerDown, {
    type: 'mouseDown', button: 'left', x: 50, y: 10, globalX: 50, globalY: 10
  });
  expect(triggerDown.preventDefault).toHaveBeenCalledOnce();
  expect(menu.viewMenuState()).toEqual({ open: false });

  // Model a lost matching mouse-up. The next new gesture must clear the stale suppression first,
  // so neither half of that unrelated click is swallowed by the native menu owner.
  owner.webContents.emit('before-mouse-event', laterDown, {
    type: 'mouseDown', button: 'left', x: 300, y: 200, globalX: 300, globalY: 200
  });
  owner.webContents.emit('before-mouse-event', laterUp, {
    type: 'mouseUp', button: 'left', x: 300, y: 200, globalX: 300, globalY: 200
  });
  expect(laterDown.preventDefault).not.toHaveBeenCalled();
  expect(laterUp.preventDefault).not.toHaveBeenCalled();
});
