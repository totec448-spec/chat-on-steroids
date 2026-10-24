//! The request-id proof ledger (`src/main/session/correlation.ts`).
//!
//! ChatGPT puts one opaque request id in two places: the `x-request-id` header of the MCP
//! request and `message.metadata.request_id` in the page model. A page reporting that id for
//! its conversation is the only ownership evidence. The first proof of an id is permanent: a
//! later claim from another conversation is refused, and no clock ages an owner out.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use cos_sessions::SessionStore;
use cos_store::{Durable, DurableStore, Logger};
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{AttributionMethod, SessionEvent};
use cos_types::state::{CorrelationEntry, RequestCorrelation, RequestCorrelations};
use indexmap::IndexMap;
use serde_json::Value;
use tokio::sync::watch;
use tokio::time::Instant;

const MAX_CORRELATIONS: usize = 50_000;
const MAX_EVIDENCE_WINDOWS: usize = 2_000;
const STATE_NAME: &str = "request-correlations";
/// Version 6 snapshots are written before the browser is told an owner is durable.
const STATE_VERSION: u64 = 6;
/// How many of the newest sessions a restore without a complete ledger rescans.
const HISTORY_SESSIONS: usize = 100;
const HISTORY_EVENTS: usize = 1024;

/// What one sighting did to the ledger (`'stored' | 'same' | 'refused'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Merge {
    /// The first proof of this id.
    Stored,
    /// The owner it already had.
    Same,
    /// Another conversation already owns this id; nothing changed.
    Refused,
}

/// The ledger. Clones share one.
#[derive(Clone)]
pub struct Correlations {
    inner: Arc<Inner>,
}

struct Inner {
    ledger: Durable<RequestCorrelations>,
    logger: Logger,
    state: Mutex<State>,
    /// Bumped on every new owner, so a waiter rechecks its own id.
    proved: watch::Sender<u64>,
}

#[derive(Default)]
struct State {
    /// Insertion order is freshness order: a newer same-owner sighting moves its id to the end.
    by_request: IndexMap<String, RequestCorrelation>,
    /// When each request's evidence wait began; grace belongs to the request, not to a call.
    windows: IndexMap<String, Instant>,
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn snapshot(state: &State) -> RequestCorrelations {
    RequestCorrelations {
        version: STATE_VERSION,
        complete: Some(true),
        entries: state
            .by_request
            .values()
            .cloned()
            .map(CorrelationEntry::Owner)
            .collect(),
        extra: Extra::new(),
    }
}

/// `validCorrelation` over a stored row; `tool` may be empty, because a request id is often
/// proven before ChatGPT names the tool.
fn valid(row: &RequestCorrelation) -> bool {
    let session = &row.session_id;
    (1..=200).contains(&row.request_id.len())
        && (1..=200).contains(&row.conversation_id.len())
        && (8..=64).contains(&session.len())
        && session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && (1..=300).contains(&row.message_id.len())
        && row.tool.len() <= 100
}

/// `storedOwner`: the owner in a persisted row of any version, or nothing.
fn stored_owner(raw: &Value) -> Option<RequestCorrelation> {
    let object = raw.as_object()?;
    let value = match object.get("value") {
        Some(value) => value,
        None => raw,
    };
    let row: RequestCorrelation = serde_json::from_value(strip_extra(value)?).ok()?;
    valid(&row).then_some(row)
}

/// Only the six owner fields are kept; anything else a row carried is not part of an owner.
fn strip_extra(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut kept = serde_json::Map::new();
    for key in [
        "requestId",
        "conversationId",
        "sessionId",
        "messageId",
        "tool",
        "observedAt",
    ] {
        kept.insert(key.to_owned(), object.get(key)?.clone());
    }
    // `Number.isFinite(observedAt)`; a fraction is still a finite number of milliseconds.
    let observed = kept.get("observedAt")?.as_f64()?;
    if !observed.is_finite() || observed < 0.0 {
        return None;
    }
    kept.insert("observedAt".into(), Value::from(observed as u64));
    Some(Value::Object(kept))
}

impl State {
    fn merge(&mut self, input: RequestCorrelation) -> Merge {
        let Some(previous) = self.by_request.get(&input.request_id) else {
            self.windows.shift_remove(&input.request_id);
            self.by_request.insert(input.request_id.clone(), input);
            self.trim();
            return Merge::Stored;
        };
        if previous.conversation_id != input.conversation_id {
            return Merge::Refused;
        }
        // Insertion order is the eviction order, so a fresher sighting moves the id to the end.
        if input.observed_at > previous.observed_at
            && let Some(mut held) = self.by_request.shift_remove(&input.request_id)
        {
            held.observed_at = input.observed_at;
            self.by_request.insert(input.request_id, held);
        }
        Merge::Same
    }

