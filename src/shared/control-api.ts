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

/**
 * Routes that change something. They are served only while the user has also switched on
 * `controlApi.allowActions`, and are listed apart from `CONTROL_API_ROUTES` for that reason.
 */
export const CONTROL_API_ACTION_ROUTES = ['POST /v1/inputs', 'POST /v1/inputs/{id}/cancel'] as const;

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
  /** Whether the action routes are being served right now, and which ones this build has. */
  actions: { enabled: boolean; routes: string[] };
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

/**
 * The compaction, or handoff to a replacement chat, this session is part of: one that is running,
 * or one the app has just finished and not yet forgotten.
 */
export interface ControlApiJob {
  /** `handoff-pending`, `opening`, `waiting-for-browser`, `done` or `failed`. */
  stage: string;
  startedAt: number;
  /** Started by the app's own threshold rather than by a person. */
  automatic: boolean;
  /** True while the job is running: every stage but `done` and `failed`. */
  busy: boolean;
  /** `not-attempted`, `attempted-unresolved`, `dispatched-unresolved` or `sent`. */
  sourceSend: string;
  destinationSend: string;
  /** Why the job failed, when it did. Free text, masked and cut like the rest. */
  error: string | null;
}

/** One thing the app is waiting on for a chat, and when it stops waiting. */
export interface ControlApiRecovery {
  /**
   * `unattributed`, `unattributed-wait`, `assistant-error`, `tab-recovery`, `thinking-failed`,
   * `native-busy`, `silence`, `post-reload` or `pickup`.
   */
  kind: string;
  /** Milliseconds since the epoch. When the app has not fixed an end for a wait, this is the moment of the read. */
  deadline: number;
  /** When the app's window starts to show this wait, if it holds it back until then. */
  visibleAt: number | null;
  /** What the wait leads to when it runs out, if anything: `queue`, `goal`, `loop` or `continue`. */
  next: string | null;
  /** The conditions for the app's attribution retry are met now. */
  reload: boolean;
  /** The app is still holding the source turn open during a post-reload wait. */
  generating: boolean;
}

export interface ControlApiLive {
  /** The turn ChatGPT is running now, if the app judges it still running. */
  activeTurnId: string | null;
  stopPending: boolean;
  /** `off`, `goal` or `loop`. */
  automation: string;
  /**
   * Empty, or why the app has taken its hands off the chat: `blocked` (the user blocked it, so
   * its tools are refused and its loop is suspended) or `worker` (a worker's chat).
   */
  blocked: string;
  /** A message sent now would stop the answer ChatGPT is writing (the composer's Send directly). */
  canSendDirectly: boolean;
  /** A message sent now is injected into the running turn (the composer's Inject now). */
  canInject: boolean;
  /** A message can be queued to go out when the session finishes. */
  queueAtFinish: boolean;
  /** The app is holding the open turn's finish and has not released it. */
  finishHeld: boolean;
  /** The finish is held and a finish call is in progress, with no message queued for the chat. */
  finishWaiting: boolean;
  /** Why an armed goal or loop has not sent its next instruction yet. `until` is null when the wait has no deadline. */
  goalWait: { reason: string; until: number | null } | null;
  /** Deadlines the app is holding for this chat: the reasons it has not acted yet. */
  recovery: ControlApiRecovery[];
  job: ControlApiJob | null;
}

export interface ControlApiSessionDetail {
  session: ControlApiSession;
  /**
   * Only present when asked for with `?live=1`. Null when the session has no attached chat to
   * describe (never recorded, or superseded), when its state could not be read, or when the
   * session moved to another chat while it was being read.
   */
  live?: ControlApiLive | null;
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
  /**
   * What the row proves about delivery. `sent`: the receipt exists. `not_sent`: terminal and
   * Send was never authorized. `unconfirmed`: Send may have reached ChatGPT; never resent.
   * `pending`: not yet handed out.
   */
  delivery: 'sent' | 'not_sent' | 'unconfirmed' | 'pending';
  mode: string;
  transportIntent: string | null;
  /** Filed by the app itself, such as a recovery pickup, rather than sent by a person or agent. */
  automatic: boolean;
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

export interface ControlApiSendResult {
  /** The outbox row. It is admitted, not delivered: `input.delivery` says what is known. */
  input: ControlApiInput;
  /** True when this id was already in the outbox, so nothing was sent again. */
  replayed: boolean;
}

export interface ControlApiCancelResult {
  input: ControlApiInput;
  /** False when the row was already cancelled or failed. `input.delivery` says whether it may have been sent. */
  cancelled: boolean;
}
