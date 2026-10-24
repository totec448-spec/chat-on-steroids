//! The bridge answers `bridge.ts` gives for `/goal/{draft,ack,objective,open}`, and the
//! chat-scoped Goal/Loop switch of `POST /settings`. Each takes the parsed body and returns a
//! status and a JSON body; the bridge family only reads and writes the wire.

use serde_json::{Map, Value, json};

use cos_types::bridge::GoalStage;
use cos_types::config::GoalMode;
use cos_types::ids::BridgeConversationId;
use cos_types::session::SessionEvent;

use crate::drafts::{DraftStart, OwnedElsewhere};
use crate::errors::{error_key, error_message};
use crate::{AcceptReply, Goal, js};

/// A bridge reply: the status and the serialized body.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
}

impl Answer {
    fn json(status: u16, body: Value) -> Self {
        Self { status, body }
    }

    /// `goalJson`: an error body gains its explanation and catalog key.
    fn goal(status: u16, body: Value) -> Self {
        let mut body = body;
        if let Value::Object(object) = &mut body
            && let Some(error) = object
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned)
            && !object.contains_key("message")
        {
            object.insert("message".into(), Value::from(error_message(&error)));
            object.insert(
                "messageKey".into(),
                error_key(&error).map_or(Value::Null, Value::from),
            );
        }
        Self { status, body }
    }

    fn refuse(status: u16, error: &str) -> Self {
        Self::goal(status, json!({ "error": error }))
    }

    fn refuse_settled(status: u16, error: &str, retryable: bool) -> Self {
        Self::goal(status, json!({ "error": error, "retryable": retryable }))
    }
}

/// What the chat's switch says after a chat-scoped `/settings` write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwitchChange {
    pub enabled: bool,
    pub mode: GoalMode,
}

/// `conversationId(value)` in `bridge.ts`.
fn conversation(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    BridgeConversationId::parse(text)
        .ok()
        .map(|_| text.to_owned())
}

fn string_field(body: &Value, key: &str, limit: usize) -> String {
    body.get(key)
        .and_then(Value::as_str)
        .map(|text| js::prefix(text, limit))
        .unwrap_or_default()
}

fn named_mode(body: &Value) -> Option<GoalMode> {
    match body.get("mode").and_then(Value::as_str) {
        Some("goal") => Some(GoalMode::Goal),
        Some("loop") => Some(GoalMode::Loop),
        _ => None,
    }
}

/// `recoveryBusyMs(pro)`.
fn recovery_busy_ms(pro: bool) -> u64 {
    if pro { 5 * 60_000 } else { 60_000 }
}

impl Goal {
    /// `goalActiveFor`: armed, and not a worker or blocked chat.
    pub fn active_for(&self, conversation: &str) -> bool {
        !self.fenced(conversation) && self.armed_for(conversation)
    }

    /// `goalFencedChat`: a chat the loop may not drive, by role or by the user's block.
    pub fn fenced(&self, conversation: &str) -> bool {
        let chats = &self.shared().chats;
        chats.worker(conversation) || chats.blocked(conversation)
    }

    fn superseded(&self, conversation: &str) -> bool {
        self.shared().sessions.conversation_superseded(conversation)
    }

    /// The switch and the ticket are one user decision (`activateConversationGoalReply`).
    async fn follow_switch(&self, conversation: &str) -> Result<bool, crate::NotDurable> {
        let mode = self.switch_for(conversation).mode;
        let active = self.active_for(conversation)
            && self.config().sessions.record
            && self.key_present(mode).await;
        self.set_reply_active_now(conversation, active).await
    }

