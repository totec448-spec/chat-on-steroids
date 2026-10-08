import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); });

it('labels the primary shortcuts as this keyboard prints them, in the language', async () => {
  const dom = new JSDOM('');
  vi.stubGlobal('document', dom.window.document);
  const { setLanguage } = await import('../src/renderer/i18n.js');
  const { primaryShortcut } = await import('../src/renderer/shortcuts.js');

  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  expect(primaryShortcut('B')).toBe('⌘B');
  vi.stubGlobal('navigator', { platform: 'Win32' });
  expect([primaryShortcut('K'), primaryShortcut('+')]).toEqual(['Ctrl+K', 'Ctrl++']);
  setLanguage('de');
  expect(primaryShortcut('K')).toBe('Strg+K');
  setLanguage('en');
  dom.window.close();
});
