/**
 * The window's side of the Keychain notice (src/renderer/keychain-notice.ts).
 */

import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); });

async function mount() {
  const dom = new JSDOM('<div class="notices"><div class="notice" id="keychainNotice" role="status" hidden></div></div>');
  Object.assign(globalThis, { document: dom.window.document });
  let listener: ((waiting: boolean) => void) | null = null;
  const ready = vi.fn(async () => ({ ok: true as const, data: undefined }));
  const { initKeychainNotice, KEYCHAIN_NOTICE_DELAY_MS } = await import('../src/renderer/keychain-notice.js');
  initKeychainNotice({ onKeychainWaiting: next => { listener = next; return () => undefined; }, keychainNoticeReady: ready });
  return { notice: dom.window.document.getElementById('keychainNotice')!, send: (waiting: boolean) => listener!(waiting), ready, delay: KEYCHAIN_NOTICE_DELAY_MS };
}

it('answers main at once and shows the notice only while the Keychain read keeps waiting', async () => {
  vi.useFakeTimers();
  const { notice, send, ready, delay } = await mount();
  send(true);
  // Main holds the read until the window answers, so the answer cannot wait for the notice.
  expect(ready).toHaveBeenCalledTimes(1);
  expect(notice.hidden).toBe(true);
  vi.advanceTimersByTime(delay);
  expect(notice.hidden).toBe(false);
  send(false);
  expect(notice.hidden).toBe(true);
});

it('shows nothing when the Keychain lets the new build through at once', async () => {
  vi.useFakeTimers();
  const { notice, send, delay } = await mount();
  send(true);
  vi.advanceTimersByTime(delay / 3);
  send(false);
  vi.advanceTimersByTime(delay * 2);
  expect(notice.hidden).toBe(true);
});
