/**
 * Wire contract of the local control API (`src/main/control-api.ts`).
 *
 * A read-only projection for a trusted local caller, such as an agent's MCP server that
 * watches the app from outside its process. Every field is copied from an existing owner;
 * nothing here is decided by the API itself. Secret-bearing fields (MCP path tokens, public
 * URLs, tunnel ids, plugin sources and config values) are deliberately absent, not masked.
 */
export const CONTROL_API_PROTOCOL = 1;

/** Listed in every health reply, so a caller learns what this build serves without guessing. */
export const CONTROL_API_ROUTES = ['/v1/health', '/v1/status'] as const;

/** Written to `userData/control-api/endpoint.json` while the listener is up. */
export interface ControlApiEndpoint {
  protocol: number;
  port: number;
  pid: number;
  appVersion: string;
  startedAt: string;
}

export interface ControlApiHealth {
  ok: true;
  protocol: number;
  routes: string[];
  pid: number;
  appVersion: string;
  /** When this app process started. */
  startedAt: string;
  uptimeSeconds: number;
}

export interface ControlApiStatus {
  appVersion: string;
  connection: {
    state: string;
    detail: string;
    handshakeAt: number | null;
    lastRequestAt: number | null;
    lastToolCallAt: number | null;
    tunnel: {
      pollErrors: number | null;
      uptimeSeconds: number | null;
      route: string | null;
      probe: string | null;
      clientVersion: string | null;
    } | null;
    surfaces: Array<{
      id: string;
      state: string;
      available: boolean;
      optional: boolean;
      detail: string;
      tools: number;
      lastRequestAt: number | null;
      lastToolCallAt: number | null;
    }>;
  };
  bridge: {
    running: boolean;
    port: number | null;
    portOverridden: boolean;
    paired: boolean;
    present: boolean;
    lastSeenAt: number | null;
    extensionVersion: string | null;
    error: string | null;
  };
  plugins: Array<{ id: string; name: string; enabled: boolean; status: string; enabledTools: number; error: string | null }>;
  update: { current: string; latest: string | null; stage: string; error: string | null; checkedAt: number | null };
  toolCalls: { running: number; settling: number; inFlight: number; inFlightMcpRequests: number };
}
