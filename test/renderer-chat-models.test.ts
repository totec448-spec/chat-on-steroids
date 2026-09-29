import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '../src/shared/types.js';
import { readFile } from 'node:fs/promises';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
it('shows pending reasons and failed refresh separately from usable cached choices', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (catalog: any) => void;
  const models = [{ id: 'future', label: '未来模型', efforts: ['high'] }];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', models } }),
    onChatModelsChanged: (listener: typeof receive) => { receive = listener; } } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  receive({ state: 'pending', models, waiting: 'ChatGPT is still generating. The running response is left untouched.' });
  expect(dom.window.document.getElementById('chatModelStatus')!.textContent).toContain('still generating');
  expect(confirmedComposerModel()).toEqual({ model: 'future', reasoningEffort: 'high' });
  receive({ state: 'ready', models, error: 'Model discovery timed out.' });
  for (const id of ['chatModelStatus', 'composerModelStatus']) {
    const node = dom.window.document.getElementById(id)!;
    expect(node.textContent).toContain('Refresh failed'); expect(node.textContent).toContain('timed out'); expect(node.hidden).toBe(false);
  }
  expect(confirmedComposerModel()).toEqual({ model: 'future', reasoningEffort: 'high' });
  receive({ state: 'ready', models, observedAt: 10 });
  expect(dom.window.document.getElementById('composerModelStatus')!.hidden).toBe(true);
});
it('keeps an unknown non-Latin saved worker model unverified instead of matching an empty normalized label', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', models: [{ id: 'future', label: '未来模型', efforts: ['high'] }] } }) } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: { defaultModel: '完全不同', defaultReasoning: 'high' }, goal: {} } as Config); await Promise.resolve();
  const model = dom.window.document.getElementById('workerModel') as HTMLSelectElement;
  expect(model.value).toBe('完全不同'); expect(model.selectedOptions[0]!.disabled).toBe(true);
});

it.each([true, false])('a model-rejection refresh waits beyond cached availability (still available=%s)', async available => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (catalog: any) => void;
  const models = [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high'] }];
  const requestChatModels = vi.fn(async () => ({ ok: true, data: { state: 'pending', models } }));
  Object.assign(dom.window, { api: { requestChatModels,
    getChatModels: async () => ({ ok: true, data: { state: 'ready', models } }),
    onChatModelsChanged: (listener: typeof receive) => { receive = listener; } } });
  const { initChatModels, applyChatModels, ensureComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  let done = false;
  const result = ensureComposerModel(true).then(value => { done = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  expect(done).toBe(false); expect(requestChatModels).toHaveBeenCalledTimes(1);
  receive({ state: 'ready', models: available ? models : [{ id: 'gpt-6', label: 'GPT-6', efforts: ['medium'] }] });
  expect(await result).toEqual(available ? { model: 'gpt-6', reasoningEffort: 'high' } : null);
});

it('a send requests missing models once and waits for the pushed catalog before selecting', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const requestChatModels = vi.fn(async () => ({ ok: true, data: { state: 'pending', requestedAt: 1, observedAt: null, models: [] } }));
  const models = [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high'] }];
  Object.assign(dom.window, { api: { requestChatModels, getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }) } });
  const { initChatModels, ensureComposerModel, applyChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels();
  const first = ensureComposerModel(), second = ensureComposerModel();
  let resolved = false; void first.then(() => { resolved = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(requestChatModels).toHaveBeenCalledTimes(1); expect(resolved).toBe(false);
  applyChatModels({ multiAgent: {}, goal: {} } as Config);
  expect(await first).toEqual({ model: 'gpt-6', reasoningEffort: 'high' });
  expect(await second).toEqual({ model: 'gpt-6', reasoningEffort: 'high' });
});

it('a failed discovery keeps sending unconfirmed and settles its wait', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { requestChatModels: async () => ({ ok: true, data: { state: 'unavailable', requestedAt: 1, observedAt: 2, models: [] } }) } });
  const { initChatModels, ensureComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); expect(await ensureComposerModel()).toBeNull();
});

it('opening an empty or pending picker requests models immediately without a separate refresh', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const pending = { state: 'pending', requestedAt: 1, observedAt: null, models: [] };
  const requestChatModels = vi.fn(async () => ({ ok: true, data: pending }));
  Object.assign(dom.window, { api: { requestChatModels } });
  const { initChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels();
  const menu = dom.window.document.getElementById('modelMenu') as HTMLDetailsElement;
  menu.open = true;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(requestChatModels).toHaveBeenCalledTimes(1);
  expect(dom.window.document.getElementById('composerPowerTitle')!.textContent).toBe('Loading models…');
  menu.open = false;
  await new Promise(resolve => setTimeout(resolve, 0));
  menu.open = true;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(requestChatModels).toHaveBeenCalledTimes(2);
});

it('offers every observed model, including GPT-5.5 and future models, separately from effort', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'old', label: 'GPT-5.5', efforts: ['medium', 'high', 'pro'] },
    { id: 'sol', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'] },
    { id: 'future', label: 'GPT-7', efforts: ['high'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }) } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(slider.max).toBe('2');
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#composerModel option')].map(option => option.value)).toEqual(['old', 'sol', 'future']);
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#workerModel option')].some(option => option.value === 'old')).toBe(true);
  dom.window.document.querySelector<HTMLButtonElement>('[data-model="future"]')!.click();
  expect(confirmedComposerModel()).toEqual({ model: 'future', reasoningEffort: 'high' });
});

