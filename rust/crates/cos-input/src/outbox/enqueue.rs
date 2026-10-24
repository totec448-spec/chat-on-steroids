//! Admission: `enqueueInput`, `cancelInput`, the queue budgets and finish-plan stages.

use super::*;

impl Inner {
    pub(super) async fn enqueue(
        &self,
        rows: &mut Rows<'_>,
        mut input: InputArgs,
    ) -> Result<InputEntry, OutboxError> {
        if let Some(stages) = &input.stages {
            let mut plan = vec![input.text.clone()];
            plan.extend(stages.iter().cloned());
            let length = serde_json::to_string(&plan).map_or(0, |text| js_length(&text));
            if length > 12_000 {
                return refuse("Keep the complete plan below 12,000 characters");
            }
        }
        let current = self.load(rows).await?;
        if let Some(prior) = current.iter().find(|row| row.id == input.id) {
            if InputArgs::of_row(prior) != input {
                return refuse("Message id already belongs to different input");
            }
            if !terminal(prior) {
                self.materialize_opening(prior).await?;
            }
            return Ok(prior.clone());
        }
        // No session: the message opens a new chat, filed under its own id.
        let session_id = input.session_id.clone();
        let requested = match &session_id {
            Some(id) => self.session(id).await,
            None => None,
        };
        let now = self.now();
        let source_turn = requested.as_ref().and_then(active_turn);
        let queued_turn = match (&requested, &source_turn) {
            (Some(session), Some(turn)) => {
                session
                    .conversation_id
                    .clone()
                    .map(|conversation| QueuedTurn {
                        conversation_id: conversation,
                        turn_id: turn.clone(),
                        extra: Default::default(),
                    })
            }
            _ => None,
        };
        // A new chat has no policy; the default answers each question as `policy?.x` does.
        let mut policy = match &session_id {
            Some(id) => self.policy(id).await,
            None => Policy::default(),
        };
        let previous_opening = current
            .iter()
            .rev()
            .find(|row| row.opening.is_some() && row.session_id == session_id);
        // An explicit resend may replace a proven pre-send failure in the same unbound new chat.
        let retry_opening = requested.as_ref().is_some_and(|session| {
            session
                .origin
                .as_ref()
                .is_some_and(|origin| origin.kind == SessionOriginKind::Desktop)
                && session.conversation_id.is_none()
        }) && previous_opening
            .is_some_and(|row| terminal(row) && never_authorized(row));
        let requested_mode = input.mode;
        let has = |list: Option<usize>| list.unwrap_or(0) > 0;
        let attachments = has(input.attachments.as_ref().map(Vec::len));
        let images = has(input.images.as_ref().map(Vec::len));
        let stages = has(input.stages.as_ref().map(Vec::len));
        if input.delivery == Some(ToolDelivery::Tool)
            && input.attachment_delivery.is_none()
            && !attachments
            && !images
            && input.mode == InputMode::Auto
            && !stages
            && policy.direct_turn.is_some()
        {
            input.delivery = None;
        }
        let probe = input.clone().into_row(now);
        if !stages && composer_only_text(&probe, requested.as_ref()) {
            if input.delivery == Some(ToolDelivery::Tool) {
                input.delivery = None;
            }
            policy.can_inject = false;
        }
        let tool_delivery = input.delivery == Some(ToolDelivery::Tool)
            || input.attachment_delivery == Some(ToolDelivery::Tool);
        let mut tool_turn = None;
        if tool_delivery {
            let turn = policy
                .direct_turn
                .as_ref()
                .map(|turn| turn.id.clone())
                .or_else(|| policy.injection_turn_id.clone());
            let count = input.images.as_ref().map_or(0, Vec::len)
                + input.attachments.as_ref().map_or(0, Vec::len);
            if input.mode != InputMode::Auto || stages || turn.is_none() || count > MAX_INPUT_IMAGES
            {
                return refuse(&format!(
                    "Inject up to {MAX_INPUT_IMAGES} images into an active chat; otherwise use Send or After this turn"
                ));
            }
            if requested
                .as_ref()
                .and_then(|session| session.conversation_id.as_ref())
                .is_none()
            {
                return refuse("Inject into an active chat");
            }
            if attachments {
                return refuse(
                    "This build cannot inject files into a running turn yet; use Send or After this turn",
                );
            }
            tool_turn = turn;
        } else if attachments {
            crate::attachments::validate(
                &self.user_data,
                input.attachments.as_deref().unwrap_or(&[]),
            )
            .await
            .map_err(OutboxError)?;
            if input.mode == InputMode::Finish
                || (input.mode == InputMode::Auto
                    && (policy.can_inject || policy.direct_turn.is_some()))
            {
                input.mode = InputMode::AfterTurn;
            }
        } else if input.mode == InputMode::AfterTurn && policy.queue_at_finish {
            input.mode = InputMode::Finish;
        }
        if input.mode == InputMode::Finish || stages {
            let session = match &session_id {
                Some(id) => self.session(id).await,
                None => None,
            };
            if (input.mode == InputMode::Finish
                && session
                    .as_ref()
                    .and_then(|s| s.conversation_id.as_ref())
                    .is_none())
                || session.as_ref().is_some_and(worker_session)
            {
                return refuse("Queue staged tasks in a normal chat");
            }
        }
        let transport_intent = if tool_delivery {
            Some(TransportIntent::Tool)
        } else if attachments {
            Some(TransportIntent::Browser)
        } else if input.mode == InputMode::Auto {
            if policy.can_inject {
                Some(TransportIntent::Tool)
            } else if session_id.is_none() || policy.browser_allowed || policy.direct_turn.is_some()
            {
                Some(TransportIntent::Browser)
            } else {
                None
            }
        } else {
            None
        };
        let direct_turn = if !tool_delivery && input.mode == InputMode::Auto && input.due_at <= now
        {
            policy.direct_turn.clone()
        } else {
            None
        };
        let stack_direct = input.mode == InputMode::Auto && policy.can_inject;
        let project = input.project_id.clone().flatten();
        let final_mode = input.mode;
        let mut entry = input.into_row(now);
        entry.queued_turn = queued_turn;
        entry.direct_turn = direct_turn;
        entry.tool_turn_id = tool_turn.clone();
        entry.transport_intent = transport_intent;
        if requested_mode != final_mode {
            entry.requested_mode = Some(requested_mode);
        }
        if let Some(project) = &project {
            let Some(session_id) = &session_id else {
                return refuse(NO_PROJECT_OPENING);
            };
            if self
                .session(session_id)
                .await
                .and_then(|session| session.project_id)
                .as_deref()
                != Some(project)
            {
                return refuse("Message project does not match the session");
            }
        }
        if retry_opening {
            entry.opening = Some(True);
            entry.requested_session_id = Some(session_id.clone());
        }
        entry.conversation_id = self.target(&entry).await.map_err(OutboxError)?;
        if session_id.is_none() {
            entry.opening = Some(True);
            entry.session_id = Some(entry.id.clone());
        }
        if let (Some(turn), Some(session_id)) = (&tool_turn, &session_id) {
            let policy = self.policy(session_id).await;
            let current_turn = policy
                .direct_turn
                .map(|turn| turn.id)
                .or(policy.injection_turn_id);
            if current_turn.as_ref() != Some(turn) {
                return refuse(if entry.delivery == Some(ToolDelivery::Tool) {
                    "The active chat changed while preparing injection; send again"
                } else {
                    "The active chat changed while preparing images; send again"
                });
            }
        }
        // User input supersedes only automatic work that has never been handed out.
        let prioritized: Vec<InputEntry> = current
            .iter()
            .map(|row| {
                if row.session_id == entry.session_id
                    && ((row.finish_owner.is_some() && row.state == InputState::Queued)
                        || (row.recovery.is_some()
                            && !terminal(row)
                            && row.send_authorized_at.is_none()))
                {
                    InputEntry {
                        state: InputState::Cancelled,
                        error: Some("Replaced by your new instruction before delivery.".into()),
                        ..row.clone()
                    }
                } else {
                    row.clone()
                }
            })
            .collect();
        let mut next = append(prioritized, entry.clone(), stack_direct)?;
        if entry.mode == InputMode::Finish {
            next = materialize_stages(next, &entry);
        }
        self.commit(rows, next.clone()).await?;
        if let Err(error) = self.materialize_opening(&entry).await {
            let failed = next
                .into_iter()
                .map(|row| {
                    if row.id == entry.id {
                        InputEntry {
                            error: Some(js_slice(&format!("{SETUP_FAILED}{error}"), 200)),
                            ..row
                        }
                    } else {
                        row
                    }
                })
                .collect();
            self.commit(rows, failed).await?;
            return Err(error);
        }
        Ok(next
            .into_iter()
            .find(|row| row.id == entry.id)
            .unwrap_or(entry))
    }

