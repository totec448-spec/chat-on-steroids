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

// #1406: long texts fill the store as well, and only old chats can give them up.
it('frees about 1 GB from old chats after its own confirmation', async () => {
  let finish!: (value: unknown) => void;
  cleanup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { imageStorageButton } = await import('../src/renderer/image-storage.js');
  imageStorageButton().click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const action = [...document.querySelectorAll('.image-storage-actions button')].find(button => button.textContent === 'Free 1 GB from old chats') as HTMLButtonElement;
  expect(action).toBeTruthy();
  const confirm = vi.fn((_question: string) => false);
  dom.window.confirm = confirm;
  action.click();
  expect(cleanup).not.toHaveBeenCalled();
  expect(confirm.mock.calls[0]?.[0]).toContain('unused for a week');
  dom.window.confirm = vi.fn(() => true);
  action.click();
  expect(cleanup).toHaveBeenCalledExactlyOnceWith('old-chats-gib');
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Freeing space in the background.');
  finish({ ok: true, data: { freedBytes: 2 ** 30, removedFiles: 40, usedBytes: 2 ** 30, limitBytes: 2 ** 31 } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Freed 1024.0 MB. 1.00 GB of recording storage is now available.');
});

// #2198: opening Free storage from a chat explains global vs per-chat storage and offers per-chat cleanup.
it('shows per-chat breakdown and cleans only the open chat when requested from a chat', async () => {
  const sessionId = 'chat-session-2198';
  const sessionFull = { sessionId, usedBytes: 192 * 2 ** 20, limitBytes: 192 * 2 ** 20, imageBytes: 0, textBytes: 192 * 2 ** 20 };
  const sessionAfter = { sessionId, usedBytes: 0, limitBytes: 192 * 2 ** 20, imageBytes: 0, textBytes: 0 };
  (dom.window as any).api.getImageStorage = vi.fn(async (id?: string) => ({
    ok: true,
    data: { usedBytes: 300 * 2 ** 20, limitBytes: 2 ** 31, ...(id ? { session: sessionFull } : {}) }
  }));
  cleanup.mockImplementation(async () => ({
    ok: true,
    data: { freedBytes: 192 * 2 ** 20, removedFiles: 12, usedBytes: 108 * 2 ** 20, limitBytes: 2 ** 31, session: sessionAfter }
  }));
  const { imageStorageButton } = await import('../src/renderer/image-storage.js');
  imageStorageButton(sessionId).click();
  await new Promise(resolve => setTimeout(resolve, 0));

  expect((dom.window as any).api.getImageStorage).toHaveBeenCalledExactlyOnceWith(sessionId);
  expect(document.querySelector('[role="status"]')?.textContent).toContain('0.29 GB used of 2 GB');
  expect(document.body.textContent).toContain('This chat: 192.0 MB of 192 MB (0.0 MB images, 192.0 MB long texts).');

  const buttons = [...document.querySelectorAll('.image-storage-actions button')] as HTMLButtonElement[];
  expect(buttons[0]?.textContent).toBe('Free oldest 1 GB');
  const clearTexts = buttons.find(button => button.textContent === 'Free long texts in this chat');
  const clearImages = buttons.find(button => button.textContent === 'Free images in this chat');
  expect(clearTexts).toBeTruthy();
  expect(clearImages).toBeTruthy();

  dom.window.confirm = vi.fn(() => true);
  clearTexts!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cleanup).toHaveBeenCalledExactlyOnceWith('session-texts', sessionId);
  expect(document.body.textContent).toContain('This chat: 0.0 MB of 192 MB (0.0 MB images, 0.0 MB long texts).');
});

it('refreshes chat usage on reopen, isolates chat cleanup results across chats, and rejoins pending session-texts', async () => {
  const chatA = 'chat-session-a-2198';
  const chatB = 'chat-session-b-2198';
  let chatAUsedMb = 100;
  let finish!: (value: unknown) => void;
  (dom.window as any).api.getImageStorage = vi.fn(async (id?: string) => ({
    ok: true,
    data: {
      usedBytes: 300 * 2 ** 20,
      limitBytes: 2 ** 31,
      ...(id === chatA
        ? { session: { sessionId: chatA, usedBytes: chatAUsedMb * 2 ** 20, limitBytes: 192 * 2 ** 20, imageBytes: 0, textBytes: chatAUsedMb * 2 ** 20 } }
        : id === chatB
          ? { session: { sessionId: chatB, usedBytes: 42 * 2 ** 20, limitBytes: 192 * 2 ** 20, imageBytes: 12 * 2 ** 20, textBytes: 30 * 2 ** 20 } }
          : {})
    }
  }));
  cleanup.mockImplementationOnce(async () => ({
    ok: true,
    data: {
      freedBytes: 100 * 2 ** 20, removedFiles: 5, usedBytes: 200 * 2 ** 20, limitBytes: 2 ** 31,
      session: { sessionId: chatA, usedBytes: 0, limitBytes: 192 * 2 ** 20, imageBytes: 0, textBytes: 0 }
    }
  })).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));

  const { imageStorageButton } = await import('../src/renderer/image-storage.js');
  dom.window.confirm = vi.fn(() => true);

  // 1. Clean chatA, close, let chatA grow, and reopen chatA -> must re-fetch updated usage.
  imageStorageButton(chatA).click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const clearA = [...document.querySelectorAll('.image-storage-actions button')].find(b => b.textContent === 'Free long texts in this chat') as HTMLButtonElement;
  clearA.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('.image-storage-dialog [role="status"]')?.textContent).toContain('Freed 100.0 MB from this chat.');
  (document.querySelector('dialog > button') as HTMLButtonElement).click();

  chatAUsedMb = 64;
  imageStorageButton(chatA).click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((dom.window as any).api.getImageStorage).toHaveBeenLastCalledWith(chatA);
  expect(document.body.textContent).toContain('This chat: 64.0 MB of 192 MB (0.0 MB images, 64.0 MB long texts).');
  (document.querySelector('dialog > button') as HTMLButtonElement).click();

  // 2. Open chatB while chatA has a pending session-texts cleanup -> chatB loads its own row and never displays chatA's result.
  imageStorageButton(chatA).click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const clearPendingA = [...document.querySelectorAll('.image-storage-actions button')].find(b => b.textContent === 'Free long texts in this chat') as HTMLButtonElement;
  clearPendingA.click();
  (document.querySelector('dialog > button') as HTMLButtonElement).click();

  // Reopen chatA while pending -> rejoins pending state and keeps chatA's usage.
  imageStorageButton(chatA).click();
  expect(document.querySelector('.image-storage-dialog [role="status"]')?.textContent).toContain('Freeing space in the background.');
  expect(document.body.textContent).toContain('This chat: 64.0 MB of 192 MB');
  (document.querySelector('dialog > button') as HTMLButtonElement).click();

  // Switch to chatB while chatA's job is still running -> chatB fetches its own breakdown and hides chatA's completion text.
  imageStorageButton(chatB).click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.body.textContent).toContain('This chat: 42.0 MB of 192 MB (12.0 MB images, 30.0 MB long texts).');
  expect(document.querySelector('.image-storage-dialog [role="status"]')?.textContent).toContain('Freeing space in the background.');
  finish({
    ok: true,
    data: {
      freedBytes: 64 * 2 ** 20, removedFiles: 3, usedBytes: 236 * 2 ** 20, limitBytes: 2 ** 31,
      session: { sessionId: chatA, usedBytes: 0, limitBytes: 192 * 2 ** 20, imageBytes: 0, textBytes: 0 }
    }
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('.image-storage-dialog [role="status"]')?.textContent).toContain('0.29 GB used of 2 GB');
  expect(document.querySelector('.image-storage-dialog [role="status"]')?.textContent).not.toContain('Freed 64.0 MB from this chat.');
  (document.querySelector('dialog > button') as HTMLButtonElement).click();

  // 3. When a mock omits `session`, the chat breakdown row stays hidden.
  imageStorageButton('chat-without-breakdown').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const row = document.querySelector('.image-storage-chat-status') as HTMLElement | null;
  expect(row?.hidden).toBe(true);
});
