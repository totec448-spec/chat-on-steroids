//! The local control API (`src/shared/control-api.ts`, served by `src/main/control-*.ts`).
//!
//! Response bodies are closed projections the app produces, so they carry no `extra` map.
//! Many fields that are enums inside the app are published as plain strings here, exactly as
//! the TypeScript contract declares them; a caller must not break when a new word appears.

use serde::{Deserialize, Serialize};

use crate::json::{JsNumber, True, nullable};

/// `CONTROL_API_PROTOCOL`.
pub const CONTROL_API_PROTOCOL: u64 = 1;

/// `CONTROL_API_ROUTES`, listed in every health reply.
pub const CONTROL_API_ROUTES: &[&str] = &[
    "/v1/health",
    "/v1/status",
    "/v1/sessions",
    "/v1/sessions/{id}",
    "/v1/sessions/{id}/events",
    "/v1/sessions/{id}/events/stream",
    "/v1/inputs",
    "/v1/agents",
    "/v1/log",
];

/// `CONTROL_API_ACTION_ROUTES`, served only while `controlApi.allowActions` is on.
pub const CONTROL_API_ACTION_ROUTES: &[&str] = &["POST /v1/inputs", "POST /v1/inputs/{id}/cancel"];

/// `userData/control-api/endpoint.json`, written while the listener is up.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiEndpoint {
    pub protocol: u64,
    pub port: u16,
    pub pid: u32,
    pub app_version: String,
    pub started_at: String,
}

/// Every non-2xx reply: a stable machine word, sometimes with a detail. A refused cancel
/// (`not_cancellable`, `delivery_unconfirmed`) also carries the row it refused.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiError {
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<ControlApiInput>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiActions {
    pub enabled: bool,
    pub routes: Vec<String>,
}

