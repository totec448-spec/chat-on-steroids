import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
const wake = vi.hoisted(() => vi.fn());
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: wake }));
import { initDurableStore, resetDurableForTests, readDurable, writeDurableNow } from '../src/main/durable.js';
import { beginPluginToolCall, authorizedPluginRefreshPublications, consumeRequestedPluginRefreshStartup, hasRequestedPluginRefresh, requestPluginRefreshes, confirmedPluginSchemas, claimPluginRefresh, requireManualPluginRefresh, completePluginRefresh, failPluginRefresh, pendingPluginRefreshes, pluginRefreshPublications, pluginRefreshStatuses, publishPluginSurface, resetPluginRefreshForTests, setPluginRefreshTunnelGraceForTests, PLUGIN_REFRESH_TUNNEL_GRACE_MS, unpublishPluginSurface } from '../src/main/plugin-refresh.js';
import { faultGate, makeTempDir, removeTempDir } from './helpers.js';
import { APP_VERSION } from '../src/main/version.js';
import * as configOwner from '../src/main/config.js';
import type { PluginToolSchema } from '../src/shared/plugin-refresh.js';
const appId = 'asdk_app_example';
const tools: PluginToolSchema[] = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
let directory = '';
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); wake.mockClear(); resetPluginRefreshForTests(); setPluginRefreshTunnelGraceForTests(0); resetDurableForTests(); directory = await makeTempDir(); initDurableStore(directory); });
afterEach(async () => { resetPluginRefreshForTests(); resetDurableForTests(); await removeTempDir(directory); vi.useRealTimers(); });
const publish = (version = '1', declarations = tools) => { publishPluginSurface('core', 'Chat On Steroids Core', version, 'Instructions', declarations); vi.advanceTimersByTime(20_000); };
const claim = (request: { id: string }, declarations = [{ ...tools[0]!, description: 'Older declaration' }]) => claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: declarations });
const consumeStartup = consumeRequestedPluginRefreshStartup;
it('keeps a legacy click read-only on its own schema and starts over when the contract changes', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!; expect(await claim(request)).toBe(true);
  const legacy = await readDurable('plugin-refresh') as any[]; delete legacy[0].tunnelKey;
  await writeDurableNow('plugin-refresh', legacy);
  // On the schema it clicked for, the outcome is unknown: observe only, never click again.
  const observation = (await pendingPluginRefreshes())[0]!;
  expect(observation).toMatchObject({ id: request.id, appId, observeOnly: true });
  expect(await claim(observation, tools)).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0].tunnelKey).toBeUndefined();
  // A newer contract needs a refresh whatever that click did; the receipt starts over as an
  // enrollment that must prove the connector on this app's own tunnel.
  publish('2', [{ ...tools[0]!, description: 'New contract' }]);
  const fresh = (await pendingPluginRefreshes())[0]!;
  expect(fresh).toMatchObject({ appId: null, schemaId: pluginRefreshPublications()[0]!.schemaId });
  expect(fresh.id).not.toBe(request.id);
  expect(fresh.observeOnly).toBeUndefined();
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ appId: null, attempted: false, completedSchemaId: null });
});
it('binds a disconnected legacy recheck to its first live schema without migrating its receipt', async () => {
  publish(); const first = (await pendingPluginRefreshes())[0]!; expect(await claim(first)).toBe(true);
  const legacy = await readDurable('plugin-refresh') as any[]; delete legacy[0].tunnelKey;
  await writeDurableNow('plugin-refresh', legacy);
  unpublishPluginSurface('core');
  await requestPluginRefreshes(APP_VERSION, ['core']);
  publish('new', [{ ...tools[0]!, description: 'New contract' }]);
  const observation = (await pendingPluginRefreshes(false))[0]!;
  expect(observation).toMatchObject({ appId, observeOnly: true });
  expect(await failPluginRefresh({ id: observation.id, error: 'Definitions differ' })).toBe(true);
  expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'failed', failure: 'migration' });
  expect((await readDurable('plugin-refresh') as any[])[0].tunnelKey).toBeUndefined();
});
it('retains a future manual-update target for its first startup even days later', async () => {
  await requestPluginRefreshes('99.0.0', ['core']);
  expect(await consumeStartup()).toBe(false);
  vi.advanceTimersByTime(7 * 24 * 60 * 60_000);
  const saved = await readDurable('plugin-refresh') as any[];
  expect(saved[0].requestedVersion).toBe('99.0.0');
  saved[0].requestedVersion = APP_VERSION; saved[0].requestedFromVersion = '1.0.0';
  await writeDurableNow('plugin-refresh', saved); resetPluginRefreshForTests();
  expect(await consumeStartup()).toBe(true);
  resetPluginRefreshForTests(); expect(await consumeStartup()).toBe(false);
  publish(); expect((await pendingPluginRefreshes(false))[0]?.surface).toBe('core');
  expect(await consumeStartup()).toBe(false);
});
it('never consumes startup work for another scope or a finished refresh', async () => {
  const original = configOwner.getConfig(); let tunnelId = 'tunnel_startup00001';
  const get = vi.spyOn(configOwner, 'getConfig').mockImplementation(() => ({ ...original, tunnel: { ...original.tunnel, kind: 'openai', tunnelId } }));
  try {
    publish(); await requestPluginRefreshes(APP_VERSION);
    const request = (await pendingPluginRefreshes(false))[0]!;
    tunnelId = 'tunnel_startup00002'; expect(await consumeStartup()).toBe(false);
    tunnelId = 'tunnel_startup00001';
    expect(await claimPluginRefresh({ ...request, appId, connectorName: request.connectorName, tools, alreadyCurrent: true }, false)).toBe(true);
    expect(await consumeStartup()).toBe(false);
    await writeDurableNow('plugin-refresh', []); await pendingPluginRefreshes(); await requestPluginRefreshes(APP_VERSION);
    const manual = (await pendingPluginRefreshes(false))[0]!;
    expect(await requireManualPluginRefresh({ ...manual, appId, connectorName: manual.connectorName,
      tools: [{ ...tools[0]!, description: 'Old' }], error: 'Recreate manually' })).toBe(true);
    expect(await consumeStartup()).toBe(false);
  } finally { get.mockRestore(); }
});
it('does not grant startup work until its consumption is durable and retries a failed save safely', async () => {
  publish(); const clicked = (await pendingPluginRefreshes())[0]!; expect(await claim(clicked)).toBe(true);
  await requestPluginRefreshes(APP_VERSION, ['core']);
  const before = await readDurable('plugin-refresh');
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Disk full'));
  try { await expect(consumeStartup()).rejects.toThrow('Disk full'); }
  finally { rename.mockRestore(); }
  expect(await readDurable('plugin-refresh')).toEqual(before);
  expect(await consumeStartup()).toBe(true);
  resetPluginRefreshForTests(); expect(await consumeStartup()).toBe(false);
  publish();
  const observation = (await pendingPluginRefreshes(false))[0]!;
  expect(observation.observeOnly).toBe(true);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ appId, attempted: true });
  expect(await claim(observation)).toBe(false);
});
it('reserves one startup connection across concurrent readers and all requested surfaces', async () => {
  await requestPluginRefreshes(APP_VERSION, ['core', 'desktop']);
  const reservations = await Promise.all(Array.from({ length: 5 }, () => consumeStartup()));
  expect(reservations.filter(Boolean)).toHaveLength(1);
  const saved = await readDurable('plugin-refresh') as any[];
  expect(saved).toHaveLength(2);
  expect(saved.every(row => row.requestedStartupVersion === APP_VERSION)).toBe(true);
  resetPluginRefreshForTests(); expect(await consumeStartup()).toBe(false);
});
it('does not consume another scope after authority changes during the savedRows read', async () => {
  const original = configOwner.getConfig();
  const first = { ...original, tunnel: { ...original.tunnel, kind: 'openai' as const, tunnelId: 'tunnel_readscope0001' } };
  const second = { ...original, tunnel: { ...original.tunnel, kind: 'openai' as const, tunnelId: 'tunnel_readscope0002' } };
  let selected = second;
  const get = vi.spyOn(configOwner, 'getConfig').mockImplementation(() => selected);
  const gate = faultGate(), actualRead = fs.readFile;
  let consuming: Promise<boolean> | undefined;
  const read = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const value = await actualRead(...args);
    if (String(args[0]).endsWith('plugin-refresh.json')) await gate.hold();
    return value;
  }) as typeof fs.readFile);
  try {
    await requestPluginRefreshes(APP_VERSION, ['core']);
    resetPluginRefreshForTests();
    selected = first;
    const captured = selected.tunnel, current = () => selected.tunnel === captured;
    consuming = consumeStartup(current);
    await gate.entered;
    selected = second;
    gate.release();
    expect(await consuming).toBe(false);
    read.mockRestore();
    expect((await readDurable('plugin-refresh') as any[])[0].requestedStartupVersion).toBeUndefined();
    // B retains its own unconsumed request; A's abandoned operation cannot spend it.
    expect(await consumeStartup()).toBe(true);
    resetPluginRefreshForTests(); expect(await consumeStartup()).toBe(false);
  } finally { gate.release(); await consuming?.catch(() => undefined); read.mockRestore(); get.mockRestore(); }
});
it('does not read or consume startup state for an already revoked authority', async () => {
  await requestPluginRefreshes(APP_VERSION, ['core']);
  resetPluginRefreshForTests();
  const read = vi.spyOn(fs, 'readFile');
  try {
    expect(await consumeStartup(() => false)).toBe(false);
    expect(read.mock.calls.some(call => String(call[0]).endsWith('plugin-refresh.json'))).toBe(false);
  } finally { read.mockRestore(); }
  expect(await consumeStartup()).toBe(true);
});
it('carries a requested app update through restart and pins only the first schema of that build', async () => {
  publish(); const original = (await pendingPluginRefreshes())[0]!;
  await claimPluginRefresh({ ...original, appId, connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true });
  await requestPluginRefreshes('99.0.0');
  expect(await pendingPluginRefreshes(false)).toEqual([]); expect(await hasRequestedPluginRefresh()).toBe(false);
  const saved = await readDurable('plugin-refresh') as any[];
  // The installer replaced the build. Keep the real persisted rows, with this test process as
  // the new app version; publication comes from the restarted app's new declarations.
  saved[0].requestedVersion = APP_VERSION; saved[0].requestedFromVersion = '1.0.0';
  await writeDurableNow('plugin-refresh', saved);
  resetPluginRefreshForTests(); setPluginRefreshTunnelGraceForTests(0);
  expect(await hasRequestedPluginRefresh()).toBe(true);
  const changed = [{ ...tools[0]!, description: 'New build declaration' }]; publish('2', changed);
  const resumed = (await pendingPluginRefreshes(false))[0]!;
  expect(resumed.schemaId).not.toBe(original.schemaId); expect(resumed.appId).toBe(appId);
  expect(await claimPluginRefresh({ ...resumed, appId, connectorName: 'Chat On Steroids Core', tools }, false)).toBe(true);
  await completePluginRefresh({ ...resumed, appId, tools: changed });
  expect(await hasRequestedPluginRefresh()).toBe(false);
  publish('2', [{ ...tools[0]!, description: 'Another settings edit' }]);
  expect(await pendingPluginRefreshes(false)).toEqual([]); expect(await authorizedPluginRefreshPublications(false)).toEqual([]);
});
it('reobserves manual or already claimed refreshes without authorizing another click', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  await claim(request); await requestPluginRefreshes(APP_VERSION);
  const observation = (await pendingPluginRefreshes(false))[0]!;
  expect(observation).toMatchObject({ appId, observeOnly: true });
  expect(observation.id).not.toBe(request.id);
  expect(await claim(request)).toBe(false);
  expect(await claim(observation)).toBe(false);
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ id: observation.id, attempted: true });
  resetPluginRefreshForTests(); publish(); await writeDurableNow('plugin-refresh', []);
  const manual = (await pendingPluginRefreshes())[0]!;
  await requireManualPluginRefresh({ ...manual, appId, connectorName: 'Chat On Steroids Core', tools: [{ ...tools[0]!, description: 'Old' }], error: 'Recreate in ChatGPT' });
  await requestPluginRefreshes(APP_VERSION);
  expect((await pluginRefreshStatuses()).core?.state).toBe('manual');
  expect(await pendingPluginRefreshes(false)).toEqual([expect.objectContaining({ observeOnly: true })]);
  expect(await claim(manual)).toBe(false);
  const recheck = (await pendingPluginRefreshes(false))[0]!;
  expect(await claim(recheck)).toBe(false);
  expect(await claimPluginRefresh({ ...recheck, appId: 'asdk_app_recreated', connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true }, false)).toBe(true);
  expect((await pluginRefreshStatuses()).core?.state).toBe('current');
});
it('keeps corrupt or ambiguous stored grants from authorizing explicit refresh', async () => {
  publish(); await requestPluginRefreshes(APP_VERSION);
  const current = await readDurable('plugin-refresh') as any[];
  await writeDurableNow('plugin-refresh', [current[0], current[0]]);
  expect(await authorizedPluginRefreshPublications(false)).toEqual([]);
  expect(await hasRequestedPluginRefresh()).toBe(false);
  const partial = structuredClone(current); delete partial[0].requestedFromVersion;
  await writeDurableNow('plugin-refresh', partial);
  expect(await authorizedPluginRefreshPublications(false)).toEqual([]);
  expect(await pendingPluginRefreshes(false)).toEqual([]);
});
it.each(['malformed JSON', 'JSON null'])('does not replace %s with a new refresh grant and recovers on explicit retry', async kind => {
  publish(); const request = (await pendingPluginRefreshes())[0]!; await claim(request);
  const committed = await readDurable('plugin-refresh');
  const file = `${directory}/state/plugin-refresh.json`;
  const broken = kind === 'JSON null' ? 'null' : '{"private-diagnostic":"fixture-only"';
  await fs.writeFile(file, broken);
  resetPluginRefreshForTests(); publish();
  const read = vi.spyOn(fs, 'readFile');
  try {
    const statuses = await Promise.all(Array.from({ length: 100 }, () => pluginRefreshStatuses()));
    expect(statuses.every(status => status.core?.state === 'unknown')).toBe(true);
    expect(read.mock.calls.filter(call => String(call[0]).endsWith('plugin-refresh.json'))).toHaveLength(1);
    expect(confirmedPluginSchemas()).toEqual({});
    expect(await authorizedPluginRefreshPublications(false)).toEqual([]);
    expect(await pendingPluginRefreshes(false)).toEqual([]);
    expect(read.mock.calls.filter(call => String(call[0]).endsWith('plugin-refresh.json')).length).toBeGreaterThan(1);
  } finally { read.mockRestore(); }
  await expect(requestPluginRefreshes(APP_VERSION)).rejects.toThrow('Could not read plugin-refresh state');
  expect(await fs.readFile(file, 'utf8')).toBe(broken);
  expect(await hasRequestedPluginRefresh()).toBe(false);
  await fs.writeFile(file, JSON.stringify(committed));
  await requestPluginRefreshes(APP_VERSION);
  const observation = (await pendingPluginRefreshes(false))[0]!;
  expect(observation.observeOnly).toBe(true);
  expect(await claim(observation)).toBe(false);
});
it('keeps a repaired legacy observation read-only even when it never claimed a click', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const saved = await readDurable('plugin-refresh') as any[];
  saved[0].attempted = true; saved[0].appId = null; saved[0].observe = true;
  await writeDurableNow('plugin-refresh', saved);
  expect(await claim(request)).toBe(false);
  expect(await requireManualPluginRefresh({ ...request, appId, connectorName: request.connectorName, tools: [{ ...tools[0]!, description: 'Old' }], error: 'Recreate' })).toBe(false);
  expect(await claimPluginRefresh({ ...request, appId, connectorName: request.connectorName, tools, alreadyCurrent: true })).toBe(true);
  expect((await pluginRefreshStatuses()).core?.state).toBe('current');
});
it('waits for the configured tunnel publication before projecting or claiming its old proof', async () => {
  let tunnelId = 'tunnel_bbbbbbbbbbbbbbbb';
  const original = configOwner.getConfig();
  const get = vi.spyOn(configOwner, 'getConfig').mockImplementation(() => ({ ...original, tunnel: { ...original.tunnel, kind: 'openai', tunnelId } }));
  try {
    publish(); const request = (await pendingPluginRefreshes())[0]!;
    await claimPluginRefresh({ ...request, appId, connectorName: request.connectorName, tools, alreadyCurrent: true });
    tunnelId = 'tunnel_aaaaaaaaaaaaaaaa'; publish();
    // Config selects B while the endpoint still advertises A. B's old ledger row survives.
    tunnelId = 'tunnel_bbbbbbbbbbbbbbbb';
    expect((await pluginRefreshStatuses()).core?.state).toBe('unknown');
    expect(pluginRefreshPublications()).toEqual([]);
    expect(await authorizedPluginRefreshPublications(true)).toEqual([]);
    await requestPluginRefreshes(APP_VERSION);
    expect(await pendingPluginRefreshes(false)).toEqual([]);
    const saved = await readDurable('plugin-refresh') as any[];
    const late = beginPluginToolCall('core');
    expect(await claimPluginRefresh({ id: saved[0].id, appId, connectorName: request.connectorName, tools, alreadyCurrent: true }, false)).toBe(false);
    expect(await completePluginRefresh({ id: saved[0].id, appId, tools })).toBe(false);
    expect(await failPluginRefresh({ id: saved[0].id, error: 'Old endpoint' })).toBe(false);
    expect(await authorizedPluginRefreshPublications(false)).toEqual([]);
    publish();
    late(); expect((await pluginRefreshStatuses()).core?.responding).toBeUndefined();
    const observation = (await pendingPluginRefreshes(false))[0]!;
    expect(observation.observeOnly).toBe(true);
    expect(await claimPluginRefresh({ ...observation, appId, connectorName: request.connectorName, tools, alreadyCurrent: true }, false)).toBe(true);
    beginPluginToolCall('core')();
    expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'current', responding: true });
  } finally { get.mockRestore(); }
});
it('waits a full tunnel grace when an identical schema is published for another connection', async () => {
  setPluginRefreshTunnelGraceForTests(PLUGIN_REFRESH_TUNNEL_GRACE_MS);
  let tunnelId = 'tunnel_aaaaaaaaaaaaaaaa';
  const original = configOwner.getConfig();
  const get = vi.spyOn(configOwner, 'getConfig').mockImplementation(() => ({ ...original, tunnel: { ...original.tunnel, kind: 'openai', tunnelId } }));
  try {
    publishPluginSurface('core', 'Chat On Steroids Core', '1', '', tools);
    vi.advanceTimersByTime(PLUGIN_REFRESH_TUNNEL_GRACE_MS);
    const previous = (await pendingPluginRefreshes())[0]!;
    tunnelId = 'tunnel_bbbbbbbbbbbbbbbb';
    publishPluginSurface('core', 'Chat On Steroids Core', '1', '', tools);
    expect(await pendingPluginRefreshes()).toEqual([]);
    expect(await claim(previous)).toBe(false);
    vi.advanceTimersByTime(PLUGIN_REFRESH_TUNNEL_GRACE_MS - 1);
    expect(await pendingPluginRefreshes()).toEqual([]);
    vi.advanceTimersByTime(1);
    const next = (await pendingPluginRefreshes())[0]!;
    expect(next.id).not.toBe(previous.id);
    expect(next.schemaId).toBe(previous.schemaId);
    expect(await claim(next)).toBe(true);
  } finally { get.mockRestore(); }
});
it('records the current inspection failure while retaining the older consumed click through restart and recovery', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  await claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true });
  expect((await pluginRefreshStatuses()).core?.state).toBe('current');
  await requestPluginRefreshes(APP_VERSION);
  const observation = (await pendingPluginRefreshes(false))[0]!;
  expect(observation.observeOnly).toBe(true);
  expect(await failPluginRefresh({ id: observation.id, error: 'Exact connector settings could not be verified' })).toBe(true);
  expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'failed', failure: 'inspection' });
  expect((await readDurable('plugin-refresh') as any[])[0]).toMatchObject({ attempted: true, failure: 'inspection' });
  resetPluginRefreshForTests(); setPluginRefreshTunnelGraceForTests(0); publish();
  expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'failed', failure: 'inspection' });
  expect(await hasRequestedPluginRefresh()).toBe(false);
  expect(await pendingPluginRefreshes()).toEqual([]);
  expect(await claim(request)).toBe(false);
  // Another explicit check may confirm a manual repair, but still cannot repeat Refresh.
  await requestPluginRefreshes(APP_VERSION);
  expect(await claim(request)).toBe(false);
  const recheck = (await pendingPluginRefreshes(false))[0]!;
  expect(await claim(recheck)).toBe(false);
  expect(await claimPluginRefresh({ ...recheck, appId, connectorName: 'Chat On Steroids Core', tools, alreadyCurrent: true }, false)).toBe(true);
  expect((await pluginRefreshStatuses()).core?.state).toBe('current');
  expect((await readDurable('plugin-refresh') as any[])[0]).not.toHaveProperty('failure');
});
it('records confirmation failures only after the current round claimed Refresh', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  await claim(request);
  await failPluginRefresh({ id: request.id, error: 'No confirmation' });
  expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'failed', failure: 'confirmation' });
  await requestPluginRefreshes(APP_VERSION);
  const recheck = (await pendingPluginRefreshes(false))[0]!;
  expect(recheck.observeOnly).toBe(true);
  expect(await claim(recheck)).toBe(false);
  await failPluginRefresh({ id: recheck.id, error: 'Could not inspect the connector' });
  expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'failed', failure: 'inspection' });
  expect((await readDurable('plugin-refresh') as any[])[0].attempted).toBe(true);
});
it('returns a safe read error for invalid stored records without replacing their contents', async () => {
  publish(); await requestPluginRefreshes(APP_VERSION);
  const file = `${directory}/state/plugin-refresh.json`;
  const broken = JSON.stringify([{ surface: 'private-invalid-surface', error: 'private-record' }]);
  await fs.writeFile(file, broken); resetPluginRefreshForTests(); publish();
  await expect(requestPluginRefreshes(APP_VERSION)).rejects.toThrow('Could not read plugin-refresh state');
  expect(await fs.readFile(file, 'utf8')).toBe(broken);
  expect(await pendingPluginRefreshes(false)).toEqual([]);
});
it('projects older failed records without creating new authority or rewriting their missing phase', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!; await claim(request);
  await failPluginRefresh({ id: request.id, error: 'No confirmation' });
  const legacy = await readDurable('plugin-refresh') as any[]; delete legacy[0].failure;
  await writeDurableNow('plugin-refresh', legacy);
  const wakes = wake.mock.calls.length;
  expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'failed', failure: 'confirmation' });
  expect(await readDurable('plugin-refresh')).toEqual(legacy);
  expect(wake).toHaveBeenCalledTimes(wakes);
  expect(await claim(request)).toBe(false);
});
it('projects refresh evidence without creating, repairing or rearming browser work', async () => {
  publish();
  expect((await pluginRefreshStatuses()).core?.state).toBe('unknown');
  expect(await readDurable('plugin-refresh')).toBeNull();
  const request = (await pendingPluginRefreshes())[0]!;
  expect((await pluginRefreshStatuses()).core).toEqual({ schemaId: request.schemaId, state: 'pending' });
  await claim(request);
  expect((await pluginRefreshStatuses()).core?.state).toBe('refreshing');
  await completePluginRefresh({ ...request, appId, tools });
  expect((await pluginRefreshStatuses()).core?.state).toBe('current');
  publish('2', [{ ...tools[0]!, description: 'Changed contract' }]);
  expect((await pluginRefreshStatuses()).core?.state).toBe('pending');
  const next = (await pendingPluginRefreshes())[0]!;
  await failPluginRefresh({ id: next.id, error: 'private diagnostic detail' });
  const saved = await readDurable('plugin-refresh') as any[];
  saved[0].parked = true; saved[0].parkedBy = 'older-app';
  await writeDurableNow('plugin-refresh', saved);
  const wakes = wake.mock.calls.length;
  const projected = await pluginRefreshStatuses();
  expect(projected.core?.state).toBe('failed');
  expect(JSON.stringify(projected)).not.toContain('private');
  expect(await readDurable('plugin-refresh')).toEqual(saved);
  expect(wake).toHaveBeenCalledTimes(wakes);
  unpublishPluginSurface('core');
  expect(await pluginRefreshStatuses()).toEqual({});
});

