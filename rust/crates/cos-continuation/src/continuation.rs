//! The one-time transaction that moves a local session from ChatGPT chat A to chat B
//! (`session/continuation.ts`), and its write-ahead log `state/continuations.json`.
//!
//! The session is the durable identity; chats A and B are two frontends attached to it in turn.
//! The transaction runs `awaiting-summary` (the user asked), `awaiting-chat` (the brief is
//! stored), `claimed` (one replacement chat took it), `committing` (the move is durable intent)
//! and ends `committed` or `aborted`. Every semantic step is written to the WAL before memory
//! says so. The commit is preflight (the swarm handover is frozen), the durable session rebind
//! (the only step that can fail; a failure leaves chat A attached in memory and on disk), then
//! publication (pure map work, after the durable record already says chat B). A restart resolves
//! a `committing` record from the session itself.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cos_sessions::SessionStore;
use cos_store::{Durable, DurableStore, Logger};
use cos_types::config::Config;
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{Handoff, ReasoningEffort, SessionSummary};
use cos_types::state::{
    ContinuationDestinationCheckpoint, ContinuationRecord, ContinuationSendCheckpoint,
    ContinuationSendState as Send, ContinuationState as State, Continuations as Wal,
    RequestedModel, V1,
};
use serde_json::Value;
use tokio::sync::{OwnedMutexGuard, watch};

use crate::events::{ensure_handoff_recorded, record_handoff, record_note};
use crate::gate::ResumeGate;
use crate::handoff::{self, PLAN_NOTICE_HEAD, PrepareHandoff};
use crate::ports::{Freeze, PrimeTransfer, Projections};
use crate::{Clock, js};

/// How long a continuation may wait once its brief is captured.
pub const CONTINUATION_TTL_MS: u64 = 10 * 60_000;
/// How long an ordinary manual brief may take to write.
pub const CONTINUATION_WRITING_TTL_MS: u64 = 30 * 60_000;
/// How long a brief written under a frozen Pro selection may take.
pub const CONTINUATION_PRO_WRITING_TTL_MS: u64 = 60 * 60_000;
/// How long an automatic handover may run once its brief was asked for.
pub const AUTOMATIC_HANDOVER_TTL_MS: u64 = 6 * 60 * 60_000;
/// How long after the armed click a document may prove ChatGPT never received it.
pub const SOURCE_UNDELIVERED_AFTER_MS: u64 = 15_000;

const STATE: &str = "continuations";
const MAX_SUMMARY_UNITS: usize = 512 * 1024;
const MAX_RESTORED: usize = 32;
pub(crate) const RESUME_SHADOW_COLLISION: &str =
    "the replacement chat already belongs to another local session";

/// `/^[A-Za-z0-9_-]{16,64}$/`: a continuation token.
pub(crate) fn token_shaped(token: &str) -> bool {
    (16..=64).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `normalizeProjectId`: `g-p-` and 32 hex digits, or `None` (the site root).
pub fn normalize_project_id(value: Option<&str>) -> Option<String> {
    let candidate = value?.trim().to_lowercase();
    let hex = candidate.strip_prefix("g-p-")?;
    (hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(candidate)
}

/// `requestedModel`: a frozen selection worth carrying, or `None`.
fn requested_model(value: Option<&RequestedModel>) -> Option<RequestedModel> {
    let value = value?;
    let model_ok = (1..=80).contains(&value.model.len())
        && value
            .model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'_' | b'-'));
    model_ok.then(|| RequestedModel {
        model: value.model.clone(),
        reasoning_effort: value.reasoning_effort,
        extra: Extra::new(),
    })
}

fn checkpoint(state: Send) -> ContinuationSendCheckpoint {
    ContinuationSendCheckpoint {
        state,
        message_id: None,
        before: None,
        dispatched_at: None,
        extra: Extra::new(),
    }
}

fn destination(state: Send) -> ContinuationDestinationCheckpoint {
    ContinuationDestinationCheckpoint {
        conversation_id: None,
        send: checkpoint(state),
    }
}

/// `sendUnattempted`: the fence still proves no prompt was submitted.
pub fn send_unattempted(checkpoint: &ContinuationSendCheckpoint) -> bool {
    matches!(
        checkpoint.state,
        Send::NotAttempted | Send::AttemptedUnresolved
    )
}

fn terminal(state: State) -> bool {
    matches!(state, State::Committed | State::Aborted)
}

/// What a caller may know about one transaction (`ContinuationView`).
#[derive(Clone, Debug, PartialEq)]
pub struct View {
    pub requested_model: Option<RequestedModel>,
    pub touched_at: u64,
    pub token: String,
    pub session_id: SessionId,
    pub from: String,
    pub to: Option<String>,
    pub state: State,
    pub handoff_id: Option<String>,
    pub error: Option<String>,
    pub opened_at: u64,
    pub automatic: bool,
    pub asked_at: Option<u64>,
    pub project: Option<String>,
    pub source_send: ContinuationSendCheckpoint,
    pub destination_send: ContinuationDestinationCheckpoint,
}

/// `ContinuationCommitResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommitResult {
    Committed(String),
    AlreadyCommitted(String),
    Retryable(String),
    Rejected(String),
}

impl CommitResult {
    pub fn landed(&self) -> bool {
        matches!(self, Self::Committed(_) | Self::AlreadyCommitted(_))
    }
}

/// `beginContinuation*SendNow`: whether this document may type, and the fence it read.
#[derive(Clone, Debug, PartialEq)]
pub struct SendClaim<C> {
    pub allowed: bool,
    pub checkpoint: C,
}

#[derive(Clone, Debug)]
struct Entry {
    requested_model: Option<RequestedModel>,
    source_turn_id: Option<String>,
    token: String,
    session_id: SessionId,
    from: String,
    opened_at: u64,
    touched_at: u64,
    source_progress: u64,
    automatic: bool,
    asked_at: Option<u64>,
    state: State,
    summary: String,
    handoff_id: Option<String>,
    /// The stored handoff, so a repeated capture is answered with the same success.
    handoff: Option<Handoff>,
    claimed_by: Option<String>,
    to: Option<String>,
    project: Option<String>,
    source_send: ContinuationSendCheckpoint,
    destination_send: ContinuationDestinationCheckpoint,
    error: Option<String>,
    capture: Capture,
}

/// The single-flight capture: callers that joined attempt `n` all get its answer.
#[derive(Clone, Copy, Debug, Default)]
struct Capture {
    next: u64,
    running: Option<u64>,
    failed: Option<u64>,
}

impl Entry {
    /// `handoffAsked`: the brief request is on its way, went out, or was answered.
    fn asked(&self) -> bool {
        self.state != State::AwaitingSummary
            || matches!(
                self.source_send.state,
                Send::DispatchedUnresolved | Send::Sent
            )
    }

    /// `manualWaitingTtlMs`.
    fn manual_ttl(state: State, requested: Option<&RequestedModel>) -> u64 {
        if state != State::AwaitingSummary {
            return CONTINUATION_TTL_MS;
        }
        if requested.is_some_and(|requested| {
            cos_input::is_pro_model(Some(&requested.model), requested.reasoning_effort)
        }) {
            CONTINUATION_PRO_WRITING_TTL_MS
        } else {
            CONTINUATION_WRITING_TTL_MS
        }
    }

    /// `expired`.
    fn expired(&self, now: u64) -> bool {
        if self.automatic {
            self.asked_at
                .is_some_and(|asked| now.saturating_sub(asked) >= AUTOMATIC_HANDOVER_TTL_MS)
        } else {
            now.saturating_sub(self.touched_at)
                >= Self::manual_ttl(self.state, self.requested_model.as_ref())
        }
    }

    fn open(&self, now: u64) -> bool {
        !terminal(self.state) && !self.expired(now)
    }

