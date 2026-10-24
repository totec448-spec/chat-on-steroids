//! What a page posted, rebuilt into observations the recorder is willing to store
//! (`parseObservations`, `parseCallEvidence` and `conversationId` in `bridge.ts`).
//!
//! The extension reads an undocumented page that can change under it, so nothing from it is
//! trusted structurally: every field is rebuilt rather than copied, unknown kinds are dropped,
//! text is capped, and an impossible clock becomes `now`. The functions are pure; the caller
//! passes the clock.

use cos_types::bridge::{
    AppSighting, ObservationKind, PageCallEvidence, PageObservation, PageTraceItem,
};
use cos_types::json::JsNumber;
use cos_types::session::{
    ChatErrorReason, MessageState, ReasoningEffort, TurnOutcome, TurnTraceItem,
};
use serde_json::{Map, Value};

use crate::message;

const MAX_OBSERVATIONS: usize = 200;
/// Connector requests accepted from one turn. Far above any real turn's call count.
const MAX_CALL_EVIDENCE: usize = 200;
/// `Date.UTC(2022, 10, 30)`: nothing ChatGPT wrote predates it.
const EARLIEST_CHATGPT: f64 = 1_669_766_400_000.0;
const MAX_TEXT: usize = 256_000;

/// `value.slice(0, max)`: the first `max` UTF-16 code units, never splitting a pair.
pub(crate) fn js_slice(value: &str, max: usize) -> String {
    let mut units = 0;
    let mut end = value.len();
    for (index, character) in value.char_indices() {
        units += character.len_utf16();
        if units > max {
            end = index;
            break;
        }
    }
    value[..end].to_owned()
}

fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn all_bytes(value: &str, min: usize, max: usize, allowed: impl Fn(u8) -> bool) -> bool {
    (min..=max).contains(&value.len()) && value.bytes().all(allowed)
}

/// `conversationId`: ChatGPT conversation ids are uuid-shaped; anything else is not one.
pub fn conversation_id(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    all_bytes(value, 8, 64, |b| b.is_ascii_hexdigit() || b == b'-').then(|| value.to_owned())
}

