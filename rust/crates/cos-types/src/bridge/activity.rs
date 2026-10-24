//! `GET /activity`: the feed every open ChatGPT tab polls for its own chat (`bridge.ts`).

use serde::{Deserialize, Serialize};

use super::{ActivityOutcome, ContextView, RevivalEntry};
use crate::config::{GoalBackend, GoalMode, GoalProviderKind};
use crate::json::{EmptyList, JsNumber, True, nullable, string_enum};
use crate::session::{
    ActivitySummary, AgentMessageDelivery, CallAttribution, FileChange, MessageState,
    ReasoningEffort, SessionOriginKind, ToolOutcome, ToolProcess, TurnOutcome,
};
use crate::state::{ContinuationDestinationCheckpoint, ContinuationSendCheckpoint, RetiredChat};

/// `GET /activity` reply. The page asks with `conversationId`, `since` and a few flags in the
/// query string, so there is no body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ActivityReply {
    /// The recorder holds this chat.
    Attached(Box<AttachedActivity>),
    /// No recorded session holds this chat yet; what drives it is still reported.
    Detached(Box<DetachedActivity>),
}

/// The feed of a chat the recorder holds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedActivity {
    pub session_id: String,
    pub generating: bool,
    /// What the currently attached chat carries, not the session's lifetime total.
    pub tokens: u64,
    pub context: ContextView,
    pub follow_output: bool,
    pub mention_core: bool,
    /// Why the app opened this chat, so the page can fold its first user message away.
    pub bootstrap: Option<SessionOriginKind>,
    pub bootstrap_agent: Option<String>,
    pub bootstrap_message_id: Option<String>,
    /// Legacy tool-only view for the old native-row relabeller.
    pub entries: Vec<ActivityEntry>,
    pub stream: Vec<StreamItem>,
    pub user_anchors: Vec<UserAnchor>,
    pub reset_activity: bool,
    pub truncated_from: Option<u64>,
    pub next_since: JsNumber,
    pub job: Option<ResumeJob>,
    pub goal: ActivityGoal,
    pub pending_tools: u64,
    pub progress: ConversationProgress,
    pub settling_tools: u64,
    pub active_turn_id: Option<String>,
    pub recorded_turn_id: Option<String>,
    pub recorded_question_id: Option<String>,
    pub settled_question_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_turn: Option<StopTurn>,
    pub revival: Option<RevivalEntry>,
    pub revivals: Vec<RevivalEntry>,
    pub placement: Option<BrowserPlacement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_worker: Option<RetiredChat>,
}

/// The feed of a chat no recorded session holds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedActivity {
    /// Always `null`.
    pub session_id: (),
    pub entries: EmptyList,
    pub stream: EmptyList,
    pub user_anchors: EmptyList,
    /// Always `null`.
    pub bootstrap_message_id: (),
    pub next_since: JsNumber,
    /// Always `null`.
    pub job: (),
    pub progress: ConversationProgress,
    pub goal: ActivityGoal,
    /// Present for a worker or superseded chat, always with `auto` off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_worker: Option<RetiredChat>,
}

/// One recorded tool call in the legacy `entries` view. No raw arguments or results.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub seq: u64,
    pub time: u64,
    pub tool: String,
    pub call_id: String,
    pub detail_revision: u64,
    pub turn_id: Option<String>,
    pub request_id: Option<String>,
    pub attribution: CallAttribution,
    pub outcome: ToolOutcome,
    pub display_outcome: ActivityOutcome,
    pub duration_ms: Option<JsNumber>,
    pub summary: ActivitySummary,
    pub changes: Vec<FileChange>,
    pub agent: Option<String>,
}

/// Fields every `stream` row carries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamBase {
    /// For a superseding row, the seq of the row it replaces.
    pub seq: u64,
    pub time: u64,
    pub turn_id: Option<String>,
    pub agent: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub turn_origin: Option<Option<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_at: Option<JsNumber>,
}

