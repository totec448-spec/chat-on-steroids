//! What a page reports back: the ACK, a failure, a new chat's bind and a deleted chat.

use super::*;

impl Inner {
    pub(super) async fn acknowledge(
        &self,
        rows: &mut Rows<'_>,
        id: &str,
        owner: &str,
        conversation: Option<Option<&str>>,
        message_id: Option<&str>,
    ) -> Result<bool, OutboxError> {
        let current = self.load(rows).await?;
        let Some(entry) = current
            .iter()
            .find(|row| row.id == id && row.owner.as_deref() == Some(owner))
            .cloned()
        else {
            return Ok(false);
        };
        if companion_of(&current, &entry).is_some() {
            return Ok(false);
        }
        if owner.is_empty()
            || !matches!(
                entry.state,
                InputState::Browser
                    | InputState::Sent
                    | InputState::Decision
                    | InputState::Cancelled
            )
            || (entry.state == InputState::Cancelled && decision(&entry))
        {
            return Ok(false);
        }
        let planner = entry.lifetime == Some(InputLifetime::TemporaryPlanner);
        if let Some(reported) = conversation
            && !(planner && reported.is_none())
            && !reported.is_some_and(provider_conversation)
        {
            return Ok(false);
        }
        let reported = conversation.flatten();
        if let (Some(reported), Some(known)) = (reported, &entry.conversation_id)
            && reported != known
        {
            return Ok(false);
        }
        if (entry.opening.is_some() || entry.session_id.is_none())
            && !decision(&entry)
            && reported.is_none()
            && entry.conversation_id.is_none()
        {
            return Ok(false);
        }
        if message_id.is_some_and(|id| id.is_empty() || js_length(id) > 256) {
            return Ok(false);
        }
        if (entry.state != InputState::Browser && entry.state != InputState::Cancelled)
            || (entry.state == InputState::Cancelled && entry.delivered_at.is_some())
        {
            self.publish_history(rows).await?;
            return Ok(true);
        }
        let delivered_conversation = reported
            .map(str::to_owned)
            .or(entry.conversation_id.clone());
        // A new chat's first receipt binds its reserved session to the chat ChatGPT made.
        if entry.opening.is_some()
            && let Some(conversation) = &delivered_conversation
        {
            if entry.state == InputState::Cancelled
                && entry.requires_authorization == Some(true)
                && entry.send_authorized_at.is_none()
            {
                return Ok(false);
            }
            if !self.bind_opening(&entry, conversation).await? {
                return Ok(false);
            }
        }
        let delivered = match (&entry.session_id, &delivered_conversation) {
            (Some(id), _) => self.session(id).await,
            (None, Some(conversation)) => self.sessions.find_by_conversation(conversation, true),
            _ => None,
        };
        let now = self.now();
        let cancelled = entry.state == InputState::Cancelled;
        let acknowledged = InputEntry {
            conversation_id: delivered_conversation,
            delivered_session_id: Some(delivered.map(|session| session.id.as_str().to_owned())),
            state: if cancelled {
                InputState::Cancelled
            } else if decision(&entry) {
                InputState::Decision
            } else {
                InputState::Sent
            },
            error: if cancelled {
                Some("Cancelled locally; delivery was later confirmed in ChatGPT.".into())
            } else {
                entry.error.clone()
            },
            message_id: message_id.map(str::to_owned).or(entry.message_id.clone()),
            delivered_at: Some(now),
            ..entry.clone()
        };
        let next = current
            .iter()
            .map(|row| {
                if row.id == entry.id {
                    acknowledged.clone()
                } else if entry.companion_input_id.as_deref() == Some(row.id.as_str()) {
                    InputEntry {
                        state: acknowledged.state,
                        error: acknowledged.error.clone(),
                        delivered_session_id: acknowledged.delivered_session_id.clone(),
                        message_id: acknowledged.message_id.clone(),
                        delivered_at: acknowledged.delivered_at,
                        ..row.clone()
                    }
                } else {
                    row.clone()
                }
            })
            .collect();
        self.commit(rows, next).await?;
        self.logger.info(&format!(
            "input {id}: browser acknowledged after {} ms",
            now.saturating_sub(entry.created_at)
        ));
        self.publish_history(rows).await?;
        Ok(true)
    }

