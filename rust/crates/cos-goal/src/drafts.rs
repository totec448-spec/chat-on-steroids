//! One draft per finished turn (`startGoalDraft`, `run`, `ackGoalDraft`). A draft is keyed by
//! the turn it answers: a second request for the same turn is the same draft, so a retried
//! POST, a reloaded tab or two observers of one settle never put two messages into one chat.

use std::sync::Arc;

use tokio::sync::watch;

use cos_types::bridge::{GoalDraftView, GoalStage};
use cos_types::config::{GoalBackend, GoalMode, GoalProviderKind, GoalReasoning};

use crate::context::{ChatMessage, OutboxView, Role, conversation_messages};
use crate::decision::{self, Decision};
use crate::errors::{error_key, error_message, retryable};
use crate::provider::{self, Answer, ApiRequest, Endpoint, REQUEST_TIMEOUT};
use crate::{Goal, NotDurable, human, js, prompts, templates};

/// How long a finished draft stays available to the page that has to type it.
const DRAFT_TTL_MS: u64 = 10 * 60_000;
/// How many times one loop draft may be asked again after it tried to stop anyway.
const LOOP_ATTEMPTS: usize = 3;
/// `MAX_CHATGPT_MESSAGE_CHARS`: the browser's authored-message limit.
const MAX_CHATGPT_MESSAGE_CHARS: usize = 96_000;

/// A draft's cancellation: acknowledged, retired or superseded work stops its request.
#[derive(Clone)]
pub(crate) struct Abort(Arc<watch::Sender<bool>>);

impl Abort {
    fn new() -> Self {
        Self(Arc::new(watch::channel(false).0))
    }

    pub(crate) fn cancel(&self) {
        self.0.send_replace(true);
    }

    fn cancelled(&self) -> bool {
        *self.0.borrow()
    }

    async fn wait(&self) {
        let mut seen = self.0.subscribe();
        let _ = seen.wait_for(|cancelled| *cancelled).await;
    }
}

pub(crate) struct Draft {
    pub(crate) id: u64,
    pub(crate) token: String,
    pub(crate) conversation_id: String,
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) stage: GoalStage,
    pub(crate) backend: GoalBackend,
    pub(crate) model: String,
    pub(crate) text: String,
    pub(crate) reply: String,
    pub(crate) error: Option<String>,
    endpoint: Endpoint,
    reasoning: GoalReasoning,
    system_prompt: String,
    objective_system_prompt: String,
    loop_system_prompt: String,
    /// The mode a draft was born in is the mode it finishes.
    mode: GoalMode,
    objective: String,
    pub(crate) client_id: String,
    settled_at: u64,
    pub(crate) acknowledged: bool,
    working: bool,
    pub(crate) abort: Abort,
}

fn view(draft: &Draft) -> GoalDraftView {
    let error = draft.error.clone();
    GoalDraftView {
        token: draft.token.clone(),
        conversation_id: draft.conversation_id.clone(),
        turn_id: draft.turn_id.clone(),
        stage: draft.stage,
        backend: draft.backend,
        model: draft.model.clone(),
        text: draft.text.clone(),
        reply: if draft.stage == GoalStage::Ready && !draft.acknowledged {
            draft.reply.clone()
        } else {
            String::new()
        },
        message: error.as_deref().map(error_message),
        message_key: error.as_deref().map(|e| error_key(e).map(str::to_owned)),
        retryable: draft.stage == GoalStage::Failed
            && retryable(draft.error.as_deref().unwrap_or("")),
        error,
    }
}

/// A failure nothing will fix on its own stays the chat's Goal state until a newer draft.
fn settled_failure(draft: &Draft) -> bool {
    draft.stage == GoalStage::Failed && draft.error.as_deref().is_some_and(|e| !retryable(e))
}

