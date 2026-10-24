//! The outbox: one durable owner for every message a person sends to a chat
//! (`session/input.ts`). Every operation runs under one queue and commits
//! `state/session-input.json` before it answers, so a claim, a receipt or a failure the browser
//! was told about is on disk first.
//!
//! A browser claim is exclusive and never retried automatically: losing its ACK is ambiguous.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use cos_sessions::{SessionStore, UpsertOptions};
use cos_store::{Durable, DurableStore, Logger};
use cos_types::config::Config;
use cos_types::ids::SessionId;
use cos_types::json::{JsNumber, True};
use cos_types::session::{
    EventBase, EventSource, InputDelivery, SessionEvent, SessionOriginKind, StoredText,
    UserMessageEvent,
};
use cos_types::state::{
    InputEntry, InputLifetime, InputMode, InputState, QueuedTurn, ToolDelivery, TransportIntent,
};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, MutexGuard, watch};

use crate::args::{InputArgs, MAX_INPUT_IMAGES};
use crate::entry::{
    browser_input_model, companion_of, decision, intent_is, manual_input, needs_history,
    never_authorized, ordered, pending_stages, preparable, queued_followup, same_delivery,
    terminal,
};
use crate::policy::{
    Policy, active_turn, astra_chat, composer_only_text, helper_or_worker_session, worker_session,
};
use crate::text::{js_length, js_slice};
use crate::{Clock, Notify};

mod claims;
mod enqueue;
mod expiry;
mod finish;
mod history;
mod opening;
mod receipts;

use enqueue::materialize_stages;
use expiry::release_recovery_claim;
use opening::{NO_PROJECT_OPENING, SETUP_FAILED};

const STATE: &str = "session-input";
/// `TOOL_INPUT_TEXT_BYTES`.
const TOOL_INPUT_TEXT_BYTES: usize = 128_000;
/// `TOOL_INPUT_HEADER`.
const TOOL_INPUT_HEADER: &str = "\n--- New instructions from the user ---\n";
/// A confirmed send receipt lands in seconds. This only bounds one that is never reported.
const UNCERTAIN_SEND_MS: u64 = 15 * 60_000;
/// The same bound for the sends the one above leaves in custody.
const ABANDONED_SEND_MS: u64 = 6 * 60 * 60_000;
const UNCLAIMED_PICKUP_MS: u64 = 60_000;
const UNCONFIRMED_SEND: &str = "Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.";
/// The page clicked native Send, but no row it could read proved the message arrived.
const RECEIPT_UNCONFIRMED: &str = "Native Send receipt was not confirmed.";
/// The page clicked Send, yet its exact text stayed in the composer.
const SEND_NOT_TAKEN: &str = "Native Send did not take the message.";
const NOT_TAKEN_FAILED: &str = "Not sent: ChatGPT did not accept the message.";
const PICKUP_TIMED_OUT: &str =
    "Not sent: the browser did not pick up this message within 60 seconds.";
const PICKUP_WITHDRAWN: &str = "After-turn pickup was withdrawn before Send.";
/// `CONVERSATION_DELETED` in `shared/chat-error.ts`.
pub const CONVERSATION_DELETED: &str =
    "This chat was deleted in ChatGPT. Start a new chat to continue.";
/// How long pages may keep withdrawing one automatic Continue before Send.
const RECOVERY_WITHDRAW_LIMIT_MS: u64 = 3 * 60_000;

/// A refusal the outbox explains in words a person can act on (a thrown `Error` in TypeScript).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboxError(pub String);

impl std::fmt::Display for OutboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OutboxError {}

fn refuse<T>(message: &str) -> Result<T, OutboxError> {
    Err(OutboxError(message.to_owned()))
}

pub struct OutboxDeps<'a> {
    pub sessions: SessionStore,
    pub state: &'a DurableStore,
    /// `<userData>`: staged attachments live in `input-attachments/`, sessions in `sessions/`.
    pub user_data: PathBuf,
    pub config: watch::Receiver<Arc<Config>>,
    pub logger: Logger,
    /// Called after every commit: the bridge wakes the extension (`wakeBrowserWork`).
    pub notify: Notify,
    pub clock: Clock,
}

