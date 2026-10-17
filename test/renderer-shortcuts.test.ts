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

// The composer's key hints in Settings name this computer's keys only (2026-10-16): Windows read
// "⌘⇧Enter (Ctrl+Shift+Enter on Windows and Linux)", a Mac symbol first.
it('labels Shift shortcuts per keyboard and language, and the hints mix no platforms', async () => {
  const dom = new JSDOM('');
  vi.stubGlobal('document', dom.window.document);
  const { setLanguage, t } = await import('../src/renderer/i18n.js');
  const { primaryShiftShortcut } = await import('../src/renderer/shortcuts.js');
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  expect(primaryShiftShortcut('Enter')).toBe('⌘⇧Enter');
  vi.stubGlobal('navigator', { platform: 'Win32' });
  expect(primaryShiftShortcut('Enter')).toBe('Ctrl+Shift+Enter');
  setLanguage('de');
  expect(primaryShiftShortcut(t('Enter'))).toBe('Strg+Umschalt+Enter');
  setLanguage('fr');
  expect(t('What a message you send while ChatGPT works does by default. {0} sends it the other way.', [primaryShiftShortcut(t('Enter'))])).toContain('Ctrl+Maj+Entrée');
  setLanguage('en');
  dom.window.close();
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  for (const id of ['followUpHint', 'enterSendsHint', 'enterSendsModifier']) expect(html).toContain(`id="${id}"`);
  const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  for (const id of ['followUpHint', 'enterSendsHint', 'enterSendsModifier']) expect(main).toContain(`$('${id}')`);
});
