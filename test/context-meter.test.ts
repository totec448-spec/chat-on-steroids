import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compactTokens, initContextMeter, paintContextMeter } from '../src/renderer/context-meter.js';
import type { Config } from '../src/shared/types.js';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });
function setup(model: string, reasoningEffort: 'high' | 'pro' = 'high') {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('Node', dom.window.Node);
  const session = { conversationId: 'chat', contextTokens: 100000,
    selectedModel: { conversationId: 'chat', model, reasoningEffort } } as SessionSummary;
  const config = { sessions: { limitTokens: 200000 }, compaction: { auto: true, autoTokens: 150000 } } as Config;
  paintContextMeter(session, config);
  return dom.window.document;
}
it('keeps Pro static and identifies token estimates and compaction exclusion', () => {
  const doc = setup('gpt-6', 'pro');
  expect(doc.getElementById('contextMeterArc')?.getAttribute('stroke-dasharray')).toBe('0 37.7');
  expect(doc.getElementById('contextMeterInfo')?.textContent).toContain('Auto-compaction off for Pro');
  expect(doc.getElementById('contextMeterButton')?.getAttribute('aria-label')).toContain('estimated');
  expect(doc.getElementById('contextTokens')?.textContent).toBe('100K');
  // Pro has no configured limit or share: the rows say so instead of showing a number.
  expect(doc.getElementById('contextLimit')?.textContent).toBe('—');
  expect(doc.getElementById('contextPercent')?.textContent).toBe('—');
  expect([...doc.querySelectorAll('.context-data dt')].map(row => row.textContent)).toEqual(['This chat (estimate)', 'Context limit', 'Filled', 'Compacts automatically at']);
});
it('uses configured limits for ordinary models and supports click and Escape', () => {
  const doc = setup('gpt-5.6-sol-high');
  expect(doc.getElementById('contextMeterButton')?.getAttribute('aria-label')).toContain('50% of configured limit');
  expect(doc.getElementById('contextMeterCompact')?.textContent).toBe('50%');
  doc.getElementById('contextDisplay')!.click();
  expect(doc.getElementById('contextMeterCompact')?.textContent).toBe('100K / 200K');
  expect(doc.getElementById('contextTokens')?.textContent).toBe('100K');
  expect(doc.getElementById('contextLimit')?.textContent).toBe('200K');
  doc.getElementById('contextDisplay')!.click();
  expect(doc.getElementById('contextMeterCompact')?.textContent).toBe('50%');
  initContextMeter();
  const button = doc.getElementById('contextMeterButton')!;
  button.click();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  button.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

it('abbreviates thousands even where the locale\'s compact notation does not', () => {
  // German compact notation leaves thousands unabbreviated ("533.333"); the chip needs "533 Tsd.".
  expect(new Intl.NumberFormat('de', { notation: 'compact' }).format(533_333)).not.toMatch(/Tsd/);
  expect(compactTokens(533_333, 'en')).toBe('533K');
  expect(compactTokens(1_200_000, 'en')).toBe('1M');
  expect(compactTokens(6_992, 'en')).toBe('7K');
});

it('uses the translated thousands unit in German', async () => {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  try {
    expect(compactTokens(533_333, 'de')).toBe('533 Tsd.');
    expect(compactTokens(6_992, 'de')).toBe('6992');
  } finally { setLanguage('en'); }
});

it.each([['en', '150,000 tokens'], ['de', '150.000 Tokens']] as const)(
  'writes the auto-compaction threshold in the interface language (%s), not the system locale',
  async (language, threshold) => {
    dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
    vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('Node', dom.window.Node);
    const { setLanguage } = await import('../src/renderer/i18n.js');
    setLanguage(language);
    try {
      const session = { conversationId: 'chat', contextTokens: 100000,
        selectedModel: { conversationId: 'chat', model: 'gpt-5.6-sol-high', reasoningEffort: 'high' } } as SessionSummary;
      paintContextMeter(session, { sessions: { limitTokens: 533333 }, compaction: { auto: true, autoTokens: 150000 } } as Config);
      // Every number in one sentence uses the same grouping: 2.1.21 printed "533,333" beside "400.000".
      expect(dom.window.document.getElementById('contextMeterButton')?.getAttribute('aria-label')).toContain(threshold);
    } finally { setLanguage('en'); }
  });
