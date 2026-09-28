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
export const CONTROL_API_ROUTES = [
  '/v1/health',
  '/v1/status',
  '/v1/sessions',
  '/v1/sessions/{id}',
  '/v1/sessions/{id}/events',
  '/v1/inputs',
  '/v1/agents',
  '/v1/log'
] as const;

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

/**
 * Free text, cut for the wire. `chars` is the length before any cut, from the stored record.
 * Known credential shapes are masked; anything else in the text is returned as recorded.
 */
export interface ControlApiText {
  text: string;
  chars: number;
  truncated: boolean;
}

export interface ControlApiSession {
  id: string;
  title: string;
  conversationId: string | null;
  projectId: string | null;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  events: number;
  userMessages: number;
  toolCalls: number;
  lastToolCallAt: number | null;
  lastAssistantFinalAt: number | null;
  lastTurnEndAt: number | null;
  /** Runtime deadline from the bridge. Null when the bridge holds no activity grant. */
  activityExpiresAt: number | null;
  errors: number;
  toolRejected: number;
  toolInternalErrors: number;
  processExitNonzero: number;
  estimatedTokens: number;
  contextTokens: number;
  lastTurnOutcome: string | null;
  /** The recorded open turn. Whether it is still running is `live.activeTurnId`. */
  activeTurnId: string | null;
  model: string | null;
  agents: string[];
  origin: { kind: string; fromSessionId: string | null; agentId: string | null; task: string } | null;
}

export interface ControlApiSessionList {
  sessions: Array<ControlApiSession & { pressure: { level: string; advisory: number; limit: number } }>;
  total: number;
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  activeId: string | null;
}

export interface ControlApiSessionDetail {
  session: ControlApiSession;
  /**
   * Only present when asked for with `?live=1`. Null when the session has no attached chat to
   * describe (never recorded, or superseded) or its state could not be read.
   */
  live?: {
    activeTurnId: string | null;
    stopPending: boolean;
    automation: string;
    blocked: string;
  } | null;
}

export type ControlApiEvent = {
  /** Order of recording. A revised message gets a new `seq` each time it is revised. */
  seq: number;
  /** Where the row sits in history. `before` and `after` take this, not `seq`. */
  position: number;
  time: number;
  kind: string;
  source: string;
  agent?: string;
  turnId?: string;
  model?: string;
  /** Set when this one row could not be read; only its position and kind are published. */
  unreadable?: true;
  message?: ControlApiText;
  /** `user_message`. */
  messageId?: string;
  inputId?: string;
  inputDelivery?: string;
  attachments?: number;
  images?: number;
  /** `assistant_message`. */
  final?: boolean;
  state?: string;
  resolvedModel?: string;
  /** `session_start`. */
  conversationId?: string | null;
  title?: string;
  /** `turn_start`, `turn_end`, `chat_error`. */
  outcome?: string;
  detail?: string;
  reason?: string;
  recoverable?: boolean;
  blocking?: boolean;
  /** `page_tool`. */
  label?: string;
  /** `native_image`. */
  previewStatus?: string;
  width?: number;
  height?: number;
  /** `tool_call`. */
  tool?: {
    callId: string;
    name: string;
    outcome: string;
    durationMs: number;
    attribution: string;
    summary: { title: string; detail?: string; metric?: string; tone: string; kind: string };
    args: ControlApiText;
    result: ControlApiText;
    changes: Array<{ path: string; added: number; removed: number }>;
  };
  /** `agent_message`. */
  from?: string;
  to?: string;
  delivery?: string;
  /** `handoff`. */
  handoffId?: string;
  chars?: number;
};

export interface ControlApiEvents {
  events: ControlApiEvent[];
  /** Total events the session has recorded, not the size of this page. */
  total: number;
  /**
   * One past the highest `seq` on this page, to pass as `from` to follow the session live. It
   * moves only past rows that were returned: an empty page, or a `kinds` filter that matched
   * nothing, leaves it where it was.
   */
  nextFrom: number;
}

export interface ControlApiInput {
  id: string;
  sessionId: string | null;
  deliveredSessionId: string | null;
  conversationId: string | null;
  state: string;
  mode: string;
  purpose: string | null;
  createdAt: number;
  dueAt: number;
  offeredAt: number | null;
  deliveredAt: number | null;
  sendAuthorizedAt: number | null;
  requiresAuthorization: boolean;
  cancelledByUser: boolean;
  queueOrder: number | null;
  model: string | null;
  reasoningEffort: string | null;
  messageId: string | null;
  error: string | null;
  text: ControlApiText;
  attachments: number;
  images: number;
}

export interface ControlApiInputs {
  /** Oldest first, the newest `limit` of the rows that match. */
  inputs: ControlApiInput[];
  /** Rows matching the filter, before `limit` kept the newest. */
  total: number;
}

export interface ControlApiAgents {
  enabled: boolean;
  running: boolean;
  agents: Array<{
    runId: string | null;
    id: string;
    role: string;
    label: string;
    task: ControlApiText;
    state: string;
    model: string | null;
    reasoningEffort: string | null;
    conversationId: string | null;
    createdAt: number;
    activatedAt: number | null;
    finishedAt: number | null;
    detachedAt: number | null;
    sleptAt: number | null;
    lastSeenAt: number | null;
    revivable: boolean;
    pending: number;
    awaitingAck: number;
    delivered: number;
    contextTokens: number;
    result: ControlApiText | null;
  }>;
}

export interface ControlApiLog {
  entries: Array<{ time: number; level: string; message: string; agent?: string; truncated?: true }>;
  /** Entries the in-memory ring holds, before the filters. */
  ringSize: number;
}
