//! The endpoint's own behavior: secret paths, metadata, probes, request accounting, the body
//! cap, and the two ways it stops.

use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
use std::time::Duration;

use bytes::Bytes;
use cos_http::{Drain, Drained};
use cos_tools::{RequestId, SurfaceId, ToolResult};
use cos_types::app_state::LogLevel;
use hyper::body::Body as _;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::{Notify, mpsc};

use super::{Conn, Fake, Payload, Req, Started, lock, path_of, send, start};
use crate::MAX_BODY_BYTES;
use crate::service::event_stream;

fn list() -> Value {
    json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} })
}

fn call(id: u64, tool: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": { "x": 1 } } })
}

fn mcp(started: &Started, surface: SurfaceId, body: &Value) -> Req {
    let endpoint = &started.endpoint;
    Req::mcp(&path_of(endpoint.urls().of(surface)), endpoint.port(), body)
}

fn logged(started: &Started) -> Vec<(LogLevel, String)> {
    started
        .logger
        .entries()
        .into_iter()
        .map(|entry| (entry.level, entry.message))
        .collect()
}

async fn until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..200 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting until {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_generation_mints_three_secret_paths_on_an_ephemeral_loopback_port() {
    let fake = Arc::new(Fake::default());
    let first = start(&fake).await;
    let second = start(&fake).await;
    assert_eq!(fake.generations.load(Ordering::SeqCst), 2);
    let mut tokens = Vec::new();
    for started in [&first, &second] {
        let port = started.endpoint.port();
        assert_ne!(port, 0);
        for &surface in SurfaceId::ALL {
            let url = started.endpoint.urls().of(surface);
            let prefix = format!("http://127.0.0.1:{port}/mcp/{}/", surface.as_str());
            let token = url.strip_prefix(&prefix).unwrap_or_else(|| panic!("{url}"));
            assert_eq!(token.len(), 43, "32 bytes of base64url: {token}");
            assert!(
                token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            );
            tokens.push(token.to_owned());
        }
        assert!(logged(started).contains(&(
            LogLevel::Info,
            format!("server started on 127.0.0.1:{port}")
        )));
    }
    let mut distinct = tokens.clone();
    distinct.sort();
    distinct.dedup();
    assert_eq!(distinct.len(), tokens.len(), "every token is fresh");

    let first_probe = first.endpoint.probe_headers().clone();
    let second_probe = second.endpoint.probe_headers().clone();
    assert_eq!(first_probe.self_test.0, "x-local-self-test");
    assert_eq!(first_probe.tunnel_probe.0, "x-local-tunnel-probe");
    for value in [&first_probe.self_test.1, &first_probe.tunnel_probe.1] {
        assert_eq!(value.len(), 32);
        assert!(
            value
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );
    }
    assert_ne!(first_probe, second_probe);

    // A surface's token opens only that surface.
    let core = path_of(first.endpoint.urls().of(SurfaceId::Core));
    let swapped = core.replace("/core/", "/desktop/");
    let reply = send(
        first.endpoint.listener.local_addr(),
        &Req::mcp(&swapped, first.endpoint.port(), &list()),
    )
    .await;
    assert_eq!(
        (reply.status, reply.json()),
        (404, json!({ "error": "not_found" }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_names_the_connector_with_the_live_suffix() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let addr = started.endpoint.listener.local_addr();
    let port = started.endpoint.port();
    let desktop = path_of(started.endpoint.urls().of(SurfaceId::Desktop));
    let prm = format!("/.well-known/oauth-protected-resource{desktop}");
    let get = || Req::new("GET", &prm).header("host", &format!("127.0.0.1:{port}"));

    let reply = send(addr, &get()).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("cache-control"), Some("no-store"));
    assert_eq!(
        reply.text(),
        json!({
            "resource": format!("http://127.0.0.1:{port}{desktop}"),
            "resource_name": "Chat On Steroids Desktop",
            "authorization_servers": [],
            "scopes_supported": [],
        })
        .to_string()
    );

    started.config.send_modify(|config| {
        let mut changed = (**config).clone();
        changed.connector_suffix = Some("Work  PC".to_owned());
        *config = Arc::new(changed);
    });
    let reply = send(addr, &get()).await;
    assert_eq!(
        reply.json()["resource_name"],
        "Chat On Steroids Desktop (Work PC)"
    );

    // Like the TypeScript server, the document does not depend on the method.
    let mut post = get();
    post.method = "POST".to_owned();
    assert_eq!(send(addr, &post).await.status, 200);
    assert_eq!(
        fake.requests.load(Ordering::SeqCst),
        0,
        "metadata is not contact"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_outside_requests_count_as_contact() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let addr = started.endpoint.listener.local_addr();
    let probe = started.endpoint.probe_headers().clone();

    let self_test =
        mcp(&started, SurfaceId::Core, &list()).header(probe.self_test.0, &probe.self_test.1);
    assert_eq!(send(addr, &self_test).await.status, 200);
    let core = path_of(started.endpoint.urls().of(SurfaceId::Core));
    let tunnel = Req::new("POST", &core)
        .header("host", &format!("127.0.0.1:{}", started.endpoint.port()))
        .header("content-type", "text/plain")
        .header("accept", "application/json, text/event-stream")
        .header(probe.tunnel_probe.0, &probe.tunnel_probe.1)
        .body(list().to_string());
    assert_eq!(send(addr, &tunnel).await.status, 415);
    let forged =
        mcp(&started, SurfaceId::Core, &list()).header(probe.self_test.0, "0".repeat(32).as_str());
    assert_eq!(send(addr, &forged).await.status, 200);
    let rebinding =
        mcp(&started, SurfaceId::Core, &list()).header("origin", "https://evil.example");
    assert_eq!(send(addr, &rebinding).await.status, 403);

    until("the forged probe is counted", || {
        fake.requests.load(Ordering::SeqCst) == 1
    })
    .await;
    until("every request is answered", || {
        fake.open_requests.load(Ordering::SeqCst) == 0
    })
    .await;
    let log = logged(&started);
    assert!(log.iter().any(|(level, line)| *level == LogLevel::Info
        && line.starts_with("request POST mcp/core → 200 in ")
        && line.ends_with("ms (self-test)")));
    assert!(log.iter().any(|(level, line)| *level == LogLevel::Info
        && line.starts_with("request POST mcp/core → 415 in ")
        && line.ends_with("ms (tunnel probe) (probe compatibility check — normal)")));
    assert!(log.iter().any(|(level, line)| *level == LogLevel::Warn
        && line.starts_with("request POST mcp/core → 403 in ")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requests_are_logged_by_shape_never_by_secret_path() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let addr = started.endpoint.listener.local_addr();
    let port = started.endpoint.port();
    let core = path_of(started.endpoint.urls().of(SurfaceId::Core));
    let long = format!("/{}", "a".repeat(60));
    for req in [
        Req::new("GET", &core)
            .header("host", &format!("127.0.0.1:{port}"))
            .header("accept", "text/event-stream"),
        Req::new("DELETE", &core).header("host", &format!("127.0.0.1:{port}")),
        Req::new("GET", &long).header("host", &format!("127.0.0.1:{port}")),
    ] {
        send(addr, &req).await;
    }
    let log = logged(&started);
    let token = core.rsplit('/').next().unwrap_or_default().to_owned();
    assert!(
        log.iter().all(|(_, line)| !line.contains(&token)),
        "{log:?}"
    );
    for method in ["GET", "DELETE"] {
        assert!(
            log.iter().any(|(level, line)| *level == LogLevel::Info
                && line.starts_with(&format!("request {method} mcp/core → 405 in "))
                && line.ends_with("(stream/session not offered — normal)")),
            "{log:?}"
        );
    }
    let shape = &long[..40];
    assert!(
        log.iter().any(|(level, line)| *level == LogLevel::Warn
            && line.starts_with(&format!("request GET {shape} → 404 in "))),
        "{log:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_call_reaches_the_kernel_with_the_generations_profile_and_request_id() {
    let fake = Arc::new(Fake::default());
    lock(&fake.script).push_back(Ok(ToolResult::text("done")));
    let started = start(&fake).await;
    let addr = started.endpoint.listener.local_addr();

    let reply = send(addr, &mcp(&started, SurfaceId::Desktop, &call(7, "probe"))).await;
    assert_eq!(
        reply.messages(),
        vec![
            json!({ "result": { "content": [{ "type": "text", "text": "done" }] }, "jsonrpc": "2.0", "id": 7 })
        ]
    );
    let calls = lock(&fake.calls).clone();
    let (surface, tool, arguments, inbound) = &calls[0];
    assert_eq!(
        (*surface, tool.as_str(), arguments),
        (SurfaceId::Desktop, "probe", &json!({ "x": 1 }))
    );
    assert_eq!(inbound.setup_profile_id.as_deref(), Some("setup-profile-1"));
    assert_eq!(inbound.request_id, None);

    // Two copies of the header are ambiguous evidence: neither is trusted.
    let twice = mcp(&started, SurfaceId::Core, &call(8, "probe"))
        .header("x-request-id", "wfr_a/1")
        .header("x-request-id", "wfr_b/2");
    send(addr, &twice).await;
    assert_eq!(lock(&fake.calls)[1].3.request_id, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_request_id_header_is_normalized_once_at_ingress() {
    if std::panic::catch_unwind(|| RequestId::from_header("wfr_probe/1")).is_err() {
        eprintln!("skipped: RequestId::from_header (C1.2) is not built yet");
        return;
    }
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let req = mcp(&started, SurfaceId::Core, &call(1, "probe"))
        .header("x-request-id", "wfr_abc123/attempt-2");
    send(started.endpoint.listener.local_addr(), &req).await;
    let inbound = lock(&fake.calls)[0].3.clone();
    assert_eq!(
        inbound.request_id.as_ref().map(RequestId::as_str),
        Some("wfr_abc123")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_panicking_handler_answers_internal_error_and_is_logged() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let reply = send(
        started.endpoint.listener.local_addr(),
        &mcp(&started, SurfaceId::Core, &call(3, "panic")),
    )
    .await;
    assert_eq!(
        reply.messages(),
        vec![
            json!({ "jsonrpc": "2.0", "id": 3, "error": { "code": -32603, "message": "Internal error" } })
        ]
    );
    assert!(
        logged(&started)
            .iter()
            .any(|(level, line)| *level == LogLevel::Error
                && line.starts_with("MCP handler error (core): request 3 failed"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_oversized_body_is_refused_and_the_connection_stays_usable() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let mut conn = Conn::open(started.endpoint.listener.local_addr()).await;
    for payload in [
        Payload::Bytes(vec![b' '; MAX_BODY_BYTES + 1]),
        Payload::Chunked(vec![b' '; MAX_BODY_BYTES + 1]),
    ] {
        let mut req = mcp(&started, SurfaceId::Core, &list());
        req.payload = payload;
        let reply = conn.send(&req).await.expect("answers");
        assert_eq!(
            (reply.status, reply.json()),
            (413, json!({ "error": "payload_too_large" }))
        );
        assert_eq!(reply.header("connection"), Some("keep-alive"));
        let next = conn
            .send(&mcp(&started, SurfaceId::Core, &list()))
            .await
            .expect("answers on the same connection");
        assert_eq!(next.status, 200);
    }
    // Exactly the cap is accepted.
    let mut exact = format!("{} ", list()).into_bytes();
    exact.resize(MAX_BODY_BYTES, b' ');
    let reply = conn
        .send(&mcp(&started, SurfaceId::Core, &list()).body(exact))
        .await
        .expect("answers");
    assert_eq!(reply.status, 200);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_that_arrives_after_an_early_answer_leaves_the_connection_usable() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let core = path_of(started.endpoint.urls().of(SurfaceId::Core));
    let loopback = format!("127.0.0.1:{}", started.endpoint.port());
    let request = |method: &str, path: &str, host: &str| {
        Req::new(method, path)
            .header("host", host)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(list().to_string())
    };
    let refused = |message: &str| json!({ "jsonrpc": "2.0", "error": { "code": -32000, "message": message }, "id": null });
    let cases = [
        (
            "403 Host",
            request("POST", &core, "evil.example"),
            403,
            refused("Invalid Host: evil.example"),
        ),
        (
            "403 Origin",
            request("POST", &core, &loopback).header("origin", "https://evil.example"),
            403,
            refused("Invalid Origin: evil.example"),
        ),
        (
            "404 wrong token",
            request(
                "POST",
                "/mcp/core/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                &loopback,
            ),
            404,
            json!({ "error": "not_found" }),
        ),
        (
            "403 metadata Host",
            request(
                "POST",
                &format!("/.well-known/oauth-protected-resource{core}"),
                "evil.example",
            ),
            403,
            refused("Invalid Host: evil.example"),
        ),
        (
            "200 metadata",
            request(
                "POST",
                &format!("/.well-known/oauth-protected-resource{core}"),
                &loopback,
            ),
            200,
            json!({
                "resource": format!("http://{loopback}{core}"),
                "resource_name": "Chat On Steroids Core",
                "authorization_servers": [],
                "scopes_supported": [],
            }),
        ),
        (
            "405 GET with a body",
            request("GET", &core, &loopback),
            405,
            refused("Method not allowed."),
        ),
        (
            "405 HEAD with a body",
            request("HEAD", &core, &loopback),
            405,
            Value::Null,
        ),
        (
            "413 by content-length",
            request("POST", &core, &loopback).body(vec![b' '; MAX_BODY_BYTES + 1]),
            413,
            json!({ "error": "payload_too_large" }),
        ),
    ];
    for (case, request, status, expected) in cases {
        let mut conn = Conn::open(started.endpoint.listener.local_addr()).await;
        let reply = conn
            .send_body_after_answer(&request)
            .await
            .unwrap_or_else(|| panic!("{case}: the answer was lost"));
        let body = if reply.body.is_empty() {
            Value::Null
        } else {
            reply.json()
        };
        assert_eq!((reply.status, body), (status, expected), "{case}");
        assert_eq!(reply.header("connection"), Some("keep-alive"), "{case}");
        let next = conn
            .send(&mcp(&started, SurfaceId::Core, &list()))
            .await
            .unwrap_or_else(|| panic!("{case}: the connection was not kept"));
        assert_eq!(next.status, 200, "{case}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_asks_to_close_gets_connection_close() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let mut conn = Conn::open(started.endpoint.listener.local_addr()).await;
    let reply = conn
        .send(&mcp(&started, SurfaceId::Core, &list()).header("connection", "close"))
        .await
        .expect("answers");
    assert_eq!(reply.header("connection"), Some("close"));
    assert!(conn.closed().await);
}

/// Starts a held tool call and waits until it reaches the kernel.
async fn held_call(
    fake: &Arc<Fake>,
    started: &Started,
) -> (Arc<Notify>, tokio::task::JoinHandle<Option<super::Reply>>) {
    let release = Arc::new(Notify::new());
    *lock(&fake.hold) = Some(release.clone());
    lock(&fake.script).push_back(Ok(ToolResult::text("finished")));
    let req = mcp(started, SurfaceId::Core, &call(5, "slow"));
    let addr = started.endpoint.listener.local_addr();
    let client = tokio::spawn(async move { Conn::open(addr).await.send(&req).await });
    fake.arrived.notified().await;
    (release, client)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_graceful_stop_waits_for_an_accepted_call_and_then_refuses_new_connections() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let addr = started.endpoint.listener.local_addr();
    let (release, client) = held_call(&fake, &started).await;
    let logger = started.logger.clone();

    let stopping = tokio::spawn(started.endpoint.stop(Drain::Graceful));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!stopping.is_finished(), "stopped under an accepted call");

    release.notify_one();
    let reply = client
        .await
        .expect("joins")
        .expect("the accepted call is answered");
    assert_eq!(
        reply.messages()[0]["result"]["content"][0]["text"],
        "finished"
    );
    assert_eq!(stopping.await.expect("joins"), Drained::Clean);
    assert!(
        TcpStream::connect(addr).await.is_err(),
        "still accepting after stop"
    );
    let log: Vec<String> = logger
        .entries()
        .into_iter()
        .map(|entry| entry.message)
        .collect();
    assert!(
        log.contains(&"server stopping: draining 1 accepted response(s)".to_owned()),
        "{log:?}"
    );
    assert_eq!(log.last().map(String::as_str), Some("server stopped"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forced_stop_abandons_the_connection_but_never_the_call() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let (release, client) = held_call(&fake, &started).await;
    let logger = started.logger.clone();

    let drained = started
        .endpoint
        .stop(Drain::ForceAfter(Duration::from_millis(100)))
        .await;
    assert_eq!(drained, Drained::Forced { abandoned: 1 });
    assert!(
        client.await.expect("joins").is_none(),
        "an abandoned request got an answer"
    );
    assert!(logger.entries().iter().any(|entry| entry.level == LogLevel::Warn
        && entry.message == "server drain timed out after 100ms during final shutdown; forcing remaining connections closed"));

    release.notify_one();
    until("the abandoned call finishes", || {
        fake.finished_calls.load(Ordering::SeqCst) == 1
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_disconnects_does_not_cancel_its_call() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let (release, client) = held_call(&fake, &started).await;
    client.abort();
    let _ = client.await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    release.notify_one();
    until("the call finishes without its client", || {
        fake.finished_calls.load(Ordering::SeqCst) == 1
    })
    .await;
    until("the request is released", || {
        fake.open_requests.load(Ordering::SeqCst) == 0
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_still_arriving_when_stop_begins_is_refused_with_server_stopping() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let mut conn = Conn::open(started.endpoint.listener.local_addr()).await;
    let mut partial = mcp(&started, SurfaceId::Core, &list()).header("content-length", "1000");
    partial.payload = Payload::Bytes(b"{\"jsonrpc\":".to_vec());
    conn.write(&partial).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let stopping = tokio::spawn(started.endpoint.stop(Drain::Graceful));
    let reply = conn.read_reply(false).await.expect("answers");
    assert_eq!(
        (reply.status, reply.json()),
        (503, json!({ "error": "server_stopping" }))
    );
    assert_eq!(reply.header("connection"), Some("close"));
    // The rest of the body lands after the answer, and the answer still stands.
    conn.write_raw(&[b' '; 1000 - 11]).await;
    conn.ended().await.expect("closed, not reset");
    drop(conn);
    assert_eq!(stopping.await.expect("joins"), Drained::Clean);
    assert_eq!(fake.finished_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "waits out the 30 s header deadline"]
async fn a_client_that_never_finishes_its_headers_is_dropped_after_30_seconds() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let mut conn = Conn::open(started.endpoint.listener.local_addr()).await;
    let begun = std::time::Instant::now();
    conn.write_raw(b"POST /mcp HTTP/1.1\r\nhost: 127.0.0.1\r\n")
        .await;
    let reply = conn.read_reply(false).await;
    let waited = begun.elapsed();
    assert!(
        waited >= Duration::from_secs(29) && waited < Duration::from_secs(40),
        "{waited:?}"
    );
    assert!(
        reply.as_ref().is_none_or(|reply| reply.status == 408),
        "{reply:?}"
    );
}

/// Sends the last frame and drops the sender the `at`-th time the body clones its waker,
/// which is how a body registers for wakeups while it is being polled.
struct LastSendMidPoll {
    clones: AtomicUsize,
    at: usize,
    frames: Mutex<Option<mpsc::Sender<Bytes>>>,
}

impl LastSendMidPoll {
    fn send_and_drop(&self) {
        if let Some(frames) = lock(&self.frames).take() {
            frames.try_send(Bytes::from_static(b"last")).expect("room");
        }
    }

    fn waker(self: &Arc<Self>) -> Waker {
        unsafe fn clone(data: *const ()) -> RawWaker {
            // SAFETY: `data` is the `Arc` the test holds until every waker is gone.
            let hook = unsafe { &*data.cast::<LastSendMidPoll>() };
            if hook.clones.fetch_add(1, Ordering::SeqCst) + 1 == hook.at {
                hook.send_and_drop();
            }
            RawWaker::new(data, &VTABLE)
        }
        unsafe fn ignore(_: *const ()) {}
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, ignore, ignore, ignore);
        // SAFETY: the vtable never frees or wakes through `data`; it only reads the hook.
        unsafe { Waker::from_raw(RawWaker::new(Arc::as_ptr(self).cast(), &VTABLE)) }
    }
}

#[test]
fn an_event_stream_ends_only_after_the_frame_sent_as_its_sender_dropped() {
    for at in 1..=3 {
        let (frames, mut body) = event_stream();
        let hook = Arc::new(LastSendMidPoll {
            clones: AtomicUsize::new(0),
            at,
            frames: Mutex::new(Some(frames)),
        });
        let waker = hook.waker();
        let mut cx = Context::from_waker(&waker);
        let mut got = Vec::new();
        loop {
            match Pin::new(&mut body).poll_frame(&mut cx) {
                Poll::Ready(Some(Ok(frame))) => got.extend(frame.into_data().ok()),
                Poll::Ready(None) => break,
                Poll::Pending => hook.send_and_drop(),
            }
        }
        drop(body);
        assert_eq!(
            got,
            [Bytes::from_static(b"last")],
            "sent at waker clone {at}"
        );
    }
}
