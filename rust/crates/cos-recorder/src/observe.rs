//! Page observations into session events (`sessionForConversation`, `recordRequestEvidence`,
//! `recordChatObservationsNow` and `closeConversation` in `src/main/session/recorder.ts`).

use std::collections::{HashMap, HashSet};

use cos_sessions::UpsertOptions;
use cos_tools::EpochMs;
use cos_types::bridge::{ObservationKind, PageObservation, PageTraceItem};
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{
    AssistantMessageEvent, AutoTitleSource, ChatErrorEvent, ChatErrorReason, EventBase,
    EventSource, MessageState, NoteEvent, PageToolEvent, SessionEvent, SessionStartEvent,
    TurnEndEvent, TurnEndReason, TurnOutcome, TurnStartEvent, UserMessageEvent,
};
use cos_types::state::RequestCorrelation;

use crate::parse::js_slice;
use crate::{Recorder, lock, millis};

const DEFAULT_TITLE: &str = "ChatGPT session";
const MAX_USER_MESSAGE_CHARS: usize = 256_000;
const MAX_ASSISTANT_CHARS: usize = 256_000;
const MAX_RENDERED_HTML_CHARS: usize = 120_000;
/// A session closed for less than this reopens without a log line.
const REOPEN_NOTICE_MS: u64 = 60_000;

/// One visible ChatGPT-native activity row, by the page's stable row identity.
#[derive(Clone, Debug)]
struct PageToolRecord {
    seq: u64,
    time: u64,
    text: String,
    turn_id: Option<String>,
    content_seq: Option<u64>,
}

/// What this process knows about a conversation a page is reporting (`LiveConversation`).
/// Turn lifecycle here is presentation and recovery state only, never ownership evidence.
#[derive(Clone, Debug)]
pub(crate) struct LiveConversation {
    pub(crate) session_id: SessionId,
    turn_started_at: Option<u64>,
    turn_id: Option<String>,
    /// Turns this log started and has not ended.
    open_turns: HashSet<String>,
    known_turn_starts: HashSet<String>,
    known_turn_ends: HashSet<String>,
    last_turn_outcome: Option<TurnOutcome>,
    last_turn_started_at: Option<u64>,
    page_tools: HashMap<String, PageToolRecord>,
}

impl LiveConversation {
    pub(crate) fn fresh(session_id: SessionId) -> Self {
        Self {
            session_id,
            turn_started_at: None,
            turn_id: None,
            open_turns: HashSet::new(),
            known_turn_starts: HashSet::new(),
            known_turn_ends: HashSet::new(),
            last_turn_outcome: None,
            last_turn_started_at: None,
            page_tools: HashMap::new(),
        }
    }

    /// This chat as `liveConversations()` reports it to `/status`.
    pub(crate) fn wire(&self, conversation: &str) -> cos_types::bridge::LiveConversation {
        let generating = self.turn_started_at.is_some();
        cos_types::bridge::LiveConversation {
            conversation_id: conversation.to_owned(),
            session_id: self.session_id.as_str().to_owned(),
            generating,
            active_turn_id: self.turn_id.clone().filter(|_| generating),
            active_turn_started_at: self.turn_started_at,
            ended_turns: self.known_turn_ends.len() as u64,
            last_turn_outcome: self.last_turn_outcome,
        }
    }
}

/// An observation of `kind` at `time` with nothing else set.
pub(crate) fn observation(kind: ObservationKind, time: f64) -> PageObservation {
    crate::parse::empty_observation(kind, time)
}

/// `pageToolKey`: one native thought row under either of ChatGPT's two renderers.
fn page_tool_key(id: &str) -> String {
    id.strip_prefix("thought-")
        .and_then(|rest| rest.strip_suffix("-0"))
        .filter(|inner| !inner.is_empty())
        .map_or_else(|| id.to_owned(), str::to_owned)
}

fn base(item: &PageObservation, agent: Option<&str>) -> EventBase {
    EventBase {
        model: None,
        reasoning_effort: None,
        seq: 0,
        time: millis(item.time),
        authored_at: item.authored_at,
        turn_origin: None,
        source: EventSource::Extension,
        agent: agent.map(str::to_owned),
        turn_id: item.turn_id.clone(),
    }
}

