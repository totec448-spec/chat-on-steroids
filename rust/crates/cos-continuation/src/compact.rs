//! `POST /compact`: Compact & Resume, all of it, from the page's side (`bridge.ts`).
//!
//! One button with one transaction behind it, so one route with these shapes:
//! `ticket` files the transaction before any page barrier; `open` starts it and hands back the
//! prompt the page injects; `summary` is the page's capture of the compaction turn's final
//! answer; `cancel` gives up. The source and destination checkpoints (`sourceAttempt`,
//! `sourceDispatch`, `sourceUndelivered`, `sourceLost`, `sourceMessageId`,
//! `destinationAttempt`, `destinationDispatch`, `destinationLost`, `destinationMessageId`)
//! are the durable fences around each irreversible Send.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use cos_types::config::HandoffLength;
use cos_types::ids::SessionId;
use cos_types::session::SessionSummary;
use serde_json::{Map, Value, json};

use crate::continuation::{Continuations, View, normalize_project_id, send_unattempted};
use crate::handoff::{brief_shortfall, native_handoff_prompt};
use crate::{Answer, CommitResult, ContinuationState as State, NotDurable};

/// The browser command that opens chat B (`type: 'resume'` in `state/bridge-commands.json`).
/// Its owner is the command ledger (E2.3).
pub trait ResumeCommands: Send + Sync + 'static {
    /// `queueResumeCommand`: queues or folds the session's one replacement chat. Answers the
    /// command id.
    fn queue(&self, session: &SessionId, token: &str) -> Option<String>;
    /// Retires every resume command for this transaction.
    fn retire(&self, token: &str, reason: &str);
    /// Durably removes the session's queued command (`cancelResumeNow`). `true` when one existed.
    fn withdraw(&self, session: &SessionId) -> bool;
    /// The session's command: `Some(leased)` when one exists.
    fn command(&self, session: &SessionId) -> Option<CommandView>;
    /// `writeCommandTransition` guard: command `id` is this transaction's, leased to `client`.
    fn leased_to(&self, id: &str, token: &str, client: Option<&str>) -> bool;
    /// `deliver()` and `pendingBrowserPlacement(conversation)`: hands the new command to a
    /// browser, and answers the placement chat A's page may open.
    fn deliver(&self, collector: Option<&str>) -> Option<Value>;
}

/// The session's resume command, as the job view needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandView {
    pub id: String,
    pub leased: bool,
}

/// No command ledger for resumes: nothing opens chat B.
pub struct NoResumeCommands;

impl ResumeCommands for NoResumeCommands {
    fn queue(&self, _session: &SessionId, _token: &str) -> Option<String> {
        None
    }
    fn retire(&self, _token: &str, _reason: &str) {}
    fn withdraw(&self, _session: &SessionId) -> bool {
        false
    }
    fn command(&self, _session: &SessionId) -> Option<CommandView> {
        None
    }
    fn leased_to(&self, _id: &str, _token: &str, _client: Option<&str>) -> bool {
        false
    }
    fn deliver(&self, _collector: Option<&str>) -> Option<Value> {
        None
    }
}

/// What the route asks the chat owners: the recorder's live chats, workers (E2.6) and blocked
/// chats.
pub trait CompactChats: Send + Sync + 'static {
    /// The session a live page reports for this chat (`liveConversations()`).
    fn live_session(&self, conversation: &str) -> Option<SessionId>;
    /// `goalWorkerChat`.
    fn worker(&self, conversation: &str) -> bool;
    fn blocked(&self, conversation: &str) -> bool;
}

/// `POST /compact`.
#[derive(Clone)]
pub struct Compact {
    inner: Arc<Inner>,
}

struct Inner {
    continuations: Continuations,
    commands: Arc<dyn ResumeCommands>,
    chats: Arc<dyn CompactChats>,
    /// `sessionTokens`: the last transaction each session opened, so a finished one is still
    /// reported once. At most 50.
    tokens: Mutex<VecDeque<(SessionId, String)>>,
}

