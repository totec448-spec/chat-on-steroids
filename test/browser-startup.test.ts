import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ connected: false }));
const ready = vi.hoisted(() => vi.fn(async () => undefined));
const open = vi.hoisted(() => vi.fn(async () => 7));

vi.mock('../src/main/bridge.js', () => ({ browserWakeConnected: () => state.connected }));
vi.mock('../src/main/internal-browser.js', () => ({
  ensureInternalBrowserReady: ready,
  openInternalBrowserUrl: open
}));

import { resetBrowserStartupForTests, wakeBrowserUrl } from '../src/main/browser-startup.js';

beforeEach(() => {
  resetBrowserStartupForTests();
  state.connected = false;
  ready.mockClear();
  open.mockClear();
});

it('warms the internal Chromium but does not create a tab when the companion is already awake', async () => {
  state.connected = true;
  await wakeBrowserUrl('https://chatgpt.com/?cos-input=one');
  expect(ready).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
});

it('creates exactly one cold-start document for concurrent wake requests', async () => {
  await Promise.all([
    wakeBrowserUrl('https://chatgpt.com/?cos-input=one'),
    wakeBrowserUrl('https://chatgpt.com/?cos-input=two')
  ]);
  expect(open).toHaveBeenCalledTimes(1);
});

it('keeps background startup hidden and foreground startup revealable', async () => {
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=one', true, true);
  expect(open).toHaveBeenLastCalledWith('https://chatgpt.com/?cos-model-catalog=one', { active: false, reveal: false });
  await wakeBrowserUrl('https://chatgpt.com/?cos-input=two');
  expect(open).toHaveBeenLastCalledWith('https://chatgpt.com/?cos-input=two', { active: true, reveal: true });
});

it('rechecks operation authority after the async browser warmup', async () => {
  let current = true;
  ready.mockImplementationOnce(async () => { current = false; });
  await wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true, { current: () => current });
  expect(open).not.toHaveBeenCalled();
});
