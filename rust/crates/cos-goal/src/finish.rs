//! Goal at a held finish (`draftFastFollowup`): the one decision the finish owner asks for when
//! a turn calls `session_finish`. The finish owner keeps the hold, the retries, the progress rows
//! and the delivery; this answers only "what is the next instruction, if any".

use cos_types::config::{GoalBackend, GoalMode, GoalProviderKind};
use cos_types::ids::SessionId;
use cos_types::session::SessionEvent;

use crate::context::{ChatMessage, OutboxView, Role, conversation_messages};
use crate::decision::Decision;
use crate::errors::retryable;
use crate::provider::{self, Answer, REQUEST_TIMEOUT};
use crate::{BoxFuture, Goal, prompts, templates};

/// Why a finish follow-up could not be decided (`TaskRequestError`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FollowupFailure {
    pub error: String,
    /// The finish owner may ask again on its own clock.
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
}

impl FollowupFailure {
    fn settled(error: &str) -> Self {
        Self {
            error: error.to_owned(),
            retryable: false,
            retry_after_ms: None,
        }
    }

    /// `nativeGoalFailure`: only an API transport failure is worth asking again.
    fn native(error: String, backend: GoalBackend, retry_after_ms: Option<u64>) -> Self {
        let code = error.split(':').next().unwrap_or_default();
        let transient = code == "rate_limited"
            || code == "request_failed"
            || code == "timeout_or_cancelled"
            || code == "http_408"
            || code == "http_425"
            || (code.len() == 8
                && code.starts_with("http_5")
                && code[5..].bytes().all(|b| b.is_ascii_digit()));
        Self {
            retryable: backend == GoalBackend::Api && retryable(&error) && transient,
            error,
            retry_after_ms,
        }
    }
}

/// What the finish owner asks of Goal. `cos-core` hands the finish owner the [`Goal`] behind
/// this trait, so the finish crate needs no edge to this one beyond the port it declares.
pub trait FinishGoal: Send + Sync + 'static {
    /// `automaticFinishEnabled`: finish is another boundary of this chat's Goal/Loop.
    fn automatic(&self, conversation: &str) -> bool;
    /// The mode and objective a decision would run under, for the finish owner's revision hash.
    fn driving(&self, conversation: &str) -> (GoalMode, String);
    /// `draftFastFollowup`: `Ok(None)` means Goal found nothing left (or Loop has no MCP work
    /// to continue from). Dropping the future cancels the request.
    fn followup(
        &self,
        session: String,
        context: Option<Vec<ChatMessage>>,
        mode: GoalMode,
    ) -> BoxFuture<'static, Result<Option<String>, FollowupFailure>>;
}

impl FinishGoal for Goal {
    fn automatic(&self, conversation: &str) -> bool {
        self.switch_for(conversation).enabled
    }

    fn driving(&self, conversation: &str) -> (GoalMode, String) {
        (
            self.driving_mode(Some(conversation)),
            self.objective_for(conversation),
        )
    }

    fn followup(
        &self,
        session: String,
        context: Option<Vec<ChatMessage>>,
        mode: GoalMode,
    ) -> BoxFuture<'static, Result<Option<String>, FollowupFailure>> {
        let goal = self.clone();
        Box::pin(async move { goal.finish_followup(&session, context, mode).await })
    }
}

