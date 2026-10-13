import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node });
});
afterEach(() => dom.window.close());

const state = (autoRefreshPlugins: boolean, autoRefreshPluginsAsked: boolean) =>
  ({ config: { ui: { autoRefreshPlugins, autoRefreshPluginsAsked } } }) as any;

// Asked once, in the window, to those who have it off without ever having been asked.
it('offers automatic plugin refresh once, and turns it on with one click', async () => {
  const { paintPluginRefreshOffer: paint } = await import('../src/renderer/plugin-refresh-offer.js');
  const card = document.getElementById('pluginRefreshOffer')!;
  const applied: unknown[] = [];
  const answerPluginRefreshOffer = vi.fn(async (turnOn: boolean) => ({ ok: true as const, data: state(turnOn, true) }));
  const api = { answerPluginRefreshOffer };

  paint(state(true, false), api, next => applied.push(next));
  expect(card.hidden).toBe(true); // already on
  paint(state(false, true), api, next => applied.push(next));
  expect(card.hidden).toBe(true); // already answered
  paint(state(false, false), api, next => applied.push(next));
  expect(card.hidden).toBe(false);
  expect(card.textContent).toMatch(/Keep plugins up to date in ChatGPT/);

  document.getElementById('pluginRefreshOfferAccept')!.click();
  await vi.waitFor(() => expect(applied).toHaveLength(1));
  expect(answerPluginRefreshOffer).toHaveBeenCalledWith(true);
  expect(card.hidden).toBe(true);
});

it('remembers "Not now", and stays up when the answer could not be saved', async () => {
  const { paintPluginRefreshOffer: paint } = await import('../src/renderer/plugin-refresh-offer.js');
  const card = document.getElementById('pluginRefreshOffer')!;
  const answerPluginRefreshOffer = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: 'Could not save settings' })
    .mockResolvedValueOnce({ ok: true, data: state(false, true) });
  const applied: unknown[] = [];
  paint(state(false, false), { answerPluginRefreshOffer }, next => applied.push(next));
  const later = document.getElementById('pluginRefreshOfferLater') as HTMLButtonElement;
  later.click();
  await vi.waitFor(() => expect(answerPluginRefreshOffer).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(later.disabled).toBe(false));
  expect(card.hidden).toBe(false);
  later.click();
  await vi.waitFor(() => expect(applied).toHaveLength(1));
  expect(answerPluginRefreshOffer).toHaveBeenLastCalledWith(false);
  expect(card.hidden).toBe(true);
});
