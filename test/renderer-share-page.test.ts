import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Share a chat as a web page: the dialog shows the page before anything is saved, hides personal
 * details only when asked, and saves the page it showed.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event });
});
afterEach(() => dom.window.close());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const page = (hidden: number, preview = `0000000${hidden}-0000-4000-8000-000000000000`) =>
  ({ ok: true as const, data: { done: 'preview' as const, preview, html: `<html><head></head><body>${hidden}</body></html>`, hidden } });

type Answer = { ok: true; data: unknown } | { ok: false; error: string };
function deferred() {
  let resolve!: (value: Answer) => void;
  const promise = new Promise<Answer>(done => { resolve = done; });
  return { promise, resolve };
}

async function open(sharePage: (request: unknown) => Promise<Answer>, saved = vi.fn()) {
  const { initSharePage } = await import('../src/renderer/share-page.js');
  initSharePage({ sharePage } as any, saved).open('session-1');
  return saved;
}

it('opens with addresses and user names hidden, shows the page in a frame that runs nothing, and saves that page', async () => {
  const sharePage = vi.fn(async (request: any): Promise<Answer> => request.target === 'preview' ? page(0)
    : { ok: true, data: { done: 'saved', name: 'Plan.html' } });
  const saved = await open(sharePage);
  expect($<HTMLDialogElement>('sharePageDialog').open).toBe(true);
  await settle();
  expect(sharePage).toHaveBeenCalledWith({ id: 'session-1', target: 'preview', hide: true, lang: 'en' });
  expect($<HTMLInputElement>('sharePageHide').checked).toBe(true);
  const frame = $<HTMLIFrameElement>('sharePageFrame');
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.srcdoc).toBe('<html><head>\n<base target="_blank"></head><body>0</body></html>');
  expect($('sharePageLoading').hidden).toBe(true);
  expect($<HTMLButtonElement>('sharePageSave').disabled).toBe(false);
  $('sharePageForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await settle();
  expect(sharePage).toHaveBeenLastCalledWith({ id: 'session-1', target: 'file', preview: '00000000-0000-4000-8000-000000000000' });
  expect(saved).toHaveBeenCalledWith('Plan.html');
  expect($<HTMLDialogElement>('sharePageDialog').open).toBe(false);
});

it('says how many details the page hides, and shows addresses and names only when asked', async () => {
  let hidden = 3;
  const sharePage = vi.fn(async (request: any): Promise<Answer> => page(request.hide ? hidden : 0));
  await open(sharePage);
  await settle();
  expect($('sharePageCount').hidden).toBe(false);
  expect($('sharePageCount').textContent).toBe('3 details are hidden on this page.');
  const hide = $<HTMLInputElement>('sharePageHide');
  hide.checked = false;
  hide.dispatchEvent(new dom.window.Event('change'));
  await settle();
  expect(sharePage).toHaveBeenLastCalledWith({ id: 'session-1', target: 'preview', hide: false, lang: 'en' });
  expect($('sharePageCount').hidden).toBe(true);
  hide.checked = true;
  hidden = 1;
  hide.dispatchEvent(new dom.window.Event('change'));
  await settle();
  expect($('sharePageCount').textContent).toBe('1 detail is hidden on this page.');
  hidden = 0;
  hide.dispatchEvent(new dom.window.Event('change'));
  await settle();
  expect($('sharePageCount').textContent).toBe('Nothing to hide was found in this chat.');
});

it('counts a hidden key with personal details shown', async () => {
  await open(vi.fn(async (): Promise<Answer> => page(1)));
  await settle();
  expect($('sharePageCount').textContent).toBe('1 detail is hidden on this page.');
});

