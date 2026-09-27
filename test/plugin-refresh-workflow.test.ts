import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('  let pluginRefreshBusy = false;'), source.indexOf('  function catalogPageReady('));
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const tools = [{ name: 'read', description: 'Read current.', inputSchema: { type: 'object' } }];
function workflow(options: { unchanged?: boolean; deny?: boolean; navigateDuringClaim?: boolean; refreshAvailable?: boolean; href?: string } = {}) {
  let refreshed = false;
  const click = vi.fn(() => { refreshed = true; });
  const href = options.href ?? `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic`;
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1,
    t: (_key: string, fallback: string) => fallback,
    location: { pathname: new URL(href).pathname, href },
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic', refresh: options.refreshAvailable === false ? null : { click }, tools: options.unchanged || refreshed ? tools : [{ ...tools[0], description: 'Old description.' }] }) }
  });
  const ask = vi.fn(async (message: { action: string }) => {
    if (message.action === 'claim' && options.navigateDuringClaim) context.epoch = 2;
    return { data: { ok: !(message.action === 'claim' && options.deny) } };
  });
  context.ask = ask;
  vm.runInContext(`${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin;`, context);
  return { click, ask, run: () => (context.run as Function)({ id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools }) };
}
it('claims before exactly one click and completes only a newly observed matching schema', async () => {
  const h = workflow();
  expect(await h.run()).toBe(true);
  expect(h.click).toHaveBeenCalledTimes(1);
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['claim', 'complete']);
  expect(h.ask.mock.invocationCallOrder[0]).toBeLessThan(h.click.mock.invocationCallOrder[0]!);
});
it.each([false, true])('waits for readable tool schemas before claim (navigation=%s)', async navigate => {
  const dom = new JSDOM('<html><body></body></html>');
  let ready = false, refreshed = false;
  const click = vi.fn(() => { refreshed = true; });
  const ask = vi.fn(async () => ({ data: { ok: true } }));
  const context = vm.createContext({ URL, setTimeout, clearTimeout, setInterval, clearInterval, pageViewChecks: new Set(), MutationObserver: dom.window.MutationObserver,
    document: dom.window.document, alive: true, generating: false, epoch: 1, ask,
    location: { pathname: '/', href: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic` },
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic', refresh: { click },
        tools: ready ? (refreshed ? tools : [{ ...tools[0], description: 'Old' }]) : null }) }
  });
  vm.runInContext(`${section}\nglobalThis.run = refreshManagedPlugin;`, context);
  const pending = (context.run as Function)({ id, appId: null, connectorName: 'Chat On Steroids Core', tools });
  expect(ask).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled();
  ready = true;
  if (navigate) context.epoch = 2;
  dom.window.document.body.setAttribute('data-hydrated', 'true');
  expect(await pending).toBe(!navigate);
  expect(click).toHaveBeenCalledTimes(navigate ? 0 : 1);
  expect(context.pageViewChecks.size).toBe(0);
  expect(ask.mock.calls.length).toBe(navigate ? 0 : 2);
  dom.window.close();
});
it('keeps a loading settings index pending and restores custody after its installed button drops the marker', async () => {
  const replace = vi.fn(), ask = vi.fn();
  let buttons: Array<{ click: () => void }> | null = null;
  const location = { pathname: '/', href: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins`, replace };
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask,
    location, history: { replaceState: replace },
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true, pluginInstalledButtons: () => buttons,
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic' }) }
  });
  vm.runInContext(`${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin;`, context);
  const run = () => (context.run as Function)({ id, appId: null, connectorName: 'Chat On Steroids Core', tools });
  expect(await run()).toBe(false);
  expect(ask).not.toHaveBeenCalled(); // no durable missing-plugin verdict while loading
  buttons = [{ click: () => { location.href = 'https://chatgpt.com/#settings/Plugins/plugin_asdk_app_synthetic'; } }];
  expect(await run()).toBe(true);
  expect(replace).toHaveBeenCalledExactlyOnceWith(undefined, '', `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic`);
  expect(ask).not.toHaveBeenCalled();
});
it('records an already current schema without clicking Refresh and invalidating old chats', async () => {
  const h = workflow({ unchanged: true });
  expect(await h.run()).toBe(true);
  expect(h.click).not.toHaveBeenCalled();
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['current']);
});
it('records an already current schema when the workspace exposes no Refresh control', async () => {
  const h = workflow({ unchanged: true, refreshAvailable: false });
  expect(await h.run()).toBe(true);
  expect(h.click).not.toHaveBeenCalled();
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['current']);
});
it('stops automatic retry when a changed schema has no Refresh control', async () => {
  const h = workflow({ refreshAvailable: false });
  expect(await h.run()).toBe(true);
  expect(h.click).not.toHaveBeenCalled();
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['manual']);
  expect(h.ask.mock.calls[0]?.[0]).toMatchObject({
    appId: 'asdk_app_synthetic',
    connectorName: 'Chat On Steroids Core',
    tools: [{ name: 'read', description: 'Old description.' }]
  });
});
it('opens an enrolled exact App Id directly in marked settings without name discovery', async () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const code = background.slice(background.indexOf('let pluginRefreshFlight = null;'), background.indexOf('async function catalogProbe('));
  const create = vi.fn(async () => ({ id: 9 }));
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    call: async () => ({ ok: true, data: { requests: [{ id, appId: 'asdk_app_synthetic', surface: 'core' }] } }), createChatTab: create,
    chrome: { storage: { session: { get: async () => ({}), set: async () => {} } }, tabs: { query: async () => [] } }
  });
  vm.runInContext(`${code}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await (context.run as Function)([{ surface: 'core' }], true);
  expect(create).toHaveBeenCalledExactlyOnceWith(`https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic`, true);
});
it.each([{ deny: true }, { navigateDuringClaim: true }])('never clicks after denied claim or changed navigation: %j', async options => {
  const h = workflow(options);
  expect(await h.run()).toBe(false);
  expect(h.click).not.toHaveBeenCalled();
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['claim', 'fail']);
});
it.each(['unpinned', 'pinned', 'pinned-during-proof'])('reuses management tabs and respects pinning (%s)', async mode => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const code = background.slice(background.indexOf('let pluginRefreshFlight = null;'), background.indexOf('async function catalogProbe('));
  let requests: object[] = [{ id }];
  const tabs = [{ id: 7, url: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins`, pinned: false }, { id: 8, url: 'https://chatgpt.com/c/user-conversation', pinned: false }];
  const create = vi.fn(async () => ({ id: 9 }));
  const remove = vi.fn();
  const sendMessage = vi.fn(async (): Promise<object> => ({ ok: true }));
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    call: async () => ({ ok: true, data: { requests } }), createChatTab: create,
    chrome: { storage: { session: { get: async () => ({}), set: async () => {} } }, tabs: { query: async () => tabs, get: async (id: number) => tabs.find(tab => tab.id === id), remove, sendMessage } }
  });
  vm.runInContext(`${code}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  const run = () => (context.run as Function)([{ surface: 'core' }], true);
  await Promise.all([run(), run()]);
  expect(create).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  requests = [{ id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' }];
  sendMessage.mockRejectedValueOnce(new Error('old document unavailable'));
  await run();
  expect(create).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  requests = [];
  tabs[0]!.pinned = mode === 'pinned';
  sendMessage.mockImplementation(async () => {
    if (mode === 'pinned-during-proof') tabs[0]!.pinned = true;
    return { safe: true };
  });
  await run();
  if (mode === 'unpinned') expect(remove).toHaveBeenCalledExactlyOnceWith(7);
  else expect(remove).not.toHaveBeenCalled();
});

/**
 * A page this document owns, whose card it cannot read.
 *
 * Measured on 2026-09-11: ChatGPT had replaced the connector settings card, `pluginSnapshot()`
 * refused, and this path returned false without telling anyone. The app's durable row carried
 * no `error` after thirty hours — the one field that would have said what was wrong. Reporting
 * is not terminal (`failPluginRefresh` only records the reason; maintenance may reobserve), so
 * the cost of saying so is nothing and the cost of staying quiet was the whole investigation.
 */
it('reports why a page it owns produced no readable view, instead of returning in silence', async () => {
  const ask = vi.fn(async (_message: { action: string; error?: string }) => ({ data: { ok: true } }));
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask, t: (_key: string, fallback: string) => fallback,
    location: { pathname: '/', href: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic` },
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true, pluginRefreshView: () => null }
  });
  vm.runInContext(`${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin;`, context);
  expect(await (context.run as Function)({ id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools })).toBe(false);
  expect(ask.mock.calls.map(([message]) => message.action)).toEqual(['fail']);
  expect(String(ask.mock.calls[0]?.[0].error)).toMatch(/card|settings/i);
});