    /// `saveConversationObjective`.
    async fn save_objective(
        &self,
        id: &str,
        text: &str,
        named: Option<GoalMode>,
    ) -> Result<Value, &'static str> {
        let set = !js::trim(text).is_empty();
        if self.shared().chats.worker(id) {
            return Err("goal_worker_chat");
        }
        if set && self.superseded(id) {
            return Err("conversation_superseded");
        }
        if set && self.shared().chats.blocked(id) {
            return Err("chat_blocked");
        }
        let mut chat_switch = None;
        if let Some(named) = named {
            let held = self.switch_for(id);
            let which = if set {
                named
            } else if held.enabled {
                held.mode
            } else {
                named
            };
            chat_switch = Some(
                self.set_switch_now(id, which, set, None)
                    .await
                    .map_err(|_| "goal_switch_not_durable")?,
            );
        }
        let objective = self
            .set_objective_now(id, text)
            .await
            .map_err(|_| "goal_objective_not_durable")?;
        self.follow_switch(id)
            .await
            .map_err(|_| "goal_ticket_not_durable")?;
        self.notify();
        let mut body = Map::new();
        body.insert("objective".into(), Value::from(objective));
        if let Some((enabled, mode)) = chat_switch {
            body.insert("enabled".into(), Value::from(enabled));
            body.insert("own".into(), Value::from(true));
            body.insert("mode".into(), Value::from(mode.as_str()));
        }
        Ok(Value::Object(body))
    }

    /// `POST /goal/objective`: one chat's specific goal, and the mode it names.
    pub async fn objective_answer(&self, body: &Value) -> Answer {
        let Some(id) = conversation(body.get("conversationId")) else {
            return Answer::refuse(400, "bad_conversation_id");
        };
        let text = body.get("text").and_then(Value::as_str).unwrap_or("");
        match self.save_objective(&id, text, named_mode(body)).await {
            Ok(saved) => Answer::goal(200, saved),
            Err(reason @ ("goal_worker_chat" | "conversation_superseded" | "chat_blocked")) => {
                Answer::refuse(409, reason)
            }
            Err(reason) => Answer::refuse_settled(503, reason, true),
        }
    }

    /// `POST /goal/open`: the opening message for a chat that has no id yet.
    pub async fn open_answer(&self, body: &Value) -> Answer {
        let text = body.get("text").and_then(Value::as_str).unwrap_or("");
        if js::trim(text).is_empty() {
            return Answer::refuse(400, "no_objective");
        }
        let named = named_mode(body);
        let mode = named.unwrap_or_else(|| self.config().goal.mode);
        if !self.key_present(mode).await {
            return Answer::refuse(409, "no_api_key");
        }
        match self.draft_opening(text, named).await {
            Ok((reply, model)) => Answer::goal(200, json!({ "reply": reply, "model": model })),
            Err(failure) => {
                let mut body = Map::new();
                body.insert("error".into(), Value::from(failure.error));
                if let Some(retryable) = failure.retryable {
                    body.insert("retryable".into(), Value::from(retryable));
                }
                if let Some(after) = failure.retry_after_ms {
                    body.insert("retryAfterMs".into(), Value::from(after));
                }
                Answer::goal(502, Value::Object(body))
            }
        }
    }

    /// `POST /goal/ack`: the page typed this draft, or decided it never will.
    pub async fn ack_answer(&self, body: &Value) -> Answer {
        let Some(id) = conversation(body.get("conversationId")) else {
            return Answer::refuse(400, "bad_conversation_id");
        };
        let token = body.get("token").and_then(Value::as_str).unwrap_or("");
        let client = string_field(body, "clientId", 100);
        let result = if body.get("nativeBusy") == Some(&Value::Bool(true)) {
            let Some(draft) = self
                .view_for(&id, Some(&client))
                .filter(|draft| draft.token == token && draft.stage == GoalStage::Ready)
            else {
                return Answer::goal(200, json!({ "acknowledged": false, "deferred": false }));
            };
            let until = self.now() + recovery_busy_ms(false);
            match self
                .defer_reply_now(&id, &draft.turn_id, Some(until), Some((token, &client)))
                .await
            {
                Ok(deferred) => {
                    let mut body = Map::new();
                    body.insert("acknowledged".into(), Value::from(false));
                    body.insert("deferred".into(), Value::from(deferred));
                    if deferred {
                        let listen = self.pending_reply_for(&id).and_then(|p| p.listen_until);
                        body.insert(
                            "listenUntil".into(),
                            listen.map_or(Value::Null, Value::from),
                        );
                    }
                    Ok(Value::Object(body))
                }
                Err(error) => Err(error),
            }
        } else {
            self.ack_draft_now(&id, token, Some(&client))
                .await
                .map(|acknowledged| json!({ "acknowledged": acknowledged }))
        };
        match result {
            Ok(body) => Answer::goal(200, body),
            Err(error) => {
                self.shared().logger.warn(&format!(
                    "bridge: Goal acknowledgement for {id} is not durable yet — {error}"
                ));
                Answer::refuse_settled(503, "goal_ack_not_durable", true)
            }
        }
    }

    /// `readCompletedFinal`, as far as this owner can see it: the newest final answer of this
    /// turn, with no newer question after it and no other turn open.
    async fn completed_final(&self, session: &str, conversation: &str, turn: &str) -> bool {
        let Ok(id) = cos_types::ids::SessionId::parse(session) else {
            return false;
        };
        let sessions = &self.shared().sessions;
        let Some(summary) = sessions.summary(&id).await else {
            return false;
        };
        if summary.conversation_id.as_deref() != Some(conversation) {
            return false;
        }
        let events = sessions
            .recent_events(
                &id,
                256,
                &["turn_start", "user_message", "assistant_message"],
            )
            .await
            .unwrap_or_default();
        let matches_turn = |turn_id: Option<&str>, message: Option<&str>| {
            turn_id == Some(turn)
                || turn
                    .strip_prefix("reply:")
                    .is_some_and(|m| message == Some(m))
        };
        let Some((at, final_turn)) =
            events
                .iter()
                .enumerate()
                .rev()
                .find_map(|(at, event)| match event {
                    SessionEvent::AssistantMessage(answer)
                        if answer.is_final
                            && answer.message_id.is_some()
                            && (!js::trim(&answer.message.text).is_empty()
                                || answer.provider_message_id.is_some())
                            && matches_turn(
                                answer.base.turn_id.as_deref(),
                                answer.message_id.as_deref(),
                            ) =>
                    {
                        Some((at, answer.base.turn_id.clone()))
                    }
                    _ => None,
                })
        else {
            return false;
        };
        if let Some(Some(active)) = &summary.active_turn_id
            && final_turn.as_deref() != Some(active.as_str())
        {
            return false;
        }
        !events[at + 1..].iter().any(|event| {
            matches!(event, SessionEvent::UserMessage(_))
                || matches!(event, SessionEvent::TurnStart(start) if start.base.turn_id != final_turn)
        })
    }

    /// `chatStillWorking`: an unfinished turn belongs to Continue, not to Goal.
    async fn still_working(&self, conversation: &str, turn: &str, session: &str) -> bool {
        if self.shared().chats.working(conversation) {
            return true;
        }
        let now = self.now();
        if self
            .pending_reply_for(conversation)
            .is_some_and(|p| p.turn_id == turn && p.listen_until.unwrap_or(0) > now)
        {
            return true;
        }
        !self.completed_final(session, conversation, turn).await
    }

    /// `POST /goal/draft`: the page has seen this turn end and asks for its one draft.
    pub async fn draft_answer(&self, body: &Value) -> Answer {
        let id = conversation(body.get("conversationId"));
        let turn = string_field(body, "turnId", 200);
        let terminal_required = body.get("terminalRequired") == Some(&Value::Bool(true));
        let client = string_field(body, "clientId", 100);
        let Some(id) = id else {
            return Answer::refuse(400, "bad_conversation_id");
        };
        if turn.is_empty() {
            return Answer::refuse(400, "bad_turn_id");
        }
        let sessions = self.shared().sessions.clone();
        let recorded = sessions.find_by_conversation(&id, true);
        if let Some(summary) = &recorded
            && self.finish_only(summary.id.as_str(), &id).await
        {
            return Answer::refuse_settled(409, "astra_finish_only", false);
        }
        // No silence owner exists in this build: a synthetic silence turn is never confirmed.
        if turn.starts_with("g-silence-") {
            let pending = self
                .pending_reply_for(&id)
                .is_some_and(|p| p.turn_id == turn);
            let error = if pending {
                "goal_final_not_confirmed"
            } else {
                "goal_reply_not_pending"
            };
            return Answer::refuse_settled(409, error, false);
        }
        if self.superseded(&id) {
            return Answer::refuse(409, "conversation_superseded");
        }
        if terminal_required
            && self
                .pending_reply_for(&id)
                .is_none_or(|p| p.turn_id != turn)
            && self
                .view_for(&id, Some(&client))
                .is_none_or(|d| d.turn_id != turn)
        {
            return Answer::refuse_settled(409, "goal_reply_not_pending", true);
        }
        if !self.active_for(&id) {
            return Answer::refuse(409, "goal_disabled");
        }
        if !self.key_present(self.switch_for(&id).mode).await {
            return Answer::refuse(409, "no_api_key");
        }
        let session = self
            .shared()
            .chats
            .live_session(&id)
            .or_else(|| recorded.as_ref().map(|s| s.id.as_str().to_owned()));
        let Some(session) = session else {
            return Answer::json(
                409,
                json!({ "error": "session_not_recorded", "message": "This chat has no recorded local session to continue from." }),
            );
        };
        if body.get("nativeBusy") == Some(&Value::Bool(true)) {
            return self.native_busy(&id, &turn, &session).await;
        }
        if self.still_working(&id, &turn, &session).await {
            return Answer::json(
                409,
                json!({ "error": "chat_still_working", "retryable": true, "message": "This chat is still working on its answer; the app will draft once it has finished." }),
            );
        }
        let draft = match self.start_draft(DraftStart {
            session_id: session.clone(),
            conversation_id: id.clone(),
            turn_id: turn.clone(),
            client_id: client,
            defer_start: true,
        }) {
            Ok(draft) => draft,
            Err(OwnedElsewhere) => {
                return Answer::json(
                    409,
                    json!({ "error": "goal_owned_elsewhere", "message": "Another tab is already handling Goal Mode for this chat." }),
                );
            }
        };
        let accepted = self
            .accept_reply_now(AcceptReply {
                conversation_id: id.clone(),
                session_id: session.clone(),
                reply_id: js::prefix(&format!("turn:{turn}"), 200),
                turn_id: turn.clone(),
                ..AcceptReply::default()
            })
            .await;
        if let Err(error) = accepted {
            self.discard_prepared(&id, &draft.token);
            self.shared().logger.warn(&format!(
                "bridge: Goal turn {turn} for {id} is not durable yet — {error}"
            ));
            return Answer::refuse_settled(503, "goal_reply_not_durable", true);
        }
        let not_pending = |goal: &Goal| {
            goal.discard_prepared(&id, &draft.token);
            Answer::refuse_settled(409, "goal_reply_not_pending", false)
        };
        let before = self.pending_reply_for(&id);
        if before.as_ref().is_some_and(|p| p.turn_id != turn) {
            return not_pending(self);
        }
        let authority = self.loop_reply_has_authority(&session, &id, &turn).await;
        let after = self.pending_reply_for(&id);
        let same = |a: &Option<cos_types::bridge::GoalPendingReply>,
                    b: &Option<cos_types::bridge::GoalPendingReply>| {
            a.as_ref().map(|p| (&p.turn_id, &p.reply_id, p.accepted_at))
                == b.as_ref().map(|p| (&p.turn_id, &p.reply_id, p.accepted_at))
        };
        if !same(&before, &after) {
            return not_pending(self);
        }
        if !authority {
            self.discard_prepared(&id, &draft.token);
            return Answer::refuse_settled(409, "loop_mcp_call_missing", false);
        }
        if after.is_none_or(|p| p.turn_id != turn) {
            return not_pending(self);
        }
        self.begin_draft(&id, &draft.token);
        Answer::goal(
            200,
            json!({ "goal": serde_json::to_value(&draft).unwrap_or(Value::Null), "sessionId": session }),
        )
    }

    /// The page's native composer is busy: defer this exact owed reply once, and claim the
    /// one native Stop when the wait is over.
    async fn native_busy(&self, id: &str, turn: &str, session: &str) -> Answer {
        let pending = self.pending_reply_for(id);
        let confirmed = match &pending {
            Some(p) => {
                p.turn_id == turn
                    && self.completed_final(session, id, turn).await
                    && self.loop_reply_has_authority(session, id, turn).await
                    && self.active_for(id)
                    && !self.shared().chats.working(id)
            }
            None => false,
        };
        let Some(pending) = pending.filter(|_| confirmed) else {
            return Answer::refuse_settled(409, "goal_final_not_confirmed", false);
        };
        if pending.listen_until.is_none() {
            let until = self.now() + recovery_busy_ms(false);
            if self
                .defer_reply_now(id, turn, Some(until), None)
                .await
                .is_err()
            {
                return Answer::refuse_settled(503, "goal_reply_not_durable", true);
            }
        }
        let stop = self
            .claim_recovery_stop_now(id, &pending.reply_id, pending.accepted_at)
            .await
            .unwrap_or(false)
            && self.completed_final(session, id, turn).await;
        let listen = self.pending_reply_for(id).and_then(|p| p.listen_until);
        let mut recovery = Map::new();
        recovery.insert("stop".into(), Value::from(stop));
        if let Some(listen) = listen {
            recovery.insert("listenUntil".into(), Value::from(listen));
        }
        Answer::goal(200, json!({ "recovery": Value::Object(recovery) }))
    }

    /// The chat-scoped switch of `POST /settings` (`setGoalSwitchNow`, then the ticket).
    /// `Err` is the 503 the page retries.
    pub async fn settings_switch(
        &self,
        id: &str,
        which: GoalMode,
        on: bool,
    ) -> Result<SwitchChange, Answer> {
        let held = self.switch_for(id);
        let before = held.enabled.then_some(held.mode);
        let (enabled, mode) = self
            .set_switch_now(id, which, on, None)
            .await
            .map_err(|_| Answer::json(500, json!({ "error": "internal" })))?;
        if before != enabled.then_some(mode) || mode == which {
            let followed = self.follow_switch(id).await;
            if let Err(error) = followed {
                self.shared().logger.warn(&format!(
                    "bridge: Goal ticket for {id} did not follow its switch — {error}"
                ));
                return Err(Answer::json(
                    503,
                    json!({ "error": "goal_ticket_not_durable", "retryable": true }),
                ));
            }
        }
        Ok(SwitchChange { enabled, mode })
    }

    /// `loopAfterTurn` of `POST /settings` (`setSessionAutomation`).
    pub async fn settings_after_turn(&self, id: &str, after_turn: bool) -> Answer {
        let Some(session) = self.shared().sessions.find_by_conversation(id, true) else {
            return Answer::json(409, json!({ "error": "session_not_recorded" }));
        };
        let control = self.switch_for(id);
        if control.enabled && self.fenced(id) {
            let error = if self.shared().chats.worker(id) {
                "worker_goal_disabled"
            } else {
                "chat_blocked"
            };
            self.shared()
                .logger
                .warn(&format!("bridge request failed: {error}"));
            return Answer::json(500, json!({ "error": "internal" }));
        }
        let held = self
            .set_switch_now(id, control.mode, control.enabled, Some(after_turn))
            .await;
        let Ok((enabled, mode)) = held else {
            return Answer::json(500, json!({ "error": "internal" }));
        };
        let key = enabled && self.key_present(mode).await;
        let live = self.switch_for(id);
        let active = enabled
            && live.enabled
            && live.mode == mode
            && !self.fenced(id)
            && self.config().sessions.record
            && key;
        let _ = session;
        if self.set_reply_active_now(id, active).await.is_err() {
            return Answer::json(500, json!({ "error": "internal" }));
        }
        self.notify();
        Answer::json(
            200,
            json!({ "goal": { "afterTurn": self.switch_for(id).after_turn } }),
        )
    }
}

/// A Goal route body that could not be read: `400 bad_request` through `goalJson`.
pub fn bad_request() -> Answer {
    Answer::refuse(400, "bad_request")
}
