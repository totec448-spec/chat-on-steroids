import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * #1833 (Haz's review): a short, optional first-run tour. Offered once after Setup, never started by
 * itself; three steps (the composer with its modes, Projects, Review), each one sentence beside the
 * real control, with Next and Skip tour. Keyboard: Enter/→ next, ← back, Escape skips. It never
 * clicks, sends or changes anything; afterwards focus is back in the composer. Replayable from Settings.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, { window: w, document: w.document, Event: w.Event, KeyboardEvent: w.KeyboardEvent, HTMLElement: w.HTMLElement });
  // jsdom lays nothing out: give the three controls a box so they count as shown.
  for (const id of ['composer', 'addProject', 'rightDockToggle']) {
    let node = w.document.getElementById(id);
    if (!node) { node = w.document.createElement('button'); node.id = id; w.document.body.append(node); }
    node.getBoundingClientRect = () => ({ x: 100, y: 100, left: 100, top: 100, right: 300, bottom: 140, width: 200, height: 40, toJSON: () => ({}) }) as DOMRect;
  }
});
afterEach(() => dom.window.close());

const $ = (id: string) => document.getElementById(id)!;
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
async function tour() {
  const { initTour } = await import('../src/renderer/tour.js');
  const markDone = vi.fn(async () => undefined);
  return { tour: initTour({ markDone }), markDone };
}
const key = (name: string) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true }));

it('offers the tour without starting it, and No thanks is final', async () => {
  const { tour: t, markDone } = await tour();
  t.offer();
  expect($('tourOffer').hidden).toBe(false);
  expect($('tourCard').hidden).toBe(true);
  ($('tourOfferNo') as HTMLButtonElement).click();
  await settle();
  expect($('tourOffer').hidden).toBe(true);
  expect(markDone).toHaveBeenCalledTimes(1);
});

it('walks three steps beside the real controls, one sentence each, and ends in the composer', async () => {
  const { tour: t, markDone } = await tour();
  t.offer();
  ($('tourOfferYes') as HTMLButtonElement).click();
  await settle();
  expect($('tourOffer').hidden).toBe(true);
  const card = $('tourCard');
  const seen: Array<[string | null, string]> = [];
  for (let step = 0; step < 3; step++) {
    expect(card.hidden).toBe(false);
    seen.push([document.querySelector('.is-tour-target')?.id ?? null, $('tourStep').textContent ?? '']);
    // One short sentence.
    expect(($('tourText').textContent ?? '').split(/[.!?](\s|$)/).filter(part => part && part.trim()).length).toBe(1);
    expect(document.activeElement?.closest('#tourCard')).not.toBeNull();
    ($('tourNext') as HTMLButtonElement).click();
    await settle();
  }
  expect(seen).toEqual([['composer', '1 of 3'], ['addProject', '2 of 3'], ['rightDockToggle', '3 of 3']]);
  expect(card.hidden).toBe(true);
  expect(document.querySelector('.is-tour-target')).toBeNull();
  expect(markDone).toHaveBeenCalledTimes(1);
  expect(document.activeElement?.id).toBe('chatInput');
});

it('goes back and forth with the keys, Escape skips, and nothing is clicked or sent', async () => {
  const { tour: t, markDone } = await tour();
  const clicks = vi.fn();
  for (const id of ['addProject', 'rightDockToggle']) $(id).addEventListener('click', clicks);
  t.start();
  key('ArrowRight'); await settle();
  expect($('tourStep').textContent).toBe('2 of 3');
  key('ArrowLeft'); await settle();
  expect($('tourStep').textContent).toBe('1 of 3');
  key('Enter'); await settle();
  expect($('tourStep').textContent).toBe('2 of 3');
  key('Escape'); await settle();
  expect($('tourCard').hidden).toBe(true);
  expect(markDone).toHaveBeenCalledTimes(1);
  expect(clicks).not.toHaveBeenCalled();
  expect(document.activeElement?.id).toBe('chatInput');
});

it('leaves out a step whose control is not on screen (a collapsed sidebar)', async () => {
  const { tour: t } = await tour();
  $('addProject').getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  t.start();
  expect($('tourStep').textContent).toBe('1 of 2');
  ($('tourNext') as HTMLButtonElement).click(); await settle();
  expect(document.querySelector('.is-tour-target')?.id).toBe('rightDockToggle');
  expect($('tourStep').textContent).toBe('2 of 2');
  expect($('tourNext').textContent).toBe('Done');
});