/// The outbox. Clones share one.
#[derive(Clone)]
pub struct Outbox {
    inner: Arc<Inner>,
}

pub(crate) struct Inner {
    pub(crate) sessions: SessionStore,
    pub(crate) config: watch::Receiver<Arc<Config>>,
    pub(crate) logger: Logger,
    pub(crate) user_data: PathBuf,
    ledger: Option<Durable<Vec<InputEntry>>>,
    notify: Notify,
    clock: Clock,
    rows: Mutex<Option<Vec<InputEntry>>>,
}

type Rows<'a> = MutexGuard<'a, Option<Vec<InputEntry>>>;

/// One browser-visible outbox offer (`pendingBrowserInputs`).
pub type Offer = Value;

/// A temporary planner keeps only ownership metadata across restart, never its task or answer.
fn durable_row(row: &InputEntry) -> InputEntry {
    if row.lifetime == Some(InputLifetime::TemporaryPlanner) {
        InputEntry {
            text: "[Temporary planner]".into(),
            delivery_text: None,
            response: None,
            ..row.clone()
        }
    } else {
        row.clone()
    }
}

fn utf8_len(text: &str) -> usize {
    text.len()
}

/// `finishInstruction`.
pub(crate) fn finish_instruction(lead_minutes: Option<u8>) -> String {
    let minutes = if lead_minutes == Some(3) { 3 } else { 5 };
    format!(
        "Work through the whole requested task, including corrections. Use session_finish only when the requested implementation is complete and about {minutes} minutes of final verification remain. New instructions extend the work; they do not require another finish call. Do not use this tool for progress updates or to collect queued tasks."
    )
}

/// `combinedInput`: one checkpoint shares this browser send with the correction before it.
fn combined_input(root: &InputEntry, companion: Option<&InputEntry>) -> InputEntry {
    let Some(companion) = companion else {
        return root.clone();
    };
    let mut images = root.images.clone().unwrap_or_default();
    images.extend(companion.images.clone().unwrap_or_default());
    let mut attachments = root.attachments.clone().unwrap_or_default();
    attachments.extend(companion.attachments.clone().unwrap_or_default());
    InputEntry {
        text: format!(
            "{}\n\nNext queued instruction:\n{}",
            root.text, companion.text
        ),
        images: (!images.is_empty())
            .then_some(images)
            .or(root.images.clone()),
        attachments: (!attachments.is_empty())
            .then_some(attachments)
            .or(root.attachments.clone()),
        ..root.clone()
    }
}

impl Outbox {
    pub fn new(deps: OutboxDeps<'_>) -> Self {
        let ledger = match deps.state.ledger(STATE) {
            Ok(ledger) => Some(ledger),
            Err(error) => {
                deps.logger
                    .error(&format!("input: the outbox ledger is unavailable: {error}"));
                None
            }
        };
        Self {
            inner: Arc::new(Inner {
                sessions: deps.sessions,
                config: deps.config,
                logger: deps.logger,
                user_data: deps.user_data,
                ledger,
                notify: deps.notify,
                clock: deps.clock,
                rows: Mutex::new(None),
            }),
        }
    }

    pub(crate) fn inner(&self) -> &Inner {
        &self.inner
    }

    /// Shutdown: the queued ledger write.
    pub fn flush(&self) {
        if let Some(ledger) = &self.inner.ledger
            && let Err(error) = ledger.flush()
        {
            self.inner
                .logger
                .warn(&format!("input: could not flush the outbox: {error}"));
        }
    }

    /// `enqueueInput`: admit one message. The same id again answers the row it already made.
    pub async fn enqueue(&self, raw: &Value) -> Result<InputEntry, OutboxError> {
        let input = InputArgs::parse(raw).map_err(OutboxError)?;
        let mut rows = self.inner.rows.lock().await;
        self.inner.enqueue(&mut rows, input).await
    }

    /// `listInputs`: every row, in delivery order, after history publication.
    pub async fn list(&self) -> Result<Vec<InputEntry>, OutboxError> {
        let mut rows = self.inner.rows.lock().await;
        self.inner.list(&mut rows).await
    }

