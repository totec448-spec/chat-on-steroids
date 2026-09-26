import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fr from '../src/renderer/locales/fr.json';
import tr from '../src/renderer/locales/tr.json';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

it('covers every current catalog key and preserves numbered arguments in French', () => {
  const keys = new Set([
    ...Object.keys(tr),
    ...['es', 'zh-CN', 'zh-TW', 'ja'].flatMap((locale) =>
      Object.keys(JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8'))),
    ),
  ]);
  expect([...keys].filter((source) => !Object.hasOwn(fr, source))).toEqual([]);
  const args = (value: string) => (value.match(/\{\d+\}/g) ?? []).sort();
  for (const [source, value] of Object.entries(fr)) {
    expect(value.trim(), source).not.toBe('');
    expect(args(value), source).toEqual(args(source));
  }
});

it('restores French through both selectors and keeps drafts, focus and authored text across languages', async () => {
  window.localStorage.setItem('cos.ui.language', 'fr');
  const { initLanguage, setLanguage, t, ui } = await import('../src/renderer/i18n.js');
  initLanguage();
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  const flag = document.querySelector<HTMLButtonElement>('[data-language="fr"]')!;
  expect(document.documentElement.lang).toBe('fr');
  expect(select.selectedOptions[0]?.textContent).toBe('Français');
  expect(flag.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.setup-heading h1')?.textContent).toBe('Connexion');
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/review\nMon brouillon $& <img src=x> 🙂';
  input.focus(); input.setSelectionRange(2, 9);
  const authored = document.createElement('p'); authored.textContent = 'Settings'; document.body.append(authored);
  const action = ui(document.createElement('button'), 'textContent', () => t('Remove {0}', ['<img src=x>']));
  document.body.append(action);
  for (const locale of ['en', 'ja', 'es', 'zh-TW', 'zh-CN', 'tr', 'fr'] as const) {
    setLanguage(locale);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 9]);
    expect(input.value).toBe('/review\nMon brouillon $& <img src=x> 🙂');
    expect(authored.textContent).toBe('Settings');
    expect(select.value).toBe(locale);
    expect(action.querySelector('img')).toBeNull();
  }
  expect(action.textContent).toBe('Retirer <img src=x>');
  expect(t('{0}m', [2])).toBe('2 min');
  select.value = 'en'; select.dispatchEvent(new dom.window.Event('change'));
  flag.click();
  expect(select.value).toBe('fr');
  expect(window.localStorage.getItem('cos.ui.language')).toBe('fr');
  vi.resetModules(); expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('fr');
});

it('leaves the default unchanged and can switch to French when preference storage fails', async () => {
  vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
  vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  const { initLanguage, setLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
  expect(currentLanguage()).toBe('en');
  initLanguage(); setLanguage('fr');
  expect(currentLanguage()).toBe('fr');
  expect(t('Settings')).toBe('Paramètres');
  expect(t('unknown /Save/<img src=x>')).toBe('unknown /Save/<img src=x>');
});
