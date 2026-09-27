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
it.each([118, 257])('accepts %s declarations for the Plugins connector including its optional code-mode tool', async (count) => {
  const { api, props } = page();
  props.connector.name = 'Chat On Steroids Plugins';
  props.actions = Array.from({ length: count }, (_, i) => ({ name: i === 256 ? 'exec' : `plugin_tool_${i}`, description: `Plugin tool ${i}`, description_model: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
  const view = await api.pluginRefreshView('Chat On Steroids Plugins');
  expect(view?.tools).toHaveLength(count);
});
it.each([['Chat On Steroids Plugins', 258], ['Chat On Steroids Core', 17]] as const)('retains the %s observation count guard', async (connector, count) => {
  const { api, props } = page();
  props.connector.name = connector;
  props.actions = Array.from({ length: count }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}`, description_model: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
  expect(await api.pluginRefreshView(connector)).toBeNull();
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

// The newer shell: a full page at /settings/plugins-settings/plugin_<app>, the connector (with
// its `actions`) a few Fibers above each management button, and only Refresh's wrapper loading.
function settingsPage(path = '/settings/plugins-settings/plugin_asdk_app_synthetic') {
  dom = new JSDOM('<main><h1>Chat On Steroids Core</h1><button id="edit">Bearbeiten</button><button id="refresh">Tools aktualisieren</button><button id="delete">App löschen</button></main>', { runScripts: 'outside-only', url: `https://chatgpt.com${path}` });
  const win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const connector = { id: 'asdk_app_synthetic', name: 'Chat On Steroids Core', tunnel_id: 'tunnel_synthetic01' as unknown, app_metadata: { version_id: 'asdk_app_v_synthetic' }, owners: ['never-copy'],
    actions: [{ name: tool.name, description: tool.description, description_model: '' as string | null, params: tool.inputSchema }] };
  const owner = { memoizedProps: { connector, link: {}, plugin: {} } };
  const chain = (wrapper: object) => ({ memoizedProps: { children: 'x' }, return: { memoizedProps: wrapper, return: { memoizedProps: { className: 'row' }, return: owner } } });
  const set = (id: string, wrapper: object) => { (win.document.getElementById(id) as any).__reactFiber$fixture = chain(wrapper); };
  set('edit', { color: 'secondary', onClick() {} });
  set('refresh', { color: 'secondary', loading: false, onClick() {} });
  set('delete', { color: 'danger', disabled: false, onClick() {} });
  win.eval(fiber); win.eval(source);
  return { api: (win as any).CLF_DOM, connector, set };
}
it.each(['/settings/plugins-settings/plugin_asdk_app_synthetic', '/plugins/plugin_asdk_app_synthetic'])('reads the plugin page at %s and only its Refresh tools control', async (path) => {
  const { api } = settingsPage(path);
  const view = await api.pluginRefreshView('Chat On Steroids Core', [tool]);
  expect(view).toMatchObject({ appId: 'asdk_app_synthetic', versionId: 'asdk_app_v_synthetic', tools: [tool] });
  expect(view.refresh.id).toBe('refresh');
  expect(dom.window.document.querySelectorAll('[data-clf-plugin-refresh]')).toHaveLength(1);
});
it('never offers a destructive control as the page refresh, and refuses an ambiguous one', async () => {
  const { api, set } = settingsPage();
  set('refresh', { color: 'secondary', onClick() {} }); set('delete', { color: 'danger', loading: false, onClick() {} });
  set('edit', { color: 'ghost', loading: false, 'aria-haspopup': 'menu' });
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool]))?.refresh).toBeNull();
  expect(dom.window.document.querySelector('[data-clf-plugin-refresh]')).toBeNull();
  set('refresh', { loading: false }); set('edit', { loading: false });
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toBeNull();
});
it('refuses the plugin page when the route and connector disagree', async () => {
  const { api, connector } = settingsPage();
  connector.id = 'asdk_app_other';
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toBeNull();
  dom.window.close(); settingsPage('/settings/plugins-settings/plugin_asdk_app_synthetic');
  dom.window.history.replaceState(null, '', '/settings/plugins-settings/plugin_asdk_app_synthetic#settings/Plugins');
  expect(await (dom.window as any).CLF_DOM.pluginRefreshView('Chat On Steroids Core', [tool])).toBeNull();
});
it('finds installed rows on the plugins settings page', () => {
  settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = '<button><div><span>Chat On Steroids Core</span></div><span>Custom</span></button><button><span>Chat On Steroids Desktop</span></button>';
  const api = (dom.window as any).CLF_DOM;
  expect(api.pluginInstalledButtons('Chat On Steroids Core')).toHaveLength(1);
  expect(api.pluginInstalledButtons('Chat On Steroids')).toBeNull();
});
it('reads the page description when the model description is empty, and prefers a set one', async () => {
  const { api, connector } = settingsPage();
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool])).tools[0].description).toBe(tool.description);
  connector.actions[0]!.description_model = 'Model-facing declaration.';
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool])).tools[0].description).toBe('Model-facing declaration.');
});
it('reports the page connector tunnel and a settled empty Plugins list', async () => {
  const { api, connector } = settingsPage();
  expect(await api.pluginRefreshView('Chat On Steroids Core', [tool])).toMatchObject({ tunnelId: 'tunnel_synthetic01', settled: true });
  connector.tunnel_id = { toString: () => 'tunnel_x' };
  expect((await api.pluginRefreshView('Chat On Steroids Core', [tool])).tunnelId).toBeNull();
  connector.name = 'Chat On Steroids Plugins'; connector.actions = [];
  expect(await api.pluginRefreshView('Chat On Steroids Plugins')).toMatchObject({ tools: [], settled: true });
});
