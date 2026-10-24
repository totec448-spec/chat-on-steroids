//! The request-id proof ledger through its public interface, with the cases of
//! `test/correlation.test.ts`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use cos_recorder::{Correlations, Merge};
use cos_sessions::SessionStore;
use cos_store::{AppPaths, DurableStore, Logger};
use cos_types::json::Extra;
use cos_types::state::RequestCorrelation;
use serde_json::{Value, json};

fn profile(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cos-recorder-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile");
    dir
}

fn ledger(profile: &Path) -> Correlations {
    Correlations::new(
        &DurableStore::new(AppPaths::at(profile).state(), Logger::new()),
        Logger::new(),
    )
}

fn owner(request: &str, conversation: &str, session: &str, observed_at: u64) -> RequestCorrelation {
    RequestCorrelation {
        request_id: request.into(),
        conversation_id: conversation.into(),
        session_id: session.into(),
        message_id: format!("msg-{request}"),
        tool: "read".into(),
        observed_at,
        extra: Extra::new(),
    }
}

fn state_file(profile: &Path) -> Value {
    let bytes = std::fs::read(
        AppPaths::at(profile)
            .state()
            .join("request-correlations.json"),
    )
    .expect("ledger file");
    serde_json::from_slice(&bytes).expect("ledger json")
}

const MS: fn(u64) -> Duration = Duration::from_millis;

#[tokio::test(start_paused = true)]
async fn spends_grace_once_per_request_while_accepting_late_exact_evidence() {
    let dir = profile("grace-once");
    let ledger = ledger(&dir);
    assert_eq!(ledger.wait_for("wfr-missing", MS(60)).await, None);
    let before = tokio::time::Instant::now();
    assert_eq!(ledger.wait_for("wfr-missing", MS(60)).await, None);
    assert_eq!(
        before.elapsed(),
        Duration::ZERO,
        "a spent grace does not wait again"
    );

    ledger.observe(vec![owner("wfr-missing", "conv-late", "session-late", 1)]);
    let late = ledger.wait_for("wfr-missing", MS(60)).await;
    assert_eq!(
        late.map(|owner| owner.conversation_id).as_deref(),
        Some("conv-late")
    );
}

#[tokio::test(start_paused = true)]
async fn shares_a_deadline_across_overlapping_callers() {
    let dir = profile("overlap");
    let ledger = ledger(&dir);
    let started = tokio::time::Instant::now();
    let first = tokio::spawn({
        let ledger = ledger.clone();
        async move { ledger.wait_for("wfr-overlap", MS(100)).await }
    });
    tokio::time::sleep(MS(40)).await;
    let second = ledger.wait_for("wfr-overlap", MS(100)).await;
    assert_eq!(second, None);
    assert_eq!(
        started.elapsed(),
        MS(100),
        "the second caller ends at the first deadline"
    );
    assert_eq!(first.await.expect("first"), None);
}

#[tokio::test(start_paused = true)]
async fn retains_the_remaining_longer_grace_after_a_shorter_timeout() {
    let dir = profile("longer");
    let ledger = ledger(&dir);
    assert_eq!(ledger.wait_for("wfr-longer", MS(15)).await, None);
    let longer = tokio::spawn({
        let ledger = ledger.clone();
        async move { ledger.wait_for("wfr-longer", MS(20)).await }
    });
    tokio::time::sleep(MS(4)).await;
    ledger.observe(vec![owner(
        "wfr-longer",
        "conv-proved",
        "session-proved",
        1,
    )]);
    let found = longer.await.expect("longer");
    assert_eq!(
        found.map(|owner| owner.conversation_id).as_deref(),
        Some("conv-proved")
    );
}

#[tokio::test(start_paused = true)]
async fn ends_the_longer_grace_at_its_original_deadline_and_leaves_zero_time_uncharged() {
    let dir = profile("budget");
    let ledger = ledger(&dir);
    assert_eq!(ledger.wait_for("wfr-budget", Duration::ZERO).await, None);
    tokio::time::sleep(MS(100)).await;
    let started = tokio::time::Instant::now();
    assert_eq!(ledger.wait_for("wfr-budget", MS(15)).await, None);
    assert_eq!(
        started.elapsed(),
        MS(15),
        "the zero-time lookup did not start the clock"
    );
    assert_eq!(ledger.wait_for("wfr-budget", MS(20)).await, None);
    assert_eq!(started.elapsed(), MS(20));
    assert_eq!(ledger.wait_for("wfr-budget", MS(20)).await, None);
    assert_eq!(started.elapsed(), MS(20));
}

