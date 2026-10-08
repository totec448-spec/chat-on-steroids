import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '../src/shared/types.js';
import { readFile } from 'node:fs/promises';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
it('opens the model list as presentation only and returns focus through both Escape boundaries', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'sol', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'] },
    { id: 'pro', label: 'GPT-6 Pro', efforts: ['pro'] },
    { id: 'future', label: 'Future model', efforts: ['low', 'high'] }
  ];
  const requestChatModels = vi.fn();
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', observedAt: 2, models } }), requestChatModels
  } });
  const { initChatModels, applyChatModels, composerSendModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const doc = dom.window.document;
  const menu = doc.getElementById('modelMenu') as HTMLDetailsElement;
  const toggle = doc.getElementById('composerModelToggle') as HTMLButtonElement;
  const list = doc.getElementById('composerModelChoices')!;
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Preserve this draft';
  const pair = composerSendModel();
  menu.open = true;
  expect(list.hidden).toBe(true);
  expect(list.inert).toBe(true);
  toggle.click();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(list.hidden).toBe(false);
  expect(list.inert).toBe(false);
  // Automatic comes first, as a deliberate choice that switches nothing (#864).
  expect([...list.querySelectorAll<HTMLElement>('[data-model]')].map(button => button.dataset.model)).toEqual(['', 'sol', 'pro', 'future']);
  expect(doc.activeElement?.getAttribute('data-model')).toBe('sol');
  expect(composerSendModel()).toEqual(pair);
  doc.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(list.hidden).toBe(true); expect(menu.open).toBe(true); expect(doc.activeElement).toBe(toggle);
  expect(list.inert).toBe(true);
  toggle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(menu.open).toBe(false); expect(doc.activeElement).toBe(menu.querySelector('summary'));
  expect(composerSendModel()).toEqual(pair); expect(input.value).toBe('Preserve this draft');
  expect(requestChatModels).not.toHaveBeenCalled();
});
it.each([false, true])('switches the current model between minimum and maximum effort with interruptible feedback (reduced motion=%s)', async reduced => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const requestChatModels = vi.fn(), sendInput = vi.fn();
  Object.assign(dom.window, { matchMedia: () => ({ matches: reduced }), api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', observedAt: 2, models: [{ id: 'sol', label: 'GPT-5.6 Sol', efforts: ['ultra', 'high', 'none', 'low'] }] } }), requestChatModels, sendInput
  } });
  const animations: Array<{ target: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean }> = [];
  Object.assign(dom.window.HTMLElement.prototype, {
    getAnimations(this: HTMLElement) { return animations.filter(animation => animation.target === this && !animation.cancelled).map(animation => ({ cancel() { animation.cancelled = true; } })); },
    animate(this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) { animations.push({ target: this, frames, options, cancelled: false }); }
  });
  const { initChatModels, applyChatModels, composerSendModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const doc = dom.window.document, spark = doc.getElementById('composerSpark') as HTMLButtonElement;
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  const menu = doc.getElementById('modelMenu') as HTMLDetailsElement;
  input.value = 'Do not send this draft'; menu.open = true; spark.focus();
  expect(composerSendModel()).toEqual({ model: 'sol', reasoningEffort: 'high' });
  expect(spark.dataset.action).toBe('min');
  expect(spark.title).toBe('Use minimum effort: Instant');
  spark.click();
  expect(composerSendModel()).toEqual({ model: 'sol', reasoningEffort: 'none' });
  expect(doc.getElementById('composerPowerTitle')!.textContent).toBe('Instant');
  expect((doc.querySelector('#composerPowerChoices input') as HTMLInputElement).value).toBe('0');
  expect(spark.dataset.action).toBe('max');
  expect(spark.getAttribute('aria-label')).toBe('Use maximum effort: Ultra');
  spark.click();
  expect(composerSendModel()).toEqual({ model: 'sol', reasoningEffort: 'ultra' });
  expect(doc.getElementById('composerPowerTitle')!.textContent).toBe('Ultra');
  expect((doc.querySelector('#composerPowerChoices input') as HTMLInputElement).value).toBe('3');
  expect(spark.dataset.action).toBe('min');
  spark.click();
  expect(composerSendModel()).toEqual({ model: 'sol', reasoningEffort: 'none' });
  expect(doc.querySelector('.toast')).toBeNull();
  expect(animations.filter(animation => !animation.cancelled)).toHaveLength(2);
  expect(animations.some(animation => animation.cancelled)).toBe(true);
  expect(animations.every(animation => Number(animation.options.duration) <= 200 && !animation.options.iterations)).toBe(true);
  if (reduced) expect(animations.every(animation => animation.frames.every(frame => !frame.transform))).toBe(true);
  expect(input.value).toBe('Do not send this draft');
  expect(menu.open).toBe(true); expect(doc.activeElement).toBe(spark);
  expect(requestChatModels).not.toHaveBeenCalled(); expect(sendInput).not.toHaveBeenCalled();
});
it('derives the effort shortcut from slider, session and account changes and disables it without two available efforts', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (catalog: any) => void;
  const models = [{ id: 'sol', label: 'GPT-6', efforts: ['low', 'high', 'ultra'] }, { id: 'instant', label: 'Instant model', efforts: ['none'] }];
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', models } }),
    onChatModelsChanged: (listener: typeof receive) => { receive = listener; }
  } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, composerSendModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const doc = dom.window.document, spark = doc.getElementById('composerSpark') as HTMLButtonElement;
  const slider = doc.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.value = '0'; slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(spark.dataset.action).toBe('max'); expect(spark.title).toBe('Use maximum effort: Ultra');
  applyComposerSessionModel('chat-b', { model: 'sol', reasoningEffort: 'ultra', observedAt: 3 });
  expect(spark.dataset.action).toBe('min');
  applyComposerSessionModel('chat-a', { model: 'sol', reasoningEffort: 'low', observedAt: 4 });
  expect(spark.dataset.action).toBe('max');
  applyComposerSessionModel('single', { model: 'instant', reasoningEffort: 'none', observedAt: 5 });
  expect(spark.disabled).toBe(true);
  spark.click();
  expect(composerSendModel()).toEqual({ model: 'instant', reasoningEffort: 'none' });
  receive({ state: 'unavailable', models: [], error: 'No account choices' });
  expect(spark.disabled).toBe(true);
  spark.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  // Without a list, an existing chat sends with its own current model, switching nothing (#864).
  expect(composerSendModel()).toEqual({ model: null, reasoningEffort: null });
});
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

