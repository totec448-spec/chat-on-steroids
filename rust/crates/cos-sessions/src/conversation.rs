//! What the browser recorder asks of the store: a session per ChatGPT conversation, canonical
//! message revisions, close and reopen, the native model selection, and recent events
//! (`createSession`, `findSessionByConversation`, `upsertMessageEvent`, `reopenSession`,
//! `endSession`, `observeSessionModel` and `readRecentEvents` in `src/main/session/store.ts`).
//! Titles live in `title.rs`. `cos-recorder` is the caller.

use std::io;

use cos_tools::EpochMs;
use cos_types::ids::SessionId;
use cos_types::json::{Extra, Record};
use cos_types::session::{
    EventBase, MessageState, ReasoningEffort, SelectedModel, SessionEvent, SessionSummary,
    TitleSource,
};

use crate::title::{DEFAULT_TITLE, refresh_user_title};
use crate::{Live, SessionStore, Writer, blocking, disk, js, lock, read, summary};

/// The result of [`SessionStore::upsert_message`].
#[derive(Clone, Debug, PartialEq)]
pub struct Upserted {
    /// The canonical message as stored now (the previous one when nothing changed).
    pub event: SessionEvent,
    pub changed: bool,
    /// The message text itself changed, not only its markup or identity.
    pub content_changed: bool,
}

/// `upsertMessageEvent`'s options.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UpsertOptions {
    /// ChatGPT's own authored time replaces the first-seen time of the same message.
    pub prefer_time: bool,
    /// `Some(false)`: a revision that is history, not new work (`work: false`).
    pub work: Option<bool>,
}

fn base_mut(event: &mut SessionEvent) -> &mut EventBase {
    match event {
        SessionEvent::SessionStart(event) => &mut event.base,
        SessionEvent::UserMessage(event) => &mut event.base,
        SessionEvent::AssistantMessage(event) => &mut event.base,
        SessionEvent::NativeImage(event) => &mut event.base,
        SessionEvent::Progress(event) => &mut event.base,
        SessionEvent::PageTool(event) => &mut event.base,
        SessionEvent::TurnStart(event) => &mut event.base,
        SessionEvent::TurnEnd(event) => &mut event.base,
        SessionEvent::ChatError(event) => &mut event.base,
        SessionEvent::ToolCall(event) => &mut event.base,
        SessionEvent::Note(event) => &mut event.base,
        SessionEvent::AgentMessage(event) => &mut event.base,
        SessionEvent::Handoff(event) => &mut event.base,
    }
}

fn is_final(event: &SessionEvent) -> bool {
    matches!(event, SessionEvent::AssistantMessage(message)
        if message.is_final || message.state == Some(MessageState::Final))
}

fn text_of(event: &SessionEvent) -> Option<&cos_types::session::StoredText> {
    match event {
        SessionEvent::UserMessage(message) => Some(&message.message),
        SessionEvent::AssistantMessage(message) => Some(&message.message),
        _ => None,
    }
}

fn same_kind(left: &SessionEvent, right: &SessionEvent) -> bool {
    std::mem::discriminant(left) == std::mem::discriminant(right)
}

