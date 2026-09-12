import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { UsageOverview } from '../src/shared/usage.js';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it.each([256_000, 400_000])('shows the calculated %i context cap and edits formula preferences without reloading recordings', async (contextTokenCap) => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = [
    { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 1e6 },
    { model: 'another-model', reasoningEffort: 'low', assumed: false, tokens: 1e6 }
  ];
  const data: UsageOverview = { contextTokenCap, tokens: 2e6, models, days: [{ date: '2026-09-05', tokens: 2e6, models }], sessions: 1, limits: ['deep_research', 'file_upload', 'paste_text_to_file', 'image_gen'].map(model => ({ model, scope: 'feature', remaining: 3, remainingPercent: 50, resetAt: null, windowSeconds: null, observedAt: Date.now() })) };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage, getChatModels: async () => ({ ok: true, data: { models: [] } }) } });
  const { initUsage, refreshUsage } = await import('../src/renderer/usage.js');
  const field = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement;
  const change = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new dom.window.Event('input')); };
  const cost = () => dom.window.document.getElementById('usageTotalCost')!.textContent;
  const divisor = field('usageDivisor');
  initUsage(); await refreshUsage();
  expect(dom.window.document.getElementById('usageFormula')!.textContent).toContain(`capped at ${contextTokenCap.toLocaleString()} tokens`);
  const formulaDetails = dom.window.document.getElementById('usageFormulaDetails') as HTMLDetailsElement;
  expect(formulaDetails.open).toBe(false);
  expect(divisor.closest('details')).toBe(formulaDetails);
  expect(dom.window.document.getElementById('usageRates')!.closest('details')).toBe(formulaDetails);
  expect(dom.window.document.getElementById('usageDays')!.closest('details')).toBeNull();
  expect(dom.window.document.getElementById('usageTotalCost')!.closest('details')).toBeNull();
  formulaDetails.querySelector('summary')!.click();
  expect(formulaDetails.open).toBe(true);
  const balances = dom.window.document.getElementById('modelUsage')!;
  for (const label of ['Deep research', 'File uploads', 'Pasted text files', 'Image generation']) expect(balances.textContent).toContain(label);
  expect(balances.textContent).not.toMatch(/deep_research|file_upload|paste_text_to_file|image_gen|below/);
  expect(field('usageDivisor')).toBe(divisor);
  expect(dom.window.document.getElementById('costModel')).toBeNull();
  expect(cost()).toContain('0.48'); expect(cost()).toContain('unpriced');
  change(divisor, '4');
  expect(cost()).toContain('0.24');
  expect(dom.window.document.getElementById('usageFormula')!.textContent).toContain('÷ 4');
  formulaDetails.querySelector('summary')!.click();
  expect(formulaDetails.open).toBe(false);
  expect(cost()).toContain('0.24');
  change(divisor, '0'); // Invalid edits do not corrupt the active calculation.
  expect(cost()).toContain('0.24');
  const unknownRate = dom.window.document.querySelector('input[aria-label="another-model cached-input USD per million tokens"]') as HTMLInputElement;
  change(unknownRate, '1');
  expect(cost()).toContain('0.84'); expect(cost()).not.toContain('unpriced');
  change(field('usageMultiplier'), '1');
  expect(cost()).toContain('0.70');
  expect(getUsage).toHaveBeenCalledTimes(1);
  expect(JSON.parse(dom.window.localStorage.getItem('usage-formula-v1')!)).toMatchObject({ divisor: 4, multiplier: 1, rates: { 'gpt-5.6': 0.4, 'gpt-5.6-sol': 0.4, 'gpt-6-astra': 1, 'gpt-5.5': 0.5, 'another-model': 1 } });
  vi.resetModules();
  const restored = await import('../src/renderer/usage.js');
  restored.initUsage(); await restored.refreshUsage();
  expect(field('usageDivisor').value).toBe('4'); expect(field('usageMultiplier').value).toBe('1');
  expect(cost()).toContain('0.70');
});

it('shows the Sol picker alias rate and preserves an explicitly cleared rate after reload', async () => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = [{ model: 'gpt-5-6-thinking', reasoningEffort: 'high', assumed: false, tokens: 427245 }];
  const data: UsageOverview = { contextTokenCap: 256_000, tokens: 427245, models, days: [{ date: '2026-09-07', tokens: 427245, models }], sessions: 1, limits: [] };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage, getChatModels: async () => ({ ok: true, data: { models: [] } }) } });
  const usage = await import('../src/renderer/usage.js');
  usage.initUsage(); await usage.refreshUsage();
  const rate = () => dom.window.document.querySelector('input[aria-label="gpt-5-6-thinking cached-input USD per million tokens"]') as HTMLInputElement;
  expect(rate().value).toBe('0.4');
  expect(dom.window.document.getElementById('usageTotalCost')!.textContent).toContain('0.21');
  expect(dom.window.document.getElementById('usageDays')!.textContent).not.toContain('Rate unknown');
  rate().value = ''; rate().dispatchEvent(new dom.window.Event('input'));
  expect(getUsage).toHaveBeenCalledTimes(1);
  expect(dom.window.document.getElementById('usageDays')!.textContent).toContain('Rate unknown');
  vi.resetModules();
  const restored = await import('../src/renderer/usage.js');
  restored.initUsage(); await restored.refreshUsage();
  expect(rate().value).toBe('');
  expect(dom.window.document.getElementById('usageDays')!.textContent).toContain('Rate unknown');
});

it('combines equivalent recorded names in the table while keeping raw rate edits and partial unknown cost', async () => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = ['5.6', 'gpt-5-6-thinking', 'gpt-5.6-sol'].map(model => ({ model, reasoningEffort: 'high', assumed: false, tokens: 1e6 }));
  const data: UsageOverview = { contextTokenCap: 256_000, tokens: 3e6, models, days: [{ date: '2026-09-08', tokens: 3e6, models }], sessions: 1, limits: [] };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage, getChatModels: async () => ({ ok: true, data: { models: [] } }) } });
  const usage = await import('../src/renderer/usage.js'); usage.initUsage(); await usage.refreshUsage();
  const table = () => dom.window.document.querySelector('#usageDays table')!;
  expect(table().querySelectorAll('tr')).toHaveLength(2);
  expect(table().textContent).toContain('gpt-5.6-sol · high');
  expect(table().textContent).toContain('1.44');
  expect(table().querySelector('[data-usage-hint]')!.getAttribute('data-usage-hint')).toBe('Recorded IDs: 5.6, gpt-5-6-thinking, gpt-5.6-sol');
  expect(dom.window.document.querySelectorAll('#usageRates input')).toHaveLength(3);
  const rate = dom.window.document.querySelector('input[aria-label="5.6 cached-input USD per million tokens"]') as HTMLInputElement;
  rate.value = ''; rate.dispatchEvent(new dom.window.Event('input'));
  expect(table().textContent).toContain('0.96 + unpriced');
  expect(getUsage).toHaveBeenCalledTimes(1);
  expect(models[0]!.model).toBe('5.6');
});