it('a send for an exact default requests missing models once and waits for the pushed catalog before selecting', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const requestChatModels = vi.fn(async () => ({ ok: true, data: { state: 'pending', requestedAt: 1, observedAt: null, models: [] } }));
  const models = [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high'] }];
  let ready = false;
  Object.assign(dom.window, { api: { requestChatModels, getChatModels: async () => ({ ok: true,
    data: ready ? { state: 'ready', requestedAt: 1, observedAt: 2, models } : { state: 'unknown', requestedAt: null, observedAt: null, models: [] } }) } });
  const { initChatModels, ensureComposerModel, applyChatModels, applyComposerSessionModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  const config = { ui: { defaultChatModel: 'gpt-6', defaultChatReasoning: 'high' }, multiAgent: {}, goal: {} } as Config;
  applyChatModels(config); await Promise.resolve();
  applyComposerSessionModel(null, null);
  const first = ensureComposerModel(), second = ensureComposerModel();
  let resolved = false; void first.then(() => { resolved = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(requestChatModels).toHaveBeenCalledTimes(1); expect(resolved).toBe(false);
  ready = true;
  applyChatModels(config); await Promise.resolve();
  expect(await first).toEqual({ model: 'gpt-6', reasoningEffort: 'high' });
  expect(await second).toEqual({ model: 'gpt-6', reasoningEffort: 'high' });
});

it('sends Automatic at once when no particular model was asked for and no list is readable yet (#864)', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const requestChatModels = vi.fn(async () => ({ ok: true, data: { state: 'pending', requestedAt: 1, observedAt: null, models: [] } }));
  Object.assign(dom.window, { api: { requestChatModels, getChatModels: async () => ({ ok: true, data: { state: 'pending', requestedAt: 1, observedAt: null, models: [] } }) } });
  const { initChatModels, ensureComposerModel, applyChatModels, applyComposerSessionModel, composerSendModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  applyComposerSessionModel(null, null);
  // Go and Free accounts have no picker at all; Send used to wait two minutes for a list that never came.
  expect(composerSendModel()).toEqual({ model: null, reasoningEffort: null });
  expect(await ensureComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(requestChatModels).not.toHaveBeenCalled();
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('Automatic');
});

it('a failed discovery confirms no exact default and settles its wait', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { requestChatModels: async () => ({ ok: true, data: { state: 'unavailable', requestedAt: 1, observedAt: 2, models: [] } }),
    getChatModels: async () => ({ ok: true, data: { state: 'unknown', requestedAt: null, observedAt: null, models: [] } }) } });
  const { initChatModels, ensureComposerModel, applyChatModels, applyComposerSessionModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ ui: { defaultChatModel: 'gpt-6', defaultChatReasoning: 'high' }, multiAgent: {}, goal: {} } as Config);
  applyComposerSessionModel(null, null);
  expect(await ensureComposerModel()).toBeNull();
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
  // Nothing particular is asked for, so the composer stays Automatic while the list loads.
  expect(dom.window.document.getElementById('composerPowerTitle')!.textContent).toBe('Automatic');
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
  expect(labels).toEqual(['Automatic', '5.6 · Instant', '5.6 · Reasoning', '5.5 · Instant', '5.5 · Reasoning']);
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#workerModel option')].map(option => option.value)).toEqual(['', ...models.map(model => model.id)]);
});