/// The revision `upsertMessageEvent` builds from the previous canonical message and the new
/// observation, before its sequence fields are set.
fn merged(
    previous: Option<&SessionEvent>,
    event: SessionEvent,
    same_message: bool,
) -> SessionEvent {
    match (previous, event) {
        (
            Some(SessionEvent::AssistantMessage(previous)),
            SessionEvent::AssistantMessage(mut next),
        ) => {
            next.message_id.clone_from(&previous.message_id);
            next.base.authored_at = previous.base.authored_at.or(next.base.authored_at);
            next.provider_message_id = next
                .provider_message_id
                .or_else(|| previous.provider_message_id.clone());
            next.resolved_model = next
                .resolved_model
                .or_else(|| previous.resolved_model.clone());
            next.references = next.references.or_else(|| previous.references.clone());
            let finished = next.state == Some(MessageState::Final) || next.is_final;
            next.state = Some(if finished {
                MessageState::Final
            } else {
                MessageState::Streaming
            });
            next.is_final = finished;
            if previous.goal_eligible == Some(true) {
                next.goal_eligible = Some(true);
            }
            if next.rendered_html.is_none() && same_message {
                next.rendered_html.clone_from(&previous.rendered_html);
            }
            SessionEvent::AssistantMessage(next)
        }
        (Some(SessionEvent::UserMessage(previous)), SessionEvent::UserMessage(mut next)) => {
            next.input_id = next.input_id.or_else(|| previous.input_id.clone());
            next.base.authored_at = previous.base.authored_at.or(next.base.authored_at);
            next.authored_text = next
                .authored_text
                .or_else(|| previous.authored_text.clone());
            next.wire_token_estimate = next.wire_token_estimate.or(previous.wire_token_estimate);
            if next.reaction.is_none() {
                next.reaction.clone_from(&previous.reaction);
            }
            next.attachments = if previous.input_id.is_some() {
                previous.attachments.clone().or(next.attachments)
            } else {
                next.attachments.or_else(|| previous.attachments.clone())
            };
            next.input_delivery =
                if previous.input_delivery == Some(cos_types::session::InputDelivery::Confirmed) {
                    previous.input_delivery
                } else {
                    next.input_delivery.or(previous.input_delivery)
                };
            next.base.model = next.base.model.or_else(|| previous.base.model.clone());
            next.base.reasoning_effort = next
                .base
                .reasoning_effort
                .or(previous.base.reasoning_effort);
            next.retired_image_asset_ids = previous.retired_image_asset_ids.clone();
            next.assets = next.assets.or_else(|| previous.assets.clone());
            SessionEvent::UserMessage(next)
        }
        (_, event) => event,
    }
}

/// Whether a revision says nothing the stored message does not already say.
fn unchanged(
    previous: &SessionEvent,
    next: &SessionEvent,
    same_message: bool,
    settled_turn: Option<&str>,
    prefer_time: bool,
) -> bool {
    if !same_kind(previous, next) || !same_message {
        return false;
    }
    let (left, right) = (previous.base(), next.base());
    if left.authored_at != right.authored_at
        || left.model != right.model
        || left.reasoning_effort != right.reasoning_effort
    {
        return false;
    }
    let details = match (previous, next) {
        (SessionEvent::AssistantMessage(a), SessionEvent::AssistantMessage(b)) => {
            a.rendered_html == b.rendered_html
                && a.state == b.state
                && a.is_final == b.is_final
                && a.goal_eligible == b.goal_eligible
                && a.provider_message_id == b.provider_message_id
                && a.resolved_model == b.resolved_model
                && a.references == b.references
        }
        (SessionEvent::UserMessage(a), SessionEvent::UserMessage(b)) => {
            a.reaction == b.reaction
                && a.input_id == b.input_id
                && a.authored_text == b.authored_text
                && a.wire_token_estimate == b.wire_token_estimate
                && a.input_delivery == b.input_delivery
                && a.assets == b.assets
                && a.retired_image_asset_ids == b.retired_image_asset_ids
                && a.attachments == b.attachments
        }
        _ => true,
    };
    details
        && left.turn_id.as_deref() == settled_turn
        && (right.agent.is_none() || left.agent == right.agent)
        && (!prefer_time || left.time == right.time)
}

impl SessionStore {
    /// `getSession`: the live summary, or the one on disk.
    pub async fn summary(&self, id: &SessionId) -> Option<SessionSummary> {
        self.get_summary(id).await
    }