/// The TTL is for the payload, not the idempotency key: a spent draft stays a tombstone.
fn expire_payload(draft: &mut Draft, now: u64) {
    if draft.settled_at == 0 || now.saturating_sub(draft.settled_at) <= DRAFT_TTL_MS {
        return;
    }
    draft.acknowledged = true;
    if settled_failure(draft) {
        return;
    }
    draft.text.clear();
    draft.reply.clear();
    draft.error = None;
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

pub(crate) fn random_slot(range: u64) -> u64 {
    let mut bytes = [0u8; 8];
    if getrandom::getrandom(&mut bytes).is_err() {
        return 0;
    }
    u64::from_le_bytes(bytes) % range
}

fn token(now: u64) -> String {
    let mut bytes = [0u8; 8];
    let _ = getrandom::getrandom(&mut bytes);
    let tail: String = bytes
        .iter()
        .map(|b| char::from(b"0123456789abcdefghijklmnopqrstuvwxyz"[usize::from(*b) % 36]))
        .collect();
    format!("goal-{}-{tail}", base36(now))
}

/// `StartGoalDraftInput`.
#[derive(Clone, Debug, Default)]
pub struct DraftStart {
    pub session_id: String,
    pub conversation_id: String,
    /// The generation whose answer triggered this: the draft's identity.
    pub turn_id: String,
    /// The browser tab that owns the right to type and acknowledge this draft.
    pub client_id: String,
    /// Reserve the owner while its durable reply obligation is committed.
    pub defer_start: bool,
}

/// Another tab is already handling this chat's unspent draft.
#[derive(Debug, PartialEq, Eq)]
pub struct OwnedElsewhere;

/// Why an opening message could not be drafted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpeningFailure {
    pub error: String,
    pub retryable: Option<bool>,
    pub retry_after_ms: Option<u64>,
}

/// One decision request, frozen from the draft or the caller.
pub(crate) struct Driving {
    pub(crate) backend: GoalBackend,
    pub(crate) endpoint: Endpoint,
    pub(crate) reasoning: GoalReasoning,
    pub(crate) key: String,
    pub(crate) model: String,
    pub(crate) mode: GoalMode,
    pub(crate) source_session: Option<String>,
    pub(crate) system: Vec<String>,
    pub(crate) messages: Vec<ChatMessage>,
    pub(crate) trailer: String,
}

/// A thrown failure, as `run` classifies it.
enum Thrown {
    Cancelled,
    Failed(String),
}

impl Goal {
    fn spent(&self, conversation: &str, id: u64) -> bool {
        self.lock()
            .drafts
            .get(conversation)
            .is_none_or(|draft| draft.id != id || draft.acknowledged)
    }

    /// `goalViewFor`: what the page should be told about this chat right now.
    pub fn view_for(&self, conversation: &str, client: Option<&str>) -> Option<GoalDraftView> {
        let now = self.now();
        let mut state = self.lock();
        let draft = state.drafts.get_mut(conversation)?;
        expire_payload(draft, now);
        if client.is_some_and(|client| draft.client_id != client) {
            return None;
        }
        if draft.acknowledged && !settled_failure(draft) {
            return None;
        }
        Some(view(draft))
    }

    /// `goalOutcomeFor`: an acknowledged "goal met", until a newer turn replaces it.
    pub fn outcome_for(&self, conversation: &str) -> Option<GoalDraftView> {
        let state = self.lock();
        let draft = state.drafts.get(conversation)?;
        (draft.acknowledged && draft.stage == GoalStage::NoReply).then(|| view(draft))
    }

    /// `goalDraftBusy`: a request is in flight for this chat.
    pub fn draft_busy(&self, conversation: &str) -> bool {
        self.lock().drafts.get(conversation).is_some_and(|draft| {
            !draft.acknowledged && matches!(draft.stage, GoalStage::Sending | GoalStage::Answering)
        })
    }

