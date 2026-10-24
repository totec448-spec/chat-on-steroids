//! What a page may take: the `/status` offers, the exclusive claim and the Send authorization.

use super::*;

impl Inner {
    pub(super) async fn pending(&self, rows: &mut Rows<'_>) -> Result<Vec<Offer>, OutboxError> {
        let current = self.load(rows).await?;
        let now = self.now();
        let mut result = Vec::new();
        for entry in ordered(&current) {
            if companion_of(&current, &entry).is_some() || !preparable(&entry) || entry.due_at > now
            {
                continue;
            }
            if queued_followup(&entry)
                && !(entry.state == InputState::Browser && entry.completed_turn_id.is_some())
                && self
                    .completed_stage_boundary(&entry, &current)
                    .await
                    .is_none()
            {
                continue;
            }
            if !self.browser_input_allowed(&entry).await {
                continue;
            }
            let Ok(conversation) = self.target(&entry).await else {
                continue;
            };
            let mut silence_turn = entry
                .silence_boundary
                .as_ref()
                .map(|boundary| boundary.turn_id.clone());
            if silence_turn.is_none()
                && manual_input(&entry)
                && let Some(session_id) = &entry.session_id
                && let Some(end) = self.boundary(session_id).await
                && !end.start
                && end.outcome == Some(cos_types::session::TurnOutcome::Failed)
                && end.thinking_failed
                && end.turn_id.is_some()
                && self.eligible_stage_end(&entry).await == end.turn_id
            {
                silence_turn = end.turn_id;
            }
            let mut offer = Map::new();
            offer.insert("id".into(), json!(entry.id));
            offer.insert("conversationId".into(), json!(conversation));
            if let Some(recovery) = &entry.recovery {
                let stop = entry
                    .silence_boundary
                    .as_ref()
                    .is_some_and(|boundary| boundary.native_busy == Some(true))
                    && recovery.phase == cos_types::state::RecoveryPhase::Ready;
                offer.insert(
                    "recovery".into(),
                    json!({ "questionId": recovery.question_id, "stop": stop }),
                );
            }
            if let Some(turn) = silence_turn {
                offer.insert("silenceTurnId".into(), json!(turn));
            }
            if let Some(direct) = &entry.direct_turn {
                offer.insert("directTurn".into(), json!(direct));
            }
            if entry.state == InputState::Queued
                && !decision(&entry)
                && entry.session_id.is_some()
                && entry.conversation_id.is_some()
                && entry.conversation_id != conversation
            {
                offer.insert(
                    "supersededConversationId".into(),
                    json!(entry.conversation_id),
                );
            }
            if let Some(lifetime) = entry.lifetime {
                offer.insert("lifetime".into(), json!(lifetime));
            }
            result.push(Value::Object(offer));
        }
        Ok(result)
    }

