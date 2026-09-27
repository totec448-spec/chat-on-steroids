import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ptPT from '../src/renderer/locales/pt-PT.json';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

it('covers every current catalog key and preserves every numbered argument', () => {
  const keys = new Set(['es', 'zh-CN', 'zh-TW', 'ja', 'tr', 'fr'].flatMap(locale =>
    Object.keys(JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')))));
  expect([...keys].filter(source => !Object.hasOwn(ptPT, source))).toEqual([]);
  const args = (value: string) => (value.match(/\{\d+\}/g) ?? []).sort();
  for (const [source, value] of Object.entries(ptPT)) {
    expect(value.trim(), source).not.toBe('');
    expect(args(value), source).toEqual(args(source));
  }
});

it('keeps every substantive Setup shell string covered by the Portuguese catalog', () => {
  const setup = document.querySelector<HTMLElement>('[data-panel="setup"]')!;
  const missing = new Set<string>();
  const walker = document.createTreeWalker(setup, 4 /* SHOW_TEXT */);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
    const source = node.data.replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]/.test(source) && !Object.hasOwn(ptPT, source)) missing.add(source);
  }
  for (const node of setup.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label]')) {
    if (node.closest('[translate="no"]')) continue;
    for (const property of ['title', 'placeholder', 'aria-label'] as const) {
      const source = node.getAttribute(property)?.trim();
      if (source && /[A-Za-z]/.test(source) && !Object.hasOwn(ptPT, source)) missing.add(source);
    }
  }
  expect([...missing]).toEqual([]);
});

it('restores European Portuguese through setup and settings without changing authored content', async () => {
  window.localStorage.setItem('cos.ui.language', 'pt-PT');
  const { initLanguage, setLanguage, t, ui } = await import('../src/renderer/i18n.js');
  initLanguage();
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  const flag = document.querySelector<HTMLButtonElement>('[data-language="pt-PT"]')!;
  expect(document.documentElement.lang).toBe('pt-PT');
  expect(select.selectedOptions[0]?.textContent).toBe('Português (Portugal)');
  expect(flag.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.setup-heading h1')?.textContent).toBe('Configuração');

  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/review\nO meu rascunho $& <img src=x> 🙂';
  input.focus(); input.setSelectionRange(2, 9);
  const authored = document.createElement('p'); authored.textContent = 'Settings'; document.body.append(authored);
  const action = ui(document.createElement('button'), 'textContent', () => t('Remove {0}', ['<img src=x>']));
  document.body.append(action);
  for (const locale of ['en', 'ja', 'es', 'zh-TW', 'zh-CN', 'tr', 'fr', 'pt-PT'] as const) {
    setLanguage(locale);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 9]);
    expect(input.value).toBe('/review\nO meu rascunho $& <img src=x> 🙂');
    expect(authored.textContent).toBe('Settings');
    expect(select.value).toBe(locale);
    expect(action.querySelector('img')).toBeNull();
  }
  expect(action.textContent).toBe('Remover <img src=x>');
  expect(t('{0}m', [2])).toBe('2 min');
  select.value = 'en'; select.dispatchEvent(new dom.window.Event('change'));
  flag.click();
  expect(select.value).toBe('pt-PT');
  expect(window.localStorage.getItem('cos.ui.language')).toBe('pt-PT');
  vi.resetModules(); expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('pt-PT');
});

it('uses English as the storage fallback and still switches to European Portuguese without storage', async () => {
  vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
  vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  const { initLanguage, setLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
  expect(currentLanguage()).toBe('en');
  initLanguage(); setLanguage('pt-PT');
  expect(currentLanguage()).toBe('pt-PT');
  expect(t('Settings')).toBe('Definições');
  expect(t('unknown /Save/<img src=x>')).toBe('unknown /Save/<img src=x>');
});

it('translates known app failures while preserving unknown provider errors', async () => {
  window.localStorage.setItem('cos.ui.language', 'pt-PT');
  const { run } = await import('../src/renderer/dom.js');
  expect(await run(Promise.resolve({ ok: false, error: 'Secure credential storage is unavailable.' }))).toBeNull();
  expect(document.querySelector('.toast')?.textContent).toBe(ptPT['Secure credential storage is unavailable.']);
  const error = 'PROVIDER: /Save/<img src=x> {0}\n  details';
  expect(await run(Promise.resolve({ ok: false, error }))).toBeNull();
  expect(document.querySelector('.toast')?.textContent).toBe(error);
  expect(document.querySelector('.toast img')).toBeNull();
});
