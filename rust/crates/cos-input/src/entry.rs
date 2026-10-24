//! What one outbox row says about itself (`shared/input.ts` and the row predicates of
//! `session/input.ts`). Pure: no clock, no session, no disk.

use cos_types::session::ReasoningEffort;
use cos_types::state::{
    InputEntry, InputMode, InputPurpose, InputState, ToolDelivery, TransportIntent,
};
use serde::Serialize;

/// `manualInput`: a message the person sent now. A native upload that waits for a browser
/// boundary keeps its immediate intent through `requestedMode`.
pub fn manual_input(row: &InputEntry) -> bool {
    row.requested_mode.unwrap_or(row.mode) == InputMode::Auto
        && row.finish_owner.is_none()
        && row.purpose != Some(InputPurpose::Decision)
        && row.attachment_delivery != Some(ToolDelivery::Tool)
}

/// `queuedFollowup`: a message that waits for its chat's turn to end.
pub fn queued_followup(row: &InputEntry) -> bool {
    row.opening.is_none()
        && !manual_input(row)
        && (row.mode == InputMode::Finish
            || (row.mode == InputMode::AfterTurn
                && row.session_id.is_some()
                && row.purpose != Some(InputPurpose::Decision)))
}

/// `browserInputModel`: a finish task continues the chat on the page's own model.
pub fn browser_input_model(row: &InputEntry) -> (Option<String>, Option<ReasoningEffort>) {
    if row.mode == InputMode::Finish {
        (None, None)
    } else {
        (row.model.clone(), row.reasoning_effort)
    }
}

pub(crate) fn terminal(row: &InputEntry) -> bool {
    matches!(
        row.state,
        InputState::Sent | InputState::Cancelled | InputState::Failed
    )
}

/// Native Send was never authorized: the row was not claimed, or its claim still awaited
/// authorization.
pub(crate) fn never_authorized(row: &InputEntry) -> bool {
    row.send_authorized_at.is_none()
        && (row.offered_at.is_none() || row.requires_authorization == Some(true))
}

/// `DeliveryProof`: what the row itself proves about delivery, and nothing more.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryProof {
    Sent,
    NotSent,
    Unconfirmed,
    Pending,
}

/// `deliveryProof`. `sent` needs the receipt; `not_sent` a terminal row whose Send was never
/// authorized; any other claim may have reached ChatGPT and is never resent.
pub fn delivery_proof(row: &InputEntry) -> DeliveryProof {
    if row.delivered_at.is_some() {
        return DeliveryProof::Sent;
    }
    if row.state == InputState::Sent {
        return DeliveryProof::Unconfirmed;
    }
    if terminal(row) {
        return if never_authorized(row) {
            DeliveryProof::NotSent
        } else {
            DeliveryProof::Unconfirmed
        };
    }
    if row.state == InputState::Queued
        || (row.state == InputState::Browser && never_authorized(row))
    {
        DeliveryProof::Pending
    } else {
        DeliveryProof::Unconfirmed
    }
}

/// `preparable`: a row a page may still claim, or re-claim before Send authorization.
pub(crate) fn preparable(row: &InputEntry) -> bool {
    row.state == InputState::Queued
        || (row.state == InputState::Browser
            && row.requires_authorization == Some(true)
            && row.send_authorized_at.is_none())
}

/// `needsHistory`: delivered or handed out, and not yet written into its session.
pub(crate) fn needs_history(row: &InputEntry) -> bool {
    row.purpose != Some(InputPurpose::Decision)
        && row.history_recorded != Some(true)
        && ((row.state == InputState::Tool && row.offered_at.is_some())
            || (matches!(row.state, InputState::Sent | InputState::Cancelled)
                && row.message_id.is_some()))
}

/// `pendingStages`: a sent plan whose checkpoints are not queued yet.
pub(crate) fn pending_stages(row: &InputEntry) -> bool {
    row.state == InputState::Sent
        && row.stages.as_ref().is_some_and(|stages| !stages.is_empty())
        && row.stages_applied != Some(true)
}

