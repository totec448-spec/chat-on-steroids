//! The recorder through the routes it answers and the attribution port the kernel calls.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cos_recorder::{Recorder, Refusal};
use cos_sessions::SessionStore;
use cos_store::config::first_launch_config;
use cos_store::{AppPaths, DurableStore, Logger, Platform};
use cos_tools::{
    Attribution, CallNotes, CallRecord, EpochMs, RequestId, SurfaceId, ToolOutcome, ToolResult,
};
use cos_types::bridge::EventsStored;
use serde_json::{Value, json};
use tokio::sync::watch;

const CHAT: &str = "c1c1c1c1-0000-4000-8000-000000000001";
const OTHER: &str = "c2c2c2c2-0000-4000-8000-000000000002";
const NOW: EpochMs = EpochMs(1_767_225_610_000);

fn profile(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cos-recorder-flow-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile");
    dir
}

fn recorder(profile: &Path, record: bool) -> (SessionStore, Recorder) {
    let paths = AppPaths::at(profile);
    let sessions = SessionStore::open(&paths, Logger::new());
    let mut config = first_launch_config(Platform::current());
    config.sessions.record = record;
    let recorder = Recorder::new(
        sessions.clone(),
        &DurableStore::new(paths.state(), Logger::new()),
        watch::channel(Arc::new(config)).1,
        Logger::new(),
    );
    (sessions, recorder)
}

fn journal(profile: &Path) -> Vec<Value> {
    let root = profile.join("sessions");
    let mut lines = Vec::new();
    for entry in std::fs::read_dir(root)
        .expect("sessions")
        .filter_map(Result::ok)
    {
        let text = std::fs::read_to_string(entry.path().join("events.jsonl")).expect("journal");
        lines.extend(
            text.lines()
                .map(|line| serde_json::from_str::<Value>(line).expect("line")),
        );
    }
    lines
}

#[tokio::test]
async fn a_proven_request_files_its_tool_call_in_the_chat_that_proved_it() {
    let dir = profile("attributed");
    let (sessions, recorder) = recorder(&dir, true);
    let reply = recorder
        .correlate(
            &json!({ "conversationId": CHAT, "calls": [{ "requestId": "wfr_owned", "messageId": null }] }),
            NOW,
        )
        .await
        .expect("correlated");
    assert!(reply.complete);
    let session = reply.session_id.expect("a session for the chat");

    let request = RequestId::from_header("wfr_owned/attempt-2").expect("request id");
    let caller = recorder.resolve("read", NOW, Some(&request)).await;
    let (conversation, owner) = caller.chat.clone().expect("the chat is proven");
    assert_eq!(conversation.as_str(), CHAT);
    assert_eq!(owner.as_str(), session);

    let result = ToolResult::text("1\thello");
    sessions
        .recorder()
        .record(CallRecord {
            surface: SurfaceId::Core,
            tool: "read",
            nested: false,
            caller: &caller,
            started_at: NOW,
            finished_at: NOW,
            outcome: ToolOutcome::Ok,
            arguments: &json!({ "paths": ["/project/a.txt"] }),
            result: &result,
            notes: &CallNotes::default(),
        })
        .await;
    let call = journal(&dir)
        .into_iter()
        .find(|line| line["kind"] == "tool_call")
        .expect("the call is recorded");
    assert_eq!(call["call"]["conversationId"], CHAT);
    assert_eq!(call["call"]["attributionMethod"], "request_id");
    assert_eq!(call["call"]["requestId"], "wfr_owned");
    assert_eq!(
        std::fs::read_dir(dir.join("sessions"))
            .expect("sessions")
            .count(),
        1,
        "no Unattributed session was needed"
    );
}

