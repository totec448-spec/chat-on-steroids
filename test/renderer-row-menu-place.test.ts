import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

// A chat's menu opened on a short window (CI's 1024x656 screen, 2026-11-02) was a few pixels too
// tall for the room below and above its button, so it got a scroll box: a scrollbar for a menu
// whose every item was on screen. Showing it whole must never put it over its own button, though:
// a second click there, meant to close it, would run the item underneath (CodeRabbit on #2044).
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const BUTTON = { left: 200, right: 230, width: 30 };

async function place(height: number, box: { top: number; bottom: number }, options: { innerHeight?: number; innerWidth?: number; content?: number; button?: typeof BUTTON } = {}) {
  const { innerHeight = 656, innerWidth = 1024, content = height, button = BUTTON } = options;
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test' });
  vi.stubGlobal('window', Object.assign(dom.window, { innerHeight, innerWidth }));
  vi.stubGlobal('document', dom.window.document);
  const { placeRowMenuBesideForTests } = await import('../src/renderer/row-menu.js');
  const menu = dom.window.document.createElement('div');
  // The stylesheet caps a menu at the window's height minus its margins: offsetHeight never
  // reports more than that, only scrollHeight does.
  Object.defineProperty(menu, 'offsetHeight', { value: height });
  Object.defineProperty(menu, 'clientHeight', { value: height });
  Object.defineProperty(menu, 'scrollHeight', { value: content });
  Object.defineProperty(menu, 'offsetWidth', { value: 190 });
  placeRowMenuBesideForTests(menu, { ...button, height: box.bottom - box.top, top: box.top, bottom: box.bottom } as DOMRect, 'below');
  return { top: Number.parseFloat(menu.style.top), left: Number.parseFloat(menu.style.left), maxHeight: menu.style.maxHeight };
}

it('opens a menu that fits in the window but on neither side of its button beside the button, whole', async () => {
  // 330 px: 325 below and 295 above, but 640 in the window.
  const { top, left, maxHeight } = await place(330, { top: 307, bottom: 319 });
  expect(maxHeight).toBe('');
  expect(top).toBeGreaterThanOrEqual(8);
  expect(top + 330).toBeLessThanOrEqual(656 - 8);
  // Beside, not over: no part of the menu covers the button.
  expect(left).toBeGreaterThanOrEqual(BUTTON.right);
});

it('opens beside on the left when the right side has no room', async () => {
  const button = { left: 700, right: 730, width: 30 };
  const { left, maxHeight } = await place(330, { top: 307, bottom: 319 }, { innerWidth: 800, button });
  expect(maxHeight).toBe('');
  expect(left + 190).toBeLessThanOrEqual(button.left);
});

it('still scrolls a menu taller than the window, next to its button, also when the stylesheet caps it', async () => {
  // Uncapped measurement.
  expect(await place(700, { top: 307, bottom: 319 })).toMatchObject({ maxHeight: '325px', top: 323 });
  // Capped at 640 by the stylesheet; its content is 700 tall.
  expect(await place(640, { top: 307, bottom: 319 }, { content: 700 })).toMatchObject({ maxHeight: '325px', top: 323 });
});

it('keeps the ordinary cases: below with room, above without', async () => {
  expect(await place(200, { top: 100, bottom: 112 })).toMatchObject({ top: 116, maxHeight: '' });
  expect(await place(200, { top: 500, bottom: 512 })).toMatchObject({ top: 296, maxHeight: '' });
});

it('scrolls next to its button rather than cover it when there is no room beside it either', async () => {
  // 300 px wide: neither 230+4+190 nor 200-4-190 fits.
  expect(await place(330, { top: 307, bottom: 319 }, { innerWidth: 300 })).toMatchObject({ maxHeight: '325px', top: 323 });
});
