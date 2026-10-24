//! The read routes over real loopback HTTP (`test/control-api-reads.test.ts`).

use std::sync::Arc;
use std::time::Duration;

use cos_store::Logger;
use cos_tools::EpochMs;
use cos_types::app_state::{LogEntry, LogLevel, SurfaceId};
use serde_json::json;
use tokio::sync::Notify;

use super::client::{Got, Sent, send};
use super::harness::{Harness, Options, note, session_row};
use crate::reads::project_log;
use crate::server::Timing;

const SESSION: &str = "2026-10-20-1a2b3c4d";

async fn get(harness: &Harness, target: &str) -> Got {
    send(
        harness.port,
        &Sent::get(target).header("authorization", &harness.auth()),
    )
    .await
}

async fn with_session() -> Harness {
    let harness = Harness::start(Options::default()).await;
    harness.sessions.add(session_row(SESSION, None, None));
    for seq in 1..=6 {
        harness
            .sessions
            .append(SESSION, note(seq, &format!("event {seq}")));
    }
    harness
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_lists_every_route_and_says_whether_actions_are_served() {
    let harness = Harness::start(Options::default()).await;
    let health = get(&harness, "/v1/health").await.json();
    assert_eq!(
        health["routes"],
        json!([
            "/v1/health",
            "/v1/status",
            "/v1/sessions",
            "/v1/sessions/{id}",
            "/v1/sessions/{id}/events",
            "/v1/sessions/{id}/events/stream",
            "/v1/inputs",
            "/v1/agents",
            "/v1/log"
        ])
    );
    assert_eq!(
        health["actions"],
        json!({ "enabled": false, "routes": ["POST /v1/inputs", "POST /v1/inputs/{id}/cancel"] })
    );
    harness.set_config(true, true);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        get(&harness, "/v1/health").await.json()["actions"]["enabled"],
        true
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_publishes_only_allowlisted_fields_and_leaves_out_what_has_no_owner() {
    let secret = "k".repeat(43);
    let connection = serde_json::from_value(json!({
        "state": "connected", "detail": format!("Connected with sk-{}", "a".repeat(24)),
        "publicUrl": format!("https://tunnel.example/mcp/core/{secret}"),
        "localUrl": format!("http://127.0.0.1:51234/mcp/core/{secret}"),
        "handshakeAt": 1, "lastRequestAt": 2, "lastToolCallAt": 3,
        "health": { "pollErrors": 4, "uptimeSeconds": 5, "route": "api.openai.com · direct", "probe": "ok", "clientVersion": "1.2.3" },
        "surfaces": [{
            "id": "core", "connectorName": "Chat On Steroids", "description": "desc", "cardSummary": "card",
            "optional": false, "available": true,
            "localUrl": format!("http://127.0.0.1:51234/mcp/core/{secret}"),
            "publicUrl": format!("https://tunnel.example/mcp/core/{secret}"),
            "tools": ["read", "exec"], "state": "live", "detail": "Published", "lastRequestAt": 6, "lastToolCallAt": 7
        }]
    }))
    .expect("a connection status");
    // The UI-only fields of the bridge status stay out, and its error is redacted.
    let bridge = serde_json::from_value(json!({
        "portOverridden": false, "error": format!("Port 8765: sk-{}", "b".repeat(24)), "running": true, "port": 8765,
        "paired": true, "present": true, "lastSeenAt": 8, "extensionVersion": "2.1.35",
        "externalExtension": { "present": true, "version": "2.1.35", "lastSeenAt": 9, "signedIn": true },
        "cosExtension": { "present": true }
    }))
    .expect("a bridge status");
    let harness = Harness::start(Options {
        connection,
        bridge,
        ..Options::default()
    })
    .await;
    let before = EpochMs::now().0;
    drop(harness.kernel.begin_request(SurfaceId::Core));
    let status = get(&harness, "/v1/status").await;
    assert_eq!(status.status, 200);
    let seen = status.json()["connection"]["lastRequestAt"]
        .as_u64()
        .expect("the request clock is set");
    assert!(
        (before..=EpochMs::now().0).contains(&seen),
        "{seen} is the request just made"
    );
    let text = String::from_utf8_lossy(&status.body).into_owned();
    assert!(
        !text.contains(&secret) && !text.contains(&harness.token),
        "{text}"
    );
    assert_eq!(
        status.json(),
        json!({
            "appVersion": "2.1.35",
            "connection": {
                "state": "connected", "detail": "Connected with sk-***", "handshakeAt": 1, "lastRequestAt": seen, "lastToolCallAt": null,
                "tunnel": { "pollErrors": 4, "uptimeSeconds": 5, "route": "api.openai.com · direct", "probe": "ok", "clientVersion": "1.2.3" },
                "surfaces": [{ "id": "core", "state": "live", "available": true, "optional": false, "detail": "Published", "tools": 2, "lastRequestAt": seen, "lastToolCallAt": null }]
            },
            "bridge": {
                "running": true, "port": 8765, "portOverridden": false, "paired": true, "present": true,
                "lastSeenAt": 8, "extensionVersion": "2.1.35", "error": "Port 8765: sk-***"
            },
            "toolCalls": { "running": 0, "settling": 0, "inFlight": 0, "inFlightMcpRequests": 0 }
        })
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuse_unknown_repeated_and_malformed_parameters_instead_of_ignoring_them() {
    let harness = with_session().await;
    for route in [
        "/v1/sessions?limit=0".to_owned(),
        "/v1/sessions?limit=51".into(),
        "/v1/sessions?limit=abc".into(),
        "/v1/sessions?limit=1&limit=2".into(),
        "/v1/sessions?verbose=1".into(),
        "/v1/sessions?cursor=".into(),
        "/v1/sessions?__proto__=1".into(),
        "/v1/sessions?constructor=1".into(),
        format!("/v1/sessions/{SESSION}?x=1"),
        format!("/v1/sessions/{SESSION}?live=yes"),
        format!("/v1/sessions/{SESSION}/events?limit=101"),
        format!("/v1/sessions/{SESSION}/events?kinds=user_message,bogus"),
        format!("/v1/sessions/{SESSION}/events?kinds="),
        format!("/v1/sessions/{SESSION}/events?from=1&before=5"),
        format!("/v1/sessions/{SESSION}/events?from=1&after=0"),
        "/v1/inputs?state=deleted".into(),
        "/v1/inputs?state=decision".into(),
        "/v1/inputs?limit=501".into(),
        "/v1/agents?x=1".into(),
        "/v1/log?level=debug".into(),
        "/v1/log?since=-1".into(),
    ] {
        let refused = get(&harness, &route).await;
        assert_eq!(
            (refused.status, refused.error()),
            (400, "invalid_query".into()),
            "{route}"
        );
    }
    let detail = get(&harness, "/v1/sessions?__proto__=1").await.json();
    assert_eq!(detail["detail"], "unknown parameter");
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answer_404_for_an_unknown_session_and_for_ids_that_cannot_be_sessions() {
    let harness = with_session().await;
    let missing = get(&harness, "/v1/sessions/2026-01-01-deadbeef").await;
    assert_eq!(
        (missing.status, missing.error()),
        (404, "session_not_found".into())
    );
    let events = get(&harness, "/v1/sessions/2026-01-01-deadbeef/events").await;
    assert_eq!(events.error(), "session_not_found");
    for route in [
        "/v1/sessions/short".to_owned(),
        "/v1/sessions/..%2F..%2Fconfig".into(),
        format!("/v1/sessions/{SESSION}/other"),
        format!("/v1/sessions/{}", SESSION.to_uppercase()),
        format!("/v1/sessions/{}/events", SESSION.to_uppercase()),
    ] {
        let refused = get(&harness, &route).await;
        assert_eq!(
            (refused.status, refused.error()),
            (404, "not_found".into()),
            "{route}"
        );
    }
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_detail_attaches_live_state_only_when_asked() {
    let harness = with_session().await;
    let plain = get(&harness, &format!("/v1/sessions/{SESSION}"))
        .await
        .json();
    assert_eq!(plain["session"]["id"], SESSION);
    assert!(plain.get("live").is_none());
    let live = get(&harness, &format!("/v1/sessions/{SESSION}?live=1"))
        .await
        .json();
    assert_eq!(live["live"], serde_json::Value::Null);
    assert!(live.as_object().expect("an object").contains_key("live"));
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn events_page_by_position_follow_by_seq_and_filter_by_kind() {
    let harness = with_session().await;
    let seqs = |body: serde_json::Value| -> Vec<u64> {
        body["events"]
            .as_array()
            .expect("events")
            .iter()
            .map(|event| event["seq"].as_u64().expect("a seq"))
            .collect()
    };
    let base = format!("/v1/sessions/{SESSION}/events");
    assert_eq!(seqs(get(&harness, &base).await.json()), [1, 2, 3, 4, 5, 6]);
    assert_eq!(
        seqs(get(&harness, &format!("{base}?limit=2")).await.json()),
        [5, 6]
    );
    assert_eq!(
        seqs(
            get(&harness, &format!("{base}?after=2&limit=2"))
                .await
                .json()
        ),
        [3, 4]
    );
    assert_eq!(
        seqs(get(&harness, &format!("{base}?before=3")).await.json()),
        [1, 2]
    );
    assert_eq!(
        seqs(
            get(&harness, &format!("{base}?after=2&before=6&limit=2"))
                .await
                .json()
        ),
        [4, 5]
    );
    let followed = get(&harness, &format!("{base}?from=5")).await.json();
    assert_eq!(
        (seqs(followed.clone()), followed["nextFrom"].clone()),
        (vec![5, 6], json!(7))
    );
    assert_eq!(
        seqs(get(&harness, &format!("{base}?kinds=note")).await.json()),
        [2, 4, 6]
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inputs_and_agents_answer_for_owners_this_build_does_not_have() {
    let harness = Harness::start(Options::default()).await;
    assert_eq!(
        get(&harness, "/v1/inputs?state=queued&limit=5")
            .await
            .json(),
        json!({ "inputs": [], "total": 0 })
    );
    let enabled = super::harness::config(true, false).multi_agent.enabled;
    assert_eq!(
        get(&harness, "/v1/agents").await.json(),
        json!({ "enabled": enabled, "running": false, "retainedHistory": false, "agents": [] })
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_log_serves_the_newest_entries_filtered_by_level_and_an_inclusive_time() {
    let harness = Harness::start(Options::default()).await;
    let logger: &Logger = &harness.logger;
    let before = cos_tools::EpochMs::now().0;
    logger.info("reads-test info");
    logger.warn("reads-test warn");
    logger.error("reads-test error");
    let levels = |body: serde_json::Value| -> Vec<String> {
        body["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .filter(|entry| {
                entry["message"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("reads-test"))
            })
            .map(|entry| entry["level"].as_str().unwrap_or_default().to_owned())
            .collect()
    };
    let all = get(&harness, &format!("/v1/log?since={before}"))
        .await
        .json();
    assert_eq!(levels(all.clone()), ["info", "warn", "error"]);
    assert!(all["ringSize"].as_u64().expect("a size") >= 3);
    let filtered = get(
        &harness,
        &format!("/v1/log?since={before}&level=warn,error"),
    )
    .await
    .json();
    assert_eq!(levels(filtered), ["warn", "error"]);
    let last = get(&harness, "/v1/log?limit=1").await.json();
    assert_eq!(last["entries"].as_array().map(Vec::len), Some(1));
    let newest = all["entries"]
        .as_array()
        .and_then(|entries| entries.last())
        .expect("an entry")["time"]
        .clone();
    let again = get(&harness, &format!("/v1/log?since={newest}"))
        .await
        .json();
    assert!(
        !again["entries"].as_array().expect("entries").is_empty(),
        "the line at `since` was dropped"
    );
    let future = get(&harness, "/v1/log?since=99999999999999").await.json();
    assert_eq!(future["entries"], json!([]));
    harness.shutdown().await;
}

#[test]
fn a_log_line_is_masked_and_cut_and_says_so() {
    let entry = |message: String, agent: Option<&str>| LogEntry {
        time: 1,
        level: LogLevel::Warn,
        message,
        agent: agent.map(str::to_owned),
    };
    let projected = project_log(&[
        entry("z".repeat(9_000), None),
        entry(
            format!("retry with Authorization: Bearer {}", "t".repeat(30)),
            Some("worker-1"),
        ),
    ]);
    let projected = serde_json::to_value(projected).expect("json");
    assert_eq!(projected[0]["message"].as_str().map(str::len), Some(4_000));
    assert_eq!(projected[0]["truncated"], true);
    assert_eq!(
        projected[1],
        json!({ "time": 1, "level": "warn", "message": "retry with Authorization: Bearer [redacted]", "agent": "worker-1" })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_in_the_owner_behind_a_route_is_a_plain_500_that_names_nothing() {
    let harness = with_session().await;
    harness
        .sessions
        .broken
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let failed = get(&harness, &format!("/v1/sessions/{SESSION}/events")).await;
    assert_eq!(
        (failed.status, failed.json()),
        (500, json!({ "error": "internal_error" }))
    );
    assert_eq!(get(&harness, "/v1/health").await.status, 200);
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stuck_owner_is_answered_504_and_its_reads_keep_their_places_until_they_end() {
    let timing = Timing {
        read_deadline: Duration::from_millis(150),
        ..Timing::default()
    };
    let harness = Harness::start(Options {
        timing,
        ..Options::default()
    })
    .await;
    harness.sessions.add(session_row(SESSION, None, None));
    let hold = Arc::new(Notify::new());
    *harness.sessions.hold.lock().expect("lock") = Some(hold.clone());
    let events = format!("/v1/sessions/{SESSION}/events");

    let first = futures_join(&harness, &events, 2).await;
    assert_eq!(
        first.iter().map(|got| got.status).collect::<Vec<_>>(),
        [504, 504]
    );
    assert_eq!(first[0].error(), "timeout");
    assert!(first[0].json()["detail"].is_string());
    // Both journal places are still taken: the reads were answered, not finished.
    let busy = get(&harness, &events).await;
    assert_eq!((busy.status, busy.error()), (503, "busy".into()));
    assert_eq!(get(&harness, "/v1/health").await.status, 200);

    let lists = futures_join(&harness, "/v1/sessions", 6).await;
    assert!(lists.iter().all(|got| got.status == 504));
    // Every place is held by a read that was answered but has not finished.
    let refused = get(&harness, "/v1/log").await;
    assert_eq!(
        (refused.status, refused.json()["detail"].clone()),
        (
            503,
            json!("too many reads are waiting on the app; retry shortly")
        )
    );
    assert_eq!(get(&harness, "/v1/health").await.status, 200);

    *harness.sessions.hold.lock().expect("lock") = None;
    hold.notify_waiters();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(get(&harness, &events).await.status, 200);
    assert_eq!(get(&harness, "/v1/log").await.status, 200);
    harness.shutdown().await;
}

async fn futures_join(harness: &Harness, target: &str, count: usize) -> Vec<Got> {
    let sent = Sent::get(target).header("authorization", &harness.auth());
    let tasks: Vec<_> = (0..count)
        .map(|_| {
            let sent = sent.clone();
            let port = harness.port;
            tokio::spawn(async move { send(port, &sent).await })
        })
        .collect();
    let mut answers = Vec::new();
    for task in tasks {
        answers.push(task.await.expect("joins"));
    }
    answers
}