it('disambiguates duplicate account model labels by their observed lane', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'gpt-5-6', label: '5.6', efforts: ['none'] },
    { id: 'gpt-5-6-thinking', label: '5.6', efforts: ['medium', 'high'] },
    { id: 'gpt-5-5-instant', label: '5.5', efforts: ['none'] },
    { id: 'gpt-5-5-thinking', label: '5.5', efforts: ['medium', 'high'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }) } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const labels = [...dom.window.document.querySelectorAll<HTMLOptionElement>('#workerModel option')].map(option => option.textContent);
  expect(labels).toEqual(['5.6 · Instant', '5.6 · Reasoning', '5.5 · Instant', '5.5 · Reasoning']);
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#workerModel option')].map(option => option.value)).toEqual(models.map(model => model.id));
});

it('binds composer selection to the selected session across delayed catalog, user edits and A-B-A navigation', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high', 'xhigh'] }];
  let resolve!: (value: unknown) => void;
  Object.assign(dom.window, { api: { getChatModels: () => new Promise(done => { resolve = done; }) } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config);
  const high = { model: 'GPT-5.6 Sol', reasoningEffort: 'high' as const, observedAt: 1 };
  applyComposerSessionModel('worker:1', high);
  expect(confirmedComposerModel()).toBeNull();
  resolve({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  applyComposerSessionModel('worker:1', { ...high, observedAt: 3 });
  expect(confirmedComposerModel()?.reasoningEffort).toBe('xhigh');
  applyComposerSessionModel('other:2', null);
  expect(confirmedComposerModel()).toBeNull();
  applyComposerSessionModel('worker:3', high);
  expect(confirmedComposerModel()?.reasoningEffort).toBe('high');
  applyComposerSessionModel('worker:3', { ...high, reasoningEffort: 'xhigh', observedAt: 4 });
  expect(confirmedComposerModel()?.reasoningEffort).toBe('xhigh');
  applyComposerSessionModel('worker:3', high);
  expect(confirmedComposerModel()?.reasoningEffort).toBe('xhigh');
});

it('renders the two observed Pro generations separately and sends their exact selection identities', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'] },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high', 'pro'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }) } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  const { paintContextMeter } = await import('../src/renderer/context-meter.js');
  const config = { multiAgent: {}, goal: {}, sessions: { limitTokens: 533000 }, compaction: { auto: true, autoTokens: 400000 } } as Config;
  initChatModels(() => paintContextMeter(null, config, confirmedComposerModel()));
  applyChatModels(config); await Promise.resolve();
  dom.window.document.querySelector<HTMLButtonElement>('[data-model="gpt-5.6-sol"]')!.click();
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('GPT-5.6 Pro');
  expect(confirmedComposerModel()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'pro' });
  expect(dom.window.document.getElementById('contextMeterInfo')!.textContent).toContain('Auto-compaction off for Pro');
  dom.window.document.querySelector<HTMLButtonElement>('[data-model="gpt-6-pro"]')!.click();
  expect(dom.window.document.getElementById('contextMeterInfo')!.textContent).toContain('Auto-compaction off for Pro');
  expect(dom.window.document.getElementById('contextMeterArc')!.getAttribute('stroke-dasharray')).toBe('0 37.7');
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('GPT-6 Pro');
  // Pro-only model: one effort, so no slider; the menu names it instead.
  expect(dom.window.document.querySelector('#composerPowerChoices input')).toBeNull();
  expect(dom.window.document.getElementById('composerPowerModel')!.textContent).toBe('Pro');
  expect(confirmedComposerModel()).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
  dom.window.document.querySelector<HTMLButtonElement>('[data-model="gpt-5.6-sol"]')!.click();
  expect(dom.window.document.getElementById('contextThreshold')!.textContent).toBe('400K');
});