fn uuid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `/^[a-z0-9][a-z0-9._-]{0,63}$/i`.
fn model_slug(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_alphanumeric())
        && all_bytes(value, 1, 64, |b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')
        })
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn string(item: &Map<String, Value>, key: &str) -> Option<String> {
    item.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_enum<T: serde::de::DeserializeOwned>(value: Option<&Value>) -> Option<T> {
    serde_json::from_value(value?.clone()).ok()
}

/// `parseCallEvidence`. With `untooled`, a sighting with no tool name is kept as long as it
/// carries a request id: the request-id join never uses the name.
pub fn parse_call_evidence(input: Option<&Value>, untooled: bool) -> Vec<PageCallEvidence> {
    let Some(rows) = input.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<PageCallEvidence> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut duplicated = std::collections::HashSet::new();
    for raw in rows.iter().take(MAX_CALL_EVIDENCE) {
        let Some(item) = raw.as_object() else {
            continue;
        };
        let tool = string(item, "tool")
            .filter(|tool| {
                all_bytes(tool, 1, 64, |b| {
                    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')
                })
            })
            .unwrap_or_default();
        let request_id = string(item, "requestId").filter(|id| {
            all_bytes(id, 1, 100, |b| {
                b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')
            })
        });
        let page_message_id = string(item, "messageId")
            .map(|id| js_slice(&id, 120))
            .unwrap_or_default();
        let bare = untooled && request_id.is_some();
        if tool.is_empty() && !bare {
            continue;
        }
        // A stream origin has no message to name, so it gets one deterministic, explicitly
        // non-provider identity; the request id stays the only ownership key.
        let stream = bare && page_message_id.is_empty();
        let message_id = match (&request_id, stream) {
            (Some(request), true) => format!("stream:{request}"),
            _ => page_message_id,
        };
        if message_id.is_empty() {
            continue;
        }
        if !seen.insert(message_id.clone()) {
            if !stream {
                duplicated.insert(message_id);
            }
            continue;
        }
        let order = finite(item.get("order"))
            .map(|order| order.floor().clamp(0.0, MAX_CALL_EVIDENCE as f64))
            .unwrap_or(out.len() as f64);
        out.push(PageCallEvidence {
            message_id: Some(Some(message_id)),
            tool: Some(tool),
            order: Some(JsNumber(order)),
            answered: Some(item.get("answered") == Some(&Value::Bool(true))),
            request_id: Some(request_id),
            create_time: Some(finite(item.get("createTime")).map(JsNumber)),
        });
    }
    out.retain(|call| {
        call.message_id
            .clone()
            .flatten()
            .is_none_or(|id| !duplicated.contains(&id))
    });
    out
}

/// The message id a parsed call evidence row carries (always present after parsing).
pub fn evidence_message_id(call: &PageCallEvidence) -> &str {
    call.message_id
        .as_ref()
        .and_then(Option::as_deref)
        .unwrap_or("")
}

/// The request id a parsed call evidence row carries.
pub fn evidence_request_id(call: &PageCallEvidence) -> Option<&str> {
    call.request_id.as_ref().and_then(Option::as_deref)
}

pub(crate) fn empty_observation(kind: ObservationKind, time: f64) -> PageObservation {
    PageObservation {
        kind,
        time: JsNumber(time),
        apps: None,
        model: None,
        reasoning_effort: None,
        authored_time: None,
        authored_at: None,
        authored_now: None,
        active_now: None,
        text: None,
        attachments: None,
        reaction: None,
        rendered_html: None,
        message_id: None,
        provider_message_id: None,
        resolved_model: None,
        references: None,
        provider_asset_id: None,
        provider_role: None,
        provider_channel: None,
        provider_status: None,
        width: None,
        height: None,
        preview_width: None,
        preview_height: None,
        preview_status: None,
        preview_error: None,
        preview_data_url: None,
        turn_id: None,
        trace: None,
        question: None,
        is_final: None,
        state: None,
        fiber_conversation_id: None,
        outcome: None,
        reason: None,
        continued: None,
        detail: None,
        goal_eligible: None,
        recoverable: None,
        blocking: None,
        retry_at: None,
        calls: None,
    }
}

fn app_sightings(item: &Map<String, Value>) -> Vec<AppSighting> {
    let Some(apps) = item.get("apps").and_then(Value::as_array) else {
        return Vec::new();
    };
    apps.iter()
        .take(200)
        .filter_map(|raw| {
            let app = raw.as_object()?;
            let request_id = string(app, "requestId").map(|id| js_slice(&id, 100))?;
            let app_id = string(app, "appId").map(|id| js_slice(&id, 200))?;
            if request_id.is_empty() || app_id.is_empty() {
                return None;
            }
            Some(AppSighting {
                request_id,
                app_id,
                link_id: string(app, "linkId").map(|id| js_slice(&id, 200)),
                app_name: string(app, "appName").map(|name| js_slice(&name, 200)),
            })
        })
        .collect()
}

const MAX_TRACE_ITEMS: usize = 400;
const MAX_TRACE_SAY_CHARS: usize = 8000;
const MAX_TRACE_RECAP_CHARS: usize = 300;
const MAX_TRACE_TEXT_CHARS: usize = 128 * 1024;

/// `turnTrace`: an outline revalidated, bounded and typed, unknown items dropped. `None` when
/// nothing is left.
pub(crate) fn turn_trace(value: Option<&Value>) -> Option<Vec<TurnTraceItem>> {
    let rows = value?.as_array()?;
    let mut out = Vec::new();
    let mut room = MAX_TRACE_TEXT_CHARS;
    for raw in rows.iter().take(MAX_TRACE_ITEMS) {
        let Some(item) = raw.as_object() else {
            continue;
        };
        let id = string(item, "id").filter(|id| {
            all_bytes(id, 1, 200, |b| {
                b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-')
            })
        });
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or_default();
        let done = item.get("done") == Some(&Value::Bool(true));
        match kind {
            "say" | "recap" | "now" => {
                let limit = if kind == "say" {
                    MAX_TRACE_SAY_CHARS
                } else {
                    MAX_TRACE_RECAP_CHARS
                };
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| js_slice(text, limit))
                    .unwrap_or_default();
                let length = js_len(&text);
                if text.trim().is_empty() || length > room {
                    continue;
                }
                room -= length;
                out.push(match kind {
                    "say" => TurnTraceItem::Say { id, text, done },
                    "recap" => TurnTraceItem::Recap { text },
                    _ => TurnTraceItem::Now { text },
                });
            }
            "answer" => {
                if let Some(id) = id {
                    out.push(TurnTraceItem::Answer { id });
                }
            }
            "call" => {
                if let Some(id) = id {
                    let tool = string(item, "tool").filter(|tool| {
                        all_bytes(tool, 1, 100, |b| {
                            b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')
                        })
                    });
                    let at = finite(item.get("at"))
                        .filter(|at| *at > 0.0)
                        .map(|at| at.round() as u64);
                    out.push(TurnTraceItem::Call { id, tool, done, at });
                }
            }
            "exec" => {
                if let Some(id) = id {
                    out.push(TurnTraceItem::Exec { id, done });
                }
            }
            _ => {}
        }
    }
    (!out.is_empty()).then_some(out)
}

