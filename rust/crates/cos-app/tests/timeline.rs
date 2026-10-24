//! The timeline model reads the newest page, then merges each live delta the way
//! `mergeDetailDelta` in `src/renderer/chat.ts` does. Events are the control API's real rows: a
//! tool call from the `base` corpus page, and messages built in the same shape.

use cos_app::timeline::{TIMELINE_BATCH, TimelinePage};
use cos_types::control_api::{ControlApiEvent, ControlApiEvents};
use serde_json::{Value, json};

fn corpus_tool_call() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../golden/base/api/session-events.json"
    );
    let text = std::fs::read_to_string(path).expect("the base corpus is checked in");
    let recorded: Value = serde_json::from_str(&text).expect("corpus JSON");
    let mut event = recorded["response"]["body"]["events"][0].clone();
    assert_eq!(event["kind"], "tool_call");
    numbers_for_placeholders(&mut event);
    event
}

/// The corpus masks clocks, durations and sizes; any number stands in for them here.
fn numbers_for_placeholders(value: &mut Value) {
    match value {
        Value::String(text) if ["<EPOCH_MS>", "<DURATION>", "<CHARS>"].contains(&text.as_str()) => {
            *value = json!(0);
        }
        Value::Object(map) => map.values_mut().for_each(numbers_for_placeholders),
        Value::Array(items) => items.iter_mut().for_each(numbers_for_placeholders),
        _ => {}
    }
}

fn tool_call(seq: u64, call: &str, outcome: &str) -> ControlApiEvent {
    let mut event = corpus_tool_call();
    event["seq"] = json!(seq);
    event["position"] = json!(seq);
    event["tool"]["callId"] = json!(call);
    event["tool"]["outcome"] = json!(outcome);
    serde_json::from_value(event).expect("a control API event")
}

fn message(seq: u64, position: u64, kind: &str, id: &str, text: &str) -> ControlApiEvent {
    serde_json::from_value(json!({
        "seq": seq, "position": position, "time": 0, "kind": kind, "source": "browser",
        "messageId": id, "message": { "text": text, "chars": text.len(), "truncated": false }
    }))
    .expect("a control API event")
}

fn note(seq: u64, position: u64) -> ControlApiEvent {
    serde_json::from_value(json!({
        "seq": seq, "position": position, "time": 0, "kind": "note", "source": "app"
    }))
    .expect("a control API event")
}

fn read(events: Vec<ControlApiEvent>, total: u64) -> ControlApiEvents {
    let next_from = events.iter().map(|event| event.seq + 1).max().unwrap_or(0);
    ControlApiEvents {
        events,
        total,
        next_from,
    }
}

fn seqs(page: &TimelinePage) -> Vec<u64> {
    page.events.iter().map(|event| event.seq).collect()
}

#[test]
fn opening_keeps_the_page_and_reads_deltas_after_it() {
    let page = TimelinePage::opened(read(vec![note(4, 4), tool_call(5, "a", "ok")], 6));
    assert_eq!(seqs(&page), [4, 5]);
    assert_eq!(page.total, 6);
    assert_eq!(page.cursor, 6);
}

#[test]
fn a_delta_appends_new_rows_and_moves_the_cursor() {
    let mut page = TimelinePage::opened(read(vec![note(1, 1)], 2));
    let more = page.merge(read(vec![tool_call(2, "a", "ok"), note(3, 3)], 4));
    assert!(!more, "a short delta means the tail is reached");
    assert_eq!(seqs(&page), [1, 2, 3]);
    assert_eq!((page.total, page.cursor), (4, 4));
}

#[test]
fn a_revised_message_or_tool_call_replaces_its_row() {
    let mut page = TimelinePage::opened(read(
        vec![
            message(1, 1, "assistant_message", "m1", "Hel"),
            tool_call(2, "call-1", "running"),
        ],
        2,
    ));
    page.merge(read(
        vec![
            message(3, 1, "assistant_message", "m1", "Hello"),
            tool_call(4, "call-1", "ok"),
        ],
        4,
    ));
    assert_eq!(seqs(&page), [3, 4], "one row each, revised in place");
    let text = page.events[0]
        .message
        .as_ref()
        .map(|text| text.text.as_str());
    assert_eq!(text, Some("Hello"));
    assert_eq!(
        page.events[1]
            .tool
            .as_ref()
            .map(|tool| tool.outcome.as_str()),
        Some("ok")
    );
}

#[test]
fn a_user_message_and_an_answer_with_one_id_stay_two_rows() {
    let mut page = TimelinePage::opened(read(vec![message(1, 1, "user_message", "x", "Hi")], 1));
    page.merge(read(
        vec![message(2, 2, "assistant_message", "x", "Hello")],
        2,
    ));
    assert_eq!(seqs(&page), [1, 2]);
}

#[test]
fn a_revision_older_than_the_page_stays_with_its_own_page() {
    let mut page = TimelinePage::opened(read(vec![note(10, 10), note(11, 11)], 12));
    page.merge(read(
        vec![
            message(12, 3, "user_message", "old", "edited"),
            note(13, 12),
        ],
        14,
    ));
    assert_eq!(seqs(&page), [10, 11, 13]);
    assert_eq!(page.cursor, 14, "the skipped row is still read past");
}

#[test]
fn a_full_delta_asks_for_another_read() {
    let mut page = TimelinePage::opened(read(Vec::new(), 0));
    let batch: Vec<ControlApiEvent> = (0..u64::from(TIMELINE_BATCH))
        .map(|seq| note(seq, seq))
        .collect();
    assert!(page.merge(read(batch, 40)));
    assert_eq!(page.cursor, u64::from(TIMELINE_BATCH));
}

#[test]
fn an_empty_delta_never_moves_the_cursor_back() {
    let mut page = TimelinePage::opened(read(vec![note(7, 7)], 8));
    assert!(!page.merge(read(Vec::new(), 8)));
    assert_eq!(page.cursor, 8);
    assert_eq!(seqs(&page), [7]);
}