it('replaces loading with the backend failure reason and an enabled retry control', async () => {
  dom = new JSDOM('<span id="composerModelLabel"></span><p id="composerModelStatus"></p><button id="refreshComposerModels"></button>' +
    ['composerModel', 'composerReasoning', 'workerModel', 'workerReasoning', 'helperModel', 'helperReasoning'].map(id => `<select id="${id}"><option value="">Default</option></select>`).join(''));
  const pending = { state: 'pending', requestedAt: 1, observedAt: null, models: [] };
  const failed = { ...pending, state: 'unavailable', error: 'Model discovery timed out. Retry.' };
  const getChatModels = vi.fn(async () => ({ ok: true, data: pending }));
  Object.assign(dom.window, { api: { getChatModels } });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  expect(confirmedComposerModel()).toBeNull();
  const config = { multiAgent: {}, goal: {} } as Config;
  applyChatModels(config); await Promise.resolve();
  const retry = dom.window.document.getElementById('refreshComposerModels') as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  getChatModels.mockResolvedValue({ ok: true, data: failed });
  applyChatModels(config); await Promise.resolve();
  expect(retry.disabled).toBe(false); expect(retry.hidden).toBe(false);
  expect(dom.window.document.getElementById('composerModelStatus')!.textContent).toContain('timed out');
});

it('uses observed account choices, preserves unverified defaults, and clears incompatible effort on model change', async () => {
  dom = new JSDOM('<span id="composerModelLabel"></span><p id="chatModelStatus"></p>' +
    ['composerModel', 'composerReasoning', 'workerModel', 'workerReasoning', 'helperModel', 'helperReasoning'].map(id => `<select id="${id}"><option value="">Default</option></select>`).join(''));
  const observed = { state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [
    { id: 'first', label: 'GPT-5.6 Sol', efforts: ['high'] }, { id: 'second', label: 'GPT-6', efforts: ['medium'] }
  ] };
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: observed }) } });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  expect(confirmedComposerModel()).toBeNull();
  applyChatModels({ multiAgent: { defaultModel: 'unseen', defaultReasoning: 'high' }, goal: {} } as Config);
  await Promise.resolve();
  const select = (id: string) => dom.window.document.getElementById(id) as HTMLSelectElement;
  expect(select('workerModel').value).toBe('unseen');
  expect(select('workerModel').selectedOptions[0]!.disabled).toBe(true);
  expect(select('workerModel').selectedOptions[0]!.textContent).toBe('unseen');
  expect(dom.window.document.getElementById('workerModelVerification')!.textContent).toBe('Unverified');
  expect(dom.window.document.getElementById('helperModelVerification')!.hasAttribute('hidden')).toBe(true);
  expect(select('helperModel').value).toBe('first');
  // Selects without the badge still say so in the option itself.
  applyChatModels({ multiAgent: { defaultModel: 'unseen', defaultReasoning: 'high' }, goal: { helperModel: 'first', helperReasoning: 'ultra' } } as Config);
  await Promise.resolve();
  expect(select('helperReasoning').value).toBe('ultra');
  expect(select('helperReasoning').selectedOptions[0]!.textContent).toBe('ultra · not verified');
  expect([...select('composerModel').options].map(row => row.value)).toEqual(['first', 'second']);
  select('composerModel').value = 'first'; select('composerModel').dispatchEvent(new dom.window.Event('change'));
  expect([...select('composerReasoning').options].map(row => row.value)).toEqual(['high']);
  select('composerReasoning').value = 'high';
  select('composerModel').value = 'second'; select('composerModel').dispatchEvent(new dom.window.Event('change'));
  expect(select('composerReasoning').value).toBe('medium');
  expect([...select('composerReasoning').options].map(row => row.value)).toEqual(['medium']);
});

