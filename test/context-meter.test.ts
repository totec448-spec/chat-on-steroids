import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { initContextMeter, paintContextMeter } from '../src/renderer/context-meter.js';
import type { Config } from '../src/shared/types.js';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });
function setup(model: string) {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('Node', dom.window.Node);
  const session = { conversationId: 'chat', contextTokens: 100000,
    selectedModel: { conversationId: 'chat', model, reasoningEffort: 'pro' } } as SessionSummary;
  const config = { sessions: { limitTokens: 200000 }, compaction: { auto: true, autoTokens: 150000 } } as Config;
  paintContextMeter(session, config);
  return dom.window.document;
}
it('keeps Pro static and identifies token estimates and compaction exclusion', () => {
  const doc = setup('gpt-6-pro');
  expect(doc.getElementById('contextMeterArc')?.getAttribute('stroke-dasharray')).toBe('0 37.7');
  expect(doc.getElementById('contextMeterInfo')?.textContent).toContain('Auto-compaction off for Pro');
  expect(doc.getElementById('contextMeterInfo')?.textContent).toContain('estimated');
});
it('uses configured limits for ordinary models and supports click and Escape', () => {
  const doc = setup('gpt-5.6-sol-high');
  expect(doc.getElementById('contextMeterInfo')?.textContent).toContain('50% of configured limit');
  initContextMeter();
  const button = doc.getElementById('contextMeterButton')!;
  button.click();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  button.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape' }));
  expect(button.getAttribute('aria-expanded')).toBe('false');
});
