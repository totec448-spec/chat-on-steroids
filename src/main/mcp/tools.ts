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
import { createRegistrar, type ToolContext } from './kernel.js';
import { registerCoreTools } from './tools-core.js';
import { registerDesktopTools } from './tools-desktop.js';
import { surfaceDefinition, type SurfaceId } from './surfaces.js';
import { serverInstructions } from './instructions.js';
import { BUILD_VERSION } from './../version.js';
import { toVirtualPath } from '../sandbox.js';
import { logWarn } from '../logger.js';

export function buildServer(ctx: ToolContext, surface: SurfaceId): McpServer {
  const definition = surfaceDefinition(surface);
  const server = new McpServer(
    // The build, not just the release. This is the one identity that reaches ChatGPT itself, so
    // a connector talking to the wrong build can be recognised from the other end — which is
    // precisely what nobody could do when a QA run spent itself on an app without the feature.
    { name: definition.serverName, version: BUILD_VERSION },
    { capabilities: { tools: {} }, instructions: serverInstructions(ctx, surface) }
  );

  const registrar = createRegistrar(server, ctx, surface);
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

  return server;
}

export { toVirtualPath };
export type { ToolContext };
export { chunkText, lastToolCallAt, resetToolClock, transportIdentityStatus } from './kernel.js';
