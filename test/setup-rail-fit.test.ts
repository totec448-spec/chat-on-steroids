import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { watchSetupRailLabels } from '../src/renderer/setup-rail-fit.js';

afterEach(() => { vi.unstubAllGlobals(); });

// The first version ran at start-up in every renderer test page, which has no ResizeObserver: 842 tests failed.
it('leaves the rail alone where the browser has no observers', () => {
  vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('MutationObserver', undefined);
  expect(watchSetupRailLabels({} as HTMLElement)).toBeNull();
});

it('does nothing without a rail', () => {
  expect(watchSetupRailLabels(null)).toBeNull();
});

it('marks the rail compact when a label does not fit, and clears it when they all fit', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} });
  vi.stubGlobal('MutationObserver', class { observe() {} });
  const frames: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run));
  const paint = () => frames.splice(0).forEach(run => run());
  const rail = new JSDOM('<nav></nav>').window.document.querySelector('nav') as HTMLElement;
  rail.innerHTML = '<ol><li><button><span class="setup-rail-label">Браузер</span></button></li></ol>';
  const label = rail.querySelector<HTMLElement>('.setup-rail-label')!;
  const size = (scroll: number, client: number) => {
    Object.defineProperty(label, 'scrollWidth', { configurable: true, value: scroll });
    Object.defineProperty(label, 'clientWidth', { configurable: true, value: client });
  };
  size(40, 40);
  const refit = watchSetupRailLabels(rail)!;
  paint();
  expect(rail.classList.contains('is-compact'), 'a label that fits stays').toBe(false);
  size(60, 40); refit(); paint();
  expect(rail.classList.contains('is-compact'), 'a cut label moves every label off screen').toBe(true);
  size(40, 40); refit(); paint();
  expect(rail.classList.contains('is-compact'), 'labels come back when they fit again').toBe(false);
});
