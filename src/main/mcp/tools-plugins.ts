import type { McpServer } from '@modelcontextprotocol/server';
import type { PluginToolSchema } from '../../shared/plugin-refresh.js';
import { pluginManager } from '../plugins/manager.js';
import { getConfig } from '../config.js';
import { noteOutcome } from './call-context.js';
import { inboundRequestId } from './inbound.js';
import { dispatch, fail, type ToolResult } from './kernel.js';

/** Raw SDK handlers keep external JSON Schema intact (including refs and output schemas).
 * Only the new surface uses them; Core/Desktop retain their existing registrar unchanged.
 * Admission is checked by the manager on every call, including stale cached tool names.
 */
export function registerPluginTools(server: McpServer): PluginToolSchema[] {
  const tools = pluginManager.tools();
  server.server.setRequestHandler('tools/list', async () => ({ tools }));
  server.server.setRequestHandler('tools/call', async (request, context) => {
    const tool = tools.find(item => item.name === request.params.name);
    const result = await dispatch(request.params.name, request.params.arguments ?? {}, context.sessionId ?? null,
      inboundRequestId(), 'plugins', async () => {
        // An external annotation is informational, never proof a process cannot mutate.
        if (getConfig().readOnly) return fail('TOOL_DISABLED: external plugins are unavailable while CoS read-only mode is on.');
        return await pluginManager.call(request.params.name, request.params.arguments ?? {}, noteOutcome) as ToolResult;
      });
    return server.server.projectCallToolResult(result, tool?.outputSchema);
  });
  return tools.map(tool => ({ ...tool, description: tool.description ?? '' }));
}