impl Goal {
    /// `draftFastFollowup(sessionId, signal, preparedMessages, publish, mode)`.
    pub async fn finish_followup(
        &self,
        session: &str,
        context: Option<Vec<ChatMessage>>,
        mode: GoalMode,
    ) -> Result<Option<String>, FollowupFailure> {
        let config = self.config();
        let backend = self.backend_for(mode);
        let endpoint = provider::endpoint(&config.goal, &self.shared().openrouter_base);
        let key = match backend {
            GoalBackend::Api => self.provider_key(endpoint.kind).await,
            _ => None,
        };
        if backend == GoalBackend::Api
            && key.is_none()
            && endpoint.kind == GoalProviderKind::Openrouter
        {
            return Err(FollowupFailure::settled(
                "Configure the Goal API key for automatic finish follow-ups, or choose Notify me",
            ));
        }
        let no_conversation =
            || FollowupFailure::settled("This session has no current conversation");
        let id = SessionId::parse(session).map_err(|_| no_conversation())?;
        let sessions = &self.shared().sessions;
        let summary = sessions.summary(&id).await.ok_or_else(no_conversation)?;
        let conversation = summary
            .conversation_id
            .clone()
            .ok_or_else(no_conversation)?;
        if mode == GoalMode::Loop {
            let start = sessions
                .recent_events(&id, 1, &["turn_start"])
                .await
                .unwrap_or_default()
                .pop()
                .and_then(|event| match event {
                    SessionEvent::TurnStart(start) => start.base.turn_id,
                    _ => None,
                });
            let source = summary.active_turn_id.clone().flatten().or(start);
            let Some(source) = source else {
                return Ok(None);
            };
            if !self
                .loop_has_mcp_work(session, &conversation, &source)
                .await
            {
                return Ok(None);
            }
        }
        let objective = self.objective_for(&conversation);
        let messages = match context {
            Some(messages) => messages,
            None => {
                let outbox = OutboxView {
                    automatic_ids: self.shared().chats.automatic_inputs(session).await,
                };
                conversation_messages(sessions, &id, &[], &outbox).await
            }
        };
        if objective.is_empty() && !messages.iter().any(|m| m.role == Role::User) {
            return Err(FollowupFailure::settled(
                "No recorded user request is available for Goal",
            ));
        }
        let prompt = match (mode, objective.is_empty()) {
            (GoalMode::Loop, _) => config.goal.loop_prompt.clone(),
            (GoalMode::Goal, false) => config.goal.objective_prompt.clone(),
            (GoalMode::Goal, true) => config.goal.prompt.clone(),
        };
        let answer = if backend == GoalBackend::Templates {
            let last = messages
                .iter()
                .rev()
                .find(|m| m.role == Role::Assistant)
                .map_or("", |m| m.content.as_str());
            Answer::Decision(templates::decision(
                last,
                crate::drafts::random_slot(200),
                crate::drafts::random_slot(200),
            ))
        } else {
            let mut system = vec![prompt];
            if !objective.is_empty() {
                system.push(prompts::objective_message(&objective));
            }
            let driving = crate::drafts::Driving {
                backend,
                endpoint,
                reasoning: config.goal.reasoning,
                key: key.unwrap_or_default(),
                model: config.goal.model.clone(),
                mode,
                source_session: Some(session.to_owned()),
                system,
                messages: if messages.is_empty() {
                    vec![ChatMessage::user(prompts::OPENING_TURN)]
                } else {
                    messages
                },
                trailer: prompts::trailer(mode, !objective.is_empty()),
            };
            let mut ignore = |_: &str| {};
            match tokio::time::timeout(REQUEST_TIMEOUT, self.request_driving(&driving, &mut ignore))
                .await
            {
                Err(_) => {
                    return Err(FollowupFailure::native(
                        "timeout_or_cancelled: Goal request timed out".to_owned(),
                        backend,
                        None,
                    ));
                }
                Ok(Err(detail)) => {
                    return Err(FollowupFailure::native(
                        format!("request_failed: {detail}"),
                        backend,
                        None,
                    ));
                }
                Ok(Ok(answer)) => answer,
            }
        };
        match answer {
            Answer::Decision(Decision::Continue(reply)) => Ok(Some(reply)),
            Answer::Decision(Decision::Stop) if mode == GoalMode::Loop => {
                Err(FollowupFailure::settled("loop_stop_refused"))
            }
            Answer::Decision(Decision::Stop) => Ok(None),
            Answer::Decision(Decision::Invalid(error)) => {
                Err(FollowupFailure::native(error, backend, None))
            }
            Answer::Refused {
                error,
                retry_after_ms,
            } => Err(FollowupFailure::native(error, backend, retry_after_ms)),
        }
    }
}
