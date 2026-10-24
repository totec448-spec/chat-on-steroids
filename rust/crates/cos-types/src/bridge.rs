//! The browser extension bridge, protocol 14 (`src/shared/browser-bridge.ts`, `src/main/bridge.ts`).
//!
//! The extension is unchanged JavaScript, so these shapes are a contract with code this
//! workspace does not own. `bridge.ts` parses request bodies by hand, field by field; each
//! request type here is the shape the extension sends, and each reply type is exactly what the
//! app answers.

mod activity;
mod compact;
mod handshakes;
mod page;
mod status;

pub use activity::*;
pub use compact::*;
pub use handshakes::*;
pub use page::*;
pub use status::*;

use serde::{Deserialize, Serialize};

use crate::config::{ChatBrowser, GoalBackend, GoalMode, GoalProviderKind};
use crate::json::{Extra, False, JsNumber, True, nullable, string_enum};
use crate::session::ReasoningEffort;
use crate::state::{CommandReceiptOutcome, CommandSpec, InputEntry};

/// `BRIDGE_PROTOCOL` on both sides; the extension sends it as `x-extension-protocol`.
pub const BRIDGE_PROTOCOL: u64 = 14;

/// Ports the extension can reach without extra host permissions (`BROWSER_BRIDGE_PORTS`).
pub const BROWSER_BRIDGE_PORTS: [u16; 5] = [8765, 8766, 8767, 8768, 8769];

/// Where Auto looks after the primary range (`BROWSER_BRIDGE_FALLBACK_PORTS`).
pub const BROWSER_BRIDGE_FALLBACK_PORTS: [u16; 10] = [
    18765, 18766, 18767, 18768, 18769, 38765, 38766, 38767, 38768, 38769,
];

/// Every non-2xx reply: a stable word plus whatever context that route adds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeError {
    pub error: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `{ ok: true }`, the reply of routes that only acknowledge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeOk {
    pub ok: True,
}

/// `GET /hello`, the one unauthenticated read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeHello {
    /// Always `chat-on-steroids`.
    pub app: String,
    pub version: String,
    pub bridge: u64,
    /// Null when the caller stated no protocol.
    pub compatible: Option<bool>,
    pub paired: bool,
    pub disconnected: bool,
}

/// `POST /pair` body.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reuse: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconnect: Option<bool>,
}

/// `POST /pair` reply: the bearer token every later request carries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairResponse {
    pub token: String,
}

/// `POST /browser/presence` body.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPresence {
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub chat_gpt_signed_in: Option<Option<bool>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeCommandKind {
    OpenChat,
    StopTurn,
}

/// Project entry is navigation authority only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub id: String,
    pub source_conversation_id: String,
}

/// The command a page receives from `POST /commands/redeem` (`BridgeCommand`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCommand {
    pub id: String,
    pub expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_entry: Option<ProjectEntry>,
    pub kind: BridgeCommandKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_message_id: Option<String>,
    #[serde(rename = "type")]
    pub spec_type: CommandSpecType,
    pub text: String,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub conversation_id: Option<String>,
}

/// `CommandSpec['type']` on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandSpecType {
    Worker,
    Revive,
    Resume,
    Stop,
}

impl CommandSpecType {
    /// The wire type of a durable spec.
    pub fn of(spec: &CommandSpec) -> Self {
        match spec {
            CommandSpec::Worker { .. } => Self::Worker,
            CommandSpec::Revive { .. } => Self::Revive,
            CommandSpec::Resume { .. } => Self::Resume,
            CommandSpec::Stop { .. } => Self::Stop,
        }
    }
}

/// `POST /commands/redeem` body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemRequest {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_entry: Option<bool>,
}

/// `POST /commands/redeem` reply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RedeemResponse {
    pub command: BridgeCommand,
}

/// Compaction thresholds the page shows (`contextView`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextView {
    pub auto: bool,
    pub threshold: u64,
    pub warn: u64,
    pub limit: u64,
}

/// The Goal/Loop switch as one chat's composer sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSettingsView {
    pub enabled: bool,
    pub own: bool,
    pub mode: GoalMode,
    pub backend: GoalBackend,
    pub model: String,
    pub provider: GoalProviderKind,
    pub has_key: bool,
    pub objective: String,
    pub blocked: GoalBlockReason,
}

/// `GET /settings`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSettings {
    pub context: ContextView,
    pub follow_output: bool,
    pub mention_core: bool,
    pub goal: GoalSettingsView,
}

