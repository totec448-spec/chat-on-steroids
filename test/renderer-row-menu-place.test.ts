import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

// A chat's menu opened on a short window (CI's 1024x656 screen, 2026-11-02) was a few pixels too
// tall for the room below and above its button, so it got a scroll box: a scrollbar for a menu
// whose every item was on screen.
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function place(height: number, box: { top: number; bottom: number }, innerHeight = 656) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test' });
  vi.stubGlobal('window', Object.assign(dom.window, { innerHeight, innerWidth: 1024 }));
  vi.stubGlobal('document', dom.window.document);
  const { placeRowMenuBesideForTests } = await import('../src/renderer/row-menu.js');
  const menu = dom.window.document.createElement('div');
  Object.defineProperty(menu, 'offsetHeight', { value: height });
  Object.defineProperty(menu, 'offsetWidth', { value: 190 });
  placeRowMenuBesideForTests(menu, { left: 200, right: 230, width: 30, height: box.bottom - box.top, top: box.top, bottom: box.bottom } as DOMRect, 'below');
  return { top: Number.parseFloat(menu.style.top), maxHeight: menu.style.maxHeight };
}

it('shows a menu whole when it fits in the window, even if neither side of its button has room', async () => {
  // 330 px: 325 below and 295 above, but 640 in the window.
  const { top, maxHeight } = await place(330, { top: 307, bottom: 319 });
  expect(maxHeight).toBe('');
  expect(top).toBeGreaterThanOrEqual(8);
  expect(top + 330).toBeLessThanOrEqual(656 - 8);
});

it('still scrolls a menu taller than the window, next to its button', async () => {
  const { top, maxHeight } = await place(700, { top: 307, bottom: 319 });
  expect(maxHeight).toBe('325px');
  expect(top).toBe(323);
});

it('keeps the ordinary cases: below with room, above without', async () => {
  expect(await place(200, { top: 100, bottom: 112 })).toEqual({ top: 116, maxHeight: '' });
  expect(await place(200, { top: 500, bottom: 512 })).toEqual({ top: 296, maxHeight: '' });
});
