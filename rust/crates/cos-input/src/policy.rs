//! When a chat can take a message, and through which door (`sessionInputPolicy`,
//! `browserInputAllowed`, `eligibleStageEnd`, `completedStageBoundary` and `target` in
//! `session/input.ts`).
//!
//! The TypeScript policy also asks three owners this build does not have: the bridge's live
//! activity hook, the kernel's in-flight call count and the blocked-chat list. Here activity is
//! what the session records (`activeTurnId`), no call is ever in flight and no chat is blocked,
//! which is what TypeScript falls back to without those owners.

use cos_types::ids::SessionId;
use cos_types::session::{
    SessionEvent, SessionOriginKind, SessionSummary, TurnEndReason, TurnOutcome,
};
use cos_types::state::{DirectTurn, InputEntry, InputMode, InputState, TransportIntent};

use crate::entry::{
    decision, intent_is, is_astra_model, is_pro_model, manual_input, ordered, queued_followup,
};
use crate::outbox::Inner;

/// The newest `turn_start` or `turn_end` of a session.
#[derive(Clone, Debug)]
pub(crate) struct Boundary {
    pub(crate) start: bool,
    pub(crate) turn_id: Option<String>,
    pub(crate) time: u64,
    pub(crate) outcome: Option<TurnOutcome>,
    pub(crate) thinking_failed: bool,
}

