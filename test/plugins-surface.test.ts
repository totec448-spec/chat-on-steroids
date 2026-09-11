import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { createSession } from '../src/main/session/store.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { initConfigPath, loadConfig, getConfig, updateConfig, effectiveCapabilities } from '../src/main/config.js';
import { initSessionStore, listSessions, readEvents } from '../src/main/session/store.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import * as recorder from '../src/main/session/recorder.js';
import * as input from '../src/main/session/input.js';
import * as agents from '../src/main/agents.js';
import * as ownership from '../src/main/codex/ownership.js';
import * as bridge from '../src/main/bridge.js';

const plugin = vi.hoisted(() => ({
  enabled: true,
  declaration: {
    name: 'inspect_scene', description: 'Read a scene',
    inputSchema: { type: 'object', properties: { name: { $ref: '#/$defs/label' } }, $defs: { label: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    _meta: { example: 'preserved' }
  },
  call: vi.fn(async (_name?: string, _args?: unknown, _onOutcome?: (outcome: 'tool_rejected' | 'tool_execution_error') => void): Promise<CallToolResult> => ({ content: [{ type: 'text', text: 'scene' }, { type: 'resource_link', uri: 'https://example.com/scene', name: 'scene' }], structuredContent: { count: 2 }, _meta: { upstream: true } })),
  redact: (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll('credential-fixture', '[redacted]').replaceAll('UklGR', '[redacted]')),
  redactResult: vi.fn((value: CallToolResult) => value)
}));
vi.mock('../src/main/plugins/manager.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/plugins/manager.js')>();
  const redactor = new actual.PluginManager();
  redactor.redact = plugin.redact;
  plugin.redactResult.mockImplementation(result => redactor.redactResult(result));
  return { ...actual, pluginManager: {
    tools: () => plugin.enabled ? [plugin.declaration] : [],
    call: async (...args: unknown[]) => plugin.redactResult(plugin.enabled ? await plugin.call(...args as []) : { isError: true, content: [{ type: 'text', text: 'PLUGIN_DISABLED' }] }),
    redact: plugin.redact,
    redactResult: plugin.redactResult
  } };
});

let directory: string;
let endpoint: McpEndpoint;
let sequence = 0;
async function rpc(surface: 'plugins' | 'core' | 'desktop', method: string, params = {}, requestId?: string): Promise<any> {
  const response = await fetch(endpoint.urls[surface], { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(requestId ? { 'x-request-id': requestId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) });
  const raw = await response.text();
  return JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}
beforeAll(async () => {
  directory = await makeTempDir('clf-plugins-surface-');
  initConfigPath(directory); await loadConfig(); initDurableStore(directory); initSessionStore(directory);
  await updateConfig(config => ({ ...config, multiAgent: { ...config.multiAgent, enabled: false } }));
  endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
});
beforeEach(async () => { plugin.enabled = true; plugin.call.mockClear(); plugin.redactResult.mockClear(); await updateConfig(config => ({ ...config, readOnly: false })); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await endpoint?.stop(); await flushRecorder(); resetDurableForTests(); await removeTempDir(directory); });

it('publishes exact external JSON schemas only on the separately tokenized Plugins surface', async () => {
  expect(new Set(Object.values(endpoint.urls)).size).toBe(3);
  expect((await rpc('plugins', 'tools/list')).result.tools).toEqual([plugin.declaration, expect.objectContaining({ name: 'exec' })]);
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

it('redacts only delivery additions after the plugin boundary and records the exact delivered protocol result', async () => {
  const data = (await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).webp().toBuffer()).toString('base64');
  expect(data.startsWith('UklGR')).toBe(true);
  plugin.call.mockResolvedValueOnce({
    content: [
      { type: 'text', text: 'credential-fixture UklGR base result' },
      { type: 'image', mimeType: 'image/webp', data },
      { type: 'resource', resource: { uri: 'https://example.com/credential-fixture', mimeType: 'application/octet-stream', blob: data } }
    ],
    structuredContent: { count: 2, detail: 'credential-fixture' },
    _meta: { detail: 'credential-fixture' }
  });
  vi.spyOn(agents, 'offerMessagesForConversation').mockReturnValue({ agentId: 'prime', messages: [{
    id: 'message-fixture', from: 'worker-1', to: 'prime', time: Date.now(), text: 'credential-fixture inbox',
    offeredAt: Date.now(), offers: 1, offeredOnFinish: false, offeredViaRevival: false, ackedAt: null
  }] });
  vi.spyOn(ownership, 'backgroundExecRecoveryNotices').mockReturnValue(['credential-fixture recovery']);
  vi.spyOn(bridge, 'unattributedRepairEta').mockReturnValue(10);
  vi.spyOn(input, 'offerToolInput').mockResolvedValue({ messages: [{ text: 'credential-fixture user input', images: [{ name: 'fixture.webp', dataUrl: `data:image/webp;base64,${data}` }] }], reminder: 'credential-fixture batch reminder' });
  const record = vi.spyOn(recorder, 'recordToolCall').mockResolvedValue(null);
  const conversationId = randomUUID(), requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  const session = await createSession({ conversationId, title: 'Exact delivery redaction' });
  observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: randomUUID(), tool: plugin.declaration.name, observedAt: Date.now() });
  const response = await rpc('plugins', 'tools/call', { name: plugin.declaration.name, arguments: { name: 'credential-fixture' } }, requestId);
  const saved = record.mock.calls[0]![0];
  expect(response.result).toEqual(saved.protocolResult);
  expect(saved.args).toEqual({ name: '[redacted]' });
  expect(plugin.redactResult).toHaveBeenCalledTimes(2);
  const base = plugin.redactResult.mock.results[0]!.value as CallToolResult;
  const final = saved.protocolResult as CallToolResult;
  expect(final.structuredContent).toBe(base.structuredContent);
  expect(final._meta).toBe(base._meta);
  for (let i = 0; i < base.content.length; i++) expect(final.content[i]).toBe(base.content[i]);
  const additions = plugin.redactResult.mock.calls[1]![0];
  expect(additions.structuredContent).toBeUndefined();
  expect(additions.content).toHaveLength(5); // inbox, recovery, input text, image and batch reminder
  const authored = final.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  expect(authored).toContain('[redacted] inbox');
  expect(authored).toContain('[redacted] recovery');
  expect(authored).toContain('[redacted] user input');
  expect(authored).toContain('[redacted] batch reminder');
  expect(authored).not.toContain('credential-fixture');
  expect(authored).not.toContain('UklGR');
  expect(final.content.filter(block => block.type === 'image').map(block => block.data)).toEqual([data, data]);
  expect(final.content[2]).toEqual({ type: 'resource', resource: { uri: 'https://example.com/[redacted]', mimeType: 'application/octet-stream', blob: data } });
});

