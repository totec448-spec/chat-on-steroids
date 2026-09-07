import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '../src/shared/types.js';
import { readFile } from 'node:fs/promises';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

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

it('excludes GPT-5.5 from the composer slider without excluding future observed models or settings choices', async () => {
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
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#composerModel option')].map(option => option.value)).toEqual(['sol', 'future']);
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#workerModel option')].some(option => option.value === 'old')).toBe(true);
  slider.value = '2'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(confirmedComposerModel()).toEqual({ model: 'future', reasoningEffort: 'high' });
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
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.value = '2'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('GPT-5.6 Pro');
  expect(confirmedComposerModel()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'pro' });
  expect(dom.window.document.getElementById('contextMeterInfo')!.textContent).toContain('Auto-compaction off for Pro');
  slider.value = '0'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(dom.window.document.getElementById('contextMeterInfo')!.textContent).toContain('Auto-compaction off for Pro');
  expect(dom.window.document.getElementById('contextMeterArc')!.getAttribute('stroke-dasharray')).toBe('0 37.7');
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('GPT-6 Pro');
  expect(slider.getAttribute('aria-valuetext')).toBe('GPT-6 Pro');
  expect(confirmedComposerModel()).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(dom.window.document.getElementById('contextMeterInfo')!.textContent).toMatch(/Auto-compaction at 400[,.]000 tokens/);
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
  expect(select('helperModel').value).toBe('gpt-5.6-sol');
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
  expect(reload.querySelector('svg')).not.toBeNull();
  expect(reload.textContent).toBe('');
  expect(reload.getAttribute('aria-label')).toBe('Reload ChatGPT models');
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(slider.max).toBe('2');
  expect(slider.getAttribute('aria-valuetext')).toBe('GPT-6 \u00b7 High');
  slider.value = '0'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(select('composerModel').value).toBe('other');
  expect(select('composerReasoning').value).toBe('medium');
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(select('composerModel').value).toBe('observed-six');
  expect(select('composerReasoning').value).toBe('medium');
  applyChatModels(config); await Promise.resolve();
  expect(dom.window.document.querySelector('#composerPowerChoices input')).toBe(slider);
  models = [{ id: 'actual-pro', label: 'GPT-6 Pro', efforts: ['pro'] }];
  applyChatModels(config); await Promise.resolve();
  expect(confirmedComposerModel()).toBeNull();
  (dom.window.document.querySelector('#composerPowerChoices input') as HTMLInputElement).dispatchEvent(new dom.window.Event('input'));
  expect(select('composerModel').value).toBe('actual-pro');
  expect(select('composerReasoning').value).toBe('pro');
  expect(dom.window.document.getElementById('composerPowerModel')!.textContent).toContain('GPT-6 Pro');
  expect(dom.window.document.getElementById('composerPowerChoices')!.textContent).not.toContain('Other');
  models = [{ id: 'limited-six', label: 'GPT-6', efforts: ['medium'] }];
  applyChatModels(config); await Promise.resolve();
  expect(confirmedComposerModel()).toBeNull();
  (dom.window.document.querySelector('#composerPowerChoices input') as HTMLInputElement).dispatchEvent(new dom.window.Event('input'));
  expect(select('composerModel').value).toBe('limited-six');
  expect(select('composerReasoning').value).toBe('medium');
  expect([...select('composerReasoning').options].some(option => option.value === 'high')).toBe(false);
});

it('keeps observed composer choices in provider order except the user-excluded GPT-5.5 section', async () => {
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
  const slider = doc.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(slider.max).toBe('3');
  expect(doc.querySelectorAll('.power-dot')).toHaveLength(4);
  const header = doc.querySelector('.power-header')!;
  expect(header.querySelector('.power-icon') === null).toBe(true);
  expect(header.querySelector('#composerPowerTitle')).not.toBeNull();
  expect(header.querySelector('#composerPowerModel')).not.toBeNull();
  expect(header.querySelector('#refreshComposerModels')).not.toBeNull();
  const expected = [['astra', 'high'], ['sol', 'low'], ['sol', 'medium'], ['sol', 'high']];
  for (const [index, [model, reasoningEffort]] of expected.entries()) {
    slider.value = String(index); slider.dispatchEvent(new dom.window.Event('input'));
    expect(confirmedComposerModel()).toEqual({ model, reasoningEffort });
    expect(slider.getAttribute('aria-valuetext')).not.toMatch(/Instant|Minimal/);
  }
  expect(doc.querySelector('.power-track')!.getAttribute('style')).toContain('--power-position: 100%');
  const effort = doc.getElementById('composerReasoning') as HTMLSelectElement;
  const injected = doc.createElement('option'); injected.value = 'none'; effort.append(injected); effort.value = 'none';
  expect(confirmedComposerModel()).toBeNull();
});

it('keeps the trigger consistent with send admission during reload and a removed effort', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let catalog = { state: 'ready', requestedAt: 1, observedAt: 2, models: [{ id: 'sol', label: 'GPT-5.6 Sol', efforts: ['high', 'xhigh'] }] };
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: catalog }),
    requestChatModels: async () => ({ ok: true, data: { state: 'pending', requestedAt: 3, observedAt: null, models: [] } })
  } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  const config = { multiAgent: {}, goal: {} } as Config;
  initChatModels(); applyChatModels(config); await Promise.resolve();
  const label = dom.window.document.getElementById('composerModelLabel')!;
  expect(label.textContent).toBe('GPT-5.6 Sol · High');
  expect(confirmedComposerModel()).toEqual({ model: 'sol', reasoningEffort: 'high' });
  dom.window.document.getElementById('refreshComposerModels')!.click();
  expect(confirmedComposerModel()).toBeNull();
  expect(label.textContent).toBe('Loading models…');
  await Promise.resolve(); await Promise.resolve();
  applyChatModels(config); await Promise.resolve();
  expect(label.textContent).toBe('GPT-5.6 Sol · High');
  expect(confirmedComposerModel()).toEqual({ model: 'sol', reasoningEffort: 'high' });
  catalog = { ...catalog, models: [{ id: 'sol', label: 'GPT-5.6 Sol', efforts: ['medium'] }] };
  applyChatModels(config); await Promise.resolve();
  expect(confirmedComposerModel()).toBeNull();
  expect(label.textContent).toBe('Select model');
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.dispatchEvent(new dom.window.Event('input'));
  expect(confirmedComposerModel()).toEqual({ model: 'sol', reasoningEffort: 'medium' });
  expect(label.textContent).toBe('GPT-5.6 Sol · Medium');
  expect(label.title).toBe(label.textContent);
});
