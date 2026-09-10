import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import type { PluginSnapshot } from '../src/shared/plugins.js';
import type { AppState } from '../src/shared/types.js';
import { createRendererRoot, flushReact, installRendererDom, ok, setNativeValue } from './renderer-react-helpers.js';

let dom: ReturnType<typeof installRendererDom>['dom'] | null = null;
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; dom?.window.close(); dom = null; vi.restoreAllMocks(); vi.resetModules(); });

function appState(): AppState {
  const config = defaultConfig('win32');
  return { config, status: { state: 'connected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [{ id: 'plugins', state: 'live', connectorName: 'Chat On Steroids Plugins', description: 'Plugins', cardSummary: 'External tools', optional: true, available: true, localUrl: 'http://localhost/mcp', publicUrl: null, lastRequestAt: null, lastToolCallAt: null, tools: [], detail: '' }] }, platform: { family: 'windows', name: 'Windows', desktopAutomation: true }, secureStorage: { available: true, detail: null }, hasApiKey: false, hasGoalKey: false, hasCustomProviderKey: false, resolvedBinary: null, bundledTunnelVersion: null, bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: 1, extensionVersion: '2.0.8' }, update: { current: '2.0.8', latest: null, stage: 'idle', error: null, checkedAt: 1 } };
}

function snapshot(): PluginSnapshot {
  return { schemaRevision: 1, catalog: [{ id: 'memory', icon: 'memory', color: '#aaa', name: 'Memory', description: 'Knowledge graph', source: { kind: 'npm', package: 'memory' }, homepage: 'https://example.org', license: 'MIT', instructions: ['Install Node.js.'], fields: [{ key: 'TOKEN', label: 'API token', secret: true, required: true }] }], plugins: [{ id: 'one', catalogId: 'memory', name: '<img src=x onerror=alert(1)>', source: { kind: 'npm', package: 'memory' }, config: {}, credentialKeys: ['TOKEN'], version: '1', license: 'MIT', enabled: true, status: 'ready', installedAt: 1, tools: [] }] };
}

function apiFor(state: PluginSnapshot) {
  const listener = { current: null as null | ((next: PluginSnapshot) => void) };
  const api: Record<string, any> = {};
  for (const name of ['pluginsInstall', 'pluginsConfigure', 'pluginsRestart', 'pluginsUpdate', 'pluginsUninstall', 'pluginsSetEnabled', 'pluginsSetToolEnabled', 'pluginsAuthenticate', 'pluginsCancelAuthentication']) api[name] = vi.fn(() => ok(state));
  Object.assign(api, {
    pluginsSnapshot: vi.fn(() => ok(state)),
    onPluginsChanged: vi.fn((next: (value: PluginSnapshot) => void) => { listener.current = next; return () => undefined; }),
    openLink: vi.fn(() => ok(true)), openLegalNotices: vi.fn(() => ok(undefined)),
    saveSettings: vi.fn((_patch: any, _base: any) => ok(appState())), connect: vi.fn(() => ok(appState())),
  });
  return { api, listener };
}

it('renders plugin/server text safely and routes exact tool identity through the React switch', async () => {
  const state = snapshot();
  state.plugins[0]!.tools = [{ name: 'remember', exposedName: 'plugin_one_remember', enabled: true }];
  const mocked = apiFor(state); const installed = installRendererDom(mocked.api); dom = installed.dom;
  const { PluginsPage } = await import('../src/renderer/components/pages/plugins-page.js');
  root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(PluginsPage, { appState: appState() })); await flushReact(); });
  expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(document.querySelector('#pluginsInstalled img[src="x"]')).toBeNull();
  expect(document.body.textContent).toContain('Ready');

  const entry = document.querySelector<HTMLButtonElement>('#pluginsInstalled button')!;
  await act(async () => { entry.click(); await flushReact(); });
  const toolSwitch = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => { toolSwitch.click(); await flushReact(); });
  expect(mocked.api.pluginsSetToolEnabled).toHaveBeenCalledWith('one', 'remember', false);
});

it('keeps a secret draft stable across plugin status pushes and sends it only on explicit save', async () => {
  const state = snapshot(); const mocked = apiFor(state); const installed = installRendererDom(mocked.api); dom = installed.dom;
  const { PluginsPage } = await import('../src/renderer/components/pages/plugins-page.js');
  root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(PluginsPage, { appState: appState() })); await flushReact(); });
  await act(async () => { document.querySelector<HTMLButtonElement>('#pluginsInstalled button')!.click(); await flushReact(); });
  const configure = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Configure')!;
  await act(async () => { configure.click(); await flushReact(); });
  const password = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => { setNativeValue(password, 'never-show-this'); await flushReact(); });
  const pushed = structuredClone(state); pushed.plugins[0]!.status = 'connecting';
  await act(async () => { mocked.listener.current?.(pushed); await flushReact(); });
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('never-show-this');
  const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save & reconnect')!;
  await act(async () => { save.click(); await flushReact(); });
  expect(mocked.api.pluginsConfigure).toHaveBeenCalledWith('one', expect.objectContaining({ credentials: { TOKEN: 'never-show-this' } }));
  expect(document.body.textContent).not.toContain('never-show-this');
});

it('restores plugin connector setup without bypassing the shared settings merge authority', async () => {
  const state = snapshot(); const app = appState(); app.config.tunnel.pluginsTunnelId = 'plugins-old';
  const mocked = apiFor(state); const installed = installRendererDom(mocked.api); dom = installed.dom;
  const { PluginsPage } = await import('../src/renderer/components/pages/plugins-page.js');
  root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(PluginsPage, { appState: app })); await flushReact(); });
  const setup = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Plugin setup')!;
  await act(async () => { setup.click(); await flushReact(); });
  const tunnel = document.querySelector<HTMLInputElement>('#pluginsTunnelId')!;
  await act(async () => { setNativeValue(tunnel, 'plugins-new'); await flushReact(); });
  const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save & connect')!;
  await act(async () => { save.click(); await flushReact(); });
  expect(mocked.api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ tunnel: expect.objectContaining({ pluginsTunnelId: 'plugins-new' }) }), expect.objectContaining({ tunnel: expect.objectContaining({ pluginsTunnelId: 'plugins-old' }) }));
  expect(mocked.api.connect).toHaveBeenCalledTimes(1);
});
