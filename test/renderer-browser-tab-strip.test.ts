import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserTabStrip } from '../src/renderer/browser-tab-strip.js';
import type { BrowserUseTabState } from '../src/shared/browser-use.js';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<body></body>', { url: 'https://cos.local/', pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLButtonElement', dom.window.HTMLButtonElement);
  vi.stubGlobal('ResizeObserver', undefined);
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function makeTabs(count: number): BrowserUseTabState[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    active: index === 0,
    loading: false,
    title: `Tab ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    canGoBack: false,
    canGoForward: false
  }));
}

it('keeps overflow inside its own viewport without auxiliary arrows or counters', async () => {
  const strip = createBrowserTabStrip({
    onSelect: vi.fn(), onClose: vi.fn(), onCreate: vi.fn(), onClosePanel: vi.fn()
  });
  document.body.append(strip.root);
  const viewport = strip.root.querySelector<HTMLElement>('.browser-use-tabs-viewport')!;
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 900 },
    scrollLeft: { configurable: true, writable: true, value: 0 }
  });

  strip.render(makeTabs(8), 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  strip.refresh();

  expect(strip.root.classList.contains('has-overflow')).toBe(true);
  expect(strip.root.querySelector('.browser-use-tab-scroll')).toBeNull();
  expect(strip.root.querySelector('.browser-use-tab-range')).toBeNull();
  expect(strip.root.querySelector('.browser-use-add')).not.toBeNull();
  expect(strip.root.querySelector('.browser-use-close')).not.toBeNull();
});

it('drags the tab strip from the tab body without selecting the tab on release', () => {
  const onSelect = vi.fn();
  const strip = createBrowserTabStrip({
    onSelect, onClose: vi.fn(), onCreate: vi.fn(), onClosePanel: vi.fn()
  });
  document.body.append(strip.root);
  const viewport = strip.root.querySelector<HTMLElement>('.browser-use-tabs-viewport')!;
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 900 },
    scrollLeft: { configurable: true, writable: true, value: 200 }
  });
  strip.render(makeTabs(8), 1);
  const pill = strip.root.querySelector<HTMLElement>('[data-browser-tab-id="1"]')!;

  const pointer = (type: string, x: number) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
    Object.defineProperty(event, 'pointerId', { value: 17 });
    return event;
  };

  pill.dispatchEvent(pointer('pointerdown', 180));
  window.dispatchEvent(pointer('pointermove', 100));
  expect(viewport.scrollLeft).toBe(280);
  expect(viewport.classList.contains('is-dragging')).toBe(true);
  window.dispatchEvent(pointer('pointerup', 100));
  pill.click();
  expect(onSelect).not.toHaveBeenCalled();
});

it('ignores unrelated pointer releases when no tab drag is active', () => {
  const strip = createBrowserTabStrip({
    onSelect: vi.fn(), onClose: vi.fn(), onCreate: vi.fn(), onClosePanel: vi.fn()
  });
  document.body.append(strip.root);

  expect(() => window.dispatchEvent(new dom.window.Event('pointerup'))).not.toThrow();
  expect(() => window.dispatchEvent(new dom.window.Event('pointercancel'))).not.toThrow();
});
