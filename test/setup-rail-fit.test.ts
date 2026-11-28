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

// Haz on #2306: with the labels off screen only a number or a check mark is left, so hovering a step names it.
it('names each step in its tooltip while the labels are off screen, and not when they are shown', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} });
  vi.stubGlobal('MutationObserver', class { observe() {} });
  const frames: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run));
  const paint = () => frames.splice(0).forEach(run => run());
  const rail = new JSDOM('<nav></nav>').window.document.querySelector('nav') as HTMLElement;
  rail.innerHTML = '<ol><li><button><span class="setup-rail-label">Браузер</span></button></li><li hidden><button><span class="setup-rail-label">Ключ</span></button></li></ol>';
  const label = rail.querySelector<HTMLElement>('.setup-rail-label')!, buttons = [...rail.querySelectorAll('button')];
  const size = (scroll: number, client: number) => {
    Object.defineProperty(label, 'scrollWidth', { configurable: true, value: scroll });
    Object.defineProperty(label, 'clientWidth', { configurable: true, value: client });
  };
  size(60, 40);
  const refit = watchSetupRailLabels(rail)!; paint();
  expect(buttons.map(button => button.title)).toEqual(['Браузер', 'Ключ']);
  size(40, 40); refit(); paint();
  expect(buttons.map(button => button.hasAttribute('title'))).toEqual([false, false]);
});

// CodeRabbit on #2306: selecting a step makes its label bolder, and a font that swaps in after the first
// measurement changes every label's width; neither changes the rail's width, so neither was measured again.
it('measures again when the selected step changes and when a font arrives later', () => {
  const options: Array<{ attributeFilter?: string[] }> = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} });
  vi.stubGlobal('MutationObserver', class { observe(_node: unknown, option: { attributeFilter?: string[] }) { options.push(option); } });
  const frames: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run));
  const paint = () => frames.splice(0).forEach(run => run());
  const doc = new JSDOM('<nav><ol><li><button><span class="setup-rail-label">Браузер</span></button></li></ol></nav>').window.document;
  const arrived = new EventTarget();
  Object.defineProperty(doc, 'fonts', { value: { ready: Promise.resolve(), addEventListener: (type: string, listener: () => void) => arrived.addEventListener(type, listener) } });
  const rail = doc.querySelector('nav') as HTMLElement, label = rail.querySelector<HTMLElement>('.setup-rail-label')!;
  const size = (scroll: number, client: number) => {
    Object.defineProperty(label, 'scrollWidth', { configurable: true, value: scroll });
    Object.defineProperty(label, 'clientWidth', { configurable: true, value: client });
  };
  size(40, 40);
  watchSetupRailLabels(rail); paint();
  expect(options[0]?.attributeFilter, 'the selected step and a shown step both change the labels').toEqual(expect.arrayContaining(['hidden', 'aria-current']));
  expect(options[0]?.attributeFilter, 'the rail\'s own class is not watched').not.toContain('class');
  expect(rail.classList.contains('is-compact')).toBe(false);
  size(60, 40); arrived.dispatchEvent(new Event('loadingdone')); paint();
  expect(rail.classList.contains('is-compact'), 'a font that arrived later cut a label').toBe(true);
});
