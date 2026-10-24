//! The account's ChatGPT model catalog (`chat-models.ts`). A catalog the page observed survives
//! a restart in `state/chat-models.json`; a discovery request, and with it the authority to open
//! a ChatGPT tab, never does.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use cos_store::{Durable, DurableStore, Logger};
use cos_types::bridge::{ModelCatalogRequest, ModelDiscoveryError, ModelDiscoveryWait};
use cos_types::config::Config;
use cos_types::session::ReasoningEffort;
use cos_types::state::{ChatModelOption, ChatModels as SavedCatalog};
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::text::js_len;
use crate::{Clock, WakeBrowser, random_uuid};

/// How long a discovery request may wait for the page.
const REQUEST_MS: u64 = 120_000;
const MAX_MODELS: usize = 20;
const DEFAULT_HELPER_CHAT_MODEL: &str = "gpt-6";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogState {
    Unknown,
    Pending,
    Ready,
    Unavailable,
}

/// `ChatModelCatalog`, what the UI shows and what Send checks against.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelCatalog {
    pub state: CatalogState,
    pub requested_at: Option<u64>,
    pub observed_at: Option<u64>,
    pub models: Vec<ChatModelOption>,
    /// Request progress. It is not an account observation and never grants Send.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ChatModelCatalog {
    fn unknown() -> Self {
        Self {
            state: CatalogState::Unknown,
            requested_at: None,
            observed_at: None,
            models: Vec::new(),
            waiting: None,
            error: None,
        }
    }
}

fn waiting_reason(wait: ModelDiscoveryWait) -> &'static str {
    use ModelDiscoveryWait as W;
    match wait {
        W::Generating => "ChatGPT is still generating. The running response is left untouched.",
        W::InputBusy => "Waiting for the current browser input operation to finish.",
        W::Draft => "An unsent browser draft is protected. Discovery needs an empty composer.",
        W::Attachments => "Browser attachments are protected. Discovery needs an empty composer.",
        W::ComposerMissing => "Waiting for the ChatGPT composer to finish loading.",
        W::ComposerHidden => {
            "The ChatGPT composer is hidden. Close native settings or dialogs to use this tab."
        }
        W::InspectionBusy => "The native model picker is already being inspected.",
        W::PageUnreachable => "The browser extension has not answered the page readiness check.",
        W::PageChanged => "The discovery page changed or closed. Retry to start a new inspection.",
        W::Opening => "Opening one separate discovery page. Existing chats are left untouched.",
        W::Inspecting => "Reading the native model versions and restoring the original selection.",
        W::InspectionFailed => "The browser model inspection did not complete.",
        W::ResultUnconfirmed => "The model inspection returned without an accepted catalog.",
        W::PickerUnreadable => {
            "The open chats show no readable model picker. Refresh opens a separate discovery page."
        }
    }
}

fn observation_error(error: Option<ModelDiscoveryError>) -> &'static str {
    match error {
        Some(ModelDiscoveryError::PickerUnavailable) => {
            "ChatGPT's native model picker could not be read. Check the loaded ChatGPT page in the selected browser, close native dialogs, then retry."
        }
        Some(ModelDiscoveryError::RestoreFailed) => {
            "The original ChatGPT model selection could not be restored. Check the native picker before retrying."
        }
        Some(ModelDiscoveryError::PickerCloseFailed) => {
            "The native ChatGPT model picker did not close. Close it before retrying."
        }
        _ => {
            "ChatGPT model choices could not be confirmed. Check the native picker in the selected browser, then retry."
        }
    }
}

/// A page's answer on `/models`, parsed strictly as `chat-models.ts` does.
enum Report {
    Waiting {
        nonce: String,
        wait: ModelDiscoveryWait,
    },
    Observed {
        nonce: String,
        error: Option<ModelDiscoveryError>,
        models: Option<Vec<ChatModelOption>>,
    },
}

fn only_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn word<T: serde::de::DeserializeOwned>(value: &Value) -> Option<T> {
    serde_json::from_value(value.clone()).ok()
}