it('offers only observed models, prefers supported GPT-6 High, and replaces a removed account selection', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let models = [
    { id: 'other', label: 'GPT-5.6 Sol', efforts: ['medium'] },
    { id: 'observed-six', label: 'GPT-6', efforts: ['medium', 'high'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: Date.now(), models } }) } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  expect(confirmedComposerModel()).toBeNull();
  const config = { multiAgent: {}, goal: {} } as Config;
  applyChatModels(config); await Promise.resolve();
  const select = (id: string) => dom.window.document.getElementById(id) as HTMLSelectElement;
  expect(select('composerModel').value).toBe('observed-six');
  expect(select('composerReasoning').value).toBe('high');
  expect(dom.window.document.getElementById('composerModelChoices')!.textContent).not.toContain('default');
  const reload = dom.window.document.getElementById('refreshComposerModels')!;
  expect(reload.querySelector('.ico.ph-arrow-clockwise')).not.toBeNull();
  expect(reload.textContent).toBe('Reload ChatGPT models');
  expect(reload.getAttribute('aria-label')).toBe('Reload ChatGPT models');
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(slider.max).toBe('1');
  expect(slider.getAttribute('aria-valuetext')).toBe('High');
  slider.value = '0'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(select('composerModel').value).toBe('observed-six');
  expect(select('composerReasoning').value).toBe('medium');
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(select('composerModel').value).toBe('observed-six');
  expect(select('composerReasoning').value).toBe('high');
  applyChatModels(config); await Promise.resolve();
  expect(dom.window.document.querySelector('#composerPowerChoices input')).toBe(slider);
  models = [{ id: 'actual-pro', label: 'GPT-6 Pro', efforts: ['pro'] }];
  applyChatModels(config); await Promise.resolve();
  expect(confirmedComposerModel()).toBeNull();
  expect(dom.window.document.querySelector('#composerPowerChoices input')).toBeNull();
  dom.window.document.querySelector<HTMLButtonElement>('[data-model="actual-pro"]')!.click();
  expect(select('composerModel').value).toBe('actual-pro');
  expect(select('composerReasoning').value).toBe('pro');
  expect(dom.window.document.getElementById('composerPowerModel')!.textContent).toBe('Pro');
  expect(dom.window.document.getElementById('composerPowerChoices')!.textContent).not.toContain('Other');
  models = [{ id: 'limited-six', label: 'GPT-6', efforts: ['medium'] }];
  applyChatModels(config); await Promise.resolve();
  expect(confirmedComposerModel()).toBeNull();
  dom.window.document.querySelector<HTMLButtonElement>('[data-model="limited-six"]')!.click();
  expect(select('composerModel').value).toBe('limited-six');
  expect(select('composerReasoning').value).toBe('medium');
  expect([...select('composerReasoning').options].some(option => option.value === 'high')).toBe(false);
});

