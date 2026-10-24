//! The owed-reply ledger (`goal-replies`): the stable ChatGPT reply that still needs one
//! terminal Goal decision. A row is changed in memory, then the whole ledger is written; a write
//! that fails puts the row back as it was.

use std::sync::Arc;

use cos_types::bridge::GoalPendingReply;
use cos_types::config::GoalMode;
use cos_types::ids::{ConversationId, SessionId};
use cos_types::json::True;
use cos_types::session::{CallAttribution, EventSource, SessionEvent, TurnOutcome};
use cos_types::state::{GoalReplies, GoalReplyObligation, GoalReplyState};

use crate::ledger::{self, PICKUP_MAX_ATTEMPTS, REPLY_TTL_MS};
use crate::{AcceptReply, Goal, NotDurable, js, write_now};

fn cut(text: &str) -> String {
    js::prefix(text, 200)
}

impl Goal {
    /// Writes the reply ledger as memory holds it now.
    pub(crate) async fn commit_replies(&self) -> Result<(), NotDurable> {
        let durable = self.files()?.replies.clone();
        let _writer = self.shared().replies_writes.lock().await;
        let snapshot = self.replies_snapshot();
        write_now(&durable, snapshot).await
    }

    /// `persistGoalRepliesSoon`: the snapshot is taken when the write happens.
    pub(crate) fn persist_replies_soon(&self) {
        let Ok(files) = self.files() else {
            return;
        };
        let owner = Arc::downgrade(self.shared_arc());
        files
            .replies
            .write_snapshot_soon(move || match owner.upgrade() {
                Some(shared) => Goal::from_shared(shared).replies_snapshot(),
                None => ledger::replies_snapshot(&Default::default(), 0),
            });
    }

    /// The whole reply ledger as it would be written now (`snapshotGoalReplies`).
    pub fn replies_snapshot(&self) -> GoalReplies {
        let now = self.now();
        let mut state = self.lock();
        ledger::bound_replies(&mut state.replies, now);
        ledger::replies_snapshot(&state.replies, now)
    }

    /// `goalPendingReplyFor`: the stable reply this chat still owes one decision.
    pub fn pending_reply_for(&self, conversation: &str) -> Option<GoalPendingReply> {
        let now = self.now();
        let state = self.lock();
        let reply = state.replies.get(conversation)?;
        if now.saturating_sub(reply.accepted_at) >= REPLY_TTL_MS
            || reply.state != GoalReplyState::Pending
        {
            return None;
        }
        Some(GoalPendingReply {
            reply_id: reply.reply_id.clone(),
            turn_id: reply.turn_id.clone(),
            event_seq: reply.event_seq,
            accepted_at: reply.accepted_at,
            explicit_activation: reply.explicit_activation,
            silence_source_turn_id: reply.silence_source_turn_id.clone(),
            listen_until: reply.listen_until,
            silence_pro: (reply.silence_pro == Some(true)).then_some(True),
            pickup_attempts: reply.pickup_attempts,
            pickup_next_at: reply.pickup_next_at,
            pickup_stopped_at: reply.pickup_stopped_at,
        })
    }

    /// `pendingGoalReplies`: every chat that still owes a decision, newest acceptance first.
    pub fn pending_replies(&self) -> Vec<GoalReplyObligation> {
        let now = self.now();
        let mut owed: Vec<GoalReplyObligation> = self
            .lock()
            .replies
            .values()
            .filter(|reply| {
                reply.state == GoalReplyState::Pending
                    && now.saturating_sub(reply.accepted_at) < REPLY_TTL_MS
            })
            .cloned()
            .collect();
        owed.sort_by_key(|reply| std::cmp::Reverse(reply.accepted_at));
        owed
    }

