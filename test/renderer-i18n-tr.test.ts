import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import tr from '../src/renderer/locales/tr.json';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

it('covers the current catalogs and preserves every numbered argument', () => {
  const keys = new Set(['es', 'zh-CN', 'zh-TW', 'ja'].flatMap(locale =>
    Object.keys(JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')))));
  expect([...keys].filter(source => !Object.hasOwn(tr, source))).toEqual([]);
  const args = (value: string) => (value.match(/\{\d+\}/g) ?? []).sort();
  for (const [source, value] of Object.entries(tr)) {
    expect(value.trim(), source).not.toBe('');
    expect(args(value), source).toEqual(args(source));
  }
});

it('restores Turkish and synchronizes both selectors without changing drafts, focus or authored content', async () => {
  window.localStorage.setItem('cos.ui.language', 'tr');
  const { initLanguage, setLanguage, t } = await import('../src/renderer/i18n.js');
  initLanguage();
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  const flag = document.querySelector<HTMLButtonElement>('[data-language="tr"]')!;
  expect(document.documentElement.lang).toBe('tr');
  expect(document.querySelector('.setup-heading h1')?.textContent).toBe('Kurulum');
  expect(select.selectedOptions[0]?.textContent).toBe('Türkçe');
  expect(flag.getAttribute('aria-pressed')).toBe('true');
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/review\nİşlenmemiş taslak $& <img src=x> 🙂';
  input.focus(); input.setSelectionRange(2, 9);
  const authored = document.createElement('p'); authored.textContent = 'Settings'; document.body.append(authored);
  for (const locale of ['en', 'ja', 'es', 'zh-TW', 'zh-CN', 'fr', 'pt-PT', 'tr'] as const) {
    setLanguage(locale);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 9]);
    expect(input.value).toBe('/review\nİşlenmemiş taslak $& <img src=x> 🙂');
    expect(authored.textContent).toBe('Settings');
    expect(select.value).toBe(locale);
  }
  expect(t('Remove {0}', ['$& /資料/Save <img src=x>'])).toBe('Kaldır: $& /資料/Save <img src=x>');
  select.value = 'en'; select.dispatchEvent(new dom.window.Event('change'));
  flag.click();
  expect(window.localStorage.getItem('cos.ui.language')).toBe('tr');
  vi.resetModules(); expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('tr');
});

it('matches both Turkish I pairs when filtering complete settings sections', async () => {
  window.localStorage.setItem('cos.ui.language', 'tr');
  const { filterSettingsSections } = await import('../src/renderer/dom.js');
  const view = document.createElement('section');
  view.innerHTML = '<h2 class="settings-section-title">İzinler</h2><div class="pane">IŞIK</div><p id="settingsSearchEmpty"></p>';
  for (const query of ['izinler', 'İZİNLER', 'ışık', 'IŞIK']) {
    filterSettingsSections(view, query);
    expect(view.querySelector<HTMLElement>('.pane')!.hidden).toBe(false);
    expect(view.querySelector<HTMLElement>('h2')!.hidden).toBe(false);
  }
  filterSettingsSections(view, 'missing');
  expect(view.querySelector<HTMLElement>('.pane')!.hidden).toBe(true);
  expect(view.querySelector<HTMLElement>('#settingsSearchEmpty')!.hidden).toBe(false);
});

it('translates known failures while retaining unknown provider errors and literal duration arguments', async () => {
  window.localStorage.setItem('cos.ui.language', 'tr');
  const { run } = await import('../src/renderer/dom.js');
  const { t } = await import('../src/renderer/i18n.js');
  expect(await run(Promise.resolve({ ok: false, error: 'Secure credential storage is unavailable.' }))).toBeNull();
  expect(document.querySelector('.toast')?.textContent).toBe(tr['Secure credential storage is unavailable.']);
  const error = 'PROVIDER: /Save/<img src=x> {0}\n  details';
  expect(await run(Promise.resolve({ ok: false, error }))).toBeNull();
  expect(document.querySelector('.toast')?.textContent).toBe(error);
  expect(document.querySelector('.toast img')).toBeNull();
  expect(t('{0} for {1}{2}s', [t('Worked'), `${t('{0}m', [1])} `, 5])).toBe('1 dk 5 sn · Çalıştı');
});
