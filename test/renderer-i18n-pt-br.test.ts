import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import es from '../src/renderer/locales/es.json';
import fr from '../src/renderer/locales/fr.json';
import ja from '../src/renderer/locales/ja.json';
import ptBR from '../src/renderer/locales/pt-BR.json';
import tr from '../src/renderer/locales/tr.json';
import zhCN from '../src/renderer/locales/zh-CN.json';
import zhTW from '../src/renderer/locales/zh-TW.json';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

it('covers the exact current source-key union with unique entries and preserved numbered arguments', () => {
  const sourceKeys = new Set([es, zhCN, zhTW, ja, tr, fr].flatMap(catalog => Object.keys(catalog)));
  expect(Object.keys(ptBR).sort()).toEqual([...sourceKeys].sort());

  const source = readFileSync('src/renderer/locales/pt-BR.json', 'utf8');
  const keys = [...source.matchAll(/^\s{2}("(?:[^"\\]|\\.)*")\s*:/gm)]
    .map(match => JSON.parse(match[1]!));
  expect(keys).toHaveLength(Object.keys(ptBR).length);
  expect(keys.length).toBe(new Set(keys).size);

  const args = (value: string) => (value.match(/\{\d+\}/g) ?? []).sort();
  for (const [english, translation] of Object.entries(ptBR)) {
    expect(translation.trim(), english).not.toBe('');
    expect(args(translation), english).toEqual(args(english));
  }
});

it('keeps every substantive Setup label and accessible name in the Brazilian Portuguese catalog', () => {
  const setup = document.querySelector<HTMLElement>('[data-panel="setup"]')!;
  const missing = new Set<string>();
  const walker = document.createTreeWalker(setup, 4 /* SHOW_TEXT */);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
    const source = node.data.replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]/.test(source) && !Object.hasOwn(ptBR, source)) missing.add(source);
  }
  for (const node of setup.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label]')) {
    if (node.closest('[translate="no"]')) continue;
    for (const property of ['title', 'placeholder', 'aria-label'] as const) {
      const source = node.getAttribute(property)?.trim();
      if (source && /[A-Za-z]/.test(source) && !Object.hasOwn(ptBR, source)) missing.add(source);
    }
  }
  expect([...missing]).toEqual([]);
});

it('restores pt-BR in Setup and Appearance with one preference and Brazilian wording', async () => {
  window.localStorage.setItem('cos.ui.language', 'pt-BR');
  const { initLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
  initLanguage();

  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  const flag = document.querySelector<HTMLButtonElement>('[data-language="pt-BR"]')!;
  expect(currentLanguage()).toBe('pt-BR');
  expect(document.documentElement.lang).toBe('pt-BR');
  expect(select.value).toBe('pt-BR');
  expect(select.selectedOptions[0]?.textContent).toBe('Português (Brasil)');
  expect(flag.textContent.trim()).toBe('');
  expect(flag.lang).toBe('pt-BR');
  expect(flag.title).toBe('Português (Brasil)');
  expect(flag.getAttribute('aria-label')).toBe('Português (Brasil)');
  expect(flag.getAttribute('aria-pressed')).toBe('true');
  expect(flag.querySelector('svg.language-flag[aria-hidden="true"]')).not.toBeNull();
  expect(document.querySelector('.setup-heading h1')?.textContent).toBe(ptBR['Setup']);

  expect(t('Settings')).toBe('Configurações');
  expect(t('Save')).toBe('Salvar');
  expect(t('File')).toBe('Arquivo');

  select.value = 'en';
  select.dispatchEvent(new dom.window.Event('change'));
  expect(flag.getAttribute('aria-pressed')).toBe('false');
  flag.click();
  expect(select.value).toBe('pt-BR');
  expect(flag.getAttribute('aria-pressed')).toBe('true');
  expect(window.localStorage.getItem('cos.ui.language')).toBe('pt-BR');

  vi.resetModules();
  const reloaded = await import('../src/renderer/i18n.js');
  expect(reloaded.currentLanguage()).toBe('pt-BR');
  expect(reloaded.t('Settings')).toBe('Configurações');
});

it('switches all app languages without replacing authored drafts, focus, selection or literal arguments', async () => {
  const { initLanguage, setLanguage, t, ui } = await import('../src/renderer/i18n.js');
  initLanguage();
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  const draft = '/review\nMeu rascunho $& <img src=x> 🙂';
  input.value = draft;
  input.focus(); input.setSelectionRange(2, 9);

  const authored = document.createElement('p'); authored.textContent = 'Save';
  const argument = '$& /Save/<img src=x> 🙂';
  const action = ui(document.createElement('button'), 'textContent', () => t('Remove {0}', [argument]));
  document.body.append(authored, action);
  const icons = [...document.querySelectorAll('svg')];

  for (const locale of ['en', 'es', 'zh-CN', 'zh-TW', 'ja', 'tr', 'fr', 'pt-BR'] as const) {
    setLanguage(locale);
    expect(document.documentElement.lang).toBe(locale);
    expect((document.getElementById('uiLanguage') as HTMLSelectElement).value).toBe(locale);
    expect(document.getElementById('chatInput')).toBe(input);
    expect(input.value).toBe(draft);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 9]);
    expect(document.activeElement).toBe(input);
    expect([...document.querySelectorAll('svg')]).toEqual(icons);
    expect(authored.textContent).toBe('Save');
    expect(action.querySelector('img')).toBeNull();
  }

  expect(action.textContent).toBe(ptBR['Remove {0}']!.replace(/\{0\}/g, () => argument));
  expect(t('Remove {0}')).toBe(ptBR['Remove {0}']);
  expect(t('unknown /Save/<img src=x> {0}', [argument])).toBe(`unknown /Save/<img src=x> ${argument}`);
  expect(t('exec_command')).toBe('exec_command');
  expect(t('gpt-6-astra')).toBe('gpt-6-astra');
});

it('keeps English for pt-PT or unavailable storage and still switches to pt-BR in memory', async () => {
  window.localStorage.setItem('cos.ui.language', 'pt-PT');
  expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('en');

  vi.resetModules();
  vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
  vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  const { initLanguage, setLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
  initLanguage(); setLanguage('pt-BR');
  expect(currentLanguage()).toBe('pt-BR');
  expect(document.documentElement.lang).toBe('pt-BR');
  expect(t('Settings')).toBe('Configurações');
  expect(t('unknown /Save/<img src=x>')).toBe('unknown /Save/<img src=x>');
});

it('translates known app errors while preserving unknown provider errors as literal text', async () => {
  window.localStorage.setItem('cos.ui.language', 'pt-BR');
  const { run } = await import('../src/renderer/dom.js');
  expect(await run(Promise.resolve({ ok: false, error: 'Secure credential storage is unavailable.' }))).toBeNull();
  expect(document.querySelector('.toast')?.textContent).toBe(ptBR['Secure credential storage is unavailable.']);

  const error = 'PROVIDER: /Save/<img src=x> {0}\n  details';
  expect(await run(Promise.resolve({ ok: false, error }))).toBeNull();
  expect(document.querySelector('.toast')?.textContent).toBe(error);
  expect(document.querySelector('.toast img')).toBeNull();
});
