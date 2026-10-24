//! The browser recorder (unit E2.2): what the ChatGPT page reports, filed into sessions, and the
//! request-id proof ledger that places each tool call in its chat. Ports the observation half of
//! `src/main/session/recorder.ts`, `src/main/session/correlation.ts`, and the `/events`,
//! `/correlations` and `/closed` handlers of `bridge.ts`.
//!
//! Session files belong to `cos-sessions`; this crate decides what to write and asks the store
//! to write it. The bridge family in `cos-bridge` is a thin wire layer over [`Recorder`].

mod correlation;
mod live;
mod message;
mod native_image;
mod observe;
mod parse;
mod repair;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use cos_sessions::SessionStore;
use cos_store::{DurableStore, Logger};
use cos_tools::{Attribution, BoxFuture, Caller, EpochMs, RequestId};
use cos_types::bridge::{CorrelationsReply, EventsStored, ObservationKind, PageObservation};
use cos_types::config::Config;
use cos_types::ids::{ConversationId, SessionId};
use cos_types::json::{Extra, JsNumber, True};
use cos_types::state::RequestCorrelation;
use serde_json::Value;
use tokio::sync::watch;

pub use correlation::{Correlations, Merge};
pub use parse::{conversation_id, parse_call_evidence, parse_observations};

/// A route's refusal word, answered as `400 { "error": word }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal(pub &'static str);

/// The recorder. Clones share one.
#[derive(Clone)]
pub struct Recorder {
    inner: Arc<Inner>,
}

