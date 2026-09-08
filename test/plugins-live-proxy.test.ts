import { expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { initConfigPath, loadConfig, getConfig, updateConfig, effectiveCapabilities } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, createSession, readEvents, flushSessions } from '../src/main/session/store.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { pluginManager } from '../src/main/plugins/manager.js';
import { makeTempDir, removeTempDir } from './helpers.js';

/** Opt-in network acceptance: actual npm server, actual SDK client and actual CoS HTTP proxy. */
it.runIf(process.env.COS_PLUGIN_LIVE_TEST === '1')('routes upstream Memory through Plugins HTTP, records exact ownership and refuses a cached disabled call', async () => {
  const directory = await makeTempDir('clf-live-plugin-proxy-');
  let endpoint: McpEndpoint | undefined;
  let client: Client | undefined;
  try {
    initConfigPath(directory); await loadConfig(); initDurableStore(directory); initSessionStore(directory);
    await updateConfig(config => ({ ...config, readOnly: false, multiAgent: { ...config.multiAgent, enabled: false } }));
    await pluginManager.initialize(directory);
    const installed = (await pluginManager.install({ catalogId: 'memory' })).plugins[0]!;
    expect(installed.status, installed.error).toBe('ready');
    endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
    const conversationId = '11111111-2222-4333-8444-555555555555';
    const session = await createSession({ title: 'Plugins network acceptance fixture', conversationId });
    const requestId = 'wfr_plugins_live_proxy_fixture';
    const name = installed.tools.find(tool => tool.name === 'create_entities')!.exposedName;
    observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: 'fixture-message', tool: name, observedAt: Date.now() });
    client = new Client({ name: 'CoS live acceptance', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.urls.plugins), { requestInit: { headers: { 'x-request-id': requestId } } }));
    const tools = (await client.listTools()).tools;
    expect(tools.some(tool => tool.name === name)).toBe(true);
    const mutation = await client.callTool({ name, arguments: { entities: [{ name: 'CoS proxy acceptance', entityType: 'test', observations: ['Local disposable fixture'] }] } });
    expect(mutation.isError).not.toBe(true);
    const read = installed.tools.find(tool => tool.name === 'read_graph')!.exposedName;
    expect(JSON.stringify(await client.callTool({ name: read, arguments: {} }))).toContain('CoS proxy acceptance');
    await pluginManager.setToolEnabled(installed.id, 'create_entities', false);
    expect((await client.callTool({ name, arguments: { entities: [] } })).isError).toBe(true);
    await flushRecorder();
    const calls = (await readEvents(session.id)).filter(event => event.kind === 'tool_call');
    expect(calls.length).toBe(3);
    expect(calls.every(event => event.kind === 'tool_call' && event.call.attributionMethod === 'request_id')).toBe(true);
    expect(JSON.stringify(calls)).toContain('CoS proxy acceptance');
  } finally {
    await client?.close();
    await endpoint?.stop();
    await pluginManager.close();
    await flushRecorder(); await flushSessions(); await flushDurable(); resetDurableForTests();
    await removeTempDir(directory);
  }
}, 180_000);
