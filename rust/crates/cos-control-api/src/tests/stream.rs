//! The event stream over real loopback HTTP (`test/control-api-stream.test.ts`).

use std::time::Duration;

use cos_types::control_api::EventStreamFrame;
use serde_json::json;

use super::client::{Connection, Sent, send};
use super::harness::{Harness, Options, note, session_row};
use crate::server::Timing;

const SESSION: &str = "2026-10-20-5e5e5e5e";

async fn recorded(timing: Timing) -> Harness {
    let harness = Harness::start(Options {
        timing,
        ..Options::default()
    })
    .await;
    harness.sessions.add(session_row(SESSION, None, None));
    harness.sessions.append(SESSION, note(1, "First"));
    harness.sessions.append(SESSION, note(2, "Second"));
    harness
}

fn stream(harness: &Harness, query: &str) -> Sent {
    Sent::get(&format!("/v1/sessions/{SESSION}/events/stream{query}"))
        .header("authorization", &harness.auth())
}

/// The whole frames received so far, parsed the way `EventStreamFrame` reads the app's stream.
fn frames(text: &str) -> Vec<EventStreamFrame> {
    let whole = &text[..text.rfind("\n\n").map_or(0, |end| end + 2)];
    if whole.is_empty() {
        return Vec::new();
    }
    EventStreamFrame::parse_stream(whole).expect("frames the app writes")
}

fn seqs(frames: &[EventStreamFrame]) -> Vec<u64> {
    frames
        .iter()
        .filter_map(|frame| match frame {
            EventStreamFrame::Event(event) => Some(event.seq),
            _ => None,
        })
        .collect()
}

