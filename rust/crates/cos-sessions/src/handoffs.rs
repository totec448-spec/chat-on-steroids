//! What Compact & Resume (unit E2.5, `cos-continuation`) writes into a session: the handoff
//! files under `handoffs/`, the A to B rebind, and the two one-field repairs recovery makes
//! (`saveHandoff`, `readHandoff`, `rebindSession`, `ensureCommittedResumeHandoff`,
//! `refuseAutomaticCompactionNow` and `readSessionPlan` in `src/main/session/store.ts`).

use std::io;
use std::path::PathBuf;

use cos_tools::EpochMs;
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{AgentPlan, AutoCompactionRefusal, Handoff, SessionSummary};

use crate::{SessionStore, blocking, disk, lock};

/// `/^[0-9a-z-]{8,64}$/i`: a handoff id, as `newHandoffId` mints it.
fn handoff_id_shaped(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `/^[0-9a-f-]{8,64}$/i`: the browser's own conversation ids, where a second owner is a collision.
fn provider_shaped(conversation: &str) -> bool {
    (8..=64).contains(&conversation.len())
        && conversation
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// `readHandoff`'s provenance check: a versioned file must name itself and carry well-formed
/// provenance, or recovery would repair a transaction from guessed identity.
fn provenance_valid(handoff: &Handoff, session: &SessionId, id: &str) -> bool {
    if handoff.version.is_none() && handoff.provenance.is_none() {
        return true;
    }
    let Some(provenance) = &handoff.provenance else {
        return false;
    };
    let continuation_ok = provenance.continuation_id.as_ref().is_none_or(|value| {
        value.len() == 43
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    });
    handoff.version.is_some()
        && handoff.id == id
        && &handoff.session_id == session
        && provenance
            .source_conversation_id
            .as_ref()
            .is_none_or(|chat| (1..=256).contains(&chat.encode_utf16().count()))
        && provenance
            .source_generation
            .is_none_or(|generation| generation >= 1)
        && provenance
            .source_turn_id
            .as_ref()
            .is_none_or(|turn| turn.encode_utf16().count() <= 256)
        && continuation_ok
}

impl SessionStore {
    fn handoff_path(&self, session: &SessionId, id: &str) -> PathBuf {
        self.dir(session)
            .join("handoffs")
            .join(format!("{id}.json"))
    }

    /// `saveHandoff`: `handoffs/<id>.json`, two-space indented, written to a temp file and
    /// renamed into place. Publishes nothing into the session timeline.
    pub async fn save_handoff(&self, handoff: &Handoff) -> io::Result<()> {
        let target = self.handoff_path(&handoff.session_id, &handoff.id);
        let bytes = serde_json::to_vec_pretty(handoff).map_err(io::Error::other)?;
        blocking(move || -> io::Result<()> {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let tmp = target.with_extension("json.tmp");
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, &target)
        })
        .await?
    }

    /// `readHandoff`: the stored brief, or `None` when it is missing, unreadable, has no text, or
    /// carries malformed identity metadata. Legacy files without version or provenance read.
    pub async fn read_handoff(&self, session: &SessionId, id: &str) -> Option<Handoff> {
        if !handoff_id_shaped(id) {
            return None;
        }
        let path = self.handoff_path(session, id);
        let bytes = blocking(move || std::fs::read(path)).await.ok()?.ok()?;
        let handoff: Handoff = serde_json::from_slice(&bytes).ok()?;
        provenance_valid(&handoff, session, id).then_some(handoff)
    }

    /// `readSessionPlan`: the chat's saved plan, after the session's queued writes.
    pub async fn read_session_plan(&self, id: &SessionId) -> Option<AgentPlan> {
        self.flush_session(id).await;
        let dir = self.dir(id);
        blocking(move || disk::read_plan(&dir)).await.ok()?.ok()?
    }

    /// Stages `change` on a clone of the summary, writes `meta.json`, and only then publishes
    /// it, so a failed write leaves memory and disk on the old summary.
    async fn rewrite_summary(
        &self,
        id: &SessionId,
        change: impl FnOnce(&SessionSummary) -> Result<Option<SessionSummary>, String>,
    ) -> Result<Option<SessionSummary>, String> {
        let live = self.ensure_open(id).await?;
        let mut writer = live.writer.lock().await;
        let Some(staged) = change(&writer.summary)? else {
            return Ok(None);
        };
        let dir = self.dir(id);
        let persisted = staged.clone();
        let history_seq = writer.history_seq;
        blocking(move || disk::write_summary(&dir, &persisted, history_seq))
            .await
            .and_then(|written| written)
            .map_err(|error| error.to_string())?;
        writer.summary = staged;
        writer.meta_dirty = false;
        *lock(&live.published) = writer.summary.clone();
        lock(&self.inner.shared)
            .catalog
            .insert(id.clone(), writer.summary.clone());
        let published = writer.summary.clone();
        drop(writer);
        self.publish_index();
        Ok(Some(published))
    }

    /// `rebindSession(id, from, to, committedResumeHandoffId)`: the Compact & Resume commit.
    /// `false` when the session is no longer attached to `from`, when another session owns
    /// `to`, or when the write fails; then the session stays attached to `from` everywhere.
    pub async fn rebind_session(
        &self,
        id: &SessionId,
        from: Option<&str>,
        to: &str,
        committed_handoff: Option<&str>,
    ) -> bool {
        if to.is_empty() || from == Some(to) {
            return false;
        }
        if committed_handoff.is_some_and(|handoff| !handoff_id_shaped(handoff)) {
            return false;
        }
        let now = EpochMs::now().0;
        let result = self
            .rewrite_summary(id, |summary| {
                if summary.conversation_id.as_deref() != from {
                    return Ok(None);
                }
                // Any existing owner is a collision witness, unique or not.
                if provider_shaped(to)
                    && let Some(owner) = self.find_by_conversation(to, false)
                    && &owner.id != id
                {
                    return Err(format!("that chat already belongs to {}", owner.id));
                }
                let mut staged = summary.clone();
                staged.conversation_id = Some(to.to_owned());
                if let Some(from) = from {
                    staged
                        .retired_chat_at
                        .get_or_insert_with(Default::default)
                        .insert(from.to_owned(), now);
                }
                if !staged.chat_ids.iter().any(|chat| chat == to) {
                    staged.chat_ids.push(to.to_owned());
                }
                staged.context_tokens = 0;
                staged.active_turn_id = Some(None);
                staged.finish_turn = Some(None);
                staged.browser_recovery_dismissed_at = None;
                if let Some(handoff) = committed_handoff {
                    staged.last_committed_resume_handoff_id = Some(Some(handoff.to_owned()));
                }
                staged.updated_at = now;
                staged.ended_at = None;
                Ok(Some(staged))
            })
            .await;
        match result {
            Ok(Some(_)) => {
                self.logger().info(&match from {
                    Some(from) => {
                        format!("session {id} moved from ChatGPT conversation {from} to {to}")
                    }
                    None => format!("session {id} is now ChatGPT conversation {to}"),
                });
                true
            }
            Ok(None) => false,
            Err(error) => {
                self.logger()
                    .warn(&format!("session {id} cannot move to {to}: {error}"));
                false
            }
        }
    }

    /// `ensureCommittedResumeHandoff`: after recovery proves the move to `conversation` landed,
    /// names the handoff that carried it. Any other attachment is refused (`Ok(false)`).
    pub async fn ensure_committed_resume_handoff(
        &self,
        id: &SessionId,
        conversation: &str,
        handoff: &str,
    ) -> Result<bool, String> {
        if conversation.is_empty() || !handoff_id_shaped(handoff) {
            return Ok(false);
        }
        let mut attached = false;
        let rewritten = self
            .rewrite_summary(id, |summary| {
                if summary.conversation_id.as_deref() != Some(conversation) {
                    return Ok(None);
                }
                attached = true;
                if summary.last_committed_resume_handoff_id.as_ref()
                    == Some(&Some(handoff.to_owned()))
                {
                    return Ok(None);
                }
                let mut staged = summary.clone();
                staged.last_committed_resume_handoff_id = Some(Some(handoff.to_owned()));
                Ok(Some(staged))
            })
            .await?;
        Ok(attached || rewritten.is_some())
    }

    /// `refuseAutomaticCompactionNow`: persists that this chat's turn may not file another
    /// automatic ticket, before the ticket is retired.
    pub async fn refuse_automatic_compaction(
        &self,
        id: &SessionId,
        conversation: &str,
        turn: Option<&str>,
    ) -> Result<(), String> {
        self.rewrite_summary(id, |summary| {
            let active = summary.active_turn_id.clone().flatten();
            if summary.conversation_id.as_deref() != Some(conversation)
                || active.as_deref().is_some_and(|active| Some(active) != turn)
            {
                return Ok(None);
            }
            let mut staged = summary.clone();
            staged.auto_compaction_refusal = Some(AutoCompactionRefusal {
                conversation_id: conversation.to_owned(),
                turn_id: turn.map(str::to_owned),
                extra: Extra::new(),
            });
            Ok(Some(staged))
        })
        .await
        .map(|_| ())
    }
}
