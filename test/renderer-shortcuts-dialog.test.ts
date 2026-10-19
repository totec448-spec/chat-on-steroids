import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(options: { platform: string; enterSends?: boolean }) {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', { platform: options.platform });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const doc = dom.window.document;
  let enterSends = options.enterSends ?? true;
  const { initShortcutsDialog } = await import('../src/renderer/shortcuts-dialog.js');
  const shortcuts = initShortcutsDialog({ enterSends: () => enterSends });
  const dialog = doc.getElementById('shortcutsDialog') as HTMLDialogElement;
  const press = (init: KeyboardEventInit, target: Element = doc.body) =>
    target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const groups = () => [...dialog.querySelectorAll('.shortcuts-group')].map(group => [
    group.querySelector('h3')!.textContent,
    [...group.querySelectorAll('dt')].map(term => [term.textContent, [...term.nextElementSibling!.querySelectorAll('kbd')].map(key => key.textContent)])
  ]);
  return { doc, dialog, shortcuts, press, groups, setEnterSends: (value: boolean) => { enterSends = value; } };
}

it('opens with Ctrl+/, lists only the keys the app handles as this keyboard prints them, and the same keys close it', async () => {
  const view = await mount({ platform: 'Win32' });
  expect(view.dialog.open).toBe(false);
  expect(view.press({ key: '/', ctrlKey: true })).toBe(false);
  expect(view.dialog.open).toBe(true);
  expect(view.doc.activeElement?.id).toBe('shortcutsClose');
  expect(view.groups()).toEqual([
    ['General', [
      ['Search chats', ['Ctrl+K']],
      ['Find in chat', ['Ctrl+F']],
      ['Search settings', ['Ctrl+F']],
      ['Toggle sidebar', ['Ctrl+B']],
      ['Zoom in', ['Ctrl++']],
      ['Zoom out', ['Ctrl+−']],
      ['Actual size', ['Ctrl+0']],
      ['Keyboard shortcuts', ['Ctrl+/']]
    ]],
    ['Sidebar', [['Move the focused chat or project', ['Alt+↑', 'Alt+↓']]]],
    ['Message box', [
      ['Send', ['Enter']],
      ['New line', ['Shift+Enter']],
      ['Send the other way while ChatGPT works', ['Ctrl+Shift+Enter']],
      ['Earlier messages, in an empty message box', ['↑', '↓']]
    ]],
    ['Workspace panels', [
      ['Toggle bottom panel', ['Ctrl+`']],
      ['Review', ['Ctrl+Shift+1']],
      ['Terminal', ['Ctrl+Shift+2']],
      ['Files', ['Ctrl+Shift+3']],
      ['Sub-agents', ['Ctrl+Shift+4']]
    ]]
  ]);
  view.press({ key: '/', ctrlKey: true });
  expect(view.dialog.open).toBe(false);
  // Keyboards that need Shift for "/" (German Shift+7) still give "/" as the key.
  view.press({ key: '/', ctrlKey: true, shiftKey: true });
  expect(view.dialog.open).toBe(true);
});

it('uses ⌘ on a Mac, where Ctrl+/ is not the shortcut', async () => {
  const view = await mount({ platform: 'MacIntel' });
  view.press({ key: '/', ctrlKey: true });
  expect(view.dialog.open).toBe(false);
  view.press({ key: '/', metaKey: true });
  expect(view.dialog.open).toBe(true);
  const keys = new Map(view.groups().flatMap(([, rows]) => rows as [string, string[]][]));
  expect(keys.get('Search chats')).toEqual(['⌘K']);
  expect(keys.get('New line')).toEqual(['⇧Enter']);
  expect(keys.get('Send the other way while ChatGPT works')).toEqual(['⌘⇧Enter']);
  expect(keys.get('Move the focused chat or project')).toEqual(['⌥↑', '⌥↓']);
  // The workspace panels' keys are Ctrl on every system.
  expect(keys.get('Review')).toEqual(['Ctrl+Shift+1']);
});

it('follows the Enter setting each time it opens, and closes with Escape, its button or the backdrop', async () => {
  const view = await mount({ platform: 'Win32', enterSends: false });
  view.shortcuts.open();
  let keys = new Map(view.groups().flatMap(([, rows]) => rows as [string, string[]][]));
  expect([keys.get('Send'), keys.get('New line')]).toEqual([['Ctrl+Enter'], ['Enter']]);
  view.dialog.dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
  expect(view.dialog.open).toBe(false);
  view.setEnterSends(true);
  view.shortcuts.open();
  keys = new Map(view.groups().flatMap(([, rows]) => rows as [string, string[]][]));
  expect([keys.get('Send'), keys.get('New line')]).toEqual([['Enter'], ['Shift+Enter']]);
  (view.doc.getElementById('shortcutsClose') as HTMLButtonElement).click();
  expect(view.dialog.open).toBe(false);
  view.shortcuts.open();
  view.dialog.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  expect(view.dialog.open).toBe(false);
});

it('leaves the terminal and the file editor their keys, and another open dialog in front', async () => {
  const view = await mount({ platform: 'Win32' });
  // The file editor (CodeMirror) comments a line out with the same keys.
  for (const owner of ['xterm', 'cm-editor']) {
    const host = view.doc.createElement('div');
    host.className = owner;
    const field = view.doc.createElement('textarea');
    host.append(field); view.doc.body.append(host);
    expect(view.press({ key: '/', ctrlKey: true }, field), owner).toBe(true);
    expect(view.dialog.open, owner).toBe(false);
  }
  const search = view.doc.getElementById('searchDialog') as HTMLDialogElement;
  search.showModal();
  view.press({ key: '/', ctrlKey: true });
  expect(view.dialog.open).toBe(false);
  search.close();
  // Alt or a held key does nothing.
  view.press({ key: '/', ctrlKey: true, altKey: true });
  view.press({ key: '/', ctrlKey: true, repeat: true });
  expect(view.dialog.open).toBe(false);
});
