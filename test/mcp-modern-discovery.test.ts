import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

let directory = '';
let endpoint: McpEndpoint;
let nextId = 1;

function decode(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = [...trimmed.matchAll(/^data:\s*(.+)$/gm)].at(-1)?.[1];
  return data ? JSON.parse(data) : trimmed;
}

async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(endpoint.urls.core, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, contentType: response.headers.get('content-type'), body: decode(await response.text()) };
}

function modern(method: string) {
  return post({
    jsonrpc: '2.0', id: nextId++, method,
    params: { _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: {} } },
  }, { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method });
}

function legacy(method: string, params: Record<string, unknown> = {}) {
  return post({ jsonrpc: '2.0', id: nextId++, method, params });
}

beforeAll(async () => {
  directory = await makeTempDir('clf-modern-discovery-');
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  const capabilities = {
    ...DEFAULT_CAPABILITIES,
    create: true,
    edit: true,
    move: true,
    deleteFile: true,
    command: true,
    saveArtifact: true,
  };
  const config = defaultConfig();
  await saveConfig({
    ...config,
    capabilities,
    readOnly: false,
    sessions: { ...config.sessions, record: false },
    multiAgent: { ...config.multiAgent, enabled: false },
    ui: { ...config.ui, finishTool: false },
  });
  endpoint = await startMcpServer(() => ({
    roots: [{ name: 'fixture', path: directory }],
    caps: capabilities, readOnly: false, sessionTools: false, agentTools: false,
  }));
});

afterAll(async () => {
  await endpoint?.stop();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  if (directory) await removeTempDir(directory);
});

it('serves the installed SDK modern server/discover contract at revision 2026-07-28', async () => {
  const reply = await modern('server/discover');
  expect(reply.status).toBe(200);
  expect(reply.contentType).toContain('application/json');
  expect(reply.body.error).toBeUndefined();
  expect(JSON.stringify(reply.body.result)).toContain(MODERN);
});

it('lists the same nonempty enabled Core catalog for modern discovery and legacy initialize', async () => {
  const initialized = await legacy('initialize', {
    protocolVersion: LEGACY,
    capabilities: {},
    clientInfo: { name: 'compatibility-fixture', version: '1' },
  });
  expect(initialized.status).toBe(200);
  expect(initialized.body.error).toBeUndefined();
  expect(initialized.body.result?.protocolVersion).toBe(LEGACY);

  const [legacyList, modernList] = await Promise.all([legacy('tools/list'), modern('tools/list')]);
  expect(legacyList.status).toBe(200);
  expect(modernList.status).toBe(200);
  expect(legacyList.body.error).toBeUndefined();
  expect(modernList.body.error).toBeUndefined();
  const names = (reply: any): string[] => (reply.body.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
  const legacyNames = names(legacyList), modernNames = names(modernList);
  expect(legacyNames).toHaveLength(7);
  expect(modernNames).toEqual(legacyNames);
  expect(modernNames).toEqual(expect.arrayContaining(['apply_patch', 'exec_command']));
});