#[tokio::test]
async fn an_unproven_request_stays_unattributed_and_another_chat_cannot_take_a_proven_one() {
    let dir = profile("contested");
    let (_sessions, recorder) = recorder(&dir, true);
    let unknown = RequestId::from_header("wfr_nobody").expect("request id");
    assert!(
        recorder
            .resolve("read", NOW, Some(&unknown))
            .await
            .chat
            .is_none()
    );

    recorder
        .correlate(
            &json!({ "conversationId": CHAT, "calls": [{ "requestId": "wfr_first" }] }),
            NOW,
        )
        .await
        .expect("first");
    let second = recorder
        .correlate(
            &json!({ "conversationId": OTHER, "calls": [{ "requestId": "wfr_first" }] }),
            NOW,
        )
        .await
        .expect("second");
    assert_eq!(second.conflicts, ["wfr_first"]);
    assert!(second.confirmed.is_empty());
    assert!(!second.complete);
    let first = RequestId::from_header("wfr_first").expect("request id");
    let (conversation, _) = recorder
        .resolve("read", NOW, Some(&first))
        .await
        .chat
        .expect("owner");
    assert_eq!(conversation.as_str(), CHAT);
}

#[tokio::test]
async fn correlations_need_a_conversation_and_a_request_id() {
    let dir = profile("refusals");
    let (_sessions, recorder) = recorder(&dir, true);
    assert_eq!(
        recorder
            .correlate(&json!({ "conversationId": "nope", "calls": [] }), NOW)
            .await
            .err(),
        Some(Refusal("bad_conversation_id"))
    );
    assert_eq!(
        recorder
            .correlate(
                &json!({ "conversationId": CHAT, "calls": [{ "tool": "read" }] }),
                NOW
            )
            .await
            .err(),
        Some(Refusal("bad_request_evidence"))
    );
    assert!(
        !dir.join("sessions").exists(),
        "a refused report creates no session"
    );
}

#[tokio::test]
async fn with_recording_off_observations_create_nothing() {
    let dir = profile("off");
    let (_sessions, recorder) = recorder(&dir, false);
    let stored = recorder
        .events(
            &json!({ "conversationId": CHAT, "events": [
                { "kind": "user_message", "messageId": "m1", "text": "hello", "time": 1_767_225_601_000u64 }
            ] }),
            NOW,
        )
        .await
        .expect("answered");
    assert_eq!(
        stored,
        EventsStored::Recorded {
            session_id: None,
            stored: 0
        }
    );
    assert!(!dir.join("sessions").exists());
}

#[tokio::test]
async fn a_replayed_batch_stores_nothing_twice_and_a_reopened_chat_continues_its_session() {
    let dir = profile("replay");
    let (sessions, recorder) = recorder(&dir, true);
    let batch = json!({ "conversationId": CHAT, "events": [
        { "kind": "user_message", "messageId": "m1", "text": "hello", "time": 1_767_225_601_000u64, "authoredNow": true },
        { "kind": "turn_start", "turnId": "t1", "time": 1_767_225_601_100u64 },
        { "kind": "turn_end", "turnId": "t1", "outcome": "completed", "time": 1_767_225_601_200u64 }
    ] });
    let first = recorder.events(&batch, NOW).await.expect("first");
    let EventsStored::Recorded {
        session_id: Some(session),
        stored: 3,
    } = first
    else {
        panic!("first batch: {first:?}");
    };
    assert_eq!(
        recorder.events(&batch, NOW).await.expect("replay"),
        EventsStored::Recorded {
            session_id: Some(session.clone()),
            stored: 0
        }
    );
    recorder.closed(&json!({ "conversationId": CHAT })).await;
    let id = cos_types::ids::SessionId::parse(session.clone()).expect("id");
    assert!(
        sessions
            .summary(&id)
            .await
            .expect("summary")
            .ended_at
            .is_some()
    );
    let again = recorder
        .events(
            &json!({ "conversationId": CHAT, "events": [
                { "kind": "user_message", "messageId": "m2", "text": "more", "time": 1_767_225_602_000u64 }
            ] }),
            NOW,
        )
        .await
        .expect("again");
    assert_eq!(
        again,
        EventsStored::Recorded {
            session_id: Some(session),
            stored: 1
        }
    );
    assert!(
        sessions
            .summary(&id)
            .await
            .expect("summary")
            .ended_at
            .is_none()
    );
    let kinds: Vec<Value> = journal(&dir)
        .into_iter()
        .map(|line| line["kind"].clone())
        .collect();
    assert_eq!(
        kinds,
        ["session_start", "turn_start", "turn_end"],
        "messages live in their shards"
    );
}
