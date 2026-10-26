import type { Tool } from '@modelcontextprotocol/client';

// Schema bytes are the normal publication bound. Keep the manager's existing
// catalog ceiling only as an emergency guard against pathological catalogs.
export const PLUGIN_MAX_TOOLS = 256;
export const PLUGIN_MAX_SCHEMA_BYTES = 250000;
/**
 * The emergency guard on what one server may declare. It is far above the publication bound: a
 * server with more tools than ChatGPT gets is installed, publishes what fits, and the user switches
 * tools off to choose the rest (#1313). It only stops a catalog no one could manage.
 */
export const PLUGIN_DISCOVERY_MAX_TOOLS = 2048;
export const PLUGIN_DISCOVERY_MAX_BYTES = 8 * 1024 * 1024;

export interface PluginExposureSource {
  id: string;
  name: string;
  enabled: boolean;
  tools: readonly Tool[];
  disabledTools: readonly string[];
}

/** ChatGPT's widget keys: each names a resource ChatGPT reads from this same server to draw the tool's result. */
const WIDGET_KEYS = ['ui/resourceUri', 'openai/outputTemplate'] as const;

/**
 * The copy ChatGPT gets, without widget resource references (#1870). The Plugins server serves no
 * resources (its catalogs are empty, #1557), so a tool naming one, like an MCP Apps `ui://` page,
 * made ChatGPT's resource read fail and the whole connector failed to enroll (-32602). Only those
 * references go, with the widget flag that only means something with one; names, schemas, annotations and every
 * other key stay as the plugin declared them, and the installed catalog is not changed.
 */
function withoutWidgets(tool: Tool): Tool {
  const meta = tool._meta;
  if (!meta) return tool;
  const ui = meta.ui && typeof meta.ui === 'object' && !Array.isArray(meta.ui) ? meta.ui as Record<string, unknown> : null;
  if (!WIDGET_KEYS.some(key => key in meta) && !('openai/widgetAccessible' in meta) && !(ui && 'resourceUri' in ui)) return tool;
  const { 'openai/widgetAccessible': _accessible, ...rest } = meta;
  for (const key of WIDGET_KEYS) delete rest[key];
  if (ui) {
    const { resourceUri: _uri, ...other } = ui;
    if (Object.keys(other).length) rest.ui = other;
    else delete rest.ui;
  }
  return { ...tool, _meta: rest };
}

/** One projection for discovery, UI and call ownership. Upstream names never change. */
export function pluginExposure(sources: readonly PluginExposureSource[]): {
  tools: Tool[];
  owners: Map<string, string>;
  issues: Map<string, Map<string, string>>;
} {
  const claims = new Map<string, PluginExposureSource[]>();
  const issues = new Map<string, Map<string, string>>();
  const issue = (id: string, name: string, reason: string) => {
    let row = issues.get(id);
    if (!row) issues.set(id, row = new Map());
    row.set(name, reason);
  };
  // Disabled integrations still own their retained names: toggling one off must
  // not route a cached call to another integration with the same upstream name.
  // Deliberate uninstall removes its catalog and releases that reservation.
  for (const source of sources) for (const tool of source.tools) {
    const owners = claims.get(tool.name) ?? [];
    owners.push(source);
    claims.set(tool.name, owners);
  }
  for (const [name, owners] of claims) if (owners.length > 1) {
    const names = [...new Set(owners.map(owner => owner.name))].join(', ');
    for (const owner of owners)
      issue(owner.id, name, `Tool "${name}" has conflicting declarations in ${names}; it is not exposed. Remove the duplicate integration to resolve the conflict.`);
  }

  const tools: Tool[] = [];
  const owners = new Map<string, string>();
  let bytes = 0;
  for (const source of sources) {
    if (!source.enabled) continue;
    const disabled = new Set(source.disabledTools);
    for (const tool of source.tools) {
      if (disabled.has(tool.name) || claims.get(tool.name)!.length !== 1) continue;
      const published = withoutWidgets(tool);
      const size = Buffer.byteLength(JSON.stringify(published));
      if (tools.length >= PLUGIN_MAX_TOOLS || bytes + size > PLUGIN_MAX_SCHEMA_BYTES) {
        issue(source.id, tool.name, 'Not exposed because the Plugins connector has reached its tool or schema size limit.');
        continue;
      }
      tools.push(published);
      owners.set(tool.name, source.id);
      bytes += size;
    }
  }
  return { tools, owners, issues };
}