    pub(super) async fn claim(
        &self,
        rows: &mut Rows<'_>,
        id: &str,
        owner: &str,
        conversation: Option<&str>,
        requires_authorization: bool,
    ) -> Result<Option<Value>, OutboxError> {
        let current = self.load(rows).await?;
        let now = self.now();
        let Some(entry) = current.iter().find(|row| row.id == id).cloned() else {
            return Ok(None);
        };
        if !preparable(&entry)
            || (entry.state == InputState::Browser && !requires_authorization)
            || entry.due_at > now
            || owner.is_empty()
        {
            return Ok(None);
        }
        if let Some(recovery) = &entry.recovery
            && ((entry.state == InputState::Browser && entry.owner.as_deref() != Some(owner))
                || recovery.reload_owner.as_deref() == Some(owner))
        {
            return Ok(None);
        }
        if companion_of(&current, &entry).is_some() {
            return Ok(None);
        }
        let completed_turn = if entry.state == InputState::Browser {
            entry.completed_turn_id.clone()
        } else if queued_followup(&entry) {
            self.completed_stage_boundary(&entry, &current).await
        } else if manual_input(&entry) {
            self.eligible_stage_end(&entry).await
        } else {
            None
        };
        if queued_followup(&entry) && completed_turn.is_none() {
            return Ok(None);
        }
        if self.target(&entry).await.ok().flatten().as_deref() != conversation {
            return Ok(None);
        }
        if !self.browser_input_allowed(&entry).await {
            return Ok(None);
        }
        // A Goal helper's waiter lives in the process that asked; none exists here.
        if decision(&entry) {
            return Ok(None);
        }
        if let Some(session_id) = &entry.session_id {
            if current.iter().any(|row| {
                !same_delivery(&entry, row)
                    && row.session_id.as_ref() == Some(session_id)
                    && matches!(row.state, InputState::Browser | InputState::Tool)
            }) {
                return Ok(None);
            }
            let sorted = ordered(&current);
            let first = sorted.iter().find(|row| {
                row.session_id.as_ref() == Some(session_id)
                    && row.state == InputState::Queued
                    && queued_followup(row) == queued_followup(&entry)
                    && row.due_at <= now
            });
            if entry.state == InputState::Queued
                && !queued_followup(&entry)
                && first.map(|row| &row.id) != Some(&entry.id)
            {
                return Ok(None);
            }
        }
        let session = match &entry.session_id {
            Some(id) => self.session(id).await,
            None => None,
        };
        let companion = match &entry.companion_input_id {
            Some(companion_id) => {
                let companion = current.iter().find(|row| &row.id == companion_id).cloned();
                match companion {
                    Some(companion)
                        if companion.state == InputState::Browser
                            && companion.owner == entry.owner
                            && companion.session_id == entry.session_id =>
                    {
                        Some(companion)
                    }
                    _ => return Ok(None),
                }
            }
            None => None,
        };
        let (model, effort) = browser_input_model(&entry);
        let settings = self.config.borrow().ui.clone();
        let observed = session
            .as_ref()
            .and_then(|session| session.selected_model.as_ref())
            .filter(|selected| Some(selected.conversation_id.as_str()) == conversation);
        let astra = match &model {
            Some(model) => crate::entry::is_astra_model(Some(model), effort),
            None => observed.is_some_and(|selected| {
                crate::entry::is_astra_model(Some(&selected.model), selected.reasoning_effort)
            }),
        };
        let instruction = if settings.finish_tool == Some(true)
            && !decision(&entry)
            && !session.as_ref().is_some_and(helper_or_worker_session)
            && astra
        {
            finish_instruction(settings.finish_lead_minutes)
        } else {
            String::new()
        };
        let suffix = if !instruction.is_empty() && !entry.text.contains(&instruction) {
            format!("\n\n{instruction}")
        } else {
            String::new()
        };
        let mut claimed = combined_input(&entry, companion.as_ref());
        if let Some(companion) = &companion {
            claimed.companion_input_id = Some(companion.id.clone());
        }
        if let Some(turn) = &completed_turn {
            claimed.completed_turn_id = Some(turn.clone());
        }
        if intent_is(&entry, TransportIntent::Tool) {
            claimed.transport_intent = Some(TransportIntent::Browser);
        }
        claimed.state = InputState::Browser;
        claimed.owner = Some(owner.to_owned());
        claimed.conversation_id = conversation.map(str::to_owned);
        claimed.offered_at = Some(entry.offered_at.unwrap_or(now));
        claimed.requires_authorization = Some(requires_authorization);
        let prepared = match prepare(claimed, &suffix, settings.finish_lead_minutes) {
            Ok(prepared) => prepared,
            Err(error) => {
                if entry.state == InputState::Queued {
                    let failed: Vec<InputEntry> = current
                        .iter()
                        .map(|row| {
                            if row.id == entry.id {
                                InputEntry {
                                    state: InputState::Failed,
                                    error: Some(js_slice(&error.0, 200)),
                                    ..row.clone()
                                }
                            } else {
                                row.clone()
                            }
                        })
                        .collect();
                    self.commit(rows, failed).await?;
                }
                return Err(error);
            }
        };
        let claimed = InputEntry {
            text: entry.text.clone(),
            images: entry.images.clone(),
            attachments: entry.attachments.clone(),
            ..prepared
        };
        let next: Vec<InputEntry> = current
            .iter()
            .map(|row| {
                if row.id == entry.id {
                    claimed.clone()
                } else if companion.as_ref().is_some_and(|c| c.id == row.id) {
                    InputEntry {
                        state: InputState::Browser,
                        owner: Some(owner.to_owned()),
                        conversation_id: conversation.map(str::to_owned),
                        offered_at: claimed.offered_at,
                        requires_authorization: Some(requires_authorization),
                        completed_turn_id: claimed.completed_turn_id.clone(),
                        ..row.clone()
                    }
                } else {
                    row.clone()
                }
            })
            .collect();
        self.commit(rows, next).await?;
        self.logger.info(&format!(
            "input {id}: browser claimed after {} ms",
            now.saturating_sub(entry.created_at)
        ));
        let mut reply = combined_input(&claimed, companion.as_ref());
        reply.model = model;
        reply.reasoning_effort = effort;
        reply.text = claimed
            .delivery_text
            .clone()
            .unwrap_or(claimed.text.clone());
        let mut reply = serde_json::to_value(&reply).unwrap_or(Value::Null);
        if let Some(object) = reply.as_object_mut() {
            // `{ ...row, ...selection }`: the selection is always present, `null` included.
            object.insert("model".into(), json!(claimed_model(&entry).0));
            object.insert("reasoningEffort".into(), json!(claimed_model(&entry).1));
        }
        Ok(Some(reply))
    }