    /// `cancelInput`.
    pub async fn cancel(&self, id: &str) -> Result<bool, OutboxError> {
        let mut rows = self.inner.rows.lock().await;
        self.inner.cancel(&mut rows, id).await
    }

    /// `sessionInputPolicy(session).directTurn`: the answer this chat is writing now, which a
    /// message sent at once would join.
    pub async fn direct_turn(&self, session: &str) -> Option<cos_types::state::DirectTurn> {
        self.inner.policy(session).await.direct_turn
    }

    /// `pendingBrowserInputs`: what `/status` offers the extension.
    pub async fn pending(&self) -> Result<Vec<Offer>, OutboxError> {
        let mut rows = self.inner.rows.lock().await;
        self.inner.pending(&mut rows).await
    }

    /// `claimBrowserInput`.
    pub async fn claim(
        &self,
        id: &str,
        owner: &str,
        conversation: Option<&str>,
        requires_authorization: bool,
    ) -> Result<Option<Value>, OutboxError> {
        let mut rows = self.inner.rows.lock().await;
        self.inner
            .claim(&mut rows, id, owner, conversation, requires_authorization)
            .await
    }

    /// `authorizeBrowserInput`.
    pub async fn authorize(
        &self,
        id: &str,
        owner: &str,
        conversation: Option<&str>,
    ) -> Result<bool, OutboxError> {
        let mut rows = self.inner.rows.lock().await;
        self.inner
            .authorize(&mut rows, id, owner, conversation)
            .await
    }

    /// `acknowledgeBrowserInput`. `conversation` is `None` when the page sent none,
    /// `Some(None)` for an explicit `null`.
    pub async fn acknowledge(
        &self,
        id: &str,
        owner: &str,
        conversation: Option<Option<&str>>,
        message_id: Option<&str>,
    ) -> Result<bool, OutboxError> {
        let mut rows = self.inner.rows.lock().await;
        self.inner
            .acknowledge(&mut rows, id, owner, conversation, message_id)
            .await
    }

    /// `failBrowserInput`.
    pub async fn fail(
        &self,
        id: &str,
        owner: &str,
        error: &str,
        detail: Option<&str>,
    ) -> Result<bool, OutboxError> {
        let mut rows = self.inner.rows.lock().await;
        self.inner.fail(&mut rows, id, owner, error, detail).await
    }

    /// `bindBrowserInputProject`.
    pub async fn bind(
        &self,
        id: &str,
        owner: &str,
        conversation: &str,
    ) -> Result<bool, OutboxError> {
        let mut rows = self.inner.rows.lock().await;
        self.inner.bind(&mut rows, id, owner, conversation).await
    }

    /// `failInputsForDeletedConversation`: how many waiting messages ended.
    pub async fn conversation_deleted(&self, conversation: &str) -> Result<u64, OutboxError> {
        let mut rows = self.inner.rows.lock().await;
        self.inner
            .conversation_deleted(&mut rows, conversation)
            .await
    }

    /// `endRecoveryInput`: an unsent, unclaimed automatic Continue a page refused because the
    /// chat shows a finished answer.
    pub async fn end_recovery(&self, id: &str, conversation: &str) -> Result<bool, OutboxError> {
        let mut rows = self.inner.rows.lock().await;
        let current = self.inner.load(&mut rows).await?;
        let Some(row) = current
            .iter()
            .find(|row| {
                row.id == id
                    && row.recovery.is_some()
                    && row.state == InputState::Queued
                    && row.offered_at.is_none()
                    && row.send_authorized_at.is_none()
            })
            .cloned()
        else {
            return Ok(false);
        };
        let Some(session_id) = &row.session_id else {
            return Ok(false);
        };
        let session = self.inner.session(session_id).await;
        if session
            .and_then(|session| session.conversation_id)
            .as_deref()
            != Some(conversation)
        {
            return Ok(false);
        }
        let error = "Automatic Continue was not needed: the page shows a finished answer.";
        self.inner
            .logger
            .warn(&format!("input {}: {error}", row.id));
        let next = current
            .iter()
            .map(|entry| {
                if entry.id == row.id {
                    let mut ended = InputEntry {
                        state: InputState::Cancelled,
                        owner: None,
                        error: Some(error.into()),
                        ..entry.clone()
                    };
                    if let Some(recovery) = &mut ended.recovery {
                        recovery.ended = Some(cos_types::state::RecoveryEnded::PageFinal);
                    }
                    ended
                } else {
                    entry.clone()
                }
            })
            .collect();
        self.inner.commit(&mut rows, next).await?;
        Ok(true)
    }

