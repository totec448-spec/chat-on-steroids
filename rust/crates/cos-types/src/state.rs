//! Durable ledgers under `userData/state/<name>.json` (`src/main/durable.ts`).
//!
//! Each file is one `JSON.stringify` of the owner's snapshot, written temp-then-rename. The
//! owners tolerate damage row by row (`restoreBlockedChats` skips a bad id, the outbox refuses
//! the whole file); that policy stays with the owner. These types describe what the owners
//! write, and read it back exactly.

use serde::{Deserialize, Serialize};

use crate::ids::{ChatgptProjectId, ConnectorAppId, ConversationId};
use crate::json::{Extra, JsNumber, Record, True, literal_version, nullable, string_enum};
use crate::session::{AgentInfo, AgentMessage, AgentPlanUpdate, InputAttachment, ReasoningEffort};

literal_version!(
    /// Version of the files whose owners only ever wrote `1`.
    pub struct V1 = 1
);

// ---------------------------------------------------------------- blocked-chats, trusted-chats

/// `state/blocked-chats.json` (`session/blocked-chats.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BlockedChats {
    pub version: V1,
    pub entries: Vec<BlockedChat>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedChat {
    pub conversation_id: ConversationId,
    pub blocked_at: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `state/trusted-chats.json` (`session/trusted-chats.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrustedChats {
    pub version: V1,
    pub entries: Vec<ConversationId>,
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------- request-correlations, request-plans

/// `state/request-correlations.json` (`session/correlation.ts`, version 6; 3..=5 still read).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RequestCorrelations {
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    pub entries: Vec<CorrelationEntry>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One ledger row: a bare owner (versions 5 and 6) or the older wrapper (versions 3 and 4).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CorrelationEntry {
    Owner(RequestCorrelation),
    Wrapped(WrappedCorrelation),
}

/// A version 3 or 4 row: the owner, or `null` for an id once marked unusable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrappedCorrelation {
    pub request_id: String,
    pub value: Option<RequestCorrelation>,
    pub conflicted: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One proven request owner (`RequestCorrelation`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestCorrelation {
    pub request_id: String,
    pub conversation_id: String,
    pub session_id: String,
    pub message_id: String,
    pub tool: String,
    pub observed_at: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `state/request-plans.json` (`session/request-plans.ts`): plans accepted before their owner was known.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RequestPlans {
    pub version: V1,
    pub entries: Vec<PendingRequestPlan>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequestPlan {
    pub request_id: String,
    pub update: AgentPlanUpdate,
    pub started_at: u64,
    pub stored_at: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------- continuations

/// `state/continuations.json`, the Compact & Resume write-ahead log (`session/continuation.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Continuations {
    pub version: V1,
    pub saved_at: u64,
    pub entries: Vec<ContinuationRecord>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum ContinuationState {
        AwaitingSummary = "awaiting-summary", AwaitingChat = "awaiting-chat", Claimed = "claimed",
        Committing = "committing", Committed = "committed", Aborted = "aborted",
    }
}

string_enum! {
    /// The four durable positions of one prompt, in order.
    pub enum ContinuationSendState {
        NotAttempted = "not-attempted", AttemptedUnresolved = "attempted-unresolved",
        DispatchedUnresolved = "dispatched-unresolved", Sent = "sent",
    }
}

/// `ContinuationSendCheckpoint`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationSendCheckpoint {
    pub state: ContinuationSendState,
    pub message_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub before: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatched_at: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `ContinuationDestinationCheckpoint`: the send checkpoint plus chat B once it is known.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationDestinationCheckpoint {
    pub conversation_id: Option<String>,
    #[serde(flatten)]
    pub send: ContinuationSendCheckpoint,
}

/// Frozen source selection intent for the replacement chat.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedModel {
    pub model: String,
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One Compact & Resume transaction (`ContinuationRecord`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationRecord {
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub requested_model: Option<Option<RequestedModel>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_turn_id: Option<Option<String>>,
    pub token: String,
    pub session_id: String,
    pub from: String,
    pub to: Option<String>,
    pub opened_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub touched_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_progress: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automatic: Option<bool>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub asked_at: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub project: Option<Option<String>>,
    pub state: ContinuationState,
    pub summary: String,
    pub handoff_id: Option<String>,
    pub claimed_by: Option<String>,
    /// Legacy pre-checkpoint arm flag, read only when migrating an older record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_send: Option<ContinuationSendCheckpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_send: Option<ContinuationDestinationCheckpoint>,
    pub error: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------- goal-replies, goal-objectives, goal-switches

string_enum! {
    pub enum GoalReplyState { Pending = "pending", Handled = "handled" }
}

/// `state/goal-replies.json` (`goal.ts` `GoalRepliesSnapshot`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalReplies {
    pub version: V1,
    pub saved_at: u64,
    pub replies: Vec<GoalReplyObligation>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A finished reply the Goal loop still owes a decision (`GoalReplyObligation`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalReplyObligation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explicit_activation: Option<True>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_source_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_pro: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_until: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_stop_claimed: Option<True>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_attempts: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_next_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_stopped_at: Option<u64>,
    pub conversation_id: ConversationId,
    pub session_id: String,
    pub reply_id: String,
    pub turn_id: String,
    pub event_seq: u64,
    pub accepted_at: u64,
    pub state: GoalReplyState,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `state/goal-objectives.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalObjectives {
    pub version: V1,
    pub saved_at: u64,
    pub objectives: Vec<GoalObjective>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalObjective {
    pub conversation_id: String,
    pub objective: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `state/goal-switches.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSwitches {
    pub version: V1,
    pub saved_at: u64,
    pub switches: Vec<GoalSwitch>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum GoalSwitchRole { Decision = "decision" }
}

/// One chat's own Goal/Loop switch (`{ conversationId } & GoalSwitchRow`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSwitch {
    pub conversation_id: String,
    pub enabled: bool,
    pub mode: crate::config::GoalMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_turn: Option<bool>,
    pub at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<GoalSwitchRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<GoalSwitchContext>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GoalSwitchContext {
    pub count: u64,
    pub hash: String,
    pub instructions: String,
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------- session-input

/// `state/session-input.json`: the durable outbox, one row per message (`session/input.ts`).
pub type SessionInput = Vec<InputEntry>;

string_enum! {
    pub enum InputMode { Auto = "auto", AfterTurn = "after-turn", Finish = "finish" }
}
string_enum! {
    pub enum InputAutomation { Off = "off", Goal = "goal", Loop = "loop" }
}
string_enum! {
    pub enum AuthoredSource { Text = "text", Objective = "objective", None = "none" }
}
string_enum! {
    pub enum ToolDelivery { Tool = "tool" }
}
string_enum! {
    pub enum InputState {
        Queued = "queued", Browser = "browser", Tool = "tool", Sent = "sent",
        Cancelled = "cancelled", Failed = "failed", Decision = "decision",
    }
}
string_enum! {
    pub enum TransportIntent { Tool = "tool", Browser = "browser" }
}
string_enum! {
    pub enum InputPurpose { User = "user", Decision = "decision" }
}
string_enum! {
    pub enum InputLifetime { TemporaryPlanner = "temporary-planner" }
}
string_enum! {
    pub enum RecoveryPhase { Ready = "ready", Stopping = "stopping", Reloading = "reloading", Resumed = "resumed" }
}
string_enum! {
    pub enum RecoveryEnded { PageFinal = "page-final" }
}

/// An image the composer normalized to WebP (`InputImage`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputImage {
    pub name: String,
    pub data_url: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A frozen automatic Skill routing decision.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutoSkill {
    pub id: String,
    pub revision: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceBoundary {
    pub turn_id: String,
    pub conversation_id: String,
    pub work_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_until: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_busy: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTurn {
    pub conversation_id: String,
    pub turn_id: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Shared unfinished-response fallback for one question.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRecovery {
    pub question_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<String>,
    pub pro: bool,
    pub busy_until: u64,
    pub phase: RecoveryPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reload_owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawn_since: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<RecoveryEnded>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectTurn {
    pub id: String,
    pub started_at: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishOwner {
    pub turn_id: String,
    pub periodic: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<crate::config::GoalMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_requested: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickupRecovery {
    pub attempts: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One outbox row (`InputEntry`, `entrySchema` in `session/input.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputEntry {
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub project_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation: Option<InputAutomation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_after_turn: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_source: Option<AuthoredSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stages: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<InputImage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<InputAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<ToolDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_delivery: Option<ToolDelivery>,
    pub id: String,
    pub session_id: Option<String>,
    pub text: String,
    pub mode: InputMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_turn: Option<bool>,
    pub due_at: u64,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opening: Option<True>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub requested_session_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_skills: Option<Vec<AutoSkill>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_images: Option<Vec<InputImage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_boundary: Option<SilenceBoundary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_turn: Option<QueuedTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<InputRecovery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_turn: Option<DirectTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_owner: Option<FinishOwner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_mode: Option<InputMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport_intent: Option<TransportIntent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub companion_input_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<InputPurpose>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<InputLifetime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_source_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
    pub state: InputState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offered_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_authorized_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_authorization: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_failed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_retry_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_taken_retries: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pickup_recovery: Option<PickupRecovery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled_by_user: Option<True>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub owner: Option<String>,
    pub created_at: u64,
    pub conversation_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub delivered_session_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stages_applied: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_recorded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_anchored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_order: Option<u64>,
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------- bridge-commands

/// `state/bridge-commands.json` (`bridge.ts` `DurableCommandSnapshot`, version 4).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeCommands {
    pub version: BridgeCommandsVersion,
    pub commands: Vec<DurableCommandRecord>,
    pub receipts: Vec<CommandReceipt>,
    #[serde(flatten)]
    pub extra: Extra,
}

literal_version!(
    /// The bridge command ledger format this build writes. Versions 1-3 migrate in the owner.
    pub struct BridgeCommandsVersion = 4
);

/// What the extension is asked to do (`CommandSpec`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CommandSpec {
    #[serde(rename_all = "camelCase")]
    Worker {
        agent: String,
        task: String,
        model: Option<String>,
        reasoning_effort: Option<ReasoningEffort>,
        run_id: String,
        #[serde(flatten)]
        extra: Extra,
    },
    #[serde(rename_all = "camelCase")]
    Revive {
        agent: String,
        conversation_id: String,
        run_id: String,
        wake: String,
        #[serde(flatten)]
        extra: Extra,
    },
    #[serde(rename_all = "camelCase")]
    Resume {
        session_id: String,
        token: String,
        #[serde(flatten)]
        extra: Extra,
    },
    #[serde(rename_all = "camelCase")]
    Stop {
        session_id: String,
        conversation_id: String,
        turn_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user_message_id: Option<String>,
        #[serde(flatten)]
        extra: Extra,
    },
}

string_enum! {
    pub enum CommandPhase { Queued = "queued", Leased = "leased" }
}
string_enum! {
    pub enum CommandReceiptOutcome { Committed = "committed", TerminalFailure = "terminal-failure" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableCommandRecord {
    pub id: String,
    pub spec: CommandSpec,
    pub created_at: u64,
    pub phase: CommandPhase,
    pub claimed_at: Option<u64>,
    pub owner: Option<String>,
    pub last_error: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReceipt {
    pub id: String,
    pub client: Option<String>,
    pub conversation_id: Option<String>,
    pub outcome: CommandReceiptOutcome,
    pub committed: bool,
    pub error: Option<String>,
    pub completed_at: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------- swarm, retired-workers

/// `state/swarm.json` (`agents.ts` `SwarmSnapshot`, versions 4..=7).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmSnapshot {
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_runs: Option<Vec<ActiveRunSnapshot>>,
    pub saved_at: u64,
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_profile_id: Option<String>,
    pub prime_conversation_id: Option<String>,
    pub started_at: Option<u64>,
    pub agents: Vec<SerializedAgent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dormant_runs: Option<Vec<DormantRunSnapshot>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_retired_conversations: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_worktree_cleanup_offers: Option<Vec<ManagedWorktreeCleanupOffer>>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SerializedAgent {
    pub info: AgentInfo,
    pub queue: Vec<AgentMessage>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRunSnapshot {
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub former_run_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_profile_id: Option<String>,
    pub prime_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prime_request_id: Option<String>,
    pub started_at: u64,
    pub agents: Vec<SerializedAgent>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DormantRunSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub former_run_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_profile_id: Option<String>,
    pub prime_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prime_request_id: Option<String>,
    pub started_at: u64,
    pub parked_at: u64,
    pub agents: Vec<SerializedAgent>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum CleanupReason { Completed = "completed", Failed = "failed", Cleared = "cleared", Evicted = "evicted" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeCleanupOffer {
    pub run_id: String,
    pub agent_id: String,
    pub reason: CleanupReason,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `state/retired-workers.json` (`RetiredWorkersSnapshot`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetiredWorkers {
    pub version: V1,
    pub saved_at: u64,
    pub workers: Vec<RetiredChat>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetiredChat {
    pub id: String,
    pub conversation_id: String,
    pub reason: String,
    pub retired_at: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------- chat-models, plugin-refresh, plugins

/// `state/chat-models.json`: the last model catalog the browser proved (strict in `chat-models.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChatModels {
    pub observed_at: u64,
    pub models: Vec<ChatModelOption>,
}

/// One account-observed model (`ChatModelOption`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatModelOption {
    pub id: String,
    pub label: String,
    pub efforts: Vec<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
}

string_enum! {
    pub enum PluginSurface { Core = "core", Desktop = "desktop", Plugins = "plugins" }
}
string_enum! {
    pub enum RefreshFailure { Inspection = "inspection", Confirmation = "confirmation" }
}

/// One MCP tool declaration as a connector publishes it (`PluginToolSchema`).
///
/// The schemas are JSON Schema documents and stay `serde_json::Value`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolSchema {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `state/plugin-refresh.json`: at most one row per surface (`plugin-refresh.ts` `rowSchema`).
pub type PluginRefreshRows = Vec<PluginRefreshRow>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRefreshRow {
    pub surface: PluginSurface,
    /// Written from the publication the row was made for; the owner's read schema ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector_name: Option<String>,
    /// Written from the publication the row was made for; the owner's read schema ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<PluginToolSchema>>,
    pub schema_id: String,
    pub id: String,
    pub app_id: Option<ConnectorAppId>,
    pub completed_schema_id: Option<String>,
    pub attempted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<RefreshFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failures: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parked_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_run: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observe: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_from_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_tunnel_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_schema_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_startup_version: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum PluginSourceKind {
        Npm = "npm", Python = "python", Command = "command", Remote = "remote", Mcpb = "mcpb", Github = "github",
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PluginDependency {
    pub package: String,
    pub version: String,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum PluginAuth { Oauth = "oauth" }
}

/// Where an installed plugin comes from (`PluginSource`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PluginSource {
    pub kind: PluginSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<Vec<PluginDependency>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<PluginAuth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A configurable field a catalog plugin asks for (`PluginField`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PluginField {
    pub key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum PluginStatus {
        Installed = "installed", Connecting = "connecting", Ready = "ready", Disabled = "disabled",
        Error = "error", NeedsAuth = "needs-auth", Authenticating = "authenticating",
    }
}

/// How an installed plugin's server is started (`InstalledLaunch`). `manifest` is the
/// bundle's own `manifest.json`, untyped in TypeScript.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InstalledLaunch {
    pub command: String,
    pub args: Vec<String>,
    pub version: String,
    pub license: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<serde_json::Value>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `state/plugins.json`: installed external MCP servers (`plugins/manager.ts` `RecordEntry`).
pub type Plugins = Vec<PluginRecord>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
    pub source: PluginSource,
    pub config: Record<String>,
    pub credential_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<PluginField>>,
    pub version: String,
    pub license: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub enabled: bool,
    pub status: PluginStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub installed_at: u64,
    /// Validated discovery, as the MCP SDK's `Tool` objects.
    pub catalog: Vec<PluginToolSchema>,
    pub directory: String,
    pub launch: InstalledLaunch,
    pub disabled_tools: Vec<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------- projects

/// `state/projects.json` (`projects.ts`).
pub type Projects = Vec<LocalProject>;

string_enum! {
    pub enum ProjectColor { Blue = "blue", Green = "green", Amber = "amber", Purple = "purple", Rose = "rose", Teal = "teal" }
}

/// An explicit local folder selection (`LocalProject`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProject {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<ProjectColor>,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ungrouped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt: Option<ChatgptProjectLink>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One CoS project's native ChatGPT Project, from request to verified identity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ChatgptProjectLink {
    #[serde(rename_all = "camelCase")]
    Requested {
        request_id: String,
        updated_at: JsNumber,
    },
    #[serde(rename_all = "camelCase")]
    Claimed {
        request_id: String,
        owner: String,
        updated_at: JsNumber,
    },
    #[serde(rename_all = "camelCase")]
    Creating {
        request_id: String,
        owner: String,
        updated_at: JsNumber,
    },
    #[serde(rename_all = "camelCase")]
    Linked {
        id: ChatgptProjectId,
        updated_at: JsNumber,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        request_id: String,
        error: String,
        updated_at: JsNumber,
    },
    #[serde(rename_all = "camelCase")]
    Uncertain {
        request_id: String,
        error: String,
        updated_at: JsNumber,
    },
}

// ---------------------------------------------------------------- usage-cache

/// `state/usage-cache.json` (`session/usage.ts`, `CACHE_VERSION = 9`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsageCache {
    pub version: UsageCacheVersion,
    pub rows: Vec<UsageCacheRow>,
    #[serde(flatten)]
    pub extra: Extra,
}

literal_version!(
    /// The usage cache format; any other version is rebuilt from history.
    pub struct UsageCacheVersion = 9
);

/// One session's derived usage: token totals per local day and verified sends.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsageCacheRow {
    pub id: String,
    pub revision: String,
    /// `[YYYY-MM-DD, tokens per model]` pairs, as `[...Map]` writes them.
    pub days: Vec<(String, Vec<UsageModelTokens>)>,
    pub messages: Vec<VerifiedMessage>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelTokens {
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub assumed: bool,
    pub tokens: JsNumber,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum VerifiedModel { Gpt56 = "gpt-5.6", Gpt6 = "gpt-6" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VerifiedMessage {
    pub id: String,
    pub time: JsNumber,
    pub model: VerifiedModel,
    #[serde(flatten)]
    pub extra: Extra,
}

// ---------------------------------------------------------------- main-texts, window-bounds, connector-identity, pet-library

/// `state/main-texts.json`: translated main-process texts, English source to translation.
pub type MainTexts = Record<String>;

/// A window rectangle in screen pixels, rounded by the tracker before it is saved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowBounds {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// `state/window-bounds.json`: the placement envelope, or the legacy bare rectangle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WindowPlacement {
    Placement {
        bounds: WindowBounds,
        maximized: bool,
    },
    Legacy(WindowBounds),
}

/// `state/connector-identity.json`: ChatGPT apps learned per surface (`connector-identity.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConnectorIdentity {
    pub core: Vec<LearnedApp>,
    pub desktop: Vec<LearnedApp>,
    pub plugins: Vec<LearnedApp>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedApp {
    pub app_id: ConnectorAppId,
    pub link_id: Option<String>,
    pub name: Option<String>,
    pub seen_at: u64,
    pub name_at: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `state/pet-library.json` (`pet-library.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PetLibrary {
    pub version: V1,
    pub enabled: Vec<String>,
    pub favorites: Vec<String>,
    #[serde(flatten)]
    pub extra: Extra,
}