/// `chatErrorMessageKey`.
fn chat_error_key(text: &str, recoverable: bool) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if !recoverable {
        return normalized;
    }
    let lower = normalized.to_ascii_lowercase();
    for suffix in [" retry.", " retry"] {
        if lower.ends_with(suffix) {
            return normalized[..normalized.len() - suffix.len()]
                .trim_end()
                .to_owned();
        }
    }
    normalized
}

/// `userTitle` for an observed first message, before the store refines it.
fn observed_user_title(first: Option<&str>) -> Option<String> {
    let first = first?;
    let title = js_slice(first.trim(), 80).trim().to_owned();
    (!title.is_empty()).then_some(title)
}

/// `observationTitle`: the page's title, else the first user message.
fn observation_title(observations: &[PageObservation]) -> Option<String> {
    let page = observations
        .iter()
        .find(|item| item.kind == ObservationKind::ConversationTitle)
        .and_then(|item| item.text.as_deref())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned);
    page.or_else(|| {
        observed_user_title(
            observations
                .iter()
                .find(|item| item.kind == ObservationKind::UserMessage)
                .and_then(|item| item.text.as_deref()),
        )
    })
}

impl Recorder {
    /// `storedHistory`: what a session's own log says, for a conversation picked up again.
    async fn stored_history(&self, session: &SessionId) -> LiveConversation {
        let mut live = LiveConversation::fresh(session.clone());
        let mut events = match self
            .inner
            .sessions
            .recent_events(session, 4096, &["turn_start", "turn_end", "page_tool"])
            .await
        {
            Ok(events) => events,
            Err(error) => {
                self.inner
                    .logger
                    .warn(&format!("could not read stored session history: {error}"));
                return live;
            }
        };
        events.sort_by_key(|event| event.base().seq);
        let mut last_ended_at: Option<u64> = None;
        let mut starts: HashMap<String, u64> = HashMap::new();
        for event in events {
            match event {
                SessionEvent::TurnStart(start) => {
                    if let Some(turn) = start.base.turn_id {
                        live.known_turn_starts.insert(turn.clone());
                        live.known_turn_ends.remove(&turn);
                        live.open_turns.insert(turn.clone());
                        starts.insert(turn.clone(), start.base.time);
                        live.turn_id = Some(turn);
                        live.turn_started_at = Some(start.base.time);
                    }
                }
                SessionEvent::TurnEnd(end) => {
                    if let Some(turn) = &end.base.turn_id {
                        live.known_turn_ends.insert(turn.clone());
                        live.open_turns.remove(turn);
                        if live.turn_id.as_ref() == Some(turn) {
                            live.turn_id = None;
                            live.turn_started_at = None;
                        }
                    }
                    if last_ended_at.is_none_or(|at| end.base.time >= at) {
                        last_ended_at = Some(end.base.time);
                        live.last_turn_started_at = end
                            .base
                            .turn_id
                            .as_ref()
                            .and_then(|turn| starts.get(turn).copied());
                    }
                }
                SessionEvent::PageTool(row) => {
                    let key = page_tool_key(&row.message_id);
                    match live.page_tools.get_mut(&key) {
                        Some(held) => {
                            held.text = row.label;
                            if held.turn_id.is_none() {
                                held.turn_id = row.base.turn_id;
                            }
                        }
                        None => {
                            live.page_tools.insert(
                                key,
                                PageToolRecord {
                                    seq: row.origin.unwrap_or(row.base.seq),
                                    time: row.base.time,
                                    text: row.label,
                                    turn_id: row.base.turn_id,
                                    content_seq: row.content_seq,
                                },
                            );
                        }
                    }
                }
                _ => {}
            }
        }
        live
    }