    pub(super) async fn fail(
        &self,
        rows: &mut Rows<'_>,
        id: &str,
        owner: &str,
        error: &str,
        detail: Option<&str>,
    ) -> Result<bool, OutboxError> {
        let current = self.load(rows).await?;
        let Some(entry) = current
            .iter()
            .find(|row| {
                row.id == id
                    && row.owner.as_deref() == Some(owner)
                    && row.state == InputState::Browser
            })
            .cloned()
        else {
            return Ok(false);
        };
        if companion_of(&current, &entry).is_some() {
            return Ok(false);
        }
        let map = |change: &dyn Fn(&InputEntry) -> Option<InputEntry>| -> Vec<InputEntry> {
            current
                .iter()
                .map(|row| change(row).unwrap_or_else(|| row.clone()))
                .collect()
        };
        if entry.send_authorized_at.is_some() && error == RECEIPT_UNCONFIRMED {
            self.logger.warn(&format!(
                "input {}: native Send was clicked, but its receipt was not confirmed",
                entry.id
            ));
            let next = map(&|row| {
                same_delivery(&entry, row).then(|| InputEntry {
                    state: InputState::Cancelled,
                    error: Some(UNCONFIRMED_SEND.into()),
                    ..row.clone()
                })
            });
            self.commit(rows, next).await?;
            return Ok(true);
        }
        if entry.send_authorized_at.is_some() && error == SEND_NOT_TAKEN {
            let retry = entry.not_taken_retries.unwrap_or(0) == 0
                && manual_input(&entry)
                && entry.recovery.is_none()
                && entry.opening.is_none()
                && !decision(&entry)
                && entry.lifetime.is_none();
            self.logger.warn(&format!(
                "input {}: ChatGPT did not take the clicked Send; {}",
                entry.id,
                if retry {
                    "queued once more"
                } else {
                    "reported as not sent"
                }
            ));
            let next = map(&|row| {
                same_delivery(&entry, row).then(|| {
                    if retry {
                        InputEntry {
                            state: InputState::Queued,
                            owner: None,
                            offered_at: None,
                            send_authorized_at: None,
                            requires_authorization: None,
                            delivery_text: None,
                            error: None,
                            not_taken_retries: Some(row.not_taken_retries.unwrap_or(0) + 1),
                            ..row.clone()
                        }
                    } else {
                        InputEntry {
                            state: InputState::Failed,
                            error: Some(NOT_TAKEN_FAILED.into()),
                            ..row.clone()
                        }
                    }
                })
            });
            self.commit(rows, next).await?;
            return Ok(true);
        }
        if let Some(recovery) = &entry.recovery
            && entry.requires_authorization == Some(true)
            && entry.send_authorized_at.is_none()
        {
            let now = self.now();
            let since = recovery.withdrawn_since.unwrap_or(now);
            if now.saturating_sub(since) >= RECOVERY_WITHDRAW_LIMIT_MS {
                let message = js_slice(
                    &format!(
                        "Automatic Continue was not sent: {}",
                        detail.unwrap_or("withdrawn before Send")
                    ),
                    200,
                );
                let next = map(&|row| {
                    (row.id == entry.id).then(|| InputEntry {
                        state: InputState::Failed,
                        owner: None,
                        error: Some(message.clone()),
                        ..row.clone()
                    })
                });
                self.commit(rows, next).await?;
                return Ok(true);
            }
            let next = map(&|row| {
                (row.id == entry.id).then(|| {
                    let mut released = release_recovery_claim(row, Some(error));
                    if let Some(recovery) = &mut released.recovery {
                        recovery.withdrawn_since = Some(since);
                    }
                    released
                })
            });
            self.commit(rows, next).await?;
            return Ok(true);
        }
        if entry.recovery.is_some() && entry.send_authorized_at.is_some() {
            return Ok(false);
        }
        let pickup_cancelled = (entry.silence_boundary.is_some()
            || entry.completed_turn_id.is_some())
            && entry.requires_authorization == Some(true)
            && entry.send_authorized_at.is_none()
            && error == PICKUP_WITHDRAWN;
        let preserve =
            pickup_cancelled && self.eligible_stage_end(&entry).await == entry.completed_turn_id;
        let message = js_slice(error, 200);
        let next = map(&|row| {
            same_delivery(&entry, row).then(|| {
                if pickup_cancelled {
                    without_silence_claim(row, row.id == entry.id && preserve)
                } else {
                    InputEntry {
                        state: if entry.companion_input_id.is_some() {
                            InputState::Cancelled
                        } else {
                            InputState::Failed
                        },
                        error: Some(message.clone()),
                        ..row.clone()
                    }
                }
            })
        });
        self.commit(rows, next).await?;
        Ok(true)
    }