impl Boundary {
    fn completed_end(&self) -> bool {
        !self.start && self.outcome == Some(TurnOutcome::Completed)
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Policy {
    pub(crate) queue_at_finish: bool,
    pub(crate) can_inject: bool,
    pub(crate) injection_turn_id: Option<String>,
    pub(crate) direct_turn: Option<DirectTurn>,
    pub(crate) browser_allowed: bool,
    pub(crate) settled: bool,
}

pub(crate) fn active_turn(session: &SessionSummary) -> Option<String> {
    session.active_turn_id.clone().flatten()
}

fn helper_or_worker(session: &SessionSummary) -> bool {
    session.origin.as_ref().is_some_and(|origin| {
        matches!(
            origin.kind,
            SessionOriginKind::Worker | SessionOriginKind::Helper
        )
    })
}

/// The chat's own model selection, when it was observed in its current conversation.
fn selection(session: &SessionSummary) -> Option<&cos_types::session::SelectedModel> {
    session
        .selected_model
        .as_ref()
        .filter(|selected| session.conversation_id.as_deref() == Some(&selected.conversation_id))
}

pub(crate) fn astra_chat(session: &SessionSummary) -> bool {
    selection(session)
        .is_some_and(|selected| is_astra_model(Some(&selected.model), selected.reasoning_effort))
}

/// `composerOnlyText`: on a model that is not Pro, text inside a tool result never reaches the
/// model, so a message of yours goes through the composer.
pub(crate) fn composer_only_text(entry: &InputEntry, session: Option<&SessionSummary>) -> bool {
    let Some(session) = session else {
        return false;
    };
    let empty = |list: Option<usize>| list.unwrap_or(0) == 0;
    manual_input(entry)
        && empty(entry.images.as_ref().map(Vec::len))
        && empty(entry.attachments.as_ref().map(Vec::len))
        && empty(entry.tool_images.as_ref().map(Vec::len))
        && session.conversation_id.is_some()
        && selection(session).is_some_and(|selected| {
            !selected.model.is_empty()
                && !is_pro_model(Some(&selected.model), selected.reasoning_effort)
        })
}

impl Inner {
    pub(crate) async fn session(&self, id: &str) -> Option<SessionSummary> {
        let id = SessionId::parse(id).ok()?;
        self.sessions.summary(&id).await
    }

    pub(crate) async fn boundary(&self, id: &str) -> Option<Boundary> {
        let id = SessionId::parse(id).ok()?;
        let events = self
            .sessions
            .recent_events(&id, 1, &["turn_start", "turn_end"])
            .await
            .ok()?;
        match events.last()? {
            SessionEvent::TurnStart(start) => Some(Boundary {
                start: true,
                turn_id: start.base.turn_id.clone(),
                time: start.base.time,
                outcome: None,
                thinking_failed: false,
            }),
            SessionEvent::TurnEnd(end) => Some(Boundary {
                start: false,
                turn_id: end.base.turn_id.clone(),
                time: end.base.time,
                outcome: Some(end.outcome),
                thinking_failed: end.reason == Some(TurnEndReason::ThinkingFailed),
            }),
            _ => None,
        }
    }

    /// `sessionInputPolicy`.
    pub(crate) async fn policy(&self, session_id: &str) -> Policy {
        let end = self.boundary(session_id).await;
        let Some(session) = self.session(session_id).await else {
            return Policy::default();
        };
        if session.conversation_id.is_none() {
            return Policy::default();
        }
        let active = active_turn(&session);
        let possible = active.is_some();
        let exact = active.is_some();
        let stopped = session
            .finish_turn
            .as_ref()
            .and_then(Option::as_ref)
            .is_some_and(|finish| finish.released);
        let direct_turn = match (&end, selection(&session)) {
            (Some(end), Some(selected))
                if !stopped
                    && exact
                    && end.start
                    && end.turn_id.is_some()
                    && end.turn_id == active
                    && !selected.model.is_empty()
                    && !is_pro_model(Some(&selected.model), selected.reasoning_effort) =>
            {
                Some(DirectTurn {
                    id: end.turn_id.clone().unwrap_or_default(),
                    started_at: end.time,
                    extra: Default::default(),
                })
            }
            _ => None,
        };
        let can_inject = !stopped && exact && direct_turn.is_none();
        let injection_turn_id = if can_inject { active.clone() } else { None };
        let astra = !helper_or_worker(&session) && astra_chat(&session);
        let current = self.session(session_id).await;
        if current.as_ref().map(|current| &current.conversation_id)
            != Some(&session.conversation_id)
            || current.as_ref().map(active_turn) != Some(active.clone())
        {
            return Policy::default();
        }
        let terminal = end.as_ref().is_some_and(|end| {
            !end.start && end.turn_id.is_some() && end.outcome != Some(TurnOutcome::Unknown)
        });
        let settled = terminal
            && end.as_ref().is_some_and(|end| {
                (end.outcome == Some(TurnOutcome::Completed) && !possible && !exact)
                    || (end.outcome == Some(TurnOutcome::Failed) && end.thinking_failed)
            });
        let finish_tool = self.config.borrow().ui.finish_tool == Some(true);
        Policy {
            queue_at_finish: astra && can_inject && finish_tool,
            can_inject,
            injection_turn_id,
            direct_turn,
            browser_allowed: active.is_none() && !possible && !exact,
            settled: settled
                && session.last_tool_call_at.unwrap_or(0) <= end.as_ref().map_or(0, |end| end.time),
        }
    }

    /// `target`: the conversation a row goes to. `Ok(None)` is a new chat.
    pub(crate) async fn target(&self, entry: &InputEntry) -> Result<Option<String>, String> {
        if decision(entry) {
            return Ok(entry.conversation_id.clone());
        }
        let Some(session_id) = &entry.session_id else {
            return Ok(None);
        };
        let session = self.session(session_id).await;
        if entry.opening.is_some()
            && let Some(session) = &session
            && session
                .origin
                .as_ref()
                .is_some_and(|origin| origin.kind == SessionOriginKind::Desktop)
            && session.conversation_id.is_none()
        {
            return Ok(None);
        }
        match session.and_then(|session| session.conversation_id) {
            Some(conversation) => Ok(Some(conversation)),
            None => Err("This recording has no ChatGPT conversation".into()),
        }
    }

    /// `eligibleStageEnd`: the finished turn that lets this row go now. Automatic Continue
    /// (`recovery`) and silence tickets need call evidence this build does not keep, so they are
    /// never eligible here.
    pub(crate) async fn eligible_stage_end(&self, entry: &InputEntry) -> Option<String> {
        let session_id = entry.session_id.as_deref()?;
        if entry.recovery.is_some() {
            return None;
        }
        let session = self.session(session_id).await?;
        if session
            .origin
            .as_ref()
            .is_some_and(|origin| origin.kind == SessionOriginKind::Worker)
        {
            return None;
        }
        let end = self.boundary(session_id).await;
        let now = self.now();
        if let Some(boundary) = &entry.silence_boundary
            && boundary.native_busy == Some(true)
            && boundary.listen_until.unwrap_or(0) > now
        {
            return None;
        }
        let active = active_turn(&session);
        if let Some(end) = &end
            && manual_input(entry)
            && active.is_none()
            && !end.start
            && end.turn_id.is_some()
            && end.outcome == Some(TurnOutcome::Failed)
            && end.thinking_failed
            && session.last_tool_call_at.unwrap_or(0) <= end.time
            && session.conversation_id.is_some()
        {
            return end.turn_id.clone();
        }
        if let Some(boundary) = &entry.silence_boundary {
            if session.conversation_id.as_deref() != Some(&boundary.conversation_id)
                || active
                    .as_ref()
                    .is_some_and(|active| active != &boundary.turn_id)
            {
                return None;
            }
            if end.as_ref().and_then(|end| end.turn_id.as_deref()) != Some(&boundary.turn_id) {
                return None;
            }
            // Without a completed final, the ticket needs the turn's own MCP call as proof.
            if !end.as_ref().is_some_and(Boundary::completed_end) {
                return None;
            }
        }
        if active.is_some() {
            return None;
        }
        let end = end.filter(Boundary::completed_end)?;
        let turn = end.turn_id.clone()?;
        let queued_here = entry.queued_turn.as_ref().is_some_and(|queued| {
            session.conversation_id.as_deref() == Some(&queued.conversation_id)
                && queued.turn_id == turn
        });
        if !queued_here && end.time < entry.created_at {
            return None;
        }
        if !self.policy(session_id).await.settled {
            return None;
        }
        Some(turn)
    }

    /// `browserInputAllowed`.
    pub(crate) async fn browser_input_allowed(&self, entry: &InputEntry) -> bool {
        if entry
            .error
            .as_deref()
            .is_some_and(|error| error.starts_with("Local chat setup failed:"))
        {
            return false;
        }
        if entry.delivery.is_some() || entry.attachment_delivery.is_some() {
            return false;
        }
        if entry.opening.is_some()
            && let Some(session_id) = &entry.session_id
            && entry.delivered_at.is_none()
            && let Some(session) = self.session(session_id).await
            && session
                .origin
                .as_ref()
                .is_some_and(|origin| origin.kind == SessionOriginKind::Desktop)
            && session.conversation_id.is_none()
        {
            return true;
        }
        if entry.mode == InputMode::Finish
            && let Some(session_id) = &entry.session_id
            && entry.after_turn != Some(true)
            && self
                .session(session_id)
                .await
                .is_some_and(|session| astra_chat(&session))
        {
            return false;
        }
        let Some(session_id) = &entry.session_id else {
            return !intent_is(entry, TransportIntent::Tool);
        };
        let session = self.session(session_id).await;
        if let Some(dismissed) = session
            .as_ref()
            .and_then(|session| session.browser_recovery_dismissed_at)
            && (!manual_input(entry) || entry.created_at <= dismissed)
        {
            return false;
        }
        if let Some(boundary) = &entry.silence_boundary {
            return self.eligible_stage_end(entry).await.as_deref() == Some(&boundary.turn_id);
        }
        let policy = self.policy(session_id).await;
        if let Some(completed) = &entry.completed_turn_id
            && self.eligible_stage_end(entry).await.as_deref() != Some(completed)
        {
            return false;
        }
        if let Some(direct) = &entry.direct_turn {
            let Some(session) = self.session(session_id).await else {
                return false;
            };
            if session.conversation_id != entry.conversation_id {
                return false;
            }
            if active_turn(&session).is_some() {
                return policy.direct_turn.as_ref().map(|turn| &turn.id) == Some(&direct.id);
            }
            let end = self.boundary(session_id).await;
            return policy.browser_allowed
                && end.is_some_and(|end| !end.start && end.turn_id.as_deref() == Some(&direct.id));
        }
        policy.browser_allowed
            && (!intent_is(entry, TransportIntent::Tool)
                || (entry.mode == InputMode::Auto
                    && entry.finish_owner.is_none()
                    && !decision(entry)
                    && entry.state == InputState::Queued
                    && entry.owner.is_none()
                    && entry.offered_at.is_none()
                    && policy.settled))
    }

    /// `completedStageBoundary`: the finished turn a queued follow-up may go after, when it is
    /// the head of its chat's queue.
    pub(crate) async fn completed_stage_boundary(
        &self,
        entry: &InputEntry,
        current: &[InputEntry],
    ) -> Option<String> {
        let session_id = entry.session_id.as_deref()?;
        if !queued_followup(entry) {
            return None;
        }
        let now = self.now();
        let sorted = ordered(current);
        let first = sorted.iter().find(|row| {
            row.session_id.as_deref() == Some(session_id)
                && queued_followup(row)
                && row.state == InputState::Queued
        })?;
        if first.id != entry.id || first.due_at > now || !self.browser_input_allowed(first).await {
            return None;
        }
        let turn = self.eligible_stage_end(entry).await?;
        let same_session = |row: &InputEntry| row.session_id.as_deref() == Some(session_id);
        if current.iter().any(|row| {
            row.id != entry.id
                && same_session(row)
                && row.state == InputState::Queued
                && row
                    .silence_boundary
                    .as_ref()
                    .is_some_and(|boundary| boundary.turn_id == turn)
        }) {
            return None;
        }
        if current.iter().any(|row| {
            same_session(row)
                && (consumed_turn(row, &turn)
                    || matches!(row.state, InputState::Tool | InputState::Browser))
        }) {
            return None;
        }
        if current.iter().any(|row| {
            same_session(row)
                && !queued_followup(row)
                && !decision(row)
                && row.due_at <= now
                && matches!(
                    row.state,
                    InputState::Queued | InputState::Browser | InputState::Tool
                )
        }) {
            return None;
        }
        Some(turn)
    }
}

/// `consumedTurn`: this row already spent that finished turn.
pub(crate) fn consumed_turn(row: &InputEntry, turn: &str) -> bool {
    row.completed_turn_id.as_deref() == Some(turn)
        && (row.send_authorized_at.is_some()
            || row.delivered_at.is_some()
            || row.requires_authorization == Some(false))
}

pub(crate) fn helper_or_worker_session(session: &SessionSummary) -> bool {
    helper_or_worker(session)
}

pub(crate) fn worker_session(session: &SessionSummary) -> bool {
    session
        .origin
        .as_ref()
        .is_some_and(|origin| origin.kind == SessionOriginKind::Worker)
}