/// `/^[a-zA-Z0-9._-]+$/`, at most 80 characters.
fn model_id(value: &Value) -> Option<String> {
    let id = value.as_str()?;
    ((1..=80).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')))
    .then(|| id.to_owned())
}

/// One model, strict: `label` is trimmed first, as zod's `.trim()` stores it.
fn model(value: &Value) -> Option<ChatModelOption> {
    let object = value.as_object()?;
    if !only_keys(object, &["id", "label", "efforts", "aliases"]) {
        return None;
    }
    let id = model_id(object.get("id")?)?;
    let label = object.get("label")?.as_str()?.trim().to_owned();
    if !(1..=80).contains(&js_len(&label)) {
        return None;
    }
    let efforts: Vec<ReasoningEffort> = object
        .get("efforts")?
        .as_array()?
        .iter()
        .map(word)
        .collect::<Option<_>>()?;
    if efforts.len() > ReasoningEffort::ALL.len() {
        return None;
    }
    let aliases = match object.get("aliases") {
        None => None,
        Some(aliases) => {
            let aliases = aliases.as_array()?;
            if aliases.len() > 20 {
                return None;
            }
            Some(aliases.iter().map(model_id).collect::<Option<Vec<_>>>()?)
        }
    };
    Some(ChatModelOption {
        id,
        label,
        efforts,
        aliases,
    })
}

/// `models`: 1 to 20 models, or `null`.
fn models(value: &Value) -> Option<Option<Vec<ChatModelOption>>> {
    if value.is_null() {
        return Some(None);
    }
    let list = value.as_array()?;
    if !(1..=MAX_MODELS).contains(&list.len()) {
        return None;
    }
    list.iter().map(model).collect::<Option<Vec<_>>>().map(Some)
}

fn parse_report(raw: &Value) -> Option<Report> {
    let object = raw.as_object()?;
    let nonce = object.get("nonce")?.as_str()?.to_owned();
    if only_keys(object, &["nonce", "waiting"])
        && let Some(wait) = object.get("waiting").and_then(word)
    {
        return Some(Report::Waiting { nonce, wait });
    }
    if !only_keys(object, &["nonce", "error", "models"]) {
        return None;
    }
    let error = match object.get("error") {
        None => None,
        Some(error) => Some(word(error)?),
    };
    let models = models(object.get("models")?)?;
    Some(Report::Observed {
        nonce,
        error,
        models,
    })
}

/// Ids unique, and efforts unique within each model.
fn distinct(models: &[ChatModelOption]) -> bool {
    let ids: HashSet<&str> = models.iter().map(|model| model.id.as_str()).collect();
    ids.len() == models.len()
        && models.iter().all(|model| {
            let efforts: HashSet<ReasoningEffort> = model.efforts.iter().copied().collect();
            efforts.len() == model.efforts.len()
        })
}

struct State {
    catalog: ChatModelCatalog,
    request: Option<ModelCatalogRequest>,
    last_problem: Option<String>,
    unoffered_asked: HashSet<String>,
    deadline: Option<JoinHandle<()>>,
}

struct Inner {
    state: Mutex<State>,
    published: watch::Sender<Arc<ChatModelCatalog>>,
    ledger: Durable<SavedCatalog>,
    clock: Clock,
    wake: WakeBrowser,
    logger: Logger,
}

/// The catalog owner. Clones share one.
#[derive(Clone)]
pub struct ChatModels {
    inner: Arc<Inner>,
}

/// The ledger this owner keeps, `state/chat-models.json`.
pub fn chat_models_ledger(state: &DurableStore) -> Durable<SavedCatalog> {
    state
        .ledger("chat-models")
        .expect("a fixed, valid ledger name")
}

impl ChatModels {
    pub fn new(state: &DurableStore, clock: Clock, wake: WakeBrowser, logger: Logger) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    catalog: ChatModelCatalog::unknown(),
                    request: None,
                    last_problem: None,
                    unoffered_asked: HashSet::new(),
                    deadline: None,
                }),
                published: watch::Sender::new(Arc::new(ChatModelCatalog::unknown())),
                ledger: chat_models_ledger(state),
                clock,
                wake,
                logger,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn now(&self) -> u64 {
        (self.inner.clock)().0
    }

    /// `restoreChatModels`: the last observed catalog, unless a request or an observation
    /// already moved this run's catalog.
    pub fn restore(&self) {
        let Some(saved) = self.inner.ledger.read() else {
            return;
        };
        let parsed = saved.as_object().and_then(|object| {
            if !only_keys(object, &["observedAt", "models"]) {
                return None;
            }
            let observed_at = object.get("observedAt")?.as_f64()?;
            let models = models(object.get("models")?)??;
            (observed_at > 0.0 && distinct(&models)).then_some((observed_at as u64, models))
        });
        let Some((observed_at, models)) = parsed else {
            return;
        };
        let mut state = self.lock();
        if state.request.is_some() || state.catalog.state != CatalogState::Unknown {
            return;
        }
        state.catalog = ChatModelCatalog {
            state: CatalogState::Ready,
            requested_at: None,
            observed_at: Some(observed_at),
            models,
            waiting: None,
            error: None,
        };
        self.publish(&state);
    }

    /// Writes a queued catalog now. Called before quitting.
    pub fn flush(&self) {
        if let Err(error) = self.inner.ledger.flush() {
            self.inner
                .logger
                .warn(&format!("could not keep the model catalog: {error}"));
        }
    }

    /// Every change of the catalog, for the UI (`chatModels:changed`).
    pub fn watch(&self) -> watch::Receiver<Arc<ChatModelCatalog>> {
        self.inner.published.subscribe()
    }

    /// `getChatModels()`.
    pub fn catalog(&self) -> ChatModelCatalog {
        let mut state = self.lock();
        self.expire(&mut state);
        state.catalog.clone()
    }

    /// `pendingChatModelRequest()`: what `/status` hands the page.
    pub fn pending_request(&self) -> Option<ModelCatalogRequest> {
        let mut state = self.lock();
        self.expire(&mut state);
        state.request.clone()
    }

    /// `requestChatModels(allowOpen)`: asks the page for the list. A request already waiting is
    /// reused; an explicit one (`allow_open`) promotes a passive one once, with a fresh budget.
    pub fn request(&self, allow_open: bool) -> ChatModelCatalog {
        let mut state = self.lock();
        self.expire(&mut state);
        let now = self.now();
        match &mut state.request {
            None => {
                let request = ModelCatalogRequest {
                    nonce: random_uuid(),
                    expires_at: now + REQUEST_MS,
                    allow_open,
                };
                self.inner
                    .logger
                    .info(&format!("model discovery requested id={}", request.nonce));
                let expires_at = request.expires_at;
                state.request = Some(request);
                state.last_problem = None;
                state.catalog.state = CatalogState::Pending;
                state.catalog.requested_at = Some(now);
                state.catalog.waiting = None;
                state.catalog.error = None;
                self.schedule_deadline(&mut state, expires_at);
                self.changed(&state);
            }
            Some(request) if allow_open && !request.allow_open => {
                // Time spent waiting for the companion during a passive startup must not use
                // up the person's inspection budget.
                request.allow_open = true;
                request.expires_at = now + REQUEST_MS;
                let expires_at = request.expires_at;
                self.schedule_deadline(&mut state, expires_at);
                self.changed(&state);
            }
            Some(_) => {}
        }
        state.catalog.clone()
    }

    /// `refreshForUnoffered(saved)`: a saved choice the stored catalog does not offer may be
    /// newer than the catalog. Asks an open page once per saved choice, never a new browser.
    pub fn refresh_for_unoffered(&self, saved: &str) {
        {
            let mut state = self.lock();
            if state.catalog.observed_at.is_none()
                || !state.unoffered_asked.insert(saved.to_owned())
            {
                return;
            }
        }
        self.request(false);
    }

    /// `observeChatModels(raw)`: the page's answer on `/models`. `false` (409) for anything but
    /// a well-formed answer to the request in flight.
    pub fn observe(&self, raw: &Value) -> bool {
        let mut state = self.lock();
        self.expire(&mut state);
        let Some(report) = parse_report(raw) else {
            return false;
        };
        let Some(request) = state.request.clone() else {
            return false;
        };
        match report {
            Report::Waiting { nonce, wait } => {
                if nonce != request.nonce {
                    return false;
                }
                let waiting = waiting_reason(wait);
                if !matches!(
                    wait,
                    ModelDiscoveryWait::Opening | ModelDiscoveryWait::Inspecting
                ) {
                    state.last_problem = Some(waiting.to_owned());
                }
                if state.catalog.waiting.as_deref() != Some(waiting) {
                    state.catalog.waiting = Some(waiting.to_owned());
                    self.inner.logger.info(&format!(
                        "model discovery waiting id={} reason={}",
                        request.nonce,
                        wait.as_str()
                    ));
                    self.publish(&state);
                }
                true
            }
            Report::Observed {
                nonce,
                error,
                models,
            } => {
                if nonce != request.nonce
                    || models.as_deref().is_some_and(|models| !distinct(models))
                {
                    return false;
                }
                let now = self.now();
                self.inner.logger.info(&format!(
                    "model discovery observed id={} models={} elapsed_ms={} error={}",
                    request.nonce,
                    models.as_ref().map_or(0, Vec::len),
                    now.saturating_sub(state.catalog.requested_at.unwrap_or(now)),
                    error.map_or("none", |error| error.as_str())
                ));
                match models {
                    Some(models) => {
                        let saved = SavedCatalog {
                            observed_at: now,
                            models: models.clone(),
                        };
                        state.catalog = ChatModelCatalog {
                            state: CatalogState::Ready,
                            observed_at: Some(now),
                            models,
                            waiting: None,
                            error: None,
                            ..state.catalog.clone()
                        };
                        if let Err(error) = self.inner.ledger.write_soon(&saved) {
                            self.inner
                                .logger
                                .warn(&format!("could not keep the model catalog: {error}"));
                        }
                    }
                    None => failed(&mut state.catalog, observation_error(error).to_owned()),
                }
                state.request = None;
                if let Some(deadline) = state.deadline.take() {
                    deadline.abort();
                }
                self.changed(&state);
                true
            }
        }
    }

    /// `expire()`: a request past its deadline ends, keeping any choices already observed.
    fn expire(&self, state: &mut State) {
        let now = self.now();
        let Some(request) = state
            .request
            .as_ref()
            .filter(|request| now >= request.expires_at)
        else {
            return;
        };
        self.inner
            .logger
            .info(&format!("model discovery expired id={}", request.nonce));
        state.request = None;
        let hint = state
            .last_problem
            .clone()
            .or_else(|| state.catalog.waiting.clone())
            .unwrap_or_else(|| {
                "Check the browser extension and the signed-in ChatGPT page, then retry.".to_owned()
            });
        failed(
            &mut state.catalog,
            format!("Model discovery timed out. {hint}"),
        );
        self.publish(state);
    }

    /// At the deadline the request ends on its own, and the UI and the page hear of it, without
    /// anyone polling.
    fn schedule_deadline(&self, state: &mut State, at: u64) {
        if let Some(previous) = state.deadline.take() {
            previous.abort();
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let owner = self.clone();
        let delay = Duration::from_millis(at.saturating_sub(self.now()));
        state.deadline = Some(runtime.spawn(async move {
            tokio::time::sleep(delay).await;
            {
                let mut state = owner.lock();
                state.deadline = None;
                owner.expire(&mut state);
                owner.publish(&state);
            }
            (owner.inner.wake)();
        }));
    }

    fn publish(&self, state: &State) {
        let next = &state.catalog;
        self.inner.published.send_if_modified(|current| {
            let differs = **current != *next;
            if differs {
                *current = Arc::new(next.clone());
            }
            differs
        });
    }

    /// `changed(); wakeBrowserWork()`.
    fn changed(&self, state: &State) {
        self.publish(state);
        (self.inner.wake)();
    }
}

