//! `GET` and `POST /status`, the extension's maintenance pass. A `POST` reports the tabs the
//! extension sees; both answer every request the app has for the browser. The work parts come
//! from [`BrowserWork`]; the requests this unit owns, and the config the extension follows,
//! come from here.

use std::sync::{Arc, Mutex};

use cos_store::Logger;
use cos_types::bridge::{
    BrowserWindowBounds, ExtensionUpdateHold, ExtensionUpdateOffer, StatusQuery, StatusReply,
};
use cos_types::config::{BackgroundPlacement, Config};
use cos_types::json::True;
use serde_json::Value;

use crate::models::ChatModels;
use crate::plugin_refresh::PluginRefreshes;
use crate::ports::{BrowserWork, StatusCall};
use crate::preferences::PreferenceRequests;
use crate::projects::ProjectCreates;
use crate::text::conversation_id;

/// At most this many ids per list.
const MAX_IDS: usize = 10_000;

/// The owners a pass reads.
#[derive(Clone)]
pub struct Owners {
    pub models: ChatModels,
    pub preferences: PreferenceRequests,
    pub projects: ProjectCreates,
    pub plugins: Arc<dyn PluginRefreshes>,
    pub work: Arc<dyn BrowserWork>,
}

/// One pass as the wire delivered it.
pub struct Pass {
    /// The `POST` body; `None` for a `GET`.
    pub report: Option<Value>,
    pub query: StatusQuery,
    /// `x-extension-browser`.
    pub browser: Option<String>,
    /// `extensionUpdateOffer` with `busy` filled in, from the bridge's extension folder.
    pub extension_update: Option<ExtensionUpdateOffer>,
}

/// A report the pass refuses (`400 { error }`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Invalid(pub &'static str);

fn ids(value: Option<&Value>) -> Option<Vec<String>> {
    let list = value?.as_array()?;
    if list.len() > MAX_IDS {
        return None;
    }
    list.iter()
        .map(|id| conversation_id(Some(id)).map(|id| id.as_str().to_owned()))
        .collect()
}

/// Logs once per change of the reason the extension holds back an update
/// (`noteExtensionUpdateHold`).
#[derive(Default)]
pub struct HoldLog(Mutex<Option<ExtensionUpdateHold>>);

impl HoldLog {
    fn note(&self, hold: Option<&Value>, logger: &Logger) {
        let reason = hold.and_then(Value::as_str).and_then(|hold| {
            ExtensionUpdateHold::ALL
                .iter()
                .copied()
                .find(|known| known.as_str() == hold)
        });
        let mut logged = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        if *logged == reason {
            return;
        }
        *logged = reason;
        if let Some(reason) = reason {
            logger.info(&format!(
                "bridge: the browser extension waits to update: {}",
                hold_text(reason)
            ));
        }
    }
}

/// `EXTENSION_UPDATE_HOLDS`.
fn hold_text(hold: ExtensionUpdateHold) -> &'static str {
    use ExtensionUpdateHold as H;
    match hold {
        H::AppBusy => "a tool call is running in this app",
        H::Sending => "a message is being sent",
        H::Commands => "a browser command is still pending",
        H::ChatBusy => "a ChatGPT tab is still answering",
        H::AlreadyTried => "it already tried this update once; reload it in chrome://extensions",
        H::FolderNotReady => "its folder does not hold the new build yet",
    }
}

/// Answers one pass.
pub async fn answer(
    owners: &Owners,
    config: &Config,
    pass: Pass,
    holds: &HoldLog,
    logger: &Logger,
) -> Result<StatusReply, Invalid> {
    let mut call = StatusCall {
        post: pass.report.is_some(),
        query: pass.query,
        browser: pass.browser,
        ..StatusCall::default()
    };
    if let Some(report) = &pass.report {
        call.open_conversations =
            ids(report.get("openConversations")).ok_or(Invalid("invalid_open_conversations"))?;
        if let Some(stalled) = report.get("stalledConversations") {
            call.stalled_conversations =
                ids(Some(stalled)).ok_or(Invalid("invalid_stalled_conversations"))?;
        }
        holds.note(report.get("updateHold"), logger);
        call.can_reveal = report.get("canReveal") == Some(&Value::Bool(true));
        call.can_export_images = report.get("canExportImages") == Some(&Value::Bool(true));
    }
    let work = owners.work.status(call).await;
    let ui = &config.ui;
    let automatic = ui.auto_refresh_plugins == Some(true);
    Ok(StatusReply {
        ok: True,
        conversations: work.conversations,
        stop_turns: work.stop_turns,
        model_catalog_request: owners.models.pending_request(),
        connector_names: cos_types::connectors::connector_names(config.connector_suffix.as_deref()),
        connector_apps: owners.plugins.connector_apps(),
        plugin_refresh_requests: if automatic {
            owners.plugins.publications()
        } else {
            Vec::new()
        },
        browser_preference_request: owners.preferences.pending(),
        project_create_requests: owners.projects.pending().await,
        input_opening_ids: work.input_opening_ids,
        inputs: work.inputs,
        background: ui.background_chats == Some(true),
        background_placement: match ui.background_placement {
            Some(BackgroundPlacement::Group) => BackgroundPlacement::Group,
            _ => BackgroundPlacement::Window,
        },
        browser_only: ui.browser_only == Some(true),
        // No display work area is known to this app yet; the extension then sizes its window
        // without placing it (`browserWindowBounds()` with no area).
        browser_work_area: None,
        browser_window_bounds: BrowserWindowBounds {
            width: 800,
            height: 600,
            left: None,
            top: None,
        },
        commands: work.command_ids.len() as u64,
        command_ids: work.command_ids,
        revival: work.revivals.first().cloned(),
        revivals: work.revivals,
        placement: work.placement,
        reveals: work.reveals,
        follow: work.follow,
        image_exports: work.image_exports,
        repairs: work.repairs,
        tabs: work.tabs,
        recovery_monitoring: work.recovery_monitoring,
        extension_update: pass.extension_update,
        language: ui.language,
        browser_preferences: ui.browser_preferences,
    })
}
