//! The time rules: unclaimed pickups, unauthorized preparation, unconfirmed sends, and
//! receipts whose session was deleted.

use super::*;

impl Inner {
    /// `retireRemovedSessionReceipts`: a delivered row is kept until its session is deleted.
    pub(super) async fn retire_removed_session_receipts(
        &self,
        rows: &mut Rows<'_>,
        current: Vec<InputEntry>,
        pending_only: bool,
    ) -> Result<Vec<InputEntry>, OutboxError> {
        let mut missing: HashMap<String, bool> = HashMap::new();
        let mut removed: HashSet<String> = HashSet::new();
        for row in &current {
            let Some(session) = row
                .session_id
                .clone()
                .or_else(|| row.delivered_session_id.clone().flatten())
            else {
                continue;
            };
            if decision(row)
                || !matches!(row.state, InputState::Sent | InputState::Cancelled)
                || row.message_id.is_none()
                || row.delivered_at.is_none()
                || (pending_only && !needs_history(row) && !pending_stages(row))
            {
                continue;
            }
            if !missing.contains_key(&session) {
                let dir = self.user_data.join("sessions").join(&session);
                let gone = tokio::task::spawn_blocking(move || !dir.is_dir())
                    .await
                    .unwrap_or(false);
                missing.insert(session.clone(), gone);
            }
            if missing.get(&session) == Some(&true) {
                removed.insert(row.id.clone());
            }
        }
        for row in &current {
            if let Some(companion) = &row.companion_input_id
                && removed.contains(&row.id) != removed.contains(companion)
            {
                removed.remove(&row.id);
                removed.remove(companion);
            }
        }
        if removed.is_empty() {
            return Ok(current);
        }
        let next: Vec<InputEntry> = current
            .into_iter()
            .filter(|row| !removed.contains(&row.id))
            .collect();
        self.commit(rows, next.clone()).await?;
        Ok(next)
    }

    /// `expireQueued`: the time rules, committed when one applies.
    pub(super) async fn expire(
        &self,
        rows: &mut Rows<'_>,
        current: Vec<InputEntry>,
    ) -> Result<Vec<InputEntry>, OutboxError> {
        let now = self.now();
        let mut next = Vec::with_capacity(current.len());
        for row in &current {
            next.push(self.expired(&current, row, now));
        }
        for index in 0..next.len() {
            if let Some(root) = companion_of(&next, &next[index]).cloned()
                && root.state != next[index].state
            {
                next[index].state = root.state;
                next[index].error = root.error;
            }
        }
        if next != current {
            self.commit(rows, next.clone()).await?;
        }
        Ok(next)
    }

    fn expired(&self, current: &[InputEntry], row: &InputEntry, now: u64) -> InputEntry {
        if companion_of(current, row).is_some() || decision(row) {
            return row.clone();
        }
        if row.state == InputState::Queued
            && row.mode == InputMode::Auto
            && row.opening.is_none()
            && row.finish_owner.is_none()
            && row.silence_boundary.is_none()
            && (intent_is(row, TransportIntent::Browser)
                || (row.transport_intent.is_none() && row.session_id.is_none()))
            && !row
                .error
                .as_deref()
                .is_some_and(|error| error.starts_with("Message queued. "))
            && now.saturating_sub(row.created_at.max(row.due_at)) >= UNCLAIMED_PICKUP_MS
        {
            return InputEntry {
                state: InputState::Failed,
                pickup_failed_at: Some(now),
                error: Some(PICKUP_TIMED_OUT.into()),
                ..row.clone()
            };
        }
        let companion = current
            .iter()
            .find(|other| Some(&other.id) == row.companion_input_id.as_ref());
        let has = |list: Option<usize>| list.unwrap_or(0) > 0;
        if row.state == InputState::Browser
            && row.send_authorized_at.is_none()
            && row.requires_authorization == Some(true)
        {
            let files = has(row.attachments.as_ref().map(Vec::len))
                || has(companion.and_then(|c| c.attachments.as_ref().map(Vec::len)));
            let images = has(row.images.as_ref().map(Vec::len))
                || has(companion.and_then(|c| c.images.as_ref().map(Vec::len)));
            let window = if files {
                720_000
            } else if images {
                120_000
            } else {
                60_000
            };
            if now.saturating_sub(row.offered_at.unwrap_or(row.created_at)) >= window {
                if row.recovery.is_some() {
                    return release_recovery_claim(row, None);
                }
                return InputEntry {
                    state: InputState::Cancelled,
                    error: Some(
                        "Not sent: browser preparation timed out. This attempt was cancelled."
                            .into(),
                    ),
                    ..row.clone()
                };
            }
        }
        if row.state == InputState::Browser
            && let Some(authorized) = row.send_authorized_at
        {
            let ordinary = row.recovery.is_none()
                && row.opening.is_none()
                && row.companion_input_id.is_none()
                && manual_input(row);
            let waited = now.saturating_sub(authorized);
            if (ordinary && waited >= UNCERTAIN_SEND_MS) || waited >= ABANDONED_SEND_MS {
                return InputEntry {
                    state: InputState::Cancelled,
                    error: Some(UNCONFIRMED_SEND.into()),
                    ..row.clone()
                };
            }
        }
        row.clone()
    }
}

/// `releaseRecoveryClaim`: an unauthorized Continue goes back to the queue with its reason.
pub(super) fn release_recovery_claim(row: &InputEntry, error: Option<&str>) -> InputEntry {
    let mut released = InputEntry {
        state: InputState::Queued,
        owner: None,
        offered_at: None,
        completed_turn_id: None,
        ..row.clone()
    };
    if let Some(error) = error {
        released.error = Some(js_slice(error, 200));
    }
    if let Some(recovery) = &mut released.recovery
        && recovery.phase != cos_types::state::RecoveryPhase::Ready
    {
        recovery.phase = cos_types::state::RecoveryPhase::Resumed;
    }
    released
}
