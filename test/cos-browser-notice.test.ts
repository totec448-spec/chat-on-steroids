import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
});
afterEach(() => dom.window.close());

it('offers the CoS browser once a desktop browser is connected, and not before or after choosing it', async () => {
  const { paintCosBrowserNotice: paint } = await import('../src/renderer/cos-browser-notice.js');
  const notice = document.getElementById('cosBrowserNotice')!;
  const choose = vi.fn();
  paint({ chatBrowser: 'chrome', browserConnected: false }, choose);
  expect(notice.hidden).toBe(true);
  paint({ chatBrowser: 'edge', browserConnected: true }, choose);
  expect(notice.hidden).toBe(false);
  // A legacy config without a saved choice means Chrome.
  paint({ chatBrowser: undefined, browserConnected: true }, choose);
  expect(notice.hidden).toBe(false);
  document.getElementById('cosBrowserNoticeChoose')!.click();
  expect(choose).toHaveBeenCalledTimes(1);
  paint({ chatBrowser: 'cos', browserConnected: true }, choose);
  expect(notice.hidden).toBe(true);
});

it('stays dismissed across app restarts', async () => {
  let { paintCosBrowserNotice: paint } = await import('../src/renderer/cos-browser-notice.js');
  const notice = document.getElementById('cosBrowserNotice')!;
  paint({ chatBrowser: 'brave', browserConnected: true }, () => undefined);
  document.getElementById('dismissCosBrowserNotice')!.click();
  expect(notice.hidden).toBe(true);
  vi.resetModules();
  ({ paintCosBrowserNotice: paint } = await import('../src/renderer/cos-browser-notice.js'));
  paint({ chatBrowser: 'brave', browserConnected: true }, () => undefined);
  expect(notice.hidden).toBe(true);
});

it('says in the chat when the built-in browser is signed out, and only then', async () => {
  const { paintCosSignInNotice: paint } = await import('../src/renderer/cos-browser-notice.js');
  const notice = document.getElementById('cosSignInNotice')!;
  const signIn = vi.fn();
  // Unknown while the built-in browser starts: nothing is claimed yet.
  paint({ chatBrowser: 'cos', signedIn: null }, signIn);
  expect(notice.hidden).toBe(true);
  paint({ chatBrowser: 'cos', signedIn: false }, signIn);
  expect(notice.hidden).toBe(false);
  // It is a state, not a tip: nothing dismisses it but the sign-in itself.
  expect(notice.querySelector('[aria-label="Dismiss"]')).toBeNull();
  document.getElementById('cosSignInNoticeOpen')!.click();
  expect(signIn).toHaveBeenCalledTimes(1);
  paint({ chatBrowser: 'cos', signedIn: true }, signIn);
  expect(notice.hidden).toBe(true);
  // A desktop browser has its own sign-in, which this app does not read.
  paint({ chatBrowser: 'chrome', signedIn: false }, signIn);
  expect(notice.hidden).toBe(true);
});
