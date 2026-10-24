//! `listInputs` and the confirmed sends published as their chat's user messages.

use super::*;

impl Inner {
    pub(super) async fn list(&self, rows: &mut Rows<'_>) -> Result<Vec<InputEntry>, OutboxError> {
        let loaded = self.load(rows).await?;
        let current = self
            .retire_removed_session_receipts(rows, loaded, true)
            .await?;
        let mut next = Vec::with_capacity(current.len());
        for entry in &current {
            if !decision(entry)
                && (entry.state == InputState::Sent
                    || (entry.state == InputState::Cancelled && entry.delivered_at.is_some()))
                && entry.session_id.is_none()
                && entry.delivered_session_id.clone().flatten().is_none()
                && let Some(conversation) = &entry.conversation_id
                && let Some(session) = self.sessions.find_by_conversation(conversation, true)
            {
                next.push(InputEntry {
                    delivered_session_id: Some(Some(session.id.as_str().to_owned())),
                    ..entry.clone()
                });
            } else {
                next.push(entry.clone());
            }
        }
        for entry in next.clone() {
            if entry.state == InputState::Sent {
                next = materialize_stages(next, &entry);
            }
        }
        if next != current {
            self.commit(rows, next).await?;
        }
        self.publish_history(rows).await?;
        let current = self.load(rows).await?;
        Ok(ordered(&current))
    }

    /// `publishHistory`: a confirmed browser send becomes its chat's user message. A failure is
    /// retried by the next read, never by a second send.
    pub(super) async fn publish_history(&self, rows: &mut Rows<'_>) -> Result<(), OutboxError> {
        let current = self.load(rows).await?;
        let mut recorded: HashSet<String> = HashSet::new();
        let mut anchored: HashMap<String, u64> = HashMap::new();
        let record = self.config.borrow().sessions.record;
        for row in &current {
            if !needs_history(row) || companion_of(&current, row).is_some() {
                continue;
            }
            let companion = row
                .companion_input_id
                .as_ref()
                .and_then(|id| current.iter().find(|other| &other.id == id));
            let combined = combined_input(row, companion);
            let outcome = if record {
                self.record_delivered(&combined).await
            } else {
                Some(None)
            };
            let Some(seq) = outcome else {
                continue;
            };
            recorded.insert(row.id.clone());
            if let Some(companion) = &row.companion_input_id {
                recorded.insert(companion.clone());
            }
            if let Some(seq) = seq {
                anchored.insert(row.id.clone(), seq);
                if let Some(companion) = &row.companion_input_id {
                    anchored.insert(companion.clone(), seq);
                }
            }
        }
        let stale_anchor = current.iter().any(|row| {
            anchored.get(&row.id).is_some_and(|seq| {
                row.history_anchored != Some(true) || row.history_seq != Some(*seq)
            })
        });
        if recorded.is_empty() && !stale_anchor {
            return Ok(());
        }
        let next = current
            .iter()
            .map(|row| {
                let mut row = row.clone();
                if recorded.contains(&row.id) {
                    row.history_recorded = Some(true);
                }
                if let Some(seq) = anchored.get(&row.id) {
                    row.history_anchored = Some(true);
                    row.history_seq = Some(*seq);
                }
                row
            })
            .collect();
        // The durable delivery receipt remains either way; canonical retry is idempotent.
        let _ = self.commit(rows, next).await;
        Ok(())
    }

    /// `recordDeliveredInput` for a confirmed browser send: `Some(anchor)` once written,
    /// `None` to retry later. A tool handout has no owner in this build.
    async fn record_delivered(&self, entry: &InputEntry) -> Option<Option<u64>> {
        let confirmed = matches!(entry.state, InputState::Sent | InputState::Cancelled)
            && entry.message_id.is_some()
            && entry.delivered_at.is_some();
        let session_id = entry
            .session_id
            .clone()
            .or_else(|| entry.delivered_session_id.clone().flatten());
        let (Some(session_id), true) = (session_id, confirmed && !decision(entry)) else {
            return None;
        };
        let message_id = entry.message_id.clone()?;
        let delivered_at = entry.delivered_at?;
        let time = if message_id.starts_with("input:") {
            entry.offered_at.unwrap_or(delivered_at)
        } else {
            delivered_at
        };
        let id = SessionId::parse(&session_id).ok()?;
        self.sessions.summary(&id).await?;
        let text = entry
            .delivery_text
            .clone()
            .unwrap_or_else(|| entry.text.clone());
        let (model, effort) = browser_input_model(entry);
        if !message_id.starts_with("input:")
            && let (Some(model), Some(conversation)) = (&model, &entry.conversation_id)
        {
            let _ = self
                .sessions
                .observe_model(&id, conversation, model, delivered_at, effort)
                .await;
        }
        let selected = !message_id.starts_with("input:") && model.is_some();
        let chars = js_length(&text) as u64;
        let event = SessionEvent::UserMessage(UserMessageEvent {
            base: EventBase {
                model: if selected { model.clone() } else { None },
                reasoning_effort: if selected { effort } else { None },
                seq: 0,
                time,
                authored_at: None,
                turn_origin: None,
                source: EventSource::App,
                agent: None,
                turn_id: None,
            },
            message: StoredText {
                text: text.clone(),
                truncated: false,
                chars,
                asset_id: None,
                digest: None,
                extra: Default::default(),
            },
            message_id: Some(message_id),
            input_id: Some(entry.id.clone()),
            input_delivery: Some(InputDelivery::Confirmed),
            authored_text: Some(entry.text.clone()),
            wire_token_estimate: Some(JsNumber(chars.div_ceil(4) as f64)),
            reaction: None,
            attachments: entry
                .attachments
                .clone()
                .filter(|files| !files.is_empty() && !intent_is(entry, TransportIntent::Tool)),
            assets: None,
            retired_image_asset_ids: None,
            origin: None,
            content_seq: None,
            extra: Default::default(),
        });
        let upserted = self
            .sessions
            .upsert_message(&id, event, UpsertOptions::default())
            .await
            .ok()?;
        let base = upserted.event.base();
        let origin = match &upserted.event {
            SessionEvent::UserMessage(message) => message.origin,
            _ => None,
        };
        Some(Some(origin.unwrap_or(base.seq)))
    }
}
