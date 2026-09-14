import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import type { ChatgptPermissionNotice } from '../src/shared/chatgpt-permission-notice.js';

let dom: JSDOM;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function shell(): Promise<void> {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'), { url: 'http://localhost' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new dom.window.Event('close'));
  };
}

function api(initial: ChatgptPermissionNotice, ack?: () => Promise<any>) {
  let state = initial;
  let listener: ((notice: ChatgptPermissionNotice) => void) | null = null;
  const getChatgptPermissionNotice = vi.fn(async () => ({ ok: true as const, data: state }));
  const acknowledgeChatgptPermissionNotice = vi.fn(ack ?? (async () => {
    state = { pending: false, revision: state.revision + 1 };
    return { ok: true as const, data: state };
  }));
  const onChatgptPermissionNotice = vi.fn((next: (notice: ChatgptPermissionNotice) => void) => {
    listener = next;
    return () => { if (listener === next) listener = null; };
  });
  return {
    getChatgptPermissionNotice,
    acknowledgeChatgptPermissionNotice,
    onChatgptPermissionNotice,
    push(next: ChatgptPermissionNotice) { state = next; listener?.(next); },
    set(next: ChatgptPermissionNotice) { state = next; }
  };
}

afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('keeps the Setup notice permanent and acknowledges a pending popup once across renderer reload', async () => {
  await shell();
  const footer = document.querySelector('.chatgpt-permission-setup-notice')!;
  expect(footer.textContent).toContain('Important: ChatGPT may be waiting for approval');
  expect(footer.textContent).toContain('Allow once, Always allow or Deny');

  const backend = api({ pending: true, revision: 4 });
  const { initChatgptPermissionNotice } = await import('../src/renderer/chatgpt-permission-notice.js');
  const stop = initChatgptPermissionNotice(backend); await tick();
  const notice = document.getElementById('chatgptPermissionNotice') as HTMLDialogElement;
  expect(notice.open).toBe(true);
  document.getElementById('chatgptPermissionUnderstand')!.click(); await tick();
  expect(backend.acknowledgeChatgptPermissionNotice).toHaveBeenCalledTimes(1);
  expect(notice.open).toBe(false);

  stop();
  const stopReload = initChatgptPermissionNotice(backend); await tick();
  expect(backend.getChatgptPermissionNotice).toHaveBeenCalledTimes(2);
  expect(notice.open).toBe(false);
  expect(footer.isConnected).toBe(true);
  stopReload();
});

it('uses the same localized approval guidance in Setup and the popup', async () => {
  await shell();
  const language = await import('../src/renderer/i18n.js');
  language.initLanguage();
  language.setLanguage('zh-CN');
  expect(document.querySelector('.chatgpt-permission-setup-notice h3')!.textContent).toBe('重要：ChatGPT 可能正在等待你的批准');
  expect(document.getElementById('chatgptPermissionNoticeTitle')!.textContent).toBe('重要：ChatGPT 可能正在等待你的批准');
  expect(document.querySelector('.chatgpt-permission-setup-notice')!.textContent).toContain('Allow once、Always allow 或 Deny');
  expect(document.getElementById('chatgptPermissionUnderstand')!.textContent).toBe('知道了');
  expect(document.querySelector('.chatgpt-permission-setup-notice figcaption')!.textContent).toBe('示意图。ChatGPT 的实际界面可能有所不同。');
  expect(document.querySelector('.chatgpt-permission-setup-notice img')!.getAttribute('aria-label')).toBe('ChatGPT 工具批准示意图，显示 Deny、Allow once 和 Always allow');
});

it('shows the durable pending notice again after a renderer reload when it was not acknowledged', async () => {
  await shell();
  const backend = api({ pending: true, revision: 9 });
  const { initChatgptPermissionNotice } = await import('../src/renderer/chatgpt-permission-notice.js');
  const notice = document.getElementById('chatgptPermissionNotice') as HTMLDialogElement;
  const first = initChatgptPermissionNotice(backend); await tick();
  expect(notice.open).toBe(true);
  first();
  expect(notice.open).toBe(false);
  const second = initChatgptPermissionNotice(backend); await tick();
  expect(notice.open).toBe(true);
  expect(backend.acknowledgeChatgptPermissionNotice).not.toHaveBeenCalled();
  second();
});