    /// `completeBrowserDecision`. No Goal helper waits in this build, so only the answer a row
    /// already holds is accepted again.
    pub async fn complete_decision(
        &self,
        id: &str,
        owner: &str,
        response: &str,
    ) -> Result<bool, OutboxError> {
        if js_trim_empty(response) || js_length(response) > 16_000 {
            return Ok(false);
        }
        let mut rows = self.inner.rows.lock().await;
        let current = self.inner.load(&mut rows).await?;
        Ok(current.iter().any(|row| {
            row.id == id
                && row.owner.as_deref() == Some(owner)
                && decision(row)
                && row.state == InputState::Sent
                && row.response.as_deref() == Some(response)
        }))
    }
}

fn js_trim_empty(text: &str) -> bool {
    crate::text::js_trim(text).is_empty()
}

impl Inner {
    pub(crate) fn now(&self) -> u64 {
        (self.clock)()
    }

    /// `load`: the ledger, read strictly once, then the time rules.
    pub(crate) async fn load(&self, rows: &mut Rows<'_>) -> Result<Vec<InputEntry>, OutboxError> {
        if rows.is_none() {
            let loaded = self.read().await?;
            // A Goal helper outlives no process: its waiter is gone, so it is cancelled.
            let mut recovered: Vec<InputEntry> = loaded
                .iter()
                .map(|row| {
                    if decision(row) && !terminal(row) {
                        InputEntry {
                            state: InputState::Cancelled,
                            ..row.clone()
                        }
                    } else {
                        row.clone()
                    }
                })
                .collect();
            self.repair_openings(&mut recovered).await;
            **rows = Some(loaded.clone());
            let retired = self
                .retire_removed_session_receipts(rows, recovered, false)
                .await?;
            if retired != loaded {
                self.commit(rows, retired).await?;
            }
        }
        let current = rows.clone().unwrap_or_default();
        self.expire(rows, current).await
    }

    async fn read(&self) -> Result<Vec<InputEntry>, OutboxError> {
        let unreadable = || OutboxError("The message outbox could not be read safely".into());
        let Some(ledger) = self.ledger.clone() else {
            return Err(unreadable());
        };
        let raw = tokio::task::spawn_blocking(move || ledger.read_strict())
            .await
            .map_err(|_| unreadable())?
            .map_err(|_| unreadable())?;
        match raw {
            None => Ok(Vec::new()),
            Some(value) => serde_json::from_value(value).map_err(|_| unreadable()),
        }
    }

    /// `commit`: the whole outbox on disk before anyone hears of the change.
    pub(crate) async fn commit(
        &self,
        rows: &mut Rows<'_>,
        next: Vec<InputEntry>,
    ) -> Result<(), OutboxError> {
        let Some(ledger) = self.ledger.clone() else {
            return refuse("The message outbox could not be saved");
        };
        let durable: Vec<InputEntry> = next.iter().map(durable_row).collect();
        let writer = ledger.clone();
        let written = tokio::task::spawn_blocking(move || writer.write_now(&durable)).await;
        if !matches!(written, Ok(Ok(()))) {
            // Never let a rejected claim or enqueue become live later behind the caller's back.
            let previous: Vec<InputEntry> = rows
                .as_ref()
                .map(|rows| rows.iter().map(durable_row).collect())
                .unwrap_or_default();
            let _ = ledger.write_soon(&previous);
            return refuse("The message outbox could not be saved");
        }
        **rows = Some(next);
        (self.notify)();
        Ok(())
    }
}
