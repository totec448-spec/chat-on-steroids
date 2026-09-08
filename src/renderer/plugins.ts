import type { AppState } from '../shared/types.js';
import type { SettingsPatch } from '../preload/index.js';
import type { PluginSnapshot, PluginView, PluginCatalogEntry, PluginSource } from '../shared/plugins.js';
import { $, el, run, toast } from './dom.js';

let snapshot: PluginSnapshot = { plugins: [], catalog: [], schemaRevision: 0 };
let epoch = 0;
let appState: AppState | null = null;
let applyAppState: (next: AppState) => void = () => {};
const artwork = import.meta.glob('./plugin-icons/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
function button(label: string, action: () => void | Promise<void>, primary = false): HTMLButtonElement {
  const node = el('button', `btn${primary ? ' btn-solid' : ''}`, label) as HTMLButtonElement;
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await action(); } catch (error) { toast(error instanceof Error ? error.message : 'Plugin operation failed'); }
    finally { node.disabled = false; }
  });
  return node;
}
function art(id: string): HTMLElement {
  const img = document.createElement('img'); img.className = 'plugin-icon'; img.alt = '';
  img.src = artwork[`./plugin-icons/${id}.svg`] ?? artwork['./plugin-icons/custom.svg']!; return img;
}
function field(parent: HTMLElement, label: string, value = '', secret = false, hint = ''): HTMLInputElement {
  const wrap = el('label', 'plugin-field'); const input = document.createElement('input');
  input.type = secret ? 'password' : 'text'; input.value = value;
  if (secret) { input.autocomplete = 'new-password'; input.spellcheck = false; }
  wrap.append(el('span', '', label), input); if (hint) wrap.append(el('small', 'muted', hint)); parent.append(wrap); return input;
}
function dialog(title: string): { box: HTMLDialogElement; body: HTMLElement } {
  document.querySelector('#pluginDialog')?.remove();
  const box = document.createElement('dialog'); box.id = 'pluginDialog'; box.className = 'plugin-dialog';
  const head = el('div', 'plugin-dialog-head'); const heading = el('h2', '', title); heading.id = 'pluginDialogTitle';
  box.setAttribute('aria-labelledby', heading.id); head.append(heading, button('Close', () => box.close()));
  const body = el('div', 'plugin-dialog-body'); box.append(head, body);
  box.addEventListener('close', () => box.remove()); document.body.append(box); box.showModal(); return { box, body };
}
async function mutate(work: ReturnType<typeof window.api.pluginsSnapshot>, notify = true): Promise<boolean> {
  const own = ++epoch; const result = await run(work);
  if (!result) return false;
  if (own === epoch) { snapshot = result; renderInstalled(); }
  if (notify) toast('Plugin settings saved. Refresh the Chat On Steroids Plugins connector in ChatGPT to update its tools.');
  return true;
}
export async function refreshPlugins(): Promise<void> { await mutate(window.api.pluginsSnapshot(), false); }
export function applyPluginsState(next: AppState): void {
  appState = next;
  const surface = next.status.surfaces.find((item) => item.id === 'plugins');
  const status = $('pluginsConnectionStatus');
  const contacted = surface?.state === 'live' && !!surface.lastRequestAt;
  const configured = !!next.config.tunnel.pluginsTunnelId?.trim() || surface?.state === 'live';
  $('pluginsSetupTitle').closest('.plugin-connection')!.classList.toggle('is-configured', configured);
  $('pluginsSetupTitle').textContent = configured ? 'Your Plugins connector' : 'Set up plugins before your first use';
  $('pluginsSetupHint').textContent = configured
    ? 'Your enabled plugins share one connector in ChatGPT. Manage its connection here.'
    : 'Add the Chat On Steroids Plugins connector in ChatGPT once so it can use your installed plugins.';
  $('pluginsSetupLink').textContent = configured ? 'Plugin setup' : 'Set up plugins';
  $('pluginsSetupLink').classList.toggle('btn-solid', !configured);
  status.textContent = surface?.state === 'live'
    ? contacted ? 'Connected to ChatGPT' : 'Connector online · waiting for ChatGPT'
    : configured ? 'Plugins connector offline' : 'Setup required · connect your plugins';
  status.dataset.live = String(surface?.state === 'live');
  status.title = surface?.detail ?? '';
  const setupStatus = document.getElementById('pluginSetupStatus');
  if (setupStatus) setupStatus.textContent = surface?.state === 'live'
    ? `${surface.tools.length} tools available · ${surface.lastRequestAt ? 'Connected to ChatGPT' : 'Ready to add in ChatGPT'}`
    : surface?.state === 'error' ? surface.detail : 'Save your connection below to make enabled plugins available in ChatGPT.';
}
function showConnection(): void {
  if (!appState) { toast('Connection settings are still loading.'); return; }
  const { config, hasApiKey, status } = appState;
  const surface = status.surfaces.find(item => item.id === 'plugins');
  const { body } = dialog('Plugin setup');
  body.append(el('p', '', 'Connect once. Your enabled plugins share this connector in ChatGPT.'));
  const connectionStatus = el('p', 'plugin-setup-status'); connectionStatus.id = 'pluginSetupStatus'; body.append(connectionStatus);
  const copy = (label: string, value: string) => {
    const input = field(body, label, value); input.readOnly = true;
    const row = el('div', 'plugin-setup-copy'); input.replaceWith(row); row.append(input, button('Copy', async () => { if (await run(window.api.writeClipboard(value))) toast(`${label} copied`); }));
  };
  let tunnel: HTMLInputElement | null = null;
  let key: HTMLInputElement | null = null;
  if (config.tunnel.kind === 'openai') {
    body.append(button('Open Tunnels', async () => { await run(window.api.openLink('https://platform.openai.com/settings/organization/tunnels')); }));
    tunnel = field(body, 'Plugins tunnel ID', config.tunnel.pluginsTunnelId ?? '', false, 'Create a dedicated tunnel in the same workspace you use in ChatGPT.');
    tunnel.id = 'pluginsTunnelId'; tunnel.spellcheck = false; tunnel.autocomplete = 'off';
    if (hasApiKey) body.append(el('p', 'hint', 'Your stored tunnel API key is already available.'));
    else key = field(body, 'Tunnel API key', '', true, 'Use a restricted key with Tunnels: Read and Tunnels: Use. It is stored securely and shared with your other connectors.');
  }
  // Values needed for ChatGPT setup stay copyable; tool lists belong to each plugin.
  copy('Connector name', surface?.connectorName ?? 'Chat On Steroids Plugins');
  copy('Description', surface?.description ?? 'Tools from your enabled Chat On Steroids plugins.');
  const url = surface?.publicUrl ?? (config.tunnel.kind === 'manual' ? surface?.localUrl : null);
  if (url) copy('MCP server URL', url);
  body.append(el('p', 'hint', config.tunnel.kind === 'openai'
    ? 'In ChatGPT, add this connector with Tunnel and select your Plugins tunnel. Refresh its tools after adding or changing plugins.'
    : 'In ChatGPT, add this connector using its MCP server URL. Refresh its tools after adding or changing plugins.'));
  const actions = el('div', 'plugin-setup-actions');
  actions.append(button('Open ChatGPT plugins', async () => { await run(window.api.openLink('https://chatgpt.com/#settings/Plugins')); }), button('Save & connect', async () => {
    if (!appState) return;
    if (tunnel && !tunnel.value.trim()) { tunnel.focus(); throw new Error('Enter your Plugins tunnel ID.'); }
    if (key?.value) { const next = await run(window.api.setApiKey(key.value)); if (!next) return; key.value = ''; applyAppState(next); applyPluginsState(next); }
    if (tunnel) {
      const { capabilities, readOnly, tunnel: previousTunnel, ui, sessions, compaction, multiAgent, goal, mcp } = appState.config;
      const base: SettingsPatch = { capabilities, readOnly, tunnel: previousTunnel, ui, sessions, compaction, multiAgent, goal, mcp };
      const next = await run(window.api.saveSettings({ ...base, tunnel: { ...previousTunnel, pluginsTunnelId: tunnel.value.trim() } }, base));
      if (!next) return; applyAppState(next); applyPluginsState(next);
    }
    const next = await run(window.api.connect());
    if (next) { applyAppState(next); applyPluginsState(next); toast('Plugin connection saved'); }
  }, true)); body.append(actions);
  applyPluginsState(appState);
}
function renderInstalled(): void {
  const list = $('pluginsInstalled');
  list.replaceChildren(); $('pluginsCount').textContent = `${snapshot.plugins.length} installed`;
  const query = $<HTMLInputElement>('pluginsSearch').value.trim().toLowerCase();
  const matches = (name: string, description = '') => `${name} ${description}`.toLowerCase().includes(query);
  if (!snapshot.plugins.length) {
    const empty = el('div', 'plugin-empty'); empty.append(art('custom'), el('h2', '', 'A little more possibility'), el('p', 'muted', 'Add a plugin below to bring memory, creative tools and browser automation into your chats.'), button('Add your first plugin', showCatalog, true)); list.append(empty);
  }
  for (const plugin of snapshot.plugins) {
    const recipe = snapshot.catalog.find(entry => entry.id === plugin.catalogId);
    const description = recipe?.description ?? (plugin.source.kind === 'remote' ? 'Your connected MCP server.' : 'Your local MCP integration.');
    if (!matches(plugin.name, description)) continue;
    const card = el('article', 'plugin-card');
    const open = button('', () => showPlugin(plugin)); open.className = 'plugin-entry';
    const title = el('div', 'plugin-card-title');
    title.append(el('h2', '', plugin.name));
    open.setAttribute('aria-label', `Open ${plugin.name}`);
    const status = plugin.status === 'error' ? 'Needs attention' : plugin.status === 'needs-auth' ? 'Sign in needed' : plugin.status === 'authenticating' ? 'Signing in…' : plugin.status === 'ready' && plugin.tools.length ? 'Ready' : plugin.status === 'ready' ? 'Connected · no tools' : plugin.status === 'connecting' ? 'Connecting…' : plugin.status === 'disabled' ? 'Disabled' : 'Check connection';
    const count = plugin.tools.filter(tool => tool.enabled).length;
    const foot = el('div', 'plugin-card-foot');
    foot.append(el('span', `pill${status === 'Ready' ? ' is-live' : plugin.status === 'error' ? ' is-error' : ''}`, status));
    if (plugin.error) foot.append(el('span', 'plugin-card-error', plugin.error));
    foot.append(el('span', 'plugin-tool-count', `${count} ${count === 1 ? 'tool' : 'tools'} enabled`));
    title.append(foot); open.append(art(recipe?.icon ?? plugin.catalogId ?? 'custom'), title);
    const menu = document.createElement('details'); menu.className = 'plugin-menu';
    const summary = el('summary', '', '•••'); summary.setAttribute('aria-label', `Actions for ${plugin.name}`);
    const actions = el('div', 'plugin-menu-actions');
    actions.append(button(plugin.enabled ? 'Disable' : 'Enable', async () => { await mutate(window.api.pluginsSetEnabled(plugin.id, !plugin.enabled)); }), button('Configure', () => showConfigure(plugin)), button('Restart', async () => { await mutate(window.api.pluginsRestart(plugin.id)); }), button('Update', async () => { await mutate(window.api.pluginsUpdate(plugin.id)); }));
    const uninstall = button('Uninstall', () => showUninstall(plugin)); uninstall.classList.add('plugin-destructive'); actions.append(uninstall);
    menu.append(summary, actions); card.append(open, menu);
    list.append(card);
  }
  if (snapshot.plugins.length && !list.children.length) list.append(el('p', 'plugin-no-results muted', 'No installed plugins match your search.'));
  renderCatalog($('pluginsExplore'), query);
  const catalog = document.querySelector<HTMLElement>('#pluginDialog [data-plugin-catalog]');
  if (catalog) renderCatalog(catalog);
  // Keep an open detail view on the same plugin after a tool or status change.
  const detail = document.querySelector<HTMLElement>('#pluginDialog [data-plugin-detail]');
  if (detail) { const current = snapshot.plugins.find(plugin => plugin.id === detail.dataset.pluginDetail); if (current) renderPluginTools(detail, current); }
}
/** Installation identity, not enabled state or a user-edited display name, owns catalog membership. */
function availableRecipes(): PluginCatalogEntry[] {
  return snapshot.catalog.filter(recipe => !snapshot.plugins.some(plugin =>
    plugin.catalogId === recipe.id || (plugin.source.kind === recipe.source.kind && (
      ((recipe.source.kind === 'npm' || recipe.source.kind === 'python') && plugin.source.package === recipe.source.package) ||
      (recipe.source.kind === 'remote' && plugin.source.url === recipe.source.url)
    ))
  ));
}
function renderCatalog(parent: HTMLElement, query = ''): void {
  parent.replaceChildren();
  for (const recipe of availableRecipes().filter(entry => `${entry.name} ${entry.description}`.toLowerCase().includes(query))) {
    const card = button('', () => showRecipe(recipe)); card.className = 'plugin-catalog-card';
    const text = el('span', 'plugin-card-title'); text.append(el('h3', '', recipe.name), el('p', 'muted', recipe.description));
    card.append(art(recipe.icon), text); parent.append(card);
  }
  if (!parent.children.length) parent.append(el('p', 'plugin-no-results muted', query
    ? 'No matching plugins available to add.' : 'All catalog plugins are installed. You can also add your own MCP server.'));
}
function renderPluginTools(parent: HTMLElement, plugin: PluginView): void {
    const published = plugin.tools.filter(tool => tool.published).length;
    const publication = plugin.tools.some(tool => tool.published !== undefined) ? ` · ${published} available in ChatGPT` : '';
    parent.replaceChildren();
    if (plugin.status === 'needs-auth' || plugin.status === 'authenticating') {
      const auth = el('div', 'plugin-auth');
      auth.append(el('p', '', plugin.status === 'authenticating' ? 'Finish signing in through your browser.' : `Sign in to ${plugin.name} to connect your account.`));
      auth.append(plugin.status === 'authenticating'
        ? button('Cancel sign-in', async () => { await mutate(window.api.pluginsCancelAuthentication(plugin.id), false); })
        : button('Sign in', async () => { await mutate(window.api.pluginsAuthenticate(plugin.id), false); }, true));
      parent.append(auth);
    }
    parent.append(el('h3', '', 'Tools'), el('p', 'plugin-tools-summary', `${plugin.tools.filter(tool => tool.enabled).length}/${plugin.tools.length} enabled${publication} · This plugin only · Refresh ChatGPT after changes`));
    if (plugin.error) parent.append(el('p', 'plugin-error', plugin.error));
    const tools = el('div', 'plugin-tools');
    for (const tool of plugin.tools) {
      const row = el('label', 'plugin-tool'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = tool.enabled; checkbox.disabled = !plugin.enabled;
      checkbox.addEventListener('change', async () => { checkbox.disabled = true; if (!await mutate(window.api.pluginsSetToolEnabled(plugin.id, tool.name, checkbox.checked))) { checkbox.checked = tool.enabled; checkbox.disabled = !plugin.enabled; } });
      const text = el('span'); text.append(el('b', '', tool.name), el('small', 'muted', tool.description || tool.exposedName));
      if (tool.enabled && tool.published === false) text.append(el('small', 'muted', tool.exposureError ?? 'Not available in ChatGPT. Check this plugin’s connection.'));
      row.append(checkbox, text); tools.append(row);
    }
    parent.append(tools);
}
function showPlugin(plugin: PluginView): void {
  const recipe = snapshot.catalog.find(entry => entry.id === plugin.catalogId);
  const { body } = dialog(plugin.name);
  const hero = el('div', 'plugin-detail-hero');
  const intro = el('div', 'plugin-detail-intro');
  const configure = button('Configure Plugin', () => showConfigure(plugin), true); configure.classList.add('plugin-configure');
  intro.append(el('p', '', recipe?.description ?? 'Your own MCP server, available in your conversations.'), configure);
  hero.append(art(recipe?.icon ?? plugin.catalogId ?? 'custom'), intro); body.append(hero);
  const tools = el('section', 'plugin-detail-tools'); tools.dataset.pluginDetail = plugin.id; renderPluginTools(tools, plugin); body.append(tools);
  const about = document.createElement('details'); about.className = 'plugin-about'; about.append(el('summary', '', 'About this plugin'));
  about.append(el('p', 'plugin-source', plugin.source.url ?? plugin.source.package ?? plugin.source.command ?? plugin.source.kind), el('p', 'muted', `${plugin.version || 'Custom version'} · ${plugin.license || 'License not supplied'}`), el('p', '', 'Runs while installed and enabled, including after reopening the app. Disable or uninstall it to stop its connection. Restart reconnects and refreshes its tools.'));
  if (plugin.homepage ?? recipe?.homepage) about.append(button('Open upstream project', async () => { await run(window.api.openLink((plugin.homepage ?? recipe!.homepage)!)); }));
  body.append(about);
}
function showUninstall(plugin: PluginView): void {
  const { box, body } = dialog(`Uninstall ${plugin.name}?`);
  body.append(el('p', '', 'This stops its connection and deletes the installation, its CoS-managed local data and stored credentials. Back up any plugin data you need first. External application data is not removed.'), button('Uninstall plugin', async () => { if (await mutate(window.api.pluginsUninstall(plugin.id))) box.close(); }, true));
}
function showConfigure(plugin: PluginView): void {
  const { box, body } = dialog(`Configure ${plugin.name}`); const config = new Map<string, HTMLInputElement>(); const secrets = new Map<string, HTMLInputElement>();
  const name = field(body, 'Display name', plugin.name);
  for (const item of plugin.fields ?? snapshot.catalog.find((entry) => entry.id === plugin.catalogId)?.fields ?? [])
    (item.secret ? secrets : config).set(item.key, field(body, item.label, item.secret ? '' : plugin.config[item.key] ?? '', item.secret, item.secret ? 'Leave empty to keep the saved credential.' : item.placeholder));
  for (const [key, value] of Object.entries(plugin.config)) if (!config.has(key)) config.set(key, field(body, key, value));
  for (const key of plugin.credentialKeys) if (!secrets.has(key)) secrets.set(key, field(body, key, '', true, 'Leave empty to keep the saved credential.'));
  const source = field(body, 'Server configuration (JSON)', JSON.stringify(plugin.source), false, 'Keep credentials in the secure fields, not in command arguments or URLs.');
  const extraConfig = field(body, 'Additional configuration (JSON object)', '{}', false, 'Non-secret settings and environment variables only.');
  const extraKey = field(body, 'Additional credential name (optional)', '', false, 'Environment variable for local servers; header name for remote servers.'); const extraValue = field(body, 'Additional credential value', '', true);
  body.append(button('Save and reconnect', async () => {
    const credentials = Object.fromEntries([...secrets].filter(([, input]) => input.value).map(([key, input]) => [key, input.value]));
    if (extraKey.value.trim() && extraValue.value) credentials[extraKey.value.trim()] = extraValue.value;
    const additions: unknown = JSON.parse(extraConfig.value);
    if (!additions || typeof additions !== 'object' || Array.isArray(additions) || !Object.values(additions).every((value) => typeof value === 'string')) throw new Error('Additional configuration must be an object of string values.');
    const configuredSource = JSON.parse(source.value) as PluginSource;
    if (await mutate(window.api.pluginsConfigure(plugin.id, { name: name.value,
      ...(JSON.stringify(configuredSource) !== JSON.stringify(plugin.source) ? { source: configuredSource } : {}),
      config: { ...Object.fromEntries([...config].map(([key, input]) => [key, input.value])), ...additions as Record<string,string> }, credentials }))) box.close();
  }, true));
}
function showCatalog(): void {
  const { body } = dialog('Add a plugin'); body.append(el('p', 'muted', 'Independent integrations, one shared connector. Review each plugin’s access and setup before installing.'));
  const grid = el('div', 'plugin-catalog'); grid.dataset.pluginCatalog = ''; renderCatalog(grid);
  body.append(grid, el('h3', '', 'Bring your own server')); const custom = el('div', 'plugin-actions');
  custom.append(button('Import MCPB bundle', async () => { const path = await run(window.api.pluginsImportBundle()); if (path) showCustom('mcpb', path); }), button('npm / Python / executable', () => showCustom('npm')), button('Remote MCP URL', () => showCustom('remote')), button('GitHub repository', () => showCustom('github')));
  body.append(custom, el('p', 'hint', 'Local plugins run as your OS user and do not inherit CoS approved-folder restrictions. Install only code you trust.'));
}
function showRecipe(recipe: PluginCatalogEntry): void {
  const { box, body } = dialog(`Set up ${recipe.name}`); const header = el('div', 'plugin-card-head'); header.append(art(recipe.icon), el('p', '', recipe.description)); body.append(header);
  const actions = el('div', 'plugin-actions'); body.append(actions);
  if (recipe.tools?.length) {
    const tools = el('ul', 'plugin-tool-preview'); for (const name of recipe.tools) tools.append(el('li', '', name));
    body.append(el('h3', 'plugin-preview-title', 'Tool preview'), tools);
  }
  const setup = document.createElement('details'); setup.className = 'plugin-about'; setup.append(el('summary', '', 'Setup requirements'));
  const steps = el('ol', 'plugin-steps'); for (const step of recipe.instructions) steps.append(el('li', '', step)); setup.append(steps, button('Open project & setup guide', async () => { await run(window.api.openLink(recipe.homepage)); })); body.append(setup);
  const values = new Map<string, HTMLInputElement>();
  for (const item of recipe.fields) { const input = field(body, item.label, '', item.secret, item.placeholder); input.required = !!item.required; values.set(item.key, input); }
  const remote = recipe.source.kind === 'remote';
  body.append(el('p', 'hint', remote
    ? `${recipe.license}. Connect your account through the provider. Its plan and usage limits apply.`
    : `License: ${recipe.license}. Installation downloads and runs third-party code as your OS user. “Ready” requires a successful connection and tool discovery.`));
  actions.append(button(remote ? 'Add connection' : 'Install and connect', async () => {
    for (const item of recipe.fields) if (item.required && !values.get(item.key)!.value.trim()) { values.get(item.key)!.focus(); throw new Error(`${item.label} is required.`); }
    const config: Record<string,string> = {}; const credentials: Record<string,string> = {};
    for (const item of recipe.fields) (item.secret ? credentials : config)[item.key] = values.get(item.key)!.value;
    if (await mutate(window.api.pluginsInstall({ catalogId: recipe.id, config, credentials }))) {
      box.close();
      if (remote) { const installed = snapshot.plugins.find(plugin => plugin.catalogId === recipe.id); if (installed) showPlugin(installed); }
    }
  }, true), button('Back to plugins', showCatalog));
}
function showCustom(kind: PluginSource['kind'], path = ''): void {
  const { box, body } = dialog('Connect your MCP server'); const name = field(body, 'Display name', 'My MCP server');
  const label = el('label', 'plugin-field'); label.append(el('span', '', 'Server type')); const select = document.createElement('select');
  for (const [value, text] of [['npm','npm package'],['python','Python package (uv)'],['command','Custom executable'],['remote','Remote Streamable HTTP'],['github','GitHub repository'],['mcpb','MCPB bundle']]) { const option = document.createElement('option'); option.value = value!; option.textContent = text!; select.append(option); }
  select.value = kind; label.append(select); body.append(label);
  const location = field(body, 'Package, executable, URL or bundle path', path); const version = field(body, 'Version (npm / Python)', '', false, 'Pin a published version for reproducible installation.');
  const args = field(body, 'Arguments (JSON array)', '[]', false, 'Example: ["--port", "9876"]. Passed directly, without a shell.');
  const key = field(body, 'Credential name (optional)', '', false, 'An environment variable for local servers, or an HTTP header such as Authorization.'); const credential = field(body, 'Credential value', '', true);
  body.append(el('p', 'hint', 'Remote servers must support MCP Streamable HTTP. GitHub links require a known recipe or supported manifest. Local servers run outside the CoS folder sandbox.'), button('Install and connect', async () => {
    const selected = select.value as PluginSource['kind']; const value = location.value.trim(); if (!value) throw new Error('Enter the server location first.');
    const parsed: unknown = JSON.parse(args.value); if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new Error('Arguments must be a JSON array of strings.');
    const source: PluginSource = { kind: selected, args: parsed };
    if (selected === 'remote' || selected === 'github') source.url = value; else if (selected === 'mcpb') source.path = value; else if (selected === 'command') source.command = value; else { source.package = value; if (version.value.trim()) source.version = version.value.trim(); }
    if (await mutate(window.api.pluginsInstall({ name: name.value, source, credentials: key.value.trim() && credential.value ? { [key.value.trim()]: credential.value } : {} }))) box.close();
  }, true));
}
export function initPlugins(onState: (next: AppState) => void = () => {}): void {
  applyAppState = onState;
  $('pluginsAdd').addEventListener('click', showCatalog); $('pluginsRefresh').addEventListener('click', () => void refreshPlugins());
  $('pluginsSearch').addEventListener('input', renderInstalled);
  $('pluginsSetupLink').addEventListener('click', showConnection);
  $('pluginsOpenChatGPT').addEventListener('click', async () => { await run(window.api.openLink('https://chatgpt.com/#settings/Plugins')); });
  $('pluginsLegalOpen').addEventListener('click', async () => { await run(window.api.openLegalNotices()); });
  window.api.onPluginsChanged(() => { void refreshPlugins(); }); void refreshPlugins();
}
