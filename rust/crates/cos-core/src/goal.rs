//! Builds the E2.7 Goal owner once, and the adapters through which it reads the owners it does
//! not hold: recorded chats (E2.2), blocked chats, the outbox (E2.3), the kernel's running
//! calls and the companion's helper model.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};

use cos_companion::{BoxFuture, ChatModels, ChatSwitches, helper_selection};
use cos_goal::{BoxFuture as GoalFuture, Chats, Goal, GoalDeps, Helper, NoHelper, OPENROUTER_BASE};
use cos_input::Outbox;
use cos_recorder::Recorder;
use cos_secrets::SecretStore;
use cos_sessions::{BlockedChatsLedger, SessionStore};
use cos_store::{DurableStore, Logger};
use cos_tools::Kernel;
use cos_types::config::{Config, GoalMode};
use serde_json::Value;
use tokio::sync::watch;

struct CoreChats {
    recorder: Recorder,
    blocked: BlockedChatsLedger,
    outbox: Outbox,
    kernel: Arc<Kernel>,
}

impl Chats for CoreChats {
    fn blocked(&self, conversation: &str) -> bool {
        self.blocked.is_blocked(Some(conversation))
    }

    /// No agent broker yet (E2.6): no chat is a worker.
    fn worker(&self, _conversation: &str) -> bool {
        false
    }

    fn live_session(&self, conversation: &str) -> Option<String> {
        self.recorder
            .live_conversations()
            .into_iter()
            .find(|live| live.conversation_id == conversation)
            .map(|live| live.session_id)
    }

    /// The kernel counts running calls only in total, so any running call keeps every chat
    /// working, as an unattributed call does in TypeScript.
    fn working(&self, conversation: &str) -> bool {
        self.kernel.counts().running > 0
            || self.recorder.live_conversations().iter().any(|live| {
                live.conversation_id == conversation
                    && (live.generating || live.active_turn_id.is_some())
            })
    }

    fn automatic_inputs(&self, session: &str) -> GoalFuture<'static, HashSet<String>> {
        let outbox = self.outbox.clone();
        let session = session.to_owned();
        Box::pin(async move {
            outbox
                .list()
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|row| {
                    row.session_id.as_deref() == Some(session.as_str())
                        && row.finish_owner.is_some()
                })
                .map(|row| row.id)
                .collect()
        })
    }
}

/// The helper model as the observed catalog offers it. No browser helper is ported yet.
struct CoreHelper {
    catalog: Arc<OnceLock<ChatModels>>,
}

impl Helper for CoreHelper {
    fn model(&self, config: &Config) -> Option<String> {
        match self.catalog.get() {
            Some(catalog) => helper_selection(config, &catalog.catalog()).model,
            None => NoHelper.model(config),
        }
    }

    fn decide(
        &self,
        prompt: String,
        source: Option<String>,
    ) -> GoalFuture<'static, Result<String, String>> {
        NoHelper.decide(prompt, source)
    }
}

/// The companion's view of the Goal owner: chat-scoped switches on `POST /settings`.
pub(crate) struct GoalSwitches(pub(crate) Goal);

impl ChatSwitches for GoalSwitches {
    fn served(&self) -> bool {
        true
    }

    fn set(
        &self,
        conversation: String,
        which: GoalMode,
        on: bool,
    ) -> BoxFuture<'static, Option<cos_companion::SwitchAnswer>> {
        let goal = self.0.clone();
        Box::pin(async move {
            Some(
                goal.settings_switch(&conversation, which, on)
                    .await
                    .map(|held| (held.enabled, held.mode))
                    .map_err(|answer| (answer.status, answer.body)),
            )
        })
    }

    fn after_turn(
        &self,
        conversation: String,
        after_turn: bool,
    ) -> BoxFuture<'static, Option<(u16, Value)>> {
        let goal = self.0.clone();
        Box::pin(async move {
            let answer = goal.settings_after_turn(&conversation, after_turn).await;
            Some((answer.status, answer.body))
        })
    }
}

pub(crate) struct GoalSources<'a> {
    pub(crate) config: watch::Receiver<Arc<Config>>,
    pub(crate) sessions: SessionStore,
    pub(crate) state: &'a DurableStore,
    pub(crate) secrets: Arc<Mutex<SecretStore>>,
    pub(crate) recorder: Recorder,
    pub(crate) blocked: BlockedChatsLedger,
    pub(crate) outbox: Outbox,
    pub(crate) kernel: Arc<Kernel>,
    /// Set once the companion has built the catalog owner.
    pub(crate) catalog: Arc<OnceLock<ChatModels>>,
    pub(crate) logger: Logger,
}

pub(crate) fn build(sources: GoalSources<'_>) -> Goal {
    Goal::new(GoalDeps {
        config: sources.config,
        sessions: sources.sessions,
        state: sources.state,
        secrets: sources.secrets,
        chats: Arc::new(CoreChats {
            recorder: sources.recorder,
            blocked: sources.blocked,
            outbox: sources.outbox,
            kernel: sources.kernel,
        }),
        helper: Arc::new(CoreHelper {
            catalog: sources.catalog,
        }),
        logger: sources.logger,
        clock: cos_goal::system_clock(),
        openrouter_base: OPENROUTER_BASE.to_owned(),
    })
}