fn failed(catalog: &mut ChatModelCatalog, error: String) {
    catalog.state = if catalog.models.is_empty() {
        CatalogState::Unavailable
    } else {
        CatalogState::Ready
    };
    catalog.waiting = None;
    catalog.error = Some(error);
}

/// `normalizeName`: NFKC, lower case, then only letters, digits and dots, so a label typed with
/// full-width or compatibility characters matches the one ChatGPT shows.
fn normalize_name(value: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfkc()
        .normalize(value)
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphabetic() || c.is_numeric() || *c == '.')
        .collect()
}

/// A display name without a leading "GPT" before a digit: "GPT-6" and "6" are one family.
fn bare(value: &str) -> String {
    let name = normalize_name(value);
    match name.strip_prefix("gpt") {
        Some(rest) if rest.starts_with(|c: char| c.is_ascii_digit()) => rest.to_owned(),
        _ => name,
    }
}

/// `resolveChatModel`: an exact id or lane alias wins; otherwise a unique display-label match.
/// An ambiguous label resolves to nothing.
pub fn resolve_chat_model<'a>(
    models: &'a [ChatModelOption],
    value: &str,
) -> Option<&'a ChatModelOption> {
    let exact: Vec<_> = models
        .iter()
        .filter(|choice| {
            choice.id == value
                || choice
                    .aliases
                    .as_ref()
                    .is_some_and(|aliases| aliases.iter().any(|alias| alias == value))
        })
        .collect();
    if !exact.is_empty() {
        return (exact.len() == 1).then(|| exact[0]);
    }
    let name = bare(value);
    if name.is_empty() {
        return None;
    }
    let mut matches = models.iter().filter(|choice| bare(&choice.label) == name);
    match (matches.next(), matches.next()) {
        (Some(only), None) => Some(only),
        _ => None,
    }
}

