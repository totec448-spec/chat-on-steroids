import { expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toolDeclaration, toolSchema, toolSchemaJson } from '../src/main/mcp/tool-declarations.js';
import { buildServer, type ToolContext } from '../src/main/mcp/tools.js';
import { createRegistrar, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerCoreTools } from '../src/main/mcp/tools-core.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import type { PluginToolSchema } from '../src/shared/plugin-refresh.js';

async function rpc(handler: ReturnType<typeof createMcpHandler>, method: string, params: Record<string, unknown> = {}) {
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {
      ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
    } })
  }));
  const text = await response.text();
  return JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}

it('shares declaration work but evicts the previous dynamic description instead of accumulating generations', () => {
  let builds = 0;
  const declaration = (key: string) => toolDeclaration('cache-fixture', () => ({ value: ++builds }), key);
  const a = declaration('A');
  expect(declaration('A')).toBe(a);
  expect(declaration('B')).not.toBe(a);
  expect(declaration('A')).not.toBe(a);
  expect(builds).toBe(3);
});

it('keeps Zod input and output refinements through fresh SDK servers while sharing their schema conversion', async () => {
  const input = z.object({ left: z.string().optional(), right: z.string().optional() })
    .refine(value => (value.left === undefined) !== (value.right === undefined), 'choose exactly one');
  const output = z.object({ value: z.string() }).refine(value => value.value !== 'invalid', 'invalid output');
  const servers = new Set<McpServer>();
  let calls = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'schema fixture', version: '1' });
    servers.add(server);
    server.registerTool('choose', { inputSchema: toolSchema(input), outputSchema: toolSchema(output) }, async args => {
      calls++;
      const value = (args as { left?: string; right?: string }).left ?? (args as { right: string }).right;
      return { content: [{ type: 'text', text: value }], structuredContent: { value } };
    });
    return server;
  });
  try {
    const first = await rpc(handler, 'tools/list');
    const json = toolSchemaJson(input);
    expect(first.result.tools[0].inputSchema).toEqual({ type: 'object', ...json });
    expect((await rpc(handler, 'tools/call', { name: 'choose', arguments: { left: 'yes' } })).result.structuredContent).toEqual({ value: 'yes' });
    expect((await rpc(handler, 'tools/call', { name: 'choose', arguments: { left: 'a', right: 'b' } })).result.isError).toBe(true);
    expect(calls).toBe(1);
    expect((await rpc(handler, 'tools/call', { name: 'choose', arguments: { left: 'invalid' } })).result.isError).toBe(true);
    expect(calls).toBe(2);
    expect(servers.size).toBe(4);
    expect(toolSchemaJson(input)).toBe(json);
    expect(toolSchema(input)).toBe(toolSchema(input));
  } finally { await handler.close(); }
});

it('refreshes root-sensitive read descriptions without rebuilding unrelated declarations', async () => {
  const ctx: ToolContext = { roots: [{ name: 'first', path: '/unused' }], caps: { ...DEFAULT_CAPABILITIES, read: true }, readOnly: false, sessionTools: false, agentTools: false, exposedFinishTool: false };
  const declarations = async () => {
    let tools: PluginToolSchema[] = [];
    const server = buildServer(ctx, 'core', (_name, _version, _instructions, published) => { tools = published; });
    await server.close();
    return tools;
  };
  const a = await declarations();
  const b = await declarations();
  const read = (tools: PluginToolSchema[]) => tools.find(tool => tool.name === 'read')!.inputSchema;
  expect(read(a).properties).toBe(read(b).properties);
  ctx.roots = [{ name: 'second', path: '/unused' }];
  const c = await declarations();
  expect(JSON.stringify(read(c))).toContain('/second');
  expect(JSON.stringify(read(c))).not.toContain('/first');
  expect(c.find(tool => tool.name === 'view_image')!.inputSchema.properties).toBe(a.find(tool => tool.name === 'view_image')!.inputSchema.properties);
});

it('shares schemas without capturing the preceding request permission snapshot in handlers', async () => {
  const register = async (read: boolean) => {
    const ctx: ToolContext = { roots: [], caps: { ...DEFAULT_CAPABILITIES, read }, exposedCaps: { ...DEFAULT_CAPABILITIES, read: true }, readOnly: false, sessionTools: false, agentTools: false, exposedFinishTool: false };
    const server = new McpServer({ name: 'permission fixture', version: '1' });
    const registrar = createRegistrar(server, ctx, 'core');
    let invoke!: (args: never) => Promise<ToolResult>;
    registrar.register = (name, _config, handler) => { if (name === 'view_image') invoke = handler; };
    registerCoreTools(registrar);
    await server.close();
    // Empty approved roots refuse before filesystem access when permission is on.
    return invoke({ path: '/unapproved/image.png' } as never);
  };
  expect(JSON.stringify(await register(false))).toContain('TOOL_DISABLED');
  expect(JSON.stringify(await register(true))).not.toContain('TOOL_DISABLED');
  expect(JSON.stringify(await register(false))).toContain('TOOL_DISABLED');
});
