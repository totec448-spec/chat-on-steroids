//! One explicit read or change of the extension's own preferences (`browser-preferences.ts`).
//! The request rides the next `/status` pass and the extension answers on
//! `/browser/preferences`; it is bounded to two ordinary maintenance passes.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use cos_types::bridge::{BrowserPreferencePatch, BrowserPreferenceRequest};
use cos_types::config::BrowserPreferences;
use serde_json::Value;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::text::js_len;
use crate::{Clock, WakeBrowser, random_uuid};

const REQUEST_MS: u64 = 65_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreferenceError {
    /// The patch is not `{ overwrite?, durations? }` with booleans.
    InvalidPatch,
    AlreadyPending,
    /// No answer within 65 s.
    NotConfirmed,
    /// The extension answered that it could not apply the change.
    Refused(String),
}

impl std::fmt::Display for PreferenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidPatch => "Invalid browser preference change",
            Self::AlreadyPending => "A browser preference request is already pending",
            Self::NotConfirmed => {
                "Browser did not confirm its preferences. Connect the extension and refresh."
            }
            Self::Refused(message) => message,
        })
    }
}

impl std::error::Error for PreferenceError {}

type Answer = Result<BrowserPreferences, PreferenceError>;

struct Pending {
    request: BrowserPreferenceRequest,
    answer: oneshot::Sender<Answer>,
    timer: Option<JoinHandle<()>>,
}

/// The preference request owner. Clones share one.
#[derive(Clone)]
pub struct PreferenceRequests {
    pending: Arc<Mutex<Option<Pending>>>,
    clock: Clock,
    wake: WakeBrowser,
}

/// `{ overwrite, durations }`, strict.
fn values(value: &Value) -> Option<BrowserPreferences> {
    let object = value.as_object()?;
    if object.len() != 2 {
        return None;
    }
    Some(BrowserPreferences {
        overwrite: object.get("overwrite")?.as_bool()?,
        durations: object.get("durations")?.as_bool()?,
    })
}

impl PreferenceRequests {
    pub fn new(clock: Clock, wake: WakeBrowser) -> Self {
        Self {
            pending: Arc::new(Mutex::new(None)),
            clock,
            wake,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Pending>> {
        self.pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// `requestBrowserPreferences(patch)`: the extension's preferences after the change.
    pub async fn request(&self, patch: &Value) -> Answer {
        let patch: BrowserPreferencePatch =
            serde_json::from_value(patch.clone()).map_err(|_| PreferenceError::InvalidPatch)?;
        let (answer, answered) = oneshot::channel();
        {
            let mut pending = self.lock();
            if pending.is_some() {
                return Err(PreferenceError::AlreadyPending);
            }
            let request = BrowserPreferenceRequest {
                nonce: random_uuid(),
                expires_at: (self.clock)().0 + REQUEST_MS,
                patch,
            };
            let nonce = request.nonce.clone();
            let owner = self.clone();
            let timer = tokio::runtime::Handle::try_current().ok().map(|runtime| {
                runtime.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(REQUEST_MS)).await;
                    let expired = {
                        let mut pending = owner.lock();
                        match pending.as_ref() {
                            Some(current) if current.request.nonce == nonce => pending.take(),
                            _ => None,
                        }
                    };
                    if let Some(expired) = expired {
                        let _ = expired.answer.send(Err(PreferenceError::NotConfirmed));
                    }
                })
            });
            *pending = Some(Pending {
                request,
                answer,
                timer,
            });
        }
        (self.wake)();
        answered.await.unwrap_or(Err(PreferenceError::NotConfirmed))
    }

    /// `pendingBrowserPreferenceRequest()`: what `/status` hands the extension.
    pub fn pending(&self) -> Option<BrowserPreferenceRequest> {
        let now = (self.clock)().0;
        self.lock()
            .as_ref()
            .filter(|pending| pending.request.expires_at > now)
            .map(|pending| pending.request.clone())
    }

    /// `acknowledgeBrowserPreferences(raw)`: the extension's answer. `false` (409) unless it
    /// answers the request in flight, in time.
    pub fn acknowledge(&self, raw: &Value) -> bool {
        let Some(object) = raw.as_object() else {
            return false;
        };
        if !object
            .keys()
            .all(|key| matches!(key.as_str(), "nonce" | "values" | "error"))
        {
            return false;
        }
        let Some(nonce) = object.get("nonce").and_then(Value::as_str) else {
            return false;
        };
        let answered = match object.get("values") {
            Some(Value::Null) => None,
            Some(value) => match values(value) {
                Some(values) => Some(values),
                None => return false,
            },
            None => return false,
        };
        let error = match object.get("error") {
            None => None,
            Some(error) => match error.as_str().filter(|error| js_len(error) <= 160) {
                Some(error) => Some(error.to_owned()),
                None => return false,
            },
        };
        let now = (self.clock)().0;
        let current = {
            let mut pending = self.lock();
            match pending.as_ref() {
                Some(current)
                    if current.request.nonce == nonce && now < current.request.expires_at =>
                {
                    pending.take()
                }
                _ => None,
            }
        };
        let Some(current) = current else {
            return false;
        };
        if let Some(timer) = current.timer {
            timer.abort();
        }
        let answer = match answered {
            Some(values) => Ok(values),
            None => Err(PreferenceError::Refused(
                error.filter(|error| !error.is_empty()).unwrap_or_else(|| {
                    "The extension could not confirm this change. Refresh its preferences."
                        .to_owned()
                }),
            )),
        };
        let _ = current.answer.send(answer);
        true
    }
}
