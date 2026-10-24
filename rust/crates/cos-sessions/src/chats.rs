//! The user's two lists of exact ChatGPT conversations: chats blocked from local tools
//! (`src/main/session/blocked-chats.ts`, `state/blocked-chats.json`) and chats trusted while the
//! strict chat allowlist is on (`trusted-chats.ts`, `state/trusted-chats.json`).
//!
//! Both are keyed by conversation, never by request id: one ChatGPT turn issues every call under
//! one request id, and the next turn brings a new one, so only the conversation stays true for a
//! rogue chat. A block refuses a call whose proven owner is blocked, never one whose owner is
//! unknown. Both lists are bounded and refuse to grow past their bound instead of dropping the
//! oldest entry, because dropping a block silently unblocks a chat the user stopped on purpose.

use std::sync::{Arc, Mutex, MutexGuard};

use cos_store::{Durable, DurableStore};
use cos_tools::EpochMs;
use cos_types::ids::ConversationId;
use cos_types::json::{Extra, Record};
use cos_types::state::{BlockedChat, BlockedChats, TrustedChats, V1};
use serde_json::Value;

const MAX_BLOCKED_CHATS: usize = 200;
const MAX_TRUSTED_CHATS: usize = 200;

/// What a blocked chat's model is told on every tool it tries: an instruction to end the turn,
/// because a bare failure invites the retry loop the block exists to stop.
pub const BLOCKED_CHAT_REFUSAL: &str = "CHAT_BLOCKED: the user blocked this conversation from using local tools, and no tool was run. This session went rogue. Stop right now: abandon the task, make no further tool calls of any kind, and reply to the user immediately with your final answer. The user explicitly asked for this.";

/// Why a change to either list was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChatListError {
    NotAConversation,
    TooManyBlocked,
    TooManyTrusted,
    /// The trusted list could not be written; nothing changed.
    Storage(String),
}

impl std::fmt::Display for ChatListError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAConversation => f.write_str("Not a ChatGPT conversation id"),
            Self::TooManyBlocked => write!(
                f,
                "Too many blocked chats ({MAX_BLOCKED_CHATS}). Release one before blocking another."
            ),
            Self::TooManyTrusted => write!(
                f,
                "Too many trusted chats ({MAX_TRUSTED_CHATS}). Untrust one before trusting another."
            ),
            Self::Storage(error) => f.write_str(error),
        }
    }
}

impl std::error::Error for ChatListError {}

/// `/^[0-9a-z-]{8,64}$/i`.
fn chat_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// The distinct ids of one request, in order, or the refusal when any is not a chat id.
fn requested(ids: &[&str]) -> Result<Vec<String>, ChatListError> {
    let mut distinct: Vec<String> = Vec::new();
    for id in ids {
        if !chat_id(id) {
            return Err(ChatListError::NotAConversation);
        }
        if !distinct.iter().any(|held| held == id) {
            distinct.push((*id).to_owned());
        }
    }
    if distinct.is_empty() {
        return Err(ChatListError::NotAConversation);
    }
    Ok(distinct)
}

fn conversation(id: &str) -> Option<ConversationId> {
    ConversationId::parse(id).ok()
}

fn version_1(saved: &Value) -> Option<&Vec<Value>> {
    (saved.get("version").and_then(Value::as_u64) == Some(1))
        .then(|| saved.get("entries")?.as_array())
        .flatten()
}

#[derive(Default)]
struct Blocks {
    /// Conversation id to when the user blocked it, in the order they were blocked.
    held: Record<u64>,
    restored: bool,
}

/// The blocked chats. Clones share one list.
#[derive(Clone)]
pub struct BlockedChatsLedger {
    inner: Arc<BlocksInner>,
}