struct Inner {
    sessions: SessionStore,
    correlations: Correlations,
    repairs: repair::Repairs,
    logger: Logger,
    config: watch::Receiver<Arc<Config>>,
    /// Conversations a page is reporting in this process (`conversations`).
    live: Mutex<HashMap<String, observe::LiveConversation>>,
    /// First sight of a conversation creates at most one session.
    initializing: tokio::sync::Mutex<()>,
    /// Observations of one conversation are written in arrival order.
    chains: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

impl Recorder {
    pub fn new(
        sessions: SessionStore,
        state: &DurableStore,
        config: watch::Receiver<Arc<Config>>,
        logger: Logger,
    ) -> Self {
        let correlations = Correlations::new(state, logger.clone());
        Self {
            inner: Arc::new(Inner {
                repairs: repair::Repairs::new(
                    sessions.clone(),
                    correlations.clone(),
                    config.clone(),
                ),
                correlations,
                sessions,
                logger,
                config,
                live: Mutex::new(HashMap::new()),
                initializing: tokio::sync::Mutex::new(()),
                chains: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn correlations(&self) -> &Correlations {
        &self.inner.correlations
    }

    /// `restoreRequestCorrelations` behind the startup fence, then the plans held for requests
    /// that are now proven. The pass over old Unattributed calls starts here and is not awaited.
    pub async fn restore(&self) {
        let inner = &self.inner;
        inner.correlations.restore(&inner.sessions).await;
        for request_id in inner.sessions.held_request_plans().await {
            if let Some(owner) = inner.correlations.lookup(&request_id) {
                self.attach_plan(&owner).await;
            }
        }
        inner.repairs.everything();
    }

    /// Shutdown phase 3: the late-proof repairs already asked for, run now.
    pub async fn settle(&self) {
        self.inner.repairs.drain().await;
    }

    /// `attachRequestPlan`: the plan held under this request id becomes its chat's plan.
    async fn attach_plan(&self, owner: &RequestCorrelation) {
        if let Err(error) = self.inner.sessions.attach_request_plan(owner).await {
            self.inner.logger.warn(&format!(
                "request plan attachment failed for {}: {error}",
                owner.request_id
            ));
        }
    }

    /// Shutdown phase 4: the queued ledger write.
    pub fn flush(&self) {
        self.inner.correlations.flush();
    }

    fn recording(&self) -> bool {
        self.inner.config.borrow().sessions.record
    }

    fn chain(&self, conversation: &str) -> Arc<tokio::sync::Mutex<()>> {
        lock(&self.inner.chains)
            .entry(conversation.to_owned())
            .or_default()
            .clone()
    }

    /// `POST /correlations`: the live-turn ownership handshake. Ensures the chat's session,
    /// stores the request ids no chat owns yet, commits the ledger, then answers which ids this
    /// chat owns now.
    pub async fn correlate(
        &self,
        body: &Value,
        now: EpochMs,
    ) -> Result<CorrelationsReply, Refusal> {
        let conversation =
            conversation_id(body.get("conversationId")).ok_or(Refusal("bad_conversation_id"))?;
        let calls: Vec<_> = parse_call_evidence(body.get("calls"), true)
            .into_iter()
            .filter(|call| parse::evidence_request_id(call).is_some())
            .collect();
        if calls.is_empty() {
            return Err(Refusal("bad_request_evidence"));
        }
        let mut request_ids: Vec<String> = Vec::new();
        for call in &calls {
            if let Some(id) = parse::evidence_request_id(call)
                && !request_ids.iter().any(|known| known == id)
            {
                request_ids.push(id.to_owned());
            }
        }
        let ledger = &self.inner.correlations;
        let conflicts: Vec<String> = request_ids
            .iter()
            .filter(|id| {
                ledger
                    .lookup(id)
                    .is_some_and(|owner| owner.conversation_id != conversation)
            })
            .cloned()
            .collect();
        let unresolved: Vec<_> = calls
            .into_iter()
            .filter(|call| {
                parse::evidence_request_id(call).is_some_and(|id| {
                    !conflicts.iter().any(|conflict| conflict == id) && ledger.lookup(id).is_none()
                })
            })
            .collect();
        let observations = if unresolved.is_empty() {
            Vec::new()
        } else {
            let mut evidence = observe::observation(ObservationKind::ToolEvidence, now.0 as f64);
            evidence.calls = Some(unresolved);
            vec![evidence]
        };
        let session = self
            .record_request_evidence(&conversation, &observations, now)
            .await;
        let confirmed: Vec<String> = request_ids
            .iter()
            .filter(|id| {
                ledger
                    .lookup(id)
                    .is_some_and(|owner| owner.conversation_id == conversation)
            })
            .cloned()
            .collect();
        Ok(CorrelationsReply {
            ok: True,
            complete: conflicts.is_empty() && confirmed.len() == request_ids.len(),
            conversation_id: conversation,
            session_id: session.map(|id| id.as_str().to_owned()),
            request_ids,
            confirmed,
            conflicts,
        })
    }

    /// `POST /events`: one observation batch from a page.
    pub async fn events(&self, body: &Value, now: EpochMs) -> Result<EventsStored, Refusal> {
        let conversation =
            conversation_id(body.get("conversationId")).ok_or(Refusal("bad_conversation_id"))?;
        let parsed = parse_observations(body.get("events"), now.0 as f64);
        let agent = body
            .get("agent")
            .and_then(Value::as_str)
            .filter(|agent| {
                (1..=40).contains(&agent.len())
                    && agent
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
            .map(str::to_owned);
        let observations: Vec<PageObservation> = parsed
            .iter()
            .filter(|item| item.kind != ObservationKind::AppSightings)
            .cloned()
            .collect();
        if observations.is_empty() && !parsed.is_empty() {
            return Ok(EventsStored::SightingsOnly {
                ok: True,
                stored: 0,
            });
        }
        let (session, stored) = self
            .record_observations(&conversation, &observations, agent.as_deref(), now)
            .await;
        Ok(EventsStored::Recorded {
            session_id: session.map(|id| id.as_str().to_owned()),
            stored,
        })
    }

    /// `POST /closed`: the page closed. A deliberate close (`manual`) also pauses browser
    /// recovery until the page returns.
    pub async fn closed(&self, body: &Value) {
        let Some(conversation) = conversation_id(body.get("conversationId")) else {
            return;
        };
        let manual = body.get("manual") == Some(&Value::Bool(true));
        self.close_conversation(&conversation, manual).await;
    }

    /// The session a conversation's live entry writes to.
    pub(crate) fn session_for_live_conversation(&self, conversation: &str) -> Option<SessionId> {
        lock(&self.inner.live)
            .get(conversation)
            .map(|live| live.session_id.clone())
    }

    /// `noteCallEvidence`: page evidence into the ledger. Answers the owner of every id this
    /// conversation now holds, and whether one of them is new.
    fn note_call_evidence(
        &self,
        conversation: &str,
        session: &SessionId,
        item: &PageObservation,
        now: EpochMs,
    ) -> Noted {
        let mut noted = Noted::default();
        let Some(calls) = &item.calls else {
            return noted;
        };
        if let Some(fiber) = &item.fiber_conversation_id
            && fiber != conversation
        {
            let dropped: Vec<&str> = calls
                .iter()
                .filter_map(parse::evidence_request_id)
                .collect();
            self.inner.logger.warn(&format!(
                "request attribution: ignoring {} sighting(s) — URL conversation {conversation} disagrees with Fiber conversation {fiber}. Later agreeing evidence can still prove these calls.{}",
                calls.len(),
                if dropped.is_empty() {
                    String::new()
                } else {
                    format!(" Discarded request ids: {}.", dropped.join(", "))
                }
            ));
            return noted;
        }
        let observed_at = (item.time.0 as u64).min(now.0);
        let evidenced: Vec<_> = calls
            .iter()
            .filter_map(|call| Some((parse::evidence_request_id(call)?.to_owned(), call)))
            .collect();
        let prior: Vec<Option<String>> = evidenced
            .iter()
            .map(|(id, _)| {
                self.inner
                    .correlations
                    .lookup(id)
                    .map(|owner| owner.conversation_id)
            })
            .collect();
        let results = self.inner.correlations.observe(
            evidenced
                .iter()
                .map(|(id, call)| RequestCorrelation {
                    request_id: id.clone(),
                    conversation_id: conversation.to_owned(),
                    session_id: session.as_str().to_owned(),
                    message_id: parse::evidence_message_id(call).to_owned(),
                    tool: call.tool.clone().unwrap_or_default(),
                    observed_at,
                    extra: Extra::new(),
                })
                .collect(),
        );
        let mut refused = Vec::new();
        for (index, result) in results.iter().enumerate() {
            let id = &evidenced[index].0;
            if *result != Merge::Refused
                && !noted.owners.iter().any(|owner| owner.request_id == *id)
                && let Some(owner) = self.inner.correlations.lookup(id)
            {
                noted.owners.push(owner);
            }
            match result {
                Merge::Refused if !refused.contains(id) => {
                    refused.push(id.clone());
                    self.inner.logger.info(&format!(
                        "request attribution: {id} stays with conversation {}; conversation {conversation} claimed it too and was refused",
                        prior[index].as_deref().unwrap_or("null")
                    ));
                }
                Merge::Stored => {
                    noted.stored = true;
                    self.inner.logger.info(&format!(
                        "request attribution: {id} -> conversation {conversation}"
                    ));
                    self.inner.repairs.proved(id);
                }
                _ => {}
            }
        }
        noted
    }
}

/// What one evidence batch did to the ledger.
#[derive(Default)]
struct Noted {
    /// A request id gained its first owner.
    stored: bool,
    /// The owner of every id the batch did not lose to another chat, once each.
    owners: Vec<RequestCorrelation>,
}

/// How long a call may wait for its exact page-side request-id proof (`REQUEST_ID_GRACE_MS`).
const REQUEST_ID_GRACE: Duration = Duration::from_secs(20);

fn caller(request_id: Option<&RequestId>, owner: Option<RequestCorrelation>) -> Caller {
    let chat = owner.and_then(|owner| {
        Some((
            ConversationId::parse(&owner.conversation_id).ok()?,
            SessionId::parse(owner.session_id).ok()?,
        ))
    });
    Caller {
        request_id: request_id.cloned(),
        chat,
    }
}

/// The kernel's attribution port: the exact request-id owner, if a page already proved one.
/// `resolve` never waits, as `callerConversation` does not; a call whose proof arrives later is
/// filed as Unattributed, and moves to its chat when the proof arrives (`repair.rs`).
/// `resolve_proven` waits, for the chat rules that refuse by chat.
impl Attribution for Recorder {
    fn resolve<'a>(
        &'a self,
        _tool: &'a str,
        _started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller> {
        Box::pin(async move {
            let owner = request_id.and_then(|id| self.inner.correlations.lookup(id.as_str()));
            caller(request_id, owner)
        })
    }

    /// `awaitFreshCallOrigin`: waits for this exact id only, within one shared window per id.
    fn resolve_proven<'a>(
        &'a self,
        _tool: &'a str,
        _started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller> {
        Box::pin(async move {
            let owner = match request_id {
                Some(id) => {
                    self.inner
                        .correlations
                        .wait_for(id.as_str(), REQUEST_ID_GRACE)
                        .await
                }
                None => None,
            };
            caller(request_id, owner)
        })
    }
}

/// `JsNumber` milliseconds as the integral clock events carry.
fn millis(value: JsNumber) -> u64 {
    if value.0.is_finite() && value.0 > 0.0 {
        value.0 as u64
    } else {
        0
    }
}