    /// `findSessionByConversation`: the session this chat is attached to now, newest first.
    /// With `unique`, two sessions attached to one chat answer `None` (`requireUnique`).
    pub fn find_by_conversation(&self, conversation: &str, unique: bool) -> Option<SessionSummary> {
        let mut current: Vec<SessionSummary> = self
            .summaries()
            .into_iter()
            .filter(|summary| summary.conversation_id.as_deref() == Some(conversation))
            .collect();
        current.sort_by_key(|summary| std::cmp::Reverse(summary.updated_at));
        if unique && current.len() > 1 {
            self.logger().warn(&format!(
                "session store: conversation {conversation} is current on {} sessions; refusing safety-sensitive lookup",
                current.len()
            ));
            return None;
        }
        current.into_iter().next()
    }

    /// `conversationWasSuperseded`: a session holds this chat in its lineage but is attached to
    /// another one, so Compact & Resume replaced it.
    pub fn conversation_superseded(&self, conversation: &str) -> bool {
        self.summaries().iter().any(|summary| {
            summary.chat_ids.iter().any(|chat| chat == conversation)
                && summary.conversation_id.as_deref() != Some(conversation)
        })
    }

    /// The one session whose lineage holds a replaced chat (`includeHistorical`).
    pub fn lineage_of(&self, conversation: &str) -> Option<SessionSummary> {
        let lineages: Vec<SessionSummary> = self
            .summaries()
            .into_iter()
            .filter(|summary| summary.chat_ids.iter().any(|chat| chat == conversation))
            .collect();
        match lineages.len() {
            1 => lineages.into_iter().next(),
            0 => None,
            count => {
                self.logger().warn(&format!(
                    "session store: conversation {conversation} appears in {count} session lineages; refusing to guess"
                ));
                None
            }
        }
    }

    /// `createSession({ conversationId, title, titleSource: 'fallback' })`. The caller appends
    /// the `session_start` event.
    pub async fn create_for_conversation(
        &self,
        conversation: &str,
        title: Option<&str>,
    ) -> Result<SessionSummary, String> {
        let now = EpochMs::now().0;
        let uuid = js::random_uuid();
        let id = SessionId::parse(format!("{}-{}", js::iso_day(now), &uuid[..8]))
            .map_err(|error| error.to_string())?;
        let title = title
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(DEFAULT_TITLE);
        let mut summary = summary::empty(id.clone(), title, Some(conversation.to_owned()), now);
        summary.title_source = Some(TitleSource::Fallback);
        let dir = self.dir(&id);
        let created = summary.clone();
        blocking(move || disk::create(&dir, &created))
            .await
            .and_then(|written| written)
            .map_err(|error| error.to_string())?;
        let live = std::sync::Arc::new(Live {
            published: std::sync::Mutex::new(summary.clone()),
            writer: tokio::sync::Mutex::new(Writer {
                summary: summary.clone(),
                messages: Some(Record::new()),
                next_seq: 1,
                history_seq: 0,
                meta_dirty: false,
                meta_scheduled: false,
            }),
        });
        {
            let mut shared = lock(&self.inner.shared);
            shared.open.insert(id.clone(), live);
            shared.catalog.insert(id.clone(), summary.clone());
        }
        self.publish_index();
        Ok(summary)
    }

    /// `appendEvent`: the event with its assigned sequence number.
    pub async fn append_event(
        &self,
        id: &SessionId,
        mut event: SessionEvent,
    ) -> Result<SessionEvent, String> {
        let seq = self.append(id, event.clone()).await?;
        base_mut(&mut event).seq = seq;
        Ok(event)
    }

    pub(crate) async fn ensure_messages(
        &self,
        id: &SessionId,
        writer: &mut Writer,
    ) -> Result<(), String> {
        if writer.messages.is_some() {
            return Ok(());
        }
        let dir = self.dir(id);
        let name = id.as_str().to_owned();
        let logger = self.logger().clone();
        let (messages, _) = blocking(move || disk::read_canonical_messages(&dir, &name, &logger))
            .await
            .map_err(|error| error.to_string())?;
        writer.messages = Some(messages);
        Ok(())
    }

