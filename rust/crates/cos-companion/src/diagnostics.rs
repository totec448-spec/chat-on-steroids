//! The extension's popup-equivalent snapshot (`/diagnostics`), kept bounded and without any page
//! text, for the app's diagnostics report.

use std::sync::Arc;
use std::time::Duration;

use cos_types::bridge::CompanionDiagnostics;
use cos_types::config::BrowserPreferences;
use serde_json::Value;
use tokio::sync::watch;

/// How long a caller waits for the extension to answer a wake with a fresh snapshot.
const FRESH_WAIT: Duration = Duration::from_millis(2_500);

/// The latest snapshot and a counter that moves on every record and every clear.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Latest {
    pub revision: u64,
    pub snapshot: Option<Arc<CompanionDiagnostics>>,
}

/// The diagnostics owner. Clones share one.
#[derive(Clone)]
pub struct Diagnostics {
    latest: Arc<watch::Sender<Latest>>,
}

impl Default for Diagnostics {
    fn default() -> Self {
        Self::new()
    }
}

impl Diagnostics {
    pub fn new() -> Self {
        Self {
            latest: Arc::new(watch::Sender::new(Latest::default())),
        }
    }

    pub fn watch(&self) -> watch::Receiver<Latest> {
        self.latest.subscribe()
    }

    /// `recordCompanionDiagnostics(body)`. Returns the preferences the extension says it stored,
    /// which the app keeps so a reinstalled extension gets them back; a fresh install reports
    /// defaults it never stored, and those are not a choice.
    pub fn record(&self, body: &Value) -> Option<BrowserPreferences> {
        let next = CompanionDiagnostics::sanitise(body)?;
        let stored = body.get("preferencesStored") == Some(&Value::Bool(true));
        let preferences = BrowserPreferences {
            overwrite: next.preferences.overwrite,
            durations: next.preferences.durations,
        };
        self.latest.send_modify(|latest| {
            latest.revision += 1;
            latest.snapshot = Some(Arc::new(next));
        });
        stored.then_some(preferences)
    }

    /// `clearCompanionDiagnostics()`: the bridge stopped or the browser disconnected.
    pub fn clear(&self) {
        self.latest.send_modify(|latest| {
            latest.revision += 1;
            latest.snapshot = None;
        });
    }

    /// `companionDiagnostics()`: asks the extension for a fresh snapshot (`wake`) and waits up
    /// to 2.5 s for it while a browser is present; otherwise, or after the wait, the last one.
    pub async fn fresh(&self, present: bool, wake: impl FnOnce()) -> Option<CompanionDiagnostics> {
        let mut seen = self.latest.subscribe();
        let before = seen.borrow_and_update().revision;
        wake();
        if present {
            let _ =
                tokio::time::timeout(FRESH_WAIT, seen.wait_for(|latest| latest.revision > before))
                    .await;
        }
        let latest = self.latest.borrow();
        latest.snapshot.as_deref().cloned()
    }
}
