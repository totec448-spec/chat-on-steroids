import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
});
afterEach(() => { vi.unstubAllGlobals(); dom.window.close(); });

async function start(platform: string, settingsShown = () => false) {
  vi.stubGlobal('navigator', { platform });
  const doc = dom.window.document;
  const pressed: string[] = [];
  const newChat = doc.getElementById('newChat')!;
  const settings = doc.getElementById('workspaceSettings')!;
  newChat.addEventListener('click', () => pressed.push('new chat'));
  settings.addEventListener('click', () => pressed.push('settings'));
  const { initAppShortcuts } = await import('../src/renderer/app-shortcuts.js');
  initAppShortcuts({ newChat, settings, settingsShown });
  const press = (key: string, init: KeyboardEventInit = {}, target: Element = doc.body) => {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { doc, pressed, press, newChat, settings };
}

// Codex starts a new chat with ⌘N and opens Settings with ⌘,; CoS had neither (backlog #10).
it('starts a new chat with Ctrl+N and opens Settings with Ctrl+, on Windows and Linux', async () => {
  const { pressed, press, newChat, settings } = await start('Win32');
  expect(press('n', { ctrlKey: true })).toBe(true);
  expect(press(',', { ctrlKey: true })).toBe(true);
  expect(pressed).toEqual(['new chat', 'settings']);
  // ⌘ is not the primary key here, and Shift or Alt make it another shortcut.
  for (const init of [{ metaKey: true }, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }, {}]) press('n', init);
  expect(pressed).toHaveLength(2);
  expect(newChat.title).toBe('New chat (Ctrl+N)');
  expect(settings.title).toBe('Settings (Ctrl+,)');
});

it('uses ⌘ on macOS, where Ctrl+N moves the caret down a line', async () => {
  const { pressed, press, newChat, settings } = await start('MacIntel');
  expect(press('n', { ctrlKey: true })).toBe(false);
  press('N', { metaKey: true });
  press(',', { metaKey: true });
  expect(pressed).toEqual(['new chat', 'settings']);
  expect([newChat.title, settings.title]).toEqual(['New chat (⌘N)', 'Settings (⌘,)']);
});

it('leaves the terminal, the file editor and open dialogs their keys', async () => {
  const { doc, pressed, press } = await start('Win32');
  const terminal = doc.body.appendChild(doc.createElement('div'));
  terminal.className = 'xterm';
  const editor = doc.body.appendChild(doc.createElement('div'));
  editor.className = 'cm-editor';
  editor.innerHTML = '<div class="cm-content" contenteditable="true"></div>';
  const dialog = doc.body.appendChild(doc.createElement('dialog'));
  dialog.innerHTML = '<button>Allow</button>';
  for (const target of [terminal, editor.firstElementChild!, dialog.firstElementChild!]) {
    expect(press('n', { ctrlKey: true }, target)).toBe(false);
    expect(press(',', { ctrlKey: true }, target)).toBe(false);
  }
  expect(pressed).toEqual([]);
});

// The base-branch and project pickers (search-popup.ts) are role="dialog" popups, not <dialog>s.
it('leaves a picker its keys while it has the focus', async () => {
  const { doc, pressed, press } = await start('Win32');
  const picker = doc.body.appendChild(doc.createElement('div'));
  picker.setAttribute('role', 'dialog');
  picker.innerHTML = '<input type="search">';
  expect(press('n', { ctrlKey: true }, picker.firstElementChild!)).toBe(false);
  expect(press(',', { ctrlKey: true }, picker.firstElementChild!)).toBe(false);
  expect(pressed).toEqual([]);
});

it('starts one chat while the key is held, and keeps an open Settings page where it is', async () => {
  let shown = false;
  const { pressed, press } = await start('Win32', () => shown);
  press('n', { ctrlKey: true });
  expect(press('n', { ctrlKey: true, repeat: true })).toBe(true);
  shown = true;
  expect(press(',', { ctrlKey: true })).toBe(true);
  expect(pressed).toEqual(['new chat']);
});

it('is installed on the sidebar buttons at startup', () => {
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  expect(main).toMatch(/initAppShortcuts\(\{\s*newChat: \$\('newChat'\),\s*settings: \$\('workspaceSettings'\)/);
});
