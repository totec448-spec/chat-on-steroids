import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
let page: JSDOM;
afterEach(() => { page?.window.close(); });
function fixture() {
  page = new JSDOM('<form><div id="prompt-textarea" contenteditable="true"></div><div data-testid="composer-trailing-actions"><button type="button" aria-haspopup="menu">Denkaufwand</button><button data-testid="send-button">Senden</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const choice = (bucket: number, modelSlug: string, thinkingEffort: string, available = true) => ({ bucket, modelSlug, thinkingEffort,
    availability: { status: available ? 'available' : 'upgrade_required' },
    category: { modelLane: modelSlug.endsWith('pro') ? 'pro' : 'thinking', shortLabel: modelSlug.startsWith('future') ? 'Neues Modell' : modelSlug.endsWith('pro') ? '6 Pro' : '5.6 Sol' } });
  const versions = [{ id: 'latest', displayTextForIntelligence: 'Aktuell', enabled: true }, { id: 'future', displayTextForIntelligence: 'Neues Modell', enabled: true }];
  const selections = [[choice(1, 'gpt-5-6-thinking', 'standard'), choice(2, 'gpt-5-6-thinking', 'extended'), choice(3, 'gpt-6-pro', 'standard', false)],
    [choice(10, 'future-model', 'low'), choice(11, 'future-model', 'ultra')]];
  const state = { bucketSelections: selections[0]!, currentBucket: 2, selectedVersionEntry: versions[0]!, currentSelection: selections[0]![1]! };
  const props = { modelsData: { versions }, composerIntelligencePickerState: state, modelSwitcherDenialsBySlug: {}, conversation: { privateSecret: 'must-never-cross' } };
  const trigger = doc.querySelector('button')!;
  const actions = vi.fn();
  let frozen = false;
  const render = () => {
    let panel = doc.querySelector('[data-testid="composer-intelligence-picker-content"]') as HTMLElement;
    if (!panel) { panel = doc.createElement('div'); panel.dataset.testid = 'composer-intelligence-picker-content'; doc.body.append(panel); }
    (panel as any).__reactFiber$test = { memoizedProps: props, return: null };
    panel.innerHTML = '<div role="menuitem" aria-expanded="false">Modell auswählen</div><div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight" aria-label="Leistung"></div>';
    panel.querySelector('[aria-expanded]')!.addEventListener('click', () => {
      panel.innerHTML = '';
      for (const version of versions) {
        const row = doc.createElement('div'); row.setAttribute('role', 'menuitemradio'); row.textContent = version.displayTextForIntelligence;
        row.addEventListener('keydown', event => { if (event.key !== 'Enter') return; actions('version'); if (frozen) return;
          state.selectedVersionEntry = version; state.bucketSelections = selections[versions.indexOf(version)]!;
          state.currentBucket = state.bucketSelections[0]!.bucket; state.currentSelection = state.bucketSelections[0]!; render(); }); panel.append(row);
      }
    });
    panel.querySelector('[aria-keyshortcuts]')!.addEventListener('keydown', (event: any) => {
      actions('effort'); if (frozen) return;
      const at = state.bucketSelections.findIndex(c => c.bucket === state.currentBucket) + (event.key === 'ArrowRight' ? 1 : -1);
      if (!state.bucketSelections[at]) return;
      state.currentBucket = state.bucketSelections[at]!.bucket; state.currentSelection = state.bucketSelections[at]!; render();
    });
  };
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Enter') render();
    if (event.key === 'Escape') doc.querySelector('[data-testid="composer-intelligence-picker-content"]')?.remove();
  });
  win.eval(fiberSource); win.eval(domSource);
  return { api: (win as any).CLF_DOM, state, props, actions, freeze: () => { frozen = true; } };
}
it('reads localized nested models and future efforts from account state, excludes locked choices, and restores selection', async () => {
  const f = fixture();
  expect(await f.api.inspectModelSettings()).toEqual([
    { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'] },
    { id: 'future-model', label: 'Neues Modell', efforts: ['low', 'ultra'] }
  ]);
  expect(f.state.selectedVersionEntry.id).toBe('latest'); expect(f.state.currentBucket).toBe(2);
  // Only restore the original High once; discovery never sweeps every power level.
  expect(f.actions.mock.calls.filter(([action]) => action === 'effort')).toHaveLength(1);
});
it('confirms the exact model and effort and refuses visible upgrade-only entries', async () => {
  const f = fixture();
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(true);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
  expect(await f.api.selectModelSettings('gpt-6-pro', 'pro')).toBe(false);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
});
it('reads an already-open version submenu and restores its original exact power', async () => {
  const f = fixture();
  page.window.document.querySelector('button')!.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  (page.window.document.querySelector('[aria-expanded]') as HTMLElement).click();
  expect(page.window.document.querySelectorAll('[role=menuitemradio]')).toHaveLength(2);
  expect(await f.api.inspectModelSettings()).toHaveLength(2);
  expect(f.state.selectedVersionEntry.id).toBe('latest');
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'extended' });
});
it('invalidates mounted selection proof when provider state becomes unrecognized', async () => {
  const f = fixture();
  page.window.document.querySelector('button')!.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const read = async () => {
    await new Promise<void>(resolve => {
      const receive = (event: MessageEvent) => { if (event.data?.source === 'clf-picker-reply') { page.window.removeEventListener('message', receive as any); resolve(); } };
      page.window.addEventListener('message', receive as any);
      page.window.postMessage({ source: 'clf-picker-ask', nonce: 'fixture' }, page.window.location.origin);
    });
    return f.api.visibleModelSelection();
  };
  expect(await read()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' });
  f.state.currentSelection.thinkingEffort = 'unknown-provider-value';
  expect(await read()).toBeNull();
});
it('keeps an explicit model denial unavailable even when the preset is visible', async () => {
  const f = fixture(); (f.props.modelSwitcherDenialsBySlug as any)['future-model'] = { reason: 'workspace_policy' };
  expect(await f.api.inspectModelSettings()).toEqual([{ id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'] }]);
});
it('does not mutate the picker after navigation ownership is lost', async () => {
  const f = fixture(); expect(await f.api.selectModelSettings('future-model', 'ultra', () => false)).toBe(false);
  expect(f.actions).not.toHaveBeenCalled();
});
it('projects an allowlist rather than leaking conversation props through the bridge', async () => {
  const f = fixture(); const replies: unknown[] = [];
  page.window.addEventListener('message', event => { if (event.data?.source === 'clf-picker-reply') replies.push(event.data); });
  await f.api.inspectModelSettings();
  expect(replies.length).toBeGreaterThan(0);
  expect(JSON.stringify(replies)).not.toMatch(/privateSecret|must-never-cross|conversation|modelsData/);
});
