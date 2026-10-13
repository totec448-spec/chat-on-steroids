import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
const getImageStorage = vi.fn(async () => ({ ok: true as const, data: { usedBytes: 2 ** 31, limitBytes: 2 ** 31 } }));
beforeEach(() => {
  vi.resetModules();
  getImageStorage.mockClear();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node });
  Object.assign(dom.window, { api: { getImageStorage } });
  // JSDOM has no modal dialogs.
  dom.window.HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
});
afterEach(() => dom.window.close());

// #1406: a full recording store was only a log warning; recordings became incomplete unnoticed.
it('says when recording storage is full, and offers the clean-up right there', async () => {
  const { paintRecordingStorageNotice: paint } = await import('../src/renderer/image-storage.js');
  const notice = document.getElementById('recordingStorageFull')!;
  expect(notice.hidden).toBe(true);
  paint(false);
  expect(notice.hidden).toBe(true);
  paint(true);
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toContain('Recording storage is full');

  document.getElementById('freeRecordingStorage')!.click();
  expect(document.querySelector('.image-storage-dialog')).not.toBeNull();
  expect(getImageStorage).toHaveBeenCalledOnce();
});

it('stays dismissed while the store is still full, and returns when it fills up again', async () => {
  const { paintRecordingStorageNotice: paint } = await import('../src/renderer/image-storage.js');
  const notice = document.getElementById('recordingStorageFull')!;
  paint(true);
  document.getElementById('dismissRecordingStorageFull')!.click();
  expect(notice.hidden).toBe(true);
  paint(true);
  expect(notice.hidden).toBe(true);
  paint(false);
  paint(true);
  expect(notice.hidden).toBe(false);
});

// #1406: the clean-up was reachable only from a timeline row whose image preview was missing,
// or once the store was already full.
it('offers the clean-up in Settings, with the storage used', async () => {
  const { initRecordingStorageSetting, paintRecordingStorageUsage } = await import('../src/renderer/image-storage.js');
  getImageStorage.mockResolvedValueOnce({ ok: true as const, data: { usedBytes: 0.5 * 2 ** 30, limitBytes: 2 ** 31 } });
  initRecordingStorageSetting();
  await paintRecordingStorageUsage();
  expect(document.getElementById('recordingStorageUsage')!.textContent).toBe('0.50 GB used of 2 GB');
  document.getElementById('settingsFreeImageStorage')!.click();
  expect(document.querySelector('.image-storage-dialog')).not.toBeNull();
});

it('keeps the description when the usage cannot be read', async () => {
  const { paintRecordingStorageUsage } = await import('../src/renderer/image-storage.js');
  const usage = document.getElementById('recordingStorageUsage')!;
  const before = usage.textContent;
  getImageStorage.mockResolvedValueOnce({ ok: false, error: 'unavailable' } as never);
  await paintRecordingStorageUsage();
  expect(usage.textContent).toBe(before);
});
