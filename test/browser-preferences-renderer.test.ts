import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { initBrowserPreferences } from '../src/renderer/browser-preferences.js';

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });

/** The page's switches, a stubbed extension round trip, and a hand-driven "came into view". */
function setup(reply: () => Promise<{ ok: true; data: { overwrite: boolean; durations: boolean } } | { ok: false; error: string }>) {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('Node', dom.window.Node);
  const browserPreferences = vi.fn(reply);
  vi.stubGlobal('window', Object.assign(dom.window, { api: { browserPreferences } }));
  let seen: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: typeof seen) { seen = callback; } observe() {} disconnect() {} });
  initBrowserPreferences();
  const doc = dom.window.document;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return {
    browserPreferences,
    overwrite: doc.getElementById('browserOverwrite') as HTMLInputElement,
    durations: doc.getElementById('browserDurations') as HTMLInputElement,
    status: doc.getElementById('browserPreferencesStatus')!,
    show: async () => { seen!([{ isIntersecting: true }]); await settle(); },
    hide: async () => { seen!([{ isIntersecting: false }]); await settle(); }
  };
}

it('reads the extension preferences when its switches come into view, so they are usable without Refresh', async () => {
  const page = setup(async () => ({ ok: true, data: { overwrite: true, durations: false } }));
  expect(page.overwrite.disabled).toBe(true);
  expect(page.browserPreferences).not.toHaveBeenCalled();

  await page.show();
  expect(page.browserPreferences).toHaveBeenCalledExactlyOnceWith({});
  expect(page.overwrite.disabled).toBe(false);
  expect(page.durations.disabled).toBe(false);
  expect(page.overwrite.checked).toBe(true);
  expect(page.status.textContent).toBe('Confirmed by the browser extension.');

  // Confirmed values are not re-read on every visit.
  await page.hide(); await page.show();
  expect(page.browserPreferences).toHaveBeenCalledTimes(1);
});

it('tries again on a later visit after the extension could not answer, never in a loop', async () => {
  let connected = false;
  const page = setup(async () => connected
    ? { ok: true, data: { overwrite: false, durations: true } }
    : { ok: false, error: 'Browser did not confirm its preferences. Connect the extension and refresh.' });

  await page.show();
  expect(page.browserPreferences).toHaveBeenCalledTimes(1);
  expect(page.overwrite.disabled).toBe(true);
  expect(page.status.textContent).toContain('Connect the extension');
  // Still on screen: the failure is shown, and the page does not keep asking.
  await page.show();
  expect(page.browserPreferences).toHaveBeenCalledTimes(1);

  connected = true;
  await page.hide(); await page.show();
  expect(page.browserPreferences).toHaveBeenCalledTimes(2);
  expect(page.durations.disabled).toBe(false);
  expect(page.durations.checked).toBe(true);
});
