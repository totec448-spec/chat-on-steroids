/** aliceric27's #243 combined with the current catalogs and draft-preserving label owner. */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import zhTW from '../src/renderer/locales/zh-TW.json';
import zhCN from '../src/renderer/locales/zh-CN.json';

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.resetModules(); });
it('covers every current source key with matching placeholders and no duplicate keys', () => {
  const missing = Object.keys(zhCN).filter(key => !Object.hasOwn(zhTW, key));
  expect(missing).toEqual([]);
  for (const locale of ['es', 'zh-CN', 'zh-TW', 'ja', 'tr', 'fr']) {
    const source = readFileSync(`src/renderer/locales/${locale}.json`, 'utf8');
    const keys = [...source.matchAll(/^\s{2}("(?:[^"\\]|\\.)*")\s*:/gm)].map(match => JSON.parse(match[1]!));
    expect(keys.length).toBe(new Set(keys).size);
  }
  for (const [source, translation] of Object.entries(zhTW)) {
    expect(translation.trim(), source).not.toBe('');
    const args = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
    expect(args(translation), source).toEqual(args(source));
  }
});
it('restores Traditional Chinese and switches all languages without changing authored content', async () => {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
  window.localStorage.setItem('cos.ui.language', 'zh-TW');
  const { initLanguage, setLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
  initLanguage();
  expect(currentLanguage()).toBe('zh-TW');
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/review\n保留我的草稿 🙂'; input.focus(); input.setSelectionRange(2, 5);
  const button = document.querySelector<HTMLButtonElement>('[data-language="zh-TW"]')!;
  expect(button.textContent).toBe(''); expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.getAttribute('aria-label')).toBe('繁體中文'); expect(button.title).toBe('繁體中文');
  for (const locale of ['es', 'zh-CN', 'ja', 'tr', 'fr', 'en', 'zh-TW'] as const) {
    setLanguage(locale);
    expect((document.getElementById('uiLanguage') as HTMLSelectElement).value).toBe(locale);
    expect(input.value).toBe('/review\n保留我的草稿 🙂');
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
    expect(document.activeElement).toBe(input);
  }
  expect(t('Projects')).toBe('專案'); expect(t('Personal')).toBe('個人'); expect(t('Import package')).toBe('匯入技能套件');
  expect(window.localStorage.getItem('cos.ui.language')).toBe('zh-TW');
  vi.resetModules(); expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('zh-TW');
});