    pub(super) async fn cancel(&self, rows: &mut Rows<'_>, id: &str) -> Result<bool, OutboxError> {
        let current = self.load(rows).await?;
        let Some(selected) = current.iter().find(|row| row.id == id) else {
            return Ok(false);
        };
        let found = companion_of(&current, selected).unwrap_or(selected).clone();
        if !matches!(
            found.state,
            InputState::Queued | InputState::Browser | InputState::Failed | InputState::Cancelled
        ) {
            return Ok(false);
        }
        let error = |entry: &InputEntry| {
            match found.state {
            InputState::Browser => Some(
                if found.requires_authorization == Some(true) && found.send_authorized_at.is_none()
                {
                    "Not sent: this delivery was cancelled before Send was authorized."
                } else {
                    "Cancelled locally. Delivery to ChatGPT is unconfirmed; the message may already have been sent."
                }
                .to_owned(),
            ),
            InputState::Queued => None,
            _ => entry.error.clone(),
        }
        };
        let next = current
            .iter()
            .map(|entry| {
                if same_delivery(&found, entry) {
                    InputEntry {
                        state: InputState::Cancelled,
                        cancelled_by_user: Some(True),
                        error: error(entry),
                        ..entry.clone()
                    }
                } else {
                    entry.clone()
                }
            })
            .collect();
        self.commit(rows, next).await?;
        Ok(true)
    }
}

