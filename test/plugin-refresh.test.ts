import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const wake = vi.hoisted(() => vi.fn());
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: wake }));
import { initDurableStore, resetDurableForTests, readDurable, writeDurableNow } from '../src/main/durable.js';
import { PLUGIN_REFRESH_FAILURE_LIMIT, beginPluginToolCall, authorizedPluginRefreshPublications, consumeRequestedPluginRefreshStartup, hasRequestedPluginRefresh, requestPluginRefreshes, confirmedPluginSchemas, claimPluginRefresh, requireManualPluginRefresh, completePluginRefresh, failPluginRefresh, pendingPluginRefreshes, pluginRefreshPublications, pluginRefreshStatuses, pluginRefreshUnreadable, resetPluginRefreshLedger, publishPluginSurface, rearmPluginRefresh, resetPluginRefreshForTests, setPluginRefreshTunnelGraceForTests, PLUGIN_REFRESH_TUNNEL_GRACE_MS, unpublishPluginSurface } from '../src/main/plugin-refresh.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { APP_VERSION } from '../src/main/version.js';
import { buildServer } from '../src/main/mcp/tools.js';
import { defaultConfig } from '../src/main/config.js';
import * as configOwner from '../src/main/config.js';
import type { PluginToolSchema } from '../src/shared/plugin-refresh.js';
const appId = 'asdk_app_example';
const tools: PluginToolSchema[] = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
let directory = '';
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); wake.mockClear(); resetPluginRefreshForTests(); setPluginRefreshTunnelGraceForTests(0); resetDurableForTests(); directory = await makeTempDir(); initDurableStore(directory); });
afterEach(async () => { resetPluginRefreshForTests(); resetDurableForTests(); vi.restoreAllMocks(); await removeTempDir(directory); vi.useRealTimers(); });
const publish = (version = '1', declarations = tools) => { publishPluginSurface('core', 'Chat On Steroids Core', version, 'Instructions', declarations); vi.advanceTimersByTime(20_000); };
const publishPlugins = (declarations: PluginToolSchema[]) => { publishPluginSurface('plugins', 'Chat On Steroids Plugins', '1', 'Instructions', declarations); vi.advanceTimersByTime(20_000); };
const claim = (request: { id: string }, declarations = [{ ...tools[0]!, description: 'Older declaration' }]) => claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: declarations });
const consumeStartup = consumeRequestedPluginRefreshStartup;
it.each(['claimed', 'manual', 'completed'] as const)('keeps the scoped enrolled App ID in an explicit %s observation without another Refresh claim', async state => {
  publish(); const first = (await pendingPluginRefreshes())[0]!;
  if (state === 'manual') await requireManualPluginRefresh({ ...first, appId, connectorName: first.connectorName,
    tools: [{ ...tools[0]!, description: 'Old' }], error: 'Manual outcome' });
  else {
    expect(await claim(first)).toBe(true);
    if (state === 'completed') expect(await completePluginRefresh({ ...first, appId, tools })).toBe(true);
  }
  await requestPluginRefreshes(APP_VERSION);
  const observation = (await pendingPluginRefreshes(false))[0]!;
  expect(observation).toMatchObject({ appId, observeOnly: true });
  expect(observation.id).not.toBe(first.id);
  expect(await claim(observation)).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ appId,
    attempted: state !== 'manual', manual: state === 'manual' });
});
it.each(['claimed', 'manual', 'completed'] as const)('preserves unscoped legacy %s authority until the same app proves its tunnel and full schema', async state => {
  const original = configOwner.getConfig(), tunnelId = 'tunnel_legacy00000001';
  const get = vi.spyOn(configOwner, 'getConfig').mockReturnValue({ ...original, tunnel: { ...original.tunnel, kind: 'openai', tunnelId } });
  try {
    publish(); const request = (await pendingPluginRefreshes())[0]!;
    if (state === 'manual') await requireManualPluginRefresh({ ...request, appId, connectorName: request.connectorName,
      tools: [{ ...tools[0]!, description: 'Old' }], error: 'Recreate manually' });
    else {
      expect(await claim(request)).toBe(true);
      if (state === 'completed') expect(await completePluginRefresh({ ...request, appId, tools })).toBe(true);
    }
    const legacy = await readDurable('plugin-refresh') as any[];
    delete legacy[0].tunnelKey; delete legacy[0].verifiedRun;
    await writeDurableNow('plugin-refresh', legacy);
    resetPluginRefreshForTests(); publish();
    expect((await pluginRefreshStatuses()).core?.state).toBe('unknown');
    expect(confirmedPluginSchemas()).toEqual({});
    await pendingPluginRefreshes();
    expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ id: request.id, appId,
      attempted: state !== 'manual', manual: state === 'manual' });
    expect((await readDurable('plugin-refresh') as any[])[0].tunnelKey).toBeUndefined();
    expect(await rearmPluginRefresh('core')).toBe(false);
    await requestPluginRefreshes(APP_VERSION);
    const observation = (await pendingPluginRefreshes(false))[0]!;
    expect(observation).toMatchObject({ appId, observeOnly: true });
    expect(await claim(observation)).toBe(false);
    const current = { ...observation, appId, connectorName: observation.connectorName, tools, alreadyCurrent: true };
    expect(await claimPluginRefresh(current, false)).toBe(false);
    expect(await claimPluginRefresh({ ...current, tunnelId, ownsTunnel: () => false }, false)).toBe(false);
    expect(await claimPluginRefresh({ ...current, appId: 'asdk_app_replacement', tunnelId, ownsTunnel: () => true }, false)).toBe(false);
    expect(await claimPluginRefresh({ ...current, tools: [{ ...tools[0]!, description: 'Still stale' }], tunnelId, ownsTunnel: () => true }, false)).toBe(false);
    expect((await pluginRefreshStatuses()).core?.state).toBe('unknown');
    expect(await claimPluginRefresh({ ...current, tunnelId, ownsTunnel: (surface, id) => surface === 'core' && id === tunnelId }, false)).toBe(true);
    expect((await pluginRefreshStatuses()).core?.state).toBe('current');
    expect(await pendingPluginRefreshes(false)).toEqual([]);
    expect(await claim(observation)).toBe(false);
  } finally { get.mockRestore(); }
});
// An unconfirmed legacy click on an older schema starts over instead, and a completed one gets its
// one migration click (both below); a manual receipt stays read-only.
it.each(['manual'] as const)('shows failed legacy %s rechecks without borrowing verification or another refresh click', async state => {
  const original = configOwner.getConfig(), tunnelId = 'tunnel_legacy00000001';
  let tunnel = { ...original.tunnel, kind: 'openai' as const, tunnelId };
  const get = vi.spyOn(configOwner, 'getConfig').mockImplementation(() => ({ ...original, tunnel }));
  try {
    publish(); const first = (await pendingPluginRefreshes())[0]!;
    if (state === 'manual') await requireManualPluginRefresh({ ...first, appId, connectorName: first.connectorName,
      tools: [{ ...tools[0]!, description: 'Old' }], error: 'Manual outcome' });
    else {
      expect(await claim(first)).toBe(true);
    }
    const legacy = await readDurable('plugin-refresh') as any[]; delete legacy[0].tunnelKey;
    await writeDurableNow('plugin-refresh', legacy);
    const declarations = [{ ...tools[0]!, description: 'New contract' }];
    publish('2', declarations);
    await requestPluginRefreshes(APP_VERSION);
    const observation = (await pendingPluginRefreshes(false))[0]!;
    expect(observation).toMatchObject({ appId, observeOnly: true });
    expect(await claim(observation)).toBe(false);
    expect(await failPluginRefresh({ id: observation.id, error: 'Private failed observation' })).toBe(true);
    const saved = await readDurable('plugin-refresh');
    const wakes = wake.mock.calls.length;
    expect((await pluginRefreshStatuses()).core).toMatchObject({ schemaId: observation.schemaId, state: 'failed', failure: 'migration' });
    expect(await readDurable('plugin-refresh')).toEqual(saved); expect(wake.mock.calls.length).toBe(wakes);
    expect(JSON.stringify(await pluginRefreshStatuses())).not.toContain('Private');
    expect(confirmedPluginSchemas()).toEqual({});
    expect(await pendingPluginRefreshes(false)).toEqual([]);
    expect(await rearmPluginRefresh('core')).toBe(false);
    expect((saved as any[])[0]).toMatchObject({ appId, attempted: state !== 'manual', manual: state === 'manual' });
    expect((saved as any[])[0].tunnelKey).toBeUndefined();
    beginPluginToolCall('core')();
    expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'failed', responding: true });
    resetPluginRefreshForTests(); publish('2', declarations);
    expect((await pluginRefreshStatuses()).core?.state).toBe('failed');
    tunnel = { ...tunnel, tunnelId: 'tunnel_other00000001' }; publish('2', declarations);
    expect((await pluginRefreshStatuses()).core?.state).toBe('unknown');
    expect(await failPluginRefresh({ id: observation.id, error: 'Foreign connection failure' })).toBe(false);
    tunnel = { ...tunnel, tunnelId }; publish('2', declarations);
    publish('3', [{ ...tools[0]!, description: 'Later contract' }]);
    expect((await pluginRefreshStatuses()).core?.state).toBe('unknown');
    expect(await failPluginRefresh({ id: observation.id, error: 'Stale declaration failure' })).toBe(false);
    expect(await pendingPluginRefreshes(false)).toEqual([]);
    await requestPluginRefreshes(APP_VERSION);
    expect((await pluginRefreshStatuses()).core?.state).toBe('unknown');
    const retry = (await pendingPluginRefreshes(false))[0]!;
    expect(retry).toMatchObject({ appId, observeOnly: true });
    expect(await claim(retry)).toBe(false);
    expect(await claimPluginRefresh({ ...retry, appId: 'asdk_app_foreign', connectorName: retry.connectorName,
      tools: retry.tools, alreadyCurrent: true, tunnelId, ownsTunnel: () => true }, false)).toBe(false);
    expect(await claimPluginRefresh({ ...retry, appId, connectorName: retry.connectorName,
      tools: retry.tools, alreadyCurrent: true, tunnelId, ownsTunnel: () => true }, false)).toBe(true);
    expect((await pluginRefreshStatuses()).core?.state).toBe('current');
  } finally { get.mockRestore(); }
});
it.each([{ automatic: true, inspectionFailure: false }, { automatic: false, inspectionFailure: false }, { automatic: true, inspectionFailure: true }])('refreshes a completed legacy receipt once after proven app/tunnel migration: %j', async ({ automatic, inspectionFailure }) => {
  const original = configOwner.getConfig(), tunnelId = 'tunnel_legacy00000001';
  const get = vi.spyOn(configOwner, 'getConfig').mockReturnValue({ ...original, tunnel: { ...original.tunnel, kind: 'openai', tunnelId } });
  try {
    publish(); const first = (await pendingPluginRefreshes())[0]!;
    expect(await claim(first)).toBe(true);
    expect(await completePluginRefresh({ ...first, appId, tools })).toBe(true);
    const legacy = await readDurable('plugin-refresh') as any[]; delete legacy[0].tunnelKey;
    await writeDurableNow('plugin-refresh', legacy);
    const next = [{ ...tools[0]!, description: 'New declarations' }]; publish('2', next);
    if (!automatic) await requestPluginRefreshes(APP_VERSION);
    let request = (await pendingPluginRefreshes(automatic))[0]!;
    if (inspectionFailure) {
      expect(await failPluginRefresh({ id: request.id, error: 'Temporary unreadable settings page' })).toBe(true);
      request = (await pendingPluginRefreshes(automatic))[0]!;
    }
    expect(request.observeOnly).not.toBe(true);
    const input = { ...request, appId, connectorName: request.connectorName, tools, tunnelId, ownsTunnel: () => true };
    const saved = await readDurable('plugin-refresh');
    for (const wrong of [{ appId: 'asdk_app_foreign' }, { tunnelId: undefined }, { tunnelId: 'tunnel_other00000001' }, { ownsTunnel: () => false }]) {
      expect(await claimPluginRefresh({ ...input, ...wrong }, automatic)).toBe(false);
    }
    expect(await readDurable('plugin-refresh')).toEqual(saved);
    const actions: string[] = []; let refreshed = false;
    const click = vi.fn(() => {
      const row = JSON.parse(readFileSync(`${directory}/state/plugin-refresh.json`, 'utf8'))[0];
      expect(row).toMatchObject({ tunnelKey: `openai:${original.tunnel.profileId ?? 'default'}:${tunnelId}`, schemaId: request.schemaId, attempted: true, observe: false });
      expect(row.completedSchemaId).not.toBe(request.schemaId);
      actions.push('click'); refreshed = true;
    });
    const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
    const section = source.slice(source.indexOf('  let pluginRefreshBusy = false;'), source.indexOf('  function catalogPageReady('));
    const context = vm.createContext({ URL, alive: true, generating: false, epoch: 1,
      t: (_key: string, fallback: string) => fallback,
      location: { pathname: '/', href: `https://chatgpt.com/?cos-plugin-refresh=${request.id}#settings/Plugins/plugin_${appId}` },
      CLF_DOM: { generating: () => false, pluginManagementIdle: () => true,
        pluginRefreshView: () => ({ appId, tunnelId, refresh: { click }, tools: refreshed ? next : tools }) },
      ask: async (message: any) => {
        actions.push(message.action);
        const ok = message.action === 'claim' ? await claimPluginRefresh({ ...message, ownsTunnel: () => true }, automatic)
          : message.action === 'complete' ? await completePluginRefresh(message)
          : message.action === 'current' ? await claimPluginRefresh({ ...message, alreadyCurrent: true, ownsTunnel: () => true }, automatic) : false;
        return { data: { ok } };
      }
    });
    vm.runInContext(`${section}\nwaitPageView = async (read, current) => current() ? read() : null; globalThis.run = refreshManagedPlugin;`, context);
    expect(await (context.run as Function)(request)).toBe(true);
    expect(actions).toEqual(['claim', 'click', 'complete']);
    expect(click).toHaveBeenCalledTimes(1);
    expect((await pluginRefreshStatuses()).core?.state).toBe('current');
    expect(await claimPluginRefresh(input, automatic)).toBe(false);
    expect(await pendingPluginRefreshes(automatic)).toEqual([]);
  } finally { get.mockRestore(); }
});
// Live 2026-10-15: Core's receipt from an old build had no tunnel key, an old schema and the error
// of a click whose outcome was never seen. Automatic refresh skipped it for every later schema,
// so the "tools changed" reminder stayed although automatic refresh was on.
it.each(['stuck', 'parked', 'error', 'unconfirmed'] as const)('starts a superseded legacy %s receipt over as a fresh enrollment', async outcome => {
  const original = configOwner.getConfig(), tunnelId = 'tunnel_legacy00000001';
  const get = vi.spyOn(configOwner, 'getConfig').mockReturnValue({ ...original, tunnel: { ...original.tunnel, kind: 'openai', tunnelId } });
  try {
    publish(); const first = (await pendingPluginRefreshes())[0]!;
    await claim(first); await completePluginRefresh({ ...first, appId, tools });
    const legacy = await readDurable('plugin-refresh') as any[]; delete legacy[0].tunnelKey; delete legacy[0].verifiedRun;
    if (outcome === 'stuck') Object.assign(legacy[0], { completedSchemaId: null, attempted: true, failures: 1,
      error: 'Refresh was requested, but a changed matching schema was not observed' });
    if (outcome === 'parked') Object.assign(legacy[0], { parked: true, parkedBy: APP_VERSION });
    if (outcome === 'error') Object.assign(legacy[0], { error: 'Uncertain saved outcome', failure: 'confirmation' });
    if (outcome === 'unconfirmed') legacy[0].completedSchemaId = null;
    await writeDurableNow('plugin-refresh', legacy);
    const next = [{ ...tools[0]!, description: 'New declarations' }]; publish('2', next);
    const request = (await pendingPluginRefreshes())[0]!;
    expect(request).toMatchObject({ appId: null, schemaId: pluginRefreshPublications()[0]!.schemaId });
    expect(request.observeOnly).toBeUndefined();
    const input = { ...request, appId, connectorName: request.connectorName, tools, tunnelId, ownsTunnel: () => true };
    expect(await claimPluginRefresh({ ...input, ownsTunnel: () => false })).toBe(false);
    expect(await claimPluginRefresh(input)).toBe(true);
    expect(await completePluginRefresh({ ...request, appId, tools: next })).toBe(true);
    expect((await pluginRefreshStatuses()).core?.state).toBe('current');
    await pendingPluginRefreshes();
    expect(confirmedPluginSchemas().core).toBe(request.schemaId);
  } finally { get.mockRestore(); }
});
it.each(['parked', 'error', 'unconfirmed', 'same-schema'] as const)('keeps a legacy %s receipt read-only on the schema it was about, even with proven app and tunnel', async outcome => {
  const original = configOwner.getConfig(), tunnelId = 'tunnel_legacy00000001';
  const get = vi.spyOn(configOwner, 'getConfig').mockReturnValue({ ...original, tunnel: { ...original.tunnel, kind: 'openai', tunnelId } });
  try {
    publish(); const first = (await pendingPluginRefreshes())[0]!;
    await claim(first); await completePluginRefresh({ ...first, appId, tools });
    const legacy = await readDurable('plugin-refresh') as any[]; delete legacy[0].tunnelKey;
    if (outcome === 'parked') Object.assign(legacy[0], { parked: true, parkedBy: APP_VERSION });
    if (outcome === 'error') legacy[0].error = 'Uncertain saved outcome';
    if (outcome === 'unconfirmed') legacy[0].completedSchemaId = null;
    await writeDurableNow('plugin-refresh', legacy);
    // A newer schema starts over (above); on the schema the receipt was about, it stays read-only.
    publish('2', tools);
    await requestPluginRefreshes(APP_VERSION);
    const request = (await pendingPluginRefreshes(false))[0]!;
    expect(request.observeOnly).toBe(true);
    const input = { ...request, appId, connectorName: request.connectorName, tools: [{ ...tools[0]!, description: 'Stale provider' }], tunnelId, ownsTunnel: () => true };
    expect(await claimPluginRefresh(input, false)).toBe(false);
    expect(await requireManualPluginRefresh({ ...input, error: 'No Refresh control' })).toBe(false);
    expect((await readDurable('plugin-refresh') as any[])[0].tunnelKey).toBeUndefined();
  } finally { get.mockRestore(); }
});
it('records a proven completed legacy migration as manual when the provider has no Refresh control', async () => {
  const original = configOwner.getConfig(), tunnelId = 'tunnel_legacy00000001';
  const get = vi.spyOn(configOwner, 'getConfig').mockReturnValue({ ...original, tunnel: { ...original.tunnel, kind: 'openai', tunnelId } });
  try {
    publish(); const first = (await pendingPluginRefreshes())[0]!;
    await claim(first); await completePluginRefresh({ ...first, appId, tools });
    const legacy = await readDurable('plugin-refresh') as any[]; delete legacy[0].tunnelKey;
    await writeDurableNow('plugin-refresh', legacy);
    publish('2', [{ ...tools[0]!, description: 'New declarations' }]);
    const request = (await pendingPluginRefreshes())[0]!;
    const input = { ...request, appId, connectorName: request.connectorName, tools, tunnelId, ownsTunnel: () => true, error: 'No Refresh control' };
    expect(await requireManualPluginRefresh({ ...input, tunnelId: undefined })).toBe(false);
    expect(await requireManualPluginRefresh(input)).toBe(true);
    expect((await pluginRefreshStatuses()).core?.state).toBe('manual');
    expect(await claimPluginRefresh(input)).toBe(false);
    expect(await pendingPluginRefreshes()).toEqual([]);
  } finally { get.mockRestore(); }
});
it('retries a transient ledger read on the next state push without Reset, replacement or browser work', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request)).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(true);
  initDurableStore(directory); wake.mockClear();
  const file = `${directory}/state/plugin-refresh.json`, before = await fs.readFile(file, 'utf8');
  const read = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('Transient private diagnostics'));
  expect(await pluginRefreshUnreadable()).toBe(true);
  expect(confirmedPluginSchemas()).toEqual({});
  const [status, unreadable] = await Promise.all([pluginRefreshStatuses(), pluginRefreshUnreadable(), hasRequestedPluginRefresh()]);
  expect(status.core?.state).toBe('current'); expect(unreadable).toBe(false);
  expect(confirmedPluginSchemas()).toEqual({ core: request.schemaId });
  expect(read).toHaveBeenCalledTimes(2); read.mockRestore();
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  expect(wake).not.toHaveBeenCalled();
});
it.each(['success', 'failure'] as const)('does not publish an older %s read after Reset commits recovery', async outcome => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  await claim(request); await completePluginRefresh({ ...request, appId, tools });
  initDurableStore(directory);
  const bytes = await fs.readFile(`${directory}/state/plugin-refresh.json`, 'utf8');
  let release!: (value: string) => void, reject!: (reason: Error) => void;
  const held = new Promise<string>((resolve, fail) => { release = resolve; reject = fail; });
  vi.spyOn(fs, 'readFile').mockImplementationOnce(() => held as any).mockRejectedValueOnce(new Error('Reset inspection failed'));
  const beforeReset = pluginRefreshStatuses();
  await resetPluginRefreshLedger();
  if (outcome === 'success') release(bytes); else reject(new Error('Late read failed'));
  expect((await beforeReset).core?.state).toBe('unknown');
  expect(await pluginRefreshUnreadable()).toBe(false);
  expect(confirmedPluginSchemas()).toEqual({});
  expect(await readDurable('plugin-refresh')).toEqual([]);
});
it.each(['manual', 'cloudflared'] as const)('never binds an old Secure Tunnel observation to a current %s publication', async replacement => {
  const original = configOwner.getConfig(), tunnelId = 'tunnel_legacy00000001';
  let kind: 'openai' | 'manual' | 'cloudflared' = 'openai';
  const get = vi.spyOn(configOwner, 'getConfig').mockImplementation(() => ({ ...original, tunnel: { ...original.tunnel, kind, tunnelId } }));
  try {
    publish(); const request = (await pendingPluginRefreshes())[0]!; expect(await claim(request)).toBe(true);
    const legacy = await readDurable('plugin-refresh') as any[]; delete legacy[0].tunnelKey;
    await writeDurableNow('plugin-refresh', legacy);
    kind = replacement; publish();
    const observation = (await pendingPluginRefreshes())[0]!;
    // The old ID can remain configured after switching transport. ID equality alone
    // cannot prove the old app points at this publication's current endpoint.
    expect(await claimPluginRefresh({ ...observation, appId, connectorName: observation.connectorName,
      tools, alreadyCurrent: true, tunnelId, ownsTunnel: () => true })).toBe(false);
    expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ appId, attempted: true });
    expect((await readDurable('plugin-refresh') as any[])[0].tunnelKey).toBeUndefined();
    expect((await pluginRefreshStatuses()).core?.state).toBe('unknown');
  } finally { get.mockRestore(); }
});
it('consumes unpublished explicit startup work once durably without expiring browser intent', async () => {
  await requestPluginRefreshes(APP_VERSION, ['core']);
  expect(await hasRequestedPluginRefresh()).toBe(true);
  expect(await consumeStartup()).toBe(true);
  resetPluginRefreshForTests();
  expect(await hasRequestedPluginRefresh()).toBe(true);
  expect(await consumeStartup()).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ schemaId: '', requestedVersion: APP_VERSION });
  publish(); expect((await pendingPluginRefreshes(false))[0]?.surface).toBe('core');
  expect(await consumeStartup()).toBe(false);
  await requestPluginRefreshes(APP_VERSION);
  expect(await consumeStartup()).toBe(true);
  expect(await consumeStartup()).toBe(false);
});
it('allows one explicit refresh round while automatic refresh stays off and fences later schema edits', async () => {
  publish(); const automatic = (await pendingPluginRefreshes())[0]!;
  expect(await pendingPluginRefreshes(false)).toEqual([]);
  expect(await claimPluginRefresh({ ...automatic, appId, connectorName: 'Chat On Steroids Core', tools }, false)).toBe(false);
  await requestPluginRefreshes(APP_VERSION);
  const explicit = (await pendingPluginRefreshes(false))[0]!;
  expect(explicit.schemaId).toBe(automatic.schemaId); expect(explicit.id).not.toBe(automatic.id);
  publishPluginSurface('desktop', 'Desktop', '1', '', tools);
  expect((await pendingPluginRefreshes(false)).map(row => row.surface)).toEqual(['core']);
  expect((await authorizedPluginRefreshPublications(false)).map(row => row.surface)).toEqual(['core']);
  expect(await claimPluginRefresh({ ...explicit, appId, connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true }, false)).toBe(true);
  expect(await hasRequestedPluginRefresh()).toBe(false);
  publish('1', [{ ...tools[0]!, description: 'Later settings edit' }]);
  expect(await pendingPluginRefreshes(false)).toEqual([]);
  expect(await authorizedPluginRefreshPublications(false)).toEqual([]);
  const later = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...later, appId, connectorName: 'Chat On Steroids Core', tools }, false)).toBe(false);
});
it('keeps both state projections on committed evidence when a write fails', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  await claimPluginRefresh({ ...request, appId, connectorName: request.connectorName, tools, alreadyCurrent: true });
  const confirmation = confirmedPluginSchemas();
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Disk full'));
  try {
    await expect(requestPluginRefreshes(APP_VERSION)).rejects.toThrow('Disk full');
    expect(confirmedPluginSchemas()).toEqual(confirmation);
    expect((await pluginRefreshStatuses()).core?.state).toBe('current');
  } finally { rename.mockRestore(); }
});
it('caches committed ledger reads across state pushes and invalidates only that ledger', async () => {
  publish();
  const read = vi.spyOn(fs, 'readFile');
  try {
    await Promise.all(Array.from({ length: 100 }, () => pluginRefreshStatuses()));
    const reads = () => read.mock.calls.filter(call => String(call[0]).endsWith('plugin-refresh.json')).length;
    expect(reads()).toBe(1);
    await writeDurableNow('other-ledger', {});
    await pluginRefreshStatuses(); expect(reads()).toBe(1);
    await requestPluginRefreshes(APP_VERSION);
    expect((await pluginRefreshStatuses()).core?.state).toBe('pending'); expect(reads()).toBe(1);
    publish('1', [{ ...tools[0]!, description: 'Changed' }]);
    await pluginRefreshStatuses(); expect(reads()).toBe(1);
    await writeDurableNow('plugin-refresh', []);
    expect((await pluginRefreshStatuses()).core?.state).toBe('unknown'); expect(reads()).toBe(2);
  } finally { read.mockRestore(); }
});
it('tracks successful use separately from complete schema verification and fences late calls', async () => {
  publish(); const confirm = beginPluginToolCall('core'); confirm();
  expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'unknown', responding: true });
  publish('1'); expect((await pluginRefreshStatuses()).core?.responding).toBe(true);
  const late = beginPluginToolCall('core');
  publish('1', [{ ...tools[0]!, description: 'Changed' }]); late();
  expect((await pluginRefreshStatuses()).core?.responding).toBeUndefined();
  const disconnected = beginPluginToolCall('core'); unpublishPluginSurface('core'); publish(); disconnected();
  expect((await pluginRefreshStatuses()).core?.responding).toBeUndefined();
});
it('never borrows schema or successful-use proof from another setup tunnel', async () => {
  let tunnelId = 'tunnel_aaaaaaaaaaaaaaaa';
  const original = configOwner.getConfig();
  const get = vi.spyOn(configOwner, 'getConfig').mockImplementation(() => ({ ...original, tunnel: { ...original.tunnel, kind: 'openai', tunnelId } }));
  try {
    publish(); await requestPluginRefreshes(APP_VERSION);
    const request = (await pendingPluginRefreshes(false))[0]!;
    await claimPluginRefresh({ ...request, appId, connectorName: request.connectorName, tools, alreadyCurrent: true }, false);
    expect(confirmedPluginSchemas()).toEqual({ core: request.schemaId });
    const late = beginPluginToolCall('core');
    tunnelId = 'tunnel_bbbbbbbbbbbbbbbb'; late();
    expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'unknown' });
    expect(confirmedPluginSchemas()).toEqual({});
    expect((await pluginRefreshStatuses()).core?.responding).toBeUndefined();
    expect(await pendingPluginRefreshes(false)).toEqual([]);
    await requestPluginRefreshes(APP_VERSION);
    expect(await pendingPluginRefreshes(false)).toEqual([]);
    publish();
    expect((await pendingPluginRefreshes(false))[0]).toMatchObject({ appId: null });
  } finally { get.mockRestore(); }
});

