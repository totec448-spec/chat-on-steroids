import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/main/config.js';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
const state = () => ({ config: defaultConfig(),
  update: { current: '2.1.34', latest: null, stage: 'idle', checkedAt: 1, error: null },
  bridge: { running: true, paired: true, present: true, extensionVersion: '2.1.34' },
  status: { state: 'connected', detail: '', surfaces: [{ id: 'core', connectorName: 'Core',
    optional: false, available: true, state: 'live', detail: '', tools: ['read'], lastRequestAt: 1, lastToolCallAt: 1 }] },
  connectorSchemas: { core: 'a' }, connectorRefresh: { core: { schemaId: 'a', state: 'current' } }
} as any);

it('keeps an app-check failure visible while showing independently pending connector checks', async () => {
  const { updateReadiness } = await import('../src/renderer/update-readiness-state.js');
  const { paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  const next = state(); next.update.stage = 'failed'; next.update.error = 'Network unavailable';
  next.connectorRefresh.core.state = 'pending';
  expect(updateReadiness(next).find(row => row.id === 'app')!.status).toBe('fail');
  expect(updateReadiness(next).find(row => row.id === 'core')!.detail).toBe('Refresh needed in ChatGPT');
  paintUpdateReadiness(next);
  expect(document.getElementById('updateReadinessSummary')!.dataset.ready).toBe('false');
});

it('expands operational but schema-unverified evidence and opens the completed card from its status line', async () => {
  const { initUpdateReadiness, paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  initUpdateReadiness(); const next = state();
  const details = document.getElementById('updateReadinessDetails') as HTMLDetailsElement;
  next.connectorRefresh.core = { schemaId: 'a', state: 'unknown', responding: true };
  paintUpdateReadiness(next);
  expect(document.getElementById('updateReadinessSummary')!.textContent).toContain('not fully verified');
  expect(details.open).toBe(true);
  next.connectorRefresh.core.state = 'current'; paintUpdateReadiness(next);
  expect(details.open).toBe(false);
  expect(document.querySelector('.update-readiness')!.classList.contains('is-compact')).toBe(true);
  document.getElementById('updateReadinessSummary')!.click();
  expect(details.open).toBe(true);
  expect(document.getElementById('updateReadinessToggle')!.getAttribute('aria-expanded')).toBe('true');
  paintUpdateReadiness(structuredClone(next));
  expect(details.open).toBe(true);
});

it('announces readiness outside the disclosure button and keeps its label, focus and translation', async () => {
  const { initUpdateReadiness, paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  initUpdateReadiness(); const next = state();
  const toggle = document.getElementById('updateReadinessToggle')!;
  const summary = document.getElementById('updateReadinessSummary')!;
  const live = document.querySelector('#updateReadinessCard [role="status"]')!;
  // Button descendants are presentational in accessibility APIs; the live region must stand alone.
  expect(live.closest('button, [role="button"], summary, details')).toBeNull();
  expect(live.getAttribute('aria-live')).toBe('polite');
  expect(live.getAttribute('aria-atomic')).toBe('true');
  toggle.focus(); paintUpdateReadiness(next);
  expect(live.textContent).toBe('All checks passed');
  expect(summary.textContent).toBe(live.textContent);
  expect(document.activeElement).toBe(toggle);
  paintUpdateReadiness(next, 'Network unavailable');
  expect(live.textContent).toBe('Checks incomplete');
  expect(summary.textContent).toBe(live.textContent);
  expect(document.activeElement).toBe(toggle);
  setLanguage('ja');
  expect(live.textContent).toBe('確認が完了していません');
  expect(summary.textContent).toBe(live.textContent);
});

it('updates the readiness live region for changed status but not identical state pushes', async () => {
  const { paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  const next = state(); paintUpdateReadiness(next);
  const live = document.querySelector('#updateReadinessCard [role="status"]')!;
  const changes: MutationRecord[] = [];
  const observer = new dom.window.MutationObserver(records => changes.push(...records));
  observer.observe(live, { childList: true, characterData: true, subtree: true });
  paintUpdateReadiness(structuredClone(next));
  await Promise.resolve();
  expect(changes).toHaveLength(0);
  next.connectorRefresh.core = { schemaId: 'a', state: 'unknown', responding: true };
  paintUpdateReadiness(next);
  await Promise.resolve();
  expect(changes).toHaveLength(1);
  expect(live.textContent).toBe('Ready to use; tool definitions not fully verified');
  observer.disconnect();
});

it('keeps a manual choice through timestamps and language changes, but reopens for a new version or schema', async () => {
  const { initUpdateReadiness, paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  initUpdateReadiness(); const next = state(); next.update.latest = '2.1.35';
  const details = document.getElementById('updateReadinessDetails') as HTMLDetailsElement;
  paintUpdateReadiness(next); expect(details.open).toBe(true); details.open = false;
  next.update.checkedAt = 20; next.status.surfaces[0].lastRequestAt = 20;
  next.status.surfaces[0].lastToolCallAt = 20;
  setLanguage('ja'); paintUpdateReadiness(next); expect(details.open).toBe(false);
  next.update.latest = '2.1.36'; paintUpdateReadiness(next); expect(details.open).toBe(true);
  details.open = false; next.connectorSchemas.core = 'b';
  paintUpdateReadiness(next); expect(details.open).toBe(true);
});

it('expands a new operation failure without retrying, then respects a manual collapse until recovery', async () => {
  const { initUpdateReadiness, paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  initUpdateReadiness(); const next = state();
  const details = document.getElementById('updateReadinessDetails') as HTMLDetailsElement;
  paintUpdateReadiness(next); paintUpdateReadiness(next, 'Network unavailable');
  expect(details.open).toBe(true); details.open = false;
  paintUpdateReadiness(structuredClone(next), 'Network unavailable');
  expect(details.open).toBe(false);
  expect(document.getElementById('updateAllError')!.hidden).toBe(false);
  expect(document.getElementById('updateAllNotice')!.hidden).toBe(false);
  paintUpdateReadiness(next); expect(document.getElementById('updateAllError')!.hidden).toBe(true);
});

it('keeps a focused setup action visible when new evidence completes the checks', async () => {
  const { initUpdateReadiness, paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  initUpdateReadiness(); const next = state(); next.connectorRefresh.core.state = 'pending';
  const details = document.getElementById('updateReadinessDetails') as HTMLDetailsElement;
  paintUpdateReadiness(next); document.getElementById('updateReviewSetup')!.focus();
  next.connectorRefresh.core.state = 'current'; paintUpdateReadiness(next);
  expect(details.open).toBe(true); expect(document.activeElement!.id).toBe('updateReviewSetup');
});

it('distinguishes an inspection failure from a failed refresh without hiding it behind a successful tool call', async () => {
  const { updateReadiness } = await import('../src/renderer/update-readiness-state.js');
  const { initUpdateReadiness, paintUpdateReadiness } = await import('../src/renderer/update-readiness.js');
  initUpdateReadiness(); const next = state();
  next.connectorRefresh.core = { schemaId: 'a', state: 'failed', failure: 'inspection', responding: true };
  const row = updateReadiness(next).find(row => row.id === 'core')!;
  expect(row.status).toBe('fail'); expect(row.detail).toBe("Plugin check failed");
  expect(row.nextStep).toContain('settings in ChatGPT'); expect(row.nextStep).toContain('Diagnostics report');
  paintUpdateReadiness(next);
  expect(document.getElementById('updateReadinessSummary')!.textContent).toBe('Checks incomplete');
  expect((document.getElementById('updateReadinessDetails') as HTMLDetailsElement).open).toBe(true);
  next.connectorRefresh.core.failure = 'confirmation';
  expect(updateReadiness(next).find(row => row.id === 'core')!.detail).toBe("Plugin refresh failed");
});