it('shows a sub-agent default that was never chosen as Automatic, which is what workers then use', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [{ id: 'gpt-6', label: 'GPT-6', efforts: ['medium', 'high'] }, { id: 'gpt-5-6', label: '5.6', efforts: ['none'] }];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }) } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: { defaultModel: '', defaultReasoning: '' }, goal: {} } as Config); await Promise.resolve();
  const shown = (id: string) => { const select = dom.window.document.getElementById(id) as HTMLSelectElement; return [select.value, select.selectedOptions[0]?.textContent]; };
  expect(shown('workerModel')).toEqual(['', 'Automatic']);
  expect(shown('workerReasoning')).toEqual(['', 'Automatic']);
  // A chosen default stays exactly that, with its own efforts.
  applyChatModels({ multiAgent: { defaultModel: 'gpt-6', defaultReasoning: 'high' }, goal: {} } as Config); await Promise.resolve();
  expect(shown('workerModel')).toEqual(['gpt-6', 'GPT-6']);
  expect(shown('workerReasoning')).toEqual(['high', 'High']);
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

it('uses ordinary new-chat defaults only when there is no per-conversation selection', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'] },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high', 'xhigh'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }) } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  const config = {
    ui: { defaultChatModel: 'gpt-5.6-sol', defaultChatReasoning: 'xhigh' },
    multiAgent: { defaultModel: 'gpt-6-pro', defaultReasoning: 'pro' },
    goal: { helperModel: 'gpt-5.6-sol', helperReasoning: 'high' }
  } as unknown as Config;
  initChatModels(); applyChatModels(config); await Promise.resolve();

  applyComposerSessionModel(null, null);
  expect(confirmedComposerModel()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' });
  expect((dom.window.document.getElementById('workerModel') as HTMLSelectElement).value).toBe('gpt-6-pro');
  expect((dom.window.document.getElementById('workerReasoning') as HTMLSelectElement).value).toBe('pro');
  expect((dom.window.document.getElementById('helperReasoning') as HTMLSelectElement).value).toBe('high');

  applyComposerSessionModel('existing:1', { model: 'gpt-5.6-sol', reasoningEffort: 'high', observedAt: 3 });
  expect(confirmedComposerModel()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  applyComposerSessionModel('existing:2', null);
  expect(confirmedComposerModel()).toBeNull();
  applyComposerSessionModel(null, null);
  expect(confirmedComposerModel()).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' });
});

