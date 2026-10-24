//! Unit E2.5's owners: Compact & Resume, the held finish boundary and repair claims, wired to
//! the owners this build has. Workers (E2.6), Goal and Loop (E2.7), browser recovery and the
//! resume command are not here yet; their ports answer as TypeScript does when they hold
//! nothing.

use std::sync::Arc;

use cos_continuation::compact::{Compact, CompactChats, NoResumeCommands};
use cos_continuation::finish::{BoxFuture, Finish, FinishChats, FinishDeps, FinishInputs};
use cos_continuation::repairs::{ChatFences, NoRepairCheck, Repairs};
use cos_continuation::{Continuations, ContinuationsDeps, NoPrime, Projections};
use cos_input::Outbox;
use cos_recorder::Recorder;
use cos_sessions::{BlockedChatsLedger, SessionStore};
use cos_store::{DurableStore, Logger};
use cos_types::config::Config;
use cos_types::ids::SessionId;
use tokio::sync::watch;

#[derive(Clone)]
pub(crate) struct ContinuationOwners {
    pub(crate) continuations: Continuations,
    pub(crate) finish: Finish,
    pub(crate) compact: Compact,
    pub(crate) repairs: Repairs,
}

/// The outbox, as the finish boundary asks it.
struct Inputs(Outbox);

impl FinishInputs for Inputs {
    fn waiting(&self, session: &SessionId) -> BoxFuture<'static, bool> {
        let outbox = self.0.clone();
        let session = session.as_str().to_owned();
        Box::pin(async move { outbox.finish_waiting(&session).await })
    }

    fn needs_browser(&self, session: &SessionId) -> BoxFuture<'static, bool> {
        let outbox = self.0.clone();
        let session = session.as_str().to_owned();
        Box::pin(async move { outbox.finish_needs_browser(&session).await })
    }

    /// Tool delivery (`offerToolInput`) is not ported: no message joins a tool result.
    fn tool_input(&self, _session: &SessionId) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
}

/// Blocked chats from their ledger; no worker and no automatic Goal yet.
struct Chats {
    blocked: BlockedChatsLedger,
    recorder: Recorder,
}

impl FinishChats for Chats {
    fn blocked(&self, conversation: &str) -> bool {
        self.blocked.is_blocked(Some(conversation))
    }
    fn worker(&self, _conversation: &str) -> bool {
        false
    }
    fn automatic(&self, _conversation: &str) -> bool {
        false
    }
}

impl CompactChats for Chats {
    fn live_session(&self, conversation: &str) -> Option<SessionId> {
        self.recorder
            .live_conversations()
            .into_iter()
            .find(|live| live.conversation_id == conversation)
            .and_then(|live| SessionId::parse(live.session_id).ok())
    }
    fn worker(&self, _conversation: &str) -> bool {
        false
    }
    fn blocked(&self, conversation: &str) -> bool {
        self.blocked.is_blocked(Some(conversation))
    }
}

impl ChatFences for Chats {
    fn blocked(&self, conversation: &str) -> bool {
        self.blocked.is_blocked(Some(conversation))
    }
    /// The Stop owner's per-chat request is not ported.
    fn stop_requested(&self, _conversation: &str) -> bool {
        false
    }
}

/// The recorder's live mapping follows the session; workspace and Goal have no owner yet.
struct Follow(Recorder);

impl Projections for Follow {
    fn committed(&self, session: &SessionId, from: &str, to: &str) {
        self.0.rebind_conversation(session, from, to);
    }
}

pub(crate) fn build(
    sessions: &SessionStore,
    state: &DurableStore,
    config: watch::Receiver<Arc<Config>>,
    outbox: &Outbox,
    blocked: &BlockedChatsLedger,
    recorder: &Recorder,
    logger: &Logger,
) -> ContinuationOwners {
    let chats = Arc::new(Chats {
        blocked: blocked.clone(),
        recorder: recorder.clone(),
    });
    let continuations = Continuations::new(ContinuationsDeps {
        sessions: sessions.clone(),
        state,
        config: config.clone(),
        logger: logger.clone(),
        clock: cos_continuation::system_clock(),
        prime: Arc::new(NoPrime),
        projections: Arc::new(Follow(recorder.clone())),
    });
    let finish = Finish::new(FinishDeps {
        sessions: sessions.clone(),
        config,
        inputs: Arc::new(Inputs(outbox.clone())),
        chats: chats.clone(),
        notifier: None,
        clock: cos_continuation::system_clock(),
    });
    let compact = Compact::new(
        continuations.clone(),
        Arc::new(NoResumeCommands),
        chats.clone(),
    );
    let repairs = Repairs::new(sessions.clone(), Arc::new(NoRepairCheck), chats);
    ContinuationOwners {
        continuations,
        finish,
        compact,
        repairs,
    }
}

/// Compact & Resume's part of the chat policy the composer switches ask about. Workers (E2.6)
/// and Goal drafts (E2.7) have no owner yet.
pub(crate) struct Policy {
    pub(crate) sessions: SessionStore,
    pub(crate) blocked: BlockedChatsLedger,
    pub(crate) compact: Compact,
    pub(crate) goal: cos_goal::Goal,
}