fn count_events(text: &str) -> usize {
    seqs(&frames(text)).len()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sends_what_is_recorded_then_each_new_event_in_the_shape_of_the_paged_read() {
    let harness = recorded(Timing::default()).await;
    let paged = send(
        harness.port,
        &Sent::get(&format!("/v1/sessions/{SESSION}/events?from=0"))
            .header("authorization", &harness.auth()),
    )
    .await
    .json();
    let mut live = Connection::open(harness.port).await;
    let (status, headers) = live.open_stream(&stream(&harness, "?from=0")).await;
    assert_eq!(status, 200);
    let header = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    assert_eq!(
        header("content-type"),
        Some("text/event-stream; charset=utf-8")
    );
    assert_eq!(header("cache-control"), Some("no-store"));
    assert_eq!(header("connection"), Some("close"));
    let text = live.read_until(|text| count_events(text) >= 2).await;
    assert!(text.starts_with(": stream open\n\n"), "{text}");
    let first = frames(&text);
    let data: Vec<serde_json::Value> = first
        .iter()
        .filter_map(|frame| match frame {
            EventStreamFrame::Event(event) => Some(serde_json::to_value(event).expect("json")),
            _ => None,
        })
        .collect();
    assert_eq!(json!(data), paged["events"]);
    assert!(
        text.contains("id: 1\nevent: user_message\ndata: {"),
        "{text}"
    );

    harness.sessions.append(SESSION, note(3, "Third, live"));
    let text = live.read_until(|text| count_events(text) >= 3).await;
    assert_eq!(seqs(&frames(&text)), [1, 2, 3]);
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resumes_after_the_last_id_a_client_saw_and_filters_by_kind() {
    let harness = recorded(Timing::default()).await;
    harness.sessions.append(SESSION, note(3, "Third"));
    let mut resumed = Connection::open(harness.port).await;
    resumed
        .open_stream(&stream(&harness, "?from=0").header("last-event-id", "1"))
        .await;
    let text = resumed.read_until(|text| count_events(text) >= 2).await;
    assert_eq!(seqs(&frames(&text)), [2, 3]);

    let mut notes = Connection::open(harness.port).await;
    notes.open_stream(&stream(&harness, "?kinds=note")).await;
    let text = notes.read_until(|text| count_events(text) >= 1).await;
    assert_eq!(seqs(&frames(&text)), [2]);
    harness
        .sessions
        .append(SESSION, note(5, "Not for this stream"));
    harness.sessions.append(SESSION, note(6, "A note"));
    let text = notes.read_until(|text| count_events(text) >= 2).await;
    assert_eq!(seqs(&frames(&text)), [2, 6]);
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_what_it_cannot_stream_before_any_stream_starts() {
    let harness = recorded(Timing::default()).await;
    let auth = harness.auth();
    let refused = |sent: Sent| async move { send(harness.port, &sent).await };
    let missing = refused(
        Sent::get("/v1/sessions/2026-01-01-deadbeef/events/stream").header("authorization", &auth),
    )
    .await;
    assert_eq!(
        (missing.status, missing.error()),
        (404, "session_not_found".into())
    );
    assert_eq!(missing.header("connection"), Some("keep-alive"));
    let before = refused(stream(&harness, "?before=3")).await;
    assert_eq!(
        (before.status, before.json()["detail"].clone()),
        (400, json!("unknown parameter"))
    );
    for id in ["abc", "", "123456789", "-1"] {
        let bad = refused(stream(&harness, "").header("last-event-id", id)).await;
        assert_eq!(
            (bad.status, bad.json()["detail"].clone()),
            (400, json!("Last-Event-ID is not valid")),
            "{id:?}"
        );
    }
    let twice = refused(
        stream(&harness, "")
            .header("last-event-id", "1")
            .header("last-event-id", "2"),
    )
    .await;
    assert_eq!(twice.status, 400);
    assert_eq!(
        refused(Sent::get(&format!("/v1/sessions/{SESSION}/events/stream")))
            .await
            .status,
        401
    );
    let page = refused(stream(&harness, "").header("origin", "https://example.test")).await;
    assert_eq!(page.status, 403);
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn holds_four_streams_and_turns_the_next_one_away_until_one_closes() {
    let harness = recorded(Timing::default()).await;
    let mut held = Vec::new();
    for _ in 0..4 {
        let mut connection = Connection::open(harness.port).await;
        assert_eq!(connection.open_stream(&stream(&harness, "")).await.0, 200);
        held.push(connection);
    }
    let busy = send(harness.port, &stream(&harness, "")).await;
    assert_eq!((busy.status, busy.error()), (503, "busy".into()));
    drop(held.remove(0));
    let mut reopened = None;
    for _ in 0..100 {
        let mut connection = Connection::open(harness.port).await;
        let (status, _) = connection.open_stream(&stream(&harness, "")).await;
        if status == 200 {
            reopened = Some(connection);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        reopened.is_some(),
        "a closed stream never gave its place back"
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keeps_an_idle_stream_alive_and_ends_it_after_its_longest_life_with_a_reason() {
    let timing = Timing {
        heartbeat: Duration::from_millis(30),
        max_life: Duration::from_millis(200),
        ..Timing::default()
    };
    let harness = recorded(timing).await;
    let mut live = Connection::open(harness.port).await;
    live.open_stream(&stream(&harness, "?from=10000000")).await;
    let text = live.read_until(|_| false).await;
    let frames = frames(&text);
    assert_eq!(frames.first(), Some(&EventStreamFrame::Open));
    assert!(frames.contains(&EventStreamFrame::KeepAlive));
    assert_eq!(
        frames.last(),
        Some(&EventStreamFrame::End("max_duration".into()))
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opens_at_once_even_when_there_is_nothing_to_send_yet() {
    let harness = recorded(Timing::default()).await;
    let began = std::time::Instant::now();
    let mut live = Connection::open(harness.port).await;
    assert_eq!(
        live.open_stream(&stream(&harness, "?from=10000000"))
            .await
            .0,
        200
    );
    let text = live.read_until(|text| text.contains("\n\n")).await;
    assert!(began.elapsed() < Duration::from_secs(2));
    assert_eq!(text, ": stream open\n\n");
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ends_every_stream_when_the_api_stops_without_waiting_out_the_drain() {
    let harness = recorded(Timing::default()).await;
    let mut live = Connection::open(harness.port).await;
    live.open_stream(&stream(&harness, "?from=10000000")).await;
    live.read_until(|text| text.contains("\n\n")).await;
    let began = std::time::Instant::now();
    harness.set_config(false, false);
    let text = live.read_until(|_| false).await;
    assert_eq!(
        frames(&text).last(),
        Some(&EventStreamFrame::End("stopped".into()))
    );
    assert!(
        began.elapsed() < Duration::from_secs(2),
        "the stream held the listener open"
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_whose_session_goes_away_ends_with_session_gone() {
    let timing = Timing {
        poll: Duration::from_millis(30),
        ..Timing::default()
    };
    let harness = recorded(timing).await;
    let mut live = Connection::open(harness.port).await;
    live.open_stream(&stream(&harness, "")).await;
    live.read_until(|text| count_events(text) >= 2).await;
    harness.sessions.remove(SESSION);
    let text = live.read_until(|_| false).await;
    assert_eq!(
        frames(&text).last(),
        Some(&EventStreamFrame::End("session_gone".into()))
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backlog_longer_than_a_page_is_sent_whole() {
    let harness = recorded(Timing::default()).await;
    for seq in 3..=250 {
        harness.sessions.append(SESSION, note(seq, "backlog"));
    }
    let mut live = Connection::open(harness.port).await;
    live.open_stream(&stream(&harness, "")).await;
    let text = live.read_until(|text| count_events(text) >= 250).await;
    assert_eq!(seqs(&frames(&text)), (1..=250).collect::<Vec<_>>());
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_that_fails_mid_stream_ends_it_with_error() {
    let harness = recorded(Timing::default()).await;
    let mut live = Connection::open(harness.port).await;
    live.open_stream(&stream(&harness, "")).await;
    live.read_until(|text| count_events(text) >= 2).await;
    harness
        .sessions
        .broken
        .store(true, std::sync::atomic::Ordering::SeqCst);
    harness.sessions.append(SESSION, note(3, "never read"));
    let text = live.read_until(|_| false).await;
    assert_eq!(
        frames(&text).last(),
        Some(&EventStreamFrame::End("error".into()))
    );
    harness.shutdown().await;
}
