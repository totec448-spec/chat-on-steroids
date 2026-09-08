import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { initPlugins, refreshPlugins, applyPluginsState } from '../src/renderer/plugins.js';
import type { PluginSnapshot } from '../src/shared/plugins.js';
import type { AppState } from '../src/shared/types.js';

let dom: JSDOM;
let state: PluginSnapshot;
let api: Record<string, ReturnType<typeof vi.fn>>;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'http://localhost' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  state = { schemaRevision: 1, catalog: [{ id: 'memory', icon: 'memory', color: '#aaa', name: 'Memory', description: 'Knowledge graph', source: { kind: 'npm', package: 'memory' }, homepage: 'https://example.org', license: 'MIT', instructions: ['Install Node.js.'], fields: [{ key: 'TOKEN', label: 'API token', secret: true, required: true }] }], plugins: [{ id: 'one', name: '<img src=x onerror=alert(1)>', source: { kind: 'command', command: 'node' }, config: {}, credentialKeys: ['TOKEN'], version: '1', license: 'MIT', enabled: true, status: 'ready', installedAt: 1, tools: [] }] };
  api = Object.fromEntries(['pluginsSnapshot', 'pluginsInstall', 'pluginsConfigure', 'pluginsRestart', 'pluginsUpdate', 'pluginsUninstall', 'pluginsSetEnabled', 'pluginsSetToolEnabled', 'pluginsImportBundle', 'pluginsAuthenticate', 'pluginsCancelAuthentication', 'onPluginsChanged', 'saveSettings', 'setApiKey', 'connect', 'openLink', 'writeClipboard'].map((key) => [key, vi.fn().mockResolvedValue({ ok: true, data: state })]));
  api.pluginsSnapshot!.mockImplementation(async () => ({ ok: true, data: state }));
  Object.assign(dom.window, { api });
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

it('renders server text safely and does not claim Ready before tool discovery', async () => {
  await refreshPlugins();
  expect(document.querySelector('.plugin-card h2')!.textContent).toContain('<img');
  expect(document.querySelector('.plugin-card h2 img')).toBeNull();
  expect(document.querySelector('.plugin-card .pill')!.textContent).toBe('Connected · no tools');
  state.plugins[0]!.tools = [{ name: 'remember', exposedName: 'plugin_one_remember', enabled: true }];
  await refreshPlugins();
  expect(document.querySelector('.plugin-card .pill')!.textContent).toBe('Ready');
});

it('keeps credential edits private and stable while status updates arrive', async () => {
  initPlugins(); await tick();
  [...document.querySelectorAll('button')].find((node) => node.textContent === 'Configure')!.click();
  const password = document.querySelector<HTMLInputElement>('#pluginDialog input[type=password]')!;
  expect(password.value).toBe(''); password.value = 'never-show-this';
  await refreshPlugins();
  expect(document.querySelector('#pluginDialog input[type=password]')).toBe(password);
  expect(password.value).toBe('never-show-this');
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find((node) => node.textContent === 'Save and reconnect')!.click(); await tick();
  expect(api.pluginsConfigure).toHaveBeenCalledWith('one', expect.objectContaining({ credentials: { TOKEN: 'never-show-this' } }));
  expect(document.body.textContent).not.toContain('never-show-this');
});

it('routes exact plugin and tool identity for disabling a discovered tool', async () => {
  state.plugins[0]!.tools = [{ name: 'remember', exposedName: 'plugin_one_remember', enabled: true }];
  await refreshPlugins(); document.querySelector<HTMLButtonElement>('.plugin-entry')!.click();
  const toggle = document.querySelector<HTMLInputElement>('.plugin-tool input')!;
  toggle.checked = false; toggle.dispatchEvent(new dom.window.Event('change')); await tick();
  expect(api.pluginsSetToolEnabled).toHaveBeenCalledWith('one', 'remember', false);
  expect(document.querySelector('.toast')!.textContent).toContain('Refresh the Chat On Steroids Plugins connector in ChatGPT');
});

it('distinguishes a serving connector from evidence of ChatGPT contact', () => {
  applyPluginsState({ config: { tunnel: { kind: 'manual' } }, status: { surfaces: [{ id: 'plugins', state: 'live', connectorName: 'Chat On Steroids Plugins', description: 'Plugins', localUrl: 'http://localhost/mcp', lastRequestAt: null }] } } as unknown as AppState);
  expect(document.getElementById('pluginsConnectionStatus')!.textContent).toBe('Connector online · waiting for ChatGPT');
  expect(document.getElementById('pluginsSetup')).toBeNull();
  expect(document.querySelector('[data-panel="setup"] #pluginsTunnelId')).toBeNull();
  expect(document.querySelector('.plugin-connection')!.classList.contains('is-configured')).toBe(true);
  expect(document.getElementById('pluginsSetupLink')!.textContent).toBe('Plugin setup');
});

