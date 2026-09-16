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