it('redacts dispatcher refusals even when the external plugin handler never ran', async () => {
  vi.spyOn(agents, 'dormantWorkerNotice').mockReturnValue('credential-fixture refused');
  const record = vi.spyOn(recorder, 'recordToolCall').mockResolvedValue(null);
  const response = await rpc('plugins', 'tools/call', { name: plugin.declaration.name, arguments: { name: 'safe' } });
  expect(plugin.call).not.toHaveBeenCalled();
  expect(response.result.isError).toBe(true);
  expect(response.result.content[0].text).toBe('[redacted] refused');
  expect(response.result).toEqual(record.mock.calls[0]![0].protocolResult);
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

it('composes plugin results, redacts constructed output and checks live admission for every child', async () => {
  const conversationId = randomUUID(), requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  const session = await createSession({ conversationId, title: 'Plugin code mode' });
  observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: randomUUID(), tool: 'exec', observedAt: Date.now() });
  const run = (code: string) => rpc('plugins', 'tools/call', { name: 'exec', arguments: { code } }, requestId);
  const result = await run('const r=await tools.inspect_scene({name:"scene"}); text(r.structuredContent.count); text("credential-"+"fixture"); text(typeof tools.read);');
  expect(result.result.content).toEqual([{ type: 'text', text: '2' }, { type: 'text', text: '[redacted]' }, { type: 'text', text: 'undefined' }]);
  expect(JSON.stringify(result)).not.toContain('https://example.com/scene');
  plugin.call.mockImplementationOnce(async () => {
    await updateConfig(config => ({ ...config, readOnly: true }));
    return { content: [{ type: 'text', text: 'first' }] };
  });
  const denied = await run('await tools.inspect_scene({name:"first"}); text(await tools.inspect_scene({name:"second"}));');
  expect(denied.result.content[0].text).toContain('TOOL_DISABLED');
  expect(plugin.call).toHaveBeenCalledTimes(2);
  await flushRecorder();
  const events = await readEvents(session.id);
  expect(events.filter(event => event.kind === 'tool_call' && event.call.tool === 'exec')).toHaveLength(2);
  expect(JSON.stringify(events)).not.toContain('credential-fixture');
});

it('preserves an upstream exec tool instead of replacing its individual contract', async () => {
  const name = plugin.declaration.name;
  try {
    plugin.declaration.name = 'exec';
    const listed = await rpc('plugins', 'tools/list');
    expect(listed.result.tools).toEqual([plugin.declaration]);
    const result = await rpc('plugins', 'tools/call', { name: 'exec', arguments: { name: 'scene' } });
    expect(result.result.structuredContent).toEqual({ count: 2 });
    expect(plugin.call).toHaveBeenCalledWith('exec', { name: 'scene' }, expect.any(Function));
  } finally { plugin.declaration.name = name; }
});
