import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { initConfigPath, loadConfig, getConfig, updateConfig, effectiveCapabilities } from '../src/main/config.js';
import { initSessionStore, listSessions, readEvents } from '../src/main/session/store.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const plugin = vi.hoisted(() => ({
  enabled: true,
  declaration: {
    name: 'inspect_scene', description: 'Read a scene',
    inputSchema: { type: 'object', properties: { name: { $ref: '#/$defs/label' } }, $defs: { label: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { example: 'preserved' }
  },
  call: vi.fn(async (_name?: string, _args?: unknown, _onOutcome?: (outcome: 'tool_rejected' | 'tool_execution_error') => void) => ({ content: [{ type: 'text', text: 'scene' }, { type: 'resource_link', uri: 'https://example.com/scene', name: 'scene' }], structuredContent: { count: 2 }, _meta: { upstream: true } })),
  redact: (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll('credential-fixture', '[redacted]'))
}));
vi.mock('../src/main/plugins/manager.js', () => ({ pluginManager: {
  tools: () => plugin.enabled ? [plugin.declaration] : [],
  call: async (...args: unknown[]) => plugin.enabled ? plugin.call(...args as []) : { isError: true, content: [{ type: 'text', text: 'PLUGIN_DISABLED' }] },
  redact: plugin.redact,
  redactResult: plugin.redact
} }));

let directory: string;
let endpoint: McpEndpoint;
let sequence = 0;
async function rpc(surface: 'plugins' | 'core' | 'desktop', method: string, params = {}): Promise<any> {
  const response = await fetch(endpoint.urls[surface], { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) });
  const raw = await response.text();
  return JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}
beforeAll(async () => {
  directory = await makeTempDir('clf-plugins-surface-');
  initConfigPath(directory); await loadConfig(); initDurableStore(directory); initSessionStore(directory);
  await updateConfig(config => ({ ...config, multiAgent: { ...config.multiAgent, enabled: false } }));
  endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
});
beforeEach(async () => { plugin.enabled = true; plugin.call.mockClear(); await updateConfig(config => ({ ...config, readOnly: false })); });
afterAll(async () => { await endpoint?.stop(); await flushRecorder(); resetDurableForTests(); await removeTempDir(directory); });

it('publishes exact external JSON schemas only on the separately tokenized Plugins surface', async () => {
  expect(new Set(Object.values(endpoint.urls)).size).toBe(3);
  expect((await rpc('plugins', 'tools/list')).result.tools).toEqual([plugin.declaration]);
  for (const surface of ['core', 'desktop'] as const) {
    expect((await rpc(surface, 'tools/list')).result.tools.some((tool: { name: string }) => tool.name === plugin.declaration.name)).toBe(false);
    expect((await rpc(surface, 'tools/call', { name: plugin.declaration.name, arguments: { name: 'scene' } })).error).toBeDefined();
  }
  expect(plugin.call).not.toHaveBeenCalled();
});
it('preserves structured results, resource blocks and metadata through the shared dispatcher and recorder', async () => {
  const response = await rpc('plugins', 'tools/call', { name: plugin.declaration.name, arguments: { name: 'credential-fixture' } });
  expect(response.result).toMatchObject({ structuredContent: { count: 2 }, _meta: { upstream: true } });
  expect(response.result.content).toContainEqual({ type: 'resource_link', uri: 'https://example.com/scene', name: 'scene' });
  await flushRecorder();
  const sessions = await listSessions();
  const events = (await Promise.all(sessions.map(session => readEvents(session.id)))).flat();
  const call = events.find(event => event.kind === 'tool_call' && event.call.tool === plugin.declaration.name);
  expect(call?.kind === 'tool_call' ? call.call.result.text : '').toContain('structuredContent');
  expect(JSON.stringify(events)).not.toContain('credential-fixture');
});
it('rejects stale calls after disabling and fails closed in read-only mode regardless of upstream annotations', async () => {
  plugin.enabled = false;
  expect((await rpc('plugins', 'tools/list')).result.tools).toEqual([]);
  expect((await rpc('plugins', 'tools/call', { name: plugin.declaration.name })).result.isError).toBe(true);
  plugin.enabled = true;
  await updateConfig(config => ({ ...config, readOnly: true }));
  expect((await rpc('plugins', 'tools/call', { name: plugin.declaration.name })).result.isError).toBe(true);
  expect(plugin.call).not.toHaveBeenCalled();
});

it('records an upstream error as failed with authored detail while preserving its exact protocol result', async () => {
  plugin.call.mockImplementationOnce(async (_name, _args, onOutcome) => {
    onOutcome?.('tool_execution_error');
    return { isError: true, content: [{ type: 'text', text: 'Expected synthetic fixture error.' },
      { type: 'resource_link', uri: 'https://example.com/scene', name: 'scene' }], structuredContent: { count: 0 }, _meta: { upstream: true } };
  });
  const response = await rpc('plugins', 'tools/call', { name: plugin.declaration.name, arguments: { name: 'intentional tool failure' } });
  expect(response.result).toMatchObject({ isError: true, structuredContent: { count: 0 }, _meta: { upstream: true } });
  expect(response.result.content[0]).toEqual({ type: 'text', text: 'Expected synthetic fixture error.' });
  await flushRecorder();
  const events = (await Promise.all((await listSessions()).map(session => readEvents(session.id)))).flat();
  const event = events.find(event => event.kind === 'tool_call' && event.call.outcome === 'tool_execution_error');
  if (event?.kind !== 'tool_call') throw new Error('Expected recorded upstream failure');
  expect(event.call.summary).toMatchObject({ title: `Tool ${plugin.declaration.name} failed`, detail: 'Expected synthetic fixture error.', metric: '✕ failed', tone: 'warn' });
  expect(event.call.result.text).toContain('structuredContent');
  expect(event.call.result.text).toContain('Expected synthetic fixture error.');
  expect(event.call.summary.title).not.toContain('Refused');
  expect((await listSessions()).every(session => session.toolInternalErrors === 0)).toBe(true);
});
