import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '../src/shared/types.js';

let page: JSDOM;
afterEach(() => { page?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
const native = [
  { id: 'gpt-5-6', label: '5.6', efforts: ['none'] },
  { id: 'gpt-5-6-thinking', label: '5.6', efforts: ['medium', 'high', 'max'], effortLabels: { max: 'Extra High' } },
  { id: 'gpt-6-pro', label: '6', efforts: ['medium'], effortLabels: { medium: 'Pro' } },
  { id: 'gpt-5-6-pro', label: '5.6', efforts: ['medium'], effortLabels: { medium: 'Pro' } },
  { id: 'gpt-5-5-instant', label: '5.5', efforts: ['none'] },
  { id: 'gpt-5-5-thinking', label: '5.5', efforts: ['medium', 'high', 'max'] },
  { id: 'gpt-5-5-pro', label: '5.5', efforts: ['medium'] }
];
async function boot(models = native) {
  page = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', page.window); vi.stubGlobal('document', page.window.document);
  let receive!: (value: any) => void;
  Object.assign(page.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', observedAt: 1, models } }),
    onChatModelsChanged: (fn: typeof receive) => { receive = fn; }
  } });
  const api = await import('../src/renderer/chat-models.js');
  api.initChatModels(); api.applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const doc = page.window.document;
  const model = (id: string) => doc.querySelector<HTMLButtonElement>(`#composerModelChoices [data-model-id="${id}"]`)!;
  const effort = (value: string) => doc.querySelector<HTMLButtonElement>(`#composerPowerChoices [data-effort="${value}"]`)!;
  return { ...api, doc, model, effort, receive };
}

it('lists every observed lane, including Instant and older models, with unambiguous names', async () => {
  const f = await boot();
  expect([...f.doc.querySelectorAll('#composerModelChoices [data-model-id]')].map(n => n.getAttribute('data-model-id'))).toEqual(native.map(n => n.id));
  expect(f.model('gpt-6-pro').textContent).toContain('GPT-6 Pro');
  expect(f.model('gpt-5-6-thinking').textContent).toContain('GPT-5.6 Thinking');
  expect(f.model('gpt-5-6').textContent).toContain('GPT-5.6 Instant');
  f.model('gpt-5-5-instant').click();
  expect(f.confirmedComposerModel()).toEqual({ model: 'gpt-5-5-instant', reasoningEffort: 'none' });
  expect(f.doc.querySelector('input[type="range"]#composerPower')).toBeNull();
});

it('uses native display labels without changing the execution effort or inventing Pro levels', async () => {
  const f = await boot(); f.model('gpt-5-6-thinking').click(); f.effort('max').click();
  expect(f.effort('max').textContent).toBe('Extra High');
  expect(f.confirmedComposerModel()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'max' });
  f.model('gpt-6-pro').click();
  expect(f.doc.getElementById('composerModelLabel')!.textContent).toBe('GPT-6 Pro');
  expect(f.confirmedComposerModel()).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'medium' });
  expect(f.doc.querySelectorAll('#composerPowerChoices [data-effort]')).toHaveLength(1);
  expect(f.doc.querySelector('#composerPowerChoices [data-effort="high"]')).toBeNull();
});

it('retains focus, the requested selection and model nodes through unrelated catalog pushes', async () => {
  const f = await boot(); const button = f.model('gpt-5-6-thinking'); button.click(); button.focus();
  f.receive({ state: 'pending', models: native, waiting: 'Waiting for an idle page' });
  expect(f.model('gpt-5-6-thinking')).toBe(button); expect(f.doc.activeElement).toBe(button);
  expect(f.confirmedComposerModel()?.model).toBe('gpt-5-6-thinking');
});

it('supports keyboard model and effort selection without submitting a message', async () => {
  const f = await boot(); const submit = vi.fn(); f.doc.getElementById('composer')!.addEventListener('submit', submit);
  const first = f.model(native[0]!.id); first.click(); first.focus();
  first.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  expect(f.confirmedComposerModel()?.model).toBe('gpt-5-6-thinking');
  f.effort('medium').click(); const middle = f.effort('medium'); middle.focus();
  middle.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(f.confirmedComposerModel()?.reasoningEffort).toBe('high'); expect(submit).not.toHaveBeenCalled();
});