    fn trim(&mut self) {
        while self.by_request.len() > MAX_CORRELATIONS {
            self.by_request.shift_remove_index(0);
        }
    }
}

impl Correlations {
    pub fn new(state: &DurableStore, logger: Logger) -> Self {
        let ledger = match state.ledger(STATE_NAME) {
            Ok(ledger) => ledger,
            Err(error) => unreachable!("{STATE_NAME} is a valid ledger name: {error}"),
        };
        let (proved, _) = watch::channel(0);
        Self {
            inner: Arc::new(Inner {
                ledger,
                logger,
                state: Mutex::new(State::default()),
                proved,
            }),
        }
    }

    /// `restoreRequestCorrelations`: the ledger, and when it cannot vouch for itself (an older
    /// version, or a version 6 file missing `complete`), the request-id calls already recorded
    /// in the newest sessions. Runs before the bridge admits traffic.
    pub async fn restore(&self, sessions: &SessionStore) {
        let ledger = self.inner.ledger.clone();
        let saved = tokio::task::spawn_blocking(move || ledger.read())
            .await
            .ok()
            .flatten();
        let version = saved
            .as_ref()
            .and_then(|saved| saved.get("version"))
            .and_then(Value::as_u64);
        let entries = saved
            .as_ref()
            .and_then(|saved| saved.get("entries"))
            .and_then(Value::as_array);
        let complete = version == Some(STATE_VERSION)
            && saved.as_ref().and_then(|saved| saved.get("complete")) == Some(&Value::Bool(true))
            && entries.is_some_and(|rows| rows.iter().all(|row| stored_owner(row).is_some()));
        if let (Some(version), Some(rows)) = (version, entries)
            && (3..=STATE_VERSION).contains(&version)
        {
            let mut state = lock(&self.inner.state);
            let start = rows.len().saturating_sub(MAX_CORRELATIONS);
            for row in &rows[start..] {
                if let Some(owner) = stored_owner(row) {
                    state.merge(owner);
                }
            }
        }
        if complete {
            self.wake();
            return;
        }
        let index = sessions.index();
        let newest: Vec<SessionId> = index
            .borrow()
            .sessions
            .iter()
            .take(HISTORY_SESSIONS)
            .map(|summary| summary.id.clone())
            .collect();
        for id in newest.iter().rev() {
            let events = match sessions
                .recent_events(id, HISTORY_EVENTS, &["tool_call"])
                .await
            {
                Ok(events) => events,
                Err(error) => {
                    self.inner.logger.warn(&format!(
                        "request correlation restore could not read session {id}: {error}"
                    ));
                    continue;
                }
            };
            let mut state = lock(&self.inner.state);
            for event in events {
                let SessionEvent::ToolCall(event) = event else {
                    continue;
                };
                let call = &event.call;
                if call.attribution_method != AttributionMethod::RequestId {
                    continue;
                }
                let (Some(request), Some(conversation)) =
                    (call.request_id.clone(), call.conversation_id.clone())
                else {
                    continue;
                };
                state.merge(RequestCorrelation {
                    request_id: request,
                    conversation_id: conversation,
                    session_id: id.as_str().to_owned(),
                    message_id: format!("stored:{}", call.call_id),
                    tool: call.tool.clone(),
                    observed_at: event.base.time,
                    extra: Extra::new(),
                });
            }
        }
        self.wake();
        if let Err(error) = self.commit().await {
            self.inner.logger.warn(&format!(
                "request correlation ledger could not be written: {error}"
            ));
        }
    }

