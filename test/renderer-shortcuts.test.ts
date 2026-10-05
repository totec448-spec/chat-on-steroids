import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); });

it('labels the primary shortcuts as this keyboard prints them, and follows the language', async () => {
  const dom = new JSDOM('<kbd data-shortcut="K">Ctrl+K</kbd><kbd data-shortcut="+">Ctrl++</kbd><kbd>Ctrl+Shift+1</kbd>');
  vi.stubGlobal('document', dom.window.document);
  const { setLanguage } = await import('../src/renderer/i18n.js');
  const { labelPrimaryShortcuts, primaryShortcut } = await import('../src/renderer/shortcuts.js');
  const labels = () => [...dom.window.document.querySelectorAll('kbd')].map(node => node.textContent);

  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  expect(primaryShortcut('B')).toBe('⌘B');
  vi.stubGlobal('navigator', { platform: 'Win32' });
  labelPrimaryShortcuts(dom.window.document);
  // The workspace panels' Ctrl+Shift shortcuts are Ctrl on every system and keep their label.
  expect(labels()).toEqual(['Ctrl+K', 'Ctrl++', 'Ctrl+Shift+1']);
  setLanguage('de');
  expect(labels()).toEqual(['Strg+K', 'Strg++', 'Ctrl+Shift+1']);
  setLanguage('en');
  expect(labels()).toEqual(['Ctrl+K', 'Ctrl++', 'Ctrl+Shift+1']);
});
