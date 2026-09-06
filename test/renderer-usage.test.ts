import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { UsageOverview } from '../src/shared/usage.js';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it('edits the canonical formula controls and per-model rates without reloading recordings, then restores preferences', async () => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = [
    { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 1e6 },
    { model: 'another-model', reasoningEffort: 'low', assumed: false, tokens: 1e6 }
  ];
  const data: UsageOverview = { tokens: 2e6, models, days: [{ date: '2026-09-05', tokens: 2e6, models }], sessions: 1, limits: ['deep_research', 'file_upload', 'paste_text_to_file', 'image_gen'].map(model => ({ model, scope: 'feature', remaining: 3, remainingPercent: 50, resetAt: null, windowSeconds: null, observedAt: Date.now() })) };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage, getChatModels: async () => ({ ok: true, data: { models: [] } }) } });
  const { initUsage, refreshUsage } = await import('../src/renderer/usage.js');
  const field = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement;
  const change = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new dom.window.Event('input')); };
  const cost = () => dom.window.document.getElementById('usageTotalCost')!.textContent;
  const divisor = field('usageDivisor');
  initUsage(); await refreshUsage();
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
