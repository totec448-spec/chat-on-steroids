import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhCN from '../src/renderer/locales/zh-CN.json';
import zhTW from '../src/renderer/locales/zh-TW.json';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
});
afterEach(() => dom.window.close());

describe('Chinese app interface', () => {
  it('exposes flagged setup choices and keeps them synchronized with settings and reloads', async () => {
    window.localStorage.setItem('cos.ui.language', 'zh-CN');
    const { initLanguage } = await import('../src/renderer/i18n.js');
    initLanguage();
    const english = document.querySelector<HTMLButtonElement>('[data-language="en"]')!;
    const chinese = document.querySelector<HTMLButtonElement>('[data-language="zh-CN"]')!;
    const select = document.getElementById('uiLanguage') as HTMLSelectElement;
    expect(chinese.closest('[data-panel="setup"]')).not.toBeNull();
    expect(chinese.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(english.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(chinese.getAttribute('aria-pressed')).toBe('true');
    expect(select.value).toBe('zh-CN');
    english.click();
    expect(select.value).toBe('en');
    expect(english.getAttribute('aria-pressed')).toBe('true');
    expect(chinese.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.setup-heading h1')!.textContent).toBe('Setup');
    chinese.click();
    expect(select.value).toBe('zh-CN');
    expect(document.querySelector('.setup-heading h1')!.textContent).toBe('连接设置');
    expect(window.localStorage.getItem('cos.ui.language')).toBe('zh-CN');
    select.value = 'en';
    select.dispatchEvent(new dom.window.Event('change'));
    expect(english.getAttribute('aria-pressed')).toBe('true');
    expect(chinese.getAttribute('aria-pressed')).toBe('false');
  });

  it('switches both ways without replacing controls, icons, emphasis, drafts or authored content', async () => {
    const { initLanguage, ui, t } = await import('../src/renderer/i18n.js');
    const { el } = await import('../src/renderer/dom.js');
    initLanguage();
    const input = document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Save\n用户草稿 <script>not markup</script> 🙂';
    input.setSelectionRange(2, 7);
    const automation = document.getElementById('chatAutomation') as HTMLSelectElement;
    automation.value = 'loop';
    const icons = [...document.querySelectorAll('svg')];
    const strong = document.querySelector('.plugin-refresh-guide strong');
    const savedHTML = strong!.outerHTML;
    const authored = el('div', 'msg', 'Save');
    document.body.append(authored);
    const action = el('button', '', () => t('Remove {0}', ['Save <img src=x>']));
    ui(action, 'aria-label', () => t('Remove {0}', ['Save <img src=x>']));
    document.body.append(action);
    const snapshots = new Map<string, string>();
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'zh-TW', 'zh-CN', 'en', 'zh-CN'] as const) {
      const language = document.getElementById('uiLanguage') as HTMLSelectElement;
      language.value = locale;
      language.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      expect(document.documentElement.lang).toBe(locale);
      expect(document.getElementById('chatInput')).toBe(input);
      expect(input.value).toBe('Save\n用户草稿 <script>not markup</script> 🙂');
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
      expect(automation.value).toBe('loop');
      expect(authored.textContent).toBe('Save');
      expect(action.querySelector('img')).toBeNull();
      expect(action.textContent).toBe(locale === 'en' ? 'Remove Save <img src=x>' : '移除 Save <img src=x>');
      expect(action.getAttribute('aria-label')).toBe(action.textContent);
      expect([...document.querySelectorAll('svg')]).toEqual(icons);
      expect(strong!.outerHTML).toBe(savedHTML);
      const text = document.getElementById('newChat')!.textContent!.trim();
      expect(text).toBe({ en: 'New chat', 'zh-CN': '新建聊天', 'zh-TW': '新增聊天' }[locale]);
      const shell = document.querySelector('.plugin-refresh-guide')!.textContent!;
      if (snapshots.has(locale)) expect(shell).toBe(snapshots.get(locale));
      else snapshots.set(locale, shell);
    }
    expect(window.localStorage.getItem('cos.ui.language')).toBe('zh-CN');
  });

  it('retains a newer authored value and persists the explicit language across renderer reloads', async () => {
    const first = await import('../src/renderer/i18n.js');
    first.initLanguage();
    const node = document.createElement('div');
    document.body.append(node);
    first.ui(node, 'textContent', () => first.t('New chat'));
    node.textContent = 'User title — 保留原文';
    first.setLanguage('zh-CN');
    expect(node.textContent).toBe('User title — 保留原文');
    vi.resetModules();
    const next = await import('../src/renderer/i18n.js');
    expect(next.currentLanguage()).toBe('zh-CN');
    expect(next.t('Settings')).toBe('设置');
    expect(next.t('not in the catalog')).toBe('not in the catalog');
    expect(next.t('__proto__')).toBe('__proto__');
    expect(next.t('toString')).toBe('toString');
  });

  it('only refreshes mounted bindings after repeated row replacement, including hidden labels and text nodes', async () => {
    const { ui, uiText, t, setLanguage } = await import('../src/renderer/i18n.js');
    const pane = document.createElement('div');
    pane.hidden = true;
    document.body.append(pane);
    const retiredReads = vi.fn(() => t('Settings'));
    const retired: Node[] = [];
    for (let i = 0; i < 1024; i++) {
      const label = ui(document.createElement('span'), 'textContent', retiredReads);
      pane.replaceChildren(label);
      retired.push(label);
    }
    const live = ui(document.createElement('button'), 'title', () => t('Settings'));
    const text = uiText(() => t('Copy'));
    live.append(text);
    pane.replaceChildren(live);
    retiredReads.mockClear();
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'zh-CN'] as const) {
      setLanguage(locale);
      expect(live.title).toBe({ en: 'Settings', 'zh-CN': '设置', 'zh-TW': '設定' }[locale]);
      expect(text.textContent).toBe({ en: 'Copy', 'zh-CN': '复制', 'zh-TW': '複製' }[locale]);
      expect(live.firstChild).toBe(text);
    }
    expect(retiredReads).not.toHaveBeenCalled();
    expect(retired).toHaveLength(1024);
    const fresh = ui(document.createElement('span'), 'textContent', () => t('Settings'));
    pane.append(fresh);
    expect(fresh.textContent).toBe('设置');
  });

  it('translates plan chrome while preserving model-authored headlines and details', async () => {
    const { setLanguage } = await import('../src/renderer/i18n.js');
    const { renderAgentPlan } = await import('../src/renderer/agent-plan.js');
    const host = document.createElement('div'); document.body.append(host);
    renderAgentPlan(host, 'session-one', { plan: [{ step: 'Plan', status: 'in_progress', details: 'Keep "Save" exactly as written.' }], explanation: 'Save', updatedAt: 1 } as any);
    const headline = host.querySelector('.agent-plan-step-title');
    setLanguage('zh-CN');
    expect(host.querySelector('.agent-plan-title')!.textContent).toBe('计划');
    expect(host.querySelector('.agent-plan-marker')!.getAttribute('aria-label')).toBe('进行中');
    expect(host.querySelector('.agent-plan-step-title')).toBe(headline);
    expect(headline!.textContent).toBe('Plan');
    expect(host.querySelector('.agent-plan-details')!.textContent).toBe('Keep "Save" exactly as written.');
    expect(host.querySelector('.agent-plan-explanation')!.textContent).toBe('Save');
  });

  it('keeps provider model/effort identities and recorded worker markers unchanged in Chinese', async () => {
    const { setLanguage } = await import('../src/renderer/i18n.js');
    setLanguage('zh-CN');
    let onModels: (value: any) => void = () => {};
    (window as any).api = { onChatModelsChanged: (callback: typeof onModels) => { onModels = callback; return () => {}; } };
    const { initChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
    initChatModels();
    onModels({ state: 'ready', requestedAt: 1, observedAt: 2, models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['high', 'max'], aliases: [] }] });
    const effort = document.getElementById('composerReasoning') as HTMLSelectElement;
    const model = document.getElementById('composerModel') as HTMLSelectElement;
    expect([...effort.options].map(option => option.value)).toEqual(['high', 'max']);
    expect([...effort.options].map(option => option.textContent)).toEqual(['高', '最高']);
    expect(model.value).toBe('gpt-6-astra');
    expect(confirmedComposerModel()).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'high' });
    const { communicationTitle } = await import('../src/renderer/agent-communication.js');
    expect(communicationTitle({ from: 'worker-1', to: 'prime', message: { text: '[worker-1 is awake again] Save' } } as any)).toBe('worker-1 已恢复工作');
    const option = effort.options[0];
    setLanguage('en');
    expect(effort.options[0]).toBe(option);
    expect(option!.textContent).toBe('High');
    expect(confirmedComposerModel()).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'high' });
  });

  it.each(['zh-CN', 'zh-TW'] as const)('covers every static app label and preserves placeholders in %s', locale => {
    const catalog: Record<string, string> = locale === 'zh-CN' ? zhCN : zhTW;
    const walker = document.createTreeWalker(document.body, 4);
    const missing: string[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
      const text = node.textContent!.replace(/\s+/g, ' ').trim();
      if (/[a-zA-Z]{2}/.test(text) && !catalog[text]) missing.push(text);
    }
    for (const node of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
      for (const attr of ['title', 'placeholder', 'aria-label']) {
        const text = node.getAttribute(attr);
        if (text && /[a-zA-Z]{2}/.test(text) && !catalog[text]) missing.push(text);
      }
    }
    expect(missing).toEqual([]);
    for (const [key, translation] of Object.entries(catalog)) {
      expect(translation.trim(), key).not.toBe('');
      expect([...translation.matchAll(/\{\d+\}/g)].map(match => match[0]).sort(), key)
        .toEqual([...key.matchAll(/\{\d+\}/g)].map(match => match[0]).sort());
    }
  });
});