// The newer shell redirects `/#settings/Plugins/plugin_<app>` to a real path and keeps our query.
// Measured 2026-09-26: unrecognised there, one request had accumulated five helper tabs.
const pathRouted = `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`;
it('reuses and retires helper tabs on the path-routed settings page too', async () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const code = background.slice(background.indexOf('let pluginRefreshFlight = null;'), background.indexOf('async function catalogProbe('));
  let requests: object[] = [{ id }];
  const tabs = [{ id: 7, url: pathRouted, pinned: false }];
  const create = vi.fn(async () => ({ id: 9 }));
  const remove = vi.fn();
  const sendMessage = vi.fn(async (): Promise<object> => ({ ok: true }));
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    call: async () => ({ ok: true, data: { requests } }), createChatTab: create,
    chrome: { storage: { session: { get: async () => ({}), set: async () => {} } }, tabs: { query: async () => tabs, get: async (id: number) => tabs.find(tab => tab.id === id), remove, sendMessage } }
  });
  vm.runInContext(`${code}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  const run = () => (context.run as Function)([{ surface: 'core' }], true);
  await run();
  expect(create).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'clf-plugin-refresh' }));
  requests = [];
  sendMessage.mockImplementation(async () => ({ safe: true }));
  await run();
  expect(remove).toHaveBeenCalledExactlyOnceWith(7);
});
it.each([
  [`https://chatgpt.com/plugins/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`, true],
  ['https://chatgpt.com/plugins/plugin_asdk_app_synthetic', false],
  [`https://chatgpt.com/plugins?cos-plugin-refresh=${id}`, false]
])('recognises %s as its own helper page: %s', async (url, own) => {
  // English reloads land on /plugins/plugin_<app>; the bare catalog is the user's page, never ours.
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const code = background.slice(background.indexOf('let pluginRefreshFlight = null;'), background.indexOf('async function catalogProbe('));
  const context = vm.createContext({ URL });
  vm.runInContext(`${code}\nglobalThis.marker = pluginRefreshMarker;`, context);
  expect((context.marker as Function)({ url })).toBe(own ? id : null);
});
it('owns the path-routed settings page, so an unreadable card is reported rather than silent', async () => {
  const ask = vi.fn(async (_message: { action: string; error?: string }) => ({ data: { ok: true } }));
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask, t: (_key: string, fallback: string) => fallback,
    location: { pathname: '/settings/plugins-settings/plugin_asdk_app_synthetic', hash: '', href: pathRouted },
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true, pluginRefreshView: () => null }
  });
  vm.runInContext(`${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin;`, context);
  expect(await (context.run as Function)({ id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools })).toBe(false);
  expect(ask.mock.calls.map(([message]) => message.action)).toEqual(['fail']);
});

