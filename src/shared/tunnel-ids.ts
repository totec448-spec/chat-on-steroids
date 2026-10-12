import type { SurfaceId } from './types.js';

/** The three connectors' Secure Tunnel IDs, as settings and Setup's draft fields hold them. */
export interface ConnectorTunnelIds {
  tunnelId?: string;
  desktopTunnelId?: string;
  pluginsTunnelId?: string;
}

/**
 * The other connectors configured on this connector's Secure Tunnel ID (#1340).
 *
 * OpenAI hands calls round-robin to every client on one tunnel ID, so connectors sharing one
 * each receive the others' calls, which then fail as UNKNOWN_TOOL. Empty IDs share nothing.
 */
export function connectorsSharingTunnel(tunnel: ConnectorTunnelIds, surface: SurfaceId): SurfaceId[] {
  const ids: Record<SurfaceId, string> = {
    core: tunnel.tunnelId?.trim() ?? '',
    desktop: tunnel.desktopTunnelId?.trim() ?? '',
    plugins: tunnel.pluginsTunnelId?.trim() ?? ''
  };
  const own = ids[surface];
  return own ? (Object.keys(ids) as SurfaceId[]).filter(other => other !== surface && ids[other] === own) : [];
}
