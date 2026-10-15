export type PluginSource = {
  kind: 'npm' | 'python' | 'command' | 'remote' | 'mcpb' | 'github';
  package?: string;
  version?: string;
  /** Reviewed exact Python dependency pins, resolved together with the server package. */
  dependencies?: { package: string; version: string }[];
  command?: string;
  args?: string[];
  url?: string;
  /** Remote OAuth is explicit; omitted sources keep their existing static headers. */
  auth?: 'oauth';
  path?: string;
};
export const DEFAULT_PLUGIN_LONGEST_CALL_SECONDS = 120;
export const MAX_PLUGIN_LONGEST_CALL_SECONDS = 1800;
export interface PluginConfigPatch {
  config?: Record<string, string>;
  credentials?: Record<string, string>;
  source?: PluginSource;
  name?: string;
  /** Per-installation overall MCP tool call limit, not a server environment variable. */
  longestCallSeconds?: number;
}
export interface PluginInstallRequest extends PluginConfigPatch {
  catalogId?: string;
}
export interface PluginField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}
export interface PluginCatalogEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  source: PluginSource;
  homepage: string;
  license: string;
  instructions: string[];
  fields: PluginField[];
  /** Representative tool names or documented action labels; live discovery determines actual tools. */
  tools?: string[];
}
export interface PluginToolView {
  name: string;
  exposedName: string;
  description?: string;
  enabled: boolean;
  published?: boolean;
  exposureError?: string;
}
export interface PluginView {
  id: string;
  name: string;
  catalogId?: string;
  source: PluginSource;
  config: Record<string, string>;
  longestCallSeconds: number;
  credentialKeys: string[];
  fields?: PluginField[];
  version: string;
  license: string;
  homepage?: string;
  enabled: boolean;
  status: 'installed' | 'connecting' | 'ready' | 'disabled' | 'error' | 'needs-auth' | 'authenticating';
  error?: string;
  tools: PluginToolView[];
  installedAt: number;
}
export interface PluginSnapshot {
  plugins: PluginView[];
  catalog: PluginCatalogEntry[];
  schemaRevision: number;
}