    /// `handleGoalReply`: a real decision discharges the turn it was owed for.
    pub(crate) fn handle_reply(&self, conversation: &str, turn: Option<&str>) {
        let changed = {
            let mut state = self.lock();
            match state.replies.get_mut(conversation) {
                Some(reply)
                    if reply.state == GoalReplyState::Pending
                        && turn.is_none_or(|turn| reply.turn_id == turn) =>
                {
                    reply.state = GoalReplyState::Handled;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.persist_replies_soon();
        }
    }

    /// `acceptGoalReplyNow`: freezes Goal eligibility for one stable reply at the recorder's
    /// durable boundary.
    pub async fn accept_reply_now(&self, input: AcceptReply) -> Result<(), NotDurable> {
        if !input.handled_only
            && self
                .finish_only(&input.session_id, &input.conversation_id)
                .await
        {
            return Ok(());
        }
        let current = self.lock().replies.get(&input.conversation_id).cloned();
        if current
            .as_ref()
            .is_some_and(|c| c.reply_id == input.reply_id || c.event_seq > input.event_seq)
        {
            return Ok(());
        }
        let provisional_upgrade = current.as_ref().is_some_and(|c| {
            c.event_seq == 0
                && c.turn_id == input.turn_id
                && c.reply_id == cut(&format!("turn:{}", input.turn_id))
        });
        let mode = self.switch_for(&input.conversation_id).mode;
        let active = !input.handled_only
            && !input.blocked
            && self.config().sessions.record
            && self.armed_for(&input.conversation_id)
            && self.key_present(mode).await
            && (mode != GoalMode::Loop
                || self
                    .loop_has_mcp_work(
                        &input.session_id,
                        &input.conversation_id,
                        input
                            .silence_source_turn_id
                            .as_deref()
                            .unwrap_or(&input.turn_id),
                    )
                    .await);
        let Ok(conversation_id) = ConversationId::parse(&input.conversation_id) else {
            return Ok(());
        };
        let now = self.now();
        let bounded = {
            let mut state = self.lock();
            let bounded = state.replies.clone();
            let previous = state.replies.get(&input.conversation_id).cloned();
            let upgrade = previous.as_ref().filter(|_| provisional_upgrade);
            let row = GoalReplyObligation {
                explicit_activation: None,
                silence_source_turn_id: input.silence_source_turn_id.as_deref().map(cut),
                silence_pro: input.silence_pro.then_some(true),
                listen_until: input.listen_until,
                recovery_stop_claimed: None,
                pickup_attempts: upgrade.and_then(|c| c.pickup_attempts),
                pickup_next_at: upgrade.and_then(|c| c.pickup_next_at),
                pickup_stopped_at: upgrade.and_then(|c| c.pickup_stopped_at),
                conversation_id,
                session_id: input.session_id.clone(),
                reply_id: cut(&input.reply_id),
                turn_id: cut(&input.turn_id),
                event_seq: input.event_seq,
                accepted_at: upgrade.map_or(now, |c| c.accepted_at),
                state: match upgrade {
                    Some(c) => c.state,
                    None if active => GoalReplyState::Pending,
                    None => GoalReplyState::Handled,
                },
                extra: Default::default(),
            };
            state.replies.set(&input.conversation_id, row);
            bounded
        };
        if let Err(error) = self.commit_replies().await {
            // The rejected write is one whole revision, so the rollback is too.
            self.lock().replies = bounded;
            self.persist_replies_soon();
            return Err(error);
        }
        Ok(())
    }

    /// `automaticLoopHasMcpWork`: automatic Loop pickup needs a recorded MCP call from this
    /// exact source turn, not a page tool.
    pub async fn loop_has_mcp_work(&self, session: &str, conversation: &str, turn: &str) -> bool {
        let Ok(id) = SessionId::parse(session) else {
            return false;
        };
        let sessions = &self.shared().sessions;
        let Some(summary) = sessions.summary(&id).await else {
            return false;
        };
        if summary.conversation_id.as_deref() != Some(conversation) {
            return false;
        }
        let source = match turn.strip_prefix("reply:") {
            Some(message) => sessions
                .recent_events(&id, 256, &["assistant_message"])
                .await
                .unwrap_or_default()
                .into_iter()
                .find_map(|event| match event {
                    SessionEvent::AssistantMessage(answer)
                        if answer.message_id.as_deref() == Some(message) =>
                    {
                        answer.base.turn_id
                    }
                    _ => None,
                }),
            None => Some(turn.to_owned()),
        };
        match source {
            Some(source) => self.turn_has_mcp_call(&id, conversation, &source).await,
            None => false,
        }
    }

    /// `turnHasMcpCall`: a request-id-attributed MCP call recorded in this exact turn.
    async fn turn_has_mcp_call(&self, session: &SessionId, conversation: &str, turn: &str) -> bool {
        let calls = self
            .shared()
            .sessions
            .recent_events(session, 4096, &["tool_call"])
            .await
            .unwrap_or_default();
        calls.iter().any(|event| match event {
            SessionEvent::ToolCall(call) => {
                call.base.turn_id.as_deref() == Some(turn)
                    && call.base.source == EventSource::Mcp
                    && call.call.conversation_id.as_deref() == Some(conversation)
                    && call.call.attribution == CallAttribution::RequestId
            }
            _ => false,
        })
    }

    /// `loopReplyHasAuthority`: restored automatic debt has no exemption.
    pub async fn loop_reply_has_authority(
        &self,
        session: &str,
        conversation: &str,
        turn: &str,
    ) -> bool {
        if self.switch_for(conversation).mode != GoalMode::Loop {
            return true;
        }
        let reply = self.lock().replies.get(conversation).cloned();
        if let Some(reply) = &reply
            && reply.session_id == session
            && reply.turn_id == turn
            && reply.state == GoalReplyState::Pending
            && reply.explicit_activation.is_some()
        {
            return true;
        }
        let source = match &reply {
            Some(reply) if reply.turn_id == turn => reply
                .silence_source_turn_id
                .clone()
                .unwrap_or_else(|| turn.to_owned()),
            _ => turn.to_owned(),
        };
        self.loop_has_mcp_work(session, conversation, &source).await
    }

    /// Deliberate On after a stopped or thinking-failed answer: that exact ended source is
    /// owed a decision, filed as an `activation:` reply.
    async fn activation_source(&self, conversation: &str) -> Result<bool, NotDurable> {
        let Some(summary) = self
            .shared()
            .sessions
            .find_by_conversation(conversation, true)
        else {
            return Ok(true);
        };
        if matches!(summary.active_turn_id, Some(Some(_))) {
            return Ok(false);
        }
        let held = self.lock().replies.get(conversation).cloned();
        if held.as_ref().is_some_and(|h| h.silence_pro == Some(true))
            && !self.loop_after_turn_for(conversation)
        {
            return Ok(false);
        }
        let end = self
            .shared()
            .sessions
            .recent_events(&summary.id, 1, &["turn_start", "turn_end", "user_message"])
            .await
            .unwrap_or_default()
            .pop();
        let not_newer = |seq: u64| held.as_ref().is_none_or(|h| h.event_seq <= seq);
        match end {
            Some(SessionEvent::UserMessage(event)) if not_newer(event.base.seq) => Ok(false),
            Some(SessionEvent::TurnStart(event)) if not_newer(event.base.seq) => Ok(false),
            Some(SessionEvent::TurnEnd(event)) => {
                let thinking_failed =
                    event.reason == Some(cos_types::session::TurnEndReason::ThinkingFailed);
                if thinking_failed && event.base.time + 5 * 60_000 > self.now() {
                    return Ok(false);
                }
                let ended = event.outcome == TurnOutcome::Stopped
                    || (event.outcome == TurnOutcome::Failed && thinking_failed);
                if let Some(turn) = event.base.turn_id.clone()
                    && ended
                    && held.as_ref().is_none_or(|h| h.event_seq < event.base.seq)
                {
                    self.accept_reply_now(AcceptReply {
                        conversation_id: conversation.to_owned(),
                        session_id: summary.id.as_str().to_owned(),
                        reply_id: format!("activation:{turn}"),
                        turn_id: turn,
                        event_seq: event.base.seq,
                        ..AcceptReply::default()
                    })
                    .await?;
                    return Ok(self.armed_for(conversation));
                }
                Ok(true)
            }
            _ => Ok(true),
        }
    }

    /// `setGoalReplyActiveNow`: one chat switch applied to the durable obligation. Off closes
    /// the pickup; On re-arms the newest stable reply the recorder accepted. The draft is
    /// retired before the ledger is written.
    pub async fn set_reply_active_now(
        &self,
        conversation: &str,
        active: bool,
    ) -> Result<bool, NotDurable> {
        if active
            && (!self.armed_for(conversation) || !self.activation_source(conversation).await?)
        {
            return Ok(false);
        }
        let retired = self.discard_draft(conversation);
        let now = self.now();
        let previous = {
            let mut state = self.lock();
            let Some(before) = state.replies.get_mut(conversation) else {
                return Ok(retired);
            };
            let previous = before.clone();
            before.state = if active {
                GoalReplyState::Pending
            } else {
                GoalReplyState::Handled
            };
            if active {
                // Re-arming the same stable reply cannot refund its recovery budget.
                before.accepted_at = now.max(previous.accepted_at + 1);
                before.explicit_activation = Some(True);
            }
            previous
        };
        if let Err(error) = self.commit_replies().await {
            self.lock().replies.set(conversation, previous);
            self.persist_replies_soon();
            return Err(error);
        }
        Ok(true)
    }

    /// `deferSilenceGoalReplyNow`: native busy defers this exact ticket, never a new one.
    pub async fn defer_reply_now(
        &self,
        conversation: &str,
        turn: &str,
        listen_until: Option<u64>,
        prepared: Option<(&str, &str)>,
    ) -> Result<bool, NotDurable> {
        let now = self.now();
        let current = {
            let mut state = self.lock();
            let Some(reply) = state.replies.get(conversation) else {
                return Ok(false);
            };
            if reply.state != GoalReplyState::Pending || reply.turn_id != turn {
                return Ok(false);
            }
            let current = reply.listen_until.unwrap_or(0);
            if let Some((token, client)) = prepared {
                let ready = state.drafts.get(conversation).is_some_and(|draft| {
                    draft.token == token
                        && draft.client_id == client
                        && draft.turn_id == turn
                        && !draft.acknowledged
                        && draft.stage == cos_types::bridge::GoalStage::Ready
                });
                if !ready {
                    return Ok(false);
                }
                // Renewed native work retires only this prepared text, never its obligation.
                if let Some(mut draft) = state.drafts.remove(conversation) {
                    draft.acknowledged = true;
                    draft.abort.cancel();
                }
            }
            current
        };
        if prepared.is_some() {
            self.notify();
        }
        if listen_until.is_none() && current > now {
            return Ok(true);
        }
        let deadline = listen_until.unwrap_or(now + 5 * 60_000);
        if current >= deadline {
            return Ok(true);
        }
        if let Some(reply) = self.lock().replies.get_mut(conversation) {
            reply.listen_until = Some(deadline);
        }
        self.notify();
        if let Err(error) = self.commit_replies().await {
            self.persist_replies_soon();
            return Err(error);
        }
        Ok(self
            .lock()
            .replies
            .get(conversation)
            .is_some_and(|reply| reply.turn_id == turn))
    }

    /// `claimGoalRecoveryStopNow`: the irreversible native Stop is claimed once per final.
    pub async fn claim_recovery_stop_now(
        &self,
        conversation: &str,
        reply_id: &str,
        accepted_at: u64,
    ) -> Result<bool, NotDurable> {
        let now = self.now();
        let armed = self.armed_for(conversation);
        {
            let mut state = self.lock();
            let Some(reply) = state.replies.get_mut(conversation) else {
                return Ok(false);
            };
            if reply.reply_id != reply_id
                || reply.accepted_at != accepted_at
                || reply.state != GoalReplyState::Pending
                || !armed
                || reply.listen_until.is_none_or(|until| until > now)
                || reply.recovery_stop_claimed.is_some()
            {
                return Ok(false);
            }
            reply.recovery_stop_claimed = Some(True);
        }
        self.commit_replies().await?;
        let pending = self.lock().replies.get(conversation).is_some_and(|reply| {
            reply.reply_id == reply_id && reply.state == GoalReplyState::Pending
        });
        Ok(pending && self.armed_for(conversation))
    }

    /// `recordGoalPickupAttemptNow`: durably reserves one reload for this exact reply, before
    /// the browser can act. Answers `(attempts, nextAt, stoppedAt)`.
    pub async fn record_pickup_attempt_now(
        &self,
        conversation: &str,
        reply_id: &str,
        at: u64,
        next_at: Option<u64>,
    ) -> Result<Option<(u64, Option<u64>, Option<u64>)>, NotDurable> {
        let previous = {
            let mut state = self.lock();
            let Some(reply) = state.replies.get_mut(conversation) else {
                return Ok(None);
            };
            let attempts = reply.pickup_attempts.unwrap_or(0);
            if reply.state != GoalReplyState::Pending
                || reply.reply_id != reply_id
                || reply.pickup_stopped_at.is_some()
                || attempts >= PICKUP_MAX_ATTEMPTS
            {
                return Ok(None);
            }
            let previous = reply.clone();
            reply.pickup_attempts = Some(attempts + 1);
            if attempts + 1 >= PICKUP_MAX_ATTEMPTS {
                reply.pickup_stopped_at = Some(at);
                reply.pickup_next_at = None;
            } else if next_at.is_some() {
                reply.pickup_next_at = next_at;
            }
            previous
        };
        if let Err(error) = self.commit_replies().await {
            self.lock().replies.set(conversation, previous);
            self.persist_replies_soon();
            return Err(error);
        }
        Ok(self.lock().replies.get(conversation).map(|reply| {
            (
                reply.pickup_attempts.unwrap_or(0),
                reply.pickup_next_at,
                reply.pickup_stopped_at,
            )
        }))
    }
}