it('keeps saved plugin setup compact after restart even while its connector is offline', () => {
  applyPluginsState({ config: { tunnel: { kind: 'openai', pluginsTunnelId: 'saved-plugins' } }, status: { surfaces: [] } } as unknown as AppState);
  expect(document.querySelector('.plugin-connection')!.classList.contains('is-configured')).toBe(true);
  expect(document.getElementById('pluginsConnectionStatus')!.textContent).toBe('Plugins connector offline');
  expect(document.getElementById('pluginsSetupLink')!.textContent).toBe('Plugin setup');
  applyPluginsState({ config: { tunnel: { kind: 'openai', pluginsTunnelId: '' } }, status: { surfaces: [] } } as unknown as AppState);
  expect(document.querySelector('.plugin-connection')!.classList.contains('is-configured')).toBe(false);
});

it('keeps first-use setup and the connector-refresh instruction visible, including after connection', async () => {
  initPlugins(); await tick();
  expect(document.querySelector('.plugin-connection')!.textContent).toContain('before your first use');
  expect(document.querySelector('.plugin-refresh-guide')!.textContent).toContain('After installing, updating or changing enabled plugins');
  applyPluginsState({ config: { tunnel: { kind: 'manual' } }, status: { surfaces: [{ id: 'plugins', state: 'live', lastRequestAt: 1 }] } } as unknown as AppState);
  expect(document.getElementById('pluginsSetupTitle')!.textContent).toBe('Your Plugins connector');
  expect(document.querySelector('.plugin-refresh-guide')!.textContent).toContain('refresh Chat On Steroids Plugins in ChatGPT');
  document.getElementById('pluginsOpenChatGPT')!.click(); await tick();
  expect(api.openLink).toHaveBeenCalledWith('https://chatgpt.com/#settings/Plugins');
});

it('keeps plugin connection setup local, preserves a draft and saves through the existing settings authority', async () => {
  const next = { hasApiKey: true, config: { tunnel: { kind: 'openai', tunnelId: 'core-original', pluginsTunnelId: 'plugins-original' }, ui: { theme: 'dark' } }, status: { surfaces: [{ id: 'plugins', state: 'live', tools: ['get_scene_info'], connectorName: 'Chat On Steroids Plugins', description: 'External tools', lastRequestAt: 1 }] } } as unknown as AppState;
  initPlugins(); applyPluginsState(next); await tick();
  document.getElementById('pluginsSetupLink')!.click();
  expect(document.getElementById('pluginDialogTitle')!.textContent).toBe('Plugin setup');
  const input = document.querySelector<HTMLInputElement>('#pluginDialog #pluginsTunnelId')!;
  input.value = 'plugins-new'; input.focus();
  const updated = structuredClone(next); updated.config.tunnel.tunnelId = 'core-concurrent';
  applyPluginsState(updated);
  expect(document.getElementById('pluginsTunnelId')).toBe(input);
  expect(input.value).toBe('plugins-new');
  api.saveSettings!.mockResolvedValue({ ok: true, data: updated }); api.connect!.mockResolvedValue({ ok: true, data: updated });
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find(node => node.textContent === 'Save & connect')!.click(); await tick();
  expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ tunnel: expect.objectContaining({ tunnelId: 'core-concurrent', pluginsTunnelId: 'plugins-new' }) }), expect.objectContaining({ tunnel: expect.objectContaining({ tunnelId: 'core-concurrent', pluginsTunnelId: 'plugins-original' }) }));
  expect(document.querySelector('[data-panel="setup"] #pluginsTunnelId')).toBeNull();
  expect(document.querySelector('#pluginDialog .plugin-tools')).toBeNull();
});

it('explains starting enabled runtimes and tool publication conflicts', async () => {
  state.plugins[0]!.status = 'connecting';
  state.plugins[0]!.tools = [{ name: 'get_scene_info', exposedName: 'get_scene_info', enabled: true, published: false, exposureError: 'Another installed plugin declares get_scene_info.' }];
  await refreshPlugins();
  expect(document.querySelector('.plugin-card .pill')!.textContent).toBe('Connecting\u2026');
  expect(document.querySelector('.plugin-tool-count')!.textContent).toBe('1 tool enabled');
  document.querySelector<HTMLButtonElement>('.plugin-entry')!.click();
  expect(document.querySelector('.plugin-tool')!.textContent).toContain('Another installed plugin declares get_scene_info.');
});

