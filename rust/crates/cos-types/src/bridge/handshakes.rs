//! Requests the app hands the extension through `/status`, and the routes that answer them:
//! `/models`, `/plugin-refresh`, `/browser/preferences`, `/extension/update`, `/image-export`,
//! and the account limits the page reads on `/usage`.

use serde::{Deserialize, Serialize};

use super::BridgeAccepted;
use crate::config::BrowserPreferences;
use crate::json::{False, JsNumber, string_enum};
use crate::state::{ChatModelOption, PluginSurface, PluginToolSchema};

// ------------------------------------------------------------------ /models

string_enum! {
    /// Why the page could not confirm the model list.
    pub enum ModelDiscoveryError {
        PickerUnavailable = "picker_unavailable", PickerCloseFailed = "picker_close_failed",
        ModelUnconfirmed = "model_unconfirmed", PowerUnknown = "power_unknown",
        PowerUnconfirmed = "power_unconfirmed", PowerChanged = "power_changed",
        RestoreFailed = "restore_failed", InspectionFailed = "inspection_failed",
    }
}

string_enum! {
    /// Why discovery has not read the picker yet.
    pub enum ModelDiscoveryWait {
        Generating = "generating", InputBusy = "input_busy", Draft = "draft", Attachments = "attachments",
        ComposerMissing = "composer_missing", ComposerHidden = "composer_hidden",
        InspectionBusy = "inspection_busy", PageUnreachable = "page_unreachable", PageChanged = "page_changed",
        Opening = "opening", Inspecting = "inspecting", InspectionFailed = "inspection_failed",
        ResultUnconfirmed = "result_unconfirmed", PickerUnreadable = "picker_unreadable",
    }
}

/// `POST /models` body, answering the `modelCatalogRequest` of `/status` with its `nonce`.
/// Replies [`BridgeAccepted`]: `true` with 200, `false` with 409 for a stale or bad report.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModelsReport {
    /// Discovery is still under way.
    Waiting(ModelsWaiting),
    /// The list, or `null` with the reason it could not be read.
    Observed(ModelsObserved),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelsWaiting {
    pub nonce: String,
    pub waiting: ModelDiscoveryWait,
}

/// `observation` in `chat-models.ts`: at most 20 models, ids unique, efforts unique per model.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelsObserved {
    pub nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ModelDiscoveryError>,
    pub models: Option<Vec<ChatModelOption>>,
}

// ------------------------------------------------------------------ /plugin-refresh

/// `POST /plugin-refresh` body, by `action`. `id` is the refresh request's UUID.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum PluginRefreshAction {
    /// Replies [`PluginRefreshesPending`].
    Pending,
    /// The page will refresh this connector. Refused with 409 `automatic_refresh_disabled`
    /// once the setting is off.
    #[serde(rename_all = "camelCase")]
    Claim(PluginRefreshReport),
    /// ChatGPT already shows the current tools.
    #[serde(rename_all = "camelCase")]
    Current(PluginRefreshReport),
    /// The person has to refresh it by hand, and why.
    #[serde(rename_all = "camelCase")]
    Manual {
        #[serde(flatten)]
        report: PluginRefreshReport,
        /// Cut to 200 characters.
        error: String,
    },
    #[serde(rename_all = "camelCase")]
    Complete {
        id: String,
        app_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tools: Option<Vec<PluginToolSchema>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version_id: Option<String>,
    },
    Fail {
        id: String,
        /// Cut to 200 characters.
        error: String,
    },
}

/// What a page saw of one connector in ChatGPT's settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRefreshReport {
    pub id: String,
    /// `asdk_app_…`.
    pub app_id: String,
    pub connector_name: String,
    /// The tools ChatGPT lists for the connector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<PluginToolSchema>>,
    /// `tunnel_…`, the tunnel the connector points at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel_id: Option<String>,
    /// Not sent by the extension, and not read: the app's own tests echo the pending request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<PluginSurface>,
    /// Not sent by the extension, and not read, as `surface`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_id: Option<String>,
}

/// `POST /plugin-refresh` reply to `pending`. Every other action replies [`BridgeAccepted`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PluginRefreshesPending {
    pub requests: Vec<PendingPluginRefresh>,
}

/// One connector the app wants refreshed (`PluginRefreshRequest`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPluginRefresh {
    pub surface: PluginSurface,
    pub schema_id: String,
    pub connector_name: String,
    /// The tools this app now publishes on that connector.
    pub tools: Vec<PluginToolSchema>,
    pub id: String,
    /// `null` while the app still has to learn which ChatGPT app is this connector.
    pub app_id: Option<String>,
    /// Re-read the declarations only; a mismatch does not earn another Refresh click.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observe_only: Option<bool>,
}

/// `POST /plugin-refresh` reply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PluginRefreshReply {
    Pending(PluginRefreshesPending),
    Done(BridgeAccepted),
    /// A claim after the person turned automatic refresh off (409).
    Disabled {
        ok: False,
        error: String,
    },
}

// ------------------------------------------------------------------ /browser/preferences

/// `POST /browser/preferences` body, answering `browserPreferenceRequest` (`acknowledgement`,
/// strict). Replies [`BridgeAccepted`]: 409 for a stale nonce.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserPreferencesAck {
    pub nonce: String,
    /// The extension's preferences after the change, or `null` with `error` when it could not.
    pub values: Option<BrowserPreferences>,
    /// At most 160 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ------------------------------------------------------------------ /extension/update

/// `POST /extension/update` reply. The request has no body: the extension's build travels in
/// `x-extension-build`. `build` is absent when the app offers no update.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionUpdatePrepared {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    /// The folder Chrome loads from now holds `build`.
    pub ready: bool,
}

// ------------------------------------------------------------------ /image-export

string_enum! {
    /// Why the page could not hand over an image (`PAGE_ERRORS`).
    pub enum ImageExportFailure {
        NotOpen = "not_open", NotRendered = "not_rendered", FetchFailed = "fetch_failed",
        NotImage = "not_image", TooLarge = "too_large", Unsupported = "unsupported",
    }
}

/// `POST /image-export` body, for one `imageExports` entry of `/status`. Replies
/// [`BridgeAccepted`]: `false` when the nonce is not pending.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ImageExportReport {
    Failed {
        nonce: String,
        error: ImageExportFailure,
    },
    /// The original file, base64.
    Image { nonce: String, data: String },
}

// ------------------------------------------------------------------ /usage

string_enum! {
    pub enum UsageScope { Model = "model", Feature = "feature", Shared = "shared" }
}

/// `POST /usage` body: the account's limits as ChatGPT reported them. Replies `{ ok: true }`;
/// rows that do not parse answer 400 `invalid_usage`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// At most 80.
    pub rows: Vec<UsageLimit>,
    /// When the page read them. A stale or future snapshot is ignored.
    pub observed_at: JsNumber,
}

/// One limit (`row` in `session/usage.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    pub model: String,
    pub scope: UsageScope,
    pub remaining: Option<JsNumber>,
    pub remaining_percent: Option<JsNumber>,
    pub reset_at: Option<JsNumber>,
    pub window_seconds: Option<JsNumber>,
}
