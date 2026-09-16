import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
});
afterEach(() => dom.window.close());

it('keeps the real compact reminder at the end of Setup and only shows once after acknowledgement', async () => {
  const { initToolApprovalNotice } = await import('../src/renderer/tool-approval.js');
  let opening!: () => void;
  initToolApprovalNotice(listener => { opening = listener; return () => {}; });
  const permanent = document.getElementById('toolApprovalSetup')!;
  expect(permanent.previousElementSibling?.classList.contains('advanced')).toBe(true);
  expect(permanent.textContent).toContain('Always allow');
  const image = permanent.querySelector('img')!;
  expect(image.src).toContain('tool-approval.jpg');
  expect(createHash('sha256').update(readFileSync('src/renderer/setup-images/tool-approval.jpg')).digest('hex')).toBe('cec727494000b9bfd87352e9248f448ddc54c042a19ffbd3b20acad8dccdb83f');
  const dialog = document.querySelector('.tool-approval-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(false); opening(); expect(dialog.open).toBe(true);
  expect(window.localStorage.getItem('cos.tool-approval-notice.v1')).toBeNull();
  (dialog.querySelector('button') as HTMLButtonElement).click();
  expect(dialog.open).toBe(false); opening(); expect(dialog.open).toBe(false);
  expect(permanent.querySelector('img')).toBe(image);
  initToolApprovalNotice(listener => { opening = listener; return () => {}; });
  opening(); expect([...document.querySelectorAll('dialog')].some(item => item.open)).toBe(false);
});
it('does not require local storage and never uses a browser or approval action', async () => {
  vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  const { initToolApprovalNotice } = await import('../src/renderer/tool-approval.js');
  let opening!: () => void;
  initToolApprovalNotice(listener => { opening = listener; return () => {}; });
  opening(); const dialog = document.querySelector('.tool-approval-dialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true); dialog.close(); opening(); expect(dialog.open).toBe(false);
  expect(dialog.textContent).toContain('does not approve a tool call');
});
