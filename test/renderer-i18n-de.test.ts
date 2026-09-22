import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import de from '../src/renderer/locales/de.json';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

it('covers all current locale keys and preserves numbered arguments', () => {
  const keys = new Set(['es', 'zh-CN', 'zh-TW', 'ja', 'tr', 'fr'].flatMap(locale =>
    Object.keys(JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')))));
  expect([...keys].filter(source => !Object.hasOwn(de, source))).toEqual([]);
  const args = (value: string) => (value.match(/\{\d+\}/g) ?? []).sort();
  for (const [source, value] of Object.entries(de)) {
    expect(value.trim(), source).not.toBe('');
    expect(args(value), source).toEqual(args(source));
  }
});

it('restores German through both selectors and preserves drafts, focus and authored text across languages', async () => {
  window.localStorage.setItem('cos.ui.language', 'de');
  const { initLanguage, setLanguage, t, ui } = await import('../src/renderer/i18n.js');
  initLanguage();
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  const flag = document.querySelector<HTMLButtonElement>('[data-language="de"]')!;
  expect(document.documentElement.lang).toBe('de');
  expect(select.selectedOptions[0]?.textContent).toBe('Deutsch');
  expect(flag.getAttribute('aria-pressed')).toBe('true');
  expect(flag.getAttribute('aria-label')).toBe('Deutsch');
  expect(flag.title).toBe('Deutsch');
  expect(document.querySelector('.setup-heading h1')?.textContent).toBe('Einrichtung');
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/review\nMein Entwurf $& <img src=x> 🙂';
  input.focus(); input.setSelectionRange(2, 9);
  const authored = document.createElement('p'); authored.textContent = 'Settings'; document.body.append(authored);
  const action = ui(document.createElement('button'), 'textContent', () => t('Remove {0}', ['<img src=x>']));
  document.body.append(action);
  for (const locale of ['en', 'ja', 'es', 'zh-TW', 'zh-CN', 'tr', 'fr', 'de'] as const) {
    setLanguage(locale);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 9]);
    expect(input.value).toBe('/review\nMein Entwurf $& <img src=x> 🙂');
    expect(authored.textContent).toBe('Settings');
    expect(select.value).toBe(locale);
    expect(action.querySelector('img')).toBeNull();
  }
  expect(action.textContent).toBe(de['Remove {0}'].replace('{0}', '<img src=x>'));
  select.value = 'en'; select.dispatchEvent(new dom.window.Event('change'));
  flag.click();
  expect(select.value).toBe('de');
  expect(window.localStorage.getItem('cos.ui.language')).toBe('de');
  vi.resetModules(); expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('de');
});

it('keeps English as the default and can switch to German when preference storage fails', async () => {
  vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
  vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  const { initLanguage, setLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
  expect(currentLanguage()).toBe('en');
  initLanguage(); setLanguage('de');
  expect(currentLanguage()).toBe('de');
  expect(t('Settings')).toBe('Einstellungen');
  expect(t('unknown /Save/<img src=x>')).toBe('unknown /Save/<img src=x>');
});
