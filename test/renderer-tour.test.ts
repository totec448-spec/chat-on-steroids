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
  const markDone = vi.fn(async () => true);
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

// CodeRabbit on #1867: steps only for controls really on screen; the tour's keys only while focus is in its card.
it('leaves out a control hidden by style or outside the window, and leaves the composer\'s keys alone', async () => {
  const { tour: t } = await tour();
  $('addProject').style.visibility = 'hidden';
  $('rightDockToggle').getBoundingClientRect = () => ({ x: 5000, y: 100, left: 5000, top: 100, right: 5200, bottom: 140, width: 200, height: 40, toJSON: () => ({}) }) as DOMRect;
  t.start();
  expect($('tourStep').textContent).toBe('1 of 1');
  // Focus in the composer: arrows and Enter are the composer's, not the tour's.
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.focus();
  const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect($('tourCard').hidden).toBe(false);
});

// CodeRabbit on #1867: a resize that hides a later step's control while the current one stays drops that
// step too, and Next never opens a step whose control left the screen.
it('drops a later step hidden by a resize while the current step stays, and Next skips a control that left', async () => {
  const { tour: t } = await tour();
  t.start();
  expect($('tourStep').textContent).toBe('1 of 3');
  $('addProject').getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.focus();
  window.dispatchEvent(new dom.window.Event('resize'));
  expect(document.querySelector('.is-tour-target')?.id).toBe('composer');
  expect($('tourStep').textContent).toBe('1 of 2');
  // The resize leaves the focus where the person was typing.
  expect(document.activeElement).toBe(input);
  ($('tourNext') as HTMLButtonElement).focus();
  // Without a resize event (a sidebar collapsed by a click): Next still skips the control that left.
  $('rightDockToggle').style.display = 'none';
  ($('tourNext') as HTMLButtonElement).click(); await settle();
  expect($('tourCard').hidden).toBe(true);
});


// CodeRabbit on #1867: a step skipped without a resize (a sidebar collapsed by a click) leaves the count too.
it('counts only the steps still on screen after Next skips one that left without a resize', async () => {
  const { tour: t } = await tour();
  t.start();
  expect($('tourStep').textContent).toBe('1 of 3');
  $('addProject').style.display = 'none';
  ($('tourNext') as HTMLButtonElement).click(); await settle();
  expect(document.querySelector('.is-tour-target')?.id).toBe('rightDockToggle');
  expect($('tourStep').textContent).toBe('2 of 2');
  key('ArrowLeft');
  expect(document.querySelector('.is-tour-target')?.id).toBe('composer');
  expect($('tourStep').textContent).toBe('1 of 2');
});

it('drops the current step when its control left without a resize, going back or forth', async () => {
  const { tour: t } = await tour();
  t.start();
  ($('tourNext') as HTMLButtonElement).click(); await settle();
  expect($('tourStep').textContent).toBe('2 of 3');
  $('addProject').style.display = 'none';
  key('ArrowLeft');
  expect(document.querySelector('.is-tour-target')?.id).toBe('composer');
  expect($('tourStep').textContent).toBe('1 of 2');
  $('composer').style.display = 'none';
  key('ArrowLeft');
  expect(document.querySelector('.is-tour-target')?.id).toBe('rightDockToggle');
  expect($('tourStep').textContent).toBe('1 of 1');
});

it('ends quietly when the person leaves the chat screen, without counting that as Skip or Done (CodeRabbit)', async () => {
  const { tour: t, markDone } = await tour();
  t.start();
  key('ArrowRight'); await settle();
  expect($('tourCard').hidden).toBe(false);
  // Settings opened mid-tour: the card and ring would point at a screen that is no longer there.
  t.stop();
  expect($('tourCard').hidden).toBe(true);
  expect($('tourRing').hidden).toBe(true);
  expect(document.querySelector('.is-tour-target')).toBeNull();
  expect(markDone).not.toHaveBeenCalled();
  // Its keys are gone too, and a stop with no tour running does nothing.
  key('ArrowRight'); await settle();
  expect($('tourCard').hidden).toBe(true);
  t.stop();
  // It can still be offered or replayed later.
  t.start();
  expect($('tourCard').hidden).toBe(false);
  expect($('tourStep').textContent).toBe('1 of 3');
});

it('rounds the ring around each control like the control itself, so the corners stay parallel (2.1.47 round)', async () => {
  // The composer's 22 px corners got a 12 px ring 4 px outside them; the ring follows the control now.
  // With a dock row above it, the composer's top corners are 12 px and its bottom ones 22 px: each ring corner follows its own (CodeRabbit).
  Object.assign($('composer').style, { borderTopLeftRadius: '12px', borderTopRightRadius: '12px', borderBottomRightRadius: '22px', borderBottomLeftRadius: '22px' });
  Object.assign($('addProject').style, { borderTopLeftRadius: '8px', borderTopRightRadius: '8px', borderBottomRightRadius: '8px', borderBottomLeftRadius: '8px' });
  const { tour: t } = await tour();
  t.start();
  const corners = () => { const ring = $('tourRing').style; return [ring.borderTopLeftRadius, ring.borderTopRightRadius, ring.borderBottomRightRadius, ring.borderBottomLeftRadius]; };
  expect(corners()).toEqual(['16px', '16px', '26px', '26px']);
  ($('tourNext') as HTMLButtonElement).click();
  expect(corners()).toEqual(['12px', '12px', '12px', '12px']);
});
