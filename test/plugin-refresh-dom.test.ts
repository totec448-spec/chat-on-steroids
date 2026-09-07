import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';
const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiber = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
let dom: JSDOM;
afterEach(() => dom?.window.close());
const tool = { name: 'read', description: 'Read an exact file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
function page() {
  dom = new JSDOM('<section role="tabpanel" aria-labelledby="settings-trigger-Plugins"><h2>Chat On Steroids Core</h2><button id="schema">Schema kopieren</button><footer><button id="refresh">Aktualisieren</button></footer></section>', { runScripts: 'outside-only', url: 'https://chatgpt.com/#settings/Plugins/plugin_asdk_app_synthetic' });
  const win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const props = { connector: { id: 'asdk_app_synthetic', name: 'Chat On Steroids Core', app_metadata: { version_id: 'asdk_app_v_synthetic' }, owners: ['never-copy'] },
    actions: [{ name: tool.name, description: tool.description, description_model: null, params: tool.inputSchema }], isLoadingActions: false };
  (win.document.getElementById('schema') as any).__reactFiber$fixture = { memoizedProps: props };
  (win.document.getElementById('refresh') as any).__reactFiber$fixture = { memoizedProps: { details: [{ title: 'App-Kennung', value: props.connector.id }], reportEntity: { id: props.connector.id, entityType: 'connector' }, headerTrailingContent: {} } };
  win.eval(fiber); win.eval(source);
  return { api: (win as any).CLF_DOM, props };
}
it('reads localized installed declarations and the unique native refresh action from provider state', async () => {
  const { api } = page(); const view = await api.pluginRefreshView('Chat On Steroids Core', [tool]);
  expect(view).toMatchObject({ appId: 'asdk_app_synthetic', versionId: 'asdk_app_v_synthetic', tools: [tool] });
  expect(view.refresh.textContent).toBe('Aktualisieren'); expect(view).not.toHaveProperty('success');
});
it('does not substitute expected declarations for changed provider descriptions', async () => {
  const { api, props } = page(); props.actions[0]!.description = 'Changed declaration.';
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool])).tools[0].description).toBe('Changed declaration.');
  props.actions.push(props.actions[0]!);
  expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
});
it('uses an enrolled App ID through renames, but refuses mismatched IDs and loading schemas', async () => {
  const { api, props } = page(); props.connector.name = 'Renamed';
  expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
  expect(await api.pluginRefreshView('Chat On Steroids Core', [], 'asdk_app_synthetic')).not.toBeNull();
  expect(await api.pluginRefreshView('Chat On Steroids Core', [], 'asdk_app_other')).toBeNull();
  props.isLoadingActions = true;
  expect(await api.pluginRefreshView('Renamed')).toBeNull();
});
it('rejects oversized or cyclic schemas before projecting them to the isolated world', async () => {
  const { api, props } = page();
  const schema = { type: 'object', description: 'x'.repeat(300000) };
  props.actions[0]!.params = schema as any;
  expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
  props.actions[0]!.params = { type: 'object', properties: {} } as any;
  (props.actions[0]!.params as any).properties.self = props.actions[0]!.params;
  expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
});
it('refuses ambiguous native actions and never copies unrelated connector properties', async () => {
  const { api } = page(); const messages: unknown[] = [];
  dom.window.addEventListener('message', event => { if (event.data?.source === 'clf-plugin-reply') messages.push(event.data); });
  await api.pluginRefreshView('Chat On Steroids Core'); expect(JSON.stringify(messages)).not.toContain('never-copy');
  const button = dom.window.document.getElementById('refresh')!;
  const copy = button.cloneNode(true) as any; copy.__reactFiber$fixture = (button as any).__reactFiber$fixture; button.after(copy);
  expect(await api.pluginRefreshView('Chat On Steroids Core')).toBeNull();
});
it('discovers exact installed rows across languages and preserves ambiguity', () => {
  const { api } = page(); const panel = dom.window.document.querySelector('section')!;
  panel.innerHTML = '<a href="/plugins">Plugins durchsuchen</a>';
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toBeNull();
  panel.insertAdjacentHTML('beforeend', '<button><span data-testid="plugin-icon-wrapper"></span><div>Chat On Steroids Core</div><span>Alle zulassen</span></button>');
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toHaveLength(1);
  expect(api.pluginInstalledButtons('Chat On Steroids Desktop')).toEqual([]);
  panel.insertAdjacentHTML('beforeend', panel.querySelector('button')!.outerHTML);
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toHaveLength(2);
});

it('observes an exact installed card without a refresh action through the real Fiber bridge', async () => {
  const { api } = page();
  const refresh = dom.window.document.getElementById('refresh') as any;
  const card = { ...refresh.__reactFiber$fixture.memoizedProps, headerTrailingContent: null };
  (dom.window.document.getElementById('schema') as any).__reactFiber$fixture.return = { memoizedProps: card };
  refresh.remove();
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toMatchObject({ appId: 'asdk_app_synthetic', tools: [tool], refresh: null });
  delete (dom.window.document.getElementById('schema') as any).__reactFiber$fixture.return;
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toBeNull();
});