    fn record(&self) -> ContinuationRecord {
        ContinuationRecord {
            requested_model: Some(requested_model(self.requested_model.as_ref())),
            source_turn_id: Some(self.source_turn_id.clone()),
            token: self.token.clone(),
            session_id: self.session_id.as_str().to_owned(),
            from: self.from.clone(),
            to: self.to.clone(),
            opened_at: self.opened_at,
            touched_at: Some(self.touched_at),
            source_progress: Some(self.source_progress),
            automatic: Some(self.automatic),
            asked_at: Some(self.asked_at),
            project: Some(self.project.clone()),
            state: self.state,
            summary: js::slice(&self.summary, 0, MAX_SUMMARY_UNITS),
            handoff_id: self.handoff_id.clone(),
            claimed_by: self.claimed_by.clone(),
            armed: None,
            source_send: Some(self.source_send.clone()),
            destination_send: Some(self.destination_send.clone()),
            error: self.error.clone(),
            extra: Extra::new(),
        }
    }

    /// `publishRecord`: the durable record, now accepted, becomes the live transaction.
    fn publish(&mut self, record: ContinuationRecord, now: u64) {
        self.to = record.to;
        self.project = normalize_project_id(record.project.flatten().as_deref());
        self.requested_model = requested_model(record.requested_model.flatten().as_ref());
        self.touched_at = self
            .touched_at
            .max(record.touched_at.unwrap_or(record.opened_at));
        self.source_progress = record.source_progress.unwrap_or(0);
        self.automatic = record.automatic == Some(true);
        self.state = record.state;
        self.summary = record.summary;
        self.handoff_id = record.handoff_id;
        self.claimed_by = record.claimed_by;
        self.source_send = record
            .source_send
            .unwrap_or_else(|| checkpoint(Send::NotAttempted));
        self.destination_send = record
            .destination_send
            .unwrap_or_else(|| destination(Send::NotAttempted));
        self.error = record.error;
        if self.asked_at.is_none() && self.asked() {
            self.asked_at = Some(record.asked_at.flatten().unwrap_or(now));
        }
    }

    fn view(&self) -> View {
        View {
            requested_model: requested_model(self.requested_model.as_ref()),
            touched_at: self.touched_at,
            token: self.token.clone(),
            session_id: self.session_id.clone(),
            from: self.from.clone(),
            to: self.to.clone(),
            state: self.state,
            handoff_id: self.handoff_id.clone(),
            error: self.error.clone(),
            opened_at: self.opened_at,
            automatic: self.automatic,
            asked_at: self.asked_at,
            project: self.project.clone(),
            source_send: self.source_send.clone(),
            destination_send: self.destination_send.clone(),
        }
    }
}

/// What [`Continuations::new`] needs.
pub struct ContinuationsDeps<'a> {
    pub sessions: SessionStore,
    pub state: &'a DurableStore,
    pub config: watch::Receiver<Arc<Config>>,
    pub logger: Logger,
    pub clock: Clock,
    pub prime: Arc<dyn PrimeTransfer>,
    pub projections: Arc<dyn Projections>,
}

/// The Compact & Resume transactions. Clones share one.
#[derive(Clone)]
pub struct Continuations {
    inner: Arc<Inner>,
}

struct Inner {
    sessions: SessionStore,
    durable: Option<Durable<Wal>>,
    config: watch::Receiver<Arc<Config>>,
    logger: Logger,
    clock: Clock,
    prime: Arc<dyn PrimeTransfer>,
    projections: Arc<dyn Projections>,
    gate: ResumeGate,
    /// In insertion order, which is the WAL's entry order.
    entries: Mutex<Vec<Entry>>,
    /// `withCheckpointLock`: one semantic step per transaction at a time.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// `commitLocks`: the chat B a commit in flight is for, and its answer once it has one.
    commits: Mutex<HashMap<String, CommitSlot>>,
    /// `openingBySession`: opens are rare, so one at a time.
    opening: tokio::sync::Mutex<()>,
}

/// The chat B a commit in flight is for, and where its answer is published.
type CommitSlot = (String, watch::Receiver<Option<CommitResult>>);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// `randomBytes(16).toString('base64url')`.
fn new_token() -> String {
    URL_SAFE_NO_PAD.encode(crate::random_bytes::<16>())
}

/// Why a durable step did not land.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotDurable(pub String);

impl std::fmt::Display for NotDurable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl Continuations {
    pub fn new(deps: ContinuationsDeps<'_>) -> Self {
        let durable = match deps.state.ledger::<Wal>(STATE) {
            Ok(durable) => Some(durable),
            Err(error) => {
                deps.logger
                    .warn(&format!("continuations: no durable ledger: {error}"));
                None
            }
        };
        Self {
            inner: Arc::new(Inner {
                sessions: deps.sessions,
                durable,
                config: deps.config,
                logger: deps.logger,
                clock: deps.clock,
                prime: deps.prime,
                projections: deps.projections,
                gate: ResumeGate::default(),
                entries: Mutex::new(Vec::new()),
                locks: Mutex::new(HashMap::new()),
                commits: Mutex::new(HashMap::new()),
                opening: tokio::sync::Mutex::new(()),
            }),
        }
    }

    fn now(&self) -> u64 {
        (self.inner.clock)()
    }

    pub(crate) fn sessions(&self) -> &SessionStore {
        &self.inner.sessions
    }

    pub(crate) fn logger(&self) -> &Logger {
        &self.inner.logger
    }

    pub(crate) fn config(&self) -> Arc<Config> {
        self.inner.config.borrow().clone()
    }

    /// The replacement-chat gate the recorder consults before inventing a session.
    pub fn gate(&self) -> &ResumeGate {
        &self.inner.gate
    }

    fn token_lock(&self, token: &str) -> Arc<tokio::sync::Mutex<()>> {
        lock(&self.inner.locks)
            .entry(token.to_owned())
            .or_default()
            .clone()
    }

    async fn checkpoint_lock(&self, token: &str) -> OwnedMutexGuard<()> {
        self.token_lock(token).lock_owned().await
    }

    fn busy(&self, token: &str) -> bool {
        lock(&self.inner.commits).contains_key(token)
            || lock(&self.inner.locks)
                .get(token)
                .is_some_and(|held| held.try_lock().is_err())
    }

    fn with_entry<T>(&self, token: &str, read: impl FnOnce(&mut Entry) -> T) -> Option<T> {
        lock(&self.inner.entries)
            .iter_mut()
            .find(|entry| entry.token == token)
            .map(read)
    }

    fn snapshot_with(&self, token: Option<&str>, replacement: Option<ContinuationRecord>) -> Wal {
        let entries = lock(&self.inner.entries);
        let mut replaced = false;
        let mut records: Vec<ContinuationRecord> = entries
            .iter()
            .map(|entry| match (&replacement, token) {
                (Some(record), Some(token)) if entry.token == token => {
                    replaced = true;
                    record.clone()
                }
                _ => entry.record(),
            })
            .collect();
        if let (Some(record), Some(_), false) = (replacement, token, replaced) {
            records.push(record);
        }
        Wal {
            version: V1,
            saved_at: self.now(),
            entries: records,
            extra: Extra::new(),
        }
    }

    fn write_now(&self, wal: &Wal) -> Result<(), NotDurable> {
        let Some(durable) = &self.inner.durable else {
            return Err(NotDurable("no durable ledger".into()));
        };
        durable
            .write_now(wal)
            .map_err(|error| NotDurable(error.to_string()))
    }

    /// `changed()`: the live transactions, written soon.
    fn changed(&self) {
        if let Some(durable) = &self.inner.durable {
            let _ = durable.write_soon(&self.snapshot_with(None, None));
        }
    }

    /// `flushDurable` for the WAL, before quitting.
    pub fn flush(&self) {
        if let Some(durable) = &self.inner.durable {
            let _ = durable.flush();
        }
    }

    /// `transitionNow`: writes the proposed record first, and only then publishes it. A rejected
    /// write leaves the previous state live and supersedes the failed generation.
    async fn transition(
        &self,
        token: &str,
        derive: impl FnOnce(&mut ContinuationRecord),
    ) -> Result<(), NotDurable> {
        let Some(current) = self.with_entry(token, |entry| entry.record()) else {
            return Err(NotDurable("the continuation no longer exists".into()));
        };
        let mut next = current.clone();
        derive(&mut next);
        let now = self.now();
        if next != current {
            next.touched_at = Some(now);
        }
        if let Err(error) = self.write_now(&self.snapshot_with(Some(token), Some(next.clone()))) {
            self.changed();
            return Err(error);
        }
        let state = next.state;
        self.with_entry(token, |entry| entry.publish(next, now));
        if terminal(state) {
            self.inner.gate.end(token);
        }
        Ok(())
    }

