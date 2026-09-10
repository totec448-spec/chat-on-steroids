import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { UsageOverview } from '../src/shared/usage.js';
import { createRendererRoot, flushReact, installRendererDom, ok, setNativeValue } from './renderer-react-helpers.js';

let dom: ReturnType<typeof installRendererDom>['dom'] | null = null; let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; dom?.window.close(); dom = null; vi.restoreAllMocks(); vi.resetModules(); });

it('edits local comparison rates without reloading recordings and restores friendly usage labels', async () => {
  const models = [{ model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 1e6 }, { model: 'another-model', reasoningEffort: 'low', assumed: false, tokens: 1e6 }];
  const data: UsageOverview = { tokens: 2e6, models, days: [{ date: '2026-09-05', tokens: 2e6, models }], sessions: 1, limits: ['deep_research', 'file_upload', 'paste_text_to_file', 'image_gen'].map(model => ({ model, scope: 'feature' as const, remaining: 3, remainingPercent: 50, resetAt: null, windowSeconds: null, observedAt: Date.now() })) };
  const getUsage = vi.fn(() => ok(data)); const installed = installRendererDom({ getUsage }); dom = installed.dom;
  const { UsagePage } = await import('../src/renderer/components/pages/usage-page.js'); root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(UsagePage)); await flushReact(); });
  for (const label of ['Deep research', 'File uploads', 'Pasted text files', 'Image generation']) expect(document.body.textContent).toContain(label);
  expect(document.body.textContent).toContain('Rate unknown');
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')];
  const divisor = inputs[0]!, unknownRate = inputs.find((input) => input.placeholder === 'Unknown')!;
  await act(async () => { setNativeValue(divisor, '4'); setNativeValue(unknownRate, '1'); await flushReact(); });
  expect(getUsage).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem('usage-formula-v1')!)).toMatchObject({ divisor: 4, rates: { 'another-model': 1 } });
  expect(document.body.textContent).not.toContain('Rate unknown');
});

it('groups equivalent recorded model ids while retaining exact raw rate controls and partial unpriced cost', async () => {
  const models = ['5.6', 'gpt-5-6-thinking', 'gpt-5.6-sol'].map(model => ({ model, reasoningEffort: 'high', assumed: false, tokens: 1e6 }));
  const data: UsageOverview = { tokens: 3e6, models, days: [{ date: '2026-09-08', tokens: 3e6, models }], sessions: 1, limits: [] };
  const getUsage = vi.fn(() => ok(data)); const installed = installRendererDom({ getUsage }); dom = installed.dom;
  const { UsagePage } = await import('../src/renderer/components/pages/usage-page.js'); root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(UsagePage)); await flushReact(); });
  const row = document.querySelector<HTMLTableRowElement>('tbody tr')!;
  expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(row.textContent).toContain('gpt-5.6-sol · high');
  expect(row.dataset.usageHint).toBe('Recorded IDs: 5.6, gpt-5-6-thinking, gpt-5.6-sol');
  const rate = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')].find((input) => input.value === '0.4' && input.closest('label')?.textContent?.includes('5.6'))!;
  await act(async () => { setNativeValue(rate, ''); await flushReact(); });
  expect(row.textContent).toContain('unpriced');
  expect(getUsage).toHaveBeenCalledTimes(1);
});
