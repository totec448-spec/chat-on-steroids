//! Goal and Loop (unit E2.7): a second model, standing in for the user, that keeps a chat moving.
//!
//! The page owns "the turn is really over". This crate owns everything after that: the per-chat
//! objectives, switches and owed replies (three durable ledgers under `state/`), the credential,
//! the request to the helper model, and the one draft per finished turn the page may type.
//! [`Goal`] is the owner; `cos_bridge::families::goal` is its wire layer.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::watch;

use cos_secrets::SecretStore;
use cos_sessions::SessionStore;
use cos_store::{Durable, DurableError, DurableStore, Logger};

use cos_types::config::Config;

use cos_types::state::{GoalObjectives, GoalReplies, GoalSwitches};

mod context;
mod controls;
mod decision;
mod drafts;
mod errors;
mod finish;
mod human;
mod js;
mod ledger;
mod prompts;
mod provider;
mod replies;
mod routes;
mod templates;

pub use context::{ChatMessage, OutboxView, Role, conversation_messages, model_facing_text};
pub use decision::{Decision, normalize};
pub use drafts::{DraftStart, OpeningFailure};
pub use errors::{error_key, error_message, retryable};
pub use finish::{FinishGoal, FollowupFailure};
pub use human::{clip, human_reply};
pub use ledger::{
    MAX_REPLIES, MAX_SWITCHES, OBJECTIVES, REPLIES, REPLY_TTL_MS, SWITCHES, Switch, apply_switch,
    valid_conversation,
};
pub use provider::{Endpoint, OPENROUTER_BASE, resolve_base_url};
pub use routes::{Answer, SwitchChange, bad_request};
pub use templates::{
    CONTINUATIONS, MARKER_INSTRUCTION, continuation as template_continuation,
    decision as template_decision,
};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Milliseconds since the Unix epoch.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as u64)
    })
}

/// What the Goal owner reads from owners it does not hold. Each `No…` answer is what
/// TypeScript sees with that owner empty.
pub trait Chats: Send + Sync + 'static {
    /// `isChatBlocked`: the person blocked this chat in the app.
    fn blocked(&self, conversation: &str) -> bool;
    /// `goalWorkerChat`: a worker's conversation never runs its own Goal.
    fn worker(&self, conversation: &str) -> bool;
    /// The recorder's live session for this chat (`liveConversations()`).
    fn live_session(&self, conversation: &str) -> Option<String>;
    /// ChatGPT or a local call is still working in this chat (`chatIsWorking`, running calls).
    fn working(&self, conversation: &str) -> bool;
    /// The outbox rows a finish owner sent in this session, labelled automatic for the helper.
    fn automatic_inputs(&self, session: &str) -> BoxFuture<'static, HashSet<String>>;
}

/// No blocked chat, no worker, no live page, nothing working, no automatic sends.
pub struct NoChats;

impl Chats for NoChats {
    fn blocked(&self, _conversation: &str) -> bool {
        false
    }
    fn worker(&self, _conversation: &str) -> bool {
        false
    }
    fn live_session(&self, _conversation: &str) -> Option<String> {
        None
    }
    fn working(&self, _conversation: &str) -> bool {
        false
    }
    fn automatic_inputs(&self, _session: &str) -> BoxFuture<'static, HashSet<String>> {
        Box::pin(async { HashSet::new() })
    }
}

/// The ChatGPT helper: one decision in a Temporary Chat the extension drives
/// (`requestBrowserDecision`), and the helper model as this account can run it
/// (`goalHelperSelection`).
pub trait Helper: Send + Sync + 'static {
    /// The helper's model, or `None` for ChatGPT's current selection.
    fn model(&self, config: &Config) -> Option<String>;
    /// The helper's answer text for one rendered prompt.
    fn decide(
        &self,
        prompt: String,
        source_session: Option<String>,
    ) -> BoxFuture<'static, Result<String, String>>;
}

/// No browser helper: the request is refused as undeliverable, a settled failure.
pub struct NoHelper;

impl Helper for NoHelper {
    fn model(&self, config: &Config) -> Option<String> {
        Some(
            config
                .goal
                .helper_model
                .clone()
                .unwrap_or_else(|| "gpt-6".to_owned()),
        )
    }

    fn decide(
        &self,
        _prompt: String,
        _source: Option<String>,
    ) -> BoxFuture<'static, Result<String, String>> {
        Box::pin(async {
            Err(
                "goal_browser_send_failed: the ChatGPT helper is not available in this build"
                    .to_owned(),
            )
        })
    }
}

pub struct GoalDeps<'a> {
    pub config: watch::Receiver<Arc<Config>>,
    pub sessions: SessionStore,
    pub state: &'a DurableStore,
    /// The one store the Core shares; provider keys are read through it.
    pub secrets: Arc<Mutex<SecretStore>>,
    pub chats: Arc<dyn Chats>,
    pub helper: Arc<dyn Helper>,
    pub logger: Logger,
    pub clock: Clock,
    /// [`OPENROUTER_BASE`] in the app; a loopback stub in tests.
    pub openrouter_base: String,
}

/// The Goal owner. Cheap to clone.
#[derive(Clone)]
pub struct Goal {
    shared: Arc<Shared>,
}