#[tokio::test]
async fn keeps_one_turn_level_request_id_owned_across_messages_and_tools() {
    let dir = profile("turn-level");
    let ledger = ledger(&dir);
    let mut read = owner("wfr_shared_turn", "conv-a", "session-a", 10);
    read.message_id = "msg-read".into();
    let mut exec = owner("wfr_shared_turn", "conv-a", "session-a-later", 11);
    exec.message_id = "msg-exec".into();
    exec.tool = "exec_command".into();
    assert_eq!(ledger.observe(vec![read]), [Merge::Stored]);
    assert_eq!(ledger.observe(vec![exec]), [Merge::Same]);
    let held = ledger.lookup("wfr_shared_turn").expect("owner");
    assert_eq!(held.conversation_id, "conv-a");
    assert_eq!(
        held.session_id, "session-a",
        "the first session epoch keeps the request"
    );
}

#[tokio::test]
async fn keeps_the_first_proven_owner_when_another_conversation_claims_the_id() {
    let dir = profile("first-wins");
    let ledger = ledger(&dir);
    ledger.observe(vec![owner("wfr_contested", "conv-a", "session-a", 1)]);
    assert_eq!(
        ledger.observe(vec![owner("wfr_contested", "conv-b", "session-b", 2)]),
        [Merge::Refused]
    );
    assert_eq!(
        ledger
            .lookup("wfr_contested")
            .map(|owner| owner.conversation_id)
            .as_deref(),
        Some("conv-a")
    );
    assert_eq!(
        ledger.observe(vec![owner("wfr_contested", "conv-a", "session-a", 3)]),
        [Merge::Same]
    );
}

#[tokio::test]
async fn does_not_age_a_proven_owner_out() {
    let dir = profile("no-ttl");
    let ledger = ledger(&dir);
    ledger.observe(vec![owner("wfr_long_running", "conv-a", "session-a", 1)]);
    assert!(ledger.lookup("wfr_long_running").is_some());
}

#[tokio::test]
async fn evicts_by_latest_same_owner_observation_rather_than_insertion_order() {
    let dir = profile("eviction");
    let ledger = ledger(&dir);
    let mut batch = vec![owner("wfr_refreshed", "conv-a", "session-a", 1)];
    batch.extend((0..49_999).map(|index| {
        owner(
            &format!("wfr_fill_{index}"),
            "conv-a",
            "session-a",
            index + 2,
        )
    }));
    ledger.observe(batch);
    assert_eq!(
        ledger.observe(vec![owner("wfr_refreshed", "conv-a", "session-a", 100_000)]),
        [Merge::Same]
    );
    ledger.observe(vec![owner("wfr_newest", "conv-a", "session-a", 100_001)]);
    assert_eq!(
        ledger
            .lookup("wfr_refreshed")
            .map(|owner| owner.observed_at),
        Some(100_000)
    );
    assert_eq!(ledger.lookup("wfr_fill_0"), None);
}

#[tokio::test]
async fn restores_proven_ownership_from_durable_state_after_a_restart() {
    let dir = profile("restart");
    let first = ledger(&dir);
    first.observe(vec![owner(
        "wfr_survives_restart",
        "conv-durable",
        "session-durable",
        123,
    )]);
    first.commit().await.expect("commit");
    let file = state_file(&dir);
    assert_eq!(file["version"], json!(6));
    assert_eq!(file["complete"], json!(true));
    assert_eq!(
        file["entries"][0],
        json!({
            "requestId": "wfr_survives_restart",
            "conversationId": "conv-durable",
            "sessionId": "session-durable",
            "messageId": "msg-wfr_survives_restart",
            "tool": "read",
            "observedAt": 123
        })
    );

    let sessions = SessionStore::open(&AppPaths::at(&dir), Logger::new());
    let second = ledger(&dir);
    assert_eq!(second.lookup("wfr_survives_restart"), None);
    second.restore(&sessions).await;
    let restored = second
        .lookup("wfr_survives_restart")
        .expect("restored owner");
    assert_eq!(restored.conversation_id, "conv-durable");
    assert_eq!(restored.session_id, "session-durable");
}

