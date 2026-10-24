//! Replays the golden corpus (`rust/golden`) against the endpoint. The fake kernel answers
//! with the recorded server info, tool lists and call results, so every difference these
//! tests find is in the transport: status, headers, framing, envelopes, guards.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cos_tools::{RequestId, ServerInfo, SurfaceId, UnknownTool};
use serde_json::{Value, json};

use super::{Conn, Fake, Payload, Reply, Req, leak, lock, path_of, same, start, tool_result};
use crate::{MAX_BODY_BYTES, McpEndpoint};

const MCP_ACCEPT: &str = "application/json, text/event-stream";

fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden")
}

fn read(path: &Path) -> Value {
    let text =
        fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn cases(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default();
    files.retain(|path| path.extension().is_some_and(|ext| ext == "json"));
    files.sort();
    files
}

fn variants() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(golden())
        .expect("the golden corpus is present")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("mcp").is_dir() || path.join("http").is_dir())
        .collect();
    dirs.sort();
    dirs
}

/// Whether C1.2's `RequestId::from_header` exists yet. Until it does, cases are replayed
/// without their `x-request-id` header, which the transport would otherwise hand to it.
fn request_ids_parse() -> bool {
    std::panic::catch_unwind(|| RequestId::from_header("wfr_probe/1")).is_ok()
}

