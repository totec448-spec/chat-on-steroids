import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
const confirm = vi.fn((_message?: string) => true);
beforeEach(() => {
  vi.resetModules();
  confirm.mockReset(); confirm.mockReturnValue(true);
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node });
  Object.assign(dom.window, { confirm });
});
afterEach(() => dom.window.close());

const state = (unreadable: boolean) => ({ credentialsUnreadable: unreadable }) as any;

// A credentials file that can no longer be decrypted (keychain reset, profile moved to another
// computer) made every key save fail, with no way out in the app.
it('says the saved keys could not be read, and starts fresh only after the person confirms', async () => {
  const { paintCredentialsNotice: paint } = await import('../src/renderer/credentials-notice.js');
  const notice = document.getElementById('credentialsUnreadable')!;
  const button = document.getElementById('credentialsStartFresh') as HTMLButtonElement;
  const applied: unknown[] = [];
  const startFreshCredentials = vi.fn(async () => ({ ok: true as const, data: { state: state(false), setAside: true } }));
  const api = { startFreshCredentials };

  expect(notice.hidden).toBe(true);
  paint(state(false), api, next => applied.push(next));
  expect(notice.hidden).toBe(true);
  paint(state(true), api, next => applied.push(next));
  expect(notice.hidden).toBe(false);

  // Declined: nothing is asked of the app.
  confirm.mockReturnValueOnce(false);
  button.click();
  await Promise.resolve();
  expect(confirm).toHaveBeenCalledOnce();
  expect(startFreshCredentials).not.toHaveBeenCalled();

  // The question says what is lost and that the old file is kept.
  button.click();
  await vi.waitFor(() => expect(applied).toHaveLength(1));
  expect(String(confirm.mock.calls.at(-1)?.[0])).toMatch(/entered again/);
  expect(String(confirm.mock.calls.at(-1)?.[0])).toMatch(/kept as a backup/);
  expect(startFreshCredentials).toHaveBeenCalledOnce();
  expect(applied[0]).toEqual(state(false));
});

it('leaves the notice up and re-enables the button when starting fresh fails', async () => {
  const { paintCredentialsNotice: paint } = await import('../src/renderer/credentials-notice.js');
  const button = document.getElementById('credentialsStartFresh') as HTMLButtonElement;
  const applied: unknown[] = [];
  const startFreshCredentials = vi.fn(async () => ({ ok: false as const, error: 'Secure OS credential storage is unavailable, so nothing was changed' }));
  paint(state(true), { startFreshCredentials }, next => applied.push(next));
  button.click();
  await vi.waitFor(() => expect(startFreshCredentials).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(applied).toEqual([]);
  expect(document.getElementById('credentialsUnreadable')!.hidden).toBe(false);
});