/// `conversationId(value)`: 8 to 64 hex digits and dashes.
fn conversation_id(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    ((8..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
        .then(|| text.to_owned())
}

fn flag(body: &Map<String, Value>, key: &str) -> bool {
    body.get(key) == Some(&Value::Bool(true))
}

fn text<'a>(body: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

fn checkpoint_json<T: serde::Serialize>(checkpoint: &T) -> Value {
    serde_json::to_value(checkpoint).unwrap_or(Value::Null)
}

/// `automaticCompactionAllowed`: on, and not exempted by the chat's own Pro selection.
pub fn automatic_compaction_allowed(auto: bool, summary: Option<&SessionSummary>) -> bool {
    let exempt = summary.is_some_and(|summary| {
        summary.selected_model.as_ref().is_some_and(|selected| {
            summary.conversation_id.as_deref() == Some(&selected.conversation_id)
                && cos_input::is_pro_model(Some(&selected.model), selected.reasoning_effort)
        })
    });
    auto && !exempt
}

impl Compact {
    pub fn new(
        continuations: Continuations,
        commands: Arc<dyn ResumeCommands>,
        chats: Arc<dyn CompactChats>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                continuations,
                commands,
                chats,
                tokens: Mutex::new(VecDeque::new()),
            }),
        }
    }

    fn continuations(&self) -> &Continuations {
        &self.inner.continuations
    }

    fn tokens(&self) -> std::sync::MutexGuard<'_, VecDeque<(SessionId, String)>> {
        self.inner
            .tokens
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// `rememberToken`.
    fn remember(&self, session: &SessionId, token: &str) {
        let mut tokens = self.tokens();
        tokens.retain(|(known, _)| known != session);
        tokens.push_back((session.clone(), token.to_owned()));
        while tokens.len() > 50 {
            tokens.pop_front();
        }
    }

    fn remembered(&self, session: &SessionId) -> Option<String> {
        self.tokens()
            .iter()
            .find(|(known, _)| known == session)
            .map(|(_, token)| token.clone())
    }

    fn entry_for(&self, session: &SessionId) -> Option<View> {
        self.remembered(session)
            .and_then(|token| self.continuations().by_token(&token))
            .or_else(|| self.continuations().for_session(session))
    }

    /// `resumeJobFor`: what the page is told about the session's Compact & Resume, derived from
    /// the transaction and whether a browser has been given its command yet.
    pub fn job(&self, session: &SessionId) -> Value {
        let Some(entry) = self.entry_for(session) else {
            return Value::Null;
        };
        let stage = match entry.state {
            State::Committed => "done",
            State::Aborted => "failed",
            State::AwaitingSummary => "handoff-pending",
            _ => match self.inner.commands.command(session) {
                Some(command) if !command.leased => "waiting-for-browser",
                _ => "opening",
            },
        };
        json!({
            "sessionId": session.as_str(),
            "token": entry.token,
            "stage": stage,
            "startedAt": entry.opened_at,
            "automatic": entry.automatic,
            "busy": matches!(stage, "handoff-pending" | "opening" | "waiting-for-browser"),
            "handoffId": entry.handoff_id,
            "sourceSend": checkpoint_json(&entry.source_send),
            "destinationSend": checkpoint_json(&entry.destination_send),
            "error": entry.error,
        })
    }

    /// `cancelResumeNow`: the durable abort first, then the command is withdrawn. `false` once
    /// the move is committing or committed, or when there was nothing to cancel.
    pub async fn cancel_resume(&self, session: &SessionId) -> Result<bool, NotDurable> {
        let entry = self.entry_for(session);
        let queued = self.inner.commands.command(session).is_some();
        if entry
            .as_ref()
            .is_some_and(|entry| matches!(entry.state, State::Committing | State::Committed))
        {
            return Ok(false);
        }
        let mut aborted = false;
        if let Some(entry) = entry.as_ref().filter(|entry| entry.state != State::Aborted) {
            aborted = self
                .continuations()
                .abort_now(&entry.token, "cancelled")
                .await?;
            let after = self.continuations().by_token(&entry.token);
            if !aborted
                && after.is_some_and(|after| {
                    matches!(after.state, State::Committing | State::Committed)
                })
            {
                return Ok(false);
            }
        }
        if entry.is_none() && !queued {
            return Ok(false);
        }
        if queued {
            self.inner.commands.withdraw(session);
        }
        let already_aborted = entry
            .as_ref()
            .is_some_and(|entry| entry.state == State::Aborted);
        Ok(aborted || already_aborted || queued)
    }

    /// `cancelAutomaticResumesNow`: Auto Off owns only threshold-created tickets.
    pub async fn cancel_automatic_resumes(
        &self,
        session: Option<&SessionId>,
    ) -> Result<usize, NotDurable> {
        let mut cancelled = 0;
        for entry in self.continuations().pending() {
            if !entry.automatic || session.is_some_and(|session| session != &entry.session_id) {
                continue;
            }
            if self.cancel_resume(&entry.session_id).await? {
                cancelled += 1;
            }
        }
        Ok(cancelled)
    }

    fn auto_allowed(&self, summary: Option<&SessionSummary>) -> bool {
        automatic_compaction_allowed(self.continuations().config().compaction.auto, summary)
    }

    fn prompt(&self, token: &str) -> String {
        let config = self.continuations().config();
        native_handoff_prompt(
            token,
            config.goal.include_tool_calls == Some(true),
            &config.compaction.handoff_prompt,
            config
                .compaction
                .handoff_length
                .unwrap_or(HandoffLength::Thorough),
        )
    }

    /// `POST /compact` with its parsed body.
    pub async fn answer(&self, body: &Value) -> Answer {
        let empty = Map::new();
        let body = body.as_object().unwrap_or(&empty);
        let token = text(body, "token").unwrap_or_default().to_owned();
        let checkpoint = self.continuations().by_token(&token);
        let sessions = self.continuations().sessions().clone();
        let fence = [
            "sourceAttempt",
            "sourceDispatch",
            "destinationAttempt",
            "destinationDispatch",
        ]
        .iter()
        .any(|key| flag(body, key));
        if let Some(checkpoint) = checkpoint.as_ref().filter(|entry| entry.automatic && fence) {
            let summary = sessions.summary(&checkpoint.session_id).await;
            if !self.auto_allowed(summary.as_ref()) {
                let _ = self
                    .cancel_automatic_resumes(Some(&checkpoint.session_id))
                    .await;
                return Answer::error(409, "automatic_compaction_disabled");
            }
        }
        if let Some(answer) = self.destination(body, &token).await {
            return answer;
        }
        let Some(id) = conversation_id(body.get("conversationId")) else {
            return Answer::error(400, "bad_conversation_id");
        };
        if let Some(answer) = self.source(body, &token, &id).await {
            return answer;
        }
        if let Some(answer) = self.marked_destination(body, &token, &id).await {
            return answer;
        }
        if self.inner.chats.worker(&id) {
            return Answer::new(
                409,
                json!({
                    "error": "worker_compaction_disabled",
                    "message": "Worker chats stay in their existing conversation so the prime can revive them safely."
                }),
            );
        }
        if self.inner.chats.blocked(&id) {
            return Answer::new(
                409,
                json!({
                    "error": "chat_blocked",
                    "message": "This chat is blocked in the app. Release it there before compacting or resuming it."
                }),
            );
        }
        let live = self.inner.chats.live_session(&id);
        let known = match live {
            Some(_) => None,
            None => sessions.find_by_conversation(&id, true),
        };
        let Some(session) = live.or_else(|| known.as_ref().map(|known| known.id.clone())) else {
            return Answer::new(
                409,
                json!({
                    "error": "session_not_recorded",
                    "message": "This chat has no recorded local session to compact."
                }),
            );
        };
        if flag(body, "cancel") {
            return match self.cancel_resume(&session).await {
                Ok(cancelled) => Answer::new(
                    200,
                    json!({
                        "cancelled": cancelled, "sessionId": session.as_str(), "job": self.job(&session)
                    }),
                ),
                Err(error) => {
                    self.continuations().logger().warn(&format!(
                        "bridge: could not durably cancel Compact & Resume for {session} — {error}"
                    ));
                    Answer::new(
                        503,
                        json!({
                            "error": "resume_cancel_not_durable", "retryable": true, "sessionId": session.as_str()
                        }),
                    )
                }
            };
        }
        let summary = sessions.summary(&session).await;
        if !self.auto_allowed(summary.as_ref()) {
            let pending = self.continuations().for_session(&session);
            let _ = self.cancel_automatic_resumes(Some(&session)).await;
            if flag(body, "automatic")
                || (pending.is_some_and(|pending| pending.automatic) && !flag(body, "ticket"))
            {
                return Answer::new(
                    409,
                    json!({ "error": "automatic_compaction_disabled", "sessionId": session.as_str() }),
                );
            }
        }
        if flag(body, "ticket") {
            return match self
                .file_ticket(&session, &id, flag(body, "automatic"))
                .await
            {
                Ok((opened, started)) => Answer::new(
                    202,
                    json!({
                        "started": started,
                        "filed": true,
                        "sessionId": session.as_str(),
                        "token": opened.token,
                        "sourceSend": checkpoint_json(&opened.source_send),
                        "prompt": Value::Null,
                        "job": self.job(&session),
                    }),
                ),
                Err(error) => {
                    self.continuations().logger().warn(&format!(
                        "bridge: could not durably file Compact & Resume for {session} — {error}"
                    ));
                    Answer::new(
                        503,
                        json!({
                            "error": "continuation_not_durable", "retryable": true, "sessionId": session.as_str()
                        }),
                    )
                }
            };
        }
        if let Some(brief) = text(body, "summary") {
            let Some(entry) = self
                .continuations()
                .by_token(&token)
                .filter(|entry| entry.session_id == session)
            else {
                return Answer::error(409, "no_such_continuation");
            };
            return self
                .capture(&id, &entry, brief, known.as_ref().or(summary.as_ref()))
                .await;
        }
        if sessions.conversation_superseded(&id) {
            return Answer::error(409, "conversation_superseded");
        }
        if let Some(already) = self.continuations().for_session(&session) {
            let prompt = (already.state == State::AwaitingSummary
                && send_unattempted(&already.source_send))
            .then(|| self.prompt(&already.token));
            return Answer::new(
                if prompt.is_some() { 202 } else { 200 },
                json!({
                    "started": false,
                    "sessionId": session.as_str(),
                    "token": already.token,
                    "sourceSend": checkpoint_json(&already.source_send),
                    "prompt": prompt,
                    "job": self.job(&session),
                }),
            );
        }
        let opened = match self.continuations().open(&session, &id, false, None).await {
            Ok(opened) => opened,
            Err(error) => {
                self.continuations().logger().warn(&format!(
                    "bridge: could not durably open Compact & Resume for {session} — {error}"
                ));
                return Answer::new(
                    503,
                    json!({
                        "error": "continuation_not_durable", "retryable": true, "sessionId": session.as_str()
                    }),
                );
            }
        };
        self.remember(&session, &opened.token);
        self.continuations().logger().info(&format!(
            "bridge: browser started Compact & Resume for {session} ({})",
            opened.token.get(..8).unwrap_or(&opened.token)
        ));
        Answer::new(
            202,
            json!({
                "started": true,
                "sessionId": session.as_str(),
                "token": opened.token,
                "sourceSend": checkpoint_json(&opened.source_send),
                "prompt": self.prompt(&opened.token),
                "job": self.job(&session),
            }),
        )
    }

    /// `fileCompactionTicket`.
    async fn file_ticket(
        &self,
        session: &SessionId,
        conversation: &str,
        automatic: bool,
    ) -> Result<(View, bool), String> {
        let sessions = self.continuations().sessions();
        let summary = sessions.summary(session).await;
        let controlled = summary
            .as_ref()
            .and_then(|summary| summary.conversation_id.clone())
            .ok_or_else(|| "session_not_recorded".to_owned())?;
        if sessions.conversation_superseded(&controlled) {
            return Err("conversation_superseded".into());
        }
        if controlled != conversation {
            return Err("conversation_changed".into());
        }
        if self.inner.chats.worker(conversation) {
            return Err("worker_compaction_disabled".into());
        }
        if self.inner.chats.blocked(conversation) {
            return Err("chat_blocked".into());
        }
        if automatic && !self.auto_allowed(summary.as_ref()) {
            return Err("automatic_compaction_disabled".into());
        }
        let existing = self.continuations().for_session(session);
        let started = existing.is_none();
        let opened = match existing {
            Some(existing) => existing,
            None => self
                .continuations()
                .open(session, conversation, automatic, None)
                .await
                .map_err(|error| error.0)?,
        };
        self.remember(session, &opened.token);
        Ok((opened, started))
    }

    /// `captureCompactionBrief`: stores the brief for chat A's open transaction and queues chat
    /// B for it.
    async fn capture(
        &self,
        conversation: &str,
        entry: &View,
        text: &str,
        known: Option<&SessionSummary>,
    ) -> Answer {
        let session = &entry.session_id;
        let tokens = match known {
            Some(known) => known.estimated_tokens,
            None => self
                .continuations()
                .sessions()
                .summary(session)
                .await
                .map_or(0, |summary| summary.estimated_tokens),
        };
        let shortfall = if entry.handoff_id.is_some() {
            None
        } else {
            brief_shortfall(text, tokens)
        };
        if let Some(shortfall) = shortfall {
            self.continuations().logger().warn(&format!(
                "bridge: refused the compaction brief for {session} — {shortfall}"
            ));
            if let Err(error) = self.cancel_resume(session).await {
                self.continuations().logger().warn(&format!(
                    "bridge: could not durably withdraw the refused compaction for {session} — {error}"
                ));
                return Answer::new(
                    503,
                    json!({
                        "error": "resume_cancel_not_durable",
                        "retryable": true,
                        "message": "The handoff was incomplete, but cancelling this compaction was not stored yet. Retrying…",
                        "sessionId": session.as_str(),
                        "job": self.job(session),
                    }),
                );
            }
            return Answer::new(
                409,
                json!({
                    "error": "brief_incomplete",
                    "message": format!("{shortfall} Nothing was compacted — this chat still has its session."),
                    "sessionId": session.as_str(),
                    "job": self.job(session),
                }),
            );
        }
        let Some(handoff) = self
            .continuations()
            .attach_summary(&entry.token, text)
            .await
        else {
            let after = self.continuations().by_token(&entry.token);
            let retryable = after.is_some_and(|after| {
                &after.session_id == session && after.state == State::AwaitingSummary
            });
            let mut body = json!({ "error": "brief_not_stored" });
            if retryable {
                body["retryable"] = Value::Bool(true);
            }
            body["sessionId"] = json!(session.as_str());
            body["job"] = self.job(session);
            return Answer::new(if retryable { 503 } else { 409 }, body);
        };
        let command = self.queue_resume(session, &entry.token);
        let placement = self.inner.commands.deliver(Some(conversation));
        self.continuations().logger().info(&format!(
            "bridge: captured the compaction brief for {session}; opening the replacement chat"
        ));
        Answer::new(
            200,
            json!({
                "stored": true,
                "sessionId": session.as_str(),
                "handoffId": handoff.id,
                "commandId": command,
                "placement": placement,
                "job": self.job(session),
            }),
        )
    }

    /// `queueResumeCommand`.
    pub fn queue_resume(&self, session: &SessionId, token: &str) -> Option<String> {
        self.remember(session, token);
        self.inner.commands.queue(session, token)
    }

    /// The source checkpoints, each quoting chat A and the token.
    async fn source(&self, body: &Map<String, Value>, token: &str, id: &str) -> Option<Answer> {
        let continuations = self.continuations();
        let shapes = [
            "sourceLost",
            "sourceDispatch",
            "sourceUndelivered",
            "sourceAttempt",
        ];
        let shape = shapes
            .iter()
            .find(|key| flag(body, key))
            .copied()
            .or_else(|| {
                body.get("sourceMessageId")
                    .and_then(Value::as_str)
                    .map(|_| "sourceMessageId")
            })?;
        let Some(entry) = continuations
            .by_token(token)
            .filter(|entry| entry.from == id)
        else {
            return Some(Answer::error(409, "no_such_continuation"));
        };
        let session = entry.session_id.clone();
        Some(match shape {
            "sourceLost" => {
                let error = text(body, "sourceError")
                    .map(|error| crate::js::slice(crate::js::trim(error), 0, 500))
                    .filter(|error| !error.is_empty())
                    .unwrap_or_else(|| "handoff_never_sent".into());
                match continuations.abort_source_before_send(token, &error).await {
                    Err(failure) => {
                        continuations.logger().warn(&format!(
                            "bridge: could not durably abandon the unsent source handoff for {session} — {failure}"
                        ));
                        Answer::new(
                            503,
                            json!({
                                "error": "source_abort_not_durable", "retryable": true,
                                "sessionId": session.as_str(), "job": self.job(&session)
                            }),
                        )
                    }
                    Ok(false) => Answer::error(409, "source_send_not_releasable"),
                    Ok(true) => Answer::new(
                        200,
                        json!({
                            "aborted": true, "sessionId": session.as_str(), "job": self.job(&session)
                        }),
                    ),
                }
            }
            "sourceDispatch" => {
                match continuations
                    .dispatch_source_send(token, text(body, "before"))
                    .await
                {
                    Ok(true) => Answer::new(200, json!({ "armed": true })),
                    Ok(false) => Answer::error(409, "source_send_reclaimed"),
                    Err(_) => Answer::internal(),
                }
            }
            "sourceUndelivered" => {
                let since = body
                    .get("documentSince")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                match continuations
                    .release_undelivered_source(token, text(body, "newestUserMessage"), since)
                    .await
                {
                    Ok(Some(released)) => {
                        continuations.logger().info(&format!(
                            "bridge: the handoff click for {session} never reached ChatGPT; it may be sent once more"
                        ));
                        Answer::new(
                            200,
                            json!({
                                "released": true, "sourceSend": checkpoint_json(&released), "job": self.job(&session)
                            }),
                        )
                    }
                    Ok(None) => Answer::error(409, "source_send_not_releasable"),
                    Err(_) => Answer::internal(),
                }
            }
            "sourceAttempt" => {
                let project = body
                    .contains_key("project")
                    .then(|| body.get("project").and_then(Value::as_str));
                let project = project.map(|value| normalize_project_id(value));
                match continuations
                    .begin_source_send(token, project.as_ref().map(|value| value.as_deref()))
                    .await
                {
                    Ok(Some(claim)) => Answer::new(
                        200,
                        json!({
                            "allowed": claim.allowed, "sourceSend": checkpoint_json(&claim.checkpoint)
                        }),
                    ),
                    Ok(None) => Answer::error(409, "source_send_not_available"),
                    Err(_) => Answer::internal(),
                }
            }
            _ => {
                let anchor =
                    crate::js::slice(text(body, "sourceMessageId").unwrap_or_default(), 0, 200);
                let progress = body.get("sourceProgress").and_then(Value::as_f64);
                match continuations
                    .bind_source_message(token, &anchor, progress)
                    .await
                {
                    Ok(true) => {
                        Answer::new(200, json!({ "bound": true, "job": self.job(&session) }))
                    }
                    Ok(false) => Answer::error(409, "source_message_conflict"),
                    Err(_) => Answer::internal(),
                }
            }
        })
    }

    /// The destination fences. ChatGPT has not named chat B yet, so they are token-addressed
    /// and checked against the command leased to this page.
    async fn destination(&self, body: &Map<String, Value>, token: &str) -> Option<Answer> {
        let continuations = self.continuations();
        let shape = [
            "destinationAttempt",
            "destinationDispatch",
            "destinationLost",
        ]
        .into_iter()
        .find(|key| flag(body, key))?;
        let command = text(body, "commandId").unwrap_or_default();
        let owned = !command.is_empty()
            && self
                .inner
                .commands
                .leased_to(command, token, text(body, "client"))
            && continuations.claimed_by(token, command);
        Some(match shape {
            "destinationAttempt" => match owned {
                false => Answer::error(409, "destination_send_not_available"),
                true => match continuations.begin_destination_send(token).await {
                    Ok(Some(claim)) => Answer::new(
                        200,
                        json!({
                            "allowed": claim.allowed, "destinationSend": checkpoint_json(&claim.checkpoint)
                        }),
                    ),
                    Ok(None) => Answer::error(409, "destination_send_not_available"),
                    Err(_) => Answer::internal(),
                },
            },
            "destinationDispatch" => {
                let armed =
                    owned && continuations.dispatch_destination_send(token).await == Ok(true);
                if armed {
                    Answer::new(200, json!({ "armed": true }))
                } else {
                    Answer::error(409, "destination_send_reclaimed")
                }
            }
            _ => {
                let released =
                    owned && continuations.release_destination_send(token, None).await == Ok(true);
                if !released {
                    return Some(Answer::error(409, "destination_send_not_releasable"));
                }
                self.inner.commands.retire(
                    token,
                    "the page lost the brief before Send; nothing was sent",
                );
                let entry = continuations.by_token(token);
                if let Some(entry) = &entry {
                    self.queue_resume(&entry.session_id, token);
                    self.inner.commands.deliver(None);
                }
                continuations.logger().info(&format!(
                    "bridge: the brief for {} was lost before Send — offering it to a fresh chat",
                    entry.map_or_else(
                        || token.get(..8).unwrap_or(token).to_owned(),
                        |entry| entry.session_id.as_str().to_owned()
                    )
                ));
                Answer::new(200, json!({ "released": true }))
            }
        })
    }

    /// `destinationMessageId`: chat B's page reports the marked bootstrap; the commit follows.
    async fn marked_destination(
        &self,
        body: &Map<String, Value>,
        token: &str,
        id: &str,
    ) -> Option<Answer> {
        let message = text(body, "destinationMessageId")?;
        let continuations = self.continuations();
        let logger = continuations.logger();
        let notice = |outcome: &str| {
            logger.info(&format!(
                "bridge: marked replacement {id} ({}): {outcome}",
                token.get(..8).unwrap_or(token)
            ));
        };
        if continuations.by_token(token).is_none() {
            notice("unknown continuation");
            return Some(Answer::error(409, "no_such_continuation"));
        }
        let message = crate::js::slice(message, 0, 200);
        if continuations
            .bind_destination_message(token, id, &message)
            .await
            != Ok(true)
        {
            notice("destination message conflict");
            return Some(Answer::error(409, "destination_message_conflict"));
        }
        Some(match continuations.commit(token, id).await {
            CommitResult::Retryable(_) => {
                notice("commit pending after a retryable failure");
                Answer::new(
                    503,
                    json!({ "error": "resume_commit_retryable", "retryable": true }),
                )
            }
            CommitResult::Rejected(reason) => {
                notice("commit rejected");
                if self.abort_rejected(token, &reason).await {
                    self.inner.commands.retire(
                        token,
                        "the session layer refused the marked replacement message",
                    );
                }
                Answer::new(
                    409,
                    json!({ "error": "resume_commit_rejected", "message": reason }),
                )
            }
            CommitResult::Committed(to) | CommitResult::AlreadyCommitted(to) => {
                let command = continuations
                    .by_token(token)
                    .and_then(|entry| self.inner.commands.command(&entry.session_id))
                    .map(|command| command.id);
                self.inner.commands.retire(
                    token,
                    "the marked replacement message committed the continuation",
                );
                notice("committed");
                Answer::new(
                    200,
                    json!({
                        "committed": true, "conversationId": to, "commandId": command
                    }),
                )
            }
        })
    }

    /// `abortRejectedResume`: a refused commit is final; the session stays in chat A.
    pub async fn abort_rejected(&self, token: &str, reason: &str) -> bool {
        let Some(state) = self.continuations().by_token(token) else {
            return false;
        };
        if matches!(
            state.state,
            State::Committing | State::Committed | State::Aborted
        ) {
            return false;
        }
        match self.continuations().abort_now(token, reason).await {
            Ok(aborted) => aborted,
            Err(error) => {
                self.continuations().logger().warn(&format!(
                    "bridge: could not durably abort the refused resume {} — {error}",
                    state.session_id
                ));
                false
            }
        }
    }
}

impl Answer {
    /// What `handle()` answers when a route throws.
    pub fn internal() -> Self {
        Self::error(500, "internal")
    }
}