    /// `goalDraftNeedsIntervention`: reloading cannot repair a settled settings refusal.
    pub fn draft_needs_intervention(&self, conversation: &str) -> bool {
        let state = self.lock();
        let Some(draft) = state.drafts.get(conversation) else {
            return false;
        };
        draft.stage == GoalStage::Failed
            && state.replies.get(conversation).map(|r| r.turn_id.as_str())
                == Some(draft.turn_id.as_str())
            && !retryable(draft.error.as_deref().unwrap_or(""))
    }

    /// `startGoalDraft`: one draft for one finished turn, or the one that already exists.
    pub fn start_draft(&self, input: DraftStart) -> Result<GoalDraftView, OwnedElsewhere> {
        let config = self.config();
        let mode = self.driving_mode(Some(&input.conversation_id));
        let backend = self.backend_for(mode);
        let objective = self.objective_for(&input.conversation_id);
        let model = match backend {
            GoalBackend::Chatgpt => self.helper_label(&config),
            _ => config.goal.model.clone(),
        };
        let now = self.now();
        let (started, defer) = {
            let mut state = self.lock();
            if let Some(existing) = state.drafts.get_mut(&input.conversation_id) {
                expire_payload(existing, now);
                if !existing.acknowledged && existing.client_id != input.client_id {
                    return Err(OwnedElsewhere);
                }
                let spent_failure = existing.stage == GoalStage::Failed
                    && existing.acknowledged
                    && retryable(existing.error.as_deref().unwrap_or(""));
                if existing.turn_id == input.turn_id && !spent_failure {
                    return Ok(view(existing));
                }
                existing.abort.cancel();
                state.drafts.remove(&input.conversation_id);
            }
            state.next_draft += 1;
            let draft = Draft {
                id: state.next_draft,
                token: token(now),
                conversation_id: input.conversation_id.clone(),
                session_id: input.session_id.clone(),
                turn_id: input.turn_id.clone(),
                stage: GoalStage::Sending,
                backend,
                model,
                text: String::new(),
                reply: String::new(),
                error: None,
                endpoint: provider::endpoint(&config.goal, &self.shared().openrouter_base),
                reasoning: config.goal.reasoning,
                system_prompt: config.goal.prompt.clone(),
                objective_system_prompt: config.goal.objective_prompt.clone(),
                loop_system_prompt: config.goal.loop_prompt.clone(),
                mode,
                objective,
                client_id: input.client_id.clone(),
                settled_at: 0,
                acknowledged: false,
                working: false,
                abort: Abort::new(),
            };
            let shown = view(&draft);
            let token = draft.token.clone();
            state.drafts.insert(input.conversation_id.clone(), draft);
            let defer: Option<String> = (!input.defer_start).then_some(token);
            (shown, defer)
        };
        self.notify();
        if let Some(token) = defer {
            self.begin_draft(&input.conversation_id, &token);
        }
        Ok(started)
    }

    /// `beginGoalDraft`: provider work starts once the reserved turn is durable.
    pub fn begin_draft(&self, conversation: &str, token: &str) -> bool {
        let id = {
            let mut state = self.lock();
            let Some(draft) = state.drafts.get_mut(conversation) else {
                return false;
            };
            if draft.token != token || draft.acknowledged || draft.working {
                return false;
            }
            draft.working = true;
            draft.id
        };
        let goal = self.clone();
        let conversation = conversation.to_owned();
        tokio::spawn(async move { goal.run(&conversation, id).await });
        true
    }

    /// `discardPreparedGoalDraft`: a reservation whose durable commit failed.
    pub fn discard_prepared(&self, conversation: &str, token: &str) -> bool {
        let mut state = self.lock();
        let prepared = state
            .drafts
            .get(conversation)
            .is_some_and(|draft| draft.token == token && !draft.working);
        if prepared {
            state.drafts.remove(conversation);
        }
        prepared
    }

