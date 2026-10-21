import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { initPlugins, refreshPlugins, applyPluginsState } from '../src/renderer/plugins.js';
import { setLanguage } from '../src/renderer/i18n.js';
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
  state = { schemaRevision: 1, catalog: [{ id: 'memory', icon: 'memory', color: '#aaa', name: 'Memory', description: 'Knowledge graph', source: { kind: 'npm', package: 'memory' }, homepage: 'https://example.org', license: 'MIT', instructions: ['Install Node.js.'], fields: [{ key: 'TOKEN', label: 'API token', secret: true, required: true }] }], plugins: [{ id: 'one', name: '<img src=x onerror=alert(1)>', source: { kind: 'command', command: 'node' }, config: {}, credentialKeys: ['TOKEN'], longestCallSeconds: 120, version: '1', license: 'MIT', enabled: true, status: 'ready', installedAt: 1, tools: [] }] };
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
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find((node) => node.textContent === 'Save')!.click(); await tick();
  expect(api.pluginsConfigure).toHaveBeenCalledWith('one', expect.objectContaining({ credentials: { TOKEN: 'never-show-this' } }));
  expect(document.body.textContent).not.toContain('never-show-this');
});

it('saves a changed longest-call limit alone without a reconnect or connector-refresh reminder', async () => {
  state.plugins[0]!.longestCallSeconds = 120;
  state.plugins[0]!.fields = [{ key: 'REGION', label: 'Region' }];
  await refreshPlugins();
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Configure')!.click();
  const limit = [...document.querySelectorAll<HTMLInputElement>('#pluginDialog .plugin-field input')]
    .find(input => input.parentElement!.querySelector('span')!.textContent === 'Longest call (seconds)')!;
  expect([limit.type, limit.min, limit.max, limit.step, limit.value]).toEqual(['number', '1', '1800', '1', '120']);
  limit.value = '45';
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find(node => node.textContent === 'Save')!.click();
  await tick();
  expect(api.pluginsConfigure).toHaveBeenCalledExactlyOnceWith('one', { longestCallSeconds: 45 });
  expect(api.pluginsRestart).not.toHaveBeenCalled();
  expect(document.querySelector('.toast')).toBeNull();
});