/// One row of the app-owned transcript feed the page renders in order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamItem {
    ToolCall(Box<StreamToolCall>),
    #[serde(rename_all = "camelCase")]
    Progress {
        #[serde(flatten)]
        base: StreamBase,
        text: String,
        progress_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    PageTool {
        #[serde(flatten)]
        base: StreamBase,
        label: String,
        message_id: String,
    },
    AssistantMessage(Box<StreamAssistantMessage>),
    #[serde(rename_all = "camelCase")]
    AgentMessage {
        #[serde(flatten)]
        base: StreamBase,
        from: String,
        to: String,
        text: String,
        delivery: AgentMessageDelivery,
        message_id: String,
    },
    ChatError {
        #[serde(flatten)]
        base: StreamBase,
        text: String,
    },
    TurnStart {
        #[serde(flatten)]
        base: StreamBase,
    },
    TurnEnd {
        #[serde(flatten)]
        base: StreamBase,
        outcome: TurnOutcome,
        /// Empty when the end carried none.
        detail: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamToolCall {
    #[serde(flatten)]
    pub base: StreamBase,
    pub tool: String,
    pub call_id: String,
    pub detail_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ToolProcess>,
    pub request_id: Option<String>,
    pub attribution: CallAttribution,
    pub outcome: ToolOutcome,
    pub display_outcome: ActivityOutcome,
    pub duration_ms: Option<JsNumber>,
    pub summary: ActivitySummary,
    pub changes: Vec<FileChange>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamAssistantMessage {
    #[serde(flatten)]
    pub base: StreamBase,
    pub text: String,
    /// Empty when ChatGPT's rendering was not recorded.
    pub rendered_html: String,
    pub state: MessageState,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub message_id: Option<String>,
    pub provider_message_id: Option<String>,
    pub origin: u64,
}

/// A user message the page authored: identity and order only, never its text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAnchor {
    pub seq: u64,
    pub time: u64,
    pub message_id: String,
}

/// A stop command waiting for this chat's turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopTurn {
    pub turn_id: String,
    pub user_message_id: Option<String>,
}

/// Where a chat the app opened should appear (`pendingBrowserPlacement`). Collected once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPlacement {
    pub id: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<True>,
    pub active: bool,
    pub home_conversation_id: Option<String>,
    pub project: Option<String>,
}

/// What this chat is waiting on, for the page to say instead of spinning.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationProgress {
    pub tools: Option<ToolProgress>,
    pub workers: Option<WorkerProgress>,
}

/// Local calls this chat still has running (`runningToolProgress`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolProgress {
    pub count: u64,
    pub since: u64,
}

/// A prime's workers, counted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerProgress {
    pub total: u64,
    pub active: u64,
    pub finished: u64,
    pub failed: u64,
    /// Up to three active workers' labels.
    pub names: Vec<String>,
}

string_enum! {
    /// `ResumeStage`.
    pub enum ResumeStage {
        HandoffPending = "handoff-pending", Opening = "opening",
        WaitingForBrowser = "waiting-for-browser", Done = "done", Failed = "failed",
    }
}

/// `ResumeJobView`: one Compact & Resume, read off its continuation transaction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeJob {
    pub session_id: String,
    pub token: String,
    pub stage: ResumeStage,
    pub started_at: u64,
    pub automatic: bool,
    pub busy: bool,
    pub handoff_id: Option<String>,
    pub source_send: ContinuationSendCheckpoint,
    pub destination_send: ContinuationDestinationCheckpoint,
    pub error: Option<String>,
}

string_enum! {
    /// Why the Goal/Loop switch is drawn off when nobody turned it off. Empty when it is not.
    pub enum GoalBlockReason {
        None = "", Worker = "worker", Blocked = "blocked", Continued = "continued",
    }
}

string_enum! {
    /// `GoalWait['reason']`.
    pub enum GoalWaitReason {
        Tools = "tools", Workers = "workers", Quiet = "quiet", Silence = "silence",
        Listening = "listening", NativeBusy = "native-busy", Settling = "settling", Closed = "closed",
    }
}

/// `GoalWait`: why the next Goal/Loop step has not started.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalWait {
    pub reason: GoalWaitReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<u64>,
}

/// The Goal/Loop state one chat's composer shows (`goalView` in `bridge.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityGoal {
    pub enabled: bool,
    pub configured_enabled: bool,
    pub after_turn: bool,
    pub pro_loop_delivery: bool,
    pub own: bool,
    pub mode: GoalMode,
    pub backend: GoalBackend,
    pub model: String,
    pub provider: GoalProviderKind,
    pub has_key: bool,
    pub queue_pending: bool,
    pub wait: Option<GoalWait>,
    pub objective: String,
    pub blocked: GoalBlockReason,
    pub pending: Option<GoalPendingReply>,
    pub draft: Option<GoalDraftView>,
}

/// The crash-durable reply a chat still owes one Goal decision (`goalPendingReplyFor`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalPendingReply {
    pub reply_id: String,
    pub turn_id: String,
    pub event_seq: u64,
    pub accepted_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explicit_activation: Option<True>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_source_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_until: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_pro: Option<True>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_attempts: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_next_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_stopped_at: Option<u64>,
}

string_enum! {
    /// `GoalStage`.
    pub enum GoalStage {
        Sending = "sending", Answering = "answering", Ready = "ready", NoReply = "no-reply", Failed = "failed",
    }
}

/// `GoalDraftView`: the one draft a chat's finished turn gets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalDraftView {
    pub token: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub stage: GoalStage,
    pub backend: GoalBackend,
    pub model: String,
    pub text: String,
    /// The message to type; empty except at `ready`.
    pub reply: String,
    pub error: Option<String>,
    /// Present exactly when `error` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub message_key: Option<Option<String>>,
    pub retryable: bool,
}
