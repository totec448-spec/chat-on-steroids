//! What the held finish boundary (`cos-continuation`, E2.5) asks the outbox:
//! `listInputs().some(waiting)` and `finishNeedsBrowserInput` in `session/input.ts`.

use cos_types::state::{InputMode, InputState, ToolDelivery};

use super::Outbox;
use super::claims::queued_after_turn;
use crate::entry::{decision, ordered};

impl Outbox {
    /// A message of this session is still `queued`, `browser` or `tool`: user instructions
    /// take priority over a finish notice.
    pub async fn finish_waiting(&self, session: &str) -> bool {
        let mut rows = self.inner.rows.lock().await;
        let Ok(rows) = self.inner.load(&mut rows).await else {
            return false;
        };
        rows.iter().any(|row| {
            row.session_id.as_deref() == Some(session)
                && matches!(
                    row.state,
                    InputState::Queued | InputState::Browser | InputState::Tool
                )
        })
    }

    /// `finishNeedsBrowserInput`: the session's next message must go through the browser after
    /// this turn (an after-turn message, or files the tool result cannot carry), so the finish
    /// hold is released for it.
    pub async fn finish_needs_browser(&self, session: &str) -> bool {
        let head = {
            let mut rows = self.inner.rows.lock().await;
            let Ok(rows) = self.inner.load(&mut rows).await else {
                return false;
            };
            ordered(&rows).into_iter().find(|row| {
                row.session_id.as_deref() == Some(session)
                    && !decision(row)
                    && matches!(
                        row.state,
                        InputState::Queued | InputState::Browser | InputState::Tool
                    )
            })
        };
        let Some(head) = head else {
            return false;
        };
        let files = head
            .attachments
            .as_ref()
            .is_some_and(|attachments| !attachments.is_empty())
            && head.attachment_delivery != Some(ToolDelivery::Tool);
        if head.state != InputState::Queued
            || head.due_at > self.inner.now()
            || !(head.mode == InputMode::AfterTurn || files)
        {
            return false;
        }
        match self.inner.session(session).await {
            Some(summary) => queued_after_turn(&head, &summary, self.inner.now()),
            None => false,
        }
    }
}
