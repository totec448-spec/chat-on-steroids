//! What a ChatGPT page reports: `/events`, `/correlations` and `/diagnostics` (`bridge.ts`).
//!
//! `bridge.ts` trusts none of these bodies structurally. It rebuilds each observation field by
//! field, drops unknown kinds, caps text and replaces impossible clocks with now
//! (`parseObservations`, `parseCallEvidence`). The types here are the shapes the extension
//! sends; those per-field policies (caps, clock bounds, id patterns) belong to the recorder that
//! consumes them. `/diagnostics` is the exception: its whole contract is "any JSON, read these
//! fields when they are well typed", so [`CompanionDiagnostics::sanitise`] is that parse.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::ids::ConversationId;
use crate::json::{JsNumber, True, nullable, string_enum};
use crate::session::{
    ChatErrorReason, InputAttachment, MessageReference, MessageState, PreviewError, PreviewStatus,
    ProviderChannel, ProviderRole, ProviderStatus, ReasoningEffort, TurnOutcome, TurnTraceItem,
};

// ------------------------------------------------------------------ /events

/// `POST /events` body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsReport {
    pub conversation_id: ConversationId,
    /// The worker label (`worker-1`) of a command-opened page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The exact command id that page redeemed; only this pair may recover a leased worker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_command_id: Option<String>,
    /// At most 200 are read.
    pub events: Vec<PageObservation>,
}

/// `POST /events` reply. `sessionId` is `null` when nothing was stored for a chat with no
/// session; a batch of only app sightings answers `{ ok: true, stored: 0 }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EventsStored {
    #[serde(rename_all = "camelCase")]
    Recorded {
        session_id: Option<String>,
        stored: u64,
    },
    SightingsOnly {
        ok: True,
        stored: u64,
    },
}

string_enum! {
    /// `ChatObservation['kind']`. Any other kind is dropped.
    pub enum ObservationKind {
        ModelSelection = "model_selection", ConversationTitle = "conversation_title",
        UserMessage = "user_message", AssistantMessage = "assistant_message", NativeImage = "native_image",
        PageTool = "page_tool", TurnTrace = "turn_trace", TurnStart = "turn_start", TurnEnd = "turn_end",
        ChatError = "chat_error", ToolEvidence = "tool_evidence", AppSightings = "app_sightings",
    }
}

/// One observation from the ChatGPT page (`ChatObservation`). Every field but `kind` and
/// `time` is optional on every kind; `parseObservations` decides per kind which it keeps.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageObservation {
    pub kind: ObservationKind,
    /// Epoch milliseconds; ChatGPT's own `create_time` can carry a fraction.
    pub time: JsNumber,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apps: Option<Vec<AppSighting>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_time: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_at: Option<JsNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_now: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_now: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<InputAttachment>>,
    /// One emoji, or `null` to clear the user's reaction.
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub reaction: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendered_html: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<MessageReference>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_role: Option<ProviderRole>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_status: Option<PreviewStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_error: Option<PreviewError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<Vec<PageTraceItem>>,
    /// On `turn_trace`: the user message that opened the turn the outline was read from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(rename = "final", default, skip_serializing_if = "Option::is_none")]
    pub is_final: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<MessageState>,
    /// The page's internal conversation id, used only to cross-check the URL's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fiber_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TurnOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ChatErrorReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_eligible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recoverable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<JsNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calls: Option<Vec<PageCallEvidence>>,
}

/// One item of a `turn_trace` outline as the page read it. `turnTrace` keeps the items it
/// can read and drops the rest, so an item of an unknown kind, or a call with no id, is kept
/// here as the JSON it was rather than refusing the whole batch.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PageTraceItem {
    Readable(TurnTraceItem),
    /// Dropped by the recorder. Unread JSON on purpose: no field of it is used.
    Unreadable(Value),
}

/// A connector result row the page saw (`AppSighting`): connector identity proof only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSighting {
    pub request_id: String,
    pub app_id: String,
    pub link_id: Option<String>,
    pub app_name: Option<String>,
}

/// One connector request as the page's message model describes it (`PageCallEvidence`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCallEvidence {
    /// `null` for a request read off the response stream before ChatGPT mounted its message.
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub message_id: Option<Option<String>>,
    /// Absent for a request id seen before its tool row; only `/correlations` keeps those.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Position within the turn; the app numbers calls in order when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<JsNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered: Option<bool>,
    /// ChatGPT's own request id (`wfr_…`), the ownership key.
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub request_id: Option<Option<String>>,
    /// ChatGPT's creation time, seconds.
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub create_time: Option<Option<JsNumber>>,
}

// ------------------------------------------------------------------ /correlations