/// `append`: admission per durable session, then the queue's size budgets and history trim.
fn append(
    current: Vec<InputEntry>,
    mut entry: InputEntry,
    stack_direct: bool,
) -> Result<Vec<InputEntry>, OutboxError> {
    if queued_followup(&entry) {
        let positioned: Vec<u64> = current
            .iter()
            .filter(|row| {
                row.session_id == entry.session_id
                    && queued_followup(row)
                    && !terminal(row)
                    && row.queue_order.is_some()
            })
            .filter_map(|row| row.queue_order)
            .collect();
        if let Some(max) = positioned.iter().max() {
            entry.queue_order = Some(max + 1);
        }
    }
    if !stack_direct
        && !decision(&entry)
        && !queued_followup(&entry)
        && current.iter().any(|row| {
            row.session_id == entry.session_id
                && !decision(row)
                && !(entry.finish_owner.is_none()
                    && row.finish_owner.is_some()
                    && row.state == InputState::Tool)
                && (!queued_followup(row) || row.state == InputState::Browser)
                && matches!(
                    row.state,
                    InputState::Queued | InputState::Browser | InputState::Tool
                )
        })
    {
        return refuse(
            "One message is already awaiting delivery. Cancel it before sending another.",
        );
    }
    let active: Vec<InputEntry> = current
        .iter()
        .filter(|row| !terminal(row) || needs_history(row) || pending_stages(row))
        .cloned()
        .collect();
    let queued_bytes = |row: &InputEntry| {
        let reserved = if row.stages_applied == Some(true) {
            Vec::new()
        } else {
            row.stages.clone().unwrap_or_default()
        };
        let probe = InputEntry {
            images: None,
            tool_images: None,
            stages: Some(reserved),
            ..row.clone()
        };
        serde_json::to_vec(&probe).map_or(0, |bytes| bytes.len())
    };
    if active
        .iter()
        .chain([&entry])
        .map(queued_bytes)
        .sum::<usize>()
        > 1_024_000
    {
        return refuse("The message queue is full");
    }
    let image_bytes = |row: &InputEntry| -> usize {
        let images: usize = row
            .images
            .iter()
            .chain(row.tool_images.iter())
            .flatten()
            .map(|image| image.data_url.len())
            .sum();
        let previews: usize = row
            .attachments
            .iter()
            .flatten()
            .map(|file| file.preview.as_ref().map_or(0, String::len))
            .sum();
        images + previews
    };
    if active
        .iter()
        .chain([&entry])
        .map(image_bytes)
        .sum::<usize>()
        > 4 * 1024 * 1024
    {
        return refuse("The image queue is full");
    }
    let finished: Vec<InputEntry> = current
        .iter()
        .filter(|row| terminal(row) && !needs_history(row) && !pending_stages(row))
        .cloned()
        .collect();
    let mut history: Vec<InputEntry> = finished[finished.len().saturating_sub(50)..].to_vec();
    let bytes = |row: &InputEntry| {
        row.text.len()
            + row.delivery_text.as_ref().map_or(0, String::len)
            + row.response.as_ref().map_or(0, String::len)
            + serde_json::to_vec(&row.stages.clone().unwrap_or_default()).map_or(2, |b| b.len())
            + image_bytes(row)
    };
    let mut retained_bytes: usize = history
        .iter()
        .chain(active.iter())
        .chain([&entry])
        .map(bytes)
        .sum();
    while !history.is_empty() && retained_bytes > 2_048_000 {
        retained_bytes -= bytes(&history.remove(0));
    }
    let retained: HashSet<String> = history
        .iter()
        .chain(active.iter())
        .chain([&entry])
        .map(|row| row.id.clone())
        .collect();
    let mut next: Vec<InputEntry> = history
        .iter()
        .filter(|row| {
            let root = companion_of(&current, row);
            row.companion_input_id
                .as_ref()
                .is_none_or(|companion| retained.contains(companion))
                && root.is_none_or(|root| retained.contains(&root.id))
        })
        .cloned()
        .collect();
    next.extend(active.iter().cloned());
    next.extend(
        current
            .iter()
            .filter(|row| {
                !retained.contains(&row.id)
                    && active.iter().any(|root| {
                        same_delivery(root, row)
                            || row.companion_input_id.as_deref() == Some(root.id.as_str())
                    })
            })
            .cloned(),
    );
    next.push(entry);
    Ok(next)
}