    /// `sweep`: aborts what outlived its wait, and forgets terminal records after twice the TTL.
    fn sweep(&self) {
        let now = self.now();
        let candidates: Vec<(String, bool, bool, bool)> = lock(&self.inner.entries)
            .iter()
            .map(|entry| {
                (
                    entry.token.clone(),
                    entry.state == State::Committing,
                    terminal(entry.state),
                    entry.expired(now),
                )
            })
            .collect();
        for (token, committing, ended, expired) in candidates {
            if committing || self.busy(&token) {
                continue;
            }
            if ended {
                lock(&self.inner.entries).retain(|entry| {
                    entry.token != token
                        || now.saturating_sub(entry.touched_at) <= CONTINUATION_TTL_MS * 2
                });
                continue;
            }
            if expired {
                let automatic = self.with_entry(&token, |entry| entry.automatic) == Some(true);
                self.abort(
                    &token,
                    if automatic {
                        "the handover never landed and was given up on"
                    } else {
                        "it took too long and was given up on"
                    },
                );
            }
        }
    }

    fn find(&self, matches: impl Fn(&Entry) -> bool) -> Option<View> {
        lock(&self.inner.entries)
            .iter()
            .find(|entry| matches(entry))
            .map(Entry::view)
    }

    /// `continuationForSession`: the open transaction of a session.
    pub fn for_session(&self, session: &SessionId) -> Option<View> {
        self.sweep();
        let now = self.now();
        self.find(|entry| &entry.session_id == session && entry.open(now))
    }

    /// `continuationByToken`: any retained transaction, open or ended.
    pub fn by_token(&self, token: &str) -> Option<View> {
        self.sweep();
        self.find(|entry| entry.token == token)
    }

    /// `compactingConversation`: the open transaction that has already asked this chat for its
    /// brief. The kernel refuses the chat's tool calls while there is one.
    pub fn compacting(&self, conversation: &str) -> Option<View> {
        if conversation.is_empty() {
            return None;
        }
        self.sweep();
        let now = self.now();
        self.find(|entry| entry.from == conversation && entry.open(now) && entry.asked())
    }

    /// `anyContinuationOpen`.
    pub fn any_open(&self) -> bool {
        let now = self.now();
        lock(&self.inner.entries)
            .iter()
            .any(|entry| entry.open(now))
    }

