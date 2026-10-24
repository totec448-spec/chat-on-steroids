//! The session store under `sessions/<id>/` (`src/shared/session.ts`, `src/main/session/store.ts`).
//!
//! `events.jsonl` lines and `messages/<sha256>.json` shards are both [`SessionEvent`]s; the
//! shards hold only the canonical kinds (`user_message`, `assistant_message`, `native_image`,
//! `tool_call`). `meta.json` is a [`SessionMeta`], `handoffs/<id>.json` a [`Handoff`],
//! `plan.json` an [`AgentPlan`] and `traces/<turnId>.json` a [`TurnTrace`].

use serde::{Deserialize, Serialize};

use crate::ids::SessionId;
use crate::json::{Extra, JsNumber, Record, True, nullable, string_enum};

string_enum! {
    /// Canonical reasoning levels (`REASONING_EFFORTS`); `pro` is ChatGPT's browser Power tier.
    pub enum ReasoningEffort {
        Pro = "pro", None = "none", Minimal = "minimal", Low = "low", Medium = "medium",
        High = "high", Xhigh = "xhigh", Max = "max", Ultra = "ultra",
    }
}

string_enum! {
    /// Where an event came from. The extension is untrusted UI observation; `mcp` is the app's own.
    pub enum EventSource { Extension = "extension", Mcp = "mcp", App = "app" }
}

string_enum! {
    /// How a ChatGPT turn ended.
    pub enum TurnOutcome {
        Completed = "completed", Failed = "failed", Stopped = "stopped",
        Interrupted = "interrupted", Stalled = "stalled", Unknown = "unknown",
    }
}

/// Text stored in an event, with an explicit note when it was cut (`StoredText`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredText {
    pub text: String,
    pub truncated: bool,
    pub chars: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A screenshot or other binary kept beside the log (`AssetRef`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
    pub id: String,
    pub mime_type: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum ActivityTone { Neutral = "neutral", Good = "good", Bad = "bad", Warn = "warn" }
}

string_enum! {
    /// Family an activity row belongs to (`ActivitySummary['kind']`).
    pub enum ActivityKind {
        Edit = "edit", Create = "create", Delete = "delete", Move = "move", Read = "read",
        Search = "search", Browse = "browse", Run = "run", Process = "process", Screen = "screen",
        Input = "input", Clipboard = "clipboard", Session = "session", Agent = "agent", Other = "other",
    }
}

/// Compact human-readable presentation of one tool call (`ActivitySummary`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivitySummary {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    pub tone: ActivityTone,
    pub kind: ActivityKind,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum ReviewUnavailable { TooLarge = "too-large", NotKept = "not-kept" }
}

/// One file a tool call changed (`FileChange`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub added: u64,
    pub removed: u64,
    pub approximate: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_unavailable: Option<ReviewUnavailable>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    /// Only `tool_internal_error` is a connector defect.
    ///
    /// `error` and `rejected` are what older builds wrote. They stay readable so an old journal
    /// round-trips; `normalizedToolOutcome` in `shared/session.ts` maps them for display.
    pub enum ToolOutcome {
        Ok = "ok", ProcessExitNonzero = "process_exit_nonzero", ToolRejected = "tool_rejected",
        ToolExecutionError = "tool_execution_error", ToolInternalError = "tool_internal_error",
        LegacyError = "error", LegacyRejected = "rejected",
    }
}

string_enum! {
    /// How confident the recorder is that a call belongs to its session (`CallAttribution`).
    pub enum CallAttribution {
        RequestId = "request_id", Unattributed = "unattributed", Superseded = "superseded",
        Turn = "turn", Agent = "agent", Generation = "generation", Inferred = "inferred",
    }
}

string_enum! {
    pub enum AttributionMethod { RequestId = "request_id", Unattributed = "unattributed", Superseded = "superseded" }
}

/// Child process lifetime of an `exec_command` call (`ToolCallRecord['process']`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProcess {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub exit_code: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<JsNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub benign_exit: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One recorded MCP tool call (`ToolCallRecord`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nested: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ToolProcess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    pub call_id: String,
    pub tool: String,
    pub attribution: CallAttribution,
    pub request_id: Option<String>,
    pub conversation_id: Option<String>,
    pub attribution_method: AttributionMethod,
    pub args: StoredText,
    pub result: StoredText,
    pub outcome: ToolOutcome,
    pub duration_ms: JsNumber,
    pub summary: ActivitySummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<Vec<FileChange>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<Vec<AssetRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_image_asset_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_activity: Option<True>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum MessageState { Streaming = "streaming", Final = "final" }
}