    /// `ackGoalDraft`: this draft is spent. Only a typed message or "goal met" discharges
    /// the turn it was owed for.
    pub fn ack_draft(&self, conversation: &str, token: &str, client: Option<&str>) -> bool {
        let now = self.now();
        let decided = {
            let mut state = self.lock();
            let Some(draft) = state.drafts.get_mut(conversation) else {
                return false;
            };
            if draft.token != token || client.is_some_and(|client| draft.client_id != client) {
                return false;
            }
            draft.acknowledged = true;
            draft.abort.cancel();
            if draft.settled_at == 0 {
                draft.settled_at = now;
            }
            matches!(draft.stage, GoalStage::Ready | GoalStage::NoReply)
                .then(|| draft.turn_id.clone())
        };
        if let Some(turn) = decided {
            self.handle_reply(conversation, Some(&turn));
        }
        self.notify();
        true
    }

    /// `ackGoalDraftNow`: the browser's ACK is not successful until the tombstone is durable.
    pub async fn ack_draft_now(
        &self,
        conversation: &str,
        token: &str,
        client: Option<&str>,
    ) -> Result<bool, NotDurable> {
        let acknowledged = self.ack_draft(conversation, token, client);
        if acknowledged {
            self.commit_replies().await?;
        }
        Ok(acknowledged)
    }

    /// `retireGoalDrafts`: attempts made under replaced settings are revoked; only an explicit
    /// master Off also discharges every owed reply.
    pub fn retire_drafts(&self, retire_replies: bool) -> usize {
        let now = self.now();
        let (retired, any_replies) = {
            let mut state = self.lock();
            let mut retired = 0;
            for draft in state.drafts.values_mut() {
                if draft.acknowledged {
                    continue;
                }
                draft.acknowledged = true;
                draft.abort.cancel();
                if draft.settled_at == 0 {
                    draft.settled_at = now;
                }
                retired += 1;
            }
            state.drafts.clear();
            if retire_replies {
                for reply in state.replies.values_mut() {
                    reply.state = cos_types::state::GoalReplyState::Handled;
                }
            }
            (retired, !state.replies.is_empty())
        };
        if retire_replies && any_replies {
            self.persist_replies_soon();
        }
        retired
    }

    /// Spends and forgets this chat's draft. Answers whether there was one.
    pub(crate) fn discard_draft(&self, conversation: &str) -> bool {
        let now = self.now();
        let mut state = self.lock();
        let Some(mut draft) = state.drafts.remove(conversation) else {
            return false;
        };
        draft.acknowledged = true;
        draft.abort.cancel();
        if draft.settled_at == 0 {
            draft.settled_at = now;
        }
        true
    }

    /// `retireGoalDraftsFor`: what one chat has in flight, leaving every other chat alone.
    pub fn retire_drafts_for(&self, conversation: &str) -> bool {
        let now = self.now();
        let (live, pending) = {
            let mut state = self.lock();
            let pending = state
                .replies
                .get(conversation)
                .is_some_and(|reply| reply.state == cos_types::state::GoalReplyState::Pending);
            let live = match state.drafts.get_mut(conversation) {
                Some(draft) if !draft.acknowledged => {
                    draft.acknowledged = true;
                    draft.abort.cancel();
                    if draft.settled_at == 0 {
                        draft.settled_at = now;
                    }
                    draft.text.clear();
                    draft.reply.clear();
                    true
                }
                _ => false,
            };
            (live, pending)
        };
        if !live {
            if pending {
                self.handle_reply(conversation, None);
            }
            return pending;
        }
        self.handle_reply(conversation, None);
        self.notify();
        true
    }

    /// `settle`: a superseded draft can never publish into the one that replaced it.
    fn settle(
        &self,
        conversation: &str,
        id: u64,
        stage: GoalStage,
        error: Option<String>,
        reply: Option<String>,
    ) {
        let now = self.now();
        let turn = {
            let mut state = self.lock();
            let Some(draft) = state
                .drafts
                .get_mut(conversation)
                .filter(|draft| draft.id == id)
            else {
                return;
            };
            draft.stage = stage;
            draft.error = error;
            if let Some(reply) = reply {
                draft.reply = reply;
            }
            draft.settled_at = now;
            draft.turn_id.clone()
        };
        // "Goal met" is a decision with nothing to type: it discharges the turn here.
        if stage == GoalStage::NoReply {
            self.handle_reply(conversation, Some(&turn));
        }
        self.notify();
    }