/// `POST /correlations` body: the request ids of the turn this page is generating now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrelationsReport {
    pub conversation_id: ConversationId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_command_id: Option<String>,
    /// A call with no tool name counts here as long as it names its request.
    pub calls: Vec<PageCallEvidence>,
}

/// `POST /correlations` reply: which request ids this chat now owns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrelationsReply {
    pub ok: True,
    pub conversation_id: String,
    pub session_id: Option<String>,
    pub request_ids: Vec<String>,
    pub confirmed: Vec<String>,
    /// Ids already proven for another chat.
    pub conflicts: Vec<String>,
    /// No conflicts, and every id confirmed.
    pub complete: bool,
}

// ------------------------------------------------------------------ /diagnostics

/// `POST /diagnostics`: the extension's popup state, as the app keeps it
/// (`CompanionDiagnostics`). Replies `{ ok: true }` whatever was sent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionDiagnostics {
    pub captured_at: JsNumber,
    pub status: CompanionStatus,
    pub preferences: CompanionPreferences,
    pub tab: Option<CompanionTab>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub connected: bool,
    pub port: Option<JsNumber>,
    pub paired: bool,
    pub disconnected: bool,
    pub pending: JsNumber,
    pub pending_command_acks: JsNumber,
    pub compatible: Option<bool>,
    pub app_version: Option<String>,
    pub app_protocol: Option<JsNumber>,
    pub extension_version: Option<String>,
    pub extension_protocol: Option<JsNumber>,
    pub pair_error: Option<CompanionPairError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompanionPairError {
    pub error: String,
    pub message: String,
}

