//! The action routes over real loopback HTTP (`test/control-api-actions.test.ts`): the checks
//! before the outbox. `inputs.rs` covers what the outbox then admits and cancels.

use std::time::Duration;

use serde_json::json;

use super::client::{Connection, Sent, send};
use super::harness::{Harness, Options, session_row};
use crate::server::Timing;

const ID: &str = "00000000-0000-4000-8000-000000000000";

fn post(harness: &Harness, target: &str) -> Sent {
    Sent::post(target).header("authorization", &harness.auth())
}

fn json_post(harness: &Harness, target: &str, body: &serde_json::Value) -> Sent {
    post(harness, target)
        .header("content-type", "application/json")
        .header("expect", "100-continue")
        .body(body.to_string())
}

async fn actions_on() -> Harness {
    Harness::start(Options {
        allow_actions: true,
        ..Options::default()
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_actions_off_every_action_route_is_refused_alike_before_anything_is_read() {
    let harness = Harness::start(Options::default()).await;
    for target in [
        "/v1/inputs",
        "/v1/inputs/BAD/cancel",
        &format!("/v1/inputs/{ID}/cancel"),
        "/v1/inputs?x=1",
    ] {
        let mut connection = Connection::open(harness.port).await;
        let refused = connection
            .send(&json_post(
                &harness,
                target,
                &json!({ "id": ID, "text": "hi" }),
            ))
            .await;
        assert_eq!(
            (refused.status, refused.error()),
            (403, "actions_disabled".into()),
            "{target}"
        );
        assert_eq!(refused.header("connection"), Some("close"));
        assert!(!refused.continued, "invited a body it was going to refuse");
        assert!(
            connection.closed_by_server().await,
            "kept a connection with an unread body"
        );
    }
    // Refusals while actions are off spend nothing, and reads are unaffected.
    assert_eq!(
        send(
            harness.port,
            &Sent::get("/v1/health").header("authorization", &harness.auth())
        )
        .await
        .status,
        200
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn follows_the_switch_on_the_next_request_without_restarting_the_listener() {
    let harness = Harness::start(Options::default()).await;
    assert_eq!(
        send(harness.port, &post(&harness, "/v1/inputs"))
            .await
            .error(),
        "actions_disabled"
    );
    harness.set_config(true, true);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let checked = send(harness.port, &post(&harness, "/v1/inputs")).await;
    assert_eq!(
        (checked.status, checked.json()["detail"].clone()),
        (400, json!("id is not valid"))
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_that_is_not_a_small_json_object_is_refused_before_it_is_used() {
    let harness = actions_on().await;
    let cases: Vec<(Sent, u16, &str, &str)> = vec![
        (
            post(&harness, "/v1/inputs")
                .header("content-type", "text/plain")
                .header("expect", "100-continue")
                .body("{}"),
            415,
            "unsupported_media_type",
            "close",
        ),
        (
            post(&harness, "/v1/inputs")
                .header("content-type", "application/json")
                .header("expect", "100-continue")
                .body(vec![b'x'; 512 * 1024 + 1]),
            413,
            "body_too_large",
            "close",
        ),
        (
            post(&harness, "/v1/inputs")
                .header("content-type", "application/json")
                .header("transfer-encoding", "chunked")
                .header("expect", "100-continue")
                .body("{}"),
            400,
            "invalid_framing",
            "close",
        ),
        (
            post(&harness, "/v1/inputs")
                .header("content-type", "application/json")
                .header("content-encoding", "gzip")
                .body("{}"),
            400,
            "invalid_framing",
            "close",
        ),
        (
            json_post(
                &harness,
                "/v1/inputs?x=1",
                &json!({ "id": ID, "text": "x" }),
            ),
            400,
            "invalid_query",
            "close",
        ),
        (
            post(&harness, "/v1/inputs")
                .header("content-type", "application/json")
                .header("expect", "100-continue")
                .body("{\"id\":"),
            400,
            "invalid_json",
            "keep-alive",
        ),
        (
            post(&harness, "/v1/inputs")
                .header("content-type", "application/json")
                .body(vec![0xFF, b'{', b'}']),
            400,
            "invalid_json",
            "keep-alive",
        ),
        (
            post(&harness, "/v1/inputs")
                .header("content-type", "Application/JSON ; charset=UTF-8")
                .body("{}"),
            400,
            "invalid_body",
            "keep-alive",
        ),
    ];
    for (sent, status, error, connection) in cases {
        let got = send(harness.port, &sent).await;
        assert_eq!(
            (got.status, got.error(), got.header("connection")),
            (status, error.into(), Some(connection)),
            "{sent:?}"
        );
    }
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invites_the_body_of_an_action_that_passed_every_check_and_only_that_one() {
    let harness = actions_on().await;
    let checked = send(
        harness.port,
        &json_post(
            &harness,
            "/v1/inputs",
            &json!({ "id": ID, "text": "x", "extra": 1 }),
        ),
    )
    .await;
    assert!(checked.continued);
    assert_eq!(
        (checked.status, checked.json()["detail"].clone()),
        (400, json!("unknown field"))
    );
    assert_eq!(checked.header("connection"), Some("keep-alive"));
    let refused = send(
        harness.port,
        &json_post(&harness, "/v1/inputs?x=1", &json!({})),
    )
    .await;
    assert!(!refused.continued);
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_caller_that_announces_a_body_and_does_not_send_it_is_answered_408() {
    let timing = Timing {
        body_timeout: Duration::from_millis(100),
        ..Timing::default()
    };
    let harness = Harness::start(Options {
        allow_actions: true,
        timing,
        ..Options::default()
    })
    .await;
    let sent = post(&harness, "/v1/inputs")
        .header("content-type", "application/json")
        .header("content-length", "20")
        .body("{");
    let got = send(harness.port, &sent).await;
    assert_eq!(
        (got.status, got.error(), got.header("connection")),
        (408, "body_timeout".into(), Some("close"))
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closing_refusal_survives_a_body_that_arrives_after_it() {
    let timing = Timing {
        body_timeout: Duration::from_millis(100),
        ..Timing::default()
    };
    let off = Harness::start(Options {
        timing,
        ..Options::default()
    })
    .await;
    let on = Harness::start(Options {
        allow_actions: true,
        timing,
        ..Options::default()
    })
    .await;
    let body = json!({ "id": ID, "text": "hi" }).to_string();
    let cases: Vec<(&Harness, Sent, u16, &str)> = vec![
        (
            &off,
            post(&off, "/v1/inputs")
                .header("content-type", "application/json")
                .body(body.clone()),
            403,
            "actions_disabled",
        ),
        (
            &off,
            post(&off, "/v1/inputs")
                .header("content-type", "text/plain")
                .body("hi"),
            403,
            "actions_disabled",
        ),
        (
            &on,
            post(&on, "/v1/inputs")
                .header("content-type", "application/json")
                .header("transfer-encoding", "chunked")
                .body(body.clone()),
            400,
            "invalid_framing",
        ),
        (
            &on,
            post(&on, "/v1/inputs")
                .header("content-type", "application/json")
                .body(vec![b' '; 512 * 1024 + 1]),
            413,
            "body_too_large",
        ),
        (
            &on,
            post(&on, "/v1/inputs")
                .header("content-type", "text/plain")
                .body("hi"),
            415,
            "unsupported_media_type",
        ),
        (
            &on,
            post(&on, "/v1/inputs")
                .header("content-type", "application/json")
                .body(body),
            408,
            "body_timeout",
        ),
    ];
    let mut reset = Vec::new();
    for (harness, sent, status, error) in cases {
        let mut connection = Connection::open(harness.port).await;
        let got = connection.send_head(&sent).await;
        assert_eq!(
            (got.status, got.error(), got.header("connection")),
            (status, error.into(), Some("close")),
            "{sent:?}"
        );
        connection.send_body(&sent).await.expect("sends the body");
        if let Err(cause) = connection.ended().await {
            reset.push(format!("{error}: {cause}"));
        }
    }
    assert!(reset.is_empty(), "reset after the answer: {reset:#?}");
    off.shutdown().await;
    on.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closing_refusal_ends_the_connection_at_once_for_a_body_that_never_comes() {
    let harness = Harness::start(Options::default()).await;
    let sent = post(&harness, "/v1/inputs")
        .header("content-type", "application/json")
        .body("{}");
    let mut connection = Connection::open(harness.port).await;
    let asked = std::time::Instant::now();
    let got = connection.send_head(&sent).await;
    assert_eq!(got.error(), "actions_disabled");
    connection.ended().await.expect("closed, not reset");
    // The server keeps reading for a late body for 2 s, but the client is told at once.
    let waited = asked.elapsed();
    assert!(waited < Duration::from_secs(1), "{waited:?}");
    drop(connection);
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_body_is_checked_field_by_field_and_unknown_fields_are_refused() {
    let harness = actions_on().await;
    for (body, detail) in [
        (json!({ "id": ID, "text": "   " }), "text is not valid"),
        (
            json!({ "id": ID.to_uppercase().replace('0', "A"), "text": "x" }),
            "id is not valid",
        ),
        (
            json!({ "id": ID, "text": "x", "extra": 1 }),
            "unknown field",
        ),
        (
            json!({ "id": ID, "sessionId": "00000000-0000-4000-8000-0000000000aa", "projectId": "00000000-0000-4000-8000-0000000000bb", "text": "x" }),
            "projectId is not valid",
        ),
        (json!([]), "body is not valid"),
    ] {
        let got = send(harness.port, &json_post(&harness, "/v1/inputs", &body)).await;
        assert_eq!(
            (got.status, got.error(), got.json()["detail"].clone()),
            (400, "invalid_body".into(), json!(detail)),
            "{body}"
        );
    }
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_send_runs_the_apps_checks_in_its_order_before_the_outbox() {
    let harness = actions_on().await;
    harness
        .sessions
        .add(session_row("2026-10-20-0c0c0c0c", None, None));
    harness.sessions.add(session_row(
        "2026-10-20-0d0d0d0d",
        Some("conv-1234567"),
        Some("worker"),
    ));
    harness.sessions.add(session_row(
        "2026-10-20-0e0e0e0e",
        Some("conv-1234567"),
        None,
    ));
    let send_to = |session: &str| json!({ "id": ID, "sessionId": session, "text": "hello" });
    let cases = [
        (
            send_to("00000000-0000-4000-8000-0000000000aa"),
            404,
            "session_not_found",
        ),
        (send_to("2026-10-20-0c0c0c0c"), 409, "no_chat"),
        (
            send_to("2026-10-20-0d0d0d0d"),
            409,
            "session_not_controllable",
        ),
        (
            json!({ "id": ID, "projectId": "00000000-0000-4000-8000-0000000000bb", "text": "hello" }),
            503,
            "unavailable",
        ),
    ];
    for (body, status, error) in cases {
        let got = send(harness.port, &json_post(&harness, "/v1/inputs", &body)).await;
        assert_eq!((got.status, got.error()), (status, error.into()), "{body}");
    }
    let no_chat = send(
        harness.port,
        &json_post(&harness, "/v1/inputs", &send_to("2026-10-20-0c0c0c0c")),
    )
    .await;
    assert_eq!(
        no_chat.json()["detail"],
        "this session has no ChatGPT chat to send to"
    );
    let inputs = send(
        harness.port,
        &Sent::get("/v1/inputs").header("authorization", &harness.auth()),
    )
    .await;
    assert_eq!(
        inputs.json(),
        json!({ "inputs": [], "total": 0 }),
        "nothing reached the outbox"
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_is_a_404_for_an_unknown_message_and_for_a_path_that_is_not_an_id() {
    let harness = actions_on().await;
    let unknown = send(
        harness.port,
        &post(&harness, &format!("/v1/inputs/{ID}/cancel")),
    )
    .await;
    assert_eq!(
        (unknown.status, unknown.error()),
        (404, "input_not_found".into())
    );
    let bad = send(harness.port, &post(&harness, "/v1/inputs/BAD/cancel")).await;
    assert_eq!((bad.status, bad.error()), (404, "not_found".into()));
    let with_body = send(
        harness.port,
        &json_post(
            &harness,
            &format!("/v1/inputs/{ID}/cancel"),
            &json!({ "reason": "x" }),
        ),
    )
    .await;
    assert_eq!(
        (with_body.status, with_body.json()["detail"].clone()),
        (400, json!("unknown field"))
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spends_30_actions_a_minute_and_none_while_actions_are_off() {
    let harness = Harness::start(Options::default()).await;
    let cancel = format!("/v1/inputs/{ID}/cancel");
    for _ in 0..40 {
        assert_eq!(
            send(harness.port, &post(&harness, &cancel)).await.status,
            403
        );
    }
    harness.set_config(true, true);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let mut connection = Connection::open(harness.port).await;
    for index in 0..30 {
        assert_eq!(
            connection.send(&post(&harness, &cancel)).await.status,
            404,
            "action {index}"
        );
    }
    let limited = connection.send(&post(&harness, &cancel)).await;
    assert_eq!(
        (limited.status, limited.error()),
        (429, "rate_limited".into())
    );
    assert_eq!(limited.header("retry-after"), Some("60"));
    harness.shutdown().await;
}