    fn publish(&self, conversation: &str, id: u64, text: &str) {
        {
            let mut state = self.lock();
            let Some(draft) = state
                .drafts
                .get_mut(conversation)
                .filter(|draft| draft.id == id)
            else {
                return;
            };
            draft.stage = GoalStage::Answering;
            draft.text = text.to_owned();
        }
        self.notify();
    }

    async fn outbox_view(&self, session: &str) -> OutboxView {
        OutboxView {
            automatic_ids: self.shared().chats.automatic_inputs(session).await,
        }
    }

    async fn run(&self, conversation: &str, id: u64) {
        let frozen = {
            let state = self.lock();
            state
                .drafts
                .get(conversation)
                .filter(|draft| draft.id == id)
                .map(|draft| {
                    (
                        draft.session_id.clone(),
                        draft.turn_id.clone(),
                        draft.backend,
                        draft.mode,
                        draft.endpoint.clone(),
                        draft.reasoning,
                        draft.model.clone(),
                        draft.objective.clone(),
                        match (draft.mode, draft.objective.is_empty()) {
                            (GoalMode::Loop, _) => draft.loop_system_prompt.clone(),
                            (GoalMode::Goal, false) => draft.objective_system_prompt.clone(),
                            (GoalMode::Goal, true) => draft.system_prompt.clone(),
                        },
                        draft.abort.clone(),
                    )
                })
        };
        let Some((
            session,
            turn,
            backend,
            mode,
            endpoint,
            reasoning,
            model,
            objective,
            prompt,
            abort,
        )) = frozen
        else {
            return;
        };
        if self.finish_only(&session, conversation).await {
            return self.settle(conversation, id, GoalStage::NoReply, None, None);
        }
        if mode == GoalMode::Loop
            && !self
                .loop_reply_has_authority(&session, conversation, &turn)
                .await
        {
            return self.settle(conversation, id, GoalStage::NoReply, None, None);
        }
        let key = match backend {
            GoalBackend::Api => self.provider_key(endpoint.kind).await,
            _ => None,
        };
        if self.spent(conversation, id) {
            return;
        }
        if backend == GoalBackend::Api
            && key.is_none()
            && endpoint.kind == GoalProviderKind::Openrouter
        {
            return self.settle(
                conversation,
                id,
                GoalStage::Failed,
                Some("no_api_key".to_owned()),
                None,
            );
        }
        let messages = match cos_types::ids::SessionId::parse(&session) {
            Ok(session_id) => {
                let outbox = self.outbox_view(&session).await;
                conversation_messages(&self.shared().sessions, &session_id, &[], &outbox).await
            }
            Err(_) => Vec::new(),
        };
        if self.spent(conversation, id) {
            return;
        }
        if objective.is_empty() && !messages.iter().any(|m| m.role == Role::User) {
            return self.settle(
                conversation,
                id,
                GoalStage::Failed,
                Some("no_conversation".to_owned()),
                None,
            );
        }
        let last_answer = messages
            .iter()
            .rev()
            .find(|m| m.role == Role::Assistant)
            .map(|m| m.content.clone())
            .unwrap_or_default();
        let mut system = vec![prompt];
        if !objective.is_empty() {
            system.push(prompts::objective_message(&objective));
        }
        let driving = Driving {
            backend,
            endpoint,
            reasoning,
            key: key.unwrap_or_default(),
            model: model.clone(),
            mode,
            source_session: Some(session.clone()),
            system,
            messages: if messages.is_empty() {
                vec![ChatMessage::user(prompts::OPENING_TURN)]
            } else {
                messages
            },
            trailer: prompts::trailer(mode, !objective.is_empty()),
        };
        let decided = if backend == GoalBackend::Templates {
            Ok(Answer::Decision(templates::decision(
                &last_answer,
                random_slot(200),
                random_slot(200),
            )))
        } else {
            let publish_goal = self.clone();
            let publish_conversation = conversation.to_owned();
            let mut publish =
                move |text: &str| publish_goal.publish(&publish_conversation, id, text);
            let work = self.request_driving(&driving, &mut publish);
            tokio::select! {
                answer = tokio::time::timeout(REQUEST_TIMEOUT, work) => match answer {
                    Ok(Ok(answer)) => Ok(answer),
                    Ok(Err(detail)) => Err(Thrown::Failed(detail)),
                    Err(_) => Err(Thrown::Cancelled),
                },
                () = abort.wait() => Err(Thrown::Cancelled),
            }
        };
        let logger = &self.shared().logger;
        let decision = match decided {
            Err(thrown) => {
                let failure = match thrown {
                    Thrown::Cancelled => "timeout_or_cancelled".to_owned(),
                    Thrown::Failed(detail) if abort.cancelled() => {
                        let _ = detail;
                        "timeout_or_cancelled".to_owned()
                    }
                    Thrown::Failed(detail)
                        if detail == "reply_too_long"
                            || detail == "stream_record_too_long"
                            || detail.starts_with("goal_browser_") =>
                    {
                        detail
                    }
                    Thrown::Failed(detail) => format!("request_failed: {detail}"),
                };
                logger.warn(&format!(
                    "goal: draft for {conversation} failed — {failure}"
                ));
                return self.settle(conversation, id, GoalStage::Failed, Some(failure), None);
            }
            Ok(answer) => answer,
        };
        if self.spent(conversation, id) {
            return;
        }
        if self.finish_only(&session, conversation).await {
            return self.settle(conversation, id, GoalStage::NoReply, None, None);
        }
        match decision {
            Answer::Refused { error, .. } | Answer::Decision(Decision::Invalid(error)) => {
                logger.warn(&format!("goal: draft for {conversation} failed — {error}"));
                self.settle(conversation, id, GoalStage::Failed, Some(error), None);
            }
            Answer::Decision(Decision::Stop) if mode == GoalMode::Loop => {
                logger.warn(&format!(
                    "goal: the loop would not write a message in {conversation} with {model}"
                ));
                self.settle(
                    conversation,
                    id,
                    GoalStage::Failed,
                    Some("loop_stop_refused".to_owned()),
                    None,
                );
            }
            Answer::Decision(Decision::Stop) => {
                logger.info(&format!(
                    "goal: {model} says the goal is met in {conversation}; nothing was sent"
                ));
                self.settle(
                    conversation,
                    id,
                    GoalStage::NoReply,
                    None,
                    Some(String::new()),
                );
            }
            Answer::Decision(Decision::Continue(reply)) => {
                let typed = if backend == GoalBackend::Templates {
                    let body = reply
                        .strip_suffix(templates::MARKER_INSTRUCTION)
                        .unwrap_or(&reply);
                    format!(
                        "{}{}",
                        human::human_reply(body),
                        templates::MARKER_INSTRUCTION
                    )
                } else {
                    human::human_reply(&reply)
                };
                logger.info(&format!(
                    "goal: drafted {} characters for {conversation} with {model}",
                    js::len(&reply)
                ));
                self.settle(conversation, id, GoalStage::Ready, None, Some(typed));
            }
        }
    }