#[tokio::test]
async fn restores_an_owner_proved_before_chatgpt_named_the_tool() {
    let dir = profile("untooled");
    let first = ledger(&dir);
    let mut bare = owner(
        "f0f00012-1111-4111-8111-111111111111",
        "conv-bare-request-id",
        "2026-01-01-00000028",
        1_788_276_631_192,
    );
    bare.tool = String::new();
    first.observe(vec![bare]);
    first.commit().await.expect("commit");
    let second = ledger(&dir);
    second
        .restore(&SessionStore::open(&AppPaths::at(&dir), Logger::new()))
        .await;
    assert_eq!(
        second
            .lookup("f0f00012-1111-4111-8111-111111111111")
            .map(|owner| owner.session_id)
            .as_deref(),
        Some("2026-01-01-00000028")
    );
}

#[tokio::test]
async fn migrates_older_owners_and_forgets_their_sticky_conflicts() {
    let dir = profile("v3");
    let state = AppPaths::at(&dir).state();
    std::fs::create_dir_all(&state).expect("state");
    std::fs::write(
        state.join("request-correlations.json"),
        serde_json::to_vec(&json!({
            "version": 3,
            "entries": [
                { "requestId": "wfr_v3_proven_owner", "conflicted": false, "value": {
                    "requestId": "wfr_v3_proven_owner", "conversationId": "conv-v3-proven",
                    "sessionId": "session-v3-proven", "messageId": "message-v3-proven",
                    "tool": "read", "observedAt": 100 } },
                { "requestId": "wfr_v3_false_conflict", "value": null, "conflicted": true }
            ]
        }))
        .expect("encode"),
    )
    .expect("write");
    let ledger = ledger(&dir);
    ledger
        .restore(&SessionStore::open(&AppPaths::at(&dir), Logger::new()))
        .await;
    assert_eq!(
        ledger
            .lookup("wfr_v3_proven_owner")
            .map(|owner| owner.conversation_id)
            .as_deref(),
        Some("conv-v3-proven")
    );
    assert_eq!(ledger.lookup("wfr_v3_false_conflict"), None);
    assert_eq!(
        ledger.observe(vec![owner(
            "wfr_v3_false_conflict",
            "conv-after",
            "session-after",
            200
        )]),
        [Merge::Stored]
    );
    let file = state_file(&dir);
    assert_eq!(
        file["version"],
        json!(6),
        "the migration rewrites the old ledger"
    );
    assert_eq!(file["entries"].as_array().map(Vec::len), Some(1));
}

/// A session for `conversation` holding one recorded `request_id` call per `(callId, requestId,
/// time)`, flushed to disk.
async fn attributed_history(
    profile: &Path,
    conversation: &str,
    calls: &[(&str, &str, u64)],
) -> cos_types::ids::SessionId {
    let store = SessionStore::open(&AppPaths::at(profile), Logger::new());
    store.restore().await;
    let session = store
        .create_for_conversation(conversation, Some("attributed history"))
        .await
        .expect("session")
        .id;
    for (call, request, time) in calls {
        let event: cos_types::session::SessionEvent = serde_json::from_value(json!({
            "seq": 0, "time": time, "source": "mcp", "kind": "tool_call",
            "call": {
                "callId": call, "tool": "read", "attribution": "request_id", "requestId": request,
                "conversationId": conversation, "attributionMethod": "request_id",
                "args": { "text": "{}", "truncated": false, "chars": 2 },
                "result": { "text": "ok", "truncated": false, "chars": 2 },
                "outcome": "ok", "durationMs": 1,
                "summary": { "kind": "read", "tone": "neutral", "title": call }
            }
        }))
        .expect("tool call event");
        store.append_event(&session, event).await.expect("append");
    }
    store.flush().await;
    session
}

