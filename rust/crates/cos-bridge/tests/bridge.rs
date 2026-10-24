//! The bridge's HTTP contract, case by case from `test/bridge.test.ts` and
//! `test/bridge-port-lifecycle.test.ts`.

mod support;

use std::sync::Arc;

use cos_bridge::{BoxFuture, Exchange, Family, MAX_BODY_BYTES, RATE_LIMIT, Reply, Route};
use cos_secrets::{SecretKey, SecretStore};
use cos_store::BridgePortOverride;
use cos_tools::Phase;
use cos_types::config::BrowserBridgePort;
use serde_json::json;
use support::{EXTENSION_ORIGIN, Fixture, Options, Request, config_with, send};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn binds_a_loopback_port_from_the_override_and_says_so() {
    let bridge = Fixture::start(Options::default()).await;
    let status = bridge.status();
    assert!(status.running);
    assert_ne!(status.port, Some(0));
    assert_eq!(status.port_overridden, Some(true));
    assert_eq!(status.error, Some(None));
    assert!(
        bridge
            .log_lines()
            .iter()
            .any(|line| line == &format!("bridge listening on 127.0.0.1:{}", bridge.port()))
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_unknown_rather_than_incompatible_to_a_hello_without_a_protocol() {
    let bridge = Fixture::start(Options::default()).await;
    let plain = bridge
        .request(Request::get("/hello").origin(None).protocol(None))
        .await;
    assert_eq!(plain.status, 200);
    assert_eq!(
        plain.body,
        json!({ "app": "chat-on-steroids", "version": "2.1.35", "bridge": 14, "compatible": null, "paired": false, "disconnected": false })
    );
    assert_eq!(
        bridge.request(Request::get("/hello")).await.body["compatible"],
        true
    );
    let old = bridge
        .request(
            Request::get("/hello")
                .protocol(Some("13"))
                .header("x-extension-version", "0.0.1"),
        )
        .await;
    assert_eq!(old.body["compatible"], false);
    let status = bridge
        .wait(|status| status.extension_version.as_deref() == Some("0.0.1"))
        .await;
    assert!(
        !status.present && status.last_seen_at.is_none(),
        "a /hello is not presence"
    );
    let refused = bridge
        .request(Request::post("/pair").protocol(Some("13")))
        .await;
    assert_eq!(refused.status, 426);
    assert_eq!(
        refused.body,
        json!({ "error": "incompatible_extension", "bridge": 14, "version": "2.1.35" })
    );
    assert!(
        bridge
            .log_lines()
            .iter()
            .any(|line| line.starts_with("bridge: the browser extension speaks protocol 13"))
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_every_web_page_origin_and_serves_no_origin_and_extensions() {
    let bridge = Fixture::start(Options::default()).await;
    for origin in [
        "https://chatgpt.com",
        "https://evil.example.com",
        "http://localhost:3000",
        "null",
    ] {
        let reply = bridge
            .request(Request::get("/hello").origin(Some(origin)))
            .await;
        assert_eq!(reply.status, 403, "{origin}");
        assert_eq!(reply.body, json!({ "error": "forbidden_origin" }));
        assert_eq!(reply.header("access-control-allow-origin"), None);
        let pair = bridge
            .request(Request::post("/pair").origin(Some(origin)))
            .await;
        assert_eq!(
            (pair.status, pair.body["token"].is_null()),
            (403, true),
            "{origin}"
        );
    }
    let bare = bridge.request(Request::get("/hello").origin(None)).await;
    assert_eq!(
        (bare.status, bare.header("access-control-allow-origin")),
        (200, None)
    );
    let extension = bridge.request(Request::get("/hello")).await;
    assert_eq!(
        extension.header("access-control-allow-origin"),
        Some(EXTENSION_ORIGIN)
    );
    assert_eq!(extension.header("cache-control"), Some("no-store"));
    assert_eq!(extension.header("content-type"), Some("application/json"));
    assert_eq!(
        bridge.request(Request::get("/hello")).await.body["paired"],
        false
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_an_extension_preflight_and_refuses_one_without_an_origin() {
    let bridge = Fixture::start(Options::default()).await;
    let reply = send(bridge.port(), Request::new("OPTIONS", "/events")).await;
    assert_eq!(reply.status, 204);
    assert_eq!(
        reply.header("access-control-allow-origin"),
        Some(EXTENSION_ORIGIN)
    );
    assert_eq!(
        reply.header("access-control-allow-private-network"),
        Some("true")
    );
    assert_eq!(reply.header("access-control-max-age"), Some("600"));
    assert!(
        reply
            .header("access-control-allow-headers")
            .is_some_and(|value| value.contains("x-extension-build"))
    );
    let bare = send(
        bridge.port(),
        Request::new("OPTIONS", "/events").origin(None),
    )
    .await;
    assert_eq!(
        (bare.status, bare.body.clone()),
        (403, json!({ "error": "forbidden_origin" }))
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issues_a_token_with_nothing_to_type_and_stores_it_encrypted() {
    let bridge = Fixture::start(Options::default()).await;
    let token = bridge.pair().await;
    assert_eq!(token.len(), 43);
    assert!(
        token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    );
    assert_eq!(
        bridge.request(Request::get("/hello")).await.body["paired"],
        true
    );
    // A fresh store reads what the bridge wrote: the file on disk, not a cache.
    let mut store = SecretStore::new(&bridge.dir);
    assert_eq!(
        store.get(&SecretKey::BridgeToken).as_deref(),
        Some(token.as_str())
    );
    let raw = std::fs::read(bridge.dir.join("secrets.bin")).expect("secrets.bin");
    assert!(raw.starts_with(b"v10"));
    assert!(
        !raw.windows(token.len())
            .any(|window| window == token.as_bytes()),
        "the token is stored in the clear"
    );
    let status = bridge.wait(|status| status.paired && status.present).await;
    assert!(status.last_seen_at.is_some());
    assert!(
        bridge
            .log_lines()
            .iter()
            .any(|line| line == "bridge: browser extension connected and provisioned")
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_pairing_replaces_the_token_and_reuse_shares_one() {
    let bridge = Fixture::start(Options::default()).await;
    let first = bridge.pair().await;
    let second = bridge.pair().await;
    assert_ne!(first, second);
    assert_eq!(
        bridge
            .request(Request::get("/status").bearer(&first))
            .await
            .status,
        401
    );
    // Past the gates: E2.4 has not claimed /status, so it is the fall-through.
    let passed = bridge
        .request(Request::get("/status").bearer(&second))
        .await;
    assert_eq!(
        (passed.status, passed.body.clone()),
        (404, json!({ "error": "not_found" }))
    );

    let port = bridge.port();
    let replies = futures_join(
        (0..6)
            .map(|_| send(port, Request::post("/pair").json(&json!({ "reuse": true }))))
            .collect(),
    )
    .await;
    let tokens: std::collections::HashSet<String> = replies
        .iter()
        .map(|reply| reply.body["token"].as_str().expect("a token").to_owned())
        .collect();
    assert_eq!(tokens.len(), 1, "browser profiles revoked one another");
    assert!(tokens.contains(&second));
    bridge.shutdown().await;
}

async fn futures_join(
    requests: Vec<impl Future<Output = support::Reply> + Send + 'static>,
) -> Vec<support::Reply> {
    let handles: Vec<_> = requests.into_iter().map(tokio::spawn).collect();
    let mut replies = Vec::new();
    for handle in handles {
        replies.push(handle.await.expect("joins"));
    }
    replies
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_stays_latched_across_a_restart_until_the_browser_reconnects() {
    let dir = support::scratch("cos-bridge-latch");
    let bridge = Fixture::start_in(dir.clone(), Options::default()).await;
    let token = bridge.pair().await;
    bridge.bridge.disconnect().await.expect("disconnects");
    let denied = bridge.request(Request::get("/status").bearer(&token)).await;
    assert_eq!(
        (denied.status, denied.body.clone()),
        (401, json!({ "error": "browser_disconnected" }))
    );
    let mut first_run = bridge;
    if let Some(task) = first_run.task.take() {
        task.shutdown().await;
    }

    // The relevant half of an app restart: a new store has to read the latch from disk.
    let bridge = Fixture::start_in(dir, Options::default()).await;
    let silent = bridge
        .request(Request::post("/pair").json(&json!({ "reuse": true })))
        .await;
    assert_eq!(
        (silent.status, silent.body.clone()),
        (409, json!({ "error": "browser_disconnected" }))
    );
    let hello = bridge.request(Request::get("/hello")).await;
    assert_eq!(
        (
            hello.body["paired"].clone(),
            hello.body["disconnected"].clone()
        ),
        (json!(false), json!(true))
    );
    let reconnect = bridge
        .request(Request::post("/pair").json(&json!({ "reconnect": true })))
        .await;
    assert_eq!(reconnect.status, 200);
    let fresh = reconnect.body["token"]
        .as_str()
        .expect("a token")
        .to_owned();
    assert_ne!(fresh, token);
    assert_eq!(
        bridge
            .request(Request::get("/status").bearer(&fresh))
            .await
            .status,
        404
    );
    assert_eq!(
        bridge.request(Request::get("/hello")).await.body["disconnected"],
        false
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_every_route_but_hello_and_pair_without_the_right_token() {
    let bridge = Fixture::start(Options::default()).await;
    let issued = bridge.pair().await;
    for (method, path) in [
        ("GET", "/status"),
        ("GET", "/activity?conversationId=abcdabcd"),
        ("POST", "/events"),
        ("POST", "/correlations"),
        ("POST", "/closed"),
        ("POST", "/live-preview"),
        ("POST", "/commands/ack"),
        ("POST", "/extension/update"),
    ] {
        let reply = bridge
            .request(Request::new(method, path).json(&json!({})))
            .await;
        assert_eq!(
            (reply.status, reply.body.clone()),
            (401, json!({ "error": "unauthorised" })),
            "{path}"
        );
    }
    let last = issued.chars().last().expect("a token");
    let forged = format!(
        "{}{}",
        &issued[..issued.len() - 1],
        if last == 'A' { 'B' } else { 'A' }
    );
    assert_eq!(
        bridge
            .request(Request::get("/status").bearer(&forged))
            .await
            .status,
        401
    );
    let wrong_scheme = bridge
        .request(Request::get("/status").header("authorization", &format!("bearer {issued}")))
        .await;
    assert_eq!(wrong_scheme.status, 401);
    let incompatible = bridge
        .request(Request::get("/status").bearer(&issued).protocol(Some("13")))
        .await;
    assert_eq!(incompatible.status, 426);
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn has_no_route_that_reads_a_file_or_runs_anything() {
    let bridge = Fixture::start(Options::default()).await;
    let token = bridge.pair().await;
    for path in ["/read", "/exec", "/config", "/secrets", "/../config.json"] {
        assert_eq!(
            bridge
                .request(Request::get(path).bearer(&token))
                .await
                .status,
            404,
            "{path}"
        );
    }
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keeps_observations_until_their_owner_exists() {
    let bridge = Fixture::start(Options::default()).await;
    let token = bridge.pair().await;
    let events = bridge
        .request(
            Request::post("/events")
                .bearer(&token)
                .json(&json!({ "events": [] })),
        )
        .await;
    assert_eq!(
        (events.status, events.body.clone()),
        (
            503,
            json!({ "error": "bridge_recovering", "retryable": true })
        )
    );
    let other = bridge
        .request(Request::post("/closed").bearer(&token).json(&json!({})))
        .await;
    assert_eq!(other.status, 404);
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_an_over_sized_body_with_an_answer_not_a_reset() {
    let bridge = Fixture::start(Options::default()).await;
    let reply = bridge
        .request(Request::post("/pair").raw(vec![b'x'; MAX_BODY_BYTES + 1024 * 1024]))
        .await;
    assert_eq!(
        (reply.status, reply.body.clone()),
        (413, json!({ "error": "body_too_large" }))
    );
    let broken = bridge
        .request(Request::post("/pair").raw(b"{not json".to_vec()))
        .await;
    assert_eq!(
        (broken.status, broken.body.clone()),
        (400, json!({ "error": "bad_request" }))
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn charges_900_authenticated_requests_a_minute_then_refuses() {
    let bridge = Fixture::start(Options::default()).await;
    let token = bridge.pair().await;
    // The pairing above was the first request in this window.
    for _ in 0..(RATE_LIMIT - 1) {
        assert_eq!(
            bridge
                .request(Request::get("/status").bearer(&token))
                .await
                .status,
            404
        );
    }
    let refused = bridge.request(Request::get("/status").bearer(&token)).await;
    assert_eq!(
        (refused.status, refused.body.clone()),
        (429, json!({ "error": "rate_limited" }))
    );
    // Unauthenticated callers are refused before they are charged.
    assert_eq!(bridge.request(Request::get("/status")).await.status, 401);
    assert_eq!(bridge.request(Request::get("/hello")).await.status, 200);
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn routed_requests_wait_for_restore_but_discovery_and_pairing_do_not() {
    let bridge = Fixture::start(Options {
        serving: false,
        ..Options::default()
    })
    .await;
    assert_eq!(bridge.request(Request::get("/hello")).await.status, 200);
    let token = bridge.pair().await;
    let early = bridge
        .request(
            Request::post("/extension/update")
                .bearer(&token)
                .json(&json!({})),
        )
        .await;
    assert_eq!(
        (early.status, early.body.clone()),
        (
            503,
            json!({ "error": "bridge_recovering", "retryable": true })
        )
    );
    bridge.gate.advance(Phase::Serving);
    let served = bridge
        .request(
            Request::post("/extension/update")
                .bearer(&token)
                .json(&json!({})),
        )
        .await;
    assert_eq!(
        (served.status, served.body.clone()),
        (200, json!({ "ready": false }))
    );
    bridge.shutdown().await;
}

struct Echo;

impl Family for Echo {
    fn routes(&self) -> &'static [Route] {
        const ROUTES: &[Route] = &[Route::post("/echo"), Route::get("/boom")];
        ROUTES
    }

    fn serve(self: Arc<Self>, mut exchange: Exchange) -> BoxFuture<Reply> {
        Box::pin(async move {
            if exchange.path() == "/boom" {
                panic!("a family bug");
            }
            let body = exchange.json(16).await;
            Reply::ok(&json!({
                "body": body.ok(),
                "q": exchange.query("q"),
                "host": exchange.peer().host.map(|host| host.as_str()),
            }))
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_family_gets_the_parsed_peer_and_body_and_a_panic_is_an_internal_error() {
    let bridge = Fixture::start(Options {
        routes: Some(Box::new(|routes| routes.family(Arc::new(Echo)))),
        ..Options::default()
    })
    .await;
    let token = bridge.pair().await;
    let echoed = bridge
        .request(
            Request::post("/echo?q=a+b")
                .bearer(&token)
                .header("x-extension-host", "cos")
                .json(&json!({ "x": 1 })),
        )
        .await;
    assert_eq!(
        echoed.body,
        json!({ "body": { "x": 1 }, "q": "a b", "host": "cos" })
    );
    let capped = bridge
        .request(
            Request::post("/echo")
                .bearer(&token)
                .json(&json!({ "long": "x".repeat(32) })),
        )
        .await;
    assert_eq!(capped.body["body"], json!(null));
    assert_eq!(
        bridge
            .request(Request::get("/echo").bearer(&token))
            .await
            .status,
        404,
        "the wrong method falls through"
    );
    let boom = bridge.request(Request::get("/boom").bearer(&token)).await;
    assert_eq!(
        (boom.status, boom.body.clone()),
        (500, json!({ "error": "internal" }))
    );
    assert!(
        bridge
            .log_lines()
            .iter()
            .any(|line| line.starts_with("bridge request failed:"))
    );
    bridge.shutdown().await;
}

#[test]
#[should_panic(expected = "two bridge families claim")]
fn two_families_cannot_claim_one_route() {
    struct Update;
    impl Family for Update {
        fn routes(&self) -> &'static [Route] {
            const ROUTES: &[Route] = &[Route::any("/extension/update")];
            ROUTES
        }
        fn serve(self: Arc<Self>, _exchange: Exchange) -> BoxFuture<Reply> {
            Box::pin(async { Reply::internal() })
        }
    }
    let dir = support::scratch("cos-bridge-routes");
    let folder = cos_bridge::ExtensionFolder::checkout(dir.clone(), &dir);
    let _ = cos_bridge::Routes::new(folder, cos_store::Logger::new()).family(Arc::new(Update));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_occupied_fixed_port_is_reported_and_a_settings_save_retries() {
    let blocker = std::net::TcpListener::bind("127.0.0.1:0").expect("binds");
    let taken = blocker.local_addr().expect("an address").port();
    let bridge = Fixture::start(Options {
        ports_override: None,
        port: BrowserBridgePort::Fixed(taken),
        ..Options::default()
    })
    .await;
    let status = bridge.status();
    assert!(!status.running);
    assert_eq!(status.port_overridden, Some(false));
    assert_eq!(
        status.error,
        Some(Some(format!(
            "Port {taken} is already in use (EADDRINUSE)."
        )))
    );
    drop(blocker);
    let free = free_port();
    bridge
        .config
        .send_replace(config_with(BrowserBridgePort::Fixed(free)));
    let status = bridge.wait(|status| status.running).await;
    assert_eq!(
        (status.port, status.error.clone()),
        (Some(free), Some(None))
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_port_change_moves_the_listener_keeps_the_pairing_and_forgets_presence() {
    let first = free_port();
    let bridge = Fixture::start(Options {
        ports_override: None,
        port: BrowserBridgePort::Fixed(first),
        ..Options::default()
    })
    .await;
    let token = bridge.pair().await;
    bridge.wait(|status| status.present).await;

    let blocker = std::net::TcpListener::bind("127.0.0.1:0").expect("binds");
    let taken = blocker.local_addr().expect("an address").port();
    bridge
        .config
        .send_replace(config_with(BrowserBridgePort::Fixed(taken)));
    let refused = bridge
        .wait(|status| status.error.clone().flatten().is_some())
        .await;
    assert_eq!(refused.port, Some(first), "a taken port moved the bridge");
    assert_eq!(
        send(first, Request::get("/status").bearer(&token))
            .await
            .status,
        404
    );
    drop(blocker);

    let second = free_port();
    bridge
        .config
        .send_replace(config_with(BrowserBridgePort::Fixed(second)));
    let moved = bridge.wait(|status| status.port == Some(second)).await;
    assert_eq!(
        (moved.paired, moved.present, moved.error.clone()),
        (true, false, Some(None))
    );
    assert_eq!(
        send(second, Request::get("/status").bearer(&token))
            .await
            .status,
        404
    );
    for _ in 0..50 {
        if std::net::TcpStream::connect(("127.0.0.1", first)).is_err() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(
        std::net::TcpStream::connect(("127.0.0.1", first)).is_err(),
        "the old port still listens"
    );
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_override_holds_the_port_against_a_settings_change() {
    let bridge = Fixture::start(Options {
        ports_override: BridgePortOverride::parse("0"),
        ..Options::default()
    })
    .await;
    let port = bridge.port();
    bridge
        .config
        .send_replace(config_with(BrowserBridgePort::Fixed(free_port())));
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(bridge.status().port, Some(port));
    bridge.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requires_a_fresh_sighting_after_the_bridge_stops() {
    let bridge = Fixture::start(Options::default()).await;
    bridge.pair().await;
    bridge.wait(|status| status.present).await;
    let status = bridge.bridge.status();
    let mut fixture = bridge;
    if let Some(task) = fixture.task.take() {
        task.shutdown().await;
    }
    let stopped = status.borrow().clone();
    assert_eq!(
        (
            stopped.running,
            stopped.paired,
            stopped.present,
            stopped.last_seen_at
        ),
        (false, true, false, None)
    );
    assert!(
        fixture
            .log_lines()
            .iter()
            .any(|line| line == "bridge stopped")
    );
    fixture.shutdown().await;
}

fn free_port() -> u16 {
    let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("binds");
    probe.local_addr().expect("an address").port()
}