    /// `requestDrivingDecision`: Loop asks again when the model tried to stop anyway.
    pub(crate) async fn request_driving(
        &self,
        driving: &Driving,
        publish: &mut (dyn FnMut(&str) + Send),
    ) -> Result<Answer, String> {
        let mut answer = self.request_decision(driving, &[], &mut *publish).await?;
        if driving.mode != GoalMode::Loop {
            return Ok(answer);
        }
        let mut attempt = 1;
        while attempt < LOOP_ATTEMPTS && answer == Answer::Decision(Decision::Stop) {
            self.shared().logger.warn(&format!(
                "goal: the loop tried to stop with {}; asking again ({attempt}/{})",
                driving.model,
                LOOP_ATTEMPTS - 1
            ));
            answer = self
                .request_decision(
                    driving,
                    &[prompts::LOOP_STOP_REFUSED.to_owned()],
                    &mut *publish,
                )
                .await?;
            attempt += 1;
        }
        Ok(answer)
    }

    /// `requestGoalDecision`: one request, one answer, including "no usable answer".
    async fn request_decision(
        &self,
        driving: &Driving,
        extra_system: &[String],
        publish: &mut (dyn FnMut(&str) + Send),
    ) -> Result<Answer, String> {
        let mut system = driving.system.clone();
        system.extend_from_slice(extra_system);
        let logger = self.shared().logger.clone();
        let mut unreadable = move |sample: String| {
            logger.warn(&format!(
                "goal: the structured decision was not JSON — {sample}"
            ));
        };
        if driving.backend == GoalBackend::Chatgpt {
            let prompt =
                render_for_chatgpt(&system, driving.mode, &driving.messages, &driving.trailer)?;
            let text = self
                .shared()
                .helper
                .decide(prompt, driving.source_session.clone())
                .await?;
            return Ok(Answer::Decision(decision::normalize(
                &text,
                false,
                &mut unreadable,
            )));
        }
        let request = ApiRequest {
            endpoint: &driving.endpoint,
            key: &driving.key,
            model: &driving.model,
            mode: driving.mode,
            reasoning: driving.reasoning,
            planner: false,
            system: &system,
            messages: &driving.messages,
            trailer: &driving.trailer,
        };
        provider::request(
            &self.shared().http,
            &request,
            Some(publish),
            &mut unreadable,
        )
        .await
    }