// Measured 2026-09-27: every refresh on the path-routed page failed with "card could not be read".
it.each([pathRouted, `https://chatgpt.com/plugins/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`])('refreshes on the path-routed page %s', async href => {
  const h = workflow({ href });
  expect(await h.run()).toBe(true);
  expect(h.click).toHaveBeenCalledTimes(1);
  expect(h.ask.mock.calls.map(([message]) => message.action)).toEqual(['claim', 'complete']);
});
it('never refreshes a path-routed page whose route names another app', async () => {
  const h = workflow({ href: pathRouted.replace('asdk_app_synthetic', 'asdk_app_other') });
  expect(await h.run()).toBe(false);
  expect(h.click).not.toHaveBeenCalled();
});
it('continues from the installed list on the path-routed settings page', async () => {
  const listed = `https://chatgpt.com/settings/plugins-settings?cos-plugin-refresh=${id}`;
  const assign = vi.fn(), replace = vi.fn(), ask = vi.fn();
  const location = { pathname: '/settings/plugins-settings', href: listed, assign };
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask, location, history: { replaceState: replace },
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginInstalledButtons: () => [{ click: () => { location.pathname = '/settings/plugins-settings/plugin_asdk_app_synthetic'; location.href = 'https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic'; } }],
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic' }) }
  });
  vm.runInContext(`${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin;`, context);
  expect(await (context.run as Function)({ id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools })).toBe(true);
  expect(assign).toHaveBeenCalledExactlyOnceWith(pathRouted);
  expect(await (context.run as Function)({ id, appId: null, connectorName: 'Chat On Steroids Core', tools })).toBe(true);
  expect(replace).toHaveBeenCalledExactlyOnceWith(undefined, '', pathRouted);
  expect(ask).not.toHaveBeenCalled();
});
it('opens the installed list by its path when the App Id is not known yet', async () => {
  // The old `#settings/Plugins` hash without an app now lands on the home page.
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const code = background.slice(background.indexOf('let pluginRefreshFlight = null;'), background.indexOf('async function catalogProbe('));
  const create = vi.fn(async () => ({ id: 9 }));
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    call: async () => ({ ok: true, data: { requests: [{ id, appId: null, surface: 'core' }] } }), createChatTab: create,
    chrome: { storage: { session: { get: async () => ({}), set: async () => {} } }, tabs: { query: async () => [] } }
  });
  vm.runInContext(`${code}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await (context.run as Function)([{ surface: 'core' }], true);
  expect(create).toHaveBeenCalledExactlyOnceWith(`https://chatgpt.com/settings/plugins-settings?cos-plugin-refresh=${id}`, true);
});
it('refreshes a settled empty Plugins page and passes its tunnel id to the claim', async () => {
  let refreshed = false;
  const click = vi.fn(() => { refreshed = true; });
  const ask = vi.fn(async (_message: Record<string, unknown>) => ({ data: { ok: true } }));
  const href = `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_synthetic?cos-plugin-refresh=${id}`;
  const refresh = { click };
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask, location: { pathname: new URL(href).pathname, href }, ...clock(),
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic', refresh, tunnelId: 'tunnel_synthetic01', settled: true, tools: refreshed ? tools : [] }) } });
  vm.runInContext(`${section}\n${ticking}; globalThis.run = refreshManagedPlugin;`, context);
  expect(await (context.run as Function)({ id, appId: null, connectorName: 'Chat On Steroids Plugins', tools })).toBe(true);
  expect(click).toHaveBeenCalledTimes(1);
  expect(ask.mock.calls.map(([message]) => message.action)).toEqual(['claim', 'complete']);
  expect(ask.mock.calls[0]?.[0]).toMatchObject({ tunnelId: 'tunnel_synthetic01', tools: [] });
});
it('forwards the page tunnel id from the extension to the app, and only a well-formed one', async () => {
  // Measured 2026-09-27: the background relay rebuilt the body without it, so the app never saw
  // the proof and every stale Desktop/Plugins enrollment was refused.
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const handler = background.slice(background.indexOf('  async plugin_refresh('), background.indexOf('  async model_catalog('));
  const call = vi.fn(async (_route: string, _init: { body: string }) => ({ ok: true, data: { ok: true } }));
  const context = vm.createContext({ call, ownsDocument: () => true, maintain: () => {}, pluginRefreshMarker: () => id,
    chrome: { tabs: { get: async () => ({ url: pathRouted }) } } });
  vm.runInContext(`globalThis.handlers = {\n${handler}\n};`, context);
  const send = (tunnelId: unknown) => (context.handlers as any).plugin_refresh({ action: 'claim', id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Desktop', tools, tunnelId }, null, { tab: 7 });
  await send('tunnel_synthetic01');
  expect(JSON.parse(call.mock.calls[0]![1].body)).toMatchObject({ action: 'claim', tunnelId: 'tunnel_synthetic01' });
  await send('tunnel_x"; drop');
  expect(JSON.parse(call.mock.calls[1]![1].body)).not.toHaveProperty('tunnelId');
});

// A stand-in clock: each read of a ticking wait advances it by 250 ms, like the real interval.
function clock() { const now = { t: 1_000_000 }; return { Date: { now: () => now.t }, advance: (ms: number) => { now.t += ms; } }; }
const ticking = 'waitPageView = async (read, current) => { for (let i = 0; i < 60; i++) { if (!current()) return null; const value = await read(); if (value) return value; advance(250); } return null; }';
it('waits for the Refresh control that renders just after the tools, and settles before clicking', async () => {
  // Measured 2026-09-27: tools at t, "Refresh tools" at t+100 ms. A read in the gap reported
  // "no Refresh control", which the app records as manual and never retries.
  const click = vi.fn(); const ask = vi.fn(async (_message: Record<string, unknown>) => ({ data: { ok: true } }));
  let reads = 0; const refresh = { click };
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask, t: (_key: string, fallback: string) => fallback,
    location: { pathname: new URL(pathRouted).pathname, href: pathRouted }, ...clock(),
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginRefreshView: () => ({ appId: 'asdk_app_synthetic', settled: true, refresh: ++reads > 1 ? refresh : null, tools: [{ ...tools[0], description: 'Old' }] }) } });
  vm.runInContext(`${section}\n${ticking}; globalThis.run = refreshManagedPlugin;`, context);
  await (context.run as Function)({ id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools });
  expect(ask.mock.calls.map(([message]) => message.action)[0]).toBe('claim');
  expect(click).toHaveBeenCalledTimes(1);
  expect(reads).toBeGreaterThanOrEqual(1 + 1500 / 250);
});
it('reports a missing Refresh control only after it stayed absent', async () => {
  const ask = vi.fn(async (_message: Record<string, unknown>) => ({ data: { ok: true } }));
  let reads = 0;
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1, ask, t: (_key: string, fallback: string) => fallback,
    location: { pathname: new URL(pathRouted).pathname, href: pathRouted }, ...clock(),
    CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
      pluginRefreshView: () => (++reads, { appId: 'asdk_app_synthetic', settled: true, refresh: null, tools: [{ ...tools[0], description: 'Old' }] }) } });
  vm.runInContext(`${section}\n${ticking}; globalThis.run = refreshManagedPlugin;`, context);
  await (context.run as Function)({ id, appId: 'asdk_app_synthetic', connectorName: 'Chat On Steroids Core', tools });
  expect(ask.mock.calls.map(([message]) => message.action)).toEqual(['manual']);
  expect(reads).toBeGreaterThanOrEqual(1 + 4000 / 250);
});