it('keeps model provider order and restricts the slider to the selected model’s observed efforts', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'astra', label: 'GPT-6 Astra', efforts: ['high'] },
    { id: 'old', label: 'GPT-5.5', efforts: ['low', 'high', 'pro'] },
    { id: 'sol', label: 'GPT-5.6 Sol', efforts: ['none', 'high', 'minimal', 'low', 'medium'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: Date.now(), models } }) } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const doc = dom.window.document;
  expect([...doc.querySelectorAll<HTMLElement>('[data-model]')].map(row => row.dataset.model)).toEqual(['astra', 'old', 'sol']);
  // A single effort (Instant) is not a choice: no slider, the effort is named instead.
  expect(doc.querySelector('#composerPowerChoices input')).toBeNull();
  expect(doc.getElementById('composerPowerModel')!.textContent).toBe('High');
  const header = doc.querySelector('.power-header')!;
  expect(header.querySelector('.power-icon') === null).toBe(true);
  expect(header.querySelector('#composerPowerTitle')).not.toBeNull();
  expect(header.querySelector('#composerPowerModel')).not.toBeNull();
  doc.querySelector<HTMLButtonElement>('[data-model="sol"]')!.click();
  const slider = doc.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(slider.max).toBe('4');
  for (const [index, reasoningEffort] of ['none', 'minimal', 'low', 'medium', 'high'].entries()) {
    slider.value = String(index); slider.dispatchEvent(new dom.window.Event('input'));
    expect(confirmedComposerModel()).toEqual({ model: 'sol', reasoningEffort });
  }
  expect(doc.querySelector('.power-track')!.getAttribute('style')).toContain('--power-fraction: 1');
  expect(doc.querySelectorAll('.power-track .power-stop')).toHaveLength(5);
  const effort = doc.getElementById('composerReasoning') as HTMLSelectElement;
  const injected = doc.createElement('option'); injected.value = 'ultra'; effort.append(injected); effort.value = 'ultra';
  expect(confirmedComposerModel()).toBeNull();
});

it('offers GPT-5.6 Pro and GPT-6 Pro with distinct observed model identities', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['none', 'medium', 'high', 'xhigh', 'pro'] },
    { id: '6', label: 'GPT-6 Pro', efforts: ['pro'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', models } }) } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(slider.max).toBe('4');
  for (const model of ['5.6', '6']) {
    dom.window.document.querySelector<HTMLButtonElement>(`[data-model="${model}"]`)!.click();
    const effortSlider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input');
    if (effortSlider) { effortSlider.value = effortSlider.max; effortSlider.dispatchEvent(new dom.window.Event('input')); }
    expect(confirmedComposerModel()).toEqual({ model, reasoningEffort: 'pro' });
    // GPT-5.6 Sol has five efforts and a slider; GPT-6 Pro has only Pro and none.
    if (model === '5.6') expect(effortSlider!.getAttribute('aria-valuetext')).toBe('Pro');
    else expect(effortSlider).toBeNull();
    expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe(`GPT-${model} Pro`);
  }
});