    /// `draftOpeningMessage`: the opening message for a chat that has no id yet. Not
    /// idempotent: there is nothing to key it to. The page holds that end.
    pub async fn draft_opening(
        &self,
        objective: &str,
        named: Option<GoalMode>,
    ) -> Result<(String, String), OpeningFailure> {
        let goal = js::trim(objective).to_owned();
        let fail = |error: &str, retry: Option<bool>| OpeningFailure {
            error: error.to_owned(),
            retryable: retry,
            retry_after_ms: None,
        };
        if goal.is_empty() {
            return Err(fail("no_objective", None));
        }
        let config = self.config();
        let mode = named.unwrap_or_else(|| self.driving_mode(None));
        let backend = self.backend_for(mode);
        if backend == GoalBackend::Templates {
            return Ok((
                format!("{goal}{}", templates::MARKER_INSTRUCTION),
                "Offline Goal".to_owned(),
            ));
        }
        let endpoint = provider::endpoint(&config.goal, &self.shared().openrouter_base);
        let key = match backend {
            GoalBackend::Api => self.provider_key(endpoint.kind).await,
            _ => None,
        };
        if backend == GoalBackend::Api
            && key.is_none()
            && endpoint.kind == GoalProviderKind::Openrouter
        {
            return Err(fail("no_api_key", None));
        }
        let model = match backend {
            GoalBackend::Chatgpt => self.helper_label(&config),
            _ => config.goal.model.clone(),
        };
        let prompt = match mode {
            GoalMode::Loop => config.goal.loop_prompt.clone(),
            GoalMode::Goal => config.goal.objective_prompt.clone(),
        };
        let driving = Driving {
            backend,
            endpoint,
            reasoning: config.goal.reasoning,
            key: key.unwrap_or_default(),
            model: model.clone(),
            mode,
            source_session: None,
            system: vec![prompt, prompts::objective_message(&goal)],
            messages: vec![ChatMessage::user(prompts::OPENING_TURN)],
            trailer: prompts::trailer(mode, true),
        };
        let mut ignore = |_: &str| {};
        let answer =
            tokio::time::timeout(REQUEST_TIMEOUT, self.request_driving(&driving, &mut ignore))
                .await;
        let answer = match answer {
            Err(_) => {
                return Err(fail(
                    "timeout_or_cancelled",
                    Some(retryable("timeout_or_cancelled")),
                ));
            }
            Ok(Err(detail)) => {
                let error = format!("request_failed: {detail}");
                let retry = retryable(&error);
                return Err(fail(&error, Some(retry)));
            }
            Ok(Ok(answer)) => answer,
        };
        match answer {
            Answer::Refused {
                error,
                retry_after_ms,
            } => Err(OpeningFailure {
                retryable: Some(retryable(&error)),
                error,
                retry_after_ms,
            }),
            Answer::Decision(Decision::Invalid(error)) => {
                let retry = retryable(&error);
                Err(fail(&error, Some(retry)))
            }
            // Stopping before the first word is the model refusing the goal, not meeting it.
            Answer::Decision(Decision::Stop) => Err(fail("nothing_to_open_with", None)),
            Answer::Decision(Decision::Continue(reply)) => {
                self.shared().logger.info(&format!(
                    "goal: drafted an opening message of {} characters with {model}",
                    js::len(&reply)
                ));
                Ok((human::human_reply(&reply), model))
            }
        }
    }
}