    fn wake(&self) {
        self.inner.proved.send_modify(|generation| *generation += 1);
    }

    /// `commitRequestCorrelations`: the ledger on disk before the browser is told it is.
    pub async fn commit(&self) -> Result<(), String> {
        let value = snapshot(&lock(&self.inner.state));
        let ledger = self.inner.ledger.clone();
        tokio::task::spawn_blocking(move || ledger.write_now(&value))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())
    }

    fn persist(&self) {
        let inner = Arc::downgrade(&self.inner);
        self.inner
            .ledger
            .write_snapshot_soon(move || match inner.upgrade() {
                Some(inner) => snapshot(&lock(&inner.state)),
                None => RequestCorrelations {
                    version: STATE_VERSION,
                    complete: Some(true),
                    entries: Vec::new(),
                    extra: Extra::new(),
                },
            });
    }

    /// `observeRequestCorrelations`: one page evidence batch, snapshotted at most once.
    pub fn observe(&self, inputs: Vec<RequestCorrelation>) -> Vec<Merge> {
        let mut changed = false;
        let results: Vec<Merge> = {
            let mut state = lock(&self.inner.state);
            inputs
                .into_iter()
                .map(|input| {
                    let before = state
                        .by_request
                        .get(&input.request_id)
                        .map(|held| held.observed_at);
                    let observed = input.observed_at;
                    let result = state.merge(input);
                    if result == Merge::Stored
                        || (result == Merge::Same && before.is_some_and(|at| observed > at))
                    {
                        changed = true;
                    }
                    result
                })
                .collect()
        };
        if changed {
            self.persist();
        }
        if results.contains(&Merge::Stored) {
            self.wake();
        }
        results
    }

    /// `requestCorrelation`: the proven owner of this exact id, if a page has proved one.
    pub fn lookup(&self, request_id: &str) -> Option<RequestCorrelation> {
        lock(&self.inner.state).by_request.get(request_id).cloned()
    }

    /// `awaitRequestCorrelation`: waits only for this exact id. The allowance is measured from
    /// the request's first wait, so later and overlapping callers share one deadline.
    pub async fn wait_for(
        &self,
        request_id: &str,
        timeout: Duration,
    ) -> Option<RequestCorrelation> {
        let mut proved = self.inner.proved.subscribe();
        let deadline = {
            let mut state = lock(&self.inner.state);
            if let Some(owner) = state.by_request.get(request_id) {
                return Some(owner.clone());
            }
            if timeout.is_zero() {
                return None;
            }
            let now = Instant::now();
            let started = match state.windows.get(request_id) {
                Some(started) => *started,
                None => {
                    state.windows.insert(request_id.to_owned(), now);
                    if state.windows.len() > MAX_EVIDENCE_WINDOWS {
                        state.windows.shift_remove_index(0);
                    }
                    now
                }
            };
            let deadline = started + timeout;
            if deadline <= now {
                return None;
            }
            deadline
        };
        loop {
            if let Some(owner) = self.lookup(request_id) {
                return Some(owner);
            }
            match tokio::time::timeout_at(deadline, proved.changed()).await {
                Ok(Ok(())) => continue,
                Ok(Err(_)) | Err(_) => return self.lookup(request_id),
            }
        }
    }

    /// Writes whatever is queued. Called before quitting.
    pub fn flush(&self) {
        if let Err(error) = self.inner.ledger.flush() {
            self.inner.logger.warn(&format!(
                "request correlation ledger could not be flushed: {error}"
            ));
        }
    }
}