it('shows the newest choice when an older preview answers last, and saves only that one', async () => {
  const first = deferred();
  const second = deferred();
  const answers = [first, second];
  const sharePage = vi.fn((request: any) => request.target === 'preview' ? answers.shift()!.promise : new Promise<Answer>(() => undefined));
  await open(sharePage);
  const hide = $<HTMLInputElement>('sharePageHide');
  hide.checked = false;
  hide.dispatchEvent(new dom.window.Event('change'));
  // Nothing can be saved while no page is shown.
  expect($<HTMLButtonElement>('sharePageSave').disabled).toBe(true);
  expect($('sharePagePreview').getAttribute('aria-busy')).toBe('true');
  expect($('sharePageLoading').hidden).toBe(false);
  second.resolve(page(2));
  await settle();
  first.resolve(page(0));
  await settle();
  expect($<HTMLIFrameElement>('sharePageFrame').srcdoc).toContain('<body>2</body>');
  $('sharePageForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await settle();
  expect(sharePage).toHaveBeenLastCalledWith({ id: 'session-1', target: 'file', preview: '00000002-0000-4000-8000-000000000000' });
});

it('keeps the choice locked while saving, and stays open when the save dialog is cancelled', async () => {
  const saving = deferred();
  const sharePage = vi.fn((request: any) => request.target === 'preview' ? Promise.resolve(page(0)) : saving.promise);
  const saved = await open(sharePage);
  await settle();
  $('sharePageForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await settle();
  expect($<HTMLInputElement>('sharePageHide').disabled).toBe(true);
  expect($<HTMLButtonElement>('sharePageSave').disabled).toBe(true);
  // A second press while the save dialog is up saves nothing twice.
  $('sharePageForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  expect(sharePage).toHaveBeenCalledTimes(2);
  saving.resolve({ ok: true, data: { done: 'cancelled' } });
  await settle();
  expect(saved).not.toHaveBeenCalled();
  expect($<HTMLDialogElement>('sharePageDialog').open).toBe(true);
  expect($<HTMLInputElement>('sharePageHide').disabled).toBe(false);
  expect($<HTMLButtonElement>('sharePageSave').disabled).toBe(false);
});

it('gives the focus back to Save after a failed or cancelled save, instead of leaving it nowhere', async () => {
  for (const answer of [{ ok: false as const, error: 'The preview is out of date. Open Share again.' }, { ok: true as const, data: { done: 'cancelled' } }]) {
    const saving = deferred();
    const sharePage = vi.fn((request: any) => request.target === 'preview' ? Promise.resolve(page(0)) : saving.promise);
    await open(sharePage);
    await settle();
    $<HTMLButtonElement>('sharePageSave').focus();
    $('sharePageForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await settle();
    // A browser moves the focus off a button that becomes disabled; jsdom does not, so it is moved here.
    const outside = document.body.appendChild(document.createElement('button'));
    outside.focus();
    expect($('sharePageDialog').contains(document.activeElement)).toBe(false);
    saving.resolve(answer);
    await settle();
    expect($<HTMLDialogElement>('sharePageDialog').open).toBe(true);
    expect(document.activeElement).toBe($('sharePageSave'));
    $('sharePageCancel').click();
  }
});

it('shows why there is no page, in the chosen language, with nothing to save', async () => {
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  const sharePage = vi.fn(async (): Promise<Answer> => ({ ok: false, error: 'This chat has nothing to share yet' }));
  await open(sharePage);
  await settle();
  expect($('sharePageError').hidden).toBe(false);
  expect($('sharePageError').textContent).toBe('In diesem Chat gibt es noch nichts zu teilen');
  expect($('sharePageLoading').hidden).toBe(true);
  expect($<HTMLButtonElement>('sharePageSave').disabled).toBe(true);
  expect($<HTMLIFrameElement>('sharePageFrame').srcdoc).toBe('');
});

it('drops a preview that answers after the dialog was closed, and starts clean when opened again', async () => {
  const late = deferred();
  const sharePage = vi.fn((_request: any) => late.promise);
  const { initSharePage } = await import('../src/renderer/share-page.js');
  const dialog = initSharePage({ sharePage } as any, vi.fn());
  dialog.open('session-1');
  $('sharePageCancel').click();
  expect($<HTMLDialogElement>('sharePageDialog').open).toBe(false);
  late.resolve(page(5));
  await settle();
  expect($<HTMLIFrameElement>('sharePageFrame').srcdoc).toBe('');
  const hide = $<HTMLInputElement>('sharePageHide');
  hide.checked = false;
  sharePage.mockImplementation(async () => page(0));
  dialog.open('session-2');
  expect(hide.checked).toBe(true);
  await settle();
  expect(sharePage).toHaveBeenLastCalledWith({ id: 'session-2', target: 'preview', hide: true, lang: 'en' });
});