/// The ChatGPT model and effort Goal and Loop decisions run on (`goalHelperSelection`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HelperSelection {
    /// `None`: ChatGPT's current selection.
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    /// A saved choice the catalog does not offer, for [`ChatModels::refresh_for_unoffered`].
    pub unoffered: Option<String>,
}

/// `goalHelperSelection` without its log lines: the saved helper model and effort, checked
/// against the observed catalog.
pub fn helper_selection(config: &Config, catalog: &ChatModelCatalog) -> HelperSelection {
    let settings = &config.goal;
    let mut model = Some(
        settings
            .helper_model
            .clone()
            .unwrap_or_else(|| DEFAULT_HELPER_CHAT_MODEL.to_owned()),
    );
    let mut reasoning_effort = Some(settings.helper_reasoning.unwrap_or(ReasoningEffort::High));
    let models = &catalog.models;
    // No readable picker at all: no model can ever be confirmed.
    if models.is_empty() && catalog.state == CatalogState::Unavailable {
        return HelperSelection {
            model: None,
            reasoning_effort: None,
            unoffered: None,
        };
    }
    if models.is_empty() {
        return HelperSelection {
            model,
            reasoning_effort,
            unoffered: None,
        };
    }
    let mut notes = Vec::new();
    let resolved = model
        .as_deref()
        .and_then(|value| resolve_chat_model(models, value));
    match (&model, resolved) {
        (Some(value), None) => {
            notes.push(format!("model \"{value}\""));
            model = None;
        }
        (Some(value), Some(choice))
            if choice.id != *value
                && !choice
                    .aliases
                    .as_ref()
                    .is_some_and(|aliases| aliases.contains(value)) =>
        {
            model = Some(choice.id.clone());
        }
        _ => {}
    }
    let offered: Vec<&ChatModelOption> = match (&model, resolved) {
        (Some(_), Some(choice)) => vec![choice],
        (Some(value), None) => models
            .iter()
            .filter(|choice| {
                choice.id == *value
                    || choice
                        .aliases
                        .as_ref()
                        .is_some_and(|aliases| aliases.contains(value))
            })
            .collect(),
        (None, _) => models.iter().collect(),
    };
    if let Some(effort) = reasoning_effort
        && !offered
            .iter()
            .any(|choice| choice.efforts.contains(&effort))
    {
        notes.push(format!("reasoning \"{}\"", effort.as_str()));
        reasoning_effort = None;
    }
    HelperSelection {
        model,
        reasoning_effort,
        unoffered: (!notes.is_empty()).then(|| format!("goal helper {}", notes.join(","))),
    }
}
