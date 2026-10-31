import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhCN from '../src/renderer/locales/zh-CN.json';
import type { Language } from '../src/renderer/i18n.js';

const names = { en: 'English', es: 'Español', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어', ru: 'Русский', tr: 'Türkçe', vi: 'Tiếng Việt', fr: 'Français', 'pt-PT': 'Português (Portugal)', 'pt-BR': 'Português (Brasil)', de: 'Deutsch' } as const;
const languages = Object.keys(names) as Language[];
const catalogs = Object.fromEntries(languages.filter(locale => locale !== 'en').map(locale =>
  [locale, JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Record<string, string>]));

it.each(languages.filter(locale => locale !== 'en'))('translates the lost-opening delivery notice into %s', locale => {
  const key = 'Not sent: the browser tab for this new chat was closed or lost. Review the message and send again.';
  expect(catalogs[locale]?.[key]).toBeTruthy();
  expect(catalogs[locale]?.[key]).not.toBe(key);
});

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement'] as const) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close(); });

// Includes the Traditional Chinese selector regression from aliceric27's #243.
it.each(languages)('restores %s and synchronizes accessible setup flags, settings and reloads', async locale => {
  window.localStorage.setItem('cos.ui.language', locale);
  const { initLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
  initLanguage();
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  const flag = document.querySelector<HTMLButtonElement>(`[data-language="${locale}"]`)!;
  expect(currentLanguage()).toBe(locale);
  expect(document.documentElement.lang).toBe(locale);
  expect(select.value).toBe(locale);
  expect(select.selectedOptions[0]!.textContent).toBe(names[locale]);
  expect(flag.closest('[data-panel="setup"]')).not.toBeNull();
  expect(flag.type).toBe('button');
  expect(flag.lang).toBe(locale);
  expect(flag.textContent.trim()).toBe('');
  expect(flag.title).toBe(names[locale]);
  expect(flag.getAttribute('aria-label')).toBe(names[locale]);
  expect(flag.querySelector('svg.language-flag[aria-hidden="true"]')).not.toBeNull();
  expect(document.querySelector('.setup-heading h1')!.textContent).toBe(catalogs[locale]?.Setup ?? 'Setup');
  expect(t('Settings')).toBe(catalogs[locale]?.Settings ?? 'Settings');

  select.value = locale === 'en' ? 'ja' : 'en';
  select.dispatchEvent(new dom.window.Event('change'));
  expect(flag.getAttribute('aria-pressed')).toBe('false');
  flag.click();
  expect(select.value).toBe(locale);
  expect([...document.querySelectorAll('[data-language][aria-pressed="true"]')]).toEqual([flag]);
  expect(window.localStorage.getItem('cos.ui.language')).toBe(locale);
  vi.resetModules();
  expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe(locale);
});

it.each([
  [['de-DE', 'de'], 'de'], [['zh-Hant-TW'], 'zh-TW'], [['zh-HK'], 'zh-TW'], [['zh-CN'], 'zh-CN'], [['zh'], 'zh-CN'],
  [['pt-PT'], 'pt-PT'], [['pt-BR'], 'pt-BR'], [['pt'], 'pt-BR'], [['nl-NL', 'fr-FR'], 'fr'], [['nl', 'sv'], 'en'],
  [['en-GB', 'de-DE'], 'en'], [['ja-JP'], 'ja'], [[], 'en']
] as const)('maps system languages %j to %s', async (preferred, expected) => {
  const { systemLanguage } = await import('../src/renderer/i18n.js');
  expect(systemLanguage(preferred)).toBe(expected);
});

it('starts in the system language until a language is chosen, and a saved choice wins', async () => {
  vi.spyOn(dom.window.navigator, 'languages', 'get').mockReturnValue(['de-DE', 'de']);
  const first = await import('../src/renderer/i18n.js');
  first.initLanguage();
  expect(first.currentLanguage()).toBe('de');
  expect(document.documentElement.lang).toBe('de');
  expect(document.querySelector('.setup-heading h1')!.textContent).toBe(catalogs.de!.Setup);
  // Following the system writes nothing: a later system change still applies until someone chooses.
  expect(window.localStorage.getItem('cos.ui.language')).toBeNull();
  window.localStorage.setItem('cos.ui.language', 'en');
  vi.resetModules();
  expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('en');
});

it('defaults to English, rejects unsupported variants and switches even when storage fails', async () => {
  expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('en');
  expect(window.localStorage.getItem('cos.ui.language')).toBeNull();
  window.localStorage.setItem('cos.ui.language', 'pt-AO');
  vi.resetModules();
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
  expect(t('unknown /Save/<img src=x>')).toBe('unknown /Save/<img src=x>');
});

it.each([
  ['fr', /compétences?/iu], ['ja', /スキル/u], ['ko', /스킬/u], ['tr', /beceri/iu],
  ['vi', /kỹ năng/iu], ['zh-CN', /技能/u], ['zh-TW', /技能/u]
] as const)('uses the Skills page terminology in all four routing strings for %s', (locale, term) => {
  const catalog = catalogs[locale];
  if (!catalog) throw new Error(`Missing routing locale: ${locale}`);
  expect(catalog.Skills).toMatch(term);
  for (const key of [
    'Choose whether imported Skills can be matched to ordinary messages.',
    'Auto-select Skills',
    'Match one imported Skill by its exact name in the message, not by topic. Explicit Skill choices always win.',
    'Auto-selected Skill: /{0}'
  ]) {
    expect(catalog[key], `${locale}: ${key}`).toMatch(term);
    expect(catalog[key], `${locale}: ${key}`).not.toMatch(/\bskills?\b/iu);
  }
});

it.each(languages)('explains exact-name Skill routing rather than topic matching in %s', async locale => {
  const source = 'Match one imported Skill by its exact name in the message, not by topic. Explicit Skill choices always win.';
  const input = document.getElementById('autoSelectSkills') as HTMLInputElement;
  const hint = input.closest('.setting')!.querySelector('em')!;
  expect(hint.textContent).toBe(source);
  expect(input.checked).toBe(false);
  if (locale !== 'en') expect(catalogs[locale]).toHaveProperty(source);
  const { initLanguage, setLanguage } = await import('../src/renderer/i18n.js');
  initLanguage(); setLanguage(locale);
  expect(hint.textContent).toBe(catalogs[locale]?.[source] ?? source);
  expect(document.getElementById('autoSelectSkills')).toBe(input);
  expect(input.checked).toBe(false);
});

it('translates known IPC failures and keeps provider errors and successful replies literal', async () => {
  window.localStorage.setItem('cos.ui.language', 'ja');
  const { run } = await import('../src/renderer/dom.js');
  expect(await run(Promise.resolve({ ok: false, error: 'Secure credential storage is unavailable.' }))).toBeNull();
  expect(document.querySelector('.toast')!.textContent).toBe(catalogs.ja!['Secure credential storage is unavailable.']);
  const limitError = 'The Skills library supports at most 128 skills';
  expect(catalogs.ja).toHaveProperty(limitError);
  expect(await run(Promise.resolve({ ok: false, error: limitError }))).toBeNull();
  expect(document.querySelector('.toast')!.textContent).toBe(catalogs.ja![limitError]);
  const error = 'PROVIDER: /Save/<img src=x> {0}\n  details';
  expect(await run(Promise.resolve({ ok: false, error }))).toBeNull();
  expect(document.querySelector('.toast')!.textContent).toBe(error);
  expect(document.querySelector('.toast img')).toBeNull();
  expect(await run(Promise.resolve({ ok: true, data: 'Settings' }))).toBe('Settings');
  expect(document.querySelectorAll('.toast')).toHaveLength(1);
});

it('preserves nested translated duration arguments in Turkish', async () => {
  const { setLanguage, t } = await import('../src/renderer/i18n.js');
  setLanguage('tr');
  expect(t('{0} for {1}{2}s', [t('Worked'), `${t('{0}m', [1])} `, 5])).toBe('1 dk 5 sn · Çalıştı');
});

describe('app interface localization', () => {

  it('switches both ways without replacing controls, icons, emphasis, drafts or authored content', async () => {
    const { initLanguage, ui, t } = await import('../src/renderer/i18n.js');
    const { el } = await import('../src/renderer/dom.js');
    const native = document.createElement('span');
    native.setAttribute('translate', 'no'); native.title = 'Settings'; native.setAttribute('aria-label', 'Save');
    native.textContent = 'Save'; document.body.append(native);
    initLanguage();
    const input = document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Save\n用户草稿 <script>not markup</script> 🙂';
    input.focus(); input.setSelectionRange(2, 7);
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
    for (const locale of [...languages, 'en', 'zh-CN'] as const) {
      const language = document.getElementById('uiLanguage') as HTMLSelectElement;
      language.value = locale;
      language.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      expect(document.documentElement.lang).toBe(locale);
      expect(document.getElementById('chatInput')).toBe(input);
      expect(input.value).toBe('Save\n用户草稿 <script>not markup</script> 🙂');
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
      expect(document.activeElement).toBe(input);
      expect(automation.value).toBe('loop');
      expect([native.textContent, native.title, native.getAttribute('aria-label')]).toEqual(['Save', 'Settings', 'Save']);
      expect(authored.textContent).toBe('Save');
      expect(action.querySelector('img')).toBeNull();
      expect(action.textContent).toBe((catalogs[locale]?.['Remove {0}'] ?? 'Remove {0}').replace('{0}', 'Save <img src=x>'));
      expect(action.getAttribute('aria-label')).toBe(action.textContent);
      expect([...document.querySelectorAll('svg')]).toEqual(icons);
      expect(strong!.outerHTML).toBe(savedHTML);
      const text = document.getElementById('newChat')!.textContent!.trim();
      expect(text).toBe(catalogs[locale]?.['New chat'] ?? 'New chat');
      const globalWorkerLabel = document.getElementById('globalMaWorkers')!.closest('.setting')!.querySelector('b')!.textContent!;
      expect(globalWorkerLabel).toBe(catalogs[locale]?.['Workers across all chats'] ?? 'Workers across all chats');
      const shell = document.querySelector('.plugin-refresh-guide')!.textContent!;
      if (snapshots.has(locale)) expect(shell).toBe(snapshots.get(locale));
      else snapshots.set(locale, shell);
    }
    expect(window.localStorage.getItem('cos.ui.language')).toBe('zh-CN');
    expect(t('  Settings\n')).toBe('设置');
    expect(t('Remove {0}')).toBe('移除 {0}');
    const argument = '$& /資料/Save <img src=x>';
    expect(t('Remove {0}', [argument])).toBe(`移除 ${argument}`);
    expect(t('unknown source {0}', [argument])).toBe(`unknown source ${argument}`);
    for (const source of ['exec_command', 'gpt-6-astra']) expect(t(source)).toBe(source);
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
    for (const locale of ['zh-CN', 'en', 'zh-CN'] as const) {
      setLanguage(locale);
      expect(live.title).toBe(locale === 'zh-CN' ? '设置' : 'Settings');
      expect(text.textContent).toBe(locale === 'zh-CN' ? '复制' : 'Copy');
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

  it('covers every static app label in every catalog', () => {
    const catalog: Record<string, string> = zhCN;
    const walker = document.createTreeWalker(document.body, 4);
    const missing: string[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
      const text = node.textContent!.replace(/\s+/g, ' ').trim();
      if (/[a-zA-Z]{2}/.test(text) && !catalog[text]) missing.push(text);
    }
    for (const node of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
      if (node.closest('[translate="no"]')) continue;
      for (const attr of ['title', 'placeholder', 'aria-label']) {
        const text = node.getAttribute(attr);
        if (text && /[a-zA-Z]{2}/.test(text) && !catalog[text]) missing.push(text);
      }
    }
    expect(missing).toEqual([]);
    for (const [locale, messages] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).filter(key => !Object.hasOwn(messages, key)), locale).toEqual([]);
    }
  });
});

it('matches both Turkish I pairs when searching settings', async () => {
  window.localStorage.setItem('cos.ui.language', 'tr');
  const { searchSettings } = await import('../src/renderer/settings-search.js');
  const entries = [{ tab: 'home', page: 'Çalışma alanı', section: 'İzinler', title: 'IŞIK', detail: '', target: document.createElement('div') }];
  for (const query of ['izinler', 'İZİNLER', 'ışık', 'IŞIK']) expect(searchSettings(entries, query)).toHaveLength(1);
  expect(searchSettings(entries, 'missing')).toEqual([]);
});

// The German interface says "du". Formal address crept in with whole features more than once
// (sign-in flow, 2026-10): an imperative or statement with "Sie", or "Ihr …" for the person's things.
it('addresses the person as "du" throughout the German catalog', () => {
  const formal = /(?:^|[.!?:]\s+|,\s+|\s)(?:\p{Lu}\p{Ll}+(?:en|ern|eln) Sie\b|Sie (?:sind|können|müssen|haben|werden gefragt)\b)|\b(?:werden|können|müssen|sind|haben|wählen|öffnen|versuchen|fahren) Sie\b|\bIhr(?:e[mnrs]?)? (?:Browser|Konto|App|Einstellungen|Computer|Projekt|Chat)\b/u;
  const offenders = Object.entries(catalogs.de!).filter(([, value]) => formal.test(value)).map(([key, value]) => `${key} → ${value}`);
  expect(offenders).toEqual([]);
  // The extension's popup and in-page notices are the same product, in its own catalog.
  const extension = JSON.parse(readFileSync('extension/_locales/de/messages.json', 'utf8')) as Record<string, { message: string }>;
  expect(Object.entries(extension).filter(([, entry]) => formal.test(entry.message)).map(([key, entry]) => `${key} → ${entry.message}`)).toEqual([]);
});

// A feature has one name per language. Sentences kept the English name ("Wie viel ein Compact &
// Resume-Bericht behält") beside the translated one ("Komprimieren & Fortsetzen"), or a second
// translation of it, so one settings page named the same feature three ways (2026-10-13).
it('calls each feature by the language\'s own name in every sentence', () => {
  // The names hold no regular-expression characters.
  const word = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}-])${name}(?![\\p{L}\\p{N}-])`, 'u');
  const offenders: string[] = [];
  for (const [language, catalog] of Object.entries(catalogs)) {
    for (const [name, entry] of [['Compact & Resume', 'Compact & Resume:'], ['Goal', 'Goal'], ['Loop', 'Loop'], ['Activity', 'Activity']] as const) {
      const own = catalog![entry]?.replace(/[:：]\s*$/, '').trim();
      if (!own || own === name) continue;
      for (const [key, value] of Object.entries(catalog!)) {
        if (!word(name).test(key)) continue;
        if (word(name).test(value)) offenders.push(`${language}: "${name}" left in → ${value}`);
        // The handoff feature is always named in full; a second translation of it is a second name.
        else if (name === 'Compact & Resume' && !value.toLowerCase().includes(own.toLowerCase())) offenders.push(`${language}: not "${own}" → ${value}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

// One word for it: the interface, the extension and its name in the browser say "browser
// extension". "Companion" was a second name for the same thing in 20 texts (2026-10-13). The pets
// are companions of another kind and keep the word.
// What a person adds in ChatGPT is a plugin there (Plugins → Add custom MCP server → Create as a
// plugin); "connector" no longer appears in ChatGPT, so the app does not use it either.
it("calls what ChatGPT holds a plugin, not a connector, in every language's source text", () => {
  const page = new JSDOM(readFileSync('src/renderer/index.html', 'utf8')).window.document;
  const shown = [page.body.textContent ?? '', ...[...page.querySelectorAll('[title], [aria-label], [placeholder]')]
    .flatMap(node => ['title', 'aria-label', 'placeholder'].map(name => node.getAttribute(name) ?? ''))].join('\n');
  expect(shown.split('\n').map(line => line.trim()).filter(line => /connector/i.test(line))).toEqual([]);
  const catalog = JSON.parse(readFileSync('src/renderer/locales/de.json', 'utf8')) as Record<string, string>;
  expect(Object.keys(catalog).filter(key => /connector/i.test(key))).toEqual([]);
  const extension = JSON.parse(readFileSync('extension/_locales/en/messages.json', 'utf8')) as Record<string, { message: string }>;
  expect(Object.entries(extension).filter(([, entry]) => /connector/i.test(entry.message)).map(([key]) => key)).toEqual([]);
});

it('calls the browser extension an extension, not a companion', () => {
  // What a person can read: the page's text and its tooltips, labels and placeholders (comments are not).
  const page = new JSDOM(readFileSync('src/renderer/index.html', 'utf8')).window.document;
  const shown = [page.body.textContent ?? '', ...[...page.querySelectorAll('[title], [aria-label], [placeholder]')]
    .flatMap(node => ['title', 'aria-label', 'placeholder'].map(name => node.getAttribute(name) ?? ''))].join('\n');
  expect(shown.split('\n').map(line => line.trim()).filter(line => /\bcompanion\b/i.test(line) && !/desktop companions/.test(line))).toEqual([]);
  const extension = JSON.parse(readFileSync('extension/_locales/en/messages.json', 'utf8')) as Record<string, { message: string }>;
  expect(Object.entries(extension).filter(([, entry]) => /\bcompanion\b/i.test(entry.message)).map(([key]) => key)).toEqual([]);
});

// Counts take the language's own plural form (Intl.PluralRules): German and Portuguese verbs agree
// with the number, Russian nouns have three forms (1/21, 2–4, 5–20), Japanese has none. Before
// this every count used one form: German "2 ruht", Portuguese "2 terminou", Russian "2 спит".
it.each([
  ['de', '{0} sleeping', [[1, '1 ruht'], [2, '2 ruhen']]],
  ['de', '{0} lines', [[1, '1 Zeile'], [0, '0 Zeilen'], [7, '7 Zeilen']]],
  ['pt-BR', '{0} finished', [[1, '1 terminou'], [2, '2 terminaram']]],
  ['fr', '{0} lines', [[0, '0 ligne'], [1, '1 ligne'], [2, '2 lignes'], [1_000_000, '1000000 de lignes']]],
  ['es', '{0} failed', [[1, '1 fallido'], [3, '3 fallidos']]],
  ['ru', '{0} lines', [[1, '1 строка'], [2, '2 строки'], [5, '5 строк'], [21, '21 строка'], [22, '22 строки'], [11, '11 строк'], [1.5, '1.5 строки']]],
  ['ru', '{0} sleeping', [[1, '1 спит'], [3, '3 спят']]],
  ['ja', '{0} lines', [[1, '1 行'], [5, '5 行']]],
  ['en', '{0} lines', [[1, '1 line'], [0, '0 lines'], [2, '2 lines']]]
] as const)('words a %s count of %s in that language\'s plural forms', async (locale, other, cases) => {
  window.localStorage.setItem('cos.ui.language', locale);
  const { initLanguage, tn } = await import('../src/renderer/i18n.js');
  initLanguage();
  const one = other === '{0} lines' ? '{0} line' : other;
  expect(cases.map(([count]) => tn(one, other, count))).toEqual(cases.map(([, text]) => text));
});

it('falls back to the plural text when a count is not a finite number', async () => {
  window.localStorage.setItem('cos.ui.language', 'ru');
  const { initLanguage, tn } = await import('../src/renderer/i18n.js');
  initLanguage();
  expect(tn('{0} line', '{0} lines', Number.NaN, ['?'])).toBe('? строки');
});
