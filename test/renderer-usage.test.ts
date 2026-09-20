import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { UsageOverview } from '../src/shared/usage.js';

let dom: JSDOM;
/**
 * The renderer prints money through `Intl.NumberFormat(undefined, …)`, on purpose: the amount
 * is read by whoever runs the app, in their own locale. A literal '1.44' in an assertion is
 * therefore not the value under test, it is en-US punctuation — and the suite failed on a
 * de-DE machine, where the same correct render reads '1,44 $'. Ask the same formatter what
 * this number looks like here, so the assertion keeps testing the amount.
 */
const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const usd = (value: number) => money.format(value);
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it('cycles the week start locally, keeps exact counts, and restores the weekday after reload', async () => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const data: UsageOverview = { contextTokenCap: 256_000, tokens: 0, models: [], days: [], sessions: 1,
    limits: [
      { model: 'gpt-6-pro', scope: 'model', remaining: 123, remainingPercent: null, resetAt: null, windowSeconds: 604800, observedAt: Date.now() },
      { model: 'deep_research', scope: 'feature', remaining: 250, remainingPercent: null, resetAt: null, windowSeconds: null, observedAt: Date.now() }
    ],
    messages: { through: new Date(2026, 8, 21, 12).getTime(), days: [
      { date: '2026-09-19', gpt56: 1234, gpt6: 12 }, { date: '2026-09-20', gpt56: 10, gpt6: 3 }, { date: '2026-09-21', gpt56: 1, gpt6: 1 }
    ] } };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage, getChatModels: async () => ({ ok: true, data: { models: [] } }) } });
  const { initLanguage, setLanguage } = await import('../src/renderer/i18n.js'); initLanguage();
  const usage = await import('../src/renderer/usage.js'); usage.initUsage();
  const element = (id: string) => dom.window.document.getElementById(id)!;
  expect(element('usageMessages6').textContent).toBe('—');
  await usage.refreshUsage();
  expect(element('usageWeekStart').textContent).toContain('Since Monday');
  expect(element('usageMessages6').textContent).toBe('1');
  expect(element('usageStatus').textContent).toBe('');
  const quotas = element('usageLimits').textContent;
  expect(quotas).toContain('123 remaining');
  expect(quotas).toContain('250 remaining');
  expect(element('usageMessageCounts').textContent).toContain('sent');
  expect(element('usageMessageCounts').textContent).not.toContain('remaining');
  const button = element('usageWeekStart') as HTMLButtonElement;
  for (let i = 0; i < 5; i++) button.click(); // Saturday.
  expect(button.textContent).toContain('Since Saturday');
  expect(element('usageMessages6').textContent).toBe('16');
  expect(element('usageMessages56').textContent).toBe((1245).toLocaleString('en')); // Never a rounded 1.2K.
  expect(element('usageMessagePeriod').textContent).toContain(new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(2026, 8, 19)));
  expect(button.title).toContain(element('usageMessagePeriod').textContent);
  expect(element('usageLimits').textContent).toBe(quotas);
  expect(dom.window.localStorage.getItem('cos.usage.weekStart')).toBe('6');
  expect(getUsage).toHaveBeenCalledTimes(1);
  setLanguage('ja');
  expect(element('usageWeekStart')).toBe(button);
  expect(button.textContent).toContain('土曜日から');
  expect(element('usageMessages6').textContent).toBe('16');
  setLanguage('en');
  button.click(); // Sunday.
  expect(button.textContent).toContain('Since Sunday');
  expect(element('usageMessages6').textContent).toBe('4');
  button.click(); // Monday again.
  expect(element('usageMessages6').textContent).toBe('1');
  expect(getUsage).toHaveBeenCalledTimes(1);
  dom.window.localStorage.setItem('cos.usage.weekStart', '6');
  vi.resetModules();
  const restored = await import('../src/renderer/usage.js'); restored.initUsage(); await restored.refreshUsage();
  expect(element('usageWeekStart').textContent).toContain('Since Saturday');
  expect(element('usageMessages6').textContent).toBe('16');
  expect(element('usageStatus').textContent).toBe('');
});

it.each(['7', '-1', '1.5', 'invalid', ''])('ignores invalid persisted weekday %j', async saved => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  dom.window.localStorage.setItem('cos.usage.weekStart', saved);
  const { initUsage } = await import('../src/renderer/usage.js'); initUsage();
  expect(dom.window.document.getElementById('usageWeekStart')!.textContent).toContain('Since Monday');
  expect(dom.window.document.getElementById('usageMessages6')!.textContent).toBe('—');
});

it('explains a pending background rebuild and replaces transport failure with a retryable status', async () => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let reject!: (error: Error) => void;
  Object.assign(dom.window, { api: {
    getUsage: () => new Promise((_resolve, fail) => { reject = fail; }),
    getChatModels: async () => ({ ok: true, data: { models: [] } })
  } });
  const { refreshUsage } = await import('../src/renderer/usage.js');
  const pending = refreshUsage();
  const status = dom.window.document.getElementById('usageStatus')!;
  const refresh = dom.window.document.getElementById('refreshUsage') as HTMLButtonElement;
  expect(status.textContent).toContain('You can keep using the app.');
  expect(refresh.disabled).toBe(true);
  reject(new Error('IPC disconnected'));
  await pending;
  expect(status.textContent).toBe('Usage could not be loaded. Try Refresh.');
  expect(refresh.disabled).toBe(false);
});

