import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import es from '../src/renderer/locales/es.json';
import zhCN from '../src/renderer/locales/zh-CN.json';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

describe('Spanish app interface', () => {
  it('covers the complete source catalog and preserves every numbered argument', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(zhCN).sort());
    for (const [source, translation] of Object.entries(es)) {
      expect(translation.trim(), source).not.toBe('');
      const args = (value: string) => (value.match(/\{\d+\}/g) ?? []).sort();
      expect(args(translation), source).toEqual(args(source));
    }
  });

  it('synchronizes Spanish in setup and settings and restores the saved choice', async () => {
    window.localStorage.setItem('cos.ui.language', 'es');
    const { initLanguage, currentLanguage } = await import('../src/renderer/i18n.js');
    initLanguage();
    const button = document.querySelector<HTMLButtonElement>('[data-language="es"]')!;
    const select = document.getElementById('uiLanguage') as HTMLSelectElement;
    expect(button.closest('[data-panel="setup"]')).not.toBeNull();
    expect(button.textContent).toBe('Español');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(select.value).toBe('es');
    expect(currentLanguage()).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    expect(document.querySelector('.setup-heading h1')!.textContent).toBe('Conexión');
    select.value = 'en';
    select.dispatchEvent(new dom.window.Event('change'));
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(select.value).toBe('es');
    expect(window.localStorage.getItem('cos.ui.language')).toBe('es');
    vi.resetModules();
    const reloaded = await import('../src/renderer/i18n.js');
    expect(reloaded.currentLanguage()).toBe('es');
    expect(reloaded.t('Settings')).toBe('Ajustes');
  });

  it('keeps English as the default for existing and fresh installs until Spanish is selected', async () => {
    const first = await import('../src/renderer/i18n.js');
    expect(first.currentLanguage()).toBe('en');
    expect(window.localStorage.getItem('cos.ui.language')).toBeNull();
    first.setLanguage('es');
    expect(window.localStorage.getItem('cos.ui.language')).toBe('es');
    vi.resetModules();
    const reloaded = await import('../src/renderer/i18n.js');
    expect(reloaded.currentLanguage()).toBe('es');
  });

  it('retains controls, drafts, selection, focus, icons and authored text across all languages', async () => {
    const { initLanguage, setLanguage, t, ui } = await import('../src/renderer/i18n.js');
    initLanguage();
    const input = document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Save\nMi borrador 🙂 <script>literal</script>';
    input.focus(); input.setSelectionRange(2, 7);
    const icons = [...document.querySelectorAll('svg')];
    const authored = document.createElement('div');
    authored.textContent = 'Save'; document.body.append(authored);
    const action = ui(document.createElement('button'), 'textContent', () => t('Remove {0}', ['<img src=x>']));
    document.body.append(action);
    for (const locale of ['es', 'zh-CN', 'en', 'es'] as const) {
      setLanguage(locale);
      expect(document.getElementById('chatInput')).toBe(input);
      expect(input.value).toBe('Save\nMi borrador 🙂 <script>literal</script>');
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
      expect(document.activeElement).toBe(input);
      expect([...document.querySelectorAll('svg')]).toEqual(icons);
      expect(authored.textContent).toBe('Save');
      expect(action.querySelector('img')).toBeNull();
    }
    expect(action.textContent).toBe('Quitar <img src=x>');
  });

  it('refreshes hidden live labels, preserves newer authored values and falls back for unknown keys', async () => {
    const { initLanguage, setLanguage, t, ui, uiText } = await import('../src/renderer/i18n.js');
    initLanguage();
    const hidden = document.createElement('div'); hidden.hidden = true;
    const label = uiText(() => t('Settings'));
    hidden.append(label); document.body.append(hidden);
    const renamed = ui(document.createElement('div'), 'textContent', () => t('New chat'));
    document.body.append(renamed); renamed.textContent = 'Mi título personal';
    setLanguage('es');
    expect(label.textContent).toBe('Ajustes');
    expect(renamed.textContent).toBe('Mi título personal');
    expect(t('not in the catalog')).toBe('not in the catalog');
    expect(t('__proto__')).toBe('__proto__');
    expect(t('toString')).toBe('toString');
    expect(t('Remove {0}')).toBe('Quitar {0}');
    expect(t('Remove {0}', ['$& /ruta/Save'])).toBe('Quitar $& /ruta/Save');
  });

  it('uses English for an invalid stored locale and still switches when storage is unavailable', async () => {
    window.localStorage.setItem('cos.ui.language', 'not-a-locale');
    const first = await import('../src/renderer/i18n.js');
    expect(first.currentLanguage()).toBe('en');
    vi.resetModules();
    vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
    vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    const { initLanguage, setLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
    initLanguage(); setLanguage('es');
    expect(currentLanguage()).toBe('es');
    expect(t('Settings')).toBe('Ajustes');
    expect(document.documentElement.lang).toBe('es');
  });
});
