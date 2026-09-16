import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

let dom: JSDOM;
let cleanup: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<body></body>', { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  cleanup = vi.fn(async () => ({ ok: true, data: { freedBytes: 2 ** 30, removedFiles: 10, usedBytes: 2 ** 30, limitBytes: 2 ** 31 } }));
  (dom.window as any).api = {
    getImageStorage: vi.fn(async () => ({ ok: true, data: { usedBytes: 2 ** 31, limitBytes: 2 ** 31 } })),
    clearImageStorage: cleanup
  };
});
afterEach(() => dom.window.close());

it('requires an explicit confirmed cleanup choice and prevents duplicate dispatch', async () => {
  const { imageStorageButton } = await import('../src/renderer/image-storage.js');
  const trigger = imageStorageButton(); document.body.append(trigger); trigger.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cleanup).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('2.00 GB used of 2 GB');
  const action = document.querySelector('.image-storage-actions button') as HTMLButtonElement;
  dom.window.confirm = vi.fn(() => false); action.click(); expect(cleanup).not.toHaveBeenCalled();
  dom.window.confirm = vi.fn(() => true); action.click(); action.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cleanup).toHaveBeenCalledExactlyOnceWith('oldest-gib');
  expect(document.body.textContent).toContain('Freed 1024.0 MB');
});

it('opening and cancelling the dialog preserves all images', async () => {
  const { imageStorageButton } = await import('../src/renderer/image-storage.js');
  imageStorageButton().click(); await new Promise(resolve => setTimeout(resolve, 0));
  (document.querySelector('dialog > button') as HTMLButtonElement).click();
  expect(document.querySelector('dialog')).toBeNull(); expect(cleanup).not.toHaveBeenCalled();
});

it('shows immediate feedback throughout cleanup and reports a rejected request', async () => {
  let reject!: (error: Error) => void;
  cleanup.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  dom.window.confirm = vi.fn(() => true);
  const { imageStorageButton } = await import('../src/renderer/image-storage.js');
  imageStorageButton().click();
  await new Promise(resolve => setTimeout(resolve, 0));
  (document.querySelector('.image-storage-actions button') as HTMLButtonElement).click();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Removing recorded images in the background.');
  expect(document.querySelector('dialog')?.getAttribute('aria-busy')).toBe('true');
  expect((document.querySelector('dialog > button') as HTMLButtonElement).disabled).toBe(false);
  reject(new Error('IPC disconnected'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.body.textContent).toContain('Image cleanup failed.');
  expect(document.querySelector('dialog')?.hasAttribute('aria-busy')).toBe(false);
  expect((document.querySelector('dialog > button') as HTMLButtonElement).disabled).toBe(false);
});

it('allows cleanup before usage loads, closes while running and rejoins the same result on reopen', async () => {
  (dom.window as any).api.getImageStorage.mockImplementation(() => new Promise(() => {}));
  let finish!: (value: unknown) => void;
  cleanup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  dom.window.confirm = vi.fn(() => true);
  const { imageStorageButton } = await import('../src/renderer/image-storage.js');
  const trigger = imageStorageButton();
  trigger.click();
  const action = document.querySelector('.image-storage-actions button') as HTMLButtonElement;
  expect(action.disabled).toBe(false);
  action.click();
  (document.querySelector('dialog > button') as HTMLButtonElement).click();
  expect(document.querySelector('dialog')).toBeNull();
  trigger.click();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('You can close this window.');
  (document.querySelector('.image-storage-actions button') as HTMLButtonElement).click();
  expect(cleanup).toHaveBeenCalledTimes(1);
  finish({ ok: true, data: { freedBytes: 2 ** 30, removedFiles: 10, usedBytes: 2 ** 30, limitBytes: 2 ** 31 } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Freed 1024.0 MB');
  (document.querySelector('dialog > button') as HTMLButtonElement).click();
  trigger.click();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Freed 1024.0 MB');
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect((dom.window as any).api.getImageStorage).toHaveBeenCalledTimes(1);
});