/// The WebSocket path that tells the extension when to read work over HTTP (`browser-wake.ts`).
/// Text frames only, at most [`WAKE_MAX_PAYLOAD`] bytes. The socket never carries work itself.
pub const WAKE_PATH: &str = "/wake";
/// `maxPayload` of the wake socket server.
pub const WAKE_MAX_PAYLOAD: usize = 512;
/// Open wake sockets the app accepts at once.
pub const WAKE_MAX_CLIENTS: usize = 8;
/// A socket that has not authenticated within this many milliseconds is closed.
pub const WAKE_AUTH_DEADLINE_MS: u64 = 5_000;
/// The app sends [`WakeSignal::Ping`] this often, which keeps a Chrome extension worker alive.
pub const WAKE_HEARTBEAT_MS: u64 = 20_000;
/// A socket with no `pong` for this long is closed.
pub const WAKE_STALE_MS: u64 = 45_000;

string_enum! {
    /// `WakeHost`, from `/wake?host=`: the CoS browser's own copy of the extension, or the one in
    /// the person's browser. Older builds send no `host`.
    pub enum WakeHost { Cos = "cos", Browser = "browser" }
}

string_enum! {
    /// A text frame the app sends on the wake socket.
    pub enum WakeSignal {
        /// Read current work: sent once after authentication and whenever work is published.
        Wake = "wake",
        /// Read pending browser-control commands.
        BrowserControl = "browser-control",
        /// Heartbeat; the extension answers [`ExtensionWakeFrame::Pong`].
        Ping = "ping",
    }
}

impl WakeSignal {
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|signal| signal.as_str() == text)
    }
}

/// A text frame the extension sends on the wake socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExtensionWakeFrame {
    /// The first frame: the bridge bearer token. A wrong token closes the socket.
    Authenticate(String),
    /// The answer to [`WakeSignal::Ping`], the only frame allowed after authentication.
    Pong,
}

impl ExtensionWakeFrame {
    /// Parses a frame by the socket's state. `None` is a frame the app closes the socket for.
    pub fn parse(text: &str, authenticated: bool) -> Option<Self> {
        match (authenticated, text) {
            (true, "pong") => Some(Self::Pong),
            (true, _) => None,
            (false, token) => Some(Self::Authenticate(token.to_owned())),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Authenticate(token) => token,
            Self::Pong => "pong",
        }
    }
}

// ------------------------------------------------------------------ small routes

/// `{ ok }`, the reply of routes whose request can be refused without an error.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeAccepted {
    pub ok: bool,
}

/// `POST /closed` body: a tab of this chat closed. Replies [`BridgeOk`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedRequest {
    pub conversation_id: String,
    /// The person closed it, rather than the browser discarding it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual: Option<bool>,
}

/// `POST /conversation-deleted` body: ChatGPT answered `conversation_deleted` for this chat.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDeletedRequest {
    pub conversation_id: String,
}

/// `POST /conversation-deleted` reply: how many waiting messages ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationDeletedReply {
    pub ok: True,
    pub ended: u64,
}

/// `POST /core-plugin` body: what ChatGPT's own plugin list says about this install's Core.
/// Replies [`BridgeOk`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CorePluginReport {
    /// The list no longer names it: deleted or disconnected.
    Missing { missing: True },
    /// It is installed under this app id (`asdk_app_…`).
    Installed {
        #[serde(rename = "appId")]
        app_id: String,
    },
}

/// `POST /repairs/claim` body. A stale extension build is refused before the body is read, so
/// its request may carry no token.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepairClaimRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Not sent by the extension, and not read; the app's own tests send it.
    #[serde(
        rename = "conversationId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub conversation_id: Option<String>,
}

/// `POST /repairs/claim` reply: whether the page may carry out the repair it was handed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepairClaimReply {
    pub allowed: bool,
}

// ------------------------------------------------------------------ activity detail

/// `POST /activity/detail` body. Any other key is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityDetailRequest {
    pub conversation_id: String,
    pub call_id: String,
    pub detail_revision: u64,
}

/// `POST /activity/detail` reply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ActivityDetailReply {
    Found(Box<ActivityDetail>),
    /// `error` is `call_not_available`.
    NotFound {
        ok: False,
        error: String,
    },
}

/// One recorded tool call, as the page's activity panel expands it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDetail {
    pub ok: True,
    pub conversation_id: String,
    pub call_id: String,
    pub detail_revision: u64,
    pub tool: String,
    pub outcome: ActivityOutcome,
    pub duration_ms: Option<JsNumber>,
    pub args: ActivityPreview,
    pub result: ActivityPreview,
}