impl cos_companion::ChatPolicy for Policy {
    fn superseded(&self, conversation: String) -> cos_companion::BoxFuture<'static, bool> {
        let superseded = self.sessions.conversation_superseded(&conversation);
        Box::pin(async move { superseded })
    }

    fn blocked(&self, conversation: &str) -> bool {
        self.blocked.is_blocked(Some(conversation))
    }

    fn worker(&self, _conversation: &str) -> bool {
        false
    }

    fn cancel_automatic_resumes(&self) -> cos_companion::BoxFuture<'static, Result<(), String>> {
        let compact = self.compact.clone();
        Box::pin(async move {
            compact
                .cancel_automatic_resumes(None)
                .await
                .map(|_| ())
                .map_err(|error| error.0)
        })
    }

    fn retire_goal_drafts(&self, all: bool) {
        self.goal.retire_drafts(all);
    }
}

/// `browserTabPolicy`'s Compact & Resume facts: a source chat the commit replaced is managed and
/// may be closed once, and a chat still being compacted is never discarded.
pub(crate) fn tab_facts(
    tabs: &mut cos_types::bridge::TabPolicy,
    open: &[String],
    continuations: &Continuations,
) {
    let open = |id: &String| open.contains(id);
    let protected: Vec<String> = continuations
        .pending()
        .into_iter()
        .map(|entry| entry.from)
        .collect();
    let superseded = continuations.superseded_sources();
    let merge = |into: &mut Vec<String>, more: Vec<String>| {
        into.extend(more);
        into.sort();
        into.dedup();
    };
    merge(
        &mut tabs.managed_conversations,
        superseded.iter().filter(|id| open(id)).cloned().collect(),
    );
    let closable: Vec<String> = superseded
        .iter()
        .filter(|id| open(id) && !protected.contains(id))
        .cloned()
        .collect();
    merge(&mut tabs.retired_conversations, closable.clone());
    merge(&mut tabs.closable_conversations, closable);
    merge(&mut tabs.non_discardable_conversations, protected);
}

#[cfg(test)]
mod tests {
    use cos_continuation::NoProjections;
    use cos_store::AppPaths;
    use cos_store::config::recovery_config;
    use cos_types::bridge::TabPolicy;
    use cos_types::json::Record;

    use super::*;

    fn empty() -> TabPolicy {
        TabPolicy {
            idle_reuse_after_ms: 120_000,
            idle_close_after_ms: 300_000,
            cancelled_decision_claims: Vec::new(),
            retired_conversations: Vec::new(),
            conversation_activity_at: Record::new(),
            managed_conversations: Vec::new(),
            reusable_conversations: Vec::new(),
            non_discardable_conversations: Vec::new(),
            blocked_conversations: Vec::new(),
            closable_conversations: Vec::new(),
        }
    }

    #[tokio::test]
    async fn a_replaced_source_chat_is_closed_once_and_a_compacting_one_is_kept() {
        let profile = std::env::temp_dir().join(format!("cos-core-tabs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let paths = AppPaths::at(&profile);
        let logger = Logger::with_clock(|| 0, false);
        let sessions = SessionStore::open(&paths, logger.clone());
        let state = DurableStore::new(paths.state(), logger.clone());
        let continuations = Continuations::new(ContinuationsDeps {
            sessions: sessions.clone(),
            state: &state,
            config: watch::channel(Arc::new(recovery_config())).1,
            logger,
            clock: cos_continuation::system_clock(),
            prime: Arc::new(NoPrime),
            projections: Arc::new(NoProjections),
        });
        let moved = sessions
            .create_for_conversation("chat-a", None)
            .await
            .unwrap()
            .id;
        let token = continuations
            .open(&moved, "chat-a", false, None)
            .await
            .unwrap()
            .token;
        let brief = "TASK — carry on.\n".repeat(20);
        continuations.attach_summary(&token, &brief).await.unwrap();
        continuations.claim(&token, "command").await.unwrap();
        assert!(continuations.commit(&token, "chat-b").await.landed());
        let waiting = sessions
            .create_for_conversation("chat-c", None)
            .await
            .unwrap()
            .id;
        continuations
            .open(&waiting, "chat-c", false, None)
            .await
            .unwrap();

        let mut tabs = empty();
        let open = [
            "chat-a".to_owned(),
            "chat-b".to_owned(),
            "chat-c".to_owned(),
        ];
        tab_facts(&mut tabs, &open, &continuations);
        assert_eq!(tabs.managed_conversations, ["chat-a"]);
        assert_eq!(tabs.retired_conversations, ["chat-a"]);
        assert_eq!(tabs.closable_conversations, ["chat-a"]);
        assert_eq!(tabs.non_discardable_conversations, ["chat-c"]);

        let mut closed = empty();
        tab_facts(&mut closed, &["chat-b".to_owned()], &continuations);
        assert!(
            closed.closable_conversations.is_empty(),
            "a closed tab is not closed again"
        );
        let _ = std::fs::remove_dir_all(&profile);
    }
}
