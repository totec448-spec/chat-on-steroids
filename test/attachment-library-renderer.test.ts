import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { InputAttachment } from '../src/shared/input.js';

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; vi.unstubAllGlobals(); vi.resetModules(); });

const png: InputAttachment = { id: '0f3c9a7e-5b21-4d8a-9c6e-000000000001', name: 'screenshot.png', size: 48_213, mimeType: 'image/png', preview: 'data:image/webp;base64,AAAA' };
const pdf: InputAttachment = { id: '0f3c9a7e-5b21-4d8a-9c6e-000000000002', name: 'report.pdf', size: 1_532_000, mimeType: 'application/pdf' };

async function mount(list: () => Promise<{ ok: true; data: InputAttachment[] } | { ok: false; error: string }>, attached = new Set<string>()) {
  dom = new JSDOM(`<!doctype html><body><details id="attachmentMenu" open><summary id="plus" tabindex="0"></summary><div class="composer-popover">
    <button id="attachRecent" type="button" data-keep-menu="true">Recent files</button><div id="attachmentLibrary" hidden></div></div></details></body>`, { url: 'https://library.test/' });
  const w = dom.window;
  for (const [key, value] of Object.entries({ window: w, document: w.document, HTMLElement: w.HTMLElement, HTMLButtonElement: w.HTMLButtonElement })) vi.stubGlobal(key, value);
  const choose = vi.fn();
  const { initAttachmentLibrary } = await import('../src/renderer/attachment-library.js');
  initAttachmentLibrary({ menu: w.document.getElementById('attachmentMenu') as HTMLDetailsElement, toggle: w.document.getElementById('attachRecent') as HTMLButtonElement,
    host: w.document.getElementById('attachmentLibrary')!, list, attached: () => attached, choose });
  return { w, choose, toggle: w.document.getElementById('attachRecent') as HTMLButtonElement, host: w.document.getElementById('attachmentLibrary')! };
}