async fn restored(profile: &Path) -> Correlations {
    let sessions = SessionStore::open(&AppPaths::at(profile), Logger::new());
    sessions.restore().await;
    let ledger = ledger(profile);
    ledger.restore(&sessions).await;
    ledger
}

fn write_ledger(profile: &Path, value: &Value) {
    let state = AppPaths::at(profile).state();
    std::fs::create_dir_all(&state).expect("state");
    std::fs::write(
        state.join("request-correlations.json"),
        serde_json::to_vec(value).expect("encode"),
    )
    .expect("write");
}

#[tokio::test]
async fn rebuilds_the_first_owner_index_from_attributed_session_history() {
    let dir = profile("history-first");
    let session = attributed_history(
        &dir,
        "conv-history",
        &[("call-history", "wfr_history", 200)],
    )
    .await;
    for launch in ["first, with no ledger", "second, from the ledger it wrote"] {
        let owner = restored(&dir).await.lookup("wfr_history");
        let owner = owner.unwrap_or_else(|| panic!("{launch}: no owner"));
        assert_eq!(owner.conversation_id, "conv-history", "{launch}");
        assert_eq!(owner.session_id, session.as_str(), "{launch}");
    }
    let file = state_file(&dir);
    assert_eq!(file["version"], json!(6));
    assert_eq!(file["complete"], json!(true));
}

#[tokio::test]
async fn reconciles_a_valid_stale_snapshot_with_newer_attributed_history() {
    let dir = profile("history-stale");
    let conversation = "conv-stale-reconcile";
    let session = attributed_history(
        &dir,
        conversation,
        &[
            ("call-old", "wfr_old_snapshot", 1),
            ("call-new", "wfr_new_history", 2),
        ],
    )
    .await;
    // Version 5 acknowledged owners before its debounced snapshot was necessarily current.
    write_ledger(
        &dir,
        &json!({ "version": 5, "entries": [{
            "requestId": "wfr_old_snapshot", "conversationId": conversation,
            "sessionId": session.as_str(), "messageId": "msg-old", "tool": "read", "observedAt": 1
        }] }),
    );
    let ledger = restored(&dir).await;
    for request in ["wfr_old_snapshot", "wfr_new_history"] {
        assert_eq!(
            ledger
                .lookup(request)
                .map(|owner| owner.conversation_id)
                .as_deref(),
            Some(conversation),
            "{request}"
        );
    }
    let file = state_file(&dir);
    assert_eq!(file["version"], json!(6));
    assert_eq!(file["complete"], json!(true));
    let mut ids: Vec<&str> = file["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .filter_map(|entry| entry["requestId"].as_str())
        .collect();
    ids.sort_unstable();
    assert_eq!(ids, ["wfr_new_history", "wfr_old_snapshot"]);
}

#[tokio::test]
async fn trusts_a_complete_version_6_ledger_and_scans_history_only_when_it_cannot_vouch_for_itself()
{
    let dir = profile("history-complete");
    let session = attributed_history(
        &dir,
        "conv-complete",
        &[("call-history-only", "wfr_history_only", 2)],
    )
    .await;
    let committed = json!({
        "requestId": "wfr_committed", "conversationId": "conv-complete", "sessionId": session.as_str(),
        "messageId": "msg-wfr_committed", "tool": "read", "observedAt": 1
    });
    let ledgers = [
        (
            false,
            json!({ "version": 6, "complete": true, "entries": [committed.clone()] }),
        ),
        (
            true,
            json!({ "version": 6, "entries": [committed.clone()] }),
        ),
        (
            true,
            json!({ "version": 6, "complete": true, "entries": [committed.clone(), { "requestId": "wfr_unreadable" }] }),
        ),
    ];
    for (scanned, value) in ledgers {
        write_ledger(&dir, &value);
        let ledger = restored(&dir).await;
        assert_eq!(
            ledger
                .lookup("wfr_committed")
                .map(|owner| owner.conversation_id)
                .as_deref(),
            Some("conv-complete")
        );
        assert_eq!(
            ledger.lookup("wfr_history_only").is_some(),
            scanned,
            "history is scanned only when the ledger cannot vouch for itself: {value}"
        );
    }
}