it('keeps a failed close acknowledgement visible and allows an explicit retry', async () => {
  await shell();
  let attempt = 0;
  const backend = api({ pending: true, revision: 2 }, async () => {
    attempt++;
    return attempt === 1
      ? { ok: false as const, error: 'disk busy' }
      : { ok: true as const, data: { pending: false, revision: 3 } };
  });
  const { initChatgptPermissionNotice } = await import('../src/renderer/chatgpt-permission-notice.js');
  initChatgptPermissionNotice(backend); await tick();
  const notice = document.getElementById('chatgptPermissionNotice') as HTMLDialogElement;
  document.getElementById('chatgptPermissionClose')!.click(); await tick();
  expect(notice.open).toBe(true);
  expect(document.getElementById('chatgptPermissionStatus')!.textContent).toContain('disk busy');
  document.getElementById('chatgptPermissionUnderstand')!.click(); await tick();
  expect(backend.acknowledgeChatgptPermissionNotice).toHaveBeenCalledTimes(2);
  expect(notice.open).toBe(false);
});

it('treats Escape as acknowledgement and closes only after the successful reply', async () => {
  await shell();
  let resolve!: (reply: { ok: true; data: ChatgptPermissionNotice }) => void;
  const backend = api({ pending: true, revision: 11 }, () => new Promise(done => { resolve = done; }));
  const { initChatgptPermissionNotice } = await import('../src/renderer/chatgpt-permission-notice.js');
  initChatgptPermissionNotice(backend); await tick();
  const notice = document.getElementById('chatgptPermissionNotice') as HTMLDialogElement;
  const cancel = new dom.window.Event('cancel', { cancelable: true });
  notice.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(notice.open).toBe(true);
  resolve({ ok: true, data: { pending: false, revision: 12 } }); await tick();
  expect(notice.open).toBe(false);
});

it('lets a higher revision push win over a stale initial read', async () => {
  await shell();
  let resolveGet!: (reply: { ok: true; data: ChatgptPermissionNotice }) => void;
  let listener: ((notice: ChatgptPermissionNotice) => void) | null = null;
  const backend = {
    getChatgptPermissionNotice: vi.fn(() => new Promise<{ ok: true; data: ChatgptPermissionNotice }>(done => { resolveGet = done; })),
    acknowledgeChatgptPermissionNotice: vi.fn(async () => ({ ok: true as const, data: { pending: false, revision: 8 } })),
    onChatgptPermissionNotice: vi.fn((next: (notice: ChatgptPermissionNotice) => void) => { listener = next; return () => {}; })
  };
  const { initChatgptPermissionNotice } = await import('../src/renderer/chatgpt-permission-notice.js');
  initChatgptPermissionNotice(backend); await tick();
  listener!({ pending: true, revision: 8 }); await tick();
  const notice = document.getElementById('chatgptPermissionNotice') as HTMLDialogElement;
  expect(notice.open).toBe(true);
  resolveGet({ ok: true, data: { pending: false, revision: 7 } }); await tick();
  expect(notice.open).toBe(true);
});

it('defers behind another dialog and preserves its typed form until that dialog closes', async () => {
  await shell();
  const competing = document.getElementById('setupProfileDialog') as HTMLDialogElement;
  const field = document.getElementById('setupProfileName') as HTMLInputElement;
  competing.showModal(); field.value = 'Work profile draft'; field.focus();
  const backend = api({ pending: true, revision: 5 });
  const { initChatgptPermissionNotice } = await import('../src/renderer/chatgpt-permission-notice.js');
  initChatgptPermissionNotice(backend); await tick();
  const notice = document.getElementById('chatgptPermissionNotice') as HTMLDialogElement;
  expect(notice.open).toBe(false);
  expect(field.value).toBe('Work profile draft');

  competing.close(); await tick();
  expect(notice.open).toBe(true);
  expect(field.value).toBe('Work profile draft');
  expect(backend.acknowledgeChatgptPermissionNotice).not.toHaveBeenCalled();
});
