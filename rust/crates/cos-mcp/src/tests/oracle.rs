//! Replays `oracle/sdk-oracle.json`: what the TypeScript app's MCP SDK answers to JSON-RPC,
//! Streamable HTTP and header edge cases the golden corpus does not record, on both protocol
//! eras. A `firstFrame` case is a stream that stays open, compared up to its first frame.

use std::sync::Arc;

use cos_tools::{ServerInfo, SurfaceId};
use serde_json::Value;

use super::{Conn, Fake, Req, lock, path_of, same, start, tool_result};

const ORACLE: &str = include_str!("../../oracle/sdk-oracle.json");
const ORACLE_HEADERS: [&str; 6] = [
    "content-type",
    "cache-control",
    "allow",
    "connection",
    "mcp-session-id",
    "x-accel-buffering",
];

fn kept(reply: &super::Reply) -> Value {
    let mut kept = serde_json::Map::new();
    for name in ORACLE_HEADERS {
        if let Some(value) = reply.header(name) {
            kept.insert(name.to_owned(), Value::String(value.to_owned()));
        }
    }
    Value::Object(kept)
}

fn body_of(text: &str, event_stream: bool) -> Value {
    if event_stream {
        let reply = super::Reply {
            status: 200,
            headers: Vec::new(),
            body: text.as_bytes().to_vec(),
        };
        return Value::Array(reply.messages());
    }
    serde_json::from_str(text).unwrap_or(Value::String(text.to_owned()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_oracle_case_is_answered_as_the_sdk_answers_it() {
    let oracle: serde_json::Map<String, Value> = serde_json::from_str(ORACLE).expect("oracle json");
    let echo = oracle["list-no-params"]["response"]["body"]
        .as_str()
        .map(|text| body_of(text, true))
        .and_then(|messages| messages[0]["result"]["tools"].as_array().cloned())
        .expect("the oracle lists its echo tool");
    let fake = Arc::new(Fake::default());
    lock(&fake.info).insert(
        SurfaceId::Core,
        ServerInfo {
            name: "oracle",
            version: "1",
            instructions: "hi".to_owned(),
        },
    );
    lock(&fake.tools).insert(SurfaceId::Core, echo);
    let started = start(&fake).await;
    let handler_errors = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = handler_errors.clone();
    started.logger.on_log(move |entry| {
        if entry.message.starts_with("MCP handler error") {
            lock(&seen).push(entry.message.clone());
        }
    });
    let addr = started.endpoint.listener.local_addr();
    let path = path_of(&started.endpoint.urls().core);
    let mut failures = Vec::new();
    let mut compared = 0;
    let mut modern = 0;
    for (name, case) in &oracle {
        let request = &case["request"];
        let expected = &case["response"];
        let mut req = Req::new(request["method"].as_str().unwrap_or("POST"), &path);
        let headers = request["headers"].as_object().cloned().unwrap_or_default();
        if !headers.contains_key("host") {
            req = req.header("host", &format!("127.0.0.1:{}", addr.port()));
        }
        for (header, value) in &headers {
            req = req.header(header, value.as_str().unwrap_or_default());
        }
        let sent_body = request["body"].as_str();
        if let Some(body) = sent_body {
            req = req.body(body);
        }
        let expected_sse = expected["headers"]["content-type"] == "text/event-stream";
        let expected_body = body_of(expected["body"].as_str().unwrap_or_default(), expected_sse);
        // A tools/call that reached the tool: the fake kernel returns the SDK's own result.
        if sent_body.is_some_and(|body| body.contains("\"tools/call\"")) {
            let messages = match &expected_body {
                Value::Array(messages) => messages.clone(),
                message => vec![message.clone()],
            };
            for message in messages {
                if let Some(result) = message.get("result") {
                    lock(&fake.script).push_back(Ok(tool_result(result)));
                }
            }
        }
        let mut conn = Conn::open(addr).await;
        let reply = if request["firstFrame"] == true {
            conn.first_frame(&req).await
        } else {
            conn.send(&req).await
        };
        let Some(reply) = reply else {
            failures.push(format!("{name}: no answer"));
            continue;
        };
        compared += 1;
        if name.starts_with("modern-") {
            modern += 1;
        }
        let actual_body = body_of(
            &reply.text(),
            reply.header("content-type") == Some("text/event-stream"),
        );
        if u64::from(reply.status) != expected["status"].as_u64().unwrap_or_default() {
            failures.push(format!(
                "{name}: status {} != {}",
                reply.status, expected["status"]
            ));
        }
        if !same(&kept(&reply), &expected["headers"]) {
            failures.push(format!(
                "{name}: headers {} != {}",
                kept(&reply),
                expected["headers"]
            ));
        }
        if !same(&actual_body, &expected_body) {
            failures.push(format!(
                "{name}: body\n  got  {actual_body}\n  want {expected_body}"
            ));
        }
        // The app's `onerror` sees only what the SDK's Node adapter reports, so an
        // `MCP handler error` line appears exactly where the SDK reported one.
        let logged = std::mem::take(&mut *lock(&handler_errors));
        let reported = case["reported"].as_array().map_or(0, Vec::len);
        if logged.len() != reported {
            failures.push(format!(
                "{name}: {} handler-error lines {logged:?}, the SDK reported {reported}",
                logged.len()
            ));
        }
        lock(&fake.script).clear();
    }
    eprintln!("oracle: {compared} cases compared, {modern} named for the 2026-07-28 era");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(compared, oracle.len());
}
