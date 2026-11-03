import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * 2026-11-01: every state push rebuilt Setup and Settings lists nobody could see, and the garbage
 * left Blink's heap at 1.1 GB with 180 MB in use. A hidden panel now waits until it is shown, and
 * then paints once, with the newest state.
 *
 * jsdom has neither `checkVisibility` nor `ResizeObserver`; both are faked the way Chromium behaves:
 * an element is visible unless it or an ancestor has `hidden`, and the observer reports a box that
 * appears.
 */
let dom: JSDOM;
let observed: Set<Element>;
let notify: (() => void) | null;

beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<main><section id="settings" hidden><div><ul id="facts"></ul></div></section><ul id="sidebar"></ul></main>', { url: 'https://local.test/' });
  const { window } = dom;
  observed = new Set();
  notify = null;
  window.Element.prototype.checkVisibility = function (this: Element) { return !this.closest('[hidden]'); };
  class FakeResizeObserver {
    constructor(callback: () => void) { notify = () => callback(); }
    observe(node: Element) { observed.add(node); }
    unobserve(node: Element) { observed.delete(node); }
    disconnect() { observed.clear(); }
  }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, ResizeObserver: FakeResizeObserver });
});
afterEach(() => {
  dom.window.close();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

const show = (id: string) => { dom.window.document.getElementById(id)!.hidden = false; notify?.(); };

it('paints a visible panel at once and a hidden one only when it is shown, with the newest state', async () => {
  const { paintWhenShown } = await import('../src/renderer/dom.js');
  const document = dom.window.document;
  const painted: string[] = [];
  paintWhenShown(document.getElementById('sidebar')!, () => painted.push('sidebar'));
  expect(painted).toEqual(['sidebar']);

  const facts = document.getElementById('facts')!;
  paintWhenShown(facts, () => painted.push('facts 1'));
  paintWhenShown(facts, () => painted.push('facts 2'));
  expect(painted).toEqual(['sidebar']);
  // The box that appears is the hidden section's, not the empty list's.
  expect(observed.has(document.getElementById('settings')!)).toBe(true);

  // A resize while still hidden paints nothing.
  notify!();
  expect(painted).toEqual(['sidebar']);
  show('settings');
  expect(painted).toEqual(['sidebar', 'facts 2']);
  // Shown and painted: nothing is waiting or watched any more, and a further state paints at once.
  notify!();
  expect(painted).toEqual(['sidebar', 'facts 2']);
  expect(observed.size).toBe(0);
  paintWhenShown(facts, () => painted.push('facts 3'));
  expect(painted).toEqual(['sidebar', 'facts 2', 'facts 3']);
});

it('forgets a waiting paint once its panel is visible again or gone from the page', async () => {
  const { paintWhenShown } = await import('../src/renderer/dom.js');
  const document = dom.window.document;
  const painted: string[] = [];
  const facts = document.getElementById('facts')!;
  paintWhenShown(facts, () => painted.push('stale'));
  // Shown by other code before any resize was reported: the next paint is the one that counts.
  document.getElementById('settings')!.hidden = false;
  paintWhenShown(facts, () => painted.push('fresh'));
  notify!();
  expect(painted).toEqual(['fresh']);

  const gone = document.createElement('ul');
  document.getElementById('settings')!.append(gone);
  document.getElementById('settings')!.hidden = true;
  paintWhenShown(gone, () => painted.push('removed'));
  gone.remove();
  show('settings');
  expect(painted).toEqual(['fresh']);
});

it('paints at once where the browser cannot tell visibility', async () => {
  delete (dom.window.Element.prototype as { checkVisibility?: unknown }).checkVisibility;
  const { paintWhenShown } = await import('../src/renderer/dom.js');
  const painted: string[] = [];
  paintWhenShown(dom.window.document.getElementById('facts')!, () => painted.push('facts'));
  expect(painted).toEqual(['facts']);
});
