export type PluginSurface = 'core' | 'desktop' | 'plugins';
/** Read-only projection of the existing refresh ledger; no IDs, tools or browser actions. */
export interface PluginRefreshStatus {
  schemaId: string;
  state: 'unknown' | 'current' | 'pending' | 'refreshing' | 'manual' | 'failed';
  /** Successful provider tool call under this live publication; not a full-schema claim. */
  responding?: boolean;
}
export interface PluginToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
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
  /** Re-read declarations only; a mismatch cannot grant another Refresh click. */
  observeOnly?: boolean;
}