    /// `supersededSourceConversations`: source chats a commit replaced, sorted.
    pub fn superseded_sources(&self) -> Vec<String> {
        self.sweep();
        let mut out: Vec<String> = lock(&self.inner.entries)
            .iter()
            .filter(|entry| {
                entry.state == State::Committed
                    && entry.to.as_ref().is_some_and(|to| to != &entry.from)
            })
            .map(|entry| entry.from.clone())
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// `pendingContinuations`: tickets still owed a commit.
    pub fn pending(&self) -> Vec<View> {
        self.sweep();
        let now = self.now();
        lock(&self.inner.entries)
            .iter()
            .filter(|entry| entry.open(now))
            .map(Entry::view)
            .collect()
    }

    /// `continuationClaimedBy`.
    pub fn claimed_by(&self, token: &str, claimant: &str) -> bool {
        self.with_entry(token, |entry| entry.claimed_by.as_deref() == Some(claimant)) == Some(true)
    }

    /// `openContinuationNow`: durably opens a transaction for the session in `from`, or answers
    /// the one already open. Pressing the button twice is one transaction.
    pub async fn open(
        &self,
        session: &SessionId,
        from: &str,
        automatic: bool,
        project: Option<&str>,
    ) -> Result<View, NotDurable> {
        self.sweep();
        let _opening = self.inner.opening.lock().await;
        let now = self.now();
        if let Some(open) = self.find(|entry| &entry.session_id == session && entry.open(now)) {
            return Ok(open);
        }
        let source = self.inner.sessions.summary(session).await;
        let source_turn = source
            .as_ref()
            .and_then(|summary| summary.active_turn_id.clone().flatten());
        let requested = source.as_ref().and_then(|summary| {
            let selected = summary.selected_model.as_ref()?;
            (summary.conversation_id.as_deref() == Some(from) && selected.conversation_id == from)
                .then(|| RequestedModel {
                    model: selected.model.clone(),
                    reasoning_effort: selected.reasoning_effort,
                    extra: Extra::new(),
                })
        });
        let entry = Entry {
            requested_model: requested_model(requested.as_ref()),
            source_turn_id: source_turn,
            token: new_token(),
            session_id: session.clone(),
            from: from.to_owned(),
            opened_at: now,
            touched_at: now,
            source_progress: 0,
            automatic,
            asked_at: None,
            state: State::AwaitingSummary,
            summary: String::new(),
            handoff_id: None,
            handoff: None,
            claimed_by: None,
            to: None,
            project: normalize_project_id(project),
            source_send: checkpoint(Send::NotAttempted),
            destination_send: destination(Send::NotAttempted),
            error: None,
            capture: Capture::default(),
        };
        let record = entry.record();
        if let Err(error) = self.write_now(&self.snapshot_with(Some(&entry.token), Some(record))) {
            self.changed();
            return Err(error);
        }
        let view = entry.view();
        lock(&self.inner.entries).push(entry);
        self.inner.prime.begin(from);
        self.inner.logger.info(&format!(
            "continuation {} durably opened for session {session} in chat {from}",
            short(&view.token)
        ));
        Ok(view)
    }

    /// `beginContinuationSourceSendNow`: the durable step before chat A's composer is submitted.
    pub async fn begin_source_send(
        &self,
        token: &str,
        project: Option<Option<&str>>,
    ) -> Result<Option<SendClaim<ContinuationSendCheckpoint>>, NotDurable> {
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let Some(send) = self.with_entry(token, |entry| {
            (entry.open(now) && entry.state == State::AwaitingSummary)
                .then(|| entry.source_send.clone())
        }) else {
            return Ok(None);
        };
        let Some(send) = send else {
            return Ok(None);
        };
        match send.state {
            Send::AttemptedUnresolved => {
                return Ok(Some(SendClaim {
                    allowed: true,
                    checkpoint: send,
                }));
            }
            Send::NotAttempted => {}
            _ => {
                return Ok(Some(SendClaim {
                    allowed: false,
                    checkpoint: send,
                }));
            }
        }
        self.transition(token, |record| {
            if let Some(project) = project {
                record.project = Some(normalize_project_id(project));
            }
            record.source_send = Some(checkpoint(Send::AttemptedUnresolved));
        })
        .await?;
        Ok(self.with_entry(token, |entry| SendClaim {
            allowed: true,
            checkpoint: entry.source_send.clone(),
        }))
    }

    /// `dispatchContinuationSourceSendNow`: arms the click, exclusively.
    pub async fn dispatch_source_send(
        &self,
        token: &str,
        before: Option<&str>,
    ) -> Result<bool, NotDurable> {
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let ready = self.with_entry(token, |entry| {
            entry.open(now)
                && entry.state == State::AwaitingSummary
                && entry.source_send.state == Send::AttemptedUnresolved
        });
        if ready != Some(true) {
            return Ok(false);
        }
        let before = before
            .filter(|text| !text.is_empty())
            .map(|text| js::slice(text, 0, 200));
        self.transition(token, |record| {
            let mut send = checkpoint(Send::DispatchedUnresolved);
            send.before = Some(before);
            send.dispatched_at = Some(now);
            record.source_send = Some(send);
        })
        .await?;
        Ok(true)
    }

    /// `releaseUndeliveredSourceDispatchNow`: hands an armed click back when a later document
    /// still shows the message that was newest before it.
    pub async fn release_undelivered_source(
        &self,
        token: &str,
        newest_user_message: Option<&str>,
        document_since: f64,
    ) -> Result<Option<ContinuationSendCheckpoint>, NotDurable> {
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let releasable = self.with_entry(token, |entry| {
            let send = &entry.source_send;
            let before = send
                .before
                .clone()
                .flatten()
                .filter(|text| !text.is_empty());
            entry.open(now)
                && entry.state == State::AwaitingSummary
                && send.state == Send::DispatchedUnresolved
                && before.is_some()
                && send.dispatched_at.is_some_and(|at| {
                    newest_user_message == before.as_deref()
                        && document_since > at as f64
                        && now.saturating_sub(at) >= SOURCE_UNDELIVERED_AFTER_MS
                })
        });
        if releasable != Some(true) {
            return Ok(None);
        }
        self.transition(token, |record| {
            record.source_send = Some(checkpoint(Send::AttemptedUnresolved));
        })
        .await?;
        Ok(self.with_entry(token, |entry| entry.source_send.clone()))
    }

    /// `abortContinuationSourceBeforeSendNow`: abandons a handoff the page can still prove was
    /// never sent.
    pub async fn abort_source_before_send(
        &self,
        token: &str,
        reason: &str,
    ) -> Result<bool, NotDurable> {
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let Some(Some((automatic, session, from, turn))) = self.with_entry(token, |entry| {
            (entry.open(now)
                && entry.state == State::AwaitingSummary
                && send_unattempted(&entry.source_send))
            .then(|| {
                (
                    entry.automatic,
                    entry.session_id.clone(),
                    entry.from.clone(),
                    entry.source_turn_id.clone(),
                )
            })
        }) else {
            return Ok(false);
        };
        if automatic {
            self.inner
                .sessions
                .refuse_automatic_compaction(&session, &from, turn.as_deref())
                .await
                .map_err(NotDurable)?;
        }
        self.transition(token, |record| {
            record.state = State::Aborted;
            record.error = Some(reason.to_owned());
        })
        .await?;
        self.inner.prime.cancel(&from);
        self.inner.logger.warn(&format!(
            "continuation {} durably abandoned before source Send — {reason}",
            short(token)
        ));
        self.note_abandoned(&session, token, reason);
        Ok(true)
    }

    /// `bindContinuationSourceMessageNow`: ties the marked prompt to ChatGPT's user-message id.
    /// A later report of growth renews a manual deadline, at most twice a minute.
    pub async fn bind_source_message(
        &self,
        token: &str,
        message: &str,
        progress: Option<f64>,
    ) -> Result<bool, NotDurable> {
        if message.is_empty() || js::len(message) > 200 {
            return Ok(false);
        }
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let progress = progress
            .filter(|value| value.fract() == 0.0 && (0.0..=4_000_000.0).contains(value))
            .map(|value| value as u64);
        let Some(Some((send, automatic, known, touched))) = self.with_entry(token, |entry| {
            (entry.open(now) && entry.state == State::AwaitingSummary).then(|| {
                (
                    entry.source_send.clone(),
                    entry.automatic,
                    entry.source_progress,
                    entry.touched_at,
                )
            })
        }) else {
            return Ok(false);
        };
        match send.state {
            Send::Sent => {
                if send.message_id.as_deref() != Some(message) {
                    return Ok(false);
                }
                if let Some(progress) = progress
                    && !automatic
                    && progress > known
                    && now.saturating_sub(touched) >= 30_000
                {
                    self.transition(token, |record| record.source_progress = Some(progress))
                        .await?;
                }
                Ok(true)
            }
            Send::DispatchedUnresolved => {
                self.transition(token, |record| {
                    record.source_progress = Some(progress.unwrap_or(0));
                    let mut sent = checkpoint(Send::Sent);
                    sent.message_id = Some(message.to_owned());
                    record.source_send = Some(sent);
                })
                .await?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// `beginContinuationDestinationSendNow`: the durable step before chat B's composer is
    /// submitted.
    pub async fn begin_destination_send(
        &self,
        token: &str,
    ) -> Result<Option<SendClaim<ContinuationDestinationCheckpoint>>, NotDurable> {
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let Some(Some(send)) = self.with_entry(token, |entry| {
            (entry.open(now) && entry.handoff_id.is_some() && entry.state != State::AwaitingSummary)
                .then(|| entry.destination_send.clone())
        }) else {
            return Ok(None);
        };
        match send.send.state {
            Send::AttemptedUnresolved => {
                return Ok(Some(SendClaim {
                    allowed: true,
                    checkpoint: send,
                }));
            }
            Send::NotAttempted => {}
            _ => {
                return Ok(Some(SendClaim {
                    allowed: false,
                    checkpoint: send,
                }));
            }
        }
        self.transition(token, |record| {
            record.destination_send = Some(destination(Send::AttemptedUnresolved));
        })
        .await?;
        Ok(self.with_entry(token, |entry| SendClaim {
            allowed: true,
            checkpoint: entry.destination_send.clone(),
        }))
    }

    /// `dispatchContinuationDestinationSendNow`: arms chat B's click, exclusively.
    pub async fn dispatch_destination_send(&self, token: &str) -> Result<bool, NotDurable> {
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let ready = self.with_entry(token, |entry| {
            entry.open(now)
                && entry.handoff_id.is_some()
                && entry.state != State::AwaitingSummary
                && entry.destination_send.send.state == Send::AttemptedUnresolved
        });
        if ready != Some(true) {
            return Ok(false);
        }
        self.transition(token, |record| {
            record.destination_send = Some(destination(Send::DispatchedUnresolved));
        })
        .await?;
        self.inner.gate.note_dispatch(token, now);
        Ok(true)
    }

    /// `releaseContinuationDestinationSendNow`: takes an armed chat B dispatch back on proof that
    /// nothing left the page, so the brief can be offered to a fresh chat. With
    /// `unattempted_claimant`, only that claimant's still-unattempted claim is released.
    pub async fn release_destination_send(
        &self,
        token: &str,
        unattempted_claimant: Option<&str>,
    ) -> Result<bool, NotDurable> {
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let Some(Some((state, claimed))) = self.with_entry(token, |entry| {
            (entry.open(now) && entry.handoff_id.is_some() && entry.state != State::AwaitingSummary)
                .then(|| (entry.destination_send.send.state, entry.claimed_by.clone()))
        }) else {
            return Ok(false);
        };
        if let Some(claimant) = unattempted_claimant
            && (claimed.as_deref() != Some(claimant) || state != Send::NotAttempted)
        {
            return Ok(false);
        }
        if state == Send::Sent {
            return Ok(false);
        }
        if state == Send::NotAttempted && claimed.is_none() {
            return Ok(true);
        }
        self.transition(token, |record| {
            if record.state == State::Claimed {
                record.state = State::AwaitingChat;
            }
            record.claimed_by = None;
            record.destination_send = Some(destination(Send::NotAttempted));
        })
        .await?;
        self.inner.gate.end(token);
        Ok(true)
    }

    /// `bindContinuationDestinationMessageNow`: ties the marked bootstrap to chat B and its
    /// message. Re-proving an already-sent pair stays true after the commit.
    pub async fn bind_destination_message(
        &self,
        token: &str,
        conversation: &str,
        message: &str,
    ) -> Result<bool, NotDurable> {
        if conversation.is_empty()
            || message.is_empty()
            || js::len(conversation) > 256
            || js::len(message) > 200
        {
            return Ok(false);
        }
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let Some(Some((send, open, committed_here))) = self.with_entry(token, |entry| {
            (entry.handoff_id.is_some() && conversation != entry.from).then(|| {
                (
                    entry.destination_send.clone(),
                    entry.open(now),
                    entry.state == State::Committed && entry.to.as_deref() == Some(conversation),
                )
            })
        }) else {
            return Ok(false);
        };
        if send.send.state == Send::Sent {
            return Ok(send.conversation_id.as_deref() == Some(conversation)
                && send.send.message_id.as_deref() == Some(message));
        }
        if (!open && !committed_here) || send.send.state != Send::DispatchedUnresolved {
            return Ok(false);
        }
        self.transition(token, |record| {
            let mut sent = destination(Send::Sent);
            sent.conversation_id = Some(conversation.to_owned());
            sent.send.message_id = Some(message.to_owned());
            record.destination_send = Some(sent);
        })
        .await?;
        Ok(true)
    }

    /// `attachSummary`: stores ChatGPT's final answer as this transaction's one handoff. A
    /// repeated capture is answered with the handoff that already exists; `None` means "not
    /// stored, ask again" for every caller of a failed attempt.
    pub async fn attach_summary(&self, token: &str, text: &str) -> Option<Handoff> {
        let brief = js::trim(text);
        if brief.is_empty() {
            return None;
        }
        self.sweep();
        let joined = self.with_entry(token, |entry| entry.capture.running)?;
        let capture_lock = self.token_lock(&format!("capture:{token}"));
        let _capture = capture_lock.lock().await;
        let now = self.now();
        let (stored, failed, open, state, session, from, turn) =
            self.with_entry(token, |entry| {
                (
                    entry.handoff.clone(),
                    entry.capture.failed,
                    entry.open(now),
                    entry.state,
                    entry.session_id.clone(),
                    entry.from.clone(),
                    entry.source_turn_id.clone(),
                )
            })?;
        if let Some(handoff) = stored {
            if js::trim(&handoff.text) != brief {
                self.inner.logger.warn(&format!(
                    "continuation {} re-captured a different brief; keeping handoff {}",
                    short(token),
                    handoff.id
                ));
            }
            if let Err(error) = ensure_handoff_recorded(
                &self.inner.sessions,
                &session,
                &handoff.id,
                js::len(&handoff.text) as u64,
                token,
                now,
            )
            .await
            {
                self.inner.logger.warn(&format!(
                    "continuation {} could not repair handoff event {} on retry — {error}",
                    short(token),
                    handoff.id
                ));
            }
            return Some(handoff);
        }
        if joined.is_some() && joined == failed {
            return None;
        }
        if !open || state != State::AwaitingSummary {
            return None;
        }
        let attempt = self
            .with_entry(token, |entry| {
                let attempt = entry.capture.next;
                entry.capture.next += 1;
                entry.capture.running = Some(attempt);
                attempt
            })
            .unwrap_or_default();
        let produced = handoff::prepare(
            &self.inner.sessions,
            &self.inner.logger,
            PrepareHandoff {
                session: &session,
                text: brief,
                continuation_token: token,
                source_conversation: Some(&from),
                source_turn: turn.as_deref(),
                now,
            },
        )
        .await;
        let accepted = match produced {
            Ok(handoff) => self.accept_capture(token, handoff).await,
            Err(error) => Err(error),
        };
        self.with_entry(token, |entry| {
            entry.capture.running = None;
            if accepted.is_err() {
                entry.capture.failed = Some(attempt);
            }
        });
        match accepted {
            Ok(Some(handoff)) => {
                if let Err(error) = record_handoff(
                    &self.inner.sessions,
                    &session,
                    &handoff.id,
                    js::len(&handoff.text) as u64,
                    token,
                    self.now(),
                )
                .await
                {
                    self.inner.logger.warn(&format!(
                        "continuation {} committed handoff {} but could not publish its session event — {error}",
                        short(token),
                        handoff.id
                    ));
                }
                self.inner.logger.info(&format!(
                    "continuation {} captured handoff {}",
                    short(token),
                    handoff.id
                ));
                Some(handoff)
            }
            Ok(None) => None,
            Err(error) => {
                self.inner.logger.warn(&format!(
                    "continuation {} could not store the brief — {error}",
                    short(token)
                ));
                None
            }
        }
    }

    /// The capture's WAL transition: the brief is claimable only once this lands.
    async fn accept_capture(
        &self,
        token: &str,
        handoff: Handoff,
    ) -> Result<Option<Handoff>, String> {
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let ready = self.with_entry(token, |entry| {
            entry.open(now) && entry.state == State::AwaitingSummary
        });
        if ready != Some(true) {
            return Ok(None);
        }
        let text = handoff.text.clone();
        let id = handoff.id.clone();
        self.transition(token, |record| {
            record.summary = text;
            record.handoff_id = Some(id);
            record.state = State::AwaitingChat;
            record.error = None;
        })
        .await
        .map_err(|error| error.0)?;
        self.with_entry(token, |entry| entry.handoff = Some(handoff.clone()));
        Ok(Some(handoff))
    }

    /// `reopenWithHandoffNow`: a new Compact & Resume from the summary an abandoned one
    /// captured, refused unless it is the session's latest handoff from its current chat.
    pub async fn reopen_with_handoff(&self, session: &SessionId, handoff: &str) -> Option<View> {
        self.sweep();
        let summary = self.inner.sessions.summary(session).await?;
        let chat = summary.conversation_id.clone()?;
        if summary.last_handoff_id.as_deref() != Some(handoff) {
            return None;
        }
        let now = self.now();
        if self
            .find(|entry| &entry.session_id == session && entry.open(now))
            .is_some()
        {
            return None;
        }
        let saved = self.inner.sessions.read_handoff(session, handoff).await?;
        if saved
            .provenance
            .as_ref()
            .is_some_and(|provenance| provenance.source_conversation_id.as_deref() != Some(&chat))
        {
            return None;
        }
        let brief = match saved.text.rfind(PLAN_NOTICE_HEAD) {
            Some(cut) => &saved.text[..cut],
            None => &saved.text,
        };
        let brief = js::trim(brief).to_owned();
        if brief.is_empty() {
            return None;
        }
        let prior_project = saved
            .provenance
            .as_ref()
            .and_then(|provenance| provenance.continuation_id.clone())
            .and_then(|id| {
                lock(&self.inner.entries)
                    .iter()
                    .find(|entry| handoff::continuation_id(&entry.token).as_deref() == Some(&id))
                    .and_then(|entry| entry.project.clone())
            });
        let opened = self
            .open(session, &chat, false, prior_project.as_deref())
            .await
            .ok()?;
        if opened.state != State::AwaitingSummary {
            return None;
        }
        let token = opened.token.clone();
        {
            let _lock = self.checkpoint_lock(&token).await;
            let now = self.now();
            let ready = self.with_entry(&token, |entry| {
                entry.open(now)
                    && entry.state == State::AwaitingSummary
                    && entry.source_send.state == Send::NotAttempted
            });
            if ready != Some(true) {
                return None;
            }
            self.transition(&token, |record| {
                record.source_send = Some(checkpoint(Send::Sent));
            })
            .await
            .ok()?;
        }
        let Some(stored) = self.attach_summary(&token, &brief).await else {
            let _ = self
                .abort_now(&token, "the saved summary could not be stored again")
                .await;
            return None;
        };
        self.inner.logger.info(&format!(
            "continuation {} reopened from handoff {handoff} as {}",
            short(&token),
            stored.id
        ));
        self.by_token(&token)
    }

    /// `claimContinuationNow`: one replacement chat takes the brief. The same claimant again is
    /// a retry; any other is refused. Never moves the state backwards.
    pub async fn claim(&self, token: &str, claimant: &str) -> Result<Option<String>, NotDurable> {
        self.sweep();
        let now = self.now();
        if lock(&self.inner.commits).contains_key(token)
            && let Some(Some(summary)) = self.with_entry(token, |entry| {
                (entry.open(now) && entry.claimed_by.as_deref() == Some(claimant))
                    .then(|| entry.summary.clone())
            })
        {
            return Ok(Some(summary));
        }
        let _lock = self.checkpoint_lock(token).await;
        let now = self.now();
        let Some(Some((state, claimed))) = self.with_entry(token, |entry| {
            entry
                .open(now)
                .then(|| (entry.state, entry.claimed_by.clone()))
        }) else {
            return Ok(None);
        };
        if state == State::AwaitingSummary
            || claimed.as_deref().is_some_and(|owner| owner != claimant)
        {
            return Ok(None);
        }
        if state == State::AwaitingChat {
            self.transition(token, |record| {
                record.claimed_by = Some(claimant.to_owned());
                record.state = State::Claimed;
            })
            .await?;
        } else if state == State::Claimed && claimed.is_none() {
            self.transition(token, |record| {
                record.claimed_by = Some(claimant.to_owned());
            })
            .await?;
        }
        let (state, dispatched, summary) = self
            .with_entry(token, |entry| {
                (
                    entry.state,
                    matches!(
                        entry.destination_send.send.state,
                        Send::DispatchedUnresolved | Send::Sent
                    ),
                    entry.summary.clone(),
                )
            })
            .unwrap_or((state, false, String::new()));
        if state == State::Claimed {
            if dispatched {
                self.inner.gate.note_dispatch(token, now);
            } else {
                self.inner.gate.note_claim(token, now);
            }
        }
        Ok(Some(summary))
    }

    /// `commitContinuationResult`: moves the session to chat B. Distinguishes retryable local
    /// failures, terminal refusals and an idempotent repeat.
    pub async fn commit(&self, token: &str, to: &str) -> CommitResult {
        self.sweep();
        if self.with_entry(token, |_| ()).is_none() {
            return CommitResult::Rejected("the continuation no longer exists".into());
        }
        let joined = lock(&self.inner.commits).get(token).cloned();
        if let Some((owner, mut answer)) = joined {
            if owner != to {
                return CommitResult::Rejected(
                    "another replacement chat already owns the commit".into(),
                );
            }
            loop {
                if let Some(result) = answer.borrow().clone() {
                    return result;
                }
                if answer.changed().await.is_err() {
                    return answer
                        .borrow()
                        .clone()
                        .unwrap_or_else(|| CommitResult::Retryable("the commit stopped".into()));
                }
            }
        }
        let (publish, answer) = watch::channel(None);
        lock(&self.inner.commits).insert(token.to_owned(), (to.to_owned(), answer));
        let result = {
            let _lock = self.checkpoint_lock(token).await;
            self.commit_unlocked(token, to).await
        };
        let _ = publish.send(Some(result.clone()));
        lock(&self.inner.commits).remove(token);
        result
    }

    async fn commit_unlocked(&self, token: &str, to: &str) -> CommitResult {
        let Some((state, from, owner, handoff, session, open)) = self.with_entry(token, |entry| {
            (
                entry.state,
                entry.from.clone(),
                entry.to.clone(),
                entry.handoff_id.clone(),
                entry.session_id.clone(),
                entry.open(self.now()),
            )
        }) else {
            return CommitResult::Rejected("the continuation no longer exists".into());
        };
        if to.is_empty() || to == from {
            return CommitResult::Rejected(
                "the replacement chat is not a distinct conversation".into(),
            );
        }
        if state == State::Committed {
            if owner.as_deref().is_some_and(|owner| owner != to) {
                return CommitResult::Rejected(
                    "the continuation already committed to a different chat".into(),
                );
            }
            let committed_to = owner.unwrap_or_else(|| to.to_owned());
            if let Some(handoff) = &handoff
                && let Err(reason) = self
                    .repair_provenance(&session, &committed_to, handoff)
                    .await
            {
                return CommitResult::Retryable(reason);
            }
            return CommitResult::AlreadyCommitted(committed_to);
        }
        if state == State::Committing {
            if owner.as_deref() != Some(to) {
                return CommitResult::Rejected(
                    "another replacement chat already owns the commit".into(),
                );
            }
            return self.reconcile(token, to).await;
        }
        if !open || !matches!(state, State::AwaitingChat | State::Claimed) {
            return CommitResult::Rejected("the continuation is not ready to commit".into());
        }
        if let Err(error) = self
            .transition(token, |record| {
                record.state = State::Committing;
                record.to = Some(to.to_owned());
                record.error = None;
            })
            .await
        {
            return CommitResult::Retryable(format!(
                "the continuation intent could not be persisted: {error}"
            ));
        }
        self.reconcile(token, to).await
    }

    async fn repair_provenance(
        &self,
        session: &SessionId,
        to: &str,
        handoff: &str,
    ) -> Result<(), String> {
        match self
            .inner
            .sessions
            .ensure_committed_resume_handoff(session, to, handoff)
            .await
        {
            Ok(true) => Ok(()),
            Ok(false) => {
                Err("the committed resume handoff provenance could not be repaired".into())
            }
            Err(error) => Err(format!(
                "the committed resume handoff provenance could not be repaired: {error}"
            )),
        }
    }

    /// `rollbackCommitting`: back to a claimable state, with the reason.
    async fn rollback(&self, token: &str, error: &str) -> bool {
        let result = self
            .transition(token, |record| {
                record.state = if record.claimed_by.is_some() {
                    State::Claimed
                } else {
                    State::AwaitingChat
                };
                record.to = None;
                record.error = Some(error.to_owned());
            })
            .await;
        if let Err(failure) = &result {
            self.inner.logger.warn(&format!(
                "continuation {} could not persist its retry state — {failure}",
                short(token)
            ));
        }
        result.is_ok()
    }

    /// `finishCommittedRecord`: a failure here is logged, never reported as a failed move.
    async fn finish_committed(&self, token: &str, to: &str) {
        if let Err(error) = self
            .transition(token, |record| {
                record.state = State::Committed;
                record.to = Some(to.to_owned());
                record.error = None;
            })
            .await
        {
            self.inner.logger.warn(&format!(
                "continuation {} moved its session but could not persist the completion record — {error}",
                short(token)
            ));
        }
    }

    /// `publishCommittedProjection`: pure map work after the durable record says chat B.
    fn publish_committed(
        &self,
        token: &str,
        session: &SessionId,
        from: &str,
        to: &str,
        swarm: Swarm,
    ) {
        self.inner.projections.committed(session, from, to);
        let prime = &self.inner.prime;
        match swarm {
            Swarm::Frozen | Swarm::Absent => {
                if !prime.commit(from, to) && swarm == Swarm::Frozen {
                    self.inner.logger.warn(&format!(
                        "continuation {} committed after its run ended; no prime to move",
                        short(token)
                    ));
                }
            }
            Swarm::Recovery => {
                if !prime.repair(from, to) && !prime.commit(from, to) && prime.has_fleet(from) {
                    self.inner.logger.warn(&format!(
                        "continuation {} recovered, but its sub-agent fleet is still led from {from}",
                        short(token)
                    ));
                }
            }
        }
    }

    /// `reconcileCommitting`: the durable half of the commit, decided from the session itself.
    async fn reconcile(&self, token: &str, to: &str) -> CommitResult {
        let Some((session_id, from, handoff)) = self.with_entry(token, |entry| {
            (
                entry.session_id.clone(),
                entry.from.clone(),
                entry.handoff_id.clone(),
            )
        }) else {
            return CommitResult::Rejected("the continuation no longer exists".into());
        };
        let Some(session) = self.inner.sessions.summary(&session_id).await else {
            return CommitResult::Rejected("the local session no longer exists".into());
        };
        if session.conversation_id.as_deref() == Some(to) {
            if let Some(handoff) = &handoff
                && let Err(reason) = self.repair_provenance(&session_id, to, handoff).await
            {
                return CommitResult::Retryable(reason);
            }
            self.publish_committed(token, &session_id, &from, to, Swarm::Recovery);
            self.finish_committed(token, to).await;
            return CommitResult::AlreadyCommitted(to.to_owned());
        }
        if session.conversation_id.as_deref() != Some(&from) {
            let reason =
                "the local session is attached to an unexpected chat, so recovery refused to guess";
            if self
                .transition(token, |record| {
                    record.state = State::Aborted;
                    record.error = Some(reason.into());
                })
                .await
                .is_err()
            {
                return CommitResult::Retryable(reason.into());
            }
            self.inner.prime.cancel(&from);
            return CommitResult::Rejected(reason.into());
        }
        if provider_shaped(to)
            && let Some(target) = self.inner.sessions.find_by_conversation(to, true)
            && target.id != session_id
        {
            return if self.rollback(token, RESUME_SHADOW_COLLISION).await {
                CommitResult::Rejected(RESUME_SHADOW_COLLISION.into())
            } else {
                CommitResult::Retryable(RESUME_SHADOW_COLLISION.into())
            };
        }
        let swarm = match self.inner.prime.freeze(&from) {
            Freeze::Unavailable => {
                let reason = "no swarm handover is open for this chat, so the session stayed in the current chat";
                if self.rollback(token, reason).await {
                    self.inner.logger.warn(&format!(
                        "continuation {} refused: no usable prime handover from {from}",
                        short(token)
                    ));
                    return CommitResult::Rejected(reason.into());
                }
                return CommitResult::Retryable(reason.into());
            }
            Freeze::Frozen => Swarm::Frozen,
            Freeze::Absent => Swarm::Absent,
        };
        let moved = self
            .inner
            .sessions
            .rebind_session(&session_id, Some(&from), to, handoff.as_deref())
            .await;
        if !moved {
            let after = self.inner.sessions.summary(&session_id).await;
            if after
                .as_ref()
                .is_some_and(|after| after.conversation_id.as_deref() == Some(to))
            {
                if let Some(handoff) = &handoff
                    && let Err(reason) = self.repair_provenance(&session_id, to, handoff).await
                {
                    return CommitResult::Retryable(reason);
                }
                self.publish_committed(token, &session_id, &from, to, swarm);
                self.finish_committed(token, to).await;
                return CommitResult::Committed(to.to_owned());
            }
            if swarm == Swarm::Frozen {
                self.inner.prime.thaw(&from);
            }
            if after
                .as_ref()
                .is_some_and(|after| after.conversation_id.as_deref() != Some(&from))
            {
                let reason =
                    "the local session changed ownership while the continuation was committing";
                if self
                    .transition(token, |record| {
                        record.state = State::Aborted;
                        record.error = Some(reason.into());
                    })
                    .await
                    .is_err()
                {
                    return CommitResult::Retryable(reason.into());
                }
                self.inner.prime.cancel(&from);
                return CommitResult::Rejected(reason.into());
            }
            let reason = "the local session could not be moved to the new chat";
            self.rollback(token, reason).await;
            self.inner.logger.warn(&format!(
                "continuation {} could not rebind session {session_id}",
                short(token)
            ));
            return CommitResult::Retryable(reason.into());
        }
        self.publish_committed(token, &session_id, &from, to, swarm);
        self.finish_committed(token, to).await;
        self.inner.logger.info(&format!(
            "continuation {} committed: session {session_id} is now chat {to}",
            short(token)
        ));
        CommitResult::Committed(to.to_owned())
    }

    /// `abortContinuation`: gives up, leaving the session in chat A, written soon. Refused once
    /// the durable phase has started.
    pub fn abort(&self, token: &str, reason: &str) -> bool {
        if self.busy(token) {
            return false;
        }
        let Some(Some((session, from))) = self.with_entry(token, |entry| {
            if entry.state == State::Committing || terminal(entry.state) {
                return None;
            }
            entry.state = State::Aborted;
            entry.error = Some(reason.to_owned());
            Some((entry.session_id.clone(), entry.from.clone()))
        }) else {
            return false;
        };
        self.inner.gate.end(token);
        self.inner.prime.cancel(&from);
        self.changed();
        self.inner.logger.warn(&format!(
            "continuation {} abandoned — {reason}",
            short(token)
        ));
        self.note_abandoned(&session, token, reason);
        true
    }

    /// `abortContinuationNow`: the durable abort of a user-visible cancellation. An automatic
    /// ticket first refuses its current source turn, so a restart cannot refile it.
    pub async fn abort_now(&self, token: &str, reason: &str) -> Result<bool, NotDurable> {
        let _lock = self.checkpoint_lock(token).await;
        let Some(Some((automatic, session, from, turn))) = self.with_entry(token, |entry| {
            (entry.state != State::Committing && !terminal(entry.state)).then(|| {
                (
                    entry.automatic,
                    entry.session_id.clone(),
                    entry.from.clone(),
                    entry.source_turn_id.clone(),
                )
            })
        }) else {
            return Ok(false);
        };
        if automatic
            && let Some(source) = self.inner.sessions.summary(&session).await
            && source.conversation_id.as_deref() == Some(&from)
        {
            let current = source.active_turn_id.clone().flatten().or(turn);
            self.inner
                .sessions
                .refuse_automatic_compaction(&session, &from, current.as_deref())
                .await
                .map_err(NotDurable)?;
        }
        self.transition(token, |record| {
            record.state = State::Aborted;
            record.error = Some(reason.to_owned());
        })
        .await?;
        self.inner.prime.cancel(&from);
        self.inner.logger.warn(&format!(
            "continuation {} durably abandoned — {reason}",
            short(token)
        ));
        self.note_abandoned(&session, token, reason);
        Ok(true)
    }

    /// `noteAbandoned`: the reason goes into the session the transaction was compacting.
    fn note_abandoned(&self, session: &SessionId, token: &str, reason: &str) {
        if !self.config().sessions.record {
            return;
        }
        let sessions = self.inner.sessions.clone();
        let session = session.clone();
        let token = token.to_owned();
        let text = format!("Compact & Resume abandoned — {reason}");
        let now = self.now();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                record_note(&sessions, &session, &text, Some(&token), now).await;
            });
        }
    }

    /// `restoreContinuations`: rebuilds the transactions from the WAL after the session and agent
    /// projections are loaded. A `committing` record is resolved from the session: attached to
    /// B means the move landed, still A means it can be retried, anything else is refused.
    pub async fn restore(&self) {
        lock(&self.inner.entries).clear();
        let raw = self.inner.durable.as_ref().and_then(Durable::read);
        let now = self.now();
        for raw in parse_entries(raw.as_ref()).into_iter().take(MAX_RESTORED) {
            let Some(mut entry) = restored_entry(&raw, now) else {
                continue;
            };
            self.recover(&mut entry, now).await;
            lock(&self.inner.entries).push(entry);
        }
        if let Err(error) = self.write_now(&self.snapshot_with(None, None)) {
            self.inner.logger.warn(&format!(
                "continuation recovery could not persist its repaired snapshot: {error}"
            ));
        }
    }

    async fn recover(&self, entry: &mut Entry, now: u64) {
        let token = entry.token.clone();
        let waiting_expired = !terminal(entry.state) && entry.expired(now);
        let mut conflict = false;
        if let Some(id) = entry.handoff_id.clone() {
            entry.handoff = self
                .inner
                .sessions
                .read_handoff(&entry.session_id, &id)
                .await;
            if let Some(handoff) = &entry.handoff
                && !handoff::matches_continuation(
                    handoff,
                    &token,
                    &entry.from,
                    entry.source_turn_id.as_deref(),
                )
            {
                conflict = true;
                self.inner.logger.warn(&format!(
                    "continuation {} refused handoff {}: stored provenance belongs to another transaction",
                    short(&token),
                    handoff.id
                ));
                entry.handoff = None;
            }
        }
        if let Some(handoff) = &entry.handoff
            && entry.state != State::AwaitingSummary
            && let Err(error) = ensure_handoff_recorded(
                &self.inner.sessions,
                &entry.session_id,
                &handoff.id,
                js::len(&handoff.text) as u64,
                &token,
                now,
            )
            .await
        {
            self.inner.logger.warn(&format!(
                "continuation {} could not repair handoff event {} — {error}",
                short(&token),
                handoff.id
            ));
        }
        let lost_handoff = || {
            if conflict {
                "The saved handoff belongs to a different continuation."
            } else {
                "The saved handoff could not be recovered."
            }
        };
        let prime = &self.inner.prime;
        if matches!(entry.state, State::Committing | State::Committed) {
            let session: Option<SessionSummary> =
                self.inner.sessions.summary(&entry.session_id).await;
            let attached = session
                .as_ref()
                .and_then(|session| session.conversation_id.clone());
            if let Some(to) = entry
                .to
                .clone()
                .filter(|to| attached.as_deref() == Some(to))
            {
                if let Some(handoff) = entry.handoff_id.clone()
                    && !conflict
                    && let Err(error) = self
                        .repair_provenance(&entry.session_id, &to, &handoff)
                        .await
                {
                    self.inner.logger.warn(&format!(
                        "continuation {} could not repair committed resume provenance — {error}",
                        short(&token)
                    ));
                }
                self.publish_committed(
                    &token,
                    &entry.session_id,
                    &entry.from,
                    &to,
                    Swarm::Recovery,
                );
                entry.state = State::Committed;
                entry.error = None;
                self.inner.logger.info(&format!(
                    "continuation {} recovered after durable commit",
                    short(&token)
                ));
            } else if entry.state == State::Committing
                && session.is_some()
                && attached.as_deref() == Some(&entry.from)
            {
                if entry.handoff.is_none() {
                    entry.state = State::Aborted;
                    entry.to = None;
                    entry.error = Some(lost_handoff().into());
                    prime.cancel(&entry.from);
                } else if waiting_expired {
                    entry.state = State::Aborted;
                    entry.to = None;
                    entry.error = Some(
                        "Recovery found the continuation had already expired before the durable session move."
                            .into(),
                    );
                    prime.cancel(&entry.from);
                } else {
                    prime.thaw(&entry.from);
                    entry.state = if entry.claimed_by.is_some() {
                        State::Claimed
                    } else {
                        State::AwaitingChat
                    };
                    entry.to = None;
                    entry.error = Some(
                        "Recovered before the durable session move; the continuation can be retried."
                            .into(),
                    );
                    prime.begin(&entry.from);
                }
            } else if entry.state == State::Committed {
                self.inner.logger.info(&format!(
                    "continuation {} stays committed although its session moved on again",
                    short(&token)
                ));
            } else {
                entry.state = State::Aborted;
                entry.error = Some(
                    "Recovery found an unexpected session attachment and refused to guess a chat."
                        .into(),
                );
                prime.cancel(&entry.from);
            }
        } else if entry.state != State::Aborted {
            if waiting_expired {
                entry.state = State::Aborted;
                entry.error = Some("Recovery found the continuation had already expired.".into());
                prime.cancel(&entry.from);
            } else if entry.state != State::AwaitingSummary && entry.handoff.is_none() {
                entry.state = State::Aborted;
                entry.error = Some(lost_handoff().into());
                prime.cancel(&entry.from);
            } else {
                prime.begin(&entry.from);
            }
        }
        if entry.state == State::Claimed {
            if matches!(
                entry.destination_send.send.state,
                Send::DispatchedUnresolved | Send::Sent
            ) {
                self.inner.gate.note_dispatch(&token, now);
            } else {
                self.inner.gate.note_claim(&token, now);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Swarm {
    Frozen,
    Absent,
    Recovery,
}

fn short(token: &str) -> &str {
    token.get(..8).unwrap_or(token)
}

/// `/^[0-9a-f-]{8,64}$/i`.
fn provider_shaped(conversation: &str) -> bool {
    (8..=64).contains(&conversation.len())
        && conversation
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn parse_entries(raw: Option<&Value>) -> Vec<Value> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    if raw.get("version").and_then(Value::as_u64) != Some(1) {
        return Vec::new();
    }
    raw.get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn text_field(raw: &Value, key: &str) -> Option<String> {
    raw.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn finite(raw: &Value, key: &str) -> Option<f64> {
    raw.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn send_state(raw: &Value) -> Option<Send> {
    match raw.get("state")?.as_str()? {
        "not-attempted" => Some(Send::NotAttempted),
        "attempted-unresolved" => Some(Send::AttemptedUnresolved),
        "dispatched-unresolved" => Some(Send::DispatchedUnresolved),
        "sent" => Some(Send::Sent),
        _ => None,
    }
}

fn state_of(raw: &Value) -> Option<State> {
    match raw.get("state")?.as_str()? {
        "awaiting-summary" => Some(State::AwaitingSummary),
        "awaiting-chat" => Some(State::AwaitingChat),
        "claimed" => Some(State::Claimed),
        "committing" => Some(State::Committing),
        "committed" => Some(State::Committed),
        "aborted" => Some(State::Aborted),
        _ => None,
    }
}

fn effort_of(raw: Option<&Value>) -> Option<Option<ReasoningEffort>> {
    match raw {
        None | Some(Value::Null) => Some(None),
        Some(value) => serde_json::from_value(value.clone()).ok().map(Some),
    }
}

/// `requestedModel(raw.requestedModel)` on an untyped record.
fn raw_requested(raw: Option<&Value>) -> Option<RequestedModel> {
    let raw = raw?.as_object()?;
    let model = raw.get("model")?.as_str()?.to_owned();
    let effort = effort_of(raw.get("reasoningEffort"))?;
    requested_model(Some(&RequestedModel {
        model,
        reasoning_effort: effort,
        extra: Extra::new(),
    }))
}

/// One WAL record, validated as `restoreContinuations` does.
fn restored_entry(raw: &Value, now: u64) -> Option<Entry> {
    let token = text_field(raw, "token")?;
    let session = text_field(raw, "sessionId")?;
    let from = text_field(raw, "from")?;
    let state = state_of(raw)?;
    let opened_at = finite(raw, "openedAt")?;
    let requested = raw_requested(raw.get("requestedModel"));
    let retention = Entry::manual_ttl(state, requested.as_ref()) as f64 * 2.0;
    let touched_raw = finite(raw, "touchedAt");
    let last_touched = touched_raw
        .filter(|at| *at <= now as f64)
        .unwrap_or(opened_at);
    let automatic = raw.get("automatic").and_then(Value::as_bool) == Some(true);
    let session_ok = (8..=64).contains(&session.len())
        && session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let stale = now as f64 - last_touched >= retention;
    if !token_shaped(&token)
        || !session_ok
        || from.is_empty()
        || js::len(&from) > 256
        || (terminal(state) && stale)
        || (!automatic && stale)
    {
        return None;
    }
    let session_id = SessionId::parse(session).ok()?;
    let opened = opened_at.max(0.0) as u64;
    let touched_at = touched_raw
        .filter(|at| *at >= opened_at && *at <= now as f64)
        .map_or(opened, |at| at as u64);
    let source_progress = raw
        .get("sourceProgress")
        .and_then(Value::as_u64)
        .filter(|progress| *progress <= 4_000_000)
        .unwrap_or(0);
    let source_send = match raw
        .get("sourceSend")
        .and_then(|send| Some((send, send_state(send)?)))
    {
        Some((send, state)) => {
            let mut checkpoint = checkpoint(state);
            checkpoint.message_id = send
                .get("messageId")
                .and_then(Value::as_str)
                .map(|id| js::slice(id, 0, 200));
            if state == Send::DispatchedUnresolved
                && let (Some(before), Some(at)) = (
                    send.get("before").and_then(Value::as_str),
                    finite(send, "dispatchedAt"),
                )
            {
                checkpoint.before = Some(Some(js::slice(before, 0, 200)));
                checkpoint.dispatched_at = Some(at.max(0.0) as u64);
            }
            checkpoint
        }
        // The retired `armed` flag was raised around the click, so it migrates to the
        // ambiguous state.
        None if raw.get("armed").and_then(Value::as_bool) == Some(true) => {
            checkpoint(Send::DispatchedUnresolved)
        }
        None => checkpoint(Send::NotAttempted),
    };
    let destination_send = match raw
        .get("destinationSend")
        .and_then(|send| Some((send, send_state(send)?)))
    {
        Some((send, state)) => {
            let mut checkpoint = destination(state);
            checkpoint.conversation_id = send
                .get("conversationId")
                .and_then(Value::as_str)
                .map(|id| js::slice(id, 0, 256));
            checkpoint.send.message_id = send
                .get("messageId")
                .and_then(Value::as_str)
                .map(|id| js::slice(id, 0, 200));
            checkpoint
        }
        None => destination(Send::NotAttempted),
    };
    let mut entry = Entry {
        requested_model: requested,
        source_turn_id: text_field(raw, "sourceTurnId"),
        token,
        session_id,
        from,
        opened_at: opened,
        touched_at,
        source_progress,
        automatic,
        asked_at: None,
        state,
        summary: text_field(raw, "summary")
            .map(|summary| js::slice(&summary, 0, MAX_SUMMARY_UNITS))
            .unwrap_or_default(),
        handoff_id: text_field(raw, "handoffId"),
        handoff: None,
        claimed_by: text_field(raw, "claimedBy"),
        to: text_field(raw, "to").filter(|to| !to.is_empty()),
        project: normalize_project_id(raw.get("project").and_then(Value::as_str)),
        source_send,
        destination_send,
        error: text_field(raw, "error"),
        capture: Capture::default(),
    };
    if entry.asked() {
        entry.asked_at = Some(
            finite(raw, "askedAt")
                .map(|at| at.max(0.0) as u64)
                .unwrap_or(now),
        );
    }
    Some(entry)
}
