import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * CodeRabbit on #1890: a ⌘K action runs once the dialog has faded out. If the chat or project chosen
 * changes meanwhile, an action such as Terminal would act on the new one. It runs only for the
 * selection it was chosen for.
 */
let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.resetModules(); });

async function palette() {
  const html = await readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  // The dialog's exit animation, which a test window does not run by itself.
  const computed = w.getComputedStyle.bind(w);
  w.getComputedStyle = ((element: Element) => element.id === 'searchDialog' ? { ...computed(element), animationName: 'search-out' } : computed(element)) as never;
  Object.assign(w.HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); },
    close(this: HTMLDialogElement) { this.removeAttribute('open'); }
  });
  (w as any).api = { searchSessions: async () => ({ ok: true, data: { results: [], indexed: 0, total: 0 } }) };
  Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node,
    HTMLInputElement: w.HTMLInputElement, HTMLButtonElement: w.HTMLButtonElement, KeyboardEvent: w.KeyboardEvent, Event: w.Event });
  const { initChatSearch } = await import('../src/renderer/chat-search.js');
  let selection = 1;
  const ran = vi.fn();
  const search = initChatSearch({ select: () => {}, selectedId: () => null, recent: () => [], epoch: () => selection,
    actions: () => [{ label: () => 'Terminal', run: ran }] });
  const field = w.document.getElementById('chatSearch') as HTMLInputElement;
  const dialog = w.document.getElementById('searchDialog') as HTMLDialogElement;
  const choose = async () => {
    search.open();
    field.value = 'terminal';
    field.dispatchEvent(new w.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(w.document.querySelector('#searchResults .is-action')).not.toBeNull(), { timeout: 5_000 });
    (w.document.querySelector('#searchResults .is-action') as HTMLButtonElement).click();
  };
  const faded = () => dialog.dispatchEvent(Object.assign(new w.Event('animationend'), { animationName: 'search-out' }));
  return { choose, faded, ran, dialog, select: (next: number) => { selection = next; } };
}

it('runs a chosen action once the dialog has faded out, for the selection it was chosen for', async () => {
  const p = await palette();
  await p.choose();
  expect(p.ran).not.toHaveBeenCalled();
  p.faded();
  expect(p.ran).toHaveBeenCalledOnce();
});

it('drops a chosen action when another chat or project was selected while the dialog faded out', async () => {
  const p = await palette();
  await p.choose();
  p.select(2);
  p.faded();
  expect(p.dialog.open).toBe(false);
  expect(p.ran).not.toHaveBeenCalled();
});