/// A fake kernel that knows the variant's recorded server info and tool lists.
fn recorded_kernel(variant: &Path) -> Arc<Fake> {
    let fake = Arc::new(Fake::default());
    for &surface in SurfaceId::ALL {
        let dir = variant.join("mcp").join(surface.as_str());
        if let Some(result) = dir
            .join("initialize.json")
            .exists()
            .then(|| read(&dir.join("initialize.json")))
            .map(|case| case["response"]["messages"][0]["result"].clone())
        {
            lock(&fake.info).insert(
                surface,
                ServerInfo {
                    name: leak(result["serverInfo"]["name"].as_str().unwrap_or_default()),
                    version: leak(result["serverInfo"]["version"].as_str().unwrap_or_default()),
                    instructions: result["instructions"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                },
            );
        }
        if dir.join("tools-list.json").exists() {
            let tools =
                read(&dir.join("tools-list.json"))["response"]["messages"][0]["result"]["tools"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
            lock(&fake.tools).insert(surface, tools);
        }
    }
    fake
}

struct Replay {
    compared: usize,
    failures: Vec<String>,
}

impl Replay {
    fn new() -> Self {
        Self {
            compared: 0,
            failures: Vec::new(),
        }
    }

    fn check(&mut self, case: &Path, what: &str, actual: &Value, expected: &Value) {
        if !same(actual, expected) {
            self.failures.push(format!(
                "{} {what}\n  got  {actual}\n  want {expected}",
                case.strip_prefix(golden()).unwrap_or(case).display()
            ));
        }
    }

    fn finish(self, name: &str) {
        eprintln!("{name}: {} cases compared", self.compared);
        assert!(self.compared > 0, "{name}: no cases found");
        assert!(self.failures.is_empty(), "{}", self.failures.join("\n"));
    }
}

/// An MCP request as the recorder's `mcpSession` sends it.
fn rpc(endpoint: &McpEndpoint, surface: SurfaceId, body: &Value, version: Option<&str>) -> Req {
    let mut req = Req::new("POST", &path_of(endpoint.urls().of(surface)))
        .header("host", &format!("127.0.0.1:{}", endpoint.port()))
        .header("content-type", "application/json")
        .header("accept", MCP_ACCEPT);
    if let Some(version) = version {
        req = req.header("mcp-protocol-version", version);
    }
    req.body(body.to_string())
}

/// The recorder's `mcpResponse`: status, framing and the JSON-RPC messages.
fn mcp_response(reply: &Reply) -> Value {
    let sse = reply
        .header("content-type")
        .is_some_and(|value| value.contains("text/event-stream"));
    let messages = if sse {
        reply.messages()
    } else if reply.body.is_empty() {
        Vec::new()
    } else {
        vec![reply.json()]
    };
    let framing = match (sse, reply.body.is_empty()) {
        (true, _) => "sse",
        (false, false) => "json",
        (false, true) => "empty",
    };
    json!({ "status": reply.status, "framing": framing, "messages": messages })
}

/// The recorder's `httpBody`, with this generation's tokens and port written as the corpus
/// placeholders.
fn http_body(reply: &Reply, endpoint: &McpEndpoint) -> (&'static str, Value) {
    let mut text = reply.text();
    for &surface in SurfaceId::ALL {
        let url = endpoint.urls().of(surface);
        let token = url.rsplit('/').next().unwrap_or_default();
        text = text.replace(token, &format!("<MCP_TOKEN:{}>", surface.as_str()));
    }
    text = text.replace(
        &format!("127.0.0.1:{}", endpoint.port()),
        "127.0.0.1:<MCP_PORT>",
    );
    let normalized = Reply {
        status: reply.status,
        headers: reply.headers.clone(),
        body: text.into_bytes(),
    };
    if reply
        .header("content-type")
        .is_some_and(|value| value.contains("event-stream"))
    {
        ("frames", Value::Array(normalized.frames()))
    } else {
        ("body", normalized.json())
    }
}

fn script(fake: &Fake, recorded: &Value) {
    let message = &recorded["messages"][0];
    let outcome = if let Some(result) = message.get("result") {
        Ok(tool_result(result))
    } else {
        let text = message["error"]["message"].as_str().unwrap_or_default();
        let name = text
            .strip_prefix("Tool ")
            .and_then(|rest| rest.strip_suffix(" not found"))
            .unwrap_or_else(|| panic!("no kernel outcome gives the error {message}"));
        Err(UnknownTool(name.to_owned()))
    };
    lock(&fake.script).push_back(outcome);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_surface_session_and_tool_call_is_framed_as_recorded() {
    let with_request_ids = request_ids_parse();
    let mut replay = Replay::new();
    for variant in variants() {
        let fake = recorded_kernel(&variant);
        let started = start(&fake).await;
        let endpoint = &started.endpoint;
        let addr = endpoint.listener.local_addr();
        for &surface in SurfaceId::ALL {
            let dir = variant.join("mcp").join(surface.as_str());
            let initialize = dir.join("initialize.json");
            if !initialize.exists() {
                continue;
            }
            let case = read(&initialize);
            let version = case["request"]["protocolVersion"]
                .as_str()
                .unwrap_or_default();
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": version, "capabilities": {}, "clientInfo": { "name": "cos-golden", "version": "1" } } });
            let mut conn = Conn::open(addr).await;
            let reply = conn
                .send(&rpc(endpoint, surface, &body, None))
                .await
                .expect("answers");
            let mut response = mcp_response(&reply);
            response["headers"] = reply.kept_headers();
            let expected = &case["response"];
            replay.check(&initialize, "initialize", &response, &json!({
                "status": expected["status"], "framing": expected["framing"], "messages": expected["messages"], "headers": expected["headers"] }));
            replay.compared += 1;

            let negotiated = response["messages"][0]["result"]["protocolVersion"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
            let reply = conn
                .send(&rpc(endpoint, surface, &initialized, Some(&negotiated)))
                .await
                .expect("answers");
            replay.check(
                &initialize,
                "notifications/initialized",
                &json!(reply.status),
                &json!(202),
            );

            let list = dir.join("tools-list.json");
            let case = read(&list);
            let id = case["response"]["messages"][0]["id"].clone();
            let body = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list", "params": {} });
            let reply = conn
                .send(&rpc(endpoint, surface, &body, Some(&negotiated)))
                .await
                .expect("answers");
            replay.check(
                &list,
                "tools/list",
                &mcp_response(&reply),
                &case["response"],
            );
            replay.compared += 1;

            for call in cases(&dir.join("calls")) {
                let case = read(&call);
                let request = &case["request"];
                script(&fake, &case["response"]);
                let id = case["response"]["messages"][0]["id"].clone();
                let tool = request["tool"].as_str().unwrap_or_default();
                let body = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call",
                    "params": { "name": tool, "arguments": request["arguments"] } });
                let mut req = rpc(endpoint, surface, &body, Some(&negotiated));
                if with_request_ids {
                    for (name, value) in request["headers"].as_object().into_iter().flatten() {
                        req = req.header(name, value.as_str().unwrap_or_default());
                    }
                }
                let reply = conn.send(&req).await.expect("answers");
                replay.check(
                    &call,
                    "tools/call",
                    &mcp_response(&reply),
                    &case["response"],
                );
                let seen = lock(&fake.calls).last().map(|(at, name, arguments, _)| {
                    json!({ "surface": at.as_str(), "tool": name, "arguments": arguments })
                });
                replay.check(
                    &call,
                    "kernel input",
                    &json!(seen),
                    &json!({
                    "surface": surface.as_str(), "tool": tool, "arguments": request["arguments"] }),
                );
                replay.compared += 1;
            }
        }
        started.endpoint.stop(cos_http::Drain::Graceful).await;
    }
    if !with_request_ids {
        eprintln!(
            "x-request-id headers were not replayed: RequestId::from_header is not built yet"
        );
    }
    replay.finish("surfaces and calls");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_protocol_case_is_answered_as_recorded() {
    let mut replay = Replay::new();
    for variant in variants() {
        let dir = variant.join("mcp/core/protocol");
        if !dir.is_dir() {
            continue;
        }
        let fake = recorded_kernel(&variant);
        let started = start(&fake).await;
        let endpoint = &started.endpoint;
        let addr = endpoint.listener.local_addr();
        for path in cases(&dir) {
            let case = read(&path);
            let request = &case["request"];
            let expected = &case["response"];
            if let Some(version) = request.get("protocolVersion") {
                let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                    "protocolVersion": version, "capabilities": {}, "clientInfo": { "name": "cos-golden", "version": "1" } } });
                let reply = Conn::open(addr)
                    .await
                    .send(&rpc(endpoint, SurfaceId::Core, &body, None))
                    .await
                    .expect("answers");
                let response = mcp_response(&reply);
                let message = &response["messages"][0];
                replay.check(&path, "initialize", &json!({
                    "status": response["status"], "framing": response["framing"],
                    "negotiated": message["result"]["protocolVersion"], "error": message.get("error").cloned().unwrap_or(Value::Null) }), expected);
            } else if request.get("headers").is_some() {
                let method = request["method"].as_str().unwrap_or("POST");
                let mut req = Req::new(method, &path_of(&endpoint.urls().core))
                    .header("host", &format!("127.0.0.1:{}", endpoint.port()));
                for (name, value) in request["headers"].as_object().into_iter().flatten() {
                    req = req.header(name, value.as_str().unwrap_or_default());
                }
                match &request["body"] {
                    Value::Null => {}
                    Value::String(text) => req = req.body(text.as_str()),
                    body => req = req.body(body.to_string()),
                }
                let reply = Conn::open(addr).await.send(&req).await.expect("answers");
                let (kind, body) = http_body(&reply, endpoint);
                let mut response =
                    json!({ "status": reply.status, "headers": reply.kept_headers() });
                response[kind] = body;
                replay.check(&path, "http", &response, expected);
            } else {
                let id = expected["messages"][0]["id"].clone();
                let body = json!({ "jsonrpc": "2.0", "id": id, "method": request["method"], "params": request["params"] });
                let reply = Conn::open(addr)
                    .await
                    .send(&rpc(endpoint, SurfaceId::Core, &body, Some("2025-06-18")))
                    .await
                    .expect("answers");
                replay.check(&path, "rpc", &mcp_response(&reply), expected);
            }
            replay.compared += 1;
        }
        started.endpoint.stop(cos_http::Drain::Graceful).await;
    }
    replay.finish("protocol");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_listener_guard_case_is_answered_as_recorded() {
    let mut replay = Replay::new();
    for variant in variants() {
        let dir = variant.join("http/mcp-guards");
        if !dir.is_dir() {
            continue;
        }
        let fake = recorded_kernel(&variant);
        let started = start(&fake).await;
        let endpoint = &started.endpoint;
        let addr = endpoint.listener.local_addr();
        let substitute = |text: &str| {
            let mut text = text.replace("<MCP_PORT>", &endpoint.port().to_string());
            for &surface in SurfaceId::ALL {
                let url = endpoint.urls().of(surface);
                let token = url.rsplit('/').next().unwrap_or_default();
                text = text.replace(&format!("<MCP_TOKEN:{}>", surface.as_str()), token);
            }
            text
        };
        for path in cases(&dir) {
            let case = read(&path);
            let request = &case["request"];
            let method = request["method"].as_str().unwrap_or("GET");
            let mut req = Req::new(method, &substitute(request["path"].as_str().unwrap_or("/")));
            let headers = request["headers"].as_object().cloned().unwrap_or_default();
            if !headers.contains_key("host") {
                req = req.header("host", &format!("127.0.0.1:{}", endpoint.port()));
            }
            for (name, value) in &headers {
                req = req.header(name, &substitute(value.as_str().unwrap_or_default()));
            }
            let oversized = vec![b' '; MAX_BODY_BYTES + 1];
            req.payload = match &request["body"] {
                Value::Null => Payload::None,
                Value::String(note) if note.ends_with("with Content-Length") => {
                    Payload::Bytes(oversized)
                }
                Value::String(note) if note.ends_with("chunked") => Payload::Chunked(oversized),
                Value::String(text) => Payload::Bytes(text.as_bytes().to_vec()),
                body => Payload::Bytes(body.to_string().into_bytes()),
            };
            let reply = Conn::open(addr).await.send(&req).await.expect("answers");
            let (kind, body) = http_body(&reply, endpoint);
            let mut response = json!({ "status": reply.status, "headers": reply.kept_headers() });
            response[kind] = body;
            replay.check(&path, "guard", &response, &case["response"]);
            replay.compared += 1;
        }
        started.endpoint.stop(cos_http::Drain::Graceful).await;
    }
    replay.finish("listener guards");
}