    /// `upsertMessageEvent`: creates or revises one canonical ChatGPT message by its own id.
    pub async fn upsert_message(
        &self,
        id: &SessionId,
        event: SessionEvent,
        options: UpsertOptions,
    ) -> Result<Upserted, String> {
        let direct_key = summary::message_key(&event)
            .ok_or_else(|| "Canonical message update requires ChatGPT messageId".to_owned())?;
        let live = self.ensure_open(id).await?;
        let mut writer = live.writer.lock().await;
        self.ensure_messages(id, &mut writer).await?;
        let Some(messages) = writer.messages.as_ref() else {
            return Err("canonical messages unavailable".into());
        };
        let provider_matches: Vec<&String> = match &event {
            SessionEvent::AssistantMessage(next) => match next.provider_message_id.as_deref() {
                Some(provider) => messages
                    .iter()
                    .filter(|(_, candidate)| {
                        matches!(candidate, SessionEvent::AssistantMessage(held)
                            if held.provider_message_id.as_deref() == Some(provider))
                    })
                    .map(|(key, _)| key)
                    .collect(),
                None => Vec::new(),
            },
            _ => Vec::new(),
        };
        let key = if !messages.contains_key(&direct_key) && provider_matches.len() == 1 {
            provider_matches[0].clone()
        } else {
            direct_key.clone()
        };
        let previous = messages
            .get(&key)
            .filter(|candidate| !matches!(candidate, SessionEvent::ToolCall(_)))
            .cloned();
        let prefer_time = options.prefer_time && key == direct_key;
        let mut event = event;
        if let Some(previous) = &previous
            && key != direct_key
            && let (SessionEvent::AssistantMessage(next), SessionEvent::AssistantMessage(held)) =
                (&mut event, previous)
        {
            next.message_id.clone_from(&held.message_id);
        }
        if let (
            Some(previous @ SessionEvent::AssistantMessage(_)),
            SessionEvent::AssistantMessage(next),
        ) = (&previous, &event)
            && is_final(previous)
            && !next.is_final
            && next.state != Some(MessageState::Final)
        {
            return Ok(Upserted {
                event: previous.clone(),
                changed: false,
                content_changed: false,
            });
        }
        let same_message = previous.as_ref().is_some_and(|previous| {
            same_kind(previous, &event) && text_of(previous) == text_of(&event)
        });
        let next = merged(previous.as_ref(), event, same_message);
        let settled_turn = match (&previous, &next) {
            (Some(SessionEvent::AssistantMessage(held)), SessionEvent::AssistantMessage(next)) => {
                held.base
                    .turn_id
                    .clone()
                    .or_else(|| next.base.turn_id.clone())
            }
            _ => next.base().turn_id.clone(),
        };
        if let Some(previous) = &previous
            && unchanged(
                previous,
                &next,
                same_message,
                settled_turn.as_deref(),
                prefer_time,
            )
        {
            return Ok(Upserted {
                event: previous.clone(),
                changed: false,
                content_changed: false,
            });
        }
        let seq = writer.next_seq;
        let next_final = is_final(&next);
        let content_seq = if options.work == Some(false)
            && ((matches!(next, SessionEvent::UserMessage(_)) && previous.is_some())
                || (matches!(next, SessionEvent::AssistantMessage(_)) && !next_final))
        {
            previous.as_ref().map_or(0, summary::work_sequence)
        } else if let Some(previous) = previous.as_ref().filter(|previous| {
            same_message
                && (!matches!(next, SessionEvent::AssistantMessage(_))
                    || (matches!(previous, SessionEvent::AssistantMessage(_))
                        && is_final(previous) == next_final))
        }) {
            summary::work_sequence(previous)
        } else {
            seq
        };
        let observed_time = next.base().time;
        let mut full = next;
        let previous_base = previous.as_ref().map(SessionEvent::base);
        {
            let base = base_mut(&mut full);
            if !prefer_time && let Some(held) = previous_base {
                base.time = held.time;
            }
            base.turn_id = settled_turn;
            if base.agent.is_none()
                && let Some(agent) = previous_base.and_then(|held| held.agent.clone())
            {
                base.agent = Some(agent);
            }
            base.seq = seq;
        }
        let origin = match &previous {
            Some(held) if same_kind(held, &full) => match held {
                SessionEvent::UserMessage(held) => held.origin.unwrap_or(held.base.seq),
                SessionEvent::AssistantMessage(held) => held.origin.unwrap_or(held.base.seq),
                _ => seq,
            },
            _ => seq,
        };
        match &mut full {
            SessionEvent::UserMessage(message) => {
                message.content_seq = Some(content_seq);
                message.origin = Some(origin);
            }
            SessionEvent::AssistantMessage(message) => {
                message.content_seq = Some(content_seq);
                message.origin = Some(origin);
                if message.is_final {
                    let kept = match &previous {
                        Some(SessionEvent::AssistantMessage(held))
                            if same_message
                                && (held.is_final || held.state == Some(MessageState::Final)) =>
                        {
                            Some((
                                held.final_content_seq
                                    .or(held.origin)
                                    .unwrap_or(held.base.seq),
                                held.final_observed_at,
                            ))
                        }
                        _ => None,
                    };
                    match kept {
                        Some((final_seq, observed)) => {
                            message.final_content_seq = Some(final_seq);
                            message.final_observed_at = observed;
                        }
                        None => {
                            message.final_content_seq = Some(seq);
                            message.final_observed_at = Some(EpochMs::now().0);
                        }
                    }
                }
            }
            _ => {}
        }
        let dir = self.dir(id);
        let shard_key = key.clone();
        let stored = full.clone();
        blocking(move || disk::write_canonical_message(&dir, &shard_key, &stored))
            .await
            .and_then(|written| written)
            .map_err(|error| {
                self.logger()
                    .error(&format!("session message upsert failed: {error}"));
                error.to_string()
            })?;
        writer.next_seq += 1;
        let Writer {
            summary: summary_state,
            messages,
            ..
        } = &mut *writer;
        let messages = messages.get_or_insert_with(Record::new);
        messages.insert(key, full.clone());
        if matches!(full, SessionEvent::UserMessage(_)) {
            refresh_user_title(summary_state, messages);
        }
        match &previous {
            None => summary::apply(summary_state, &full),
            Some(previous) => {
                let delta =
                    summary::event_tokens(&full) as i64 - summary::event_tokens(previous) as i64;
                summary_state.estimated_tokens =
                    (summary_state.estimated_tokens as i64 + delta).max(0) as u64;
                summary_state.context_tokens =
                    (summary_state.context_tokens as i64 + delta).max(0) as u64;
                summary_state.updated_at = summary_state.updated_at.max(observed_time);
                summary::note_finish_work(summary_state, &full);
                if is_final(&full) {
                    let at = summary_state
                        .last_assistant_final_at
                        .flatten()
                        .unwrap_or(0)
                        .max(observed_time);
                    summary_state.last_assistant_final_at = Some(Some(at));
                }
                if let Some(agent) = &full.base().agent
                    && !summary_state.agents.contains(agent)
                {
                    summary_state.agents.push(agent.clone());
                }
            }
        }
        writer.history_seq = seq;
        *lock(&live.published) = writer.summary.clone();
        self.schedule_meta(id, &live, &mut writer);
        drop(writer);
        lock(&self.inner.shared).active = Some(id.clone());
        let _ = self.inner.appended.send(crate::Appended {
            session: id.clone(),
            seq,
        });
        Ok(Upserted {
            content_changed: !same_message,
            event: full,
            changed: true,
        })
    }

