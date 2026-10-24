//! `GET` and `POST /status`: the extension's maintenance pass (`bridge.ts`).
//!
//! `POST` reports the tabs the extension sees; `GET` is the same reply without that report.
//! Repair receipts travel in the query string (`repaired`, `repairFailed`, `repairAction`,
//! `why`, `detail`, `repairHeld`), parsed by [`StatusQuery`].

use serde::{Deserialize, Serialize};

use super::{BrowserPlacement, ProjectCreate, RevivalEntry};
use crate::config::{BackgroundPlacement, BrowserPreferences, UiLanguage};
use crate::ids::BridgeConversationId;
use crate::json::{JsNumber, Record, True, nullable, string_enum};
use crate::session::TurnOutcome;
use crate::state::{DirectTurn, InputLifetime, PluginSurface};

string_enum! {
    /// Why the extension waits to reload into a newer build (`EXTENSION_UPDATE_HOLDS`).
    pub enum ExtensionUpdateHold {
        AppBusy = "app-busy", Sending = "sending", Commands = "commands", ChatBusy = "chat-busy",
        AlreadyTried = "already-tried", FolderNotReady = "folder-not-ready",
    }
}

/// `POST /status` body. At most 10 000 ids per list; any id that is not a ChatGPT
/// conversation id refuses the whole request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    /// Every chat with a tab open.
    pub open_conversations: Vec<BridgeConversationId>,
    /// Tabs Chrome discarded or froze: open, but no page runs in them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stalled_conversations: Option<Vec<BridgeConversationId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_hold: Option<ExtensionUpdateHold>,
    /// The extension can raise a chat's tab, so the reply may carry `reveals` and `follow`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_reveal: Option<bool>,
    /// The extension can fetch a generated image's original, so the reply may carry `imageExports`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_export_images: Option<bool>,
    /// Whether a signed-in ChatGPT page was seen; `null` when no page could tell.
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub chat_gpt_signed_in: Option<Option<bool>>,
}

string_enum! {
    /// `repairAction`: how a page carried out a repair. Any other value reads as none.
    pub enum RepairAction {
        Reloaded = "reloaded", Reopened = "reopened", Resumed = "resumed", Preserved = "preserved", Present = "present",
    }
}

/// The repair receipt a maintenance pass may carry in its query string. `repaired` wins over
/// `repairFailed`; `repairHeld` is independent of both.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StatusQuery {
    pub receipt: Option<RepairReceipt>,
    /// A repair the page is holding back, by token (at most 64 characters), and why.
    pub held: Option<(String, Option<String>)>,
}

/// The one repair handout the page last carried out or gave up on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RepairReceipt {
    Done {
        token: String,
        action: Option<RepairAction>,
    },
    Failed {
        token: String,
        action: Option<RepairAction>,
        why: Option<String>,
        /// At most 80 characters.
        detail: Option<String>,
    },
}

impl StatusQuery {
    /// Reads the query parameters as `bridge.ts` does: tokens are cut to 64 characters, an
    /// unknown action is none, and an empty value is absent.
    pub fn parse<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut first: Record<&str> = Record::new();
        for (key, value) in pairs {
            first.entry(key.to_owned()).or_insert(value);
        }
        let get = |key: &str| first.get(key).copied().filter(|value| !value.is_empty());
        let cut = |value: &str, chars: usize| value.chars().take(chars).collect::<String>();
        let action = get("repairAction").and_then(|value| {
            RepairAction::ALL
                .iter()
                .copied()
                .find(|action| action.as_str() == value)
        });
        let why = first.get("why").map(|value| (*value).to_owned());
        let receipt = match (get("repaired"), get("repairFailed")) {
            (Some(token), _) => Some(RepairReceipt::Done {
                token: cut(token, 64),
                action,
            }),
            (None, Some(token)) => Some(RepairReceipt::Failed {
                token: cut(token, 64),
                action,
                why: why.clone(),
                detail: first.get("detail").map(|value| cut(value, 80)),
            }),
            (None, None) => None,
        };
        let held = get("repairHeld").map(|token| (cut(token, 64), why));
        Self { receipt, held }
    }
}

/// `GET` and `POST /status` reply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReply {
    pub ok: True,
    pub conversations: Vec<LiveConversation>,
    pub stop_turns: Vec<StopCommand>,
    pub model_catalog_request: Option<ModelCatalogRequest>,
    /// This install's connector names, so the extension recognizes exactly its own traffic.
    pub connector_names: ConnectorNames,
    /// Apps proven to be this install's connectors, by surface.
    pub connector_apps: ConnectorApps,
    pub plugin_refresh_requests: Vec<PluginRefreshRequest>,
    pub browser_preference_request: Option<BrowserPreferenceRequest>,
    pub project_create_requests: Vec<ProjectCreate>,
    /// Messages not yet sent, failed or cancelled.
    pub input_opening_ids: Vec<String>,
    pub inputs: Vec<StatusInput>,
    pub background: bool,
    pub background_placement: BackgroundPlacement,
    pub browser_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_work_area: Option<BrowserWorkArea>,
    pub browser_window_bounds: BrowserWindowBounds,
    pub commands: u64,
    pub command_ids: Vec<String>,
    pub revival: Option<RevivalEntry>,
    pub revivals: Vec<RevivalEntry>,
    pub placement: Option<BrowserPlacement>,
    /// Chats to raise, for a report that said `canReveal`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reveals: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow: Option<String>,
    /// For a report that said `canExportImages`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_exports: Option<Vec<ImageExportRequest>>,
    pub repairs: Vec<RepairHandout>,
    #[serde(flatten)]
    pub tabs: TabPolicy,
    pub recovery_monitoring: bool,
    pub extension_update: Option<ExtensionUpdateOffer>,
    pub language: Option<UiLanguage>,
    pub browser_preferences: Option<BrowserPreferences>,
}