it.each([256_000, 400_000])('shows the calculated %i context cap and edits formula preferences without reloading recordings', async (contextTokenCap) => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = [
    { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 1e6 },
    { model: 'another-model', reasoningEffort: 'low', assumed: false, tokens: 1e6 }
  ];
  const data: UsageOverview = { contextTokenCap, messages: { through: Date.now(), days: [] }, tokens: 2e6, models, days: [{ date: '2026-09-05', tokens: 2e6, models }], sessions: 1, limits: ['deep_research', 'file_upload', 'paste_text_to_file', 'image_gen'].map(model => ({ model, scope: 'feature', remaining: 3, remainingPercent: 50, resetAt: null, windowSeconds: null, observedAt: Date.now() })) };
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
  expect(cost()).toContain(usd(0.48)); expect(cost()).toContain('unpriced');
  change(divisor, '4');
  expect(cost()).toContain(usd(0.24));
  expect(dom.window.document.getElementById('usageFormula')!.textContent).toContain('÷ 4');
  formulaDetails.querySelector('summary')!.click();
  expect(formulaDetails.open).toBe(false);
  expect(cost()).toContain(usd(0.24));
  change(divisor, '0'); // Invalid edits do not corrupt the active calculation.
  expect(cost()).toContain(usd(0.24));
  const unknownRate = dom.window.document.querySelector('input[aria-label="another-model cached-input USD per million tokens"]') as HTMLInputElement;
  change(unknownRate, '1');
  expect(cost()).toContain(usd(0.84)); expect(cost()).not.toContain('unpriced');
  change(field('usageMultiplier'), '1');
  expect(cost()).toContain(usd(0.7));
  expect(getUsage).toHaveBeenCalledTimes(1);
  expect(JSON.parse(dom.window.localStorage.getItem('usage-formula-v1')!)).toMatchObject({ divisor: 4, multiplier: 1, rates: { 'gpt-5.6': 0.4, 'gpt-5.6-sol': 0.4, 'gpt-6-astra': 1, 'gpt-5.5': 0.5, 'another-model': 1 } });
  vi.resetModules();
  const restored = await import('../src/renderer/usage.js');
  restored.initUsage(); await restored.refreshUsage();
  expect(field('usageDivisor').value).toBe('4'); expect(field('usageMultiplier').value).toBe('1');
  expect(cost()).toContain(usd(0.7));
});

it('shows the Sol picker alias rate and preserves an explicitly cleared rate after reload', async () => {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const models = [{ model: 'gpt-5-6-thinking', reasoningEffort: 'high', assumed: false, tokens: 427245 }];
  const data: UsageOverview = { contextTokenCap: 256_000, messages: { through: Date.now(), days: [] }, tokens: 427245, models, days: [{ date: '2026-09-07', tokens: 427245, models }], sessions: 1, limits: [] };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage, getChatModels: async () => ({ ok: true, data: { models: [] } }) } });
  const usage = await import('../src/renderer/usage.js');
  usage.initUsage(); await usage.refreshUsage();
  const rate = () => dom.window.document.querySelector('input[aria-label="gpt-5-6-thinking cached-input USD per million tokens"]') as HTMLInputElement;
  expect(rate().value).toBe('0.4');
  expect(dom.window.document.getElementById('usageTotalCost')!.textContent).toContain(usd(0.21));
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
  const data: UsageOverview = { contextTokenCap: 256_000, messages: { through: Date.now(), days: [] }, tokens: 3e6, models, days: [{ date: '2026-09-08', tokens: 3e6, models }], sessions: 1, limits: [] };
  const getUsage = vi.fn(async () => ({ ok: true, data }));
  Object.assign(dom.window, { api: { getUsage, getChatModels: async () => ({ ok: true, data: { models: [] } }) } });
  const usage = await import('../src/renderer/usage.js'); usage.initUsage(); await usage.refreshUsage();
  const table = () => dom.window.document.querySelector('#usageDays table')!;
  expect(table().querySelectorAll('tr')).toHaveLength(2);
  expect(table().textContent).toContain('gpt-5.6-sol · high');
  expect(table().textContent).toContain(usd(1.44));
  expect(table().querySelector('[data-usage-hint]')!.getAttribute('data-usage-hint')).toBe('Recorded IDs: 5.6, gpt-5-6-thinking, gpt-5.6-sol');
  expect(dom.window.document.querySelectorAll('#usageRates input')).toHaveLength(3);
  const rate = dom.window.document.querySelector('input[aria-label="5.6 cached-input USD per million tokens"]') as HTMLInputElement;
  rate.value = ''; rate.dispatchEvent(new dom.window.Event('input'));
  expect(table().textContent).toContain(`${usd(0.96)} + unpriced`);
  expect(getUsage).toHaveBeenCalledTimes(1);
  expect(models[0]!.model).toBe('5.6');
});