it('keeps manual, corrupt and ambiguous refresh evidence out of the current state', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  await requireManualPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: [{ ...tools[0]!, description: 'Old' }], error: 'Manual action needed' });
  expect((await pluginRefreshStatuses()).core?.state).toBe('manual');
  await writeDurableNow('plugin-refresh', [{ invalid: true }]);
  expect((await pluginRefreshStatuses()).core?.state).toBe('unknown');
});

it('projects the failed refresh phase without exposing private diagnostics or borrowing another schema', async () => {
  publish(); const request = (await pendingPluginRefreshes())[0]!;
  const privateDiagnostic = 'fixture-private-token and asdk_app_private';
  await failPluginRefresh({ id: request.id, error: privateDiagnostic });
  expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'failed', failure: 'inspection' });
  expect(JSON.stringify(await pluginRefreshStatuses())).not.toContain(privateDiagnostic);
  await claim(request);
  await failPluginRefresh({ id: request.id, error: privateDiagnostic });
  expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'failed', failure: 'confirmation' });
  publish('2', [{ ...tools[0]!, description: 'New declaration' }]);
  expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'pending' });
  expect((await pluginRefreshStatuses()).core).not.toHaveProperty('failure');
});
it('keeps target intent without live publications and adopts only their first schema', async () => {
  await requestPluginRefreshes('99.0.0', ['core', 'desktop']);
  const saved = await readDurable('plugin-refresh') as any[];
  expect(saved).toHaveLength(2); expect(saved.every(row => row.schemaId === '')).toBe(true);
  for (const row of saved) { row.requestedVersion = APP_VERSION; row.requestedFromVersion = '1.0.0'; }
  await writeDurableNow('plugin-refresh', saved);
  resetPluginRefreshForTests(); setPluginRefreshTunnelGraceForTests(0);
  expect(await hasRequestedPluginRefresh()).toBe(true);
  publish(); expect((await pendingPluginRefreshes(false)).map(row => row.surface)).toEqual(['core']);
  publishPluginSurface('desktop', 'Desktop', '1', '', tools);
  expect((await pendingPluginRefreshes(false)).map(row => row.surface)).toEqual(['core', 'desktop']);
  publish('1', [{ ...tools[0]!, description: 'Later settings' }]);
  expect((await pendingPluginRefreshes(false)).map(row => row.surface)).toEqual(['desktop']);
});
it('does not reuse full-schema proof from a previous unstable connection run', async () => {
  const original = configOwner.getConfig();
  const get = vi.spyOn(configOwner, 'getConfig').mockImplementation(() => ({ ...original, tunnel: { ...original.tunnel, kind: 'cloudflared' as const } }));
  try {
    publish(); const request = (await pendingPluginRefreshes())[0]!;
    await claimPluginRefresh({ ...request, appId, connectorName: request.connectorName, tools, alreadyCurrent: true });
    expect((await pluginRefreshStatuses()).core?.state).toBe('current');
    const saved = await readDurable('plugin-refresh') as any[];
    saved[0].verifiedRun = 'another-process'; await writeDurableNow('plugin-refresh', saved);
    expect((await pluginRefreshStatuses()).core?.state).toBe('unknown');
    expect(confirmedPluginSchemas()).toEqual({});
    beginPluginToolCall('core')();
    expect((await pluginRefreshStatuses()).core).toMatchObject({ state: 'unknown', responding: true });
  } finally { get.mockRestore(); }
});
