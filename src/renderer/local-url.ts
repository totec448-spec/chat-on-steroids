/**
 * A local MCP address for display. The path segment after /mcp/<surface>/ is the per-session
 * token that authorises callers (see src/main/mcp/server.ts), so diagnostics show where the
 * server listens without the key; these rows end up in shared screenshots.
 */
export function displayLocalServer(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/(\/mcp\/[^/]+\/)[^/?#]+/, '$1…');
}
