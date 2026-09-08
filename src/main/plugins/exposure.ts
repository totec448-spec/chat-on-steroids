import type { Tool } from '@modelcontextprotocol/client';

export const PLUGIN_MAX_TOOLS = 64;
export const PLUGIN_MAX_SCHEMA_BYTES = 250000;

export interface PluginExposureSource {
  id: string;
  name: string;
  enabled: boolean;
  tools: readonly Tool[];
  disabledTools: readonly string[];
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
      const size = Buffer.byteLength(JSON.stringify(tool));
      if (tools.length >= PLUGIN_MAX_TOOLS || bytes + size > PLUGIN_MAX_SCHEMA_BYTES) {
        issue(source.id, tool.name, 'Not exposed because the Plugins connector has reached its tool or schema size limit.');
        continue;
      }
      tools.push(tool);
      owners.set(tool.name, source.id);
      bytes += size;
    }
  }
  return { tools, owners, issues };
}