it('lists recent files under the + menu row and hands the picked one to the draft', async () => {
  const list = vi.fn(async () => ({ ok: true as const, data: [png, pdf] }));
  const { w, choose, toggle, host } = await mount(list, new Set([png.id]));
  expect(host.hidden).toBe(true);
  toggle.click();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  await vi.waitFor(() => expect(host.querySelectorAll('.attachment-library-item')).toHaveLength(1), { timeout: 5000 });
  // The file already in this draft is not offered a second time.
  const row = host.querySelector<HTMLButtonElement>(`[data-attachment-id="${pdf.id}"]`)!;
  expect(row.textContent).toContain('report.pdf');
  expect(row.textContent).toContain('1.5 MB');
  expect(row.getAttribute('aria-label')).toBe('Attach report.pdf again');
  row.click();
  expect(choose).toHaveBeenCalledWith(pdf);
  expect(host.hidden).toBe(true);
  // Each expansion reads staging again; closing the menu collapses the list.
  toggle.click();
  await vi.waitFor(() => expect(host.querySelectorAll('.attachment-library-item')).toHaveLength(1), { timeout: 5000 });
  expect(list).toHaveBeenCalledTimes(2);
  const menu = w.document.getElementById('attachmentMenu') as HTMLDetailsElement;
  menu.open = false; menu.dispatchEvent(new w.Event('toggle'));
  expect(host.hidden).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('shows the image preview, the empty state and a load failure', async () => {
  let reply: { ok: true; data: InputAttachment[] } | { ok: false; error: string } = { ok: true, data: [png] };
  const { toggle, host } = await mount(async () => reply);
  toggle.click();
  await vi.waitFor(() => expect(host.querySelector('.attachment-library-thumb img')?.getAttribute('src')).toBe(png.preview), { timeout: 5000 });
  expect(host.textContent).toContain('Image · 47 kB');
  toggle.click(); reply = { ok: true, data: [] }; toggle.click();
  await vi.waitFor(() => expect(host.textContent).toBe('No files attached in the last 24 hours'), { timeout: 5000 });
  toggle.click(); reply = { ok: false, error: 'Session storage is not ready' }; toggle.click();
  await vi.waitFor(() => expect(host.textContent).toBe('Recent files could not be loaded'), { timeout: 5000 });
});

it('shows the load failure note when the list call itself rejects, and ignores a rejection that arrives after the list closed', async () => {
  const rejects: Array<(error: Error) => void> = [];
  const { toggle, host } = await mount(() => new Promise((_resolve, reject) => { rejects.push(reject); }));
  toggle.click();
  expect(host.textContent).toBe('Loading…');
  rejects[0]!(new Error('No handler registered for sessions:recentAttachments'));
  await vi.waitFor(() => expect(host.textContent).toBe('Recent files could not be loaded'), { timeout: 5000 });
  // Closed before the rejection arrives: the stale reply leaves the hidden list alone.
  toggle.click(); toggle.click(); toggle.click();
  expect(rejects).toHaveLength(2);
  rejects[1]!(new Error('late'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(host.hidden).toBe(true);
  expect(host.textContent).toBe('');
});

it('moves focus to the menu button when a row is picked or Escape is pressed, never to the page', async () => {
  const { w, toggle, host } = await mount(async () => ({ ok: true as const, data: [pdf] }));
  const plus = w.document.getElementById('plus')!;
  toggle.click();
  await vi.waitFor(() => expect(host.querySelectorAll('.attachment-library-item')).toHaveLength(1), { timeout: 5000 });
  host.querySelector<HTMLButtonElement>('.attachment-library-item')!.focus();
  host.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(w.document.activeElement).toBe(plus);
  host.querySelector<HTMLButtonElement>('.attachment-library-item')!.focus();
  host.querySelector<HTMLButtonElement>('.attachment-library-item')!.click();
  expect(w.document.activeElement).toBe(plus);
});

it('writes sizes in the number format of the app language', async () => {
  const { toggle, host } = await mount(async () => ({ ok: true as const, data: [pdf] }));
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  toggle.click();
  await vi.waitFor(() => expect(host.textContent).toContain('1,5 MB'), { timeout: 5000 });
});

it('writes the unit names of the app language', async () => {
  const tiny: InputAttachment = { ...pdf, id: '0f3c9a7e-5b21-4d8a-9c6e-000000000003', size: 512 };
  const { toggle, host } = await mount(async () => ({ ok: true as const, data: [tiny] }));
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  toggle.click();
  await vi.waitFor(() => expect(host.textContent).toContain('512 Byte'), { timeout: 5000 });
});

it('keeps a picked file out of the list until its attach settles, so a slow reply cannot attach it twice', async () => {
  let settle!: () => void;
  const attach = new Promise<void>(resolve => { settle = resolve; });
  const { choose, toggle, host } = await mount(async () => ({ ok: true as const, data: [png, pdf] }));
  choose.mockReturnValueOnce(attach);
  toggle.click();
  await vi.waitFor(() => expect(host.querySelectorAll('.attachment-library-item')).toHaveLength(2), { timeout: 5000 });
  host.querySelector<HTMLButtonElement>(`[data-attachment-id="${pdf.id}"]`)!.click();
  // Reopened before the first reply: the file in flight is not offered, the other one still is.
  toggle.click();
  await vi.waitFor(() => expect(host.querySelectorAll('.attachment-library-item')).toHaveLength(1), { timeout: 5000 });
  expect(host.querySelector(`[data-attachment-id="${pdf.id}"]`)).toBeNull();
  expect(choose).toHaveBeenCalledTimes(1);
  settle(); await attach;
  // Once settled it is offered again (the real draft hides it by listing it as attached).
  toggle.click(); toggle.click();
  await vi.waitFor(() => expect(host.querySelectorAll('.attachment-library-item')).toHaveLength(2), { timeout: 5000 });
});

it('limits the list to the room above the menu when it opens there, and to the room it has beside it', async () => {
  const { toggle, host } = await mount(async () => ({ ok: true as const, data: [pdf] }));
  const rect = (values: Partial<DOMRect>) => () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {}, ...values }) as DOMRect;
  host.parentElement!.getBoundingClientRect = rect({ top: 150, bottom: 400 });
  host.getBoundingClientRect = rect({ right: 5000 });
  toggle.click();
  expect(host.classList.contains('is-above')).toBe(true);
  expect(host.style.maxHeight).toBe('136px');
  toggle.click();
  host.getBoundingClientRect = rect({ right: 300 });
  toggle.click();
  expect(host.classList.contains('is-above')).toBe(false);
  expect(host.style.maxHeight).toBe('320px');
  // Less than 72 px of room: the list gets that room and scrolls, it never reaches past the window edge.
  toggle.click();
  host.getBoundingClientRect = rect({ right: 5000 });
  host.parentElement!.getBoundingClientRect = rect({ top: 50, bottom: 400 });
  toggle.click();
  expect(host.style.maxHeight).toBe('36px');
  toggle.click();
  host.parentElement!.getBoundingClientRect = rect({ top: 0, bottom: 400 });
  toggle.click();
  expect(host.style.maxHeight).toBe('0px');
});

it('puts Recent files in the composer + menu, keeping the menu open for the list', () => {
  const page = new JSDOM(readFileSync('src/renderer/index.html', 'utf8')).window.document;
  const toggle = page.querySelector('#attachmentMenu .composer-popover #attachRecent')!;
  expect(toggle.getAttribute('data-keep-menu')).toBe('true');
  expect(toggle.nextElementSibling?.id).toBe('attachmentLibrary');
});

it('translates the Recent files row and the label of its list with the rest of the page', async () => {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://library.test/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement'] as const) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  const { initLanguage, setLanguage } = await import('../src/renderer/i18n.js');
  initLanguage();
  const row = dom.window.document.getElementById('attachRecent')!, list = dom.window.document.getElementById('attachmentLibrary')!;
  expect(row.textContent).toContain('Recent files');
  setLanguage('de');
  expect(row.textContent).toContain('Zuletzt verwendete Dateien');
  expect(row.textContent).not.toContain('Recent files');
  expect(list.getAttribute('aria-label')).toBe('Zuletzt verwendete Dateien');
});

it('adds a staged id to the draft once, however many paths bring it', async () => {
  const { notInDraft } = await import('../src/renderer/attachment-library.js');
  const image = { name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' };
  // The + menu's slow attach lands after Recent files already put the same file in the draft.
  expect(notInDraft([png, image], [png])).toEqual([]);
  expect(notInDraft([image], [png, pdf, png])).toEqual([png, pdf]);
  expect(notInDraft([], [png])).toEqual([png]);
});
