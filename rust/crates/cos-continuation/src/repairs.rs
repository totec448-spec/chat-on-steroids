//! `POST /repairs/claim`: a browser asks once, just before it reloads or reopens a chat, whether
//! the repair `/status` handed it is still owed (`bridge.ts`, `repairsInFlight`).
//!
//! The repairs are produced by browser recovery (silence, assistant errors, attribution,
//! pickups of a Compact & Resume ticket). This owner keeps the handed repairs and answers the
//! claim exactly once per repair; whether a repair is still current is the producer's
//! question, asked through [`RepairCheck`].

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use cos_sessions::SessionStore;
use cos_types::ids::SessionId;
use cos_types::session::SessionSummary;
use serde_json::{Value, json};

use crate::Answer;

/// `Repair['reason']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepairReason {
    Unattributed,
    AssistantError,
    Silence,
    NoTab,
    Stalled,
    Goal,
    Compaction,
    /// A reason that needs no claim (`repairNeedsClaim` is false).
    Other,
}

impl RepairReason {
    /// `repairNeedsClaim`.
    fn needs_claim(self) -> bool {
        !matches!(self, Self::Other)
    }
}

/// One repair handed to a browser.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Repair {
    pub token: String,
    pub session_id: SessionId,
    pub reason: RepairReason,
    /// `compaction:<token>:<phase>:manual` and the like.
    pub episode: String,
    pub handed: bool,
    pub claimed: bool,
}

/// What only the producer of a repair can judge: whether it is still owed now.
pub trait RepairCheck: Send + Sync + 'static {
    /// The producer's currency checks for `repair` on `conversation` (provider backoff,
    /// Stop, attribution, assistant error, silence and compaction phase).
    fn current(&self, conversation: &str, repair: &Repair, session: &SessionSummary) -> bool;
    /// `observationWritesInFlight === 0`: no observation that could revoke it is publishing.
    fn settled(&self) -> bool;
    /// Bookkeeping when a claim is granted (an assistant-error turn spent, a first attempt).
    fn claimed(&self, conversation: &str, repair: &Repair);
}

/// No browser recovery: nothing is ever current.
pub struct NoRepairCheck;

impl RepairCheck for NoRepairCheck {
    fn current(&self, _conversation: &str, _repair: &Repair, _session: &SessionSummary) -> bool {
        false
    }
    fn settled(&self) -> bool {
        true
    }
    fn claimed(&self, _conversation: &str, _repair: &Repair) {}
}

/// Whether a chat is blocked or has a Stop pending, the two fences a repair never crosses.
pub trait ChatFences: Send + Sync + 'static {
    fn blocked(&self, conversation: &str) -> bool;
    fn stop_requested(&self, conversation: &str) -> bool;
}

/// The handed repairs, at most one per chat. Clones share one.
#[derive(Clone)]
pub struct Repairs {
    inner: Arc<Inner>,
}

struct Inner {
    sessions: SessionStore,
    check: Arc<dyn RepairCheck>,
    fences: Arc<dyn ChatFences>,
    in_flight: Mutex<HashMap<String, Repair>>,
}

impl Repairs {
    pub fn new(
        sessions: SessionStore,
        check: Arc<dyn RepairCheck>,
        fences: Arc<dyn ChatFences>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions,
                check,
                fences,
                in_flight: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn in_flight(&self) -> std::sync::MutexGuard<'_, HashMap<String, Repair>> {
        self.inner
            .in_flight
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// The producer hands `repair` for `conversation`, replacing what that chat had.
    pub fn hand_out(&self, conversation: &str, repair: Repair) {
        self.in_flight().insert(conversation.to_owned(), repair);
    }

    /// The producer retires the chat's repair.
    pub fn retire(&self, conversation: &str) -> Option<Repair> {
        self.in_flight().remove(conversation)
    }

    /// The chat's repair, if one is in flight.
    pub fn get(&self, conversation: &str) -> Option<Repair> {
        self.in_flight().get(conversation).cloned()
    }

    /// `POST /repairs/claim`. `stale` is `staleCompanion(req)`: a companion on an older build
    /// while the shipped one is present is refused work before its body is read. `body` is the
    /// parsed body, or `None` when it could not be read.
    pub async fn claim(&self, stale: bool, body: Option<&Value>) -> Answer {
        if stale {
            return Answer::new(200, json!({ "allowed": false }));
        }
        let Some(body) = body else {
            return Answer::error(400, "bad_request");
        };
        let token = body
            .as_object()
            .and_then(|fields| fields.get("token"))
            .and_then(Value::as_str);
        let Some(token) = token.filter(|token| token.encode_utf16().count() <= 128) else {
            return Answer::error(400, "bad_request");
        };
        let found = self
            .in_flight()
            .iter()
            .find(|(_, repair)| {
                repair.reason.needs_claim() && repair.token == token && repair.handed
            })
            .map(|(conversation, repair)| (conversation.clone(), repair.clone()));
        let Some((conversation, repair)) = found else {
            return Answer::new(200, json!({ "allowed": false }));
        };
        let session = self.inner.sessions.summary(&repair.session_id).await;
        let current = session.as_ref().is_some_and(|session| {
            let manual_compaction =
                repair.reason == RepairReason::Compaction && repair.episode.ends_with(":manual");
            let departure_allows =
                session.browser_recovery_dismissed_at.is_none() || manual_compaction;
            let stopped = repair.reason != RepairReason::Compaction
                && session.active_turn_id.clone().flatten().is_none()
                && session.last_turn_outcome == Some(cos_types::session::TurnOutcome::Stopped);
            session.conversation_id.as_deref() == Some(&conversation)
                && departure_allows
                && !stopped
                && !self.inner.fences.blocked(&conversation)
                && !self.inner.fences.stop_requested(&conversation)
                && self.inner.check.current(&conversation, &repair, session)
        });
        let mut in_flight = self.in_flight();
        let allowed = current
            && self.inner.check.settled()
            && in_flight
                .get(&conversation)
                .is_some_and(|live| live == &repair && live.handed && !live.claimed);
        if allowed {
            if let Some(live) = in_flight.get_mut(&conversation) {
                live.claimed = true;
            }
            drop(in_flight);
            self.inner.check.claimed(&conversation, &repair);
        }
        Answer::new(200, json!({ "allowed": allowed }))
    }
}