describe('Traditional Chinese (Taiwan)', () => {
  it('synchronizes setup and settings and persists across renderer reloads', async () => {
    const { initLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
    initLanguage();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-language]')];
    const traditional = document.querySelector<HTMLButtonElement>('[data-language="zh-TW"]')!;
    const select = document.getElementById('uiLanguage') as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(['en', 'zh-CN', 'zh-TW']);
    expect(traditional.closest('[data-panel="setup"]')).not.toBeNull();
    expect(traditional.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(traditional.lang).toBe('zh-TW');
    expect(currentLanguage()).toBe('en');
    traditional.click();
    expect(currentLanguage()).toBe('zh-TW');
    expect(document.documentElement.lang).toBe('zh-TW');
    expect(select.value).toBe('zh-TW');
    expect(document.querySelector('.setup-heading h1')!.textContent).toBe('連線設定');
    expect(t('Settings')).toBe('設定');
    expect(t('Save')).toBe('儲存');
    expect(t('Plugins')).toBe('外掛');
    expect(t('Files')).toBe('檔案');
    expect(t('Folders')).toBe('資料夾');
    expect(t('Default')).toBe('預設');
    for (const locale of ['zh-CN', 'en', 'zh-TW'] as const) {
      select.value = locale;
      select.dispatchEvent(new dom.window.Event('change'));
      expect(currentLanguage()).toBe(locale);
      expect(document.documentElement.lang).toBe(locale);
      for (const button of buttons) {
        expect(button.getAttribute('aria-pressed')).toBe(String(button.dataset.language === locale));
      }
    }
    expect(buttons.map(button => button.textContent)).toEqual(['English', '简体中文', '繁體中文']);
    expect(window.localStorage.getItem('cos.ui.language')).toBe('zh-TW');
    vi.resetModules();
    const reloaded = await import('../src/renderer/i18n.js');
    expect(reloaded.currentLanguage()).toBe('zh-TW');
    expect(reloaded.t('Settings')).toBe('設定');
    expect(reloaded.t('not in the catalog')).toBe('not in the catalog');
    expect(reloaded.t('__proto__')).toBe('__proto__');
    expect(reloaded.t('toString')).toBe('toString');
    expect(reloaded.t('Unknown {0}', ['原文'])).toBe('Unknown 原文');
  });

  it.each(['', 'fr', '__proto__', 'zh-unknown'])('falls back to English for unsupported saved value %j', async saved => {
    window.localStorage.setItem('cos.ui.language', saved);
    const { initLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
    initLanguage();
    expect(currentLanguage()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(t('Settings')).toBe('Settings');
  });

  it('still switches when browser preference storage is unavailable', async () => {
    const get = vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    const set = vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    try {
      const { initLanguage, setLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
      initLanguage();
      expect(currentLanguage()).toBe('en');
      setLanguage('zh-TW');
      expect(currentLanguage()).toBe('zh-TW');
      expect(document.documentElement.lang).toBe('zh-TW');
      expect(t('Copy')).toBe('複製');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('translates plan labels without changing model-authored text', async () => {
    const { setLanguage } = await import('../src/renderer/i18n.js');
    const { renderAgentPlan } = await import('../src/renderer/agent-plan.js');
    const host = document.createElement('div');
    document.body.append(host);
    renderAgentPlan(host, 'traditional-plan', { plan: [{ step: 'Plan', status: 'in_progress', details: 'Save 用户原文' }], explanation: 'Keep original', updatedAt: 1 } as any);
    const headline = host.querySelector('.agent-plan-step-title');
    setLanguage('zh-TW');
    expect(host.querySelector('.agent-plan-title')!.textContent).toBe('計畫');
    expect(host.querySelector('.agent-plan-marker')!.getAttribute('aria-label')).toBe('進行中');
    expect(host.querySelector('.agent-plan-step-title')).toBe(headline);
    expect(headline!.textContent).toBe('Plan');
    expect(host.querySelector('.agent-plan-details')!.textContent).toBe('Save 用户原文');
    expect(host.querySelector('.agent-plan-explanation')!.textContent).toBe('Keep original');
  });

  it('matches catalog keys and preserves Unicode symbols and technical URLs', () => {
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(zhCN).sort());
    expect(zhTW['•••••••• stored']).toBe('•••••••• 已儲存');
    for (const [key, translation] of Object.entries(zhTW)) {
      expect(translation, key).not.toContain('\uFFFD');
      expect(translation, key).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
      for (const symbol of ['©', '•', '←', '→']) {
        expect(translation.split(symbol).length, key).toBe(key.split(symbol).length);
      }
      const urls = (value: string) => (value.match(/https?:\/\/[^\s\u3000-\u9fff]+/g) ?? []).map(url => url.replace(/[.,;:!]+$/, ''));
      expect(urls(translation), key).toEqual(urls(key));
    }
  });
});
