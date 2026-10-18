import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initConfigPath, loadConfig, getConfig, effectiveCapabilities } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, flushSessions } from '../src/main/session/store.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { pluginManager } from '../src/main/plugins/manager.js';
import { getLog } from '../src/main/logger.js';
import { makeTempDir, removeTempDir } from './helpers.js';

/**
 * #1557: ChatGPT enrolls a new connector with MCP revision 2026-07-28 and asks for resources too.
 * In that revision the SDK answers a method no handler serves with HTTP 404 (-32601), and ChatGPT
 * fails the whole enrollment with 424. Every surface answers the catalogs it has none of as empty.
 */
let directory: string, endpoint: McpEndpoint;
beforeAll(async () => {
  directory = await makeTempDir('clf-mcp-catalogs-');
  initConfigPath(directory); await loadConfig(); initDurableStore(directory); initSessionStore(directory);
  await pluginManager.initialize(directory);
  endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
});
afterAll(async () => {
  await endpoint.stop(); await pluginManager.close(); await flushSessions(); await flushDurable(); resetDurableForTests();
  await removeTempDir(directory);
});

const MODERN = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'openai-mcp', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
async function call(surface: 'core' | 'desktop' | 'plugins', method: string, modern: boolean): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (modern) Object.assign(headers, { 'mcp-protocol-version': MODERN, 'mcp-method': method });
  else if (method !== 'initialize') headers['mcp-protocol-version'] = '2025-06-18';
  const params = modern ? { _meta: meta } : method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1' } } : {};
  const response = await fetch(endpoint.urls[surface], { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await response.text();
  const data = text.match(/^data: (.*)$/m)?.[1] ?? text;
  return { status: response.status, body: JSON.parse(data) };
}

describe.each(['core', 'desktop', 'plugins'] as const)('the %s connector', surface => {
  it.each([true, false])('answers the resource and prompt catalogs as empty (modern revision: %s)', async modern => {
    if (!modern) expect((await call(surface, 'initialize', false)).status).toBe(200);
    for (const [method, key] of [['resources/list', 'resources'], ['resources/templates/list', 'resourceTemplates'], ['prompts/list', 'prompts']] as const) {
      const { status, body } = await call(surface, method, modern);
      expect(status, `${surface} ${method}`).toBe(200);
      expect(body.result?.[key], `${surface} ${method}: ${JSON.stringify(body)}`).toEqual([]);
    }
    expect((await call(surface, 'tools/list', modern)).body.result?.tools).toBeInstanceOf(Array);
  });
});

it('names the method of a failed MCP request in the log', async () => {
  const response = await fetch(endpoint.urls.plugins, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MODERN, 'mcp-method': 'ping' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping', params: { _meta: meta } }) });
  await response.text();
  expect(response.status).toBeGreaterThanOrEqual(400);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(getLog().map(row => row.message).find(message => message.includes('mcp/plugins → ' + response.status))).toContain('(method ping)');
});
