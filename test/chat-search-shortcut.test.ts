import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * Ctrl+K / ⌘K opened chat search on top of another open dialog, such as What's New after an update
 * (2.1.48 release round): two modal dialogs stacked, and the first came back after the second closed.
 * Like the other app shortcuts, it now waits until the other dialog is closed.
 */
let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.resetModules(); });

async function app() {
  const html = await readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(w.HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); },
    close(this: HTMLDialogElement) { this.removeAttribute('open'); }
  });
  (w as any).api = { searchSessions: async () => ({ ok: true, data: { results: [], indexed: 0, total: 0 } }) };
  Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node,
    HTMLInputElement: w.HTMLInputElement, HTMLButtonElement: w.HTMLButtonElement, KeyboardEvent: w.KeyboardEvent, Event: w.Event });
  const { initChatSearch } = await import('../src/renderer/chat-search.js');
  initChatSearch({ select: () => {}, selectedId: () => null, recent: () => [], epoch: () => 1, actions: () => [] });
  const search = w.document.getElementById('searchDialog') as HTMLDialogElement;
  // ⌘K on macOS, Ctrl+K elsewhere, as isMac() reads the platform of the machine running the test.
  const mac = /^Mac/.test(navigator.platform);
  const press = (target: Element) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
  return { w, search, press };
}

it('opens chat search with Ctrl+K when no other dialog is open', async () => {
  const { w, search, press } = await app();
  press(w.document.body);
  expect(search.open).toBe(true);
});

it('does not open chat search over another open dialog, wherever the focus is', async () => {
  const { w, search, press } = await app();
  const other = w.document.getElementById('whatsNewDialog') as HTMLDialogElement;
  other.showModal();
  press(w.document.getElementById('whatsNewDone')!);
  press(w.document.body);
  expect(search.open).toBe(false);
  other.close();
  press(w.document.body);
  expect(search.open).toBe(true);
});
