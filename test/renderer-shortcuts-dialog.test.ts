import { readdirSync, readFileSync } from 'node:fs';
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
      ['New chat', ['Ctrl+N']],
      ['Settings', ['Ctrl+,']],
      ['Next chat', ['Ctrl+Tab']],
      ['Previous chat', ['Ctrl+Shift+Tab']],
      ['Find in chat', ['Ctrl+F']],
      ['Search settings', ['Ctrl+F']],
      ['Toggle sidebar', ['Ctrl+B']],
      ['Zoom in', ['Ctrl++']],
      ['Zoom out', ['Ctrl+−']],
      ['Actual size', ['Ctrl+0']],
      ['Full screen', ['F11']],
      ['Keyboard shortcuts', ['Ctrl+/']]
    ]],
    ['Sidebar', [['Move the focused chat or project', ['Alt+↑', 'Alt+↓']]]],
    ['Terminal', [
      ['Copy the selection', ['Ctrl+Shift+C']],
      ['Send to chat', ['Ctrl+Shift+Enter']]
    ]],
    ['Message box', [
      ['Send', ['Enter']],
      ['New line', ['Shift+Enter']],
      ['Send the other way while ChatGPT works', ['Ctrl+Shift+Enter']],
      ['Earlier messages, in an empty message box', ['↑', '↓']],
      ['Stop the turn, twice in an empty message box', ['Esc', 'Esc']],
      // Hold-to-talk is Windows only.
      ['Hold to dictate', ['Ctrl+Shift+Space']],
      ['Move a queued task', ['Alt+↑', 'Alt+↓']]
    ]],
    ['Workspace panels', [
      ['Toggle bottom panel', ['Ctrl+`']],
      ['Review', ['Ctrl+Shift+1']],
      ['Terminal', ['Ctrl+Shift+2']],
      ['Files', ['Ctrl+Shift+3']],
      ['Sub-agents', ['Ctrl+Shift+4']],
      ['Move the focused tab', ['Ctrl+Shift+←', 'Ctrl+Shift+→']],
      ['Save the file being edited', ['Ctrl+S']]
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
  expect(keys.get('New chat')).toEqual(['⌘N']);
  expect(keys.get('Settings')).toEqual(['⌘,']);
  expect(keys.get('Save the file being edited')).toEqual(['⌘S']);
  expect(keys.get('Send to chat')).toEqual(['⌘⇧Enter']);
  // Ctrl+Tab is Control on every system, as in browsers.
  expect(keys.get('Next chat')).toEqual(['⌃Tab']);
  // F11 is Show Desktop on a Mac, so full screen is the default View menu's ⌃⌘F there.
  expect(keys.get('Full screen')).toEqual(['⌃⌘F']);
  // Hold-to-talk is Windows only: no row on a Mac.
  expect(keys.has('Hold to dictate')).toBe(false);
  expect(keys.get('New line')).toEqual(['⇧Enter']);
  expect(keys.get('Send the other way while ChatGPT works')).toEqual(['⌘⇧Enter']);
  expect(keys.get('Move the focused chat or project')).toEqual(['⌥↑', '⌥↓']);
  expect(keys.get('Move a queued task')).toEqual(['⌥↑', '⌥↓']);
  // The workspace panels' keys are Control on every system, printed as the empty side panel does.
  expect(keys.get('Review')).toEqual(['⌃⇧1']);
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

it('has a row for every file that handles modifier keys, so a new shortcut cannot be left out', async () => {
  await mount({ platform: 'Win32' });
  const { shortcutGroups } = await import('../src/renderer/shortcuts-dialog.js');
  const rows = shortcutGroups(() => true).flatMap(group => group.rows);
  const sources = new Set(rows.map(row => row.source));
  for (const source of sources) {
    const code = readFileSync(new URL(`../src/${source}`, import.meta.url), 'utf8');
    expect(code, source).toMatch(/keydown|KeyboardEvent|before-input-event/);
  }
  // Files that read a modifier or a physical key without owning a shortcut of their own.
  const guards = new Map([
    ['skills.ts', 'the slash menu only steps aside when a modifier is held']
  ]);
  const renderer = new URL('../src/renderer/', import.meta.url);
  const handlers = readdirSync(renderer).filter(name => name.endsWith('.ts') &&
    /\.(ctrlKey|metaKey|altKey)\b|event\.code\b/.test(readFileSync(new URL(name, renderer), 'utf8')));
  expect(handlers.length).toBeGreaterThan(10);
  const missing = handlers.filter(name => !sources.has(`renderer/${name}`) && !guards.has(name));
  expect(missing, 'add a row to shortcuts-dialog.ts, or name the file in guards with the reason').toEqual([]);
  // The window's own keys (F11, and ⌃⌘F from the default menu on a Mac) are handled in the main process.
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  expect(main).toMatch(/before-input-event/);
  expect(sources.has('main/index.ts')).toBe(true);
});

it('gives the keyboard back to where it was when it closes', async () => {
  const view = await mount({ platform: 'Win32' });
  const input = view.doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.focus();
  view.press({ key: '/', ctrlKey: true }, input);
  expect(view.doc.activeElement?.id).toBe('shortcutsClose');
  view.press({ key: '/', ctrlKey: true });
  expect(view.doc.activeElement).toBe(input);
  // Opened from the View menu button and closed with Escape.
  const button = view.doc.getElementById('viewMenu') as HTMLButtonElement;
  button.focus();
  view.shortcuts.open();
  view.dialog.dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
  expect(view.doc.activeElement).toBe(button);
});

it('gives the keyboard to the View button when the keys open it from a View menu item', async () => {
  const view = await mount({ platform: 'Win32' });
  const button = view.doc.getElementById('viewMenu') as HTMLButtonElement;
  const { openRowMenu } = await import('../src/renderer/row-menu.js');
  openRowMenu({ owner: 'view', anchor: () => button, label: () => 'View', items: () => [{ action: 'zoom', label: () => 'Zoom' }] });
  const item = view.doc.activeElement!;
  expect(item.closest('[role="menu"]')).not.toBeNull();
  view.press({ key: '/', ctrlKey: true }, item);
  expect(view.dialog.open).toBe(true);
  view.press({ key: '/', ctrlKey: true });
  expect(view.doc.activeElement).toBe(button);
});

it('names Ctrl and Shift in the interface language, in every row that has them', async () => {
  const view = await mount({ platform: 'Win32' });
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  view.shortcuts.open();
  const keys = new Map(view.groups().flatMap(([, rows]) => rows as [string, string[]][]));
  expect(keys.get('Nächster Chat')).toEqual(['Strg+Tab']);
  expect(keys.get('Vorheriger Chat')).toEqual(['Strg+Umschalt+Tab']);
  expect(keys.get('Auswahl kopieren')).toEqual(['Strg+Umschalt+C']);
  expect([...keys.values()].flat().filter(key => /Ctrl|Shift/.test(key))).toEqual([]);
  setLanguage('en');
  view.shortcuts.open();
  expect(new Map(view.groups().flatMap(([, rows]) => rows as [string, string[]][])).get('Next chat')).toEqual(['Ctrl+Tab']);
});

it('closes with a Close button worded like every other dialog’s, in the chosen language', async () => {
  const view = await mount({ platform: 'Win32' });
  const { setLanguage } = await import('../src/renderer/i18n.js');
  view.shortcuts.open();
  const close = view.doc.getElementById('shortcutsClose') as HTMLButtonElement;
  expect(close.textContent!.trim()).toBe('Close');
  expect(close.querySelector('.ico')).toBeNull();
  setLanguage('de');
  expect(close.textContent!.trim()).toBe('Schließen');
  setLanguage('en');
});

it('shows the focus ring on the close button when the keys opened the dialog, not when the View menu did', async () => {
  const view = await mount({ platform: 'Win32' });
  const close = view.doc.getElementById('shortcutsClose') as HTMLButtonElement;
  const calls: unknown[] = [];
  const focus = close.focus.bind(close);
  close.focus = (options?: FocusOptions) => { calls.push(options); focus(options); };
  view.press({ key: '/', ctrlKey: true });
  view.press({ key: '/', ctrlKey: true });
  view.shortcuts.open();
  view.shortcuts.open(true);
  expect(calls).toEqual([{ focusVisible: true }, { focusVisible: false }, { focusVisible: true }]);
});

it('stays closed over a role="dialog" picker that is open, and opens once it is gone', async () => {
  const view = await mount({ platform: 'Win32' });
  // The context meter keeps a role="dialog" element in the page while it is closed.
  expect(view.doc.querySelector('#contextMeterInfo[role="dialog"]')).not.toBeNull();
  const trigger = view.doc.createElement('button');
  view.doc.body.append(trigger);
  const { createSearchPopup } = await import('../src/renderer/search-popup.js');
  const picker = createSearchPopup({
    trigger: () => trigger, className: 'test-picker', label: () => 'Pick', placeholder: () => 'Search',
    choices: () => [], empty: () => 'Nothing'
  });
  picker.show();
  expect(view.doc.activeElement?.closest('[role="dialog"]')).not.toBeNull();
  expect(view.press({ key: '/', ctrlKey: true }, view.doc.activeElement!)).toBe(true);
  expect(view.dialog.open).toBe(false);
  picker.close(true);
  expect(view.press({ key: '/', ctrlKey: true }, view.doc.activeElement!)).toBe(false);
  expect(view.dialog.open).toBe(true);
});