/// A cited source as the citation pill holds it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReferenceSource {
    pub title: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// The sources one inline citation names (`MessageReference`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageReference {
    pub index: u64,
    pub sources: Vec<ReferenceSource>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Upload metadata without a local path (`shared/input.ts` `InputAttachment`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputAttachment {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Fields every event carries (`BaseEvent`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventBase {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    /// 1-based, strictly increasing within a session.
    pub seq: u64,
    pub time: u64,
    /// Provider timestamp; ChatGPT's `create_time` in ms, which can carry a fraction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_at: Option<JsNumber>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub turn_origin: Option<Option<u64>>,
    pub source: EventSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

/// One line of `events.jsonl`, or one canonical message shard (`SessionEvent`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    SessionStart(SessionStartEvent),
    UserMessage(UserMessageEvent),
    AssistantMessage(AssistantMessageEvent),
    NativeImage(NativeImageEvent),
    Progress(ProgressEvent),
    PageTool(PageToolEvent),
    TurnStart(TurnStartEvent),
    TurnEnd(TurnEndEvent),
    ChatError(ChatErrorEvent),
    /// Boxed: a recorded call is several times the size of every other event.
    ToolCall(Box<ToolCallEvent>),
    Note(NoteEvent),
    AgentMessage(AgentMessageEvent),
    Handoff(HandoffEvent),
}

impl SessionEvent {
    /// The fields every kind shares.
    pub fn base(&self) -> &EventBase {
        match self {
            Self::SessionStart(event) => &event.base,
            Self::UserMessage(event) => &event.base,
            Self::AssistantMessage(event) => &event.base,
            Self::NativeImage(event) => &event.base,
            Self::Progress(event) => &event.base,
            Self::PageTool(event) => &event.base,
            Self::TurnStart(event) => &event.base,
            Self::TurnEnd(event) => &event.base,
            Self::ChatError(event) => &event.base,
            Self::ToolCall(event) => &event.base,
            Self::Note(event) => &event.base,
            Self::AgentMessage(event) => &event.base,
            Self::Handoff(event) => &event.base,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub conversation_id: Option<String>,
    pub title: String,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum InputDelivery { Offered = "offered", Confirmed = "confirmed" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessageEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub message: StoredText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_delivery: Option<InputDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wire_token_estimate: Option<JsNumber>,
    /// Missing means unobserved; `null` means ChatGPT showed no badge.
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub reaction: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<InputAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<Vec<AssetRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_image_asset_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_seq: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessageEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub message: StoredText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendered_html: Option<StoredText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<MessageReference>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<MessageState>,
    /// Compatibility mirror of `state === 'final'`.
    #[serde(rename = "final")]
    pub is_final: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_eligible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_content_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_observed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_seq: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum ProviderRole { Tool = "tool", Assistant = "assistant" }
}
string_enum! {
    pub enum ProviderChannel { Final = "final" }
}
string_enum! {
    pub enum ProviderStatus { InProgress = "in_progress", FinishedSuccessfully = "finished_successfully" }
}
string_enum! {
    pub enum PreviewStatus { Pending = "pending", Available = "available", Unavailable = "unavailable" }
}
string_enum! {
    pub enum PreviewError {
        NotLoaded = "not_loaded", Ambiguous = "ambiguous", Tainted = "tainted", Oversized = "oversized",
        Invalid = "invalid", Quota = "quota", Removed = "removed",
    }
}

/// ChatGPT-native generated media (`kind: 'native_image'`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImageEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub message_id: String,
    pub provider_asset_id: String,
    pub provider_role: ProviderRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_channel: Option<ProviderChannel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_status: Option<ProviderStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_width: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_height: Option<u64>,
    pub preview_status: PreviewStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_error: Option<PreviewError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<AssetRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum FinishControlState { Released = "released", Notified = "notified", Decision = "decision" }
}

/// A finish receipt attached to a progress caption.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishControl {
    pub state: FinishControlState,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_seq: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One visible ChatGPT commentary snapshot (`kind: 'progress'`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub message: StoredText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_control: Option<FinishControl>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// ChatGPT-native tool activity that never passed through this MCP server.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageToolEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub message_id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_seq: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TurnStartEvent {
    #[serde(flatten)]
    pub base: EventBase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum TurnEndReason { ThinkingFailed = "thinking_failed" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEndEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub outcome: TurnOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<TurnEndReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued: Option<True>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum ChatErrorReason { ThinkingFailed = "thinking_failed", StreamGone = "stream_gone" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatErrorEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub message: StoredText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recoverable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ChatErrorReason>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCallEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub call: ToolCallRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NoteEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub message: StoredText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum AgentMessageDelivery { Sent = "sent", Delivered = "delivered" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub message_id: String,
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_run_id: Option<String>,
    pub message: StoredText,
    pub delivery: AgentMessageDelivery,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffEvent {
    #[serde(flatten)]
    pub base: EventBase,
    pub handoff_id: String,
    pub chars: u64,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum SessionOriginKind { Resume = "resume", Worker = "worker", Helper = "helper", Desktop = "desktop" }
}

/// How a chat came to exist, when this app opened it (`SessionOrigin`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOrigin {
    pub kind: SessionOriginKind,
    pub from_session_id: Option<String>,
    pub agent_id: Option<String>,
    pub task: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Historical worker presentation projected from an accepted broker snapshot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerAssignmentSummary {
    pub conversation_id: String,
    pub agent_id: String,
    pub label: String,
    pub task: String,
    pub recorded_at: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One response turn's transcript boundaries (`chronology.ts` `TimelineTurns[id]`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTurn {
    pub origin: u64,
    pub time: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_time: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_origin: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued: Option<True>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Request-to-turn proof (`RequestTurns[id]`); `null` records a conflict.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestTurn {
    pub turn_id: String,
    pub conversation_id: String,
    pub origin: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Rebuildable native question boundary.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeQuestion {
    pub message_id: String,
    pub origin: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum TitleSource { Fallback = "fallback", Provider = "provider", Manual = "manual" }
}
string_enum! {
    pub enum AutoTitleSource { Fallback = "fallback", Provider = "provider" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AutoTitle {
    pub title: String,
    pub source: AutoTitleSource,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Latest proven native picker selection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedModel {
    pub conversation_id: String,
    pub model: String,
    pub observed_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `Pick<ActivitySummary, 'kind' | 'title'>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolActivity {
    pub kind: ActivityKind,
    pub title: String,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoCompactionRefusal {
    pub conversation_id: String,
    pub turn_id: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Constant-size projection of app finish receipts for the newest turn.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishTurn {
    pub turn_id: String,
    pub conversation_id: Option<String>,
    pub started_at: u64,
    pub notified: bool,
    pub released: bool,
    pub decision_revision: Option<String>,
    pub work_seq: u64,
    pub decision_seq: u64,
    pub decision_input_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_at: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// The durable summary of one session (`SessionSummary`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_turns: Option<Record<TimelineTurn>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_turns: Option<Record<Option<RequestTurn>>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub native_question: Option<Option<NativeQuestion>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_source: Option<TitleSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_title: Option<AutoTitle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<SelectedModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub id: SessionId,
    pub title: String,
    pub conversation_id: Option<String>,
    pub chat_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_chat_at: Option<Record<u64>>,
    pub started_at: u64,
    pub updated_at: u64,
    pub ended_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_recovery_dismissed_at: Option<u64>,
    pub events: u64,
    pub user_messages: u64,
    pub tool_calls: u64,
    pub last_tool_call_at: Option<u64>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_tool_activity: Option<Option<ToolActivity>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_assignment: Option<WorkerAssignmentSummary>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_assistant_final_at: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_turn_end_at: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub activity_expires_at: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_finish_report_at: Option<Option<u64>>,
    pub process_exit_nonzero: u64,
    pub tool_rejected: u64,
    pub tool_internal_errors: u64,
    pub errors: u64,
    pub estimated_tokens: u64,
    pub context_tokens: u64,
    pub last_handoff_id: Option<String>,
    pub last_handoff_at: Option<u64>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_committed_resume_handoff_id: Option<Option<String>>,
    pub last_turn_outcome: Option<TurnOutcome>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub active_turn_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compaction_refusal: Option<AutoCompactionRefusal>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub finish_turn: Option<Option<FinishTurn>>,
    pub agents: Vec<String>,
    pub origin: Option<SessionOrigin>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `meta.json`: the summary plus the store's private checkpoint fields (`PersistedSummary`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    #[serde(flatten)]
    pub summary: SessionSummary,
    /// Highest durable journal/message seq the summary reflects.
    #[serde(
        rename = "__historySeq",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub history_seq: Option<u64>,
    #[serde(
        rename = "__canonicalProjection",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub canonical_projection: Option<u64>,
    #[serde(
        rename = "__tokenEstimate",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub token_estimate: Option<u64>,
}

/// Where a handoff brief came from (`HandoffProvenance`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffProvenance {
    pub source_conversation_id: Option<String>,
    pub source_generation: Option<u64>,
    pub source_turn_id: Option<String>,
    pub continuation_id: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `handoffs/<id>.json` (`Handoff`). `version` is absent on legacy handoffs and `1` otherwise.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<HandoffVersion>,
    pub id: String,
    pub session_id: SessionId,
    pub created_at: u64,
    pub text: String,
    pub source_events: u64,
    pub source_tokens: u64,
    pub notes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<HandoffProvenance>,
    #[serde(flatten)]
    pub extra: Extra,
}

crate::json::literal_version!(
    /// `Handoff.version`, the only versioned handoff format.
    pub struct HandoffVersion = 1
);

string_enum! {
    pub enum PlanStepStatus { Pending = "pending", InProgress = "in_progress", Completed = "completed" }
}

/// One step of the agent's displayed plan. Zod `.strict()`: no other keys are written or read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanStep {
    pub step: String,
    pub status: PlanStepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

/// The `update_plan` tool's arguments (`agentPlanUpdateSchema`, strict).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentPlanUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    pub plan: Vec<PlanStep>,
}

/// `plan.json` (`agentPlanSchema`, strict).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentPlan {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    pub plan: Vec<PlanStep>,
    pub updated_at: JsNumber,
}

/// One item of ChatGPT's own outline of a turn (`TurnTraceItem`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnTraceItem {
    Say {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        text: String,
        done: bool,
    },
    Call {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool: Option<String>,
        done: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
    },
    Exec {
        id: String,
        done: bool,
    },
    Recap {
        text: String,
    },
    Answer {
        id: String,
    },
    Now {
        text: String,
    },
}

/// `traces/<turnId>.json`.
pub type TurnTrace = Vec<TurnTraceItem>;

string_enum! {
    pub enum AgentRole { Prime = "prime", Worker = "worker" }
}

string_enum! {
    /// Where an agent is in its life (`AgentState`).
    pub enum AgentState {
        Invited = "invited", Active = "active", Detached = "detached", Waking = "waking",
        Sleeping = "sleeping", Finished = "finished", Failed = "failed",
    }
}

/// One agent in a prime family (`AgentInfo`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_allocation_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_worktree: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_worktree_cleaned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prime_conversation_id: Option<String>,
    pub id: String,
    pub role: AgentRole,
    pub label: String,
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_title: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub model: Option<String>,
    pub state: AgentState,
    pub created_at: u64,
    pub activated_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub result: Option<String>,
    pub pending: u64,
    pub awaiting_ack: u64,
    pub delivered: u64,
    pub conversation_id: Option<String>,
    pub detached_at: Option<u64>,
    pub last_seen_at: Option<u64>,
    pub revivable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_parked: Option<bool>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub silence_recovery_turn_id: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub silence_recovery_request_origin_max: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_revival_command_id: Option<Option<String>>,
    pub slept_at: Option<u64>,
    pub context_tokens: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One brokered message, delivered at least once (`AgentMessage`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_run_id: Option<String>,
    pub time: u64,
    pub text: String,
    pub offered_at: Option<u64>,
    pub offers: u64,
    pub offered_on_finish: bool,
    pub offered_via_revival: bool,
    pub acked_at: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// The swarm as the renderer and IPC see it (`SwarmState`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmState {
    pub enabled: bool,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_history: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_workers: Option<Vec<AgentInfo>>,
    pub agents: Vec<AgentInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_reaction_and_a_null_reaction_stay_different() {
        let base = r#""seq":1,"time":2,"source":"extension","message":{"text":"hi","truncated":false,"chars":2},"kind":"user_message""#;
        let absent: SessionEvent =
            serde_json::from_str(&format!("{{{base}}}")).expect("absent parses");
        let null: SessionEvent =
            serde_json::from_str(&format!("{{{base},\"reaction\":null}}")).expect("null parses");
        let (SessionEvent::UserMessage(absent), SessionEvent::UserMessage(null)) = (absent, null)
        else {
            panic!("both are user messages");
        };
        assert_eq!(absent.reaction, None);
        assert_eq!(null.reaction, Some(None));
        let written = serde_json::to_value(SessionEvent::UserMessage(null)).expect("serializes");
        assert_eq!(written["reaction"], serde_json::Value::Null);
    }

    #[test]
    fn unknown_event_fields_survive_a_round_trip() {
        let text = r#"{"kind":"turn_start","seq":3,"time":4,"source":"app","futureField":{"a":1}}"#;
        let event: SessionEvent = serde_json::from_str(text).expect("parses");
        let back = serde_json::to_value(&event).expect("serializes");
        assert_eq!(back["futureField"]["a"], 1);
        assert_eq!(back["kind"], "turn_start");
    }
}