struct BlocksInner {
    ledger: Option<Durable<BlockedChats>>,
    blocks: Mutex<Blocks>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

impl BlockedChatsLedger {
    pub fn new(state: &DurableStore) -> Self {
        Self {
            inner: Arc::new(BlocksInner {
                ledger: state.ledger("blocked-chats").ok(),
                blocks: Mutex::new(Blocks::default()),
            }),
        }
    }

    /// `restoreBlockedChats`: before the endpoint takes a call, because a block that lands one
    /// call late is one more tool for the rogue turn. A bad row is skipped; the rest are kept.
    /// Reads the file, so call it on the blocking pool. Only the first call reads.
    pub fn restore(&self) {
        let saved = self.inner.ledger.as_ref().and_then(Durable::read);
        let mut blocks = lock(&self.inner.blocks);
        if std::mem::replace(&mut blocks.restored, true) {
            return;
        }
        let Some(entries) = saved.as_ref().and_then(version_1) else {
            return;
        };
        for entry in entries.iter().take(MAX_BLOCKED_CHATS) {
            let Some(id) = entry
                .get("conversationId")
                .and_then(Value::as_str)
                .filter(|id| chat_id(id))
            else {
                continue;
            };
            let at = entry
                .get("blockedAt")
                .and_then(Value::as_f64)
                .filter(|at| at.is_finite())
                .map_or_else(|| EpochMs::now().0, |at| at.max(0.0) as u64);
            blocks.held.insert(id.to_owned(), at);
        }
    }

    /// `anyChatBlocked`: whether resolving a call's owner is worth it at all.
    pub fn any(&self) -> bool {
        !lock(&self.inner.blocks).held.is_empty()
    }

    /// `isChatBlocked`: exact lookup. A call with no proven owner is never blocked.
    pub fn is_blocked(&self, conversation: Option<&str>) -> bool {
        conversation.is_some_and(|id| lock(&self.inner.blocks).held.contains_key(id))
    }

    /// `blockedChatIds`.
    pub fn ids(&self) -> Vec<String> {
        lock(&self.inner.blocks).held.keys().cloned().collect()
    }

    /// `chatBlockedAt`.
    pub fn blocked_at(&self, conversation: &str) -> Option<u64> {
        lock(&self.inner.blocks).held.get(conversation).copied()
    }

    /// `setChatsBlocked`: blocks or releases these chats. Pressing twice changes nothing more:
    /// a block keeps its first time and a release stays released.
    pub fn set(&self, ids: &[&str], blocked: bool) -> Result<(), ChatListError> {
        let ids = requested(ids)?;
        let mut blocks = lock(&self.inner.blocks);
        let changed = if blocked {
            let additions: Vec<&String> = ids
                .iter()
                .filter(|id| !blocks.held.contains_key(*id))
                .collect();
            if blocks.held.len() + additions.len() > MAX_BLOCKED_CHATS {
                return Err(ChatListError::TooManyBlocked);
            }
            let at = EpochMs::now().0;
            for id in &additions {
                blocks.held.insert((*id).clone(), at);
            }
            !additions.is_empty()
        } else {
            let before = blocks.held.len();
            blocks.held.retain(|id, _| !ids.contains(id));
            blocks.held.len() != before
        };
        if changed && let Some(ledger) = &self.inner.ledger {
            let snapshot = BlockedChats {
                version: V1,
                entries: blocks
                    .held
                    .iter()
                    .filter_map(|(id, at)| {
                        Some(BlockedChat {
                            conversation_id: conversation(id)?,
                            blocked_at: *at,
                            extra: Extra::new(),
                        })
                    })
                    .collect(),
                extra: Extra::new(),
            };
            ledger
                .write_soon(&snapshot)
                .map_err(|error| ChatListError::Storage(error.to_string()))?;
        }
        Ok(())
    }