it('keeps the trigger consistent with send admission during reload and a removed effort', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let catalog = { state: 'ready', requestedAt: 1, observedAt: 2, models: [{ id: 'sol', label: 'GPT-5.6 Sol', efforts: ['high', 'xhigh'] }] };
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: catalog }),
    requestChatModels: async () => ({ ok: true, data: { ...catalog, state: 'pending', requestedAt: 3 } })
  } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  const config = { multiAgent: {}, goal: {} } as Config;
  initChatModels(); applyChatModels(config); await Promise.resolve();
  const label = dom.window.document.getElementById('composerModelLabel')!;
  expect(label.textContent).toBe('GPT-5.6 Sol · High');
  expect(confirmedComposerModel()).toEqual({ model: 'sol', reasoningEffort: 'high' });
  dom.window.document.getElementById('refreshComposerModels')!.click();
  expect(confirmedComposerModel()).toEqual({ model: 'sol', reasoningEffort: 'high' });
  expect(label.textContent).toBe('GPT-5.6 Sol · High');
  await Promise.resolve(); await Promise.resolve();
  applyChatModels(config); await Promise.resolve();
  expect(label.textContent).toBe('GPT-5.6 Sol · High');
  expect(confirmedComposerModel()).toEqual({ model: 'sol', reasoningEffort: 'high' });
  catalog = { ...catalog, models: [{ id: 'sol', label: 'GPT-5.6 Sol', efforts: ['medium'] }] };
  applyChatModels(config); await Promise.resolve();
  expect(confirmedComposerModel()).toBeNull();
  expect(label.textContent).toBe('Select model');
  // The only remaining effort still needs one explicit confirmation, now a button, not a slider.
  expect(dom.window.document.querySelector('#composerPowerChoices input')).toBeNull();
  const confirm = dom.window.document.querySelector<HTMLButtonElement>('#composerPowerChoices .power-single')!;
  expect(confirm.textContent).toBe('Use effort: Medium');
  confirm.click();
  expect(dom.window.document.querySelector('#composerPowerChoices .power-single')).toBeNull();
  expect(confirmedComposerModel()).toEqual({ model: 'sol', reasoningEffort: 'medium' });
  expect(label.textContent).toBe('GPT-5.6 Sol · Medium');
  expect(label.title).toBe(label.textContent);
});
it('paints catalog pushes immediately and refuses late startup reads without refetching on unrelated state', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (catalog: any) => void, resolve!: (result: any) => void;
  const getChatModels = vi.fn(() => new Promise<any>(done => { resolve = done; }));
  Object.assign(dom.window, { api: { getChatModels, onChatModelsChanged: (listener: typeof receive) => { receive = listener; } } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  const config = { multiAgent: {}, goal: {} } as Config;
  initChatModels(); applyChatModels(config);
  receive({ state: 'ready', requestedAt: 1, observedAt: 2, models: [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['high', 'pro'] }] });
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  resolve({ ok: true, data: { state: 'pending', requestedAt: 1, observedAt: null, models: [] } }); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  applyChatModels(config); applyChatModels(config);
  expect(getChatModels).toHaveBeenCalledTimes(1);
});
it('preserves an observed saved execution slug together with its Pro reasoning', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2,
    models: [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['high', 'pro'], aliases: ['gpt-5-6-thinking', 'gpt-5-6-pro'] }] } }) } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: { defaultModel: 'gpt-5-6-pro', defaultReasoning: 'pro' }, goal: {} } as Config); await Promise.resolve();
  const model = dom.window.document.getElementById('workerModel') as HTMLSelectElement;
  expect(model.value).toBe('gpt-5-6-pro'); expect(model.options).toHaveLength(2);
  expect((dom.window.document.getElementById('workerReasoning') as HTMLSelectElement).value).toBe('pro');
});
it('preserves worker execution aliases without inferring a different family effort', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', models: [
    { id: 'family', label: 'Future model', efforts: ['high', 'pro'], aliases: ['future-thinking', 'future-pro'] }
  ] } }) } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: { defaultModel: 'future-pro', defaultReasoning: null }, goal: {} } as unknown as Config);
  await Promise.resolve();
  const model = dom.window.document.getElementById('workerModel') as HTMLSelectElement;
  const effort = dom.window.document.getElementById('workerReasoning') as HTMLSelectElement;
  expect(model.value).toBe('future-pro'); expect(model.selectedOptions[0]!.disabled).toBe(false); expect(effort.value).toBe('');
  model.value = 'family'; model.dispatchEvent(new dom.window.Event('change'));
  expect(effort.value).toBe('high');
});
it.each(['5.6', 'gpt-5.6-sol', 'GPT-5.6 Sol', 'gpt-5-6-thinking'])('keeps saved Sol High selected across reordered catalogs: %s', async saved => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (catalog: any) => void;
  const models = [
    { id: '6', label: 'GPT-6 Pro', efforts: ['pro'], aliases: ['gpt-6-pro'] },
    { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['none', 'medium', 'high', 'xhigh', 'pro'], aliases: ['gpt-5-6-thinking', 'gpt-5-6-pro'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', models } }), onChatModelsChanged: (listener: typeof receive) => { receive = listener; } } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: { defaultModel: saved, defaultReasoning: 'high' }, goal: {} } as Config); await Promise.resolve();
  const check = () => {
    const model = dom.window.document.getElementById('workerModel') as HTMLSelectElement;
    expect(model.value).toBe(saved === 'gpt-5-6-thinking' ? saved : '5.6'); expect(model.selectedOptions[0]!.disabled).toBe(false);
    expect((dom.window.document.getElementById('workerReasoning') as HTMLSelectElement).value).toBe('high');
  };
  check(); receive({ state: 'ready', models: [...models].reverse() }); check();
});

it('offers ChatGPT’s current model only when no account list is readable, and only on an explicit choice (#104)', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (catalog: any) => void;
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'pending', requestedAt: 1, observedAt: null, models: [] } }),
    onChatModelsChanged: (listener: typeof receive) => { receive = listener; } } });
  const { initChatModels, applyChatModels, composerSendModel, confirmedComposerModel, ensureComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const button = () => dom.window.document.querySelector<HTMLButtonElement>('[data-use-current-model]');
  // Still reading: nothing is offered, and nothing is sent without a choice.
  expect(button()).toBeNull();
  expect(composerSendModel()).toBeNull();
  // A Go/Free account has no picker, so discovery ends without any list.
  receive({ state: 'unavailable', requestedAt: 1, observedAt: 2, models: [], error: 'ChatGPT’s native model picker could not be read.' });
  expect(button(), 'offered once no list is readable').not.toBeNull();
  expect(composerSendModel(), 'never chosen silently').toBeNull();
  button()!.click();
  expect(composerSendModel()).toEqual({ model: null, reasoningEffort: null });
  expect(await ensureComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(confirmedComposerModel(), 'the confirmed-pair contract is unchanged').toBeNull();
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('ChatGPT’s current model');
  // A readable list takes over again at once.
  receive({ state: 'ready', requestedAt: 3, observedAt: 4, models: [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high'] }] });
  expect(composerSendModel()).toEqual({ model: 'gpt-6', reasoningEffort: 'high' });
  expect(button()).toBeNull();
});

it('glides the effort thumb, picks the nearest effort, settles on release and steps by keys', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [{ id: 'think', label: 'GPT-5.6 Thinking', efforts: ['medium', 'high', 'xhigh'] }];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: Date.now(), models } }) } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const doc = dom.window.document;
  const slider = doc.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  const track = doc.querySelector<HTMLElement>('.power-track')!;
  expect(slider.step).toBe('any');
  expect(doc.querySelectorAll('.power-track .power-stop')).toHaveLength(3);
  // Mid-drag: the fill follows the pointer exactly, the effort is the nearest stop.
  slider.value = '1.4'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(track.style.getPropertyValue('--power-fraction')).toBe('0.7');
  expect(confirmedComposerModel()).toEqual({ model: 'think', reasoningEffort: 'high' });
  // Release: the thumb settles on that stop.
  slider.dispatchEvent(new dom.window.Event('change'));
  expect(slider.value).toBe('1');
  expect(track.style.getPropertyValue('--power-fraction')).toBe('0.5');
  // Keys move one whole effort at a time and stop at the ends.
  slider.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  expect(confirmedComposerModel()).toEqual({ model: 'think', reasoningEffort: 'xhigh' });
  slider.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  expect(confirmedComposerModel()).toEqual({ model: 'think', reasoningEffort: 'xhigh' });
  slider.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home' }));
  expect(confirmedComposerModel()).toEqual({ model: 'think', reasoningEffort: 'medium' });
  expect(slider.getAttribute('aria-valuetext')).toBe('Medium');
});
