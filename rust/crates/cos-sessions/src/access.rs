//! The per-chat rules the kernel applies before any handler runs
//! (`src/main/session/conversation-access.ts` and the block gate in `kernel.ts`): a blocked chat
//! is refused, and with strict chat allowlisting on, only an exactly trusted chat or a committed
//! Compact & Resume successor of one may run tools.

use std::sync::Arc;

use cos_tools::{Caller, ChatPolicy};
use cos_types::config::Config;
use cos_types::session::{SessionOriginKind, SessionSummary};
use tokio::sync::watch;

use crate::SessionStore;
use crate::chats::{BLOCKED_CHAT_REFUSAL, BlockedChatsLedger, TrustedChatsLedger};

pub const STRICT_CHAT_REFUSAL: &str = "CHAT_NOT_TRUSTED: strict chat allowlisting is enabled and this call is not currently allowed. No tool was run. For an attributed chat, ask the user to hover its row in the sidebar chat list and choose Trust (\u{2713}); if that row is blocked, choose Release there. For an app-created worker, use the owning prime row instead. Calls the app cannot link to a chat are refused in strict mode. Retry only after the user changes that policy.";

/// The kernel's [`ChatPolicy`], over the user's two chat lists and the session store.
pub struct ChatAccess {
    pub blocked: BlockedChatsLedger,
    pub trusted: TrustedChatsLedger,
    pub sessions: SessionStore,
    pub config: watch::Receiver<Arc<Config>>,
}

/// `committedResumeAncestorsFromSummary`: the chats this session left behind through committed
/// Compact & Resume, nearest first, when `conversation` is its current chat.
fn resume_ancestors<'a>(summary: &'a SessionSummary, conversation: &str) -> Vec<&'a str> {
    let committed =
        matches!(&summary.last_committed_resume_handoff_id, Some(Some(id)) if !id.is_empty());
    if !committed || summary.conversation_id.as_deref() != Some(conversation) {
        return Vec::new();
    }
    match summary.chat_ids.iter().rposition(|id| id == conversation) {
        Some(current) if current >= 1 && current + 1 == summary.chat_ids.len() => summary.chat_ids
            [..current]
            .iter()
            .rev()
            .map(String::as_str)
            .collect(),
        _ => Vec::new(),
    }
}

impl ChatAccess {
    fn strict(&self) -> bool {
        self.config.borrow().multi_agent.strict_chat_allowlist == Some(true)
    }

    /// `trustedByExactProvenance`.
    fn trusted_by_provenance(&self, conversation: &str) -> bool {
        if self.blocked.is_blocked(Some(conversation)) {
            return false;
        }
        let summary = self.sessions.find_by_conversation(conversation, true);
        // An app-created worker never stands on a Trust bit of its own: once its prime cannot
        // be proven it stays refused for good.
        let worker = summary.as_ref().is_some_and(|summary| {
            summary
                .origin
                .as_ref()
                .is_some_and(|origin| origin.kind == SessionOriginKind::Worker)
        });
        if worker {
            return false;
        }
        if self.trusted.is_trusted(Some(conversation)) {
            return true;
        }
        let ancestors = summary
            .as_ref()
            .map(|summary| resume_ancestors(summary, conversation))
            .unwrap_or_default();
        for source in ancestors {
            // A blocked predecessor revokes inherited trust; otherwise the nearest trusted one
            // is enough.
            if self.blocked.is_blocked(Some(source)) {
                return false;
            }
            if self.trusted.is_trusted(Some(source)) {
                return true;
            }
        }
        false
    }
}

impl ChatPolicy for ChatAccess {
    fn needs_proof(&self) -> bool {
        self.blocked.any() || self.strict()
    }

    /// `conversationAccessRefusal`. A block always wins over trust and is decided first.
    fn refusal(&self, caller: &Caller) -> Option<String> {
        let conversation = caller.chat.as_ref().map(|(id, _)| id.as_str());
        if self.blocked.is_blocked(conversation) {
            return Some(BLOCKED_CHAT_REFUSAL.to_owned());
        }
        if !self.strict() {
            return None;
        }
        match conversation {
            Some(conversation) if self.trusted_by_provenance(conversation) => None,
            _ => Some(STRICT_CHAT_REFUSAL.to_owned()),
        }
    }
}
