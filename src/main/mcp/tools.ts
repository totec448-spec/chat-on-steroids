/**
 * Builds the MCP server for one surface.
 *
 * There is no "the" tool list any more. Each connector is its own server with its own
 * `tools/list`, because that list is the unit ChatGPT discovers: a no-query discovery pull
 * returns everything one server advertises, so the only real way to bound what a
 * conversation can be handed is to publish less per server (`docs/tool-surface.md` §6.4).
 *
 * The invariant this file enforces is that the boundary is *real*. A server registers the
 * tools its surface names and nothing else, so a Core server has no handler for `computer`
 * and answers a call for it with an unknown-tool error from the protocol layer itself.
 * There is no hidden acceptance of names a server did not advertise, and there is no
 * merged list — those would both be ways of claiming a separation the product does not have.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import { createRegistrar, type ToolContext } from './kernel.js';
import { registerCoreTools } from './tools-core.js';
import { registerDesktopTools } from './tools-desktop.js';
import { surfaceDefinition, type SurfaceId } from './surfaces.js';
import { serverInstructions } from './instructions.js';
import { APP_VERSION } from './../version.js';
import { toVirtualPath } from '../sandbox.js';
import { logWarn } from '../logger.js';

export function buildServer(ctx: ToolContext, surface: SurfaceId, observe?: (connectorName: string, version: string, instructions: string, tools: PluginToolSchema[]) => void): McpServer {
  const definition = surfaceDefinition(surface);
  const server = new McpServer(
    { name: definition.serverName, version: APP_VERSION },
    { capabilities: { tools: {} }, instructions: serverInstructions(ctx, surface) }
  );

  const tools: PluginToolSchema[] = [];
  const registrar = createRegistrar(server, ctx, surface, observe ? (name, config) => {
    // Match the SDK's Standard Schema conversion target and object-root normalization.
    const schema = z.toJSONSchema(config.inputSchema, { target: 'draft-2020-12', io: 'input' });
    tools.push({ name, description: config.description, inputSchema: { type: 'object', ...schema }, ...(config.annotations ? { annotations: { ...config.annotations } } : {}) });
  } : undefined);
  if (surface === 'core') registerCoreTools(registrar);
  else registerDesktopTools(registrar);

  // Cheap self-check on a property the tests assert and the design depends on: a surface
  // may register fewer tools than it declares — permissions decide that — but it may never
  // register one it does not declare. Logged rather than thrown, because refusing to serve
  // would turn a naming slip into a dead connector for the user.
  const declared = new Set(definition.tools);
  for (const name of registrar.registered()) {
    if (!declared.has(name)) {
      logWarn(`MCP surface ${surface} registered "${name}", which it does not declare — check surfaces.ts`);
    }
  }

  observe?.(definition.connectorName, APP_VERSION, serverInstructions(ctx, surface), tools);
  return server;
}

export { toVirtualPath };
export type { ToolContext };
export { chunkText, lastToolCallAt, resetToolClock, transportIdentityStatus } from './kernel.js';