it.each(['malformed', 'null', 'invalid', 'duplicate'] as const)('preserves a %s ledger without creating new refresh authority', async kind => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request)).toBe(true);
  const saved = await readDurable('plugin-refresh') as object[];
  const broken = kind === 'malformed' ? '{"private":"fixture-only"' : kind === 'null' ? 'null'
    : JSON.stringify(kind === 'duplicate' ? [...saved, ...saved] : [{ surface: 'private-invalid' }]);
  const file = `${directory}/state/plugin-refresh.json`;
  await fs.writeFile(file, broken); resetPluginRefreshForTests(); publish();
  await expect(pendingPluginRefreshes()).rejects.toThrow(/^Could not read plugin-refresh state$/);
  await expect(claim(request)).rejects.toThrow(/^Could not read plugin-refresh state$/);
  expect(await fs.readFile(file, 'utf8')).toBe(broken);
  // An independently restored receipt remains consumed; the failed read did not rearm it.
  await writeDurableNow('plugin-refresh', saved);
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect(await claim(request)).toBe(false);
});
it('debounces only changed declarations for twenty seconds and fences stale claims', async () => {
  publish(); const old = (await pendingPluginRefreshes())[0]!;
  const change = (description: string) => publishPluginSurface('core', 'Chat On Steroids Core', '1', 'Instructions', [{ ...tools[0]!, description }]);
  change('A');
  expect(await claim(old)).toBe(false);
  vi.advanceTimersByTime(19_000); expect(await pendingPluginRefreshes()).toEqual([]);
  change('B');
  vi.advanceTimersByTime(19_000); expect(await pendingPluginRefreshes()).toEqual([]);
  // An unchanged settings publication must not prolong the debounce.
  change('B');
  vi.advanceTimersByTime(1_000);
  expect((await pendingPluginRefreshes())[0]?.tools[0]?.description).toBe('B');
  expect(wake).toHaveBeenCalledTimes(2);
});
it('keeps Desktop independent and debounces shape changes across reconnects', async () => {
  publish();
  publishPluginSurface('desktop', 'Desktop', '1', '', tools);
  unpublishPluginSurface('core');
  publishPluginSurface('core', 'Chat On Steroids Core', '1', '', [{ ...tools[0]!, description: 'Reconnected shape' }]);
  expect((await pendingPluginRefreshes()).map(row => row.surface)).toEqual(['desktop']);
  vi.advanceTimersByTime(20_000);
  expect((await pendingPluginRefreshes()).map(row => row.surface).sort()).toEqual(['core', 'desktop']);
});
it('wakes a settled publication restored after its deadline elapsed while disconnected', async () => {
  publish();
  const changed = [{ ...tools[0]!, description: 'Changed declaration' }];
  publishPluginSurface('core', 'Chat On Steroids Core', '1', '', changed);
  unpublishPluginSurface('core');
  vi.advanceTimersByTime(20_000);
  expect(wake).toHaveBeenCalledTimes(1);
  publishPluginSurface('core', 'Chat On Steroids Core', '1', '', changed);
  expect(wake).toHaveBeenCalledTimes(2);
  expect((await pendingPluginRefreshes())[0]?.tools).toEqual(changed);
});
it('persists one explicit retry with a fresh id while retaining the exact pending schema', async () => {
  publishPlugins(tools);
  const first = (await pendingPluginRefreshes())[0]!;
  await failPluginRefresh({ id: first.id, error: 'Helper was closed before discovery' });
  expect(await rearmPluginRefresh('plugins')).toBe(true);
  const next = (await pendingPluginRefreshes())[0]!;
  expect(next.id).not.toBe(first.id);
  expect(next.schemaId).toBe(first.schemaId);
  expect(wake).toHaveBeenCalledTimes(2);
  const proof = { appId, connectorName: 'Chat On Steroids Plugins', tools: [{ ...tools[0]!, description: 'Older declaration' }] };
  expect(await claimPluginRefresh({ ...proof, id: first.id })).toBe(false);
  resetPluginRefreshForTests();
  publishPlugins(tools);
  expect((await pendingPluginRefreshes())[0]?.id).toBe(next.id);
  expect((await readDurable('plugin-refresh') as any[])[0].error).toBeUndefined();
  expect(await claimPluginRefresh({ ...proof, id: next.id })).toBe(true);
  expect(await rearmPluginRefresh('plugins')).toBe(false);
});

