import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { initSidebarResize } from '../src/renderer/sidebar-resize.js';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });
it('bounds dragging, releases capture, preserves width through collapse and smaller windows, and resets', () => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const doc = dom.window.document;
  const app = doc.querySelector<HTMLElement>('.app')!;
  const sidebar = doc.getElementById('sidebar')!;
  const handle = doc.getElementById('sidebarResize')!;
  sidebar.getBoundingClientRect = () => ({ width: parseFloat(app.style.getPropertyValue('--sidebar-width')) || 248 }) as DOMRect;
  let captured = false;
  handle.setPointerCapture = () => { captured = true; };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => { captured = false; };
  initSidebarResize();
  const pointer = (type: string, x: number) => {
    const event = new dom.window.MouseEvent(type, { clientX: x, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    handle.dispatchEvent(event);
  };
  pointer('pointerdown', 248); pointer('pointermove', 1000); pointer('pointerup', 1000);
  expect(captured).toBe(false);
  expect(app.classList.contains('is-resizing-sidebar')).toBe(false);
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('480px');
  doc.getElementById('sidebarToggle')!.click();
  expect(sidebar.inert).toBe(true);
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
  expect(sidebar.inert).toBe(false);
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('480px');
  Object.defineProperty(dom.window, 'innerWidth', { value: 600, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('300px');
  Object.defineProperty(dom.window, 'innerWidth', { value: 1200 });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('480px');
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home' }));
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('180px');
  handle.dispatchEvent(new dom.window.MouseEvent('dblclick'));
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('');
  // The View menu's button lives in the title bar beside this toggle, not in the sidebar it hides.
  expect(sidebar.querySelector('#viewMenu')).toBeNull();
  expect(doc.getElementById('sidebarToggle')!.nextElementSibling!.id).toBe('viewMenu');
});

// The separator announces the width it set, not a measurement taken while the sidebar still glides
// to it (the compact-rows UI check read 205 for a width of 180 on macOS).
it('reports the target width through aria-valuenow while the measured width still lags', () => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  Object.defineProperty(dom.window, 'innerWidth', { value: 1200, configurable: true });
  const doc = dom.window.document;
  const sidebar = doc.getElementById('sidebar')!;
  const handle = doc.getElementById('sidebarResize')!;
  // Mid-glide: the box is still 205 wide whatever width was just asked for.
  sidebar.getBoundingClientRect = () => ({ width: 205 }) as DOMRect;
  initSidebarResize();
  expect(handle.getAttribute('aria-valuenow')).toBe('205');
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home' }));
  expect(handle.getAttribute('aria-valuenow')).toBe('180');
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End' }));
  expect(handle.getAttribute('aria-valuenow')).toBe('480');
  // A step right after Home starts from the reported 180, not from the lagging box.
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home' }));
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  expect(handle.getAttribute('aria-valuenow')).toBe('190');
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End' }));
  // A window that allows less clamps the announced value like the style does.
  Object.defineProperty(dom.window, 'innerWidth', { value: 600 });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  expect(handle.getAttribute('aria-valuenow')).toBe('300');
  // Back to the default: the box is all there is to read.
  handle.dispatchEvent(new dom.window.MouseEvent('dblclick'));
  expect(handle.getAttribute('aria-valuenow')).toBe('205');
});
