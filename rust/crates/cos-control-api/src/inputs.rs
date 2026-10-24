//! The message outbox as the control API sees it, as one seam: `cos_input::Outbox` in the Core,
//! a stand-in in this crate's tests. The outbox stays the only owner of what was admitted; the
//! API only projects its rows (`projectInput` and `selectInputs` in `control-reads.ts`).

use cos_input::{DeliveryProof, Outbox, delivery_proof};
use cos_tools::BoxFuture;
use cos_types::control_api::{ControlApiDelivery, ControlApiInput, ControlApiText};
use cos_types::state::{InputEntry, InputPurpose};
use serde::Serialize;
use serde_json::Value;

use crate::text::{clipped_line, js_length, line};

const TEXT_CAP: usize = 4_000;
const SUMMARY_CAP: usize = 300;

pub(crate) trait Inputs: Send + Sync + 'static {
    /// `sendDesktopInput`: the admitted row, or the outbox's own refusal text.
    fn enqueue(&self, input: Value) -> BoxFuture<'_, Result<InputEntry, String>>;
    /// `listInputs`.
    fn list(&self) -> BoxFuture<'_, Result<Vec<InputEntry>, String>>;
    /// `cancelDesktopInput`.
    fn cancel<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<bool, String>>;
    /// `!!sessionInputPolicy(session).directTurn`: the chat is writing an answer a send would end.
    fn answering<'a>(&'a self, session: &'a str) -> BoxFuture<'a, bool>;
}

impl Inputs for Outbox {
    fn enqueue(&self, input: Value) -> BoxFuture<'_, Result<InputEntry, String>> {
        Box::pin(async move { Outbox::enqueue(self, &input).await.map_err(|error| error.0) })
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<InputEntry>, String>> {
        Box::pin(async move { Outbox::list(self).await.map_err(|error| error.0) })
    }

    fn cancel<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move { Outbox::cancel(self, id).await.map_err(|error| error.0) })
    }

    fn answering<'a>(&'a self, session: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move { self.direct_turn(session).await.is_some() })
    }
}

/// The JSON word serde gives an enum the row stores.
fn word(value: &impl Serialize) -> Option<String> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
}

pub(crate) fn delivery(entry: &InputEntry) -> ControlApiDelivery {
    match delivery_proof(entry) {
        DeliveryProof::Sent => ControlApiDelivery::Sent,
        DeliveryProof::NotSent => ControlApiDelivery::NotSent,
        DeliveryProof::Unconfirmed => ControlApiDelivery::Unconfirmed,
        DeliveryProof::Pending => ControlApiDelivery::Pending,
    }
}

/// `projectInput`: the fields a caller may see, the text redacted and cut.
pub(crate) fn project_input(entry: &InputEntry) -> ControlApiInput {
    let (text, truncated) = clipped_line(&entry.text, TEXT_CAP);
    ControlApiInput {
        id: entry.id.clone(),
        session_id: entry.session_id.clone(),
        delivered_session_id: entry.delivered_session_id.clone().flatten(),
        conversation_id: entry.conversation_id.clone(),
        state: word(&entry.state).unwrap_or_default(),
        delivery: delivery(entry),
        mode: word(&entry.mode).unwrap_or_default(),
        transport_intent: entry.transport_intent.as_ref().and_then(word),
        // Filed by the app itself, not typed by anyone.
        automatic: entry.recovery.is_some() || entry.finish_owner.is_some(),
        purpose: entry.purpose.as_ref().and_then(word),
        created_at: entry.created_at,
        due_at: entry.due_at,
        offered_at: entry.offered_at,
        delivered_at: entry.delivered_at,
        send_authorized_at: entry.send_authorized_at,
        requires_authorization: entry.requires_authorization == Some(true),
        cancelled_by_user: entry.cancelled_by_user.is_some(),
        queue_order: entry.queue_order,
        model: entry.model.clone(),
        reasoning_effort: entry.reasoning_effort.as_ref().and_then(word),
        message_id: entry.message_id.clone(),
        error: entry
            .error
            .as_deref()
            .filter(|error| !error.is_empty())
            .map(|error| line(error, SUMMARY_CAP)),
        text: ControlApiText {
            text,
            chars: js_length(&entry.text) as u64,
            truncated,
        },
        attachments: entry.attachments.as_ref().map_or(0, Vec::len) as u64,
        images: entry.images.as_ref().map_or(0, Vec::len) as u64,
    }
}

/// `selectInputs`: the rows a caller may see, in some states, oldest first, the newest `limit`.
/// Ordered by creation, not by the queue's own order, so a cut drops the oldest.
pub(crate) fn select(
    rows: &[InputEntry],
    states: Option<&[&str]>,
    limit: usize,
) -> (Vec<ControlApiInput>, u64) {
    let mut matching: Vec<&InputEntry> = rows
        .iter()
        .filter(|row| row.purpose != Some(InputPurpose::Decision))
        .filter(|row| {
            states.is_none_or(|states| {
                word(&row.state).is_some_and(|state| states.contains(&state.as_str()))
            })
        })
        .collect();
    matching.sort_by_key(|row| row.created_at);
    let total = matching.len() as u64;
    let kept = &matching[matching.len().saturating_sub(limit)..];
    (kept.iter().map(|row| project_input(row)).collect(), total)
}