    /// Writes a queued change now. Shutdown phase 4.
    pub fn flush(&self) {
        if let Some(ledger) = &self.inner.ledger {
            let _ = ledger.flush();
        }
    }
}

#[derive(Default)]
struct Trusted {
    held: Vec<String>,
    restored: bool,
}

/// The chats the user trusts while strict chat allowlisting is on. Separate from blocks:
/// releasing a block does not trust a chat. Clones share one list.
#[derive(Clone)]
pub struct TrustedChatsLedger {
    inner: Arc<TrustInner>,
}

struct TrustInner {
    ledger: Option<Durable<TrustedChats>>,
    trusted: Mutex<Trusted>,
    /// One change at a time, each on disk before the next starts.
    changing: tokio::sync::Mutex<()>,
}

fn trusted_snapshot(ids: &[String]) -> TrustedChats {
    TrustedChats {
        version: V1,
        entries: ids.iter().filter_map(|id| conversation(id)).collect(),
        extra: Extra::new(),
    }
}

impl TrustedChatsLedger {
    pub fn new(state: &DurableStore) -> Self {
        Self {
            inner: Arc::new(TrustInner {
                ledger: state.ledger("trusted-chats").ok(),
                trusted: Mutex::new(Trusted::default()),
                changing: tokio::sync::Mutex::new(()),
            }),
        }
    }

    /// `restoreTrustedChats`. A damaged file or an unknown version trusts nothing. Reads the
    /// file, so call it on the blocking pool. Only the first call reads.
    pub fn restore(&self) {
        let saved = self.inner.ledger.as_ref().and_then(Durable::read);
        let mut trusted = lock(&self.inner.trusted);
        if std::mem::replace(&mut trusted.restored, true) {
            return;
        }
        let Some(entries) = saved.as_ref().and_then(version_1) else {
            return;
        };
        for id in entries
            .iter()
            .take(MAX_TRUSTED_CHATS)
            .filter_map(Value::as_str)
        {
            if chat_id(id) && !trusted.held.iter().any(|held| held == id) {
                trusted.held.push(id.to_owned());
            }
        }
    }

    /// `isChatTrusted`.
    pub fn is_trusted(&self, conversation: Option<&str>) -> bool {
        conversation.is_some_and(|id| lock(&self.inner.trusted).held.iter().any(|held| held == id))
    }

    /// `trustedChatIds`.
    pub fn ids(&self) -> Vec<String> {
        lock(&self.inner.trusted).held.clone()
    }

    /// `setChatsTrusted`: the change is on disk before it takes effect, so a permission the user
    /// granted or revoked survives a crash right after. A failed write changes nothing, and the
    /// rejected list is superseded so a later retry of that write cannot grant it.
    pub async fn set(&self, ids: &[&str], trusted: bool) -> Result<(), ChatListError> {
        let ids = requested(ids)?;
        let _changing = self.inner.changing.lock().await;
        let current = lock(&self.inner.trusted).held.clone();
        let mut updated = current.clone();
        if trusted {
            let additions: Vec<&String> = ids.iter().filter(|id| !updated.contains(id)).collect();
            if updated.len() + additions.len() > MAX_TRUSTED_CHATS {
                return Err(ChatListError::TooManyTrusted);
            }
            updated.extend(additions.into_iter().cloned());
        } else {
            updated.retain(|id| !ids.contains(id));
        }
        if updated == current {
            return Ok(());
        }
        if let Some(ledger) = self.inner.ledger.clone() {
            let proposed = trusted_snapshot(&updated);
            let written = tokio::task::spawn_blocking(move || {
                let result = ledger.write_now(&proposed);
                if result.is_err() {
                    let _ = ledger.write_soon(&trusted_snapshot(&current));
                }
                result
            })
            .await
            .map_err(|error| ChatListError::Storage(error.to_string()))?;
            written.map_err(|error| ChatListError::Storage(error.to_string()))?;
        }
        lock(&self.inner.trusted).held = updated;
        Ok(())
    }

    /// Writes a queued retry now. Shutdown phase 4.
    pub fn flush(&self) {
        if let Some(ledger) = &self.inner.ledger {
            let _ = ledger.flush();
        }
    }
}
