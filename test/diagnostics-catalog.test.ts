import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/main/connection.js', () => ({
  getStatus: () => ({ state: 'disconnected', localUrl: null, lastRequestAt: null, lastToolCallAt: null, surfaces: [] }),
  isServerRunning: () => false,
  tunnelHealthBase: () => null
}));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({}), effectiveCapabilities: () => ({}) }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/mcp/server.js', () => ({ lastRequestAt: () => null, lastCatalogResponse: () => null, selfTestHeaders: () => ({ 'x-local-self-test': 'fixture' }) }));
vi.mock('../src/main/mcp/tools.js', () => ({ lastToolCallAt: () => null }));
vi.mock('../src/main/tunnel/health.js', () => ({
  ago: () => 'now', POLL_FRESH_MS: 95_000, readClientStatus: vi.fn(), readPollHealth: vi.fn()
}));
vi.mock('../src/main/mcp/surfaces.js', () => ({ surfaceIsUseful: () => false }));
vi.mock('../src/main/computer/index.js', () => ({ refreshMacOSDesktopAccess: vi.fn() }));

import { checkLocalServer, describeExternalCatalog, describeToolRequests } from '../src/main/diagnostics.js';

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  const current = server;
  server = null;
  await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
});

type RpcResponse = unknown | ((body: Record<string, unknown>) => unknown);

async function endpoint(initialize: RpcResponse, toolsList: RpcResponse): Promise<string> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const selected = body.method === 'initialize' ? initialize : toolsList;
      const payload = typeof selected === 'function' ? selected(body) : selected;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind an ephemeral TCP port');
  return `http://127.0.0.1:${address.port}/mcp/core/test`;
}

const initOk = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } };
const tool = (name: string) => ({ name, description: `${name} description`, inputSchema: { type: 'object', properties: {} } });

it('fails an HTTP 200 tools/list response with an empty catalog', async () => {
  const url = await endpoint(initOk, { jsonrpc: '2.0', id: 2, result: { tools: [] } });
  const result = await checkLocalServer(url);
  expect(result).toMatchObject({ name: 'Local server', status: 'fail', ok: false });
  expect(result.detail).toContain('tools/list is empty');
});

it('fails a malformed initialize JSON-RPC response before tools/list', async () => {
  const url = await endpoint('not-json-rpc', { jsonrpc: '2.0', id: 2, result: { tools: [tool('read')] } });
  const result = await checkLocalServer(url);
  expect(result).toMatchObject({ name: 'Local server', status: 'fail', ok: false });
  expect(result.detail).toContain('initialize failed');
});

it('fails a nameless tool definition', async () => {
  const url = await endpoint(initOk, { jsonrpc: '2.0', id: 2, result: { tools: [{ description: 'missing name', inputSchema: { type: 'object' } }] } });
  const result = await checkLocalServer(url);
  expect(result).toMatchObject({ status: 'fail', ok: false });
  expect(result.detail).toContain('invalid or duplicate tool definition');
});

it('fails a tool definition without an object input schema', async () => {
  const url = await endpoint(initOk, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'read', description: 'read things' }] } });
  const result = await checkLocalServer(url);
  expect(result).toMatchObject({ status: 'fail', ok: false });
  expect(result.detail).toContain('invalid or duplicate tool definition');
});

it('fails duplicate tool names', async () => {
  const url = await endpoint(initOk, { jsonrpc: '2.0', id: 2, result: { tools: [tool('read'), tool('read')] } });
  const result = await checkLocalServer(url);
  expect(result).toMatchObject({ status: 'fail', ok: false });
  expect(result.detail).toContain('invalid or duplicate tool definition');
});

it('passes a valid non-empty catalog and reports its exact tool count', async () => {
  const url = await endpoint(initOk, { jsonrpc: '2.0', id: 2, result: { tools: [tool('read'), tool('exec_command')] } });
  const result = await checkLocalServer(url);
  expect(result).toMatchObject({ name: 'Local server', status: 'pass', ok: true });
  expect(result.detail).toBe('Answers on loopback and offers 2 tools: read, exec_command');
});

it.each([{}, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }])('refuses a malformed or non-tool handshake before accepting a catalog', async result => {
  const list = vi.fn(() => ({ jsonrpc: '2.0', id: 2, result: { tools: [tool('read')] } }));
  expect(await checkLocalServer(await endpoint({ jsonrpc: '2.0', id: 1, result }, list))).toMatchObject({ status: 'fail' });
  expect(list).not.toHaveBeenCalled();
});

it('keeps external catalog evidence separate from HTTP arrival and provider approval', () => {
  expect(describeExternalCatalog(null)).toMatchObject({ status: 'not-run' });
  const observation = { method: 'tools/list' as const, httpStatus: 200, outcome: 'success' as const, at: Date.now() };
  expect(describeExternalCatalog({ ...observation, toolCount: 0 })).toMatchObject({ status: 'fail' });
  expect(describeExternalCatalog({ ...observation, outcome: 'rpc-error', rpcErrorCode: -32603 })).toMatchObject({ status: 'fail' });
  expect(describeExternalCatalog({ ...observation, toolCount: 7, definitionHash: '1234' })).toMatchObject({ status: 'pass', detail: expect.stringContaining('does not prove the host accepted') });
  expect(describeToolRequests(Date.now(), null)).toMatchObject({ status: 'not-run', detail: expect.stringContaining('no tool call') });
  expect(describeToolRequests(Date.now(), Date.now()).detail).not.toContain('whole chain works');
});
