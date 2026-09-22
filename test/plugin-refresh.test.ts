import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const wake = vi.hoisted(() => vi.fn());
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: wake }));
import { initDurableStore, resetDurableForTests, readDurable, writeDurableNow } from '../src/main/durable.js';
import { claimPluginRefresh, requireManualPluginRefresh, completePluginRefresh, failPluginRefresh, pendingPluginRefreshes, pluginRefreshPublications, publishPluginSurface, rearmPluginRefresh, resetPluginRefreshForTests, unpublishPluginSurface } from '../src/main/plugin-refresh.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { buildServer } from '../src/main/mcp/tools.js';
import { defaultConfig } from '../src/main/config.js';
import type { PluginToolSchema } from '../src/shared/plugin-refresh.js';
const appId = 'asdk_app_example';
const tools: PluginToolSchema[] = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
let directory = '';
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); wake.mockClear(); resetPluginRefreshForTests(); resetDurableForTests(); directory = await makeTempDir(); initDurableStore(directory); });
afterEach(async () => { resetPluginRefreshForTests(); resetDurableForTests(); await removeTempDir(directory); vi.useRealTimers(); });
const publish = (version = '1', declarations = tools) => { publishPluginSurface('core', 'Chat On Steroids Core', version, 'Instructions', declarations); vi.advanceTimersByTime(20_000); };
const publishPlugins = (declarations: PluginToolSchema[]) => { publishPluginSurface('plugins', 'Chat On Steroids Plugins', '1', 'Instructions', declarations); vi.advanceTimersByTime(20_000); };
const claim = (request: { id: string }, declarations = [{ ...tools[0]!, description: 'Older declaration' }]) => claimPluginRefresh({ ...request, appId, connectorName: 'Chat On Steroids Core', tools: declarations });
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