string_enum! {
    /// `activityDisplayOutcome(...).code`.
    pub enum ActivityOutcomeCode {
        Started = "started", Finished = "finished", Failed = "failed", Completed = "completed",
        Refused = "refused", InternalError = "internal_error", Unknown = "unknown",
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityOutcome {
    pub code: ActivityOutcomeCode,
    pub label: String,
    /// Absent for a call that is not a process, `null` for a process whose exit is unknown.
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub exit_code: Option<Option<i64>>,
}

/// A bounded preview of a call's arguments or result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityPreview {
    pub text: String,
    pub truncated: bool,
    pub chars: u64,
}

// ------------------------------------------------------------------ commands

string_enum! {
    /// `COMMAND_STEPS`: where a page is in carrying out a command.
    pub enum CommandStep {
        RevivalWaiting = "revival-waiting", RevivalBusy = "revival-busy", RevivalDraft = "revival-draft",
        RevivalEditor = "revival-editor", Composer = "composer", Model = "model",
        ComposerAfterModel = "composer-after-model", Inserting = "inserting", Sending = "sending",
    }
}

/// `POST /commands/step` body. Replies [`BridgeAccepted`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandStepRequest {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    pub step: CommandStep,
}

string_enum! {
    /// `AckStatus`. A protocol-1 extension sends none, which means `sent`.
    pub enum AckStatus { Sent = "sent", Failed = "failed" }
}

/// `POST /commands/ack` body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandAckRequest {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// The native turn a stop command named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// Sent by the extension for a worker command; the app reads the agent from the command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<AckStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// `project-entry:<detail>` when the page entered a ChatGPT Project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// `POST /commands/ack` reply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CommandAckReply {
    /// The command's durable receipt (`receiptReply`), replayed for a repeated ACK.
    Receipt(CommandAckReceipt),
    /// An ACK the app took without finishing the command.
    Accepted(BridgeOk),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandAckReceipt {
    pub ok: True,
    #[serde(rename = "final")]
    pub is_final: True,
    pub committed: bool,
    pub outcome: CommandReceiptOutcome,
    pub conversation_id: Option<String>,
    pub error: Option<String>,
}

/// `POST /commands/revivals/pending` body: revive commands a page holds, by chat.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevivalsPendingRequest {
    pub entries: Vec<RevivalEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevivalEntry {
    pub id: String,
    pub conversation_id: String,
}

/// `POST /commands/revivals/pending` reply: the ids still waiting for delivery.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevivalsPendingReply {
    pub pending: Vec<String>,
}

// ------------------------------------------------------------------ inputs

/// The body of `POST /input/claim`, `/input/progress`, `/input/answer`, `/input/fail` and
/// `/input/ack`. The extension sends one shape to all five and picks the route by what the page
/// reported: `partial` is progress, `response` an answer, a failure goes to `/input/fail`, a
/// sent message to `/input/ack`, and anything else is a claim. On `/input/claim` the app reads
/// `recoveryAction`, `recoveryVeto`, `silenceBusyTurnId`, `authorize`, then a claim, in that order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRequest {
    pub id: String,
    /// The page's per-document owner token, at most 160 characters.
    pub owner: String,
    /// `null` for a message that opens a new chat or goes to a temporary planner, and absent
    /// when the page knows none (`JSON.stringify` drops an `undefined`).
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub conversation_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_action: Option<RecoveryAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_busy_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_veto: Option<RecoveryVeto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_authorization: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorize: Option<bool>,
    /// A helper chat's answer so far (`/input/progress`), its last 8 000 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial: Option<String>,
    /// The ChatGPT message the page sent (`/input/ack`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A lowercase word with hyphens, at most 40 characters (`/input/fail`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// A helper chat's answer to a decision (`/input/answer`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
    /// The native ChatGPT Project the page is on (`g-p-…`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

string_enum! {
    /// How far a page got with a recovery message.
    pub enum RecoveryAction { Stop = "stop", Stopped = "stopped", Reloaded = "reloaded" }
}

string_enum! {
    pub enum RecoveryVeto { PageFinal = "page-final" }
}

/// `POST /input/claim` reply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InputClaimReply {
    /// A recovery step, veto, deferral or authorization. First, because `Claimed` would also
    /// read `{ ok }` as a claim of nothing.
    Done(BridgeAccepted),
    /// A claim: the message this page now owns, or `null`.
    Claimed { input: Option<Box<InputEntry>> },
}

/// `POST /input/bind` body: the new chat a claimed opening message created. Replies
/// [`BridgeAccepted`]. `/input/progress`, `/input/answer`, `/input/fail` and `/input/ack`
/// take an [`InputRequest`] and reply [`BridgeAccepted`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputBindRequest {
    pub id: String,
    pub owner: String,
    pub conversation_id: String,
}

/// `POST /input/attachment` body: one chunk of a file attached to a claimed message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputAttachmentRequest {
    pub id: String,
    pub owner: String,
    pub conversation_id: Option<String>,
    /// Not sent by the extension, and not read; the app's own tests send it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_authorization: Option<bool>,
    pub attachment_id: String,
    /// A multiple of the chunk size.
    pub offset: u64,
}