/// `GET /v1/health`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiHealth {
    pub ok: True,
    pub protocol: u64,
    pub routes: Vec<String>,
    pub actions: ControlApiActions,
    pub pid: u32,
    pub app_version: String,
    pub started_at: String,
    pub uptime_seconds: JsNumber,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiTunnel {
    pub poll_errors: Option<u64>,
    pub uptime_seconds: Option<JsNumber>,
    pub route: Option<String>,
    pub probe: Option<String>,
    pub client_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiSurface {
    pub id: String,
    pub state: String,
    pub available: bool,
    pub optional: bool,
    pub detail: String,
    pub tools: u64,
    pub last_request_at: Option<u64>,
    pub last_tool_call_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiConnection {
    pub state: String,
    pub detail: String,
    pub handshake_at: Option<u64>,
    pub last_request_at: Option<u64>,
    pub last_tool_call_at: Option<u64>,
    pub tunnel: Option<ControlApiTunnel>,
    pub surfaces: Vec<ControlApiSurface>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiBridge {
    pub running: bool,
    pub port: Option<u16>,
    pub port_overridden: bool,
    pub paired: bool,
    pub present: bool,
    pub last_seen_at: Option<u64>,
    pub extension_version: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiPlugin {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub status: String,
    pub enabled_tools: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiUpdate {
    pub current: String,
    pub latest: Option<String>,
    pub stage: String,
    pub error: Option<String>,
    pub checked_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiToolCalls {
    pub running: u64,
    pub settling: u64,
    pub in_flight: u64,
    pub in_flight_mcp_requests: u64,
}

/// `GET /v1/status`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiStatus {
    pub app_version: String,
    pub connection: ControlApiConnection,
    pub bridge: ControlApiBridge,
    pub plugins: Vec<ControlApiPlugin>,
    pub update: ControlApiUpdate,
    pub tool_calls: ControlApiToolCalls,
}

/// Free text cut for the wire; `chars` is the length before any cut.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiText {
    pub text: String,
    pub chars: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiOrigin {
    pub kind: String,
    pub from_session_id: Option<String>,
    pub agent_id: Option<String>,
    pub task: String,
}

/// One session row (`ControlApiSession`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiSession {
    pub id: String,
    pub title: String,
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub started_at: u64,
    pub updated_at: u64,
    pub ended_at: Option<u64>,
    pub events: u64,
    pub user_messages: u64,
    pub tool_calls: u64,
    pub last_tool_call_at: Option<u64>,
    pub last_assistant_final_at: Option<u64>,
    pub last_turn_end_at: Option<u64>,
    pub activity_expires_at: Option<u64>,
    pub errors: u64,
    pub tool_rejected: u64,
    pub tool_internal_errors: u64,
    pub process_exit_nonzero: u64,
    pub estimated_tokens: u64,
    pub context_tokens: u64,
    pub last_turn_outcome: Option<String>,
    pub active_turn_id: Option<String>,
    pub model: Option<String>,
    pub agents: Vec<String>,
    pub origin: Option<ControlApiOrigin>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiPressure {
    pub level: String,
    pub advisory: u64,
    pub limit: u64,
}

/// A listed session: the row plus its context pressure.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiListedSession {
    #[serde(flatten)]
    pub session: ControlApiSession,
    pub pressure: ControlApiPressure,
}

/// `GET /v1/sessions`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiSessionList {
    pub sessions: Vec<ControlApiListedSession>,
    pub total: u64,
    pub next_cursor: Option<String>,
    pub active_id: Option<String>,
}

/// The compaction or handoff a session is part of (`ControlApiJob`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiJob {
    pub stage: String,
    pub started_at: u64,
    pub automatic: bool,
    pub busy: bool,
    pub source_send: String,
    pub destination_send: String,
    pub error: Option<String>,
}

/// One thing the app is waiting on for a chat (`ControlApiRecovery`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiRecovery {
    pub kind: String,
    pub deadline: u64,
    pub visible_at: Option<u64>,
    pub next: Option<String>,
    pub reload: bool,
    pub generating: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiGoalWait {
    pub reason: String,
    pub until: Option<u64>,
}

/// Live state of the chat attached to a session (`ControlApiLive`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiLive {
    pub active_turn_id: Option<String>,
    pub stop_pending: bool,
    pub automation: String,
    pub blocked: String,
    pub can_send_directly: bool,
    pub can_inject: bool,
    pub queue_at_finish: bool,
    pub finish_held: bool,
    pub finish_waiting: bool,
    pub goal_wait: Option<ControlApiGoalWait>,
    pub recovery: Vec<ControlApiRecovery>,
    pub job: Option<ControlApiJob>,
}

/// `GET /v1/sessions/{id}`. `live` is present only for `?live=1`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiSessionDetail {
    pub session: ControlApiSession,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub live: Option<Option<ControlApiLive>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiActivitySummary {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    pub tone: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiChange {
    pub path: String,
    pub added: u64,
    pub removed: u64,
}

/// A `tool_call` row's call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiToolCall {
    pub call_id: String,
    pub name: String,
    pub outcome: String,
    pub duration_ms: JsNumber,
    pub attribution: String,
    pub summary: ControlApiActivitySummary,
    pub args: ControlApiText,
    pub result: ControlApiText,
    pub changes: Vec<ControlApiChange>,
}

/// One published history row (`ControlApiEvent`): common fields plus the ones its kind has.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiEvent {
    pub seq: u64,
    pub position: u64,
    pub time: u64,
    pub kind: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unreadable: Option<True>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<ControlApiText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_delivery: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<u64>,
    #[serde(rename = "final", default, skip_serializing_if = "Option::is_none")]
    pub is_final: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub conversation_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recoverable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ControlApiToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chars: Option<u64>,
}

/// `GET /v1/sessions/{id}/events`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiEvents {
    pub events: Vec<ControlApiEvent>,
    pub total: u64,
    pub next_from: u64,
}

/// What an outbox row proves about delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlApiDelivery {
    Sent,
    NotSent,
    Unconfirmed,
    Pending,
}

/// One outbox row (`ControlApiInput`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiInput {
    pub id: String,
    pub session_id: Option<String>,
    pub delivered_session_id: Option<String>,
    pub conversation_id: Option<String>,
    pub state: String,
    pub delivery: ControlApiDelivery,
    pub mode: String,
    pub transport_intent: Option<String>,
    pub automatic: bool,
    pub purpose: Option<String>,
    pub created_at: u64,
    pub due_at: u64,
    pub offered_at: Option<u64>,
    pub delivered_at: Option<u64>,
    pub send_authorized_at: Option<u64>,
    pub requires_authorization: bool,
    pub cancelled_by_user: bool,
    pub queue_order: Option<u64>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub message_id: Option<String>,
    pub error: Option<String>,
    pub text: ControlApiText,
    pub attachments: u64,
    pub images: u64,
}

/// `GET /v1/inputs`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiInputs {
    pub inputs: Vec<ControlApiInput>,
    pub total: u64,
}