/// `materializeStages`: a finish plan's checkpoints, published together.
pub(super) fn materialize_stages(current: Vec<InputEntry>, entry: &InputEntry) -> Vec<InputEntry> {
    let session_id = entry
        .session_id
        .clone()
        .or_else(|| entry.delivered_session_id.clone().flatten());
    let (Some(session_id), Some(stages)) = (session_id, &entry.stages) else {
        return current;
    };
    if entry.stages_applied == Some(true) {
        return current;
    }
    let mut next: Vec<InputEntry> = current
        .into_iter()
        .map(|row| {
            if row.id == entry.id {
                InputEntry {
                    stages_applied: Some(true),
                    ..row
                }
            } else {
                row
            }
        })
        .collect();
    for (index, text) in stages.iter().enumerate() {
        let at = entry.created_at + index as u64;
        let mut stage = InputArgs {
            project_id: entry.project_id.clone(),
            automation: None,
            loop_after_turn: None,
            objective: None,
            authored_source: Some(cos_types::state::AuthoredSource::None),
            stages: None,
            images: None,
            attachments: None,
            delivery: None,
            attachment_delivery: None,
            id: random_uuid(),
            session_id: Some(session_id.clone()),
            text: text.clone(),
            mode: InputMode::Finish,
            after_turn: None,
            due_at: at,
            model: None,
            reasoning_effort: None,
        }
        .into_row(at);
        stage.conversation_id = entry.conversation_id.clone();
        stage.queued_turn = entry.queued_turn.clone();
        // Over budget, the stage stays out exactly as TypeScript's throw would leave it.
        if let Ok(appended) = append(next.clone(), stage, false) {
            next = appended;
        }
    }
    next
}

fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        use std::hash::{BuildHasher, RandomState};
        let high = RandomState::new().hash_one(std::time::Instant::now());
        let low = RandomState::new().hash_one(std::process::id());
        bytes[..8].copy_from_slice(&high.to_le_bytes());
        bytes[8..].copy_from_slice(&low.to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