    async fn promote_generic_title(&self, session: &SessionId, title: Option<&str>) {
        let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) else {
            return;
        };
        let generic = self
            .inner
            .sessions
            .summary(session)
            .await
            .is_some_and(|summary| summary.title == DEFAULT_TITLE);
        if generic
            && let Err(error) = self
                .inner
                .sessions
                .rename_automatic(session, title, AutoTitleSource::Fallback, None)
                .await
        {
            self.inner
                .logger
                .warn(&format!("session {session}: title not updated: {error}"));
        }
    }

    /// `sessionForConversation`: the session a conversation writes to, created on first sight.
    pub(crate) async fn session_for_conversation(
        &self,
        conversation: &str,
        title: Option<&str>,
    ) -> Option<SessionId> {
        if !self.recording() {
            return None;
        }
        if let Some(session) = self.session_for_live_conversation(conversation) {
            self.promote_generic_title(&session, title).await;
            return Some(session);
        }
        let _first_sight = self.inner.initializing.lock().await;
        if let Some(session) = self.session_for_live_conversation(conversation) {
            self.promote_generic_title(&session, title).await;
            return Some(session);
        }
        let sessions = &self.inner.sessions;
        let known = sessions.find_by_conversation(conversation, false);
        if known.is_none() && sessions.conversation_superseded(conversation) {
            self.inner.logger.info(&format!(
                "conversation {conversation} was replaced by Compact & Resume; its late observation gets no session of its own"
            ));
            return None;
        }
        let summary = match known.clone() {
            Some(summary) => summary,
            None => match sessions.create_for_conversation(conversation, title).await {
                Ok(summary) => summary,
                Err(error) => {
                    self.inner.logger.warn(&format!(
                        "session for conversation {conversation} could not be created: {error}"
                    ));
                    return None;
                }
            },
        };
        let id = summary.id.clone();
        if let Some(ended) = known.as_ref().and_then(|known| known.ended_at) {
            let closed_for = EpochMs::now().0.saturating_sub(ended);
            let _ = sessions.reopen(&id, None).await;
            if closed_for >= REOPEN_NOTICE_MS {
                self.inner.logger.info(&format!(
                    "session {id} reopened — its ChatGPT conversation is active again"
                ));
            }
        }
        let mut live = if known.is_some() {
            self.stored_history(&id).await
        } else {
            LiveConversation::fresh(id.clone())
        };
        live.last_turn_outcome = summary.last_turn_outcome;
        lock(&self.inner.live).insert(conversation.to_owned(), live);
        if known.is_none() {
            let start = SessionEvent::SessionStart(SessionStartEvent {
                base: EventBase {
                    model: None,
                    reasoning_effort: None,
                    seq: 0,
                    time: EpochMs::now().0,
                    authored_at: None,
                    turn_origin: None,
                    source: EventSource::Extension,
                    agent: None,
                    turn_id: None,
                },
                conversation_id: Some(conversation.to_owned()),
                title: summary.title.clone(),
                extra: Extra::new(),
            });
            if let Err(error) = sessions.append_event(&id, start).await {
                self.inner.logger.warn(&format!(
                    "session {id}: session_start not recorded: {error}"
                ));
            }
            self.inner.logger.info(&format!(
                "session started for a ChatGPT conversation ({id})"
            ));
        } else {
            self.promote_generic_title(&id, title).await;
        }
        Some(id)
    }

    /// `supersededLineage`: the session a replaced Compact & Resume source chat still writes
    /// its prose to; `None` for every chat that is current somewhere or unknown.
    fn superseded_lineage(&self, conversation: &str) -> Option<SessionId> {
        let sessions = &self.inner.sessions;
        if !sessions.conversation_superseded(conversation)
            || sessions.find_by_conversation(conversation, false).is_some()
        {
            return None;
        }
        sessions
            .lineage_of(conversation)
            .filter(|lineage| lineage.conversation_id.as_deref() != Some(conversation))
            .map(|lineage| lineage.id)
    }

    /// `recordRequestEvidence`: the one ownership ingress for `/correlations` and transcript
    /// batches. Never waits behind the chat's streamed text.
    pub(crate) async fn record_request_evidence(
        &self,
        conversation: &str,
        observations: &[PageObservation],
        now: EpochMs,
    ) -> Option<SessionId> {
        if !self.recording() {
            return None;
        }
        let lineage = if self.session_for_live_conversation(conversation).is_none() {
            self.superseded_lineage(conversation)
        } else {
            None
        };
        let session = match lineage {
            Some(lineage) => lineage,
            None => {
                self.session_for_conversation(
                    conversation,
                    observation_title(observations).as_deref(),
                )
                .await?
            }
        };
        let mut stored = false;
        let mut owners: Vec<RequestCorrelation> = Vec::new();
        for item in observations {
            if item.kind == ObservationKind::ToolEvidence
                && item.calls.as_ref().is_some_and(|calls| !calls.is_empty())
            {
                let noted = self.note_call_evidence(conversation, &session, item, now);
                stored |= noted.stored;
                for owner in noted.owners {
                    if !owners
                        .iter()
                        .any(|held| held.request_id == owner.request_id)
                    {
                        owners.push(owner);
                    }
                }
            }
        }
        if stored && let Err(error) = self.inner.correlations.commit().await {
            self.inner.logger.warn(&format!(
                "request correlation ledger could not be written: {error}"
            ));
        }
        for owner in &owners {
            self.attach_plan(owner).await;
        }
        Some(session)
    }

    /// `recordChatObservations`: ownership first, then the transcript in arrival order.
    pub(crate) async fn record_observations(
        &self,
        conversation: &str,
        observations: &[PageObservation],
        agent: Option<&str>,
        now: EpochMs,
    ) -> (Option<SessionId>, u64) {
        let has_evidence = observations
            .iter()
            .any(|item| item.kind == ObservationKind::ToolEvidence);
        if has_evidence {
            self.record_request_evidence(conversation, observations, now)
                .await;
        }
        let transcript: Vec<PageObservation> = observations
            .iter()
            .filter(|item| item.kind != ObservationKind::ToolEvidence)
            .cloned()
            .collect();
        let chain = self.chain(conversation);
        let _ordered = chain.lock().await;
        self.record_now(conversation, &transcript, agent).await
    }

    async fn store_text(
        &self,
        session: &SessionId,
        text: Option<&str>,
        cap: usize,
    ) -> cos_types::session::StoredText {
        self.inner
            .sessions
            .store_text(session, text.unwrap_or_default().to_owned(), cap)
            .await
    }

    /// `recordSupersededMessages`: a replaced chat adds its messages and nothing else.
    async fn record_superseded(
        &self,
        session: &SessionId,
        observations: &[PageObservation],
    ) -> u64 {
        let mut stored = 0;
        for item in observations {
            let Some(message_id) = &item.message_id else {
                continue;
            };
            let mut event_base = base(item, None);
            event_base.agent = None;
            let (event, options) = match item.kind {
                ObservationKind::UserMessage => (
                    self.user_message(session, item, event_base, message_id)
                        .await,
                    UpsertOptions {
                        prefer_time: item.authored_time == Some(true),
                        work: Some(false),
                    },
                ),
                ObservationKind::AssistantMessage => (
                    self.assistant_message(session, item, event_base, message_id)
                        .await,
                    UpsertOptions {
                        prefer_time: item.authored_time == Some(true),
                        work: None,
                    },
                ),
                ObservationKind::NativeImage => {
                    stored += self.record_native_image(session, item, event_base).await;
                    continue;
                }
                _ => continue,
            };
            if let Ok(written) = self
                .inner
                .sessions
                .upsert_message(session, event, options)
                .await
                && written.changed
            {
                stored += 1;
            }
        }
        stored
    }

    async fn user_message(
        &self,
        session: &SessionId,
        item: &PageObservation,
        mut event_base: EventBase,
        message_id: &str,
    ) -> SessionEvent {
        event_base.model.clone_from(&item.model);
        SessionEvent::UserMessage(UserMessageEvent {
            base: event_base,
            message: self
                .store_text(session, item.text.as_deref(), MAX_USER_MESSAGE_CHARS)
                .await,
            message_id: Some(message_id.to_owned()),
            input_id: None,
            input_delivery: None,
            authored_text: None,
            wire_token_estimate: None,
            reaction: item.reaction.clone(),
            attachments: item.attachments.clone().filter(|files| !files.is_empty()),
            assets: None,
            retired_image_asset_ids: None,
            origin: None,
            content_seq: None,
            extra: Extra::new(),
        })
    }

    async fn assistant_message(
        &self,
        session: &SessionId,
        item: &PageObservation,
        event_base: EventBase,
        message_id: &str,
    ) -> SessionEvent {
        let state = item.state.unwrap_or(if item.is_final == Some(true) {
            MessageState::Final
        } else {
            MessageState::Streaming
        });
        let rendered_html = match item
            .rendered_html
            .as_deref()
            .filter(|html| !html.is_empty())
        {
            Some(html) => Some(
                self.store_text(session, Some(html), MAX_RENDERED_HTML_CHARS)
                    .await,
            ),
            None => None,
        };
        SessionEvent::AssistantMessage(AssistantMessageEvent {
            base: event_base,
            message: self
                .store_text(session, item.text.as_deref(), MAX_ASSISTANT_CHARS)
                .await,
            message_id: Some(message_id.to_owned()),
            rendered_html,
            provider_message_id: item.provider_message_id.clone(),
            resolved_model: item.resolved_model.clone(),
            references: item.references.clone(),
            state: Some(state),
            is_final: state == MessageState::Final,
            goal_eligible: (item.goal_eligible == Some(true) && state == MessageState::Final)
                .then_some(true),
            final_content_seq: None,
            final_observed_at: None,
            origin: None,
            content_seq: None,
            extra: Extra::new(),
        })
    }

    fn live_entry(&self, conversation: &str) -> Option<LiveConversation> {
        lock(&self.inner.live).get(conversation).cloned()
    }

    fn update_live(&self, conversation: &str, update: impl FnOnce(&mut LiveConversation)) {
        if let Some(live) = lock(&self.inner.live).get_mut(conversation) {
            update(live);
        }
    }

    /// `recordChatObservationsNow`. Answers the session and how many observations were stored.
    async fn record_now(
        &self,
        conversation: &str,
        observations: &[PageObservation],
        agent: Option<&str>,
    ) -> (Option<SessionId>, u64) {
        if !self.recording() {
            return (None, 0);
        }
        if self.session_for_live_conversation(conversation).is_none()
            && let Some(lineage) = self.superseded_lineage(conversation)
        {
            let stored = self.record_superseded(&lineage, observations).await;
            return (Some(lineage), stored);
        }
        let first_user = observations
            .iter()
            .find(|item| item.kind == ObservationKind::UserMessage);
        let page_title = observations
            .iter()
            .rev()
            .find(|item| item.kind == ObservationKind::ConversationTitle);
        let title = page_title
            .and_then(|item| item.text.as_deref())
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_owned)
            .or_else(|| observed_user_title(first_user.and_then(|item| item.text.as_deref())));
        let Some(session) = self
            .session_for_conversation(conversation, title.as_deref())
            .await
        else {
            return (None, 0);
        };
        let sessions = &self.inner.sessions;
        let mut stored = 0;
        for item in observations {
            let event_base = base(item, agent);
            let live = self.live_entry(conversation);
            match item.kind {
                ObservationKind::ModelSelection => {
                    if let Some(model) = &item.model {
                        let _ = sessions
                            .observe_model(
                                &session,
                                conversation,
                                model,
                                millis(item.time),
                                item.reasoning_effort,
                            )
                            .await;
                    }
                }
                ObservationKind::ConversationTitle => {}
                ObservationKind::UserMessage => {
                    let Some(message_id) = &item.message_id else {
                        continue;
                    };
                    let event = self
                        .user_message(&session, item, event_base, message_id)
                        .await;
                    let options = UpsertOptions {
                        prefer_time: item.authored_time == Some(true),
                        work: Some(item.authored_now == Some(true)),
                    };
                    match sessions.upsert_message(&session, event, options).await {
                        Ok(written) if written.changed => {}
                        Ok(_) => continue,
                        Err(error) => {
                            self.inner.logger.warn(&format!(
                                "session {session}: user message not stored: {error}"
                            ));
                            continue;
                        }
                    }
                }
                ObservationKind::AssistantMessage => {
                    let Some(message_id) = &item.message_id else {
                        continue;
                    };
                    let event = self
                        .assistant_message(&session, item, event_base, message_id)
                        .await;
                    let options = UpsertOptions {
                        prefer_time: item.authored_time == Some(true),
                        work: Some(item.active_now == Some(true)),
                    };
                    match sessions.upsert_message(&session, event, options).await {
                        Ok(written) if written.changed => {}
                        Ok(_) => continue,
                        Err(error) => {
                            self.inner.logger.warn(&format!(
                                "session {session}: assistant message not stored: {error}"
                            ));
                            continue;
                        }
                    }
                }
                ObservationKind::PageTool => {
                    if !self
                        .record_page_tool(&session, conversation, live.as_ref(), item, event_base)
                        .await
                    {
                        continue;
                    }
                }
                ObservationKind::ChatError => {
                    if !self
                        .record_chat_error(&session, live.as_ref(), item, event_base)
                        .await
                    {
                        continue;
                    }
                }
                ObservationKind::TurnStart => {
                    let Some(turn) = &item.turn_id else {
                        continue;
                    };
                    if live.as_ref().is_some_and(|live| {
                        live.known_turn_starts.contains(turn) || live.known_turn_ends.contains(turn)
                    }) {
                        continue;
                    }
                    let start = SessionEvent::TurnStart(TurnStartEvent {
                        base: event_base,
                        detail: None,
                        extra: Extra::new(),
                    });
                    if sessions.append_event(&session, start).await.is_err() {
                        continue;
                    }
                    let time = millis(item.time);
                    self.update_live(conversation, |live| {
                        live.known_turn_starts.insert(turn.clone());
                        live.turn_started_at = Some(time);
                        live.turn_id = Some(turn.clone());
                        live.open_turns.insert(turn.clone());
                    });
                }
                ObservationKind::TurnEnd => {
                    if !self
                        .record_turn_end(&session, conversation, live.as_ref(), item, event_base)
                        .await
                    {
                        continue;
                    }
                }
                ObservationKind::TurnTrace => {
                    // Presentation beside the log: no event, no activity, no work evidence.
                    if let (Some(turn), Some(trace)) = (&item.turn_id, &item.trace) {
                        let items = trace
                            .iter()
                            .filter_map(|entry| match entry {
                                PageTraceItem::Readable(entry) => Some(entry.clone()),
                                PageTraceItem::Unreadable(_) => None,
                            })
                            .collect();
                        if let Err(error) = sessions
                            .write_turn_trace(&session, turn, items, item.question.as_deref())
                            .await
                        {
                            self.inner.logger.warn(&format!(
                                "session {session}: turn outline not stored: {error}"
                            ));
                        }
                    }
                    continue;
                }
                ObservationKind::NativeImage => {
                    // Transcript content only: no activity, no turn verdict, no work evidence.
                    stored += self.record_native_image(&session, item, event_base).await;
                    continue;
                }
                ObservationKind::ToolEvidence | ObservationKind::AppSightings => continue,
            }
            stored += 1;
        }
        if let Some(title) = page_title
            .and_then(|item| item.text.as_deref())
            .map(str::trim)
            .filter(|title| !title.is_empty())
            && let Err(error) = sessions
                .rename_automatic(
                    &session,
                    title,
                    AutoTitleSource::Provider,
                    Some(conversation),
                )
                .await
        {
            self.inner
                .logger
                .warn(&format!("session {session}: title not updated: {error}"));
        }
        (Some(session), stored)
    }

    /// `recordPageTool`: one visible native activity row, superseding the record it has.
    async fn record_page_tool(
        &self,
        session: &SessionId,
        conversation: &str,
        live: Option<&LiveConversation>,
        item: &PageObservation,
        mut event_base: EventBase,
    ) -> bool {
        let Some(id) = &item.message_id else {
            return false;
        };
        let label = js_slice(item.text.as_deref().unwrap_or_default(), 300)
            .trim()
            .to_owned();
        if label.is_empty() {
            return false;
        }
        let key = page_tool_key(id);
        let held = live.and_then(|live| live.page_tools.get(&key)).cloned();
        if held.as_ref().is_some_and(|held| held.text == label) {
            return false;
        }
        let mut content_seq = None;
        if let Some(held) = &held {
            if held.turn_id.is_some() {
                event_base.turn_id.clone_from(&held.turn_id);
            }
            event_base.time = held.time;
            content_seq = held.content_seq;
        } else if live.is_some() && item.active_now == Some(false) {
            content_seq = Some(0);
        }
        let observed_time = millis(item.time);
        let turn = event_base.turn_id.clone();
        let event = SessionEvent::PageTool(PageToolEvent {
            base: event_base,
            message_id: id.clone(),
            label: label.clone(),
            origin: held.as_ref().map(|held| held.seq),
            content_seq,
            extra: Extra::new(),
        });
        let written = match self.inner.sessions.append_event(session, event).await {
            Ok(written) => written,
            Err(_) => return false,
        };
        if live.is_some() {
            let seq = held.as_ref().map_or(written.base().seq, |held| held.seq);
            let time = held.as_ref().map_or(observed_time, |held| held.time);
            self.update_live(conversation, |live| {
                live.page_tools.insert(
                    key,
                    PageToolRecord {
                        seq,
                        time,
                        text: label,
                        turn_id: held.and_then(|held| held.turn_id).or(turn),
                        content_seq,
                    },
                );
            });
        }
        true
    }

    /// `chat_error`: one notice per failure, not one per retry.
    async fn record_chat_error(
        &self,
        session: &SessionId,
        live: Option<&LiveConversation>,
        item: &PageObservation,
        event_base: EventBase,
    ) -> bool {
        if item.reason == Some(ChatErrorReason::ThinkingFailed) && item.turn_id.is_none() {
            return false;
        }
        if item.reason == Some(ChatErrorReason::StreamGone)
            && (item.turn_id.is_none()
                || live.and_then(|live| live.turn_id.as_ref()) != item.turn_id.as_ref())
        {
            return false;
        }
        let recoverable = item.recoverable == Some(true);
        let text = chat_error_key(item.text.as_deref().unwrap_or_default(), recoverable);
        let recent = self
            .inner
            .sessions
            .recent_events(session, 32, &["chat_error"])
            .await
            .unwrap_or_default();
        let time = millis(item.time);
        let duplicate = recent.iter().any(|event| {
            let SessionEvent::ChatError(error) = event else {
                return false;
            };
            let close = time.abs_diff(error.base.time) <= 30_000
                || (item.reason == Some(ChatErrorReason::ThinkingFailed)
                    && error.reason == item.reason
                    && error.base.turn_id == item.turn_id);
            let same_turn = item.blocking == Some(true)
                || error.base.turn_id.as_deref().unwrap_or("")
                    == item.turn_id.as_deref().unwrap_or("");
            let same_text = chat_error_key(&error.message.text, error.recoverable == Some(true))
                == text
                || (recoverable
                    && error.recoverable == Some(true)
                    && (item.reason == Some(ChatErrorReason::StreamGone)
                        || error.reason == Some(ChatErrorReason::StreamGone)));
            close && same_turn && same_text
        });
        if duplicate {
            return false;
        }
        let retry_at = item
            .retry_at
            .filter(|_| item.blocking == Some(true))
            .map(millis)
            .filter(|retry| *retry > time && retry - time <= 24 * 60 * 60_000);
        let event = SessionEvent::ChatError(ChatErrorEvent {
            base: event_base,
            message: self.store_text(session, item.text.as_deref(), 2000).await,
            recoverable: item.recoverable,
            blocking: item.blocking,
            retry_at,
            reason: item.reason,
            extra: Extra::new(),
        });
        self.inner
            .sessions
            .append_event(session, event)
            .await
            .is_ok()
    }

    /// `turn_end`: idempotent per turn id; an explicit Stop may strengthen an earlier end once.
    async fn record_turn_end(
        &self,
        session: &SessionId,
        conversation: &str,
        live: Option<&LiveConversation>,
        item: &PageObservation,
        event_base: EventBase,
    ) -> bool {
        let Some(turn) = item.turn_id.clone() else {
            return false;
        };
        let known_end = live.is_some_and(|live| live.known_turn_ends.contains(&turn));
        let stop_override = known_end && item.outcome == Some(TurnOutcome::Stopped);
        if known_end {
            if !stop_override
                || live.is_some_and(|live| {
                    live.turn_id
                        .as_ref()
                        .is_some_and(|current| *current != turn)
                })
            {
                return false;
            }
            let latest = self
                .inner
                .sessions
                .recent_events(session, 1, &["turn_start", "turn_end", "user_message"])
                .await
                .unwrap_or_default();
            let strengthens = matches!(latest.last(), Some(SessionEvent::TurnEnd(end))
                if end.base.turn_id.as_deref() == Some(turn.as_str())
                    && end.outcome != TurnOutcome::Stopped
                    && millis(item.time) >= end.base.time);
            if !strengthens {
                return false;
            }
        }
        if live.is_some_and(|live| live.turn_id.as_deref() == Some(turn.as_str())) {
            // A replay of the end from before an app-authored reopen cannot undo newer work.
            let latest = self
                .inner
                .sessions
                .recent_events(session, 1, &["turn_start", "turn_end"])
                .await
                .unwrap_or_default();
            if matches!(latest.last(), Some(SessionEvent::TurnStart(start))
                if start.base.source == EventSource::App
                    && start.base.turn_id.as_deref() == Some(turn.as_str())
                    && start.base.time >= millis(item.time))
            {
                return false;
            }
        }
        let outcome = item.outcome.unwrap_or(TurnOutcome::Unknown);
        let event = SessionEvent::TurnEnd(TurnEndEvent {
            base: event_base,
            outcome,
            detail: item.detail.clone(),
            reason: (outcome == TurnOutcome::Failed
                && item.reason == Some(ChatErrorReason::ThinkingFailed))
            .then_some(TurnEndReason::ThinkingFailed),
            provider_message_id: if outcome == TurnOutcome::Completed {
                item.provider_message_id.clone()
            } else {
                None
            },
            continued: (item.continued == Some(true)).then_some(cos_types::json::True),
            extra: Extra::new(),
        });
        if self
            .inner
            .sessions
            .append_event(session, event)
            .await
            .is_err()
        {
            return false;
        }
        self.update_live(conversation, |live| {
            let ended_started_at = if live.turn_id.as_ref() == Some(&turn) {
                live.turn_started_at
            } else {
                None
            };
            live.known_turn_ends.insert(turn.clone());
            live.open_turns.remove(&turn);
            live.last_turn_outcome = Some(outcome);
            live.last_turn_started_at = ended_started_at;
            if live.turn_id.as_ref() == Some(&turn) {
                live.turn_started_at = None;
                live.turn_id = None;
            }
        });
        true
    }

    /// `closeConversation`: the page is gone. A turn still open gets a note and stays open.
    pub(crate) async fn close_conversation(&self, conversation: &str, dismiss: bool) {
        let live = lock(&self.inner.live).remove(conversation);
        let sessions = &self.inner.sessions;
        let Some(live) = live else {
            if dismiss && let Some(known) = sessions.find_by_conversation(conversation, false) {
                let _ = sessions.end(&known.id, true, Some(conversation)).await;
            }
            return;
        };
        if live.turn_started_at.is_some() {
            let message = self
                .store_text(
                    &live.session_id,
                    Some("the ChatGPT page detached while this turn was still open; the turn stays open until real evidence ends it"),
                    4000,
                )
                .await;
            let note = SessionEvent::Note(NoteEvent {
                base: EventBase {
                    model: None,
                    reasoning_effort: None,
                    seq: 0,
                    time: EpochMs::now().0,
                    authored_at: None,
                    turn_origin: None,
                    source: EventSource::Extension,
                    agent: None,
                    turn_id: live.turn_id.clone(),
                },
                message,
                continuation: None,
                extra: Extra::new(),
            });
            let _ = sessions.append_event(&live.session_id, note).await;
        }
        let _ = sessions
            .end(&live.session_id, dismiss, Some(conversation))
            .await;
    }
}