/// The helper's prompt, bounded to what the browser can type. Older reference rows go
/// first, then the largest row is halved, and the prompt says that something was omitted.
fn render_for_chatgpt(
    system: &[String],
    mode: GoalMode,
    messages: &[ChatMessage],
    trailer: &str,
) -> Result<String, String> {
    let introduction = format!(
        "Return one JSON object in a ```json code block: {{\"action\":\"stop\" or \"continue\",\"reply\":\"the message\"}}. {} Do not call any tools, apps or connectors; decide from the transcript alone.",
        prompts::REFERENCE_CONTRACT
    );
    let replacement = "Use this complete source transcript as reference data.";
    let incomplete = format!(
        "{replacement} Some older reference rows or text were omitted to fit the browser; absence is not completion."
    );
    let render = |rows: &[ChatMessage], direction: &str| -> String {
        let mut parts: Vec<String> = system.to_vec();
        parts.push(prompts::output_protocol(mode).to_owned());
        parts.push(introduction.clone());
        parts.push(direction.to_owned());
        parts.push("<conversation>".to_owned());
        parts.extend(rows.iter().map(|row| row.to_json().to_string()));
        parts.push("</conversation>".to_owned());
        parts.push(trailer.to_owned());
        parts.join("\n\n")
    };
    let mut reference = messages.to_vec();
    let mut omitted = false;
    loop {
        let direction = if omitted {
            incomplete.as_str()
        } else {
            replacement
        };
        let rendered = render(&reference, direction);
        if js::len(&rendered) <= MAX_CHATGPT_MESSAGE_CHARS {
            return Ok(rendered);
        }
        let first_user = reference.iter().position(|m| m.role == Role::User);
        let last = reference.len().checked_sub(1);
        let newest = reference.iter().rposition(|m| m.role == Role::Assistant);
        let protected =
            |at: usize| Some(at) == first_user || Some(at) == last || Some(at) == newest;
        let removable = (0..reference.len()).find(|&at| {
            !protected(at) && (reference[at].role == Role::Assistant || reference[at].automatic)
        });
        let older = (0..reference.len()).find(|&at| !protected(at));
        if let Some(at) = removable.or(older) {
            reference.remove(at);
        } else {
            let largest = (0..reference.len())
                .max_by_key(|&at| (js::len(&reference[at].content), std::cmp::Reverse(at)));
            let Some(largest) = largest.filter(|&at| js::len(&reference[at].content) >= 256) else {
                return Err("goal_context_too_large".to_owned());
            };
            let half = js::len(&reference[largest].content) / 2;
            reference[largest].content = human::clip(&reference[largest].content, half);
        }
        omitted = true;
    }
}