it.each(['missing', 'unpublished', 'changed', 'claimed', 'manual', 'completed'])('does not rearm %s refresh work', async state => {
  if (state === 'missing') { expect(await rearmPluginRefresh('plugins')).toBe(false); return; }
  publishPlugins(tools);
  const request = (await pendingPluginRefreshes())[0]!;
  const proof = { ...request, appId, connectorName: 'Chat On Steroids Plugins', tools: [{ ...tools[0]!, description: 'Older declaration' }] };
  if (state === 'unpublished') unpublishPluginSurface('plugins');
  if (state === 'changed') publishPlugins([{ ...tools[0]!, description: 'Changed publication' }]);
  if (state === 'claimed' || state === 'completed') await claimPluginRefresh(proof);
  if (state === 'manual') await requireManualPluginRefresh({ ...proof, error: 'Manual recreation required' });
  if (state === 'completed') await completePluginRefresh({ ...request, appId, tools });
  const before = await readDurable('plugin-refresh');
  const wakes = wake.mock.calls.length;
  expect(await rearmPluginRefresh('plugins')).toBe(false);
  expect(await readDurable('plugin-refresh')).toEqual(before);
  expect(wake).toHaveBeenCalledTimes(wakes);
});

it.each([false, true])('serializes explicit retry with the irreversible claim (retry first=%s)', async retryFirst => {
  publish();
  const first = (await pendingPluginRefreshes())[0]!;
  const results = retryFirst
    ? await Promise.all([rearmPluginRefresh('core'), claim(first)])
    : await Promise.all([claim(first), rearmPluginRefresh('core')]);
  expect(results).toEqual([true, false]);
  const stored = (await readDurable('plugin-refresh') as any[])[0];
  expect(stored.attempted).toBe(!retryFirst);
  expect(stored.id === first.id).toBe(!retryFirst);
});