    /// Writes the summary now and publishes it (`writeMeta`).
    pub(crate) async fn commit_summary(&self, id: &SessionId, live: &Live, writer: &mut Writer) {
        writer.meta_dirty = true;
        self.write_meta(id, live, writer).await;
        *lock(&live.published) = writer.summary.clone();
        self.publish_index();
    }

    /// `reopenSession`: a closed chat that is active again is live again.
    pub async fn reopen(
        &self,
        id: &SessionId,
        page_observed_at: Option<u64>,
    ) -> Result<(), String> {
        let live = self.ensure_open(id).await?;
        let mut writer = live.writer.lock().await;
        let dismissed = writer.summary.browser_recovery_dismissed_at;
        let returned = matches!((dismissed, page_observed_at), (Some(at), Some(page)) if page > at);
        if writer.summary.ended_at.is_none() && !returned {
            return Ok(());
        }
        if returned {
            writer.summary.browser_recovery_dismissed_at = None;
        }
        writer.summary.ended_at = None;
        writer.summary.updated_at = EpochMs::now().0;
        self.commit_summary(id, &live, &mut writer).await;
        Ok(())
    }

    /// `endSession`: stamps the close and forgets the live entry. `dismiss` is a deliberate close
    /// that pauses browser recovery until the page returns. Answers whether it ended.
    pub async fn end(
        &self,
        id: &SessionId,
        dismiss: bool,
        expected_conversation: Option<&str>,
    ) -> Result<bool, String> {
        let live = if dismiss {
            self.ensure_open(id).await?
        } else {
            match lock(&self.inner.shared).open.get(id).cloned() {
                Some(live) => live,
                None => return Ok(false),
            }
        };
        let mut writer = live.writer.lock().await;
        if let Some(expected) = expected_conversation
            && writer.summary.conversation_id.as_deref() != Some(expected)
        {
            return Ok(false);
        }
        let now = EpochMs::now().0;
        writer.summary.ended_at = Some(now);
        if dismiss {
            writer.summary.browser_recovery_dismissed_at = Some(now);
        }
        self.commit_summary(id, &live, &mut writer).await;
        drop(writer);
        {
            let mut shared = lock(&self.inner.shared);
            if shared
                .open
                .get(id)
                .is_some_and(|held| std::sync::Arc::ptr_eq(held, &live))
            {
                shared.open.remove(id);
            }
        }
        Ok(true)
    }