/// One chat the recorder holds (`liveConversations`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConversation {
    pub conversation_id: String,
    pub session_id: String,
    pub generating: bool,
    pub active_turn_id: Option<String>,
    pub active_turn_started_at: Option<u64>,
    /// Finished turns; only ever goes up.
    pub ended_turns: u64,
    pub last_turn_outcome: Option<TurnOutcome>,
}

/// A stop command waiting for a page (`pendingStopCommands`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopCommand {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub expires_at: u64,
}

/// The app wants the account's model list (`pendingChatModelRequest`); answered on `/models`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogRequest {
    pub nonce: String,
    pub expires_at: u64,
    /// The extension may open a ChatGPT tab to read the list.
    pub allow_open: bool,
}

/// `connectorNames(suffix)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectorNames {
    pub core: String,
    pub desktop: String,
    pub plugins: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectorApps {
    pub core: Vec<ConnectorApp>,
    pub desktop: Vec<ConnectorApp>,
    pub plugins: Vec<ConnectorApp>,
}

/// A ChatGPT app proven to be one of this install's connectors.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorApp {
    pub app_id: String,
    pub link_id: Option<String>,
    pub name: Option<String>,
}

/// A connector whose tools changed, for the page to refresh in ChatGPT's settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRefreshRequest {
    pub surface: PluginSurface,
    pub schema_id: String,
    pub connector_name: String,
}

/// The app wants the extension's preferences, changed by `patch`; answered on
/// `/browser/preferences`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPreferenceRequest {
    pub nonce: String,
    pub expires_at: u64,
    pub patch: BrowserPreferencePatch,
}

/// `Partial<BrowserPreferences>`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserPreferencePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub durations: Option<bool>,
}

/// A message for a page to take, or a planner tab to close.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StatusInput {
    /// A temporary planner chat that is done: close its tab. First, because a pending input
    /// would also read these keys.
    Close(ClosePlanner),
    Pending(PendingBrowserInput),
}

/// A temporary planner whose message was sent, cancelled or failed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosePlanner {
    pub id: String,
    pub owner: Option<String>,
    pub lifetime: InputLifetime,
    pub close: True,
    pub retire: True,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

/// A message a page may claim (`pendingBrowserInputs`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingBrowserInput {
    pub id: String,
    /// `null` for a message that opens a new chat.
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<InputRecoveryOffer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_turn: Option<DirectTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<InputLifetime>,
    /// The native ChatGPT Project the new chat opens in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRecoveryOffer {
    pub question_id: String,
    /// Stop ChatGPT's own turn first.
    pub stop: bool,
}

/// `BrowserWorkArea`: the display area the app opens browser windows in.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct BrowserWorkArea {
    pub x: JsNumber,
    pub y: JsNumber,
    pub width: JsNumber,
    pub height: JsNumber,
}

/// Where a browser window the extension opens goes. Without a work area, only its size.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserWindowBounds {
    pub width: u64,
    pub height: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<i64>,
}

/// A generated image the page should fetch and post to `/image-export` (`pendingImageExports`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageExportRequest {
    pub nonce: String,
    pub conversation_id: String,
    pub message_id: String,
    pub asset_id: String,
}

string_enum! {
    /// `Repair['reason']`.
    pub enum RepairReason {
        Unattributed = "unattributed", AssistantError = "assistant-error", NoTab = "no-tab",
        Silence = "silence", Goal = "goal", Compaction = "compaction", Stalled = "stalled",
    }
}

/// A chat due one repair (`takePendingRepairs`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairHandout {
    pub conversation_id: String,
    pub token: String,
    pub reason: RepairReason,
    /// Raise the tab before acting: a background tab is throttled.
    pub focus: bool,
    /// The page claims it on `/repairs/claim` before it acts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_claim: Option<True>,
}

/// Which open tabs the extension may reuse, close or must keep (`browserTabPolicy`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabPolicy {
    pub idle_reuse_after_ms: u64,
    pub idle_close_after_ms: u64,
    pub cancelled_decision_claims: Vec<CancelledDecisionClaim>,
    pub retired_conversations: Vec<String>,
    /// Newest activity per managed chat, epoch milliseconds.
    pub conversation_activity_at: Record<u64>,
    pub managed_conversations: Vec<String>,
    pub reusable_conversations: Vec<String>,
    pub non_discardable_conversations: Vec<String>,
    pub blocked_conversations: Vec<String>,
    pub closable_conversations: Vec<String>,
}

/// A helper chat whose decision was cancelled after a page claimed it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelledDecisionClaim {
    pub id: String,
    pub owner: String,
    pub conversation_id: String,
}

/// A newer extension build ships with this app (`extensionUpdateOffer`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionUpdateOffer {
    pub build: String,
    /// A tool call is running here, which a reload could cut short.
    pub busy: bool,
}