it('keeps ordinary new-chat defaults Automatic through an explicit model refresh', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const catalog = {
    state: 'ready' as const, requestedAt: 1, observedAt: 2,
    models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high', 'xhigh'] as const }]
  };
  let resolveRefresh!: (value: any) => void;
  const requestChatModels = vi.fn(() => new Promise<any>(resolve => { resolveRefresh = resolve; }));
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: catalog }),
    requestChatModels
  } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ ui: {}, multiAgent: {}, goal: {} } as unknown as Config); await Promise.resolve();
  const model = dom.window.document.getElementById('defaultChatModel') as HTMLSelectElement;
  const reasoning = dom.window.document.getElementById('defaultChatReasoning') as HTMLSelectElement;
  expect([model.value, reasoning.value]).toEqual(['', '']);

  const refresh = dom.window.document.getElementById('refreshChatModels') as HTMLButtonElement;
  refresh.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  expect(requestChatModels).toHaveBeenCalledTimes(1);
  resolveRefresh({ ok: true, data: { ...catalog, requestedAt: 3, observedAt: 4 } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect([model.value, reasoning.value]).toEqual(['', '']);
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
  expect(dom.window.document.getElementById('composerPowerTitle')!.textContent).toBe('Pro');
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
    { id: 'first', label: 'GPT-5.6 Sol', efforts: ['high'] }, { id: 'gpt-6-thinking', label: 'GPT-6', efforts: ['medium'] }
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
  // The badge says what runs instead, not just that something is wrong.
  expect(dom.window.document.getElementById('workerModelVerification')!.title)
    .toBe("This ChatGPT account doesn't offer this model, so ChatGPT's current model is used.");
  expect(dom.window.document.getElementById('helperModelVerification')!.hasAttribute('hidden')).toBe(true);
  // The built-in helper default is ChatGPT's GPT-6 thinking lane.
  expect(select('helperModel').value).toBe('gpt-6-thinking');
  // Selects without the badge still say so in the option itself.
  applyChatModels({ multiAgent: { defaultModel: 'unseen', defaultReasoning: 'high' }, goal: { helperModel: 'first', helperReasoning: 'ultra' } } as Config);
  await Promise.resolve();
  expect(select('helperReasoning').value).toBe('ultra');
  expect(select('helperReasoning').selectedOptions[0]!.textContent).toBe('ultra · not verified');
  expect([...select('composerModel').options].map(row => row.value)).toEqual(['first', 'gpt-6-thinking']);
  select('composerModel').value = 'first'; select('composerModel').dispatchEvent(new dom.window.Event('change'));
  expect([...select('composerReasoning').options].map(row => row.value)).toEqual(['high']);
  select('composerReasoning').value = 'high';
  select('composerModel').value = 'gpt-6-thinking'; select('composerModel').dispatchEvent(new dom.window.Event('change'));
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
  expect(reload.textContent).toBe('');
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
  expect(dom.window.document.getElementById('composerPowerTitle')!.textContent).toBe('Pro');
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
  expect([...doc.querySelectorAll<HTMLElement>('[data-model]')].map(row => row.dataset.model)).toEqual(['', 'astra', 'old', 'sol']);
  // A single effort (Instant) is not a choice: no slider, the effort is named instead.
  expect(doc.querySelector('#composerPowerChoices input')).toBeNull();
  expect(doc.getElementById('composerPowerTitle')!.textContent).toBe('High');
  expect(doc.getElementById('composerPowerModel')!.textContent).toBe('GPT-6 Astra');
  const header = doc.querySelector('.power-header')!;
  expect(header.querySelector('#composerSpark')?.getAttribute('type')).toBe('button');
  expect(header.querySelector('#composerSpark .ph-lightning')?.getAttribute('aria-hidden')).toBe('true');
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
  expect(model.value).toBe('gpt-5-6-pro'); expect([...model.options].map(option => option.value)).toEqual(['', '5.6', 'gpt-5-6-pro']);
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

it('keeps an exact default exact without a list, and offers Automatic instead of assuming it (#104, #864)', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (catalog: any) => void;
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'pending', requestedAt: 1, observedAt: null, models: [] } }),
    onChatModelsChanged: (listener: typeof receive) => { receive = listener; } } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, composerSendModel, confirmedComposerModel, ensureComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ ui: { defaultChatModel: 'gpt-6', defaultChatReasoning: 'high' }, multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  applyComposerSessionModel(null, null);
  const button = () => dom.window.document.querySelector<HTMLButtonElement>('[data-use-current-model]');
  // The person asked for GPT-6 as their default: nothing else is sent while it cannot be confirmed.
  expect(composerSendModel()).toBeNull();
  receive({ state: 'unavailable', requestedAt: 1, observedAt: 2, models: [], error: 'ChatGPT’s native model picker could not be read.' });
  expect(button(), 'Automatic is offered once no list is readable').not.toBeNull();
  expect(composerSendModel(), 'never chosen silently over an exact default').toBeNull();
  button()!.click();
  expect(composerSendModel()).toEqual({ model: null, reasoningEffort: null });
  expect(await ensureComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(confirmedComposerModel(), 'the confirmed-pair contract is unchanged').toBeNull();
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('Automatic');
  // A deliberate Automatic stays chosen when a list appears; picking a model ends it.
  receive({ state: 'ready', requestedAt: 3, observedAt: 4, models: [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high'] }] });
  expect(composerSendModel()).toEqual({ model: null, reasoningEffort: null });
  expect(button()).toBeNull();
  dom.window.document.querySelector<HTMLButtonElement>('[data-model="gpt-6"]')!.click();
  expect(composerSendModel()).toEqual({ model: 'gpt-6', reasoningEffort: 'high' });
  dom.window.document.querySelector<HTMLButtonElement>('[data-model=""]')!.click();
  expect(composerSendModel()).toEqual({ model: null, reasoningEffort: null });
  expect(dom.window.document.querySelector('[data-model=""]')!.getAttribute('aria-pressed')).toBe('true');
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
