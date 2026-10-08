import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
afterEach(async () => {
  (await import('../src/renderer/row-menu.js')).closeRowMenu();
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(options: { cos: boolean }) {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', { platform: 'Win32' });
  const doc = dom.window.document;
  let pets = false, zoom = 100;
  const calls: string[] = [];
  const { initViewMenu } = await import('../src/renderer/view-menu.js');
  const menu = initViewMenu({
    search: () => calls.push('search'),
    cosBrowser: () => options.cos,
    showCosBrowser: () => calls.push('cos-browser'),
    pets: { toggle: () => { pets = !pets; calls.push('pets'); }, visible: () => pets },
    // As in the app: the zoom applies later (an IPC round trip), and then refreshes the menu.
    zoom: {
      step: async delta => { await Promise.resolve(); zoom += Math.round(delta * 100); menu.refresh(); },
      reset: async () => { await Promise.resolve(); zoom = 100; menu.refresh(); },
      percent: () => zoom
    }
  });
  const button = doc.getElementById('viewMenu') as HTMLButtonElement;
  const open = () => doc.querySelector<HTMLElement>('.row-menu');
  const items = () => [...open()?.querySelectorAll<HTMLButtonElement>('.row-menu-item') ?? []].map(item => [
    item.dataset.rowAction,
    item.querySelector('.row-menu-label')!.textContent,
    item.querySelector('.row-menu-shortcut')?.textContent ?? null
  ]);
  const item = (action: string) => doc.querySelector<HTMLButtonElement>(`.row-menu [data-row-action="${action}"]`)!;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { doc, menu, button, open, items, item, calls, settle, zoom: () => zoom };
}

it('opens one menu with each action, its icon and its shortcut, the CoS browser only when it is the ChatGPT browser', async () => {
  const view = await mount({ cos: false });
  expect(view.button.getAttribute('aria-haspopup')).toBe('menu');
  view.button.click();
  expect(view.button.getAttribute('aria-expanded')).toBe('true');
  // Not the sidebar: its own toggle sits right beside the menu's button.
  expect(view.items()).toEqual([
    ['search', 'Search chats', 'Ctrl+K'],
    ['pets', 'Show pets', null],
    ['zoom-in', 'Zoom in', 'Ctrl++'],
    ['zoom-out', 'Zoom out', 'Ctrl+−'],
    ['zoom-reset', 'Actual size', 'Ctrl+0']
  ]);
  // Every item draws its icon, and the groups are separated.
  expect(view.open()!.querySelectorAll('.row-menu-item > .ico').length).toBe(5);
  expect(view.open()!.querySelectorAll('.row-menu-separator').length).toBe(2);
  // The same button closes it.
  view.button.click();
  expect(view.open()).toBeNull();
  expect(view.button.getAttribute('aria-expanded')).toBe('false');

  const cos = await mount({ cos: true });
  cos.button.click();
  expect(cos.items().map(([action]) => action)).toEqual(['search', 'cos-browser', 'pets', 'zoom-in', 'zoom-out', 'zoom-reset']);
  expect(cos.item('cos-browser').querySelector('.row-menu-label')!.textContent).toBe('Show browser');
  cos.item('cos-browser').click();
  expect(cos.calls).toEqual(['cos-browser']);
  expect(cos.open()).toBeNull();
});

it('says what the pets toggle will do, runs actions and closes; zoom steps keep it open with the value updating', async () => {
  const view = await mount({ cos: false });
  view.button.click();
  view.item('search').click();
  expect(view.open()).toBeNull();
  view.button.click();
  view.item('pets').click();
  expect(view.calls).toEqual(['search', 'pets']);
  view.button.click();
  expect(view.item('pets').querySelector('.row-menu-label')!.textContent).toBe('Hide pets');

  expect(view.item('zoom-reset').querySelector('.row-menu-hint')!.textContent).toBe('100%');
  view.item('zoom-in').click(); await view.settle();
  view.item('zoom-in').click(); await view.settle();
  expect(view.open()).not.toBeNull();
  expect(view.item('zoom-reset').querySelector('.row-menu-hint')!.textContent).toBe('120%');
  view.item('zoom-reset').click(); await view.settle();
  expect([view.zoom(), view.item('zoom-reset').querySelector('.row-menu-hint')!.textContent]).toEqual([100, '100%']);
  // A zoom made elsewhere (the keyboard) shows in the open menu too.
  await view.menu.refresh();
  expect(view.open()).not.toBeNull();
});

it('opens from the keyboard and gives focus back to its button on Escape', async () => {
  const view = await mount({ cos: false });
  view.button.focus();
  view.button.dispatchEvent(new view.doc.defaultView!.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(view.open()).not.toBeNull();
  expect((view.doc.activeElement as HTMLElement).dataset.rowAction).toBe('search');
  view.open()!.dispatchEvent(new view.doc.defaultView!.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect((view.doc.activeElement as HTMLElement).dataset.rowAction).toBe('pets');
  view.open()!.dispatchEvent(new view.doc.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(view.open()).toBeNull();
  expect(view.doc.activeElement).toBe(view.button);
});
