import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
let page: JSDOM;
afterEach(() => { page?.window.close(); });
it('reveals the native New Chat control through the compact sidebar before reuse', async () => {
  page = new JSDOM('<button data-testid="open-sidebar-button" aria-expanded="false" aria-controls="stage-popover-sidebar">Menu</button>', { url: 'https://chatgpt.com/c/existing', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.eval(domSource);
  const button = page.window.document.querySelector('button')!;
  const click = vi.fn(() => {
    button.setAttribute('aria-expanded', 'true');
    const sidebar = page.window.document.createElement('aside'); sidebar.id = 'stage-popover-sidebar';
    sidebar.innerHTML = '<a data-testid="create-new-chat-button" data-sidebar-item="true" href="/">New Chat</a>';
    page.window.document.body.append(sidebar);
  });
  button.addEventListener('click', click);
  const api = (page.window as any).CLF_DOM;
  expect(await api.newChatControl(() => false)).toBeNull(); expect(click).not.toHaveBeenCalled();
  const control = await api.newChatControl();
  expect(control?.getAttribute('data-testid')).toBe('create-new-chat-button');
  expect(click).toHaveBeenCalledTimes(1);
});
it('switches the observed Work surface to Chat once without relying on translated labels', async () => {
  page = new JSDOM('<button role="radio" data-tpp-toggle-value="chatgpt" aria-checked="false">Unterhaltung</button><button role="radio" data-tpp-toggle-value="work" aria-checked="true">Arbeit</button>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.eval(domSource);
  const chat = page.window.document.querySelector('[data-tpp-toggle-value="chatgpt"]')!;
  const click = vi.fn(() => {
    chat.setAttribute('aria-checked', 'true');
    page.window.document.querySelector('[data-tpp-toggle-value="work"]')!.setAttribute('aria-checked', 'false');
  });
  chat.addEventListener('click', click);
  const api = (page.window as any).CLF_DOM;
  expect(await api.prepareChatModelSurface(() => false)).toBe(false); expect(click).not.toHaveBeenCalled();
  expect(await api.prepareChatModelSurface()).toBe(true); expect(click).toHaveBeenCalledTimes(1);
  expect(await api.prepareChatModelSurface()).toBe(true); expect(click).toHaveBeenCalledTimes(1);
});
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
  (trigger as any).__reactFiber$test = { memoizedProps: props, return: null };
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
  return { api: (win as any).CLF_DOM, state, props, selections, actions, freeze: () => { frozen = true; } };
}
it('reads localized nested models and future efforts from account state, excludes locked choices, and restores selection', async () => {
  const f = fixture();
  expect(await f.api.inspectModelSettings()).toEqual([
    { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] },
    { id: 'future-model', label: 'Neues Modell', efforts: ['low', 'ultra'], aliases: ['future-model'] }
  ]);
  expect(f.state.selectedVersionEntry.id).toBe('latest'); expect(f.state.currentBucket).toBe(2);
  // Only restore the original High once; discovery never sweeps every power level.
  expect(f.actions.mock.calls.filter(([action]) => action === 'effort')).toHaveLength(1);
});
it('rejects a mounted composer hidden by Settings while recognizing the visible High picker', async () => {
  const f = fixture(), doc = page.window.document;
  doc.querySelector('button')!.textContent = 'High';
  expect(f.api.composerVisible()).toBe(true);
  const editor = doc.querySelector('#prompt-textarea')!;
  editor.setAttribute('aria-hidden', 'true');
  expect(f.api.composerVisible()).toBe(false);
  editor.removeAttribute('aria-hidden');
  doc.querySelector('form')!.setAttribute('inert', '');
  expect(f.api.composerVisible()).toBe(false);
  doc.querySelector('form')!.removeAttribute('inert');
  expect(f.api.composerVisible()).toBe(true);
  expect(await f.api.inspectModelSettings()).toHaveLength(2);
  expect(f.state.currentBucket).toBe(2);
});
it('confirms the exact model and effort and refuses visible upgrade-only entries', async () => {
  const f = fixture();
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(true);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
  expect(await f.api.selectModelSettings('gpt-6-pro', 'pro')).toBe(false);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
});
it('groups provider family lanes and selects Pro through the same family instead of a separate execution slug', async () => {
  const f = fixture();
  const version = f.props.modelsData.versions[0]!;
  version.id = '5.6'; version.displayTextForIntelligence = 'GPT-5.6 Sol';
  for (const selection of f.selections[0]!) (selection.category as any).modelVersion = '5.6';
  const pro = f.selections[0]![2]!;
  pro.modelSlug = 'gpt-5-6-pro'; pro.availability.status = 'available'; pro.category.shortLabel = '5.6 Pro';
  expect(await f.api.inspectModelSettings()).toContainEqual({ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['medium', 'high', 'pro'], aliases: ['gpt-5-6-thinking', 'gpt-5-6-pro'] });
  expect(await f.api.selectModelSettings('5.6', 'pro')).toBe(true);
  expect(f.state.currentSelection.modelSlug).toBe('gpt-5-6-pro');
  // Existing stored family display slugs retain their requested Pro effort too.
  expect(await f.api.selectModelSettings('gpt-5.6-sol', 'pro')).toBe(true);
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
it('observes direct Chrome selection with the picker closed and invalidates another route', async () => {
  const f = fixture();
  page.window.document.querySelector('[data-testid="composer-trailing-actions"]')!.removeAttribute('data-testid');
  const plus = page.window.document.createElement('button');
  plus.id = 'composer-plus-btn'; plus.setAttribute('aria-haspopup', 'menu');
  page.window.document.querySelector('form')!.append(plus);
  const trigger = page.window.document.querySelector('button')!;
  trigger.textContent = 'Extra High';
  (trigger as any).__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: { currentModelId: 'gpt-5-6-thinking' }, return: null } };
  const scan = () => new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => { if (event.data?.source === 'clf-fiber-reply') { page.window.removeEventListener('message', receive as any); resolve(); } };
    page.window.addEventListener('message', receive as any);
    page.window.postMessage({ source: 'clf-fiber-ask', nonce: 'passive-test' }, page.window.location.origin);
  });
  await scan();
  expect(page.window.document.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
  expect(f.actions).not.toHaveBeenCalled();
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh' });
  const owner = (trigger as any).__reactFiber$test.return;
  owner.return = { memoizedProps: { currentModelId: 'different-model' }, return: null };
  await scan();
  expect(f.api.visibleModelSelection()).toBeNull();
  owner.return = null;
  await scan();
  page.window.history.pushState({}, '', '/c/other');
  expect(f.api.visibleModelSelection()).toBeNull();
  trigger.textContent = 'Unrecognized effort';
  await scan();
  page.window.history.pushState({}, '', '/');
  expect(f.api.visibleModelSelection()).toBeNull();
});
it('keeps an explicit model denial unavailable even when the preset is visible', async () => {
  const f = fixture(); (f.props.modelSwitcherDenialsBySlug as any)['future-model'] = { reason: 'workspace_policy' };
  expect(await f.api.inspectModelSettings()).toEqual([{ id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] }]);
});
it('reads the September closed 6 Pro dropdown without opening or changing a working composer', async () => {
  const f = fixture(), doc = page.window.document, trigger = doc.querySelector('button')!;
  const pro = f.selections[0]![2]!;
  pro.availability.status = 'available';
  f.state.currentBucket = pro.bucket; f.state.currentSelection = pro;
  trigger.innerHTML = '<span>6</span><span>Pro</span>';
  (trigger as any).__reactFiber$test = { memoizedProps: { dropdownContent: { props: f.props } }, return: null };
  doc.querySelector('#prompt-textarea')!.textContent = 'Unsent user draft';
  doc.querySelector('[data-testid="send-button"]')!.setAttribute('data-testid', 'stop-button');
  expect(await f.api.inspectVisibleModelSettings()).toContainEqual({ id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'], aliases: ['gpt-6-pro'] });
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-6-pro', reasoningEffort: 'pro' });
  expect(doc.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
  expect(f.actions).not.toHaveBeenCalled();
  expect(doc.querySelector('#prompt-textarea')!.textContent).toBe('Unsent user draft');
  (f.props.modelSwitcherDenialsBySlug as any)['gpt-6-pro'] = { reason: 'workspace_policy' };
  expect(await f.api.inspectVisibleModelSettings()).not.toContainEqual(expect.objectContaining({ id: 'gpt-6-pro' }));
  expect(f.api.visibleModelSelection()).toBeNull();
});
it('recognizes the provider min effort as Low without invalidating the account catalog', async () => {
  const f = fixture(); f.selections[0]![0]!.thinkingEffort = 'min';
  expect(await f.api.inspectModelSettings()).toContainEqual({ id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['low', 'high'], aliases: ['gpt-5-6-thinking'] });
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