it('does not show a settings-change notification when only refreshing the plugin list', async () => {
  await refreshPlugins();
  expect(document.querySelector('.toast')).toBeNull();
});

it('removes installed recipes from both catalogs until uninstalled, including disabled and renamed package installs', async () => {
  initPlugins(); await tick();
  document.getElementById('pluginsAdd')!.click();
  const available = () => [document.querySelectorAll('#pluginsExplore .plugin-catalog-card').length, document.querySelectorAll('#pluginDialog .plugin-catalog-card').length];
  expect(available()).toEqual([1, 1]);
  state.plugins[0]!.catalogId = 'memory';
  state.plugins[0]!.enabled = false;
  await refreshPlugins(); expect(available()).toEqual([0, 0]);
  delete state.plugins[0]!.catalogId;
  state.plugins[0]!.source = { kind: 'npm', package: 'memory', version: 'old-version' };
  await refreshPlugins(); expect(available()).toEqual([0, 0]);
  state.plugins = [];
  await refreshPlugins(); expect(available()).toEqual([1, 1]);
});

it('opens a concise tool preview without installing or showing enabled-tool controls', async () => {
  state.catalog[0]!.tools = ['remember', 'recall'];
  await refreshPlugins();
  document.querySelector<HTMLButtonElement>('#pluginsExplore .plugin-catalog-card')!.click();
  expect(document.querySelector('.plugin-card-head')!.textContent).toContain('Knowledge graph');
  const actions = document.querySelector('.plugin-card-head')!.nextElementSibling!;
  expect(actions.classList.contains('plugin-actions')).toBe(true);
  expect(actions.querySelector('button:first-child')!.textContent).toBe('Install and connect');
  expect(actions.querySelector('button:first-child')!.classList.contains('btn-solid')).toBe(true);
  expect(actions.nextElementSibling!.textContent).toBe('Tool preview');
  expect([...document.querySelectorAll('.plugin-tool-preview li')].map(node => node.textContent)).toEqual(['remember', 'recall']);
  expect(document.querySelector('.plugin-tool input')).toBeNull();
  expect(document.querySelector<HTMLDetailsElement>('.plugin-about')!.open).toBe(false);
  expect(api.pluginsInstall).not.toHaveBeenCalled();
});

it('opens the full error from the compact card and exposes configuration beside the introduction', async () => {
  const error = 'Connection refused. Start the application and enable its companion integration.';
  state.plugins[0]!.error = error;
  state.plugins[0]!.status = 'error';
  await refreshPlugins();
  expect(document.querySelector('.plugin-entry .plugin-card-error')!.textContent).toBe(error);
  document.querySelector<HTMLButtonElement>('.plugin-entry')!.click();
  expect(document.querySelector('.plugin-detail-tools .plugin-error')!.textContent).toBe(error);
  expect(document.querySelectorAll('.plugin-tools-summary')).toHaveLength(1);
  document.querySelector<HTMLButtonElement>('.plugin-detail-intro .plugin-configure')!.click();
  expect(document.getElementById('pluginDialogTitle')!.textContent).toMatch(/^Configure /);
});

it('waits for explicit sign-in and updates the same detail with a cancellable authentication state', async () => {
  state.plugins[0]!.source = { kind: 'remote', url: 'https://example.org/mcp', auth: 'oauth' };
  state.plugins[0]!.status = 'needs-auth';
  initPlugins(); await tick();
  expect(document.querySelector('.plugin-card .pill')!.textContent).toBe('Sign in needed');
  document.querySelector<HTMLButtonElement>('.plugin-entry')!.click();
  expect(api.pluginsAuthenticate).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('.plugin-auth button')!.click(); await tick();
  expect(api.pluginsAuthenticate).toHaveBeenCalledWith('one');
  expect(document.querySelector('.toast')).toBeNull();
  state.plugins[0]!.status = 'authenticating'; await refreshPlugins();
  expect(document.querySelector('.plugin-auth')!.textContent).toContain('Finish signing in through your browser.');
  document.querySelector<HTMLButtonElement>('.plugin-auth button')!.click(); await tick();
  expect(api.pluginsCancelAuthentication).toHaveBeenCalledWith('one');
  state.plugins[0]!.status = 'ready'; await refreshPlugins();
  expect(document.querySelector('.plugin-auth')).toBeNull();
});
