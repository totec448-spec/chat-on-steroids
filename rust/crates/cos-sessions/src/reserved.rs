//! A new chat's local session, reserved before ChatGPT gives the chat an id
//! (`createSession({ reservedId, origin: desktop })` and `rebindSession(id, null, chat)` in
//! `src/main/session/store.ts`). The outbox reserves it under the opening message's id when it
//! admits the message, and binds it to the chat the first receipt names.

use std::sync::Arc;

use cos_tools::EpochMs;
use cos_types::ids::SessionId;
use cos_types::json::{Extra, Record};
use cos_types::session::{SessionOrigin, SessionOriginKind, SessionSummary, TitleSource};

use crate::title::{DEFAULT_TITLE, user_title};
use crate::{Live, SessionStore, Writer, blocking, disk, lock, summary};

/// `/^[0-9a-f-]{8,64}$/i`: the browser's own conversation ids, where a second owner is a collision.
fn provider_shaped(conversation: &str) -> bool {
    (8..=64).contains(&conversation.len())
        && conversation
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
}

impl SessionStore {
    /// `createSession({ reservedId, title: userTitle(text), titleSource: 'fallback', origin:
    /// desktop })`. The same id again answers the session it already made, so a restart or a
    /// repeated admission converges on one session. A session under that id that this app did
    /// not open for a new chat is refused.
    pub async fn create_reserved(
        &self,
        id: &SessionId,
        text: &str,
    ) -> Result<SessionSummary, String> {
        if let Some(existing) = self.summary(id).await {
            if existing.origin.as_ref().map(|origin| origin.kind)
                != Some(SessionOriginKind::Desktop)
            {
                return Err("Reserved opening session belongs to different work".into());
            }
            return Ok(existing);
        }
        let now = EpochMs::now().0;
        let title = user_title(text, Some(text));
        let title = if title.trim().is_empty() {
            DEFAULT_TITLE
        } else {
            title.trim()
        };
        let mut created = summary::empty(id.clone(), title, None, now);
        created.title_source = Some(TitleSource::Fallback);
        created.origin = Some(SessionOrigin {
            kind: SessionOriginKind::Desktop,
            from_session_id: None,
            agent_id: None,
            task: String::new(),
            extra: Extra::new(),
        });
        let dir = self.dir(id);
        let written = created.clone();
        blocking(move || disk::create(&dir, &written))
            .await
            .and_then(|written| written)
            .map_err(|error| error.to_string())?;
        let live = Arc::new(Live {
            published: std::sync::Mutex::new(created.clone()),
            writer: tokio::sync::Mutex::new(Writer {
                summary: created.clone(),
                messages: Some(Record::new()),
                next_seq: 1,
                history_seq: 0,
                meta_dirty: false,
                meta_scheduled: false,
            }),
        });
        {
            let mut shared = lock(&self.inner.shared);
            shared.open.insert(id.clone(), live);
            shared.catalog.insert(id.clone(), created.clone());
        }
        self.publish_index();
        Ok(created)
    }

    /// `rebindSession(id, null, conversation)`: a session with no chat yet becomes this chat.
    /// `false` when it already has one, or when another session owns the chat. The summary is
    /// on disk before memory says so, so a failed write leaves the session unbound everywhere.
    pub async fn bind_conversation(
        &self,
        id: &SessionId,
        conversation: &str,
    ) -> Result<bool, String> {
        if conversation.is_empty() {
            return Ok(false);
        }
        let live = self.ensure_open(id).await?;
        let mut writer = live.writer.lock().await;
        if writer.summary.conversation_id.is_some() {
            return Ok(false);
        }
        if provider_shaped(conversation)
            && let Some(owner) = self.find_by_conversation(conversation, false)
            && &owner.id != id
        {
            self.logger().warn(&format!(
                "session {id} cannot move to {conversation}: that chat already belongs to {}",
                owner.id
            ));
            return Ok(false);
        }
        let mut staged = writer.summary.clone();
        staged.conversation_id = Some(conversation.to_owned());
        if !staged.chat_ids.iter().any(|chat| chat == conversation) {
            staged.chat_ids.push(conversation.to_owned());
        }
        staged.context_tokens = 0;
        staged.active_turn_id = Some(None);
        staged.finish_turn = Some(None);
        staged.browser_recovery_dismissed_at = None;
        staged.updated_at = EpochMs::now().0;
        staged.ended_at = None;
        let dir = self.dir(id);
        let persisted = staged.clone();
        let history_seq = writer.history_seq;
        let written = blocking(move || disk::write_summary(&dir, &persisted, history_seq))
            .await
            .and_then(|written| written);
        if let Err(error) = written {
            self.logger().warn(&format!(
                "session {id} could not be moved to {conversation}: {error}"
            ));
            return Ok(false);
        }
        writer.summary = staged;
        writer.meta_dirty = false;
        *lock(&live.published) = writer.summary.clone();
        lock(&self.inner.shared)
            .catalog
            .insert(id.clone(), writer.summary.clone());
        drop(writer);
        self.publish_index();
        self.logger().info(&format!(
            "session {id} is now ChatGPT conversation {conversation}"
        ));
        Ok(true)
    }
}