/// `POST /input/attachment` reply: the chunk, base64.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputAttachmentReply {
    pub chunk: String,
}

// ------------------------------------------------------------------ native projects

/// `POST /project-create` body, by `action`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ProjectCreateRequest {
    /// Replies [`ProjectCreatesPending`].
    Pending,
    /// A new chat's tab for a linked Project landed on ChatGPT's home: that Project is gone.
    #[serde(rename_all = "camelCase")]
    Gone {
        input_id: String,
        chatgpt_id: String,
    },
    Claim {
        id: String,
        client: String,
    },
    Arm {
        id: String,
        client: String,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        id: String,
        client: String,
        chatgpt_id: String,
    },
    Fail {
        id: String,
        client: String,
        error: String,
    },
}

/// `POST /project-create` reply to `pending`. Every other action replies [`BridgeAccepted`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectCreatesPending {
    pub requests: Vec<ProjectCreate>,
}

/// A native ChatGPT Project the app wants a page to create (`pendingProjectCreates`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreate {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub state: ProjectCreateState,
}

string_enum! {
    pub enum ProjectCreateState { Requested = "requested", Claimed = "claimed", Creating = "creating" }
}

/// `POST /project-create` reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProjectCreateReply {
    Pending(ProjectCreatesPending),
    Done(BridgeAccepted),
}

// ------------------------------------------------------------------ CoS browser sign-in

/// `GET /cos-browser/sign-in` reply: the transfer the app is waiting for, if any.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignInOfferReply {
    pub offer: Option<SignInOffer>,
}

/// `SignInTransferOffer`: the person's browser should send its ChatGPT session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInOffer {
    pub id: String,
    /// Never `cos`.
    pub browser: ChatBrowser,
    pub expires_at: u64,
}

/// `POST /cos-browser/sign-in` body. Any other key is refused.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignInTransferRequest {
    pub id: String,
    pub cookies: Vec<SignInCookie>,
}

/// One ChatGPT session cookie (`cookieSchema`, strict).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignInCookie {
    /// `__Secure-next-auth.session-token`, or one of its numbered chunks.
    pub name: String,
    pub value: String,
    pub domain: SignInCookieDomain,
    /// Always `/`.
    pub path: String,
    pub secure: True,
    pub http_only: True,
    pub host_only: bool,
    pub same_site: SameSite,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<JsNumber>,
}

string_enum! {
    pub enum SignInCookieDomain { Host = "chatgpt.com", Domain = ".chatgpt.com" }
}

string_enum! {
    pub enum SameSite { NoRestriction = "no_restriction", Lax = "lax", Strict = "strict", Unspecified = "unspecified" }
}

/// `POST /cos-browser/sign-in` reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignInImported {
    pub ok: True,
    pub imported: True,
}

// ------------------------------------------------------------------ Goal/Loop and settings

/// `POST /goal/ack` body: the page typed, or holds, a Goal/Loop draft.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalAckRequest {
    pub conversation_id: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// ChatGPT is still busy with its own turn, so the draft waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_busy: Option<bool>,
}

/// `POST /goal/ack` reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalAckReply {
    pub acknowledged: bool,
    /// Present for a `nativeBusy` report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_until: Option<u64>,
}

/// `POST /goal/objective` body. Empty text clears the objective.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalObjectiveRequest {
    pub conversation_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<GoalMode>,
}

/// `POST /goal/objective` reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalObjectiveReply {
    pub objective: String,
    /// The chat's own switch, when the request named a mode or cleared the objective.
    #[serde(flatten)]
    pub switch: Option<ChatGoalSwitch>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatGoalSwitch {
    pub enabled: bool,
    pub own: True,
    pub mode: GoalMode,
}

/// `POST /goal/open` body: draft the opening message of a new chat.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalOpenRequest {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<GoalMode>,
}

/// `POST /goal/open` reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalOpenReply {
    pub reply: String,
    pub model: String,
}

/// `POST /settings` body: the switches the composer's settings menu owns.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#loop: Option<bool>,
    /// Scopes `goal` or `loop` to this chat's own switch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Alone with `conversationId`: whether Loop waits for the turn to end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_after_turn: Option<bool>,
}

/// `POST /settings` reply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SettingsUpdated {
    Switches {
        context: ContextView,
        goal: GoalSwitchView,
    },
    LoopDelivery {
        goal: LoopDelivery,
    },
}

/// The Goal/Loop switch after a `POST /settings`, global or this chat's own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSwitchView {
    pub enabled: bool,
    pub own: bool,
    pub mode: GoalMode,
    pub backend: GoalBackend,
    pub model: String,
    pub provider: GoalProviderKind,
    pub has_key: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopDelivery {
    pub after_turn: bool,
}