/// One agent row in `GET /v1/agents`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiAgent {
    pub run_id: Option<String>,
    pub id: String,
    pub role: String,
    pub label: String,
    pub task: ControlApiText,
    pub state: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub conversation_id: Option<String>,
    pub created_at: u64,
    pub activated_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub detached_at: Option<u64>,
    pub slept_at: Option<u64>,
    pub last_seen_at: Option<u64>,
    pub revivable: bool,
    pub pending: u64,
    pub awaiting_ack: u64,
    pub delivered: u64,
    pub context_tokens: u64,
    pub result: Option<ControlApiText>,
}

/// `GET /v1/agents`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiAgents {
    pub enabled: bool,
    pub running: bool,
    pub retained_history: bool,
    pub agents: Vec<ControlApiAgent>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiLogEntry {
    pub time: u64,
    pub level: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<True>,
}

/// `GET /v1/log`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiLog {
    pub entries: Vec<ControlApiLogEntry>,
    pub ring_size: u64,
}

/// `POST /v1/inputs` body (`sendBody`, strict).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ControlApiSendRequest {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupt: Option<bool>,
}

/// `POST /v1/inputs`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiSendResult {
    pub input: ControlApiInput,
    pub replayed: bool,
}

/// `POST /v1/inputs/{id}/cancel`. The request body is `{}` (strict).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlApiCancelResult {
    pub input: ControlApiInput,
    pub cancelled: bool,
}

/// One frame of `GET /v1/sessions/{id}/events/stream`, a `text/event-stream` body
/// (`control-stream.ts`). Each frame ends with a blank line.
#[derive(Clone, Debug, PartialEq)]
pub enum EventStreamFrame {
    /// `: stream open`, written as soon as the stream starts.
    Open,
    /// `: keep-alive`, written while the chat is quiet.
    KeepAlive,
    /// A row that the paged read would return. The frame's `id` is the event's `seq`, so
    /// `Last-Event-ID` resumes after it, and its `event` is the event's `kind`.
    Event(Box<ControlApiEvent>),
    /// The last frame of a stream that the app ended, with why: `session_gone`, `error`,
    /// `max_duration`, `slow_consumer` or `stopped` today. A stream the client closed gets none.
    End(String),
}

impl EventStreamFrame {
    /// The frame as the app writes it, blank line included.
    pub fn to_text(&self) -> String {
        match self {
            Self::Open => ": stream open\n\n".to_owned(),
            Self::KeepAlive => ": keep-alive\n\n".to_owned(),
            Self::Event(event) => format!(
                "id: {}\nevent: {}\ndata: {}\n\n",
                event.seq,
                event.kind,
                serde_json::to_string(event).expect("an event always serializes")
            ),
            Self::End(reason) => format!(
                "event: end\ndata: {}\n\n",
                serde_json::json!({ "reason": reason })
            ),
        }
    }

    /// Splits a whole stream body into frames. Fails on any frame the app does not write.
    pub fn parse_stream(text: &str) -> Result<Vec<Self>, String> {
        let body = text
            .strip_suffix("\n\n")
            .ok_or("a stream ends with a blank line")?;
        body.split("\n\n").map(Self::parse).collect()
    }

    /// Parses one frame, given without its blank line.
    pub fn parse(frame: &str) -> Result<Self, String> {
        match frame.split('\n').collect::<Vec<_>>().as_slice() {
            [": stream open"] => Ok(Self::Open),
            [": keep-alive"] => Ok(Self::KeepAlive),
            ["event: end", data] => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct End {
                    reason: String,
                }
                let json = data
                    .strip_prefix("data: ")
                    .ok_or("an end frame has a data line")?;
                let end: End =
                    serde_json::from_str(json).map_err(|error| format!("end frame: {error}"))?;
                Ok(Self::End(end.reason))
            }
            [id, event, data] => {
                let id = id
                    .strip_prefix("id: ")
                    .ok_or("an event frame starts with its id")?;
                let kind = event
                    .strip_prefix("event: ")
                    .ok_or("an event frame names its event")?;
                let json = data
                    .strip_prefix("data: ")
                    .ok_or("an event frame has a data line")?;
                let parsed: ControlApiEvent =
                    serde_json::from_str(json).map_err(|error| format!("event frame: {error}"))?;
                if id != parsed.seq.to_string() || kind != parsed.kind {
                    return Err(format!(
                        "frame id {id} and event {kind} do not match its data"
                    ));
                }
                Ok(Self::Event(Box::new(parsed)))
            }
            _ => Err(format!("not a frame the app writes: {frame:?}")),
        }
    }
}
