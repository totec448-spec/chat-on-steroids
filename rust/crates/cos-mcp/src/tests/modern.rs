//! The 2026-07-28 era where the SDK oracle cannot reach: a subscription stream across an
//! endpoint stop, and the app-log line that names each new client's protocol.

use std::sync::Arc;
use std::time::Duration;

use cos_http::{Drain, Drained};
use cos_tools::{ServerInfo, SurfaceId};
use serde_json::{Value, json};

use super::{Conn, Fake, Reply, Req, Started, lock, path_of, send, start};

const REVISION: &str = "2026-07-28";

fn enveloped(method: &str, params: Value, version: &str, client: &str) -> Value {
    let mut params = params;
    params["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { "name": client, "version": "1.0.0" },
    });
    json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
}

fn modern(started: &Started, body: &Value) -> Req {
    let endpoint = &started.endpoint;
    let path = path_of(endpoint.urls().of(SurfaceId::Core));
    Req::mcp(&path, endpoint.port(), body)
        .header(
            "mcp-protocol-version",
            body["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"]
                .as_str()
                .unwrap_or_default(),
        )
        .header("mcp-method", body["method"].as_str().unwrap_or_default())
}

fn initialize(started: &Started, version: &str, client: &str) -> Req {
    let endpoint = &started.endpoint;
    let path = path_of(endpoint.urls().of(SurfaceId::Core));
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": version, "capabilities": {}, "clientInfo": { "name": client, "version": "1.0.0" } },
    });
    Req::mcp(&path, endpoint.port(), &body)
}

fn client_lines(started: &Started) -> Vec<String> {
    started
        .logger
        .entries()
        .into_iter()
        .map(|entry| entry.message)
        .filter(|line| line.starts_with("MCP client"))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_ends_a_subscription_with_its_close_result_and_the_drain_completes() {
    let fake = Arc::new(Fake::default());
    lock(&fake.info).insert(
        SurfaceId::Core,
        ServerInfo {
            name: "chat-on-steroids-core",
            version: "2.1.35",
            instructions: String::new(),
        },
    );
    let started = start(&fake).await;
    let addr = started.endpoint.listener.local_addr();
    let listen = enveloped(
        "subscriptions/listen",
        json!({ "notifications": { "toolsListChanged": true, "promptsListChanged": true } }),
        REVISION,
        "openai-mcp",
    );
    let mut conn = Conn::open(addr).await;
    let opened = conn
        .first_frame(&modern(&started, &listen))
        .await
        .expect("the subscription opens");
    assert_eq!(opened.status, 200);
    assert_eq!(opened.header("content-type"), Some("text/event-stream"));
    assert_eq!(
        opened.messages(),
        vec![json!({
            "jsonrpc": "2.0",
            "method": "notifications/subscriptions/acknowledged",
            "params": {
                "notifications": { "toolsListChanged": true },
                "_meta": { "io.modelcontextprotocol/subscriptionId": 1 },
            },
        })]
    );

    let drained = tokio::time::timeout(
        Duration::from_secs(5),
        started.endpoint.stop(Drain::Graceful),
    )
    .await
    .expect("a graceful stop does not wait on an open subscription");
    assert_eq!(drained, Drained::Clean);
    let rest = conn.read_chunked().await.expect("the stream ends cleanly");
    let closed = Reply {
        status: 200,
        headers: Vec::new(),
        body: rest,
    };
    assert_eq!(
        closed.messages(),
        vec![json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "resultType": "complete",
                "_meta": {
                    "io.modelcontextprotocol/subscriptionId": 1,
                    "io.modelcontextprotocol/serverInfo": { "name": "chat-on-steroids-core", "version": "2.1.35" },
                },
            },
        })]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_new_client_is_logged_once_with_the_protocol_it_speaks() {
    let fake = Arc::new(Fake::default());
    let started = start(&fake).await;
    let addr = started.endpoint.listener.local_addr();
    let list = enveloped("tools/list", json!({}), REVISION, "openai-mcp");
    let future = enveloped("tools/list", json!({}), "2027-01-01", "openai-mcp");
    for req in [
        initialize(&started, "2025-06-18", "openai-mcp"),
        initialize(&started, "2025-06-18", "openai-mcp"),
        initialize(&started, REVISION, "openai-mcp"),
        modern(&started, &list),
        modern(&started, &list),
        modern(&started, &future),
        initialize(&started, "2025-06-18", "line\nbreak"),
    ] {
        assert!(send(addr, &req).await.status < 500);
    }
    let probe = started.endpoint.probe_headers().clone();
    let self_test = initialize(&started, "2025-06-18", "self-test-client")
        .header(probe.self_test.0, &probe.self_test.1);
    assert_eq!(send(addr, &self_test).await.status, 200);

    assert_eq!(
        client_lines(&started),
        vec![
            r#"MCP client (core): protocol 2025-06-18 (2025 era, initialize), client "openai-mcp" "1.0.0""#,
            r#"MCP client (core): protocol 2025-11-25 (2025 era, initialize, requested "2026-07-28"), client "openai-mcp" "1.0.0""#,
            r#"MCP client (core): protocol 2026-07-28 (2026 era, per-request envelope), client "openai-mcp" "1.0.0""#,
            r#"MCP client (core): protocol "2027-01-01" refused (2026 era, unsupported revision), client "openai-mcp" "1.0.0""#,
            r#"MCP client (core): protocol 2025-06-18 (2025 era, initialize), client "line\nbreak" "1.0.0""#,
        ]
    );
}