pub(crate) struct Ledgers {
    pub objectives: ledger::Objectives,
    pub switches: ledger::Switches,
    pub replies: ledger::Replies,
    pub drafts: HashMap<String, drafts::Draft>,
    pub next_draft: u64,
}

pub(crate) struct Files {
    pub(crate) objectives: Durable<GoalObjectives>,
    pub(crate) switches: Durable<GoalSwitches>,
    pub(crate) replies: Durable<GoalReplies>,
}

pub(crate) struct Shared {
    pub config: watch::Receiver<Arc<Config>>,
    pub sessions: SessionStore,
    pub secrets: Arc<Mutex<SecretStore>>,
    pub chats: Arc<dyn Chats>,
    pub helper: Arc<dyn Helper>,
    pub logger: Logger,
    pub clock: Clock,
    pub openrouter_base: String,
    pub http: provider::Http,
    files: Option<Files>,
    /// One writer per file at a time: a snapshot is taken and written under it.
    objectives_writes: tokio::sync::Mutex<()>,
    switches_writes: tokio::sync::Mutex<()>,
    replies_writes: tokio::sync::Mutex<()>,
    /// The in-memory ledgers. Never held across an await.
    state: Mutex<Ledgers>,
    changes: watch::Sender<u64>,
}

/// A durable write that did not land.
#[derive(Debug)]
pub struct NotDurable(pub String);

impl std::fmt::Display for NotDurable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NotDurable {}

impl From<DurableError> for NotDurable {
    fn from(error: DurableError) -> Self {
        Self(error.to_string())
    }
}

async fn write_now<T: serde::Serialize + Send + Sync + 'static>(
    durable: &Durable<T>,
    value: T,
) -> Result<(), NotDurable> {
    let durable = durable.clone();
    tokio::task::spawn_blocking(move || durable.write_now(&value))
        .await
        .map_err(|error| NotDurable(error.to_string()))?
        .map_err(NotDurable::from)
}

impl Goal {
    pub fn new(deps: GoalDeps<'_>) -> Self {
        let files = match (
            deps.state.ledger(ledger::OBJECTIVES),
            deps.state.ledger(ledger::SWITCHES),
            deps.state.ledger(ledger::REPLIES),
        ) {
            (Ok(objectives), Ok(switches), Ok(replies)) => Some(Files {
                objectives,
                switches,
                replies,
            }),
            _ => None,
        };
        let (changes, _) = watch::channel(0);
        Self {
            shared: Arc::new(Shared {
                config: deps.config,
                sessions: deps.sessions,
                secrets: deps.secrets,
                chats: deps.chats,
                helper: deps.helper,
                logger: deps.logger,
                clock: deps.clock,
                openrouter_base: deps.openrouter_base,
                http: provider::Http::default(),
                files,
                objectives_writes: tokio::sync::Mutex::new(()),
                switches_writes: tokio::sync::Mutex::new(()),
                replies_writes: tokio::sync::Mutex::new(()),
                state: Mutex::new(Ledgers {
                    objectives: Default::default(),
                    switches: Default::default(),
                    replies: Default::default(),
                    drafts: HashMap::new(),
                    next_draft: 0,
                }),
                changes,
            }),
        }
    }

    /// Changes whenever a draft, a switch or a reply moves, for the UI to re-read.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.shared.changes.subscribe()
    }

    /// Reads the three ledgers, in the TypeScript order. Restoring never asks for a draft.
    pub async fn restore(&self) {
        let Some(files) = &self.shared.files else {
            return;
        };
        let (objectives, switches, replies) = (
            files.objectives.clone(),
            files.switches.clone(),
            files.replies.clone(),
        );
        let read = tokio::task::spawn_blocking(move || {
            (objectives.read(), switches.read(), replies.read())
        })
        .await;
        let Ok((objectives, switches, replies)) = read else {
            return;
        };
        let now = self.now();
        let mut state = self.lock();
        state.objectives = ledger::restore_objectives(objectives.as_ref());
        state.switches = ledger::restore_switches(switches.as_ref(), now);
        state.replies = ledger::restore_replies(replies.as_ref(), now);
    }

    pub(crate) fn now(&self) -> u64 {
        (self.shared.clock)()
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Ledgers> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub(crate) fn config(&self) -> Arc<Config> {
        self.shared.config.borrow().clone()
    }

    pub(crate) fn shared(&self) -> &Shared {
        &self.shared
    }

    pub(crate) fn shared_arc(&self) -> &Arc<Shared> {
        &self.shared
    }

    pub(crate) fn from_shared(shared: Arc<Shared>) -> Self {
        Self { shared }
    }

    pub(crate) fn files(&self) -> Result<&Files, NotDurable> {
        self.shared
            .files
            .as_ref()
            .ok_or_else(|| NotDurable("goal state is not available".to_owned()))
    }

    pub(crate) fn notify(&self) {
        self.shared.changes.send_modify(|revision| *revision += 1);
    }
}

/// `acceptGoalReplyNow`'s input.
#[derive(Clone, Debug, Default)]
pub struct AcceptReply {
    pub conversation_id: String,
    pub session_id: String,
    pub reply_id: String,
    pub turn_id: String,
    pub event_seq: u64,
    pub blocked: bool,
    pub silence_source_turn_id: Option<String>,
    pub silence_pro: bool,
    pub listen_until: Option<u64>,
    /// Retain proved exhausted silence while Off without creating active debt.
    pub handled_only: bool,
}
