export type PluginSurface = 'core' | 'desktop';
export interface PluginToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
export interface PluginPublication {
  surface: PluginSurface;
  schemaId: string;
  connectorName: string;
  tools: PluginToolSchema[];
}
export interface PluginRefreshRequest extends PluginPublication {
  id: string;
  appId: string | null;
}