    pub(super) async fn authorize(
        &self,
        rows: &mut Rows<'_>,
        id: &str,
        owner: &str,
        conversation: Option<&str>,
    ) -> Result<bool, OutboxError> {
        let current = self.load(rows).await?;
        let Some(row) = current
            .iter()
            .find(|row| {
                row.id == id
                    && row.owner.as_deref() == Some(owner)
                    && row.state == InputState::Browser
                    && row.conversation_id.as_deref() == conversation
            })
            .cloned()
        else {
            return Ok(false);
        };
        if row.send_authorized_at.is_some() || companion_of(&current, &row).is_some() {
            return Ok(false);
        }
        if !self.browser_input_allowed(&row).await
            || self.target(&row).await.ok().flatten().as_deref() != conversation
        {
            return Ok(false);
        }
        if let Some(companion_id) = &row.companion_input_id {
            let companion = current.iter().find(|other| {
                &other.id == companion_id
                    && other.state == InputState::Browser
                    && other.owner.as_deref() == Some(owner)
                    && other.session_id == row.session_id
            });
            let session = match &row.session_id {
                Some(id) => self.session(id).await,
                None => None,
            };
            let ready = match (companion, &session) {
                (Some(companion), Some(session)) => queued_after_turn(
                    &InputEntry {
                        state: InputState::Queued,
                        ..companion.clone()
                    },
                    session,
                    self.now(),
                ),
                _ => false,
            };
            if !ready {
                return Ok(false);
            }
        }
        let now = self.now();
        let next = current
            .iter()
            .map(|entry| {
                if same_delivery(&row, entry) {
                    InputEntry {
                        send_authorized_at: Some(now),
                        ..entry.clone()
                    }
                } else {
                    entry.clone()
                }
            })
            .collect();
        self.commit(rows, next).await?;
        // Automatic Continue needs its live source proof again after the write, which this
        // build cannot give (see `eligible_stage_end`).
        Ok(row.recovery.is_none())
    }
}

/// The model a claimed row asks the page to select (`browserInputModel`).
fn claimed_model(
    entry: &InputEntry,
) -> (Option<String>, Option<cos_types::session::ReasoningEffort>) {
    browser_input_model(entry)
}

/// `queuedAfterTurn`.
pub(crate) fn queued_after_turn(
    row: &InputEntry,
    session: &cos_types::session::SessionSummary,
    now: u64,
) -> bool {
    row.session_id.as_deref() == Some(session.id.as_str())
        && (queued_followup(row) || (manual_input(row) && row.offered_at.is_none()))
        && row.state == InputState::Queued
        && row.due_at <= now
        && (row.mode != InputMode::Finish || row.after_turn == Some(true) || !astra_chat(session))
}

/// `prepare`: freeze the exact transport bytes with the claim. A follow-up in an existing chat
/// is its text; Skill and Goal framing need owners this build does not have.
fn prepare(
    entry: InputEntry,
    suffix: &str,
    lead_minutes: Option<u8>,
) -> Result<InputEntry, OutboxError> {
    if decision(&entry) {
        return Ok(entry);
    }
    let text = if let Some(stages) = entry
        .stages
        .as_ref()
        .filter(|_| entry.mode != InputMode::Finish)
    {
        let mut steps = vec![entry.text.clone()];
        steps.extend(stages.iter().cloned());
        let numbered: Vec<String> = steps
            .iter()
            .enumerate()
            .map(|(index, stage)| format!("{}. {stage}", index + 1))
            .collect();
        format!(
            "Original user request:\n{}\n\nComplete workflow:\n{}\n\nBegin the complete implementation now. Later queued messages are verification checkpoints; do not wait for them to learn or implement requirements. Carry out and verify each received checkpoint before asking for the next one with session_finish; never call it repeatedly just to collect the queue.",
            entry
                .objective
                .clone()
                .filter(|objective| !objective.is_empty())
                .unwrap_or_else(|| entry.text.clone()),
            numbered.join("\n\n")
        )
    } else if let Some(objective) = entry
        .objective
        .as_ref()
        .filter(|objective| !objective.is_empty())
        && (entry.opening.is_some() || entry.session_id.is_none())
    {
        format!(
            "Original user request:\n{objective}\n\nOpening instruction:\n{}\n\nFollow the complete original request, including all constraints, throughout this task.",
            entry.text
        )
    } else {
        entry.text.clone()
    };
    let delivery_text = entry
        .delivery_text
        .clone()
        .unwrap_or_else(|| format!("{text}{suffix}"));
    let envelope = format!(
        "{TOOL_INPUT_HEADER}{delivery_text}\n\n{}",
        finish_instruction(lead_minutes)
    );
    if delivery_text.is_empty()
        || js_length(&delivery_text) > crate::args::MAX_CHATGPT_MESSAGE_CHARS
        || utf8_len(&envelope) > TOOL_INPUT_TEXT_BYTES
    {
        return refuse("Prepared message exceeds the delivery limit; shorten the request or plan");
    }
    Ok(InputEntry {
        delivery_text: Some(delivery_text),
        ..entry
    })
}