/// The extension's own preferences (`overwrite` defaults on, `durations` off).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompanionPreferences {
    pub overwrite: bool,
    pub durations: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionTab {
    pub tab: Option<JsNumber>,
    pub is_chat: bool,
    pub conversation_id: Option<String>,
    pub bound: bool,
    pub epoch: Option<JsNumber>,
    pub terminal: bool,
    pub recorder: bool,
    pub page: Option<CompanionPage>,
    pub chat_tabs: JsNumber,
    pub pending: JsNumber,
    pub pending_all: JsNumber,
    pub pending_closes: JsNumber,
    pub pending_command_acks: JsNumber,
    pub delivery: CompanionDelivery,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CompanionDelivery {
    pub at: JsNumber,
    pub ok: Option<bool>,
    pub events: JsNumber,
    pub total: JsNumber,
    pub status: JsNumber,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionPage {
    pub recorder_version: Option<JsNumber>,
    pub run_id: Option<String>,
    pub conversation_id: Option<String>,
    pub generating: bool,
    pub turn_id: Option<String>,
    pub generations: JsNumber,
    pub queued: JsNumber,
    pub queue_bytes: JsNumber,
    pub request_id: Option<String>,
    pub trace: Vec<CompanionTrace>,
    pub overwrite: bool,
    pub painted: bool,
    pub events: JsNumber,
    pub calls: JsNumber,
    pub sends: JsNumber,
    pub failures: JsNumber,
    pub session: Option<String>,
    pub last_error: Option<CompanionError>,
    pub blocked: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompanionTrace {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub read: bool,
    pub sent: bool,
    pub confirmed: bool,
    pub app: Option<String>,
    pub tool: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CompanionError {
    pub at: JsNumber,
    pub text: String,
}

/// A JSON object, or nothing (`diagnosticObject`).
fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `value.slice(0, max)` on a string: `max` UTF-16 code units. A cut that would split a
/// surrogate pair keeps the pair out, where JavaScript would keep its first half.
fn text(value: Option<&Value>, max: usize) -> Option<String> {
    let value = value?.as_str()?;
    let mut units = 0;
    let mut out = String::new();
    for character in value.chars() {
        units += character.len_utf16();
        if units > max {
            break;
        }
        out.push(character);
    }
    Some(out)
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

/// `diagnosticNumber`: a finite number clamped to `0..=max`, else 0.
fn count(value: Option<&Value>, max: f64) -> JsNumber {
    JsNumber(finite(value).map_or(0.0, |value| value.clamp(0.0, max)))
}

fn number_or_null(value: Option<&Value>) -> Option<JsNumber> {
    finite(value).map(JsNumber)
}

fn is_true(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

fn tri_state(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

impl CompanionDiagnostics {
    /// `sanitiseCompanionDiagnostics`: `None` unless the body, its `status` and its
    /// `preferences` are objects; every other field reads as a default when it is not well typed.
    pub fn sanitise(body: &Value) -> Option<Self> {
        let root = body.as_object()?;
        let status = object(root.get("status"))?;
        let preferences = object(root.get("preferences"))?;
        let pair_error = object(status.get("pairError")).map(|error| CompanionPairError {
            error: text(error.get("error"), 160).unwrap_or_default(),
            message: text(error.get("message"), 500).unwrap_or_default(),
        });
        Some(Self {
            captured_at: count(root.get("capturedAt"), MAX_SAFE),
            status: CompanionStatus {
                connected: is_true(status.get("connected")),
                port: number_or_null(status.get("port")),
                paired: is_true(status.get("paired")),
                disconnected: is_true(status.get("disconnected")),
                pending: count(status.get("pending"), 1e6),
                pending_command_acks: count(status.get("pendingCommandAcks"), 1e6),
                compatible: tri_state(status.get("compatible")),
                app_version: text(status.get("appVersion"), 32),
                app_protocol: number_or_null(status.get("appProtocol")),
                extension_version: text(status.get("extensionVersion"), 32),
                extension_protocol: number_or_null(status.get("extensionProtocol")),
                pair_error,
            },
            preferences: CompanionPreferences {
                overwrite: preferences.get("overwrite") != Some(&Value::Bool(false)),
                durations: is_true(preferences.get("durations")),
            },
            tab: object(root.get("tab")).map(CompanionTab::sanitise),
        })
    }

    /// Whether the extension says these preferences are ones it stored, not its install
    /// defaults. Only stored ones are kept for a reinstalled extension.
    pub fn preferences_stored(body: &Value) -> bool {
        is_true(body.get("preferencesStored"))
    }
}

impl CompanionTab {
    fn sanitise(tab: &Map<String, Value>) -> Self {
        let delivery = object(tab.get("delivery"));
        let field = |key: &str| delivery.and_then(|delivery| delivery.get(key));
        Self {
            tab: number_or_null(tab.get("tab")),
            is_chat: is_true(tab.get("isChat")),
            conversation_id: text(tab.get("conversationId"), 200),
            bound: is_true(tab.get("bound")),
            epoch: number_or_null(tab.get("epoch")),
            terminal: is_true(tab.get("terminal")),
            recorder: is_true(tab.get("recorder")),
            page: object(tab.get("page")).map(CompanionPage::sanitise),
            chat_tabs: count(tab.get("chatTabs"), 1e4),
            pending: count(tab.get("pending"), 1e6),
            pending_all: count(tab.get("pendingAll"), 1e6),
            pending_closes: count(tab.get("pendingCloses"), 1e6),
            pending_command_acks: count(tab.get("pendingCommandAcks"), 1e6),
            delivery: CompanionDelivery {
                at: count(field("at"), MAX_SAFE),
                ok: tri_state(field("ok")),
                events: count(field("events"), 1e6),
                total: count(field("total"), 1e8),
                status: count(field("status"), 999.0),
                error: text(field("error"), 200),
            },
        }
    }
}

impl CompanionPage {
    fn sanitise(page: &Map<String, Value>) -> Self {
        let last_error = object(page.get("lastError")).and_then(|error| {
            finite(error.get("at")).map(|at| CompanionError {
                at: JsNumber(at),
                text: text(error.get("text"), 500).unwrap_or_default(),
            })
        });
        let trace = page
            .get("trace")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .take(16)
                    .filter_map(|row| {
                        let row = row.as_object()?;
                        let request_id =
                            text(row.get("requestId"), 160).filter(|id| !id.is_empty())?;
                        Some(CompanionTrace {
                            request_id,
                            read: is_true(row.get("read")),
                            sent: is_true(row.get("sent")),
                            confirmed: is_true(row.get("confirmed")),
                            app: text(row.get("app"), 80),
                            tool: text(row.get("tool"), 160),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            recorder_version: number_or_null(page.get("recorderVersion")),
            run_id: text(page.get("runId"), 160),
            conversation_id: text(page.get("conversationId"), 200),
            generating: is_true(page.get("generating")),
            turn_id: text(page.get("turnId"), 200),
            generations: count(page.get("generations"), 1e6),
            queued: count(page.get("queued"), 1e6),
            queue_bytes: count(page.get("queueBytes"), 64.0 * 1024.0 * 1024.0),
            request_id: text(page.get("requestId"), 160),
            trace,
            overwrite: is_true(page.get("overwrite")),
            painted: is_true(page.get("painted")),
            events: count(page.get("events"), 1e7),
            calls: count(page.get("calls"), 1e7),
            sends: count(page.get("sends"), 1e7),
            failures: count(page.get("failures"), 1e7),
            session: text(page.get("session"), 160),
            last_error,
            blocked: text(page.get("blocked"), 160),
        }
    }
}
