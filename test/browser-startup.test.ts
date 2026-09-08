import { beforeEach, expect, it, vi } from 'vitest';
const browser = vi.hoisted(() => ({ connected: false, present: false, lastSeenAt: null as number | null }));
const config = vi.hoisted(() => ({ ui: { chatBrowser: 'chrome' } }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => config }));
const open = vi.hoisted(() => vi.fn(async (_url: string): Promise<string | null> => 'chrome'));
const running = vi.hoisted(() => vi.fn(async (): Promise<boolean | null> => null));
vi.mock('../src/main/bridge.js', () => ({ bridgeStatus: async () => ({ ...browser }), browserWakeConnected: () => browser.connected, startBridge: async () => true }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: open, isPreferredBrowserRunning: running }));
vi.mock('../src/main/connection.js', () => ({ connect: vi.fn(), getStatus: vi.fn(), onStatusChange: vi.fn() }));
import { resetBrowserStartupForTests, wakeBrowserUrl } from '../src/main/browser-startup.js';
beforeEach(() => { resetBrowserStartupForTests(); config.ui.chatBrowser = 'chrome'; browser.connected = false; browser.present = false; browser.lastSeenAt = null; open.mockReset().mockResolvedValue('chrome'); running.mockReset().mockResolvedValue(false); });

it('starts the newly selected family without reusing the old attempt or overriding a connected companion', async () => {
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=old');
  config.ui.chatBrowser = 'edge';
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=new');
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=repeat');
  expect(open).toHaveBeenCalledTimes(2);
  browser.connected = true;
  config.ui.chatBrowser = 'chrome';
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=connected');
  expect(open).toHaveBeenCalledTimes(2);
});

it('discards absence evidence when the selected browser changes during its probe', async () => {
  browser.present = true;
  running.mockImplementationOnce(async () => { config.ui.chatBrowser = 'edge'; return false; });
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=old', true);
  expect(open).not.toHaveBeenCalled();
  running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=new', true);
  expect(open).toHaveBeenCalledTimes(1);
});

it('admits a new explicit refresh after the previous browser process exited', async () => {
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=old', true);
  running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=new', true);
  expect(open).toHaveBeenCalledTimes(2);
});
it('uses confirmed process absence to supersede stale HTTP presence, never socket suspension alone', async () => {
  browser.present = true; browser.lastSeenAt = Date.now();
  running.mockResolvedValue(true);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=one', true);
  expect(open).not.toHaveBeenCalled();
  running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=one', true);
  expect(open).toHaveBeenCalledTimes(1);
});
it('shares concurrent absence probes and never opens after the wake socket reconnects during a probe', async () => {
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=old', true);
  let release!: (value: boolean) => void;
  const probe = new Promise<boolean>(resolve => { release = resolve; });
  running.mockReturnValue(probe);
  const first = wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=new', true);
  const second = wakeBrowserUrl('https://chatgpt.com/?cos-input=other', true);
  await Promise.resolve(); release(false);
  await Promise.all([first, second]);
  expect(open).toHaveBeenCalledTimes(2);
  running.mockImplementation(async () => { browser.connected = true; return false; });
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=third', true);
  expect(open).toHaveBeenCalledTimes(2);
});
it('also opens for a first authored send when Chrome exited inside the HTTP presence window', async () => {
  browser.present = true; browser.lastSeenAt = Date.now(); running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-input=first');
  expect(open).toHaveBeenCalledTimes(1);
});

it('shares one successful absence episode across input and discovery retries', async () => {
  await Promise.all([wakeBrowserUrl('https://chatgpt.com/?cos-input=one'), wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=two', true)]);
  running.mockResolvedValue(true);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=three', true);
  expect(open).toHaveBeenCalledTimes(1);
  browser.connected = true; browser.present = true; browser.lastSeenAt = 100;
  await wakeBrowserUrl('https://chatgpt.com/');
  browser.connected = false; browser.present = false; running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=four', true);
  expect(open).toHaveBeenCalledTimes(2);
});
it('retries a rejected launch only after explicit retry and keeps successful retry shared', async () => {
  open.mockRejectedValueOnce(new Error('Microsoft Edge was not found'));
  await expect(wakeBrowserUrl('https://chatgpt.com/')).rejects.toThrow(/not found/);
  await expect(wakeBrowserUrl('https://chatgpt.com/')).rejects.toThrow(/not found/);
  expect(open).toHaveBeenCalledTimes(1);
  await wakeBrowserUrl('https://chatgpt.com/', true);
  running.mockResolvedValue(true);
  await wakeBrowserUrl('https://chatgpt.com/', true);
  expect(open).toHaveBeenCalledTimes(2);
});
it('waits for real absence after the wake channel closes with recent HTTP presence', async () => {
  browser.present = true; browser.lastSeenAt = Date.now(); browser.connected = true;
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=discovery');
  expect(open).not.toHaveBeenCalled();
  running.mockResolvedValue(true);
  browser.connected = false; // MV3 suspension or reconnect is not proof of browser absence
  await Promise.all([wakeBrowserUrl('https://chatgpt.com/?cos-input=first'), wakeBrowserUrl('https://chatgpt.com/?cos-input=second')]);
  expect(open).not.toHaveBeenCalled();
  browser.present = false; running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-input=first');
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith('https://chatgpt.com/?cos-input=first');
});
it('starts model discovery without asking the OS to open its URL in a foreground window', async () => {
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=one', true, true);
  expect(open).toHaveBeenCalledWith('https://chatgpt.com/?cos-model-catalog=one', { backgroundStartup: true });
});

it('opens an authorized recovery only after proving process absence, including stale HTTP absence', async () => {
  running.mockResolvedValue(null);
  const authority = { current: () => true };
  await wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true, authority);
  expect(open).not.toHaveBeenCalled(); // Unknown process state is not absence.
  running.mockResolvedValue(true);
  await wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true, authority);
  expect(open).not.toHaveBeenCalled(); // No socket/HTTP observation is not a closed browser.
  running.mockResolvedValue(false);
  await Promise.all([
    wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true, authority),
    wakeBrowserUrl('https://chatgpt.com/?cos-input=concurrent')
  ]);
  expect(open).toHaveBeenCalledTimes(1);
});

it('cannot open a recovery revoked while its process probe is pending', async () => {
  let current = true;
  let release!: (value: boolean) => void;
  running.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const work = wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true,
    { current: () => current });
  await Promise.resolve();
  current = false; release(false);
  await work;
  expect(open).not.toHaveBeenCalled();
});

it.each([true, null])('never forwards an initial discovery or authored URL to an existing or unknown process (%s)', async state => {
  running.mockResolvedValue(state);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=first', true, true);
  await wakeBrowserUrl('https://chatgpt.com/?cos-input=first');
  expect(open).not.toHaveBeenCalled();
});
