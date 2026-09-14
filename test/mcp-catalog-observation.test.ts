import { expect, it, vi } from 'vitest';
import {
  observeCatalogTraffic,
  summarizeCatalogResponse
} from '../src/main/mcp/catalog-observation.js';

const tool = (name: string) => ({ name, description: `${name} description`, inputSchema: { type: 'object', properties: {} } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('summarizes a valid JSON tools/list without retaining its definitions', () => {
  const summary = summarizeCatalogResponse('tools/list', 7, 200, JSON.stringify({
    jsonrpc: '2.0', id: 7, result: { tools: [tool('read'), tool('exec_command')] }
  }));

  expect(summary).toMatchObject({ method: 'tools/list', httpStatus: 200, outcome: 'success', toolCount: 2 });
  expect(summary.definitionHash).toMatch(/^[0-9a-f]{16}$/);
  expect(JSON.stringify(summary)).not.toContain('read description');
});

it('summarizes an empty SSE tools/list as a zero-count catalog', () => {
  const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'catalog', result: { tools: [] } })}\n\n`;
  expect(summarizeCatalogResponse('tools/list', 'catalog', 200, body)).toMatchObject({
    method: 'tools/list', httpStatus: 200, outcome: 'success', toolCount: 0
  });
});

it('records only the RPC error code on an HTTP 200 response', () => {
  const secret = 'private-token-and-path';
  const summary = summarizeCatalogResponse('tools/list', 3, 200, JSON.stringify({
    jsonrpc: '2.0', id: 3, error: { code: -32603, message: `failed ${secret}`, data: { params: secret } }
  }));

  expect(summary).toEqual({ method: 'tools/list', httpStatus: 200, outcome: 'rpc-error', rpcErrorCode: -32603 });
  expect(JSON.stringify(summary)).not.toContain(secret);
});

it('rejects malformed or duplicate tool definitions as an invalid catalog', () => {
  for (const tools of [
    [{ name: '', inputSchema: { type: 'object' } }],
    [{ name: 'read' }],
    [tool('read'), tool('read')]
  ]) {
    expect(summarizeCatalogResponse('tools/list', 4, 200, JSON.stringify({ jsonrpc: '2.0', id: 4, result: { tools } }))).toMatchObject({
      outcome: 'invalid-catalog'
    });
  }
});

it('ignores a response for a different JSON-RPC id', () => {
  const summary = summarizeCatalogResponse('tools/list', 'wanted', 200, JSON.stringify({
    jsonrpc: '2.0', id: 'other', result: { tools: [tool('read')] }
  }));
  expect(summary).toEqual({ method: 'tools/list', httpStatus: 200, outcome: 'unparsed' });
});

it('observes catalog traffic without consuming requests or responses, ignores tools/call, and swallows observer errors', async () => {
  const catalogRequest = new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} })
  });
  const responseBytes = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { tools: [tool('read')] } });
  const catalogResponse = new Response(responseBytes, { status: 200, headers: { 'content-type': 'application/json' } });
  const seenRequests: Request[] = [];
  const handler = { fetch: vi.fn(async (request: Request) => { seenRequests.push(request); return catalogResponse; }) } as any;
  const observe = vi.fn(() => { throw new Error('observer failure'); });
  const wrapped = observeCatalogTraffic(handler, observe);

  const returned = await wrapped.fetch(catalogRequest, {} as any);
  expect(seenRequests).toEqual([catalogRequest]);
  expect(returned).toBe(catalogResponse);
  expect(await catalogRequest.text()).toContain('"method":"tools/list"');
  expect(await returned.text()).toBe(responseBytes);
  await tick();
  expect(observe).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', toolCount: 1 }));

  const callRequest = new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'read', arguments: { secret: 'do-not-observe' } } })
  });
  const callResponse = new Response(JSON.stringify({ jsonrpc: '2.0', id: 10, result: { content: [] } }), { status: 200 });
  handler.fetch.mockResolvedValueOnce(callResponse);
  expect(await wrapped.fetch(callRequest, {} as any)).toBe(callResponse);
  await tick();
  expect(observe).toHaveBeenCalledTimes(1);
});

it('does not consume or truncate an oversized non-catalog request while bounding its observer clone', async () => {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 20, method: 'tools/call',
    params: { name: 'exec_command', arguments: { code: 'x'.repeat(100 * 1024) } }
  });
  expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1024);
  const request = new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body
  });
  let received = '';
  const responseBody = JSON.stringify({ jsonrpc: '2.0', id: 20, result: { content: [] } });
  const response = new Response(responseBody, { status: 200 });
  const handler = { fetch: vi.fn(async (incoming: Request) => { received = await incoming.text(); return response; }) } as any;
  const observe = vi.fn();

  const returned = await observeCatalogTraffic(handler, observe).fetch(request, {} as any);
  expect(received).toBe(body);
  expect(returned).toBe(response);
  expect(await returned.text()).toBe(responseBody);
  await tick();
  expect(observe).not.toHaveBeenCalled();
});

it('returns an oversized catalog response byte-for-byte while the bounded observation becomes unparsed', async () => {
  const request = new Request('http://127.0.0.1/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/list', params: {} })
  });
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 21,
    result: { tools: [tool('read')], padding: 'y'.repeat(600 * 1024) }
  });
  expect(Buffer.byteLength(body)).toBeGreaterThan(512 * 1024);
  expect(Buffer.byteLength(body)).toBeLessThan(1024 * 1024);
  const response = new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  const handler = { fetch: vi.fn(async () => response) } as any;
  const observe = vi.fn();

  const returned = await observeCatalogTraffic(handler, observe).fetch(request, {} as any);
  expect(returned).toBe(response);
  expect(await returned.text()).toBe(body);
  await tick();
  expect(observe).toHaveBeenCalledWith({ method: 'tools/list', httpStatus: 200, outcome: 'unparsed' });
});