/// `ordered`: display and delivery order. Stable, as `Array.prototype.sort` is.
pub(crate) fn ordered(rows: &[InputEntry]) -> Vec<InputEntry> {
    let mut sorted = rows.to_vec();
    sorted.sort_by_key(|row| (row.queue_order.unwrap_or(row.due_at), row.created_at));
    sorted
}

/// `companionOf`: the root whose combined delivery carries this row.
pub(crate) fn companion_of<'a>(rows: &'a [InputEntry], row: &InputEntry) -> Option<&'a InputEntry> {
    rows.iter()
        .find(|root| root.companion_input_id.as_deref() == Some(row.id.as_str()))
}

/// `sameDelivery`: the root and the companion its claim carries.
pub(crate) fn same_delivery(root: &InputEntry, row: &InputEntry) -> bool {
    row.id == root.id || root.companion_input_id.as_deref() == Some(row.id.as_str())
}

pub(crate) fn intent_is(row: &InputEntry, intent: TransportIntent) -> bool {
    row.transport_intent == Some(intent)
}

pub(crate) fn decision(row: &InputEntry) -> bool {
    row.purpose == Some(InputPurpose::Decision)
}

/// Whether the provider model is ChatGPT's newest Pro lane (`isAstraModel`).
pub fn is_astra_model(model: Option<&str>, effort: Option<ReasoningEffort>) -> bool {
    let normalized = normalized_model(model);
    let family = strip_gpt(&normalized);
    let six = |rest: &str| rest == "6" || rest == "6.0";
    if normalized == "astra" {
        return true;
    }
    if let Some(family) = family {
        if let Some((head, tail)) = family.split_once('-')
            && six(head)
            && (tail == "pro" || tail == "astra")
        {
            return true;
        }
        if six(family) && effort == Some(ReasoningEffort::Pro) {
            return true;
        }
    }
    false
}

/// `isProModel`.
pub fn is_pro_model(model: Option<&str>, effort: Option<ReasoningEffort>) -> bool {
    if effort == Some(ReasoningEffort::Pro) || is_astra_model(model, effort) {
        return true;
    }
    let normalized = normalized_model(model);
    if normalized == "pro" {
        return true;
    }
    // `(?:gpt-?)?\d+(?:[.-]\d+)?-pro`
    let Some(family) = strip_gpt(&normalized) else {
        return false;
    };
    let Some(version) = family.strip_suffix("-pro") else {
        return false;
    };
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
    match version.find(['.', '-']) {
        None => digits(version),
        Some(at) => digits(&version[..at]) && digits(&version[at + 1..]),
    }
}

fn normalized_model(model: Option<&str>) -> String {
    let lower = model.unwrap_or_default().trim().to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut space = false;
    for ch in lower.chars() {
        if ch.is_whitespace() {
            if !space {
                out.push('-');
            }
            space = true;
        } else {
            out.push(ch);
            space = false;
        }
    }
    out
}

/// The text after an optional `gpt` or `gpt-` prefix; `None` when nothing is left.
fn strip_gpt(normalized: &str) -> Option<&str> {
    let rest = normalized
        .strip_prefix("gpt-")
        .or_else(|| normalized.strip_prefix("gpt"))
        .unwrap_or(normalized);
    (!rest.is_empty()).then_some(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pro_and_astra_follow_the_typescript_patterns() {
        assert!(is_astra_model(Some("GPT 6 Pro"), None));
        assert!(is_astra_model(Some("gpt-6.0-astra"), None));
        assert!(is_astra_model(Some("6"), Some(ReasoningEffort::Pro)));
        assert!(!is_astra_model(Some("gpt-6"), Some(ReasoningEffort::High)));
        assert!(is_pro_model(Some("gpt-5.5-pro"), None));
        assert!(is_pro_model(Some("o3"), Some(ReasoningEffort::Pro)));
        assert!(!is_pro_model(
            Some("GPT-5.6 Sol"),
            Some(ReasoningEffort::High)
        ));
        assert!(!is_pro_model(Some("gpt-6-thinking"), None));
    }
}
