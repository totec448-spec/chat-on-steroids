import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

let dom: JSDOM | null = null;

afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('projects Pets first, current checks and commands through the narrow menu preload', async () => {
  const css = readFileSync(new URL('../src/renderer/view-menu.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../src/renderer/view-menu.html', import.meta.url), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  dom = new JSDOM(html, { url: 'https://local.test/' });
  const command = vi.fn();
  const close = vi.fn();
  let applySnapshot: (value: any) => void = () => undefined;
  Object.defineProperty(dom.window, 'viewMenuApi', {
    configurable: true,
    value: {
      command,
      close,
      onSnapshot: (listener: (value: any) => void) => { applySnapshot = listener; return () => undefined; }
    }
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLButtonElement', dom.window.HTMLButtonElement);

  await import('../src/renderer/view-menu.js');
  applySnapshot({
    petVisible: true,
    petReady: true,
    sidebarCollapsed: true,
    zoomPercent: 117,
    theme: 'dark',
    language: 'en',
    labels: { pet: 'Desktop pets', sidebar: 'Toggle Sidebar', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', actualSize: 'Actual Size' }
  });

  const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[data-command]')];
  expect(buttons.map(button => button.dataset.command)).toEqual(['pet', 'sidebar', 'zoom-in', 'zoom-out', 'zoom-reset']);
  expect(dom.window.document.querySelector('#viewPet span')!.textContent).toBe('Desktop pets');
  expect(dom.window.document.querySelector('#viewPet .ph-paw-print')).not.toBeNull();
  expect(dom.window.document.querySelector('#viewSidebar .ph-sidebar-simple')).not.toBeNull();
  expect(dom.window.document.querySelector('#viewZoomIn .ph-magnifying-glass-plus')).not.toBeNull();
  expect(dom.window.document.querySelector('#viewZoomOut .ph-magnifying-glass-minus')).not.toBeNull();
  expect(dom.window.document.querySelector('#viewActualSize .ph-corners-out')).not.toBeNull();
  expect(dom.window.document.querySelectorAll('.menu-check.ph-check')).toHaveLength(2);
  expect(dom.window.document.querySelector('.view-menu-surface svg')).toBeNull();
  expect(dom.window.document.getElementById('viewPet')!.getAttribute('aria-pressed')).toBe('true');
  expect(dom.window.document.getElementById('viewSidebar')!.getAttribute('aria-pressed')).toBe('false');
  expect(dom.window.document.getElementById('viewZoomValue')!.textContent).toBe('117%');
  expect(dom.window.document.querySelector('.view-menu-surface')!.classList.contains('is-opening')).toBe(true);
  expect(css).toContain('.view-menu-surface.is-opening { transform-origin: top left; animation: surface-in 140ms ease-out; }');
  expect(css).toContain('@media (prefers-reduced-motion: reduce)');

  dom.window.document.getElementById('viewPet')!.click();
  expect(command).toHaveBeenCalledWith('pet');
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(close).toHaveBeenCalledOnce();
});
