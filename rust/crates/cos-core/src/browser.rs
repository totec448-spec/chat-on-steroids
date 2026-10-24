//! Builds the E2.8 owner: the `browser_*` Desktop tools and the bridge's `/browser-control`
//! route share one [`BrowserControl`].

use std::path::PathBuf;
use std::sync::Arc;

use cos_bridge::Bridge;
use cos_browser_control::{BrowserControl, BrowserControlDeps, Chat, ChatProof};
use cos_recorder::Recorder;
use cos_sessions::{BlockedChatsLedger, SessionStore};
use cos_store::Platform;
use cos_tools::{BoxFuture, GrantEnv};
use cos_types::bridge::WakeSignal;
use cos_types::config::Config;
use cos_types::ids::{ConversationId, SessionId};
use tokio::sync::watch;

/// Chat proof from the recorder's request-id ledger, the session store and the blocked chats.
struct Proof {
    recorder: Recorder,
    sessions: SessionStore,
    blocked: BlockedChatsLedger,
}

impl ChatProof for Proof {
    fn proven(&self, request_id: &str) -> Option<Chat> {
        let owner = self.recorder.correlations().lookup(request_id)?;
        Some(Chat {
            conversation: ConversationId::parse(owner.conversation_id).ok()?,
            session: SessionId::parse(owner.session_id).ok()?,
        })
    }

    /// `conversationAttachment(chat, session) === 'current'` and not blocked. No continuation or
    /// worker ledger exists in this app yet, so nothing else can retire a chat.
    fn live<'a>(&'a self, chat: &'a Chat) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            let conversation = chat.conversation.as_str();
            if self.blocked.is_blocked(Some(conversation)) {
                return false;
            }
            self.sessions
                .summary(&chat.session)
                .await
                .is_some_and(|session| {
                    session.chat_ids.iter().any(|id| id == conversation)
                        && session.conversation_id.as_deref() == Some(conversation)
                })
        })
    }
}

pub(crate) fn build(
    config: watch::Receiver<Arc<Config>>,
    skills_dir: PathBuf,
    platform: Platform,
    recorder: &Recorder,
    sessions: &SessionStore,
    blocked: &BlockedChatsLedger,
    bridge: &Bridge,
) -> BrowserControl {
    let wake = bridge.wake();
    BrowserControl::new(BrowserControlDeps {
        config,
        env: GrantEnv {
            skills_dir,
            platform,
        },
        proof: Arc::new(Proof {
            recorder: recorder.clone(),
            sessions: sessions.clone(),
            blocked: blocked.clone(),
        }),
        wake: Arc::new(move || wake.signal(WakeSignal::BrowserControl)),
    })
}
