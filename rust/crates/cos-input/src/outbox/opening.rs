//! A new chat's first message (`opening`). The outbox reserves a local session under the
//! message's own id when it admits it, and binds that session to the chat the first receipt
//! names (`materializeOpening` and `bindOpening` in `session/input.ts`).

use super::*;

/// The prefix of the error a row keeps while its reserved session cannot be made.
pub(super) const SETUP_FAILED: &str = "Local chat setup failed: ";
pub(super) const NO_PROJECT_OPENING: &str = "This build cannot open a new chat in a project yet";

impl Inner {
    /// `materializeOpening`: the reserved session exists and has no other chat. Repeating it
    /// after a crash at any point converges on the same session.
    pub(super) async fn materialize_opening(&self, entry: &InputEntry) -> Result<(), OutboxError> {
        let (Some(_), Some(session_id)) = (&entry.opening, &entry.session_id) else {
            return Ok(());
        };
        let id = SessionId::parse(session_id).map_err(|error| OutboxError(error.to_string()))?;
        let existing = self.sessions.summary(&id).await;
        // A row recovered onto the session that already holds its chat keeps that session.
        let recovered_owner = existing.as_ref().filter(|session| {
            entry.requested_session_id == Some(None)
                && entry.conversation_id.is_some()
                && session.conversation_id == entry.conversation_id
                && !helper_or_worker_session(session)
        });
        let session = match recovered_owner {
            Some(session) => session.clone(),
            None => self
                .sessions
                .create_reserved(&id, &entry.text)
                .await
                .map_err(OutboxError)?,
        };
        if session.conversation_id.is_some() && session.conversation_id != entry.conversation_id {
            return refuse("Reserved opening session belongs to another ChatGPT conversation");
        }
        // Assigning the project needs the projects owner, which this build does not have.
        if let Some(project) = entry.project_id.clone().flatten()
            && session.project_id.as_deref() != Some(project.as_str())
        {
            return refuse(NO_PROJECT_OPENING);
        }
        Ok(())
    }

    /// `bindOpening`: the reserved session becomes the chat the page reported.
    pub(super) async fn bind_opening(
        &self,
        entry: &InputEntry,
        conversation: &str,
    ) -> Result<bool, OutboxError> {
        let (Some(_), Some(session_id)) = (&entry.opening, &entry.session_id) else {
            return Ok(false);
        };
        if entry
            .conversation_id
            .as_deref()
            .is_some_and(|known| known != conversation)
            || self.sessions.conversation_superseded(conversation)
        {
            return Ok(false);
        }
        self.materialize_opening(entry).await?;
        let Some(session) = self.session(session_id).await else {
            return Ok(false);
        };
        match session.conversation_id.as_deref() {
            Some(bound) => Ok(bound == conversation),
            None => {
                // Strict mode admits a chat only through the Trust registry, which has no owner
                // in this build, so a strict opening stays unbound as TypeScript leaves it
                // without that hook.
                if self.config.borrow().multi_agent.strict_chat_allowlist == Some(true) {
                    return Ok(false);
                }
                self.sessions
                    .bind_conversation(&session.id, conversation)
                    .await
                    .map_err(OutboxError)
            }
        }
    }

    /// `load`'s repair pass: every open opening has its session again, and a row whose setup
    /// failed says so (and loses the note once setup works).
    pub(super) async fn repair_openings(&self, rows: &mut [InputEntry]) {
        for row in rows.iter_mut() {
            if row.opening.is_none() || terminal(row) {
                continue;
            }
            match self.materialize_opening(row).await {
                Ok(()) => {
                    if row
                        .error
                        .as_deref()
                        .is_some_and(|error| error.starts_with(SETUP_FAILED))
                    {
                        row.error = None;
                    }
                }
                Err(error) => {
                    row.error = Some(js_slice(&format!("{SETUP_FAILED}{error}"), 200));
                }
            }
        }
    }
}