    pub(super) async fn bind(
        &self,
        rows: &mut Rows<'_>,
        id: &str,
        owner: &str,
        conversation: &str,
    ) -> Result<bool, OutboxError> {
        if owner.is_empty() || !provider_conversation(conversation) {
            return Ok(false);
        }
        let current = self.load(rows).await?;
        let Some(entry) = current
            .iter()
            .find(|row| row.id == id && row.owner.as_deref() == Some(owner))
            .cloned()
        else {
            return Ok(false);
        };
        let project = entry.project_id.clone().flatten();
        if !matches!(entry.state, InputState::Browser | InputState::Sent)
            || (entry.opening.is_none() && project.is_none())
            || decision(&entry)
        {
            return Ok(false);
        }
        if entry.requires_authorization == Some(true) && entry.send_authorized_at.is_none() {
            return Ok(false);
        }
        if entry
            .conversation_id
            .as_deref()
            .is_some_and(|known| known != conversation)
        {
            return Ok(false);
        }
        if self.sessions.conversation_superseded(conversation) {
            return Ok(false);
        }
        let bound = InputEntry {
            conversation_id: Some(conversation.to_owned()),
            ..entry.clone()
        };
        if entry.conversation_id.is_none() {
            let next = current
                .iter()
                .map(|row| {
                    if row.id == entry.id {
                        InputEntry {
                            conversation_id: Some(conversation.to_owned()),
                            ..row.clone()
                        }
                    } else {
                        row.clone()
                    }
                })
                .collect();
            self.commit(rows, next).await?;
        }
        if entry.opening.is_some() {
            return self.bind_opening(&bound, conversation).await;
        }
        // Binding a project to the new chat needs the projects owner this build does not have.
        Ok(false)
    }

    pub(super) async fn conversation_deleted(
        &self,
        rows: &mut Rows<'_>,
        conversation: &str,
    ) -> Result<u64, OutboxError> {
        let current = self.load(rows).await?;
        let mut ended = HashSet::new();
        for row in &current {
            if !matches!(row.state, InputState::Queued | InputState::Browser) {
                continue;
            }
            let destination = match &row.conversation_id {
                Some(known) => Some(known.clone()),
                None => self.target(row).await.ok().flatten(),
            };
            if destination.as_deref() == Some(conversation) {
                ended.insert(row.id.clone());
            }
        }
        if ended.is_empty() {
            return Ok(0);
        }
        let next = current
            .iter()
            .map(|row| {
                if ended.contains(&row.id) {
                    InputEntry {
                        state: InputState::Failed,
                        owner: None,
                        error: Some(CONVERSATION_DELETED.into()),
                        ..row.clone()
                    }
                } else {
                    row.clone()
                }
            })
            .collect();
        self.commit(rows, next).await?;
        Ok(ended.len() as u64)
    }
}

/// `withoutSilenceClaim`.
fn without_silence_claim(row: &InputEntry, preserve_boundary: bool) -> InputEntry {
    if row.recovery.is_some() {
        return InputEntry {
            state: InputState::Cancelled,
            error: Some("Automatic Continue cancelled by new activity.".into()),
            ..row.clone()
        };
    }
    InputEntry {
        state: InputState::Queued,
        owner: None,
        silence_boundary: if preserve_boundary {
            row.silence_boundary.clone()
        } else {
            None
        },
        completed_turn_id: None,
        transport_intent: if manual_input(row) {
            Some(TransportIntent::Tool)
        } else {
            row.transport_intent
        },
        companion_input_id: None,
        offered_at: None,
        send_authorized_at: None,
        requires_authorization: None,
        delivery_text: None,
        error: None,
        ..row.clone()
    }
}

/// `/^[0-9a-z-]{8,256}$/i`.
fn provider_conversation(text: &str) -> bool {
    (8..=256).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