/// `parseObservations` at the clock `now` (epoch milliseconds).
///
pub fn parse_observations(input: Option<&Value>, now: f64) -> Vec<PageObservation> {
    let Some(rows) = input.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for raw in rows.iter().take(MAX_OBSERVATIONS) {
        let Some(item) = raw.as_object() else {
            continue;
        };
        let Some(kind) = string_enum::<ObservationKind>(item.get("kind")) else {
            continue;
        };
        let time = finite(item.get("time")).unwrap_or(now);
        let time = if time > now + 60_000.0 || time < EARLIEST_CHATGPT {
            now
        } else {
            time
        };
        let mut observation = empty_observation(kind, time);
        if kind == ObservationKind::AppSightings {
            observation.apps = Some(app_sightings(item));
            out.push(observation);
            continue;
        }
        if kind == ObservationKind::NativeImage
            && !crate::native_image::parse(item, &mut observation)
        {
            continue;
        }
        let message = matches!(
            kind,
            ObservationKind::AssistantMessage | ObservationKind::UserMessage
        );
        if item.get("authoredTime") == Some(&Value::Bool(true)) {
            observation.authored_time = Some(true);
        }
        if message
            && let Some(at) = finite(item.get("authoredAt"))
            && (EARLIEST_CHATGPT..=now + 60_000.0).contains(&at)
        {
            observation.authored_at = Some(JsNumber(at));
        }
        if item.get("authoredNow") == Some(&Value::Bool(true))
            && kind == ObservationKind::UserMessage
        {
            observation.authored_now = Some(true);
        }
        if let Some(active) = item.get("activeNow").and_then(Value::as_bool)
            && matches!(
                kind,
                ObservationKind::AssistantMessage | ObservationKind::PageTool
            )
        {
            observation.active_now = Some(active);
        }
        if kind == ObservationKind::ModelSelection {
            let Some(model) = string(item, "model").filter(|model| {
                all_bytes(model, 1, 80, |b| {
                    b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'_' | b'-')
                })
            }) else {
                continue;
            };
            observation.model = Some(model);
            observation.reasoning_effort =
                string_enum::<ReasoningEffort>(item.get("reasoningEffort"));
        }
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            observation.text = Some(js_slice(text, MAX_TEXT));
        }
        if kind == ObservationKind::UserMessage
            && let Some(model) = string(item, "model").filter(|model| model_slug(model))
        {
            observation.model = Some(model);
        }
        if kind == ObservationKind::UserMessage
            && item.get("messageId").is_some_and(Value::is_string)
        {
            match item.get("reaction") {
                Some(Value::Null) => observation.reaction = Some(None),
                Some(value) => observation.reaction = message::reaction(value).map(Some),
                None => {}
            }
        }
        if kind == ObservationKind::UserMessage
            && let Some(files) = item.get("attachments")
        {
            observation.attachments = message::attachments(files);
        }
        if let Some(id) = item.get("messageId").and_then(Value::as_str) {
            if id.is_empty() || js_len(id) > 190 {
                continue;
            }
            observation.message_id = Some(id.to_owned());
        }
        let completed_end = kind == ObservationKind::TurnEnd
            && item.get("outcome").and_then(Value::as_str) == Some("completed");
        if (kind == ObservationKind::AssistantMessage || completed_end)
            && let Some(id) = string(item, "providerMessageId").filter(|id| uuid(id))
        {
            observation.provider_message_id = Some(id);
        }
        if kind == ObservationKind::AssistantMessage
            && let Some(references) = item.get("references")
        {
            observation.references = message::references(references);
        }
        if kind == ObservationKind::AssistantMessage
            && let Some(model) = string(item, "resolvedModel").filter(|model| model_slug(model))
        {
            observation.resolved_model = Some(model);
        }
        if let Some(turn) = item.get("turnId").and_then(Value::as_str) {
            observation.turn_id = Some(js_slice(turn, 100));
        }
        if kind == ObservationKind::TurnTrace {
            let (Some(trace), Some(_)) = (turn_trace(item.get("trace")), &observation.turn_id)
            else {
                continue;
            };
            observation.trace = Some(trace.into_iter().map(PageTraceItem::Readable).collect());
            observation.question = string(item, "question").filter(|question| {
                all_bytes(question, 1, 200, |b| {
                    b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-')
                })
            });
        }
        if let Some(html) = item.get("renderedHtml").and_then(Value::as_str) {
            let final_assistant = kind == ObservationKind::AssistantMessage
                && item.get("state").and_then(Value::as_str) == Some("final")
                && item.get("final") == Some(&Value::Bool(true));
            observation.rendered_html = Some(js_slice(
                html,
                if final_assistant { MAX_TEXT } else { 120_000 },
            ));
        }
        observation.state = match item.get("state").and_then(Value::as_str) {
            Some("streaming") => Some(MessageState::Streaming),
            Some("final") => Some(MessageState::Final),
            _ => None,
        };
        if item.get("fiberConversationId").is_some() {
            observation.fiber_conversation_id = conversation_id(item.get("fiberConversationId"));
        }
        if item.get("final") == Some(&Value::Bool(true)) {
            observation.is_final = Some(true);
        }
        observation.outcome = string_enum::<TurnOutcome>(item.get("outcome"));
        let reason = item.get("reason").and_then(Value::as_str);
        if ((kind == ObservationKind::TurnEnd && observation.outcome == Some(TurnOutcome::Failed))
            || kind == ObservationKind::ChatError)
            && reason == Some("thinking_failed")
        {
            observation.reason = Some(ChatErrorReason::ThinkingFailed);
        }
        if kind == ObservationKind::ChatError && reason == Some("stream_gone") {
            observation.reason = Some(ChatErrorReason::StreamGone);
        }
        if item.get("goalEligible") == Some(&Value::Bool(true))
            && kind == ObservationKind::AssistantMessage
            && item.get("final") == Some(&Value::Bool(true))
            && item.get("state").and_then(Value::as_str) == Some("final")
        {
            observation.goal_eligible = Some(true);
        }
        if let Some(detail) = item.get("detail").and_then(Value::as_str) {
            observation.detail = Some(js_slice(detail, 500));
        }
        if kind == ObservationKind::TurnEnd && item.get("continued") == Some(&Value::Bool(true)) {
            observation.continued = Some(true);
        }
        observation.recoverable = item.get("recoverable").and_then(Value::as_bool);
        if item.get("blocking") == Some(&Value::Bool(true)) {
            observation.blocking = Some(true);
        }
        if kind == ObservationKind::ChatError
            && observation.blocking == Some(true)
            && let Some(retry) = finite(item.get("retryAt"))
            && retry > time
            && retry - time <= 24.0 * 60.0 * 60_000.0
        {
            observation.retry_at = Some(JsNumber(retry.floor()));
        }
        if item.get("calls").is_some_and(Value::is_array) {
            observation.calls = Some(parse_call_evidence(item.get("calls"), false));
        }
        out.push(observation);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: f64 = 1_767_225_600_000.0;

    #[test]
    fn drops_unknown_kinds_and_replaces_impossible_clocks_with_now() {
        let parsed = parse_observations(
            Some(&json!([
                { "kind": "mystery", "time": NOW },
                { "kind": "turn_start", "turnId": "a", "time": NOW + 120_000.0 },
                { "kind": "turn_start", "turnId": "b", "time": 1_000.0 },
                { "kind": "turn_start", "turnId": "c", "time": NOW - 5.0 },
            ])),
            NOW,
        );
        let times: Vec<f64> = parsed.iter().map(|item| item.time.0).collect();
        assert_eq!(times, [NOW, NOW, NOW - 5.0]);
    }

    #[test]
    fn caps_text_and_refuses_overlong_message_ids() {
        let parsed = parse_observations(
            Some(&json!([
                { "kind": "user_message", "time": NOW, "messageId": "m".repeat(191), "text": "x" },
                { "kind": "user_message", "time": NOW, "messageId": "ok", "text": "y".repeat(300_000) },
            ])),
            NOW,
        );
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text.as_deref().map(str::len), Some(MAX_TEXT));
    }

    #[test]
    fn a_model_selection_needs_a_well_formed_model() {
        let parsed = parse_observations(
            Some(&json!([
                { "kind": "model_selection", "time": NOW, "model": "gpt<script>" },
                { "kind": "model_selection", "time": NOW, "model": "GPT-5.6 Sol", "reasoningEffort": "high" },
                { "kind": "model_selection", "time": NOW, "model": "gpt-6", "reasoningEffort": "warp" },
            ])),
            NOW,
        );
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(parsed[1].reasoning_effort, None);
    }

    #[test]
    fn bare_request_ids_count_only_for_correlations() {
        let calls = json!([
            { "requestId": "wfr_one", "messageId": null },
            { "requestId": "bad id!", "tool": "read", "messageId": "m2" },
            { "tool": "read", "messageId": "m3", "requestId": "wfr_three", "createTime": 1767225600 },
        ]);
        assert_eq!(parse_call_evidence(Some(&calls), false).len(), 2);
        let bare = parse_call_evidence(Some(&calls), true);
        assert_eq!(evidence_message_id(&bare[0]), "stream:wfr_one");
        assert_eq!(evidence_request_id(&bare[1]), None);
        assert_eq!(bare[2].order, Some(JsNumber(2.0)));
    }

    #[test]
    fn a_reused_page_message_id_drops_both_sides() {
        let calls = json!([
            { "tool": "read", "messageId": "same", "requestId": "a" },
            { "tool": "exec_command", "messageId": "same", "requestId": "b" },
            { "tool": "read", "messageId": "other", "requestId": "c" },
        ]);
        let parsed = parse_call_evidence(Some(&calls), false);
        assert_eq!(parsed.len(), 1);
        assert_eq!(evidence_request_id(&parsed[0]), Some("c"));
    }

    #[test]
    fn conversation_ids_are_uuid_shaped() {
        assert!(conversation_id(Some(&json!("efefefef-1111-2222-3333-000000000093"))).is_some());
        assert!(conversation_id(Some(&json!("not a uuid"))).is_none());
        assert!(conversation_id(Some(&json!(42))).is_none());
    }
}

#[cfg(test)]
mod trace_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_the_readable_items_of_a_turn_outline() {
        let parsed = parse_observations(
            Some(
                &json!([{ "kind": "turn_trace", "time": 1_767_225_600_000.0, "turnId": "g-942-0-1", "trace": [
                { "kind": "say", "text": "First command printed one.", "done": true },
                { "kind": "call", "id": "call-1", "tool": "exec_command", "done": true, "at": 1_767_225_600_000.0 },
                { "kind": "recap", "text": "Ran the first command" },
                { "kind": "say", "text": "Second.", "done": false },
                { "kind": "mystery", "text": "x" },
                { "kind": "call", "tool": "read" }
            ] }]),
            ),
            1_767_225_600_000.0,
        );
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].trace.as_ref().map(Vec::len), Some(4));
    }
}