    /// `observeSessionModel`: the native picker's current selection for this chat.
    pub async fn observe_model(
        &self,
        id: &SessionId,
        conversation: &str,
        model: &str,
        observed_at: u64,
        reasoning_effort: Option<ReasoningEffort>,
    ) -> Result<(), String> {
        let valid = (1..=80).contains(&model.len())
            && model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'_' | b'-'));
        if !valid {
            return Ok(());
        }
        let live = self.ensure_open(id).await?;
        let mut writer = live.writer.lock().await;
        if writer.summary.conversation_id.as_deref() != Some(conversation)
            || observed_at
                < writer
                    .summary
                    .selected_model
                    .as_ref()
                    .map_or(0, |selected| selected.observed_at)
        {
            return Ok(());
        }
        let selected = SelectedModel {
            conversation_id: conversation.to_owned(),
            model: model.to_owned(),
            observed_at,
            reasoning_effort,
            extra: Extra::new(),
        };
        if writer.summary.selected_model.as_ref() == Some(&selected) {
            return Ok(());
        }
        writer.summary.selected_model = Some(selected);
        self.commit_summary(id, &live, &mut writer).await;
        Ok(())
    }

    /// `readRecentEvents(id, limit, { kinds })`: the newest events of these kinds, oldest first,
    /// after the pending summary write (`flushSession`).
    pub async fn recent_events(
        &self,
        id: &SessionId,
        limit: usize,
        kinds: &[&str],
    ) -> io::Result<Vec<SessionEvent>> {
        self.flush_session(id).await;
        let summary = self.get_summary(id).await;
        let dir = self.dir(id);
        let target = id.clone();
        let logger = self.logger().clone();
        let kinds: Vec<String> = kinds.iter().map(|kind| (*kind).to_owned()).collect();
        blocking(move || {
            read::page(
                &dir,
                &target,
                summary.as_ref(),
                read::Window::Latest { before: None },
                limit,
                Some(&kinds),
                &logger,
            )
        })
        .await?
    }
}

