//! The listener over real loopback HTTP: who may call it, when it runs, and the files that say
//! where it is (`test/control-api.test.ts`).

use std::time::Duration;

use super::client::{Connection, Sent, send};
use super::harness::{Harness, Options, read_endpoint};

fn get(harness: &Harness, target: &str) -> Sent {
    Sent::get(target).header("authorization", &harness.auth())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publishes_its_port_and_a_per_launch_token_only_while_running() {
    let mut harness = Harness::start(Options::default()).await;
    let endpoint: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(harness.control_dir().join("endpoint.json")).expect("endpoint"),
    )
    .expect("json");
    let keys: Vec<&str> = endpoint
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["protocol", "port", "pid", "appVersion", "startedAt"]);
    assert_eq!(endpoint["protocol"], 1);
    assert_eq!(endpoint["pid"], std::process::id());
    assert_eq!(endpoint["appVersion"], "2.1.35");
    let token_text = std::fs::read_to_string(harness.control_dir().join("token")).expect("token");
    assert!(token_text.ends_with('\n'));
    assert_eq!(harness.token.len(), 43);
    let first = (harness.port, harness.token.clone());

    harness.set_config(false, false);
    for _ in 0..200 {
        if !harness.control_dir().join("token").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!harness.control_dir().join("endpoint.json").exists());
    assert!(!harness.control_dir().join("token").exists());
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", first.0))
            .await
            .is_err(),
        "still listening after the switch went off"
    );

    harness.set_config(true, false);
    harness.reload_endpoint().await;
    assert_ne!(harness.token, first.1, "a restart reused the token");
    assert_eq!(
        send(harness.port, &get(&harness, "/v1/health"))
            .await
            .status,
        200
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_removes_the_endpoint_and_token_and_stops_listening() {
    let harness = Harness::start(Options::default()).await;
    let dir = harness.control_dir();
    let port = harness.port;
    let ended = tokio::spawn(async move {
        harness.shutdown().await;
    });
    ended.await.expect("shuts down");
    assert!(read_endpoint(&dir).is_none());
    assert!(!dir.join("endpoint.json").exists() && !dir.join("token").exists());
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stays_off_and_writes_nothing_while_disabled() {
    let harness = Harness::start(Options {
        enabled: false,
        ..Options::default()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!harness.control_dir().exists());
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_only_an_authenticated_local_caller_with_no_origin_and_its_own_host() {
    let harness = Harness::start(Options::default()).await;
    let port = harness.port;
    let auth = harness.auth();
    let status = |sent: Sent| async move { send(port, &sent).await };

    assert_eq!(status(Sent::get("/v1/health")).await.status, 401);
    let wrong = format!("Bearer {}x", &harness.token[1..]);
    assert_eq!(
        status(Sent::get("/v1/health").header("authorization", &wrong))
            .await
            .status,
        401
    );
    let bare = harness.token.clone();
    assert_eq!(
        status(Sent::get("/v1/health").header("authorization", &bare))
            .await
            .status,
        401
    );
    // An Origin is refused before authentication, so a page learns nothing even with a token.
    let from_page =
        status(get(&harness, "/v1/health").header("origin", "https://chatgpt.com")).await;
    assert_eq!(
        (from_page.status, from_page.error()),
        (403, "origin_forbidden".into())
    );
    assert!(from_page.header("access-control-allow-origin").is_none());
    let unauthenticated_page = status(Sent::get("/v1/health").header("origin", "null")).await;
    assert_eq!(unauthenticated_page.error(), "origin_forbidden");
    for host in [
        "attacker.example".to_owned(),
        format!("127.0.0.1:{}", port + 1),
        format!("LOCALHOST:{port}"),
    ] {
        let refused = status(get(&harness, "/v1/health").header("host", &host)).await;
        assert_eq!(
            (refused.status, refused.error()),
            (403, "host_forbidden".into()),
            "{host}"
        );
    }
    let local =
        status(get(&harness, "/v1/health").header("host", &format!("localhost:{port}"))).await;
    assert_eq!(local.status, 200);

    let health = status(get(&harness, "/v1/health")).await;
    assert_eq!(health.status, 200);
    assert_eq!(health.header("cache-control"), Some("no-store"));
    assert_eq!(
        health.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(health.header("connection"), Some("keep-alive"));
    let body = health.json();
    assert_eq!(body["ok"], true);
    assert_eq!(body["pid"], std::process::id());
    assert!(body["uptimeSeconds"].is_u64());
    assert!(
        !health
            .body
            .windows(auth.len())
            .any(|window| window == auth.as_bytes())
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn is_read_only_get_without_a_body_and_known_routes_only() {
    let harness = Harness::start(Options::default()).await;
    let port = harness.port;
    let post = send(
        port,
        &Sent::post("/v1/status").header("authorization", &harness.auth()),
    )
    .await;
    assert_eq!((post.status, post.header("allow")), (405, Some("GET")));
    let put = send(
        port,
        &Sent {
            method: "PUT".into(),
            ..get(&harness, "/v1/inputs")
        },
    )
    .await;
    assert_eq!((put.status, put.header("allow")), (405, Some("GET, POST")));
    let get_cancel = send(
        port,
        &get(
            &harness,
            "/v1/inputs/00000000-0000-4000-8000-000000000000/cancel",
        ),
    )
    .await;
    assert_eq!(
        (get_cancel.status, get_cancel.header("allow")),
        (405, Some("POST"))
    );

    // A body on a read is refused, and read off the connection so the next request is served.
    let mut connection = Connection::open(port).await;
    let with_body = get(&harness, "/v1/status")
        .header("content-type", "application/json")
        .body("{}");
    let refused = connection.send(&with_body).await;
    assert_eq!(
        (refused.status, refused.error()),
        (413, "body_not_allowed".into())
    );
    assert_eq!(refused.header("connection"), Some("keep-alive"));
    assert_eq!(
        connection.send(&get(&harness, "/v1/health")).await.status,
        200
    );

    let large = get(&harness, "/v1/status").body(vec![b'x'; 1024 * 1024]);
    assert_eq!(send(port, &large).await.status, 413);
    for target in [
        "/v1/nothing",
        "/",
        "/v1/sessions/not-a-session-id-at-all!",
        "/v1/sessions/a/b/c",
        "/v1/health/",
    ] {
        let missing = send(port, &get(&harness, target)).await;
        assert_eq!(
            (missing.status, missing.error()),
            (404, "not_found".into()),
            "{target}"
        );
    }
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_target_that_is_not_plain_origin_form_whatever_the_method() {
    let harness = Harness::start(Options::default()).await;
    for target in ["//v1/health", "/v1\\health", "/v1/health?x=\\"] {
        for method in ["GET", "POST"] {
            let sent = Sent {
                method: method.into(),
                ..get(&harness, target)
            };
            let refused = send(harness.port, &sent).await;
            assert_eq!(
                (refused.status, refused.error()),
                (400, "invalid_target".into()),
                "{method} {target}"
            );
        }
    }
    let absolute = format!("http://127.0.0.1:{}/v1/health", harness.port);
    assert_eq!(
        send(harness.port, &get(&harness, &absolute)).await.error(),
        "invalid_target"
    );
    // Dot segments are resolved as a URL parser resolves them.
    assert_eq!(
        send(harness.port, &get(&harness, "/v1/x/../health"))
            .await
            .status,
        200
    );
    assert_eq!(
        send(harness.port, &get(&harness, "/v1/%2e/health"))
            .await
            .status,
        200
    );
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn charges_600_reads_a_minute_after_authentication() {
    let harness = Harness::start(Options::default()).await;
    let mut connection = Connection::open(harness.port).await;
    for _ in 0..5 {
        assert_eq!(connection.send(&Sent::get("/v1/health")).await.status, 401);
    }
    for index in 0..600 {
        let reply = connection.send(&get(&harness, "/v1/health")).await;
        assert_eq!(reply.status, 200, "request {index}");
    }
    let limited = connection.send(&get(&harness, "/v1/health")).await;
    assert_eq!(
        (limited.status, limited.error()),
        (429, "rate_limited".into())
    );
    assert_eq!(limited.header("retry-after"), None);
    harness.shutdown().await;
}