it('validates integer longest-call limits from 1 to 1800 seconds', async () => {
  await refreshPlugins();
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Configure')!.click();
  const limit = document.querySelector<HTMLInputElement>('#pluginDialog input[type=number]')!;
  const save = [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find(node => node.textContent === 'Save')!;
  for (const invalid of ['0', '1801', '1.5', '']) {
    limit.value = invalid; save.click(); await tick();
    expect(api.pluginsConfigure).not.toHaveBeenCalled();
    expect(document.querySelector('.toast')!.textContent).toContain('Enter a whole number from 1 to 1800 seconds.');
  }
  limit.value = '1'; save.click(); await tick();
  expect(api.pluginsConfigure).toHaveBeenCalledExactlyOnceWith('one', { longestCallSeconds: 1 });
  await refreshPlugins();
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Configure')!.click();
  document.querySelector<HTMLInputElement>('#pluginDialog input[type=number]')!.value = '1800';
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find(node => node.textContent === 'Save')!.click();
  await tick();
  expect(api.pluginsConfigure).toHaveBeenLastCalledWith('one', { longestCallSeconds: 1800 });
});

it('keeps the longest-call limit independent per plugin and reconnects when other settings change', async () => {
  state.plugins[0]!.longestCallSeconds = 30;
  state.plugins.push({ ...structuredClone(state.plugins[0]!), id: 'two', name: 'Second plugin', longestCallSeconds: 300 });
  await refreshPlugins();
  const openConfigure = (index: number) => {
    document.querySelectorAll<HTMLButtonElement>('.plugin-entry')[index]!.click();
    document.querySelector<HTMLButtonElement>('.plugin-detail-intro .plugin-configure')!.click();
    return document.querySelector<HTMLInputElement>('#pluginDialog input[type=number]')!;
  };
  const first = openConfigure(0); expect(first.value).toBe('30');
  first.value = '60';
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find(node => node.textContent === 'Save')!.click(); await tick();
  expect(api.pluginsConfigure).toHaveBeenLastCalledWith('one', { longestCallSeconds: 60 });
  const second = openConfigure(1); expect(second.value).toBe('300');
  second.value = '90';
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find(node => node.textContent === 'Save')!.click(); await tick();
  expect(api.pluginsConfigure).toHaveBeenLastCalledWith('two', { longestCallSeconds: 90 });
  const withSettings = openConfigure(0);
  withSettings.value = '40';
  document.querySelector<HTMLInputElement>('#pluginDialog .plugin-field input')!.value = 'Renamed plugin';
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find(node => node.textContent === 'Save')!.click(); await tick();
  expect(api.pluginsConfigure).toHaveBeenLastCalledWith('one', expect.objectContaining({ name: 'Renamed plugin', longestCallSeconds: 40 }));
  expect(document.querySelector('.toast')!.textContent).toContain('Refresh Chat On Steroids Plugins in ChatGPT');
});

it('recognizes cleared configuration values and additional JSON keys as reconnecting changes', async () => {
  state.plugins[0]!.config = { REGION: 'eu' };
  await refreshPlugins();
  const configure = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Configure')!.click();
  const save = () => [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find(node => node.textContent === 'Save')!.click();
  const byLabel = (label: string) => [...document.querySelectorAll<HTMLInputElement>('#pluginDialog .plugin-field input')]
    .find(input => input.parentElement!.querySelector('span')!.textContent === label)!;
  configure(); byLabel('REGION').value = '';
  byLabel('Longest call (seconds)').value = '45'; save(); await tick();
  expect(api.pluginsConfigure).toHaveBeenLastCalledWith('one', expect.objectContaining({ config: { REGION: '' }, longestCallSeconds: 45 }));
  await refreshPlugins();
  configure(); byLabel('Additional configuration (JSON object)').value = '{"EXTRA":"value"}';
  byLabel('Longest call (seconds)').value = '30'; save(); await tick();
  expect(api.pluginsConfigure).toHaveBeenLastCalledWith('one', expect.objectContaining({ config: { REGION: 'eu', EXTRA: 'value' }, longestCallSeconds: 30 }));
});

it('sends the full patch for a new empty config key and changed longest-call limit', async () => {
  state.plugins[0]!.config = { REGION: 'eu' };
  await refreshPlugins();
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Configure')!.click();
  const field = (label: string) => [...document.querySelectorAll<HTMLInputElement>('#pluginDialog .plugin-field input')]
    .find(input => input.parentElement!.querySelector('span')!.textContent === label)!;
  field('Additional configuration (JSON object)').value = '{"HTTP_PROXY":""}';
  field('Longest call (seconds)').value = '45';
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find(node => node.textContent === 'Save')!.click();
  await tick();
  expect(api.pluginsConfigure).toHaveBeenCalledExactlyOnceWith('one', expect.objectContaining({
    config: { REGION: 'eu', HTTP_PROXY: '' },
    longestCallSeconds: 45,
  }));
  expect(document.querySelector('.toast')!.textContent).toContain('Refresh Chat On Steroids Plugins in ChatGPT');
});

it('keeps the limit-only path when an existing config key is already empty', async () => {
  state.plugins[0]!.config = { HTTP_PROXY: '' };
  await refreshPlugins();
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Configure')!.click();
  document.querySelector<HTMLInputElement>('#pluginDialog input[type=number]')!.value = '45';
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')].find(node => node.textContent === 'Save')!.click();
  await tick();
  expect(api.pluginsConfigure).toHaveBeenCalledExactlyOnceWith('one', { longestCallSeconds: 45 });
  expect(document.querySelector('.toast')).toBeNull();
});

it('routes exact plugin and tool identity for disabling a discovered tool', async () => {
  state.plugins[0]!.tools = [{ name: 'remember', exposedName: 'plugin_one_remember', enabled: true }];
  await refreshPlugins(); document.querySelector<HTMLButtonElement>('.plugin-entry')!.click();
  const toggle = document.querySelector<HTMLInputElement>('.plugin-tool input')!;
  toggle.checked = false; toggle.dispatchEvent(new dom.window.Event('change')); await tick();
  expect(api.pluginsSetToolEnabled).toHaveBeenCalledWith('one', 'remember', false);
  expect(document.querySelector('.toast')!.textContent).toContain('Refresh Chat On Steroids Plugins in ChatGPT');
});

it('distinguishes a serving connector from evidence of ChatGPT contact', () => {
  applyPluginsState({ config: { tunnel: { kind: 'manual' } }, status: { surfaces: [{ id: 'plugins', state: 'live', connectorName: 'Chat On Steroids Plugins', description: 'Plugins', localUrl: 'http://localhost/mcp', lastRequestAt: null }] } } as unknown as AppState);
  expect(document.getElementById('pluginsConnectionStatus')!.textContent).toBe('Plugin online · waiting for ChatGPT');
  expect(document.getElementById('pluginsSetup')).toBeNull();
  expect(document.querySelector('[data-panel="setup"] #pluginsTunnelId')).toBeNull();
  expect(document.querySelector('.plugin-connection')!.classList.contains('is-configured')).toBe(true);
  expect(document.getElementById('pluginsSetupLink')!.textContent).toBe('Plugin setup');
});

it('keeps saved plugin setup compact after restart even while its connector is offline', () => {
  applyPluginsState({ config: { tunnel: { kind: 'openai', pluginsTunnelId: 'saved-plugins' } }, status: { surfaces: [] } } as unknown as AppState);
  expect(document.querySelector('.plugin-connection')!.classList.contains('is-configured')).toBe(true);
  expect(document.getElementById('pluginsConnectionStatus')!.textContent).toBe('Chat On Steroids Plugins offline');
  expect(document.getElementById('pluginsSetupLink')!.textContent).toBe('Plugin setup');
  applyPluginsState({ config: { tunnel: { kind: 'openai', pluginsTunnelId: '' } }, status: { surfaces: [] } } as unknown as AppState);
  expect(document.querySelector('.plugin-connection')!.classList.contains('is-configured')).toBe(false);
});

it('keeps first-use setup and the connector-refresh instruction visible, including after connection', async () => {
  initPlugins(); await tick();
  expect(document.querySelector('.plugin-connection')!.textContent).toContain('before your first use');
  expect(document.querySelector('.plugin-refresh-guide')!.textContent).toContain('After installing, updating or changing enabled plugins');
  applyPluginsState({ config: { tunnel: { kind: 'manual' } }, status: { surfaces: [{ id: 'plugins', state: 'live', lastRequestAt: 1, tools: [] }] } } as unknown as AppState);
  expect(document.getElementById('pluginsSetupTitle')!.textContent).toBe('Chat On Steroids Plugins in ChatGPT');
  expect(document.querySelector('.plugin-refresh-guide')!.textContent).toContain('refresh Chat On Steroids Plugins in ChatGPT');
  document.getElementById('pluginsOpenChatGPT')!.click(); await tick();
  expect(api.openLink).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com/plugins');
  document.getElementById('pluginsSetupLink')!.click();
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog button')]
    .find(node => node.textContent === 'Open ChatGPT plugins')!.click();
  await tick();
  expect(api.openLink!.mock.calls).toEqual([['https://chatgpt.com/plugins'], ['https://chatgpt.com/plugins']]);
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

it('marks the About and Setup disclosures with the chevron, and keeps it through a language change', async () => {
  // The native marker is hidden, so the chevron is the only sign these rows open.
  const chevronFirst = (summary: HTMLElement) => summary.firstElementChild!.classList.contains('details-chevron');
  await refreshPlugins();
  document.querySelector<HTMLButtonElement>('#pluginsExplore .plugin-catalog-card')!.click();
  const setup = document.querySelector<HTMLElement>('#pluginDialog .plugin-about > summary')!;
  expect(setup.textContent).toBe('Setup requirements');
  expect(chevronFirst(setup)).toBe(true);
  document.querySelector<HTMLButtonElement>('.plugin-entry')!.click();
  const about = [...document.querySelectorAll<HTMLElement>('#pluginDialog .plugin-about > summary')].find(node => node.textContent === 'About this plugin')!;
  expect(chevronFirst(about)).toBe(true);
  try {
    setLanguage('pt-BR');
    expect(about.textContent).toBe('Sobre este plugin');
    expect(chevronFirst(about)).toBe(true);
  } finally {
    setLanguage('en');
  }
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

it('offers OAuth for a custom remote server and opens the new plugin where it can sign in', async () => {
  initPlugins(); await tick();
  document.getElementById('pluginsAdd')!.click();
  [...document.querySelectorAll<HTMLButtonElement>('.plugin-actions button')].find(node => node.textContent === 'Remote MCP URL')!.click();
  const fields = () => [...document.querySelectorAll<HTMLLabelElement>('.plugin-field')];
  const labelled = (text: string) => fields().find(node => node.querySelector('span')!.textContent === text)!;
  const [type, auth] = [labelled('Server type'), labelled('Authentication')].map(node => node.querySelector('select')!);
  expect(labelled('Authentication').hidden).toBe(false);
  type!.value = 'npm'; type!.dispatchEvent(new dom.window.Event('change'));
  expect(labelled('Authentication').hidden, 'OAuth is a remote-only choice').toBe(true);
  type!.value = 'remote'; type!.dispatchEvent(new dom.window.Event('change'));
  auth!.value = 'oauth'; auth!.dispatchEvent(new dom.window.Event('change'));
  expect(labelled('Credential value').hidden, 'no static credential beside a provider sign-in').toBe(true);
  labelled('Credential value').querySelector('input')!.value = 'left over';
  labelled('Credential name (optional)').querySelector('input')!.value = 'Authorization';
  labelled('Package, executable, URL or bundle path').querySelector('input')!.value = 'https://mcp.example.org/mcp';
  const added = { ...state.plugins[0]!, id: 'two', name: 'Remote', source: { kind: 'remote' as const, url: 'https://mcp.example.org/mcp', auth: 'oauth' as const }, status: 'needs-auth' as const, credentialKeys: [] };
  api.pluginsInstall!.mockImplementation(async () => ({ ok: true, data: { ...state, plugins: [...state.plugins, added] } }));
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Install and connect')!.click();
  await tick(); await tick();
  expect(api.pluginsInstall).toHaveBeenCalledWith({ name: 'My MCP server', source: { kind: 'remote', args: [], url: 'https://mcp.example.org/mcp', auth: 'oauth' }, credentials: {} });
  expect(document.querySelector('.plugin-auth button'), 'lands on the new plugin with its Sign in').not.toBeNull();
});

it('keeps a custom remote server without OAuth on its static credential', async () => {
  initPlugins(); await tick();
  document.getElementById('pluginsAdd')!.click();
  [...document.querySelectorAll<HTMLButtonElement>('.plugin-actions button')].find(node => node.textContent === 'Remote MCP URL')!.click();
  const labelled = (text: string) => [...document.querySelectorAll<HTMLLabelElement>('.plugin-field')].find(node => node.querySelector('span')!.textContent === text)!;
  labelled('Package, executable, URL or bundle path').querySelector('input')!.value = 'https://mcp.example.org/mcp';
  labelled('Credential name (optional)').querySelector('input')!.value = 'Authorization';
  labelled('Credential value').querySelector('input')!.value = 'Bearer x';
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Install and connect')!.click();
  await tick();
  expect(api.pluginsInstall).toHaveBeenCalledWith({ name: 'My MCP server', source: { kind: 'remote', args: [], url: 'https://mcp.example.org/mcp' }, credentials: { Authorization: 'Bearer x' } });
});

it('names this computer\'s own Plugins connector everywhere the page tells the user to act on it', async () => {
  // One ChatGPT account on several computers: this computer's connector carries its suffix,
  // and an instruction naming the plain one would send the user to the other computer's plugin.
  const named = 'Chat On Steroids Plugins (Windows)';
  const withName = (lastRequestAt: number | null) => ({ config: { tunnel: { kind: 'openai', pluginsTunnelId: '' } },
    status: { surfaces: [{ id: 'plugins', state: 'off', connectorName: named, lastRequestAt, tools: [] }] } }) as unknown as AppState;
  initPlugins(); await tick();
  applyPluginsState(withName(null));
  expect(document.getElementById('pluginsSetupHint')!.textContent).toBe(`Add ${named} to ChatGPT once, so ChatGPT can use your installed plugins.`);
  expect(document.querySelector('.plugin-refresh-guide')!.textContent).toContain(`refresh ${named} in ChatGPT`);
  state.plugins[0]!.tools = [{ name: 'remember', exposedName: 'plugin_one_remember', enabled: true }];
  await refreshPlugins(); document.querySelector<HTMLButtonElement>('.plugin-entry')!.click();
  const toggle = document.querySelector<HTMLInputElement>('.plugin-tool input')!;
  toggle.checked = false; toggle.dispatchEvent(new dom.window.Event('change')); await tick();
  expect(document.querySelector('.toast')!.textContent).toContain(`Refresh ${named} in ChatGPT`);
  // The name survives a language change, and a later state without a name falls back to the plain one.
  setLanguage('de');
  expect(document.querySelector('.plugin-refresh-guide')!.textContent).toContain(named);
  setLanguage('en');
  applyPluginsState({ config: { tunnel: { kind: 'openai', pluginsTunnelId: '' } }, status: { surfaces: [] } } as unknown as AppState);
  expect(document.querySelector('.plugin-refresh-guide strong')!.textContent).toBe('Chat On Steroids Plugins');
});

it('asks before uninstalling like removing a skill: Cancel first and focused, the destructive step last', async () => {
  await refreshPlugins();
  [...document.querySelectorAll<HTMLButtonElement>('.plugin-card button')].find(node => node.textContent === 'Uninstall')!.click();
  const box = document.getElementById('pluginDialog')!;
  const buttons = [...box.querySelectorAll<HTMLButtonElement>('.pet-delete-actions button')];
  expect(buttons.map(node => node.textContent)).toEqual(['Cancel', 'Uninstall plugin']);
  expect(buttons[1]!.classList.contains('plugin-destructive')).toBe(true);
  expect(document.activeElement).toBe(buttons[0]);
  // Cancel closes it and uninstalls nothing.
  buttons[0]!.click(); await tick();
  expect(document.getElementById('pluginDialog')).toBeNull();
  expect(api.pluginsUninstall).not.toHaveBeenCalled();
  [...document.querySelectorAll<HTMLButtonElement>('.plugin-card button')].find(node => node.textContent === 'Uninstall')!.click();
  [...document.querySelectorAll<HTMLButtonElement>('#pluginDialog .pet-delete-actions button')].find(node => node.textContent === 'Uninstall plugin')!.click(); await tick();
  expect(api.pluginsUninstall).toHaveBeenCalledExactlyOnceWith('one');
});
