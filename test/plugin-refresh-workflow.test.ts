import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('  let pluginRefreshBusy = false;'), source.indexOf('  function catalogPageReady('));
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const tools = [{ name: 'read', description: 'Read current.', inputSchema: { type: 'object' } }];
function workflow(options: { unchanged?: boolean; deny?: boolean; navigateDuringClaim?: boolean; refreshAvailable?: boolean } = {}) {
  let refreshed = false;
  const click = vi.fn(() => { refreshed = true; });
  const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1,
    location: { pathname: '/', href: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic` },
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
  const context = vm.createContext({ URL, setTimeout, clearTimeout, pageViewChecks: new Set(), MutationObserver: dom.window.MutationObserver,
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
it('reuses one owned management tab and preserves unreachable helpers and user chats', async () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const code = background.slice(background.indexOf('let pluginRefreshFlight = null;'), background.indexOf('async function catalogProbe('));
  let requests: object[] = [{ id }];
  const tabs = [{ id: 7, url: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins` }, { id: 8, url: 'https://chatgpt.com/c/user-conversation' }];
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
  sendMessage.mockResolvedValue({ safe: true });
  await run();
  expect(remove).toHaveBeenCalledExactlyOnceWith(7);
});
