import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import es from '../src/renderer/locales/es.json';
import zhCN from '../src/renderer/locales/zh-CN.json';
import zhTW from '../src/renderer/locales/zh-TW.json';
import ja from '../src/renderer/locales/ja.json';

const names = { en: 'English', es: 'Español', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語' } as const;
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

describe('Japanese app interface and compact setup languages', () => {
  it('covers the union of existing catalogs, including newer notices, with all arguments preserved', () => {
    const sources = [...new Set([es, zhCN, zhTW].flatMap(catalog => Object.keys(catalog)))].sort();
    expect(sources.filter(source => !Object.hasOwn(ja, source))).toEqual([]);
    for (const [source, translation] of Object.entries(ja)) {
      expect(translation.trim(), source).not.toBe('');
      const args = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
      expect(args(translation), source).toEqual(args(source));
    }
  });

  it('restores Japanese and synchronizes the flags, settings and saved preference in both directions', async () => {
    window.localStorage.setItem('cos.ui.language', 'ja');
    const { initLanguage, currentLanguage } = await import('../src/renderer/i18n.js');
    initLanguage();
    const select = document.getElementById('uiLanguage') as HTMLSelectElement;
    const button = document.querySelector<HTMLButtonElement>('[data-language="ja"]')!;
    expect(currentLanguage()).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
    expect(document.querySelector('.setup-heading h1')!.textContent).toBe('セットアップ');
    expect(select.value).toBe('ja');
    expect(select.selectedOptions[0]!.textContent).toBe('日本語');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    select.value = 'en';
    select.dispatchEvent(new dom.window.Event('change'));
    expect(currentLanguage()).toBe('en');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(select.value).toBe('ja');
    expect(window.localStorage.getItem('cos.ui.language')).toBe('ja');
    vi.resetModules();
    const reloaded = await import('../src/renderer/i18n.js');
    expect(reloaded.currentLanguage()).toBe('ja');
    expect(reloaded.t('Settings')).toBe('設定');
  });

  it('keeps every setup choice flag-only with a native language name and one selected button', async () => {
    const { initLanguage, currentLanguage } = await import('../src/renderer/i18n.js');
    initLanguage();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.language-tabs [data-language]')];
    expect(buttons).toHaveLength(Object.keys(names).length);
    for (const button of buttons) {
      const locale = button.dataset.language as keyof typeof names;
      expect(button.type).toBe('button');
      expect(button.lang).toBe(locale);
      expect(button.textContent).toBe('');
      expect(button.title).toBe(names[locale]);
      expect(button.getAttribute('aria-label')).toBe(names[locale]);
      expect(button.querySelector('svg.language-flag[aria-hidden="true"]')).not.toBeNull();
      button.click();
      expect(currentLanguage()).toBe(locale);
      expect(buttons.filter(node => node.getAttribute('aria-pressed') === 'true')).toEqual([button]);
      expect((document.getElementById('uiLanguage') as HTMLSelectElement).value).toBe(locale);
    }
  });

  it('preserves drafts, focus, literal arguments and untranslated native labels while refreshing Japanese UI', async () => {
    const native = document.createElement('span');
    native.setAttribute('translate', 'no'); native.title = 'Settings'; native.setAttribute('aria-label', 'Save');
    native.textContent = 'Save'; document.body.append(native);
    const { initLanguage, setLanguage, t, ui, uiText } = await import('../src/renderer/i18n.js');
    initLanguage();
    const input = document.getElementById('chatInput') as HTMLTextAreaElement;
    const draft = '/review\n保存しない下書き 🙂 <script>literal</script>';
    input.value = draft; input.focus(); input.setSelectionRange(2, 8);
    const authored = document.createElement('p'); authored.textContent = 'Settings';
    const hidden = document.createElement('div'); hidden.hidden = true;
    const label = uiText(() => t('Settings')); hidden.append(label);
    const argument = '$& /資料/Save <img src=x>';
    const action = ui(document.createElement('button'), 'textContent', () => t('Remove {0}', [argument]));
    document.body.append(authored, hidden, action);
    const icons = [...document.querySelectorAll('svg')];
    for (const locale of ['ja', 'es', 'zh-CN', 'zh-TW', 'en', 'ja'] as const) {
      setLanguage(locale);
      expect(document.getElementById('chatInput')).toBe(input);
      expect(input.value).toBe(draft);
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
      expect(document.activeElement).toBe(input);
      expect([...document.querySelectorAll('svg')]).toEqual(icons);
      expect(authored.textContent).toBe('Settings');
      expect([native.textContent, native.title, native.getAttribute('aria-label')]).toEqual(['Save', 'Settings', 'Save']);
      expect(action.querySelector('img')).toBeNull();
    }
    expect(label.textContent).toBe('設定');
    expect(action.textContent).toBe(`${argument}を取り除く`);
    expect(t('  Settings\n')).toBe('設定');
    expect(t('Remove {0}')).toBe('{0}を取り除く');
    expect(t('unknown source {0}', [argument])).toBe(`unknown source ${argument}`);
    for (const source of ['__proto__', 'toString', 'exec_command', 'gpt-6-astra']) expect(t(source)).toBe(source);
  });

  it('translates app-owned IPC failures while preserving unknown errors and successful replies', async () => {
    window.localStorage.setItem('cos.ui.language', 'ja');
    const { run } = await import('../src/renderer/dom.js');
    expect(await run(Promise.resolve({ ok: false, error: 'Secure credential storage is unavailable.' }))).toBeNull();
    expect(document.querySelector('.toast')?.textContent).toBe(ja['Secure credential storage is unavailable.']);
    const nativeError = 'NATIVE_ERROR: /Save/<img src=x> {0}\n  details';
    expect(await run(Promise.resolve({ ok: false, error: nativeError }))).toBeNull();
    expect(document.querySelector('.toast')?.textContent).toBe(nativeError);
    expect(document.querySelector('.toast img')).toBeNull();
    expect(await run(Promise.resolve({ ok: true, data: 'Settings' }))).toBe('Settings');
    expect(document.querySelectorAll('.toast')).toHaveLength(1);
  });

  it('falls back to English for invalid saved data and can select Japanese when storage fails', async () => {
    window.localStorage.setItem('cos.ui.language', 'invalid');
    expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('en');
    vi.resetModules();
    vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
    vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    const { initLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
    initLanguage();
    document.querySelector<HTMLButtonElement>('[data-language="ja"]')!.click();
    expect(currentLanguage()).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
    expect((document.getElementById('uiLanguage') as HTMLSelectElement).value).toBe('ja');
    expect(t('Settings')).toBe('設定');
  });
});