it('wakes existing browser transport once per changed publication, not unchanged settings', () => {
  publish(); expect(wake).toHaveBeenCalledTimes(1);
  publish(); publish(); expect(wake).toHaveBeenCalledTimes(1);
  publish('2'); expect(wake).toHaveBeenCalledTimes(1);
  publish('2', [{ ...tools[0]!, description: 'Changed declaration' }]); expect(wake).toHaveBeenCalledTimes(2);
});
it('deduplicates unchanged reconnects, durably acknowledges a matching generation and notices an update', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request)).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools, versionId: 'unchanged-provider-version' })).toBe(true);
  resetPluginRefreshForTests(); publish();
  expect(await pendingPluginRefreshes()).toEqual([]);
  publish('2'); expect(await pendingPluginRefreshes()).toEqual([]);
  publish('2', [{ ...tools[0]!, description: 'New contract' }]); const updated = (await pendingPluginRefreshes())[0]!;
  expect(updated.id).not.toBe(request.id); expect(updated.appId).toBe(appId);
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(false);
});
it('reports the schema ChatGPT confirmed per surface, and nothing for a click that never confirmed', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(confirmedPluginSchemas()).toEqual({});
  expect(await claim(request)).toBe(true);
  expect(confirmedPluginSchemas()).toEqual({});
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(true);
  const first = pluginRefreshPublications()[0]!.schemaId;
  expect(confirmedPluginSchemas()).toEqual({ core: first });
  // A newer contract is not confirmed by the older completion.
  publish('2', [{ ...tools[0]!, description: 'New contract' }]); await pendingPluginRefreshes();
  expect(confirmedPluginSchemas()).toEqual({ core: first });
  expect(pluginRefreshPublications()[0]!.schemaId).not.toBe(first);
});
it('requires a recognizable exact tool set for enrollment and refreshes stale definitions', async () => {
  publish(); const first = (await pendingPluginRefreshes())[0]!;
  expect(await claim(first, [])).toBe(false);
  expect(await claim(first, [{ ...tools[0]!, description: 'Older installed declaration' }])).toBe(true);
  const changed = [{ ...tools[0]!, description: 'New declaration' }]; publish('2', changed);
  const next = (await pendingPluginRefreshes())[0]!;
  expect(await claim(next, tools)).toBe(true);
  expect(await completePluginRefresh({ ...next, appId, tools })).toBe(false);
  expect(await completePluginRefresh({ ...next, appId, tools: changed })).toBe(true);
});
it.each([{ count: 118, codeMode: false }, { count: 118, codeMode: true }, { count: 256, codeMode: true }])('enrolls legacy Plugins into $count tools with code mode $codeMode and requires the complete expanded catalog', async ({ count, codeMode }) => {
  const catalog: PluginToolSchema[] = Array.from({ length: count }, (_, i) => ({
    name: `plugin_tool_${i}`, description: `Plugin tool ${i}`, inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  }));
  const legacy = catalog.slice(0, 64);
  if (codeMode) {
    const exec = { name: 'exec', description: 'Compose tools', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } };
    legacy.push(exec); catalog.push(exec);
  }
  publishPlugins(catalog);
  const request = (await pendingPluginRefreshes())[0]!;
  expect(request.surface).toBe('plugins');
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Plugins', tools: legacy })).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools: legacy })).toBe(false);
  expect(await completePluginRefresh({ ...request, appId, tools: catalog })).toBe(true);
});
it('rejects a foreign declaration inside a legacy Plugins subset', async () => {
  const catalog: PluginToolSchema[] = Array.from({ length: 118 }, (_, i) => ({
    name: `plugin_tool_${i}`, description: `Plugin tool ${i}`, inputSchema: { type: 'object', properties: {} },
  }));
  const legacy = catalog.slice(0, 64).map(tool => ({ ...tool }));
  legacy[63] = { ...legacy[63]!, description: 'Changed foreign declaration' };
  publishPlugins(catalog);
  const request = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Plugins', tools: legacy })).toBe(false);
});
it('enrolls already-current tools without granting a refresh click, including after restart', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request, tools)).toBe(false);
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true })).toBe(true);
  expect(await pendingPluginRefreshes()).toEqual([]);
  resetPluginRefreshForTests();
  publishPluginSurface('core', 'Chat On Steroids Core', 'a-new-app-version', 'Different runtime instructions', tools);
  expect(await pendingPluginRefreshes()).toEqual([]);
});
it('does not settle a changed contract as already current', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: [{ ...tools[0]!, description: 'Old' }], alreadyCurrent: true })).toBe(false);
  expect(await claim(request)).toBe(true);
});
it('durably suppresses automatic retries when the provider requires manual recreation', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const installed = [{ ...tools[0]!, description: 'Older installed declaration' }];
  expect(await requireManualPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: installed, error: 'Recreate the custom app manually.' })).toBe(true);
  expect(await pendingPluginRefreshes()).toEqual([]);
  const stored = (await readDurable('plugin-refresh') as any[])[0];
  expect(stored).toMatchObject({ appId, attempted: false, manual: true, error: 'Recreate the custom app manually.' });
  expect(stored.completedSchemaId).not.toBe(stored.schemaId);
  resetPluginRefreshForTests(); publish();
  expect(await pendingPluginRefreshes()).toEqual([]);
  publish('2', [{ ...tools[0]!, description: 'Another local schema' }]);
  expect((await pendingPluginRefreshes())[0]).toMatchObject({ appId });
});
it('keeps an exact app mapping and refuses another installed same-name plugin', async () => {
  publish(); const a = (await pendingPluginRefreshes())[0]!;
  expect(await claim(a)).toBe(true);
  expect(await completePluginRefresh({ ...a, appId: 'asdk_app_other', tools })).toBe(false);
  publish('2', [{ ...tools[0]!, description: 'New contract' }]); const b = (await pendingPluginRefreshes())[0]!;
  expect(b.appId).toBe(appId);
  expect(await claimPluginRefresh({ ...b, appId: 'asdk_app_other', connectorName: 'Chat On Steroids Core', tools })).toBe(false);
});
it('enrolls an older Core subset only with two unchanged full declarations, then requires the enabled tool at completion', async () => {
  const plan = { name: 'update_plan', description: 'Update the displayed plan.', inputSchema: { type: 'object', properties: { plan: { type: 'array', items: { type: 'object' } } } } };
  const finish = { name: 'session_finish', description: 'Finish the turn.', inputSchema: { type: 'object' } };
  const installed = [...tools, plan];
  publish('2', [...installed, finish]);
  const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request, tools)).toBe(false);
  expect(await claim(request, [tools[0]!, { ...plan, description: 'Unrelated plan tool' }])).toBe(false);
  expect(await claim(request, [...installed, { ...finish, name: 'foreign_tool' }])).toBe(false);
  expect(await claim(request, installed)).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools: installed })).toBe(false);
  expect(await completePluginRefresh({ ...request, appId, tools: [...installed, finish] })).toBe(true);
});
it('recognizes retired session only for old Core enrollment with two unchanged current declarations', async () => {
  const plan = { name: 'update_plan', description: 'Update the displayed plan.', inputSchema: { type: 'object' } };
  const session = { name: 'session', description: 'Read recorded history.', inputSchema: { type: 'object' } };
  const current = [...tools, plan];
  publish('2', current);
  const request = (await pendingPluginRefreshes())[0]!;
  expect(request.tools.map(tool => tool.name)).not.toContain('session');
  expect(await claim(request, [...tools, session])).toBe(false);
  expect(await claim(request, [...tools, { ...plan, description: 'Changed declaration' }, session])).toBe(false);
  expect(await claim(request, [...current, session, { ...session, name: 'foreign_tool' }])).toBe(false);
  expect(await claim(request, [...current, session])).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools: [...current, session] })).toBe(false);
  expect(await completePluginRefresh({ ...request, appId, tools: current })).toBe(true);
});
it('keeps pre-claim errors observable and retries the same obligation after restart', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await failPluginRefresh({ id: request.id, error: 'Mapped plugin is not installed in this page' })).toBe(true);
  resetPluginRefreshForTests(); publish();
  expect((await pendingPluginRefreshes())[0]?.id).toBe(request.id);
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0].attempted).toBe(false);
  expect(await claim(request)).toBe(true);
  expect((await readDurable('plugin-refresh') as any[])[0].error).toBeUndefined();
  expect(await pendingPluginRefreshes()).toEqual([]);
});
it('requires readable declarations before claiming even an enrolled exact app', async () => {
  publish(); const first = (await pendingPluginRefreshes())[0]!;
  await claim(first);
  publish('2', [{ ...tools[0]!, description: 'New schema' }]);
  const next = (await pendingPluginRefreshes())[0]!;
  expect(await claimPluginRefresh({ ...next, appId, connectorName: 'Chat On Steroids Core', tools: null })).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0].attempted).toBe(false);
  expect(await claim(next)).toBe(true);
});
it('enrolls an older known Core superset when a user disabled a tool, never a foreign tool', async () => {
  const plan = { name: 'update_plan', description: 'Update the displayed plan.', inputSchema: { type: 'object' } };
  const remaining = [...tools, plan];
  const removed = { name: 'keep_astra_on_forever', description: 'Previously enabled finish hold.', inputSchema: { type: 'object' } };
  publish('2', remaining);
  const request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request, [...remaining, { ...removed, name: 'foreign_tool' }])).toBe(false);
  expect(await claim(request, [...remaining, removed])).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools: [...remaining, removed] })).toBe(false);
  expect(await completePluginRefresh({ ...request, appId, tools: remaining })).toBe(true);
});
it('repairs legacy impossible click receipts only when no concrete app was ever claimed', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const stored = await readDurable('plugin-refresh') as any[];
  stored[0].attempted = true; stored[0].error = 'Exact connector settings or Refresh control could not be verified';
  await writeDurableNow('plugin-refresh', stored);
  expect((await pendingPluginRefreshes())[0]?.id).toBe(request.id);
  await claim(request);
  expect(await pendingPluginRefreshes()).toEqual([]);
});
it('admits one concurrent click and never automatically reclaims it after a crash or failure', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  expect(await Promise.all([claim(request), claim(request)])).toEqual([true, false]);
  resetPluginRefreshForTests(); publish();
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect(await failPluginRefresh({ ...request, error: 'Refresh outcome unavailable' })).toBe(true);
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(true);
});
it('does not let an unpublished connector accept a receipt', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!; await claim(request);
  unpublishPluginSurface('core');
  expect(pluginRefreshPublications()).toEqual([]);
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(false);
});
it('captures actual registered object schemas without executing handlers', async () => {
  const config = defaultConfig(); let observed: PluginToolSchema[] = [];
  const server = buildServer({ roots: [], caps: config.capabilities, readOnly: false }, 'core', (_name, _version, _instructions, definitions) => { observed = definitions; });
  expect(observed.some(tool => tool.name === 'read')).toBe(true);
  expect(observed.every(tool => tool.inputSchema.type === 'object')).toBe(true);
  expect(observed.some(tool => tool.name === 'computer')).toBe(false);
  await server.close();
});
it('parks a schema whose page keeps failing before any claim, until Restart', async () => {
  // Measured 2026-09-26: on the newer ChatGPT shell every pre-claim attempt fails the same way,
  // and an unbounded retry kept reopening the settings page for one request all day.
  publishPlugins(tools);
  let request = (await pendingPluginRefreshes())[0]!;
  for (let attempt = 1; attempt < PLUGIN_REFRESH_FAILURE_LIMIT; attempt++) {
    await failPluginRefresh({ id: request.id, error: 'The connector settings card could not be read' });
    expect(await pendingPluginRefreshes()).toHaveLength(1);
  }
  await failPluginRefresh({ id: request.id, error: 'The connector settings card could not be read' });
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ parked: true, error: 'The connector settings card could not be read' });
  expect(await rearmPluginRefresh('plugins')).toBe(true);
  request = (await pendingPluginRefreshes())[0]!;
  expect(request).toBeDefined();
  expect((await readDurable('plugin-refresh') as any[])[0].failures).toBeUndefined();
});
it('tries a parked schema once more after an app update', async () => {
  // Parked by builds that could not read ChatGPT's new plugin page; only the update can.
  publishPlugins(tools);
  const request = (await pendingPluginRefreshes())[0]!;
  for (let attempt = 0; attempt < PLUGIN_REFRESH_FAILURE_LIMIT; attempt++) await failPluginRefresh({ id: request.id, error: 'The connector settings card could not be read' });
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ parked: true, parkedBy: APP_VERSION });
  expect(await pendingPluginRefreshes()).toEqual([]);
  const rows = await readDurable('plugin-refresh') as any[];
  delete rows[0].parkedBy; // parked by 2.1.15, which did not record its version
  await writeDurableNow('plugin-refresh', rows);
  const retried = await pendingPluginRefreshes();
  expect(retried).toHaveLength(1);
  expect(retried[0]!.id).not.toBe(request.id);
  expect((await readDurable('plugin-refresh') as any[])[0]).not.toHaveProperty('failures');
});
it('enrolls a stale connector by a tunnel this app serves, never by the page alone', async () => {
  // Measured 2026-09-27: Desktop showed 4 stale tools and Plugins none; names never matched.
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const stale = [{ name: 'observe', description: 'Old', inputSchema: { type: 'object' } }];
  const ours = (surface: string, id: string) => surface === 'core' && id === 'tunnel_ours0001';
  const enroll = (extra: object) => claimPluginRefresh({ id: request.id, appId, connectorName: 'Chat On Steroids Core', tools: stale, ...extra });
  expect(await enroll({})).toBe(false);
  expect(await enroll({ tunnelId: 'tunnel_ours0001' })).toBe(false);
  expect(await enroll({ tunnelId: 'tunnel_foreign01', ownsTunnel: ours })).toBe(false);
  expect(await claimPluginRefresh({ id: request.id, appId, connectorName: 'Someone Else', tools: stale, tunnelId: 'tunnel_ours0001', ownsTunnel: ours })).toBe(false);
  expect(await enroll({ tunnelId: 'tunnel_ours0001', ownsTunnel: ours })).toBe(true);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ appId, attempted: true });
  expect(await completePluginRefresh({ id: request.id, appId, tools })).toBe(true);
});
it('hands out a refresh only after the surface tunnel has been live for its grace', async () => {
  // Measured 2026-09-27: a Refresh clicked ~4 s after the Desktop tunnel came up never reached
  // this app, three app starts out of three; ~20 s later, and at runtime, it always did.
  setPluginRefreshTunnelGraceForTests(PLUGIN_REFRESH_TUNNEL_GRACE_MS);
  publishPluginSurface('desktop', 'Chat On Steroids Desktop', '1', '', tools);
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect(wake).not.toHaveBeenCalled();
  vi.advanceTimersByTime(PLUGIN_REFRESH_TUNNEL_GRACE_MS - 1);
  expect(await pendingPluginRefreshes()).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(wake).toHaveBeenCalledTimes(1);
  expect((await pendingPluginRefreshes()).map(row => row.surface)).toEqual(['desktop']);
  // A reconnect of the same declaration starts a new grace, and a runtime change keeps its debounce.
  unpublishPluginSurface('desktop');
  publishPluginSurface('desktop', 'Chat On Steroids Desktop', '1', '', tools);
  expect(await pendingPluginRefreshes()).toEqual([]);
  vi.advanceTimersByTime(PLUGIN_REFRESH_TUNNEL_GRACE_MS);
  expect(await pendingPluginRefreshes()).toHaveLength(1);
  publishPluginSurface('desktop', 'Chat On Steroids Desktop', '1', '', [{ ...tools[0]!, description: 'Changed at runtime' }]);
  vi.advanceTimersByTime(19_000); expect(await pendingPluginRefreshes()).toEqual([]);
  vi.advanceTimersByTime(1_000); expect((await pendingPluginRefreshes())[0]?.tools[0]?.description).toBe('Changed at runtime');
});
// Release round 2026-10-13: after an update the app restarts and its tunnel-client is new. For
// about 128 s OpenAI can still route an existing app's requests to the previous client (#1220).
// A Refresh clicked 30 s after the Mac's Core tunnel connected never reached the app, and ChatGPT
// kept the old tools; the click is spent, so nothing tried again.
it('waits out the previous tunnel client before handing out a refresh after the app starts', async () => {
  setPluginRefreshTunnelGraceForTests(PLUGIN_REFRESH_TUNNEL_GRACE_MS);
  publishPluginSurface('core', 'Chat On Steroids Core', '1', '', tools);
  vi.advanceTimersByTime(130_000);
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect(wake).not.toHaveBeenCalled();
  vi.advanceTimersByTime(PLUGIN_REFRESH_TUNNEL_GRACE_MS - 130_000);
  expect((await pendingPluginRefreshes()).map(row => row.surface)).toEqual(['core']);
});
it('does not take an older completion as current after an unconfirmed click for a newer schema', async () => {
  publish('1', tools); let request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request)).toBe(true);
  expect(await completePluginRefresh({ ...request, appId, tools })).toBe(true);
  const narrower = [{ ...tools[0]!, description: 'Narrower' }];
  publish('2', narrower); request = (await pendingPluginRefreshes())[0]!;
  expect(await claim(request, tools)).toBe(true); // clicked; the app quits before completion
  publish('3', tools);
  const back = await pendingPluginRefreshes();
  expect(back).toHaveLength(1); // ChatGPT may hold the narrower schema, so the original is due again
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ completedSchemaId: null, attempted: false });
});