impl SessionStore {
    /// `storeText`: inline up to `cap` UTF-16 units, the whole text spilled to an asset beyond.
    pub async fn store_text(
        &self,
        id: &SessionId,
        value: String,
        cap: usize,
    ) -> cos_types::session::StoredText {
        crate::recorder::store_text(self, id, value, cap).await
    }
}

/// `TRACE_TURN_ID`.
fn trace_turn_id(turn: &str) -> bool {
    (1..=100).contains(&turn.len())
        && turn
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

const MAX_TRACE_FILE_BYTES: usize = 512 * 1024;

impl SessionStore {
    /// `writeTurnTrace`: ChatGPT's outline of one turn, beside the log as
    /// `traces/<turnId>.json`. The earliest time seen for a call is kept. Answers whether the
    /// file changed.
    pub async fn write_turn_trace(
        &self,
        id: &SessionId,
        turn: &str,
        trace: Vec<cos_types::session::TurnTraceItem>,
        question: Option<&str>,
    ) -> Result<bool, String> {
        use cos_types::session::TurnTraceItem;
        if !trace_turn_id(turn) || trace.is_empty() {
            return Ok(false);
        }
        let live = self.ensure_open(id).await?;
        let writer = live.writer.lock().await;
        let asked = writer
            .summary
            .timeline_turns
            .as_ref()
            .and_then(|turns| turns.get(turn))
            .and_then(|entry| entry.question_id.clone());
        if let (Some(question), Some(asked)) = (question, asked.as_deref())
            && asked != question
        {
            return Ok(false);
        }
        let target = self.dir(id).join("traces").join(format!("{turn}.json"));
        let temporary_name = format!("{turn}.json.{}.tmp", js::random_uuid());
        blocking(move || -> io::Result<bool> {
            let previous: Option<(Vec<u8>, Vec<TurnTraceItem>)> = std::fs::read(&target)
                .ok()
                .and_then(|bytes| Some((bytes.clone(), serde_json::from_slice(&bytes).ok()?)));
            let seen: std::collections::HashMap<String, u64> = previous
                .iter()
                .flat_map(|(_, items)| items.iter())
                .filter_map(|item| match item {
                    TurnTraceItem::Call {
                        id, at: Some(at), ..
                    } => Some((id.clone(), *at)),
                    _ => None,
                })
                .collect();
            let merged: Vec<TurnTraceItem> = trace
                .into_iter()
                .map(|item| match item {
                    TurnTraceItem::Call { id, tool, done, at } if seen.contains_key(&id) => {
                        let first = seen[&id];
                        TurnTraceItem::Call {
                            at: Some(at.map_or(first, |at| at.min(first))),
                            id,
                            tool,
                            done,
                        }
                    }
                    other => other,
                })
                .collect();
            let json = serde_json::to_vec(&merged).map_err(io::Error::other)?;
            if json.len() > MAX_TRACE_FILE_BYTES
                || previous.as_ref().is_some_and(|(bytes, _)| *bytes == json)
            {
                return Ok(false);
            }
            let folder = target
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_default();
            std::fs::create_dir_all(&folder)?;
            let temporary = folder.join(&temporary_name);
            let written = std::fs::write(&temporary, &json)
                .and_then(|()| std::fs::rename(&temporary, &target));
            if written.is_err() {
                let _ = std::fs::remove_file(&temporary);
            }
            written.map(|()| true)
        })
        .await
        .and_then(|result| result)
        .map_err(|error| error.to_string())
    }
}