it('projects unreadable state without repairing legacy receipts or waking work', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const legacy = [{ ...request, appId: null, attempted: true, completedSchemaId: null, parked: true, parkedBy: 'old' }];
  await writeDurableNow('plugin-refresh', legacy); wake.mockClear();
  resetPluginRefreshForTests(); confirmedPluginSchemas();
  expect(await pluginRefreshUnreadable()).toBe(false);
  expect(await readDurable('plugin-refresh')).toEqual(legacy);
  await fs.writeFile(`${directory}/state/plugin-refresh.json`, '{broken');
  initDurableStore(directory); // A reloaded store invalidates the read-only projection cache.
  expect(await pluginRefreshUnreadable()).toBe(true);
  expect(wake).not.toHaveBeenCalled();
});
it.each(['{broken', 'null', '[{}]'])('archives an unreadable ledger only on explicit reset: %s', async broken => {
  publish(); const old = (await pendingPluginRefreshes())[0]!;
  expect(await claim(old)).toBe(true);
  expect(await completePluginRefresh({ ...old, appId, tools })).toBe(true);
  expect(confirmedPluginSchemas().core).toBe(old.schemaId);
  await fs.writeFile(`${directory}/state/plugin-refresh.json`, broken); wake.mockClear();
  initDurableStore(directory);
  expect(await pluginRefreshUnreadable()).toBe(true);
  await Promise.all([resetPluginRefreshLedger(), resetPluginRefreshLedger()]);
  expect(await readDurable('plugin-refresh')).toEqual([]);
  expect(confirmedPluginSchemas()).toEqual({});
  const backups = (await fs.readdir(`${directory}/state`)).filter(name => name.includes('.recovery-'));
  expect(backups).toHaveLength(1);
  expect(await fs.readFile(`${directory}/state/${backups[0]}`, 'utf8')).toBe(broken);
  expect(wake).toHaveBeenCalledTimes(1);
  const fresh = (await pendingPluginRefreshes())[0]!;
  expect(fresh.id).not.toBe(old.id);
  expect(await claim(old)).toBe(false);
  expect(await completePluginRefresh({ ...old, appId, tools })).toBe(false);
  expect(await claim(fresh)).toBe(true);
});
it('leaves healthy and missing ledgers unchanged when a stale Reset arrives', async () => {
  await resetPluginRefreshLedger();
  await expect(fs.stat(`${directory}/state/plugin-refresh.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  publish(); const request = (await pendingPluginRefreshes())[0]!; await claim(request);
  const before = await fs.readFile(`${directory}/state/plugin-refresh.json`, 'utf8'); wake.mockClear();
  await resetPluginRefreshLedger();
  expect(await fs.readFile(`${directory}/state/plugin-refresh.json`, 'utf8')).toBe(before);
  expect(await fs.readdir(`${directory}/state`)).toEqual(['plugin-refresh.json']);
  expect(wake).not.toHaveBeenCalled();
});
it('rechecks cached state only on explicit Reset and clears a stale read failure without replacing healthy bytes', async () => {
  await writeDurableNow('plugin-refresh', []);
  const read = vi.spyOn(fs, 'readFile');
  expect(await pluginRefreshUnreadable()).toBe(false);
  expect(await pluginRefreshUnreadable()).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  const file = `${directory}/state/plugin-refresh.json`;
  await fs.writeFile(file, '{broken');
  await expect(resetPluginRefreshLedger()).resolves.toBeUndefined();
  expect(await pluginRefreshUnreadable()).toBe(false);
  await fs.writeFile(file, '{broken'); initDurableStore(directory);
  expect(await pluginRefreshUnreadable()).toBe(true);
  await fs.writeFile(file, '[]'); wake.mockClear();
  const before = await fs.readdir(`${directory}/state`);
  await resetPluginRefreshLedger();
  expect(await pluginRefreshUnreadable()).toBe(false);
  expect(await fs.readFile(file, 'utf8')).toBe('[]');
  expect(await fs.readdir(`${directory}/state`)).toEqual(before);
  expect(wake).not.toHaveBeenCalled();
});
it.each(['copyFile', 'writeFile', 'rename'] as const)('retains the unreadable ledger when recovery %s fails', async operation => {
  publish(); await pendingPluginRefreshes();
  const file = `${directory}/state/plugin-refresh.json`; await fs.writeFile(file, '{broken'); wake.mockClear();
  const fault = vi.spyOn(fs, operation).mockRejectedValueOnce(new Error('private filesystem diagnostics'));
  await expect(resetPluginRefreshLedger()).rejects.toThrow(/^Could not reset plugin-refresh state$/);
  fault.mockRestore();
  expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  expect(await pluginRefreshUnreadable()).toBe(true);
  await expect(pendingPluginRefreshes()).rejects.toThrow('Could not read plugin-refresh state');
  vi.advanceTimersByTime(10_000);
  expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  expect(wake).not.toHaveBeenCalled();
  await resetPluginRefreshLedger();
  expect(await pluginRefreshUnreadable()).toBe(false);
});
