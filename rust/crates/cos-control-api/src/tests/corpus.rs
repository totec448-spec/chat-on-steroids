//! Replays the golden corpus cases this unit owns (`rust/golden/*/api`) against this crate and
//! compares status, the kept headers and the body, key order included.
//!
//! Session content (the rows of the recorded "Unattributed activity" session) belongs to the
//! session store's unit and is proven by a golden recording of the binary. Each case that this
//! build answers differently on purpose is listed in [`KNOWN`] with why, and checked to differ
//! in exactly that way.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::client::{Connection, Got, Sent};
use std::sync::Arc;

use cos_tools::Inbound;
use cos_types::app_state::SurfaceId;
use cos_types::config::Config;

use super::harness::{BRIDGE_PORT, Harness, Options, config as harness_config, session_row};

const ID: &str = "00000000-0000-4000-8000-000000000000";
const UNATTRIBUTED: &str = "2026-10-20-0a0b0c0d";
const HEADERS_KEPT: &[&str] = &[
    "content-type",
    "cache-control",
    "allow",
    "retry-after",
    "connection",
];

/// Cases replayed against the `base` config (actions off), in recording order.
const BASE: &[&str] = &[
    "health",
    "sessions-bad-limit",
    "sessions-unknown-param",
    "sessions-repeated-param",
    "session-events-bad-kind",
    "session-events-from-and-after",
    "session-not-found",
    "session-events-not-found",
    "session-bad-id",
    "inputs",
    "inputs-state",
    "inputs-bad-state",
    "agents",
    "agents-param",
    "log-bad-level",
    "unknown-route",
    "root",
    "no-token",
    "wrong-token",
    "basic-auth",
    "origin-header",
    "origin-null",
    "bad-host",
    "localhost-host",
    "double-slash-target",
    "backslash-target",
    "post-health",
    "put-inputs",
    "get-cancel",
    "get-with-body",
    "post-inputs-actions-off",
    "post-cancel-actions-off",
    "sse/stream-bad-last-event-id",
    "sse/stream-not-found",
];

/// Cases replayed against the `actions` config, in recording order: `send-uppercase-id` admits
/// a new chat under `ID`, and the cases after it find that row.
const ACTIONS: &[&str] = &[
    "send-not-found-session",
    "send-unattributed-session",
    "send-project-not-found",
    "send-empty-text",
    "send-uppercase-id",
    "send-unknown-field",
    "send-session-and-project",
    "send-no-body",
    "send-invalid-json",
    "send-wrong-content-type",
    "send-query-string",
    "send-too-large",
    "send-chunked",
    "cancel-not-found",
    "cancel-with-body",
    "cancel-bad-id",
];

/// Cases this build answers differently, the answer it gives, and why.
const KNOWN: &[(&str, u16, &str, &str)] = &[(
    "actions/send-project-not-found",
    503,
    "unavailable",
    "no owner of local projects in this build",
)];

fn golden() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../golden")
}

fn case(variant: &str, name: &str) -> Value {
    let folder = if variant == "actions" {
        "api/actions"
    } else {
        "api"
    };
    let file = golden()
        .join(variant)
        .join(folder)
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&file)
        .unwrap_or_else(|error| panic!("{}: {error}", file.display()));
    serde_json::from_str(&text).expect("a corpus case")
}

/// The request as the recorder put it on the wire.
fn request(harness: &Harness, name: &str, recorded: &Value) -> Sent {
    let route = recorded["route"]
        .as_str()
        .expect("a route")
        .replace("<UUID:1>", ID)
        .replace("{unattributed}", UNATTRIBUTED)
        // Node's URL parser reads a backslash as a slash in an http: URL before sending.
        .replace('\\', "/");
    let mut sent = Sent {
        method: recorded["method"].as_str().expect("a method").to_owned(),
        target: route,
        ..Sent::default()
    };
    let headers = recorded["headers"].as_object().cloned().unwrap_or_default();
    if !headers.contains_key("authorization") {
        sent = sent.header("authorization", &harness.auth());
    }
    for (name, value) in headers {
        let value = value
            .as_str()
            .expect("a header")
            .replace("<API_PORT>", &harness.port.to_string());
        sent = sent.header(&name, &value);
    }
    let body = match (name, &recorded["body"]) {
        ("send-too-large", _) => {
            Some(json!({ "id": ID, "text": "x".repeat(512 * 1024) }).to_string())
        }
        ("send-unattributed-session", _) => {
            Some(json!({ "id": ID, "sessionId": UNATTRIBUTED, "text": "hello" }).to_string())
        }
        (_, Value::Null) => None,
        (_, Value::String(raw)) => Some(raw.clone()),
        (_, body) => Some(with_ids(body).to_string()),
    };
    match body {
        Some(body) => sent.body(body),
        None => sent,
    }
}

/// The ids `variants.mjs` sent, where the normalizer numbered them `<UUID:n>` per file.
fn with_ids(body: &Value) -> Value {
    let mut body = body.clone();
    for (key, id) in [
        ("id", ID),
        ("sessionId", "00000000-0000-4000-8000-0000000000aa"),
        ("projectId", "00000000-0000-4000-8000-0000000000bb"),
    ] {
        if body[key]
            .as_str()
            .is_some_and(|value| value.starts_with("<UUID:"))
        {
            body[key] = json!(id);
        }
    }
    body
}

/// The seeded switches of a variant, over the first-launch config.
fn variant_config(variant: &str) -> Arc<Config> {
    let file = golden().join(variant).join("config.json");
    let text = std::fs::read_to_string(file).expect("the seeded config");
    let seeded: Value = serde_json::from_str(&text).expect("json");
    let seeded = &seeded["config"];
    let switch = |value: &Value| value.as_bool().expect("a switch");
    let mut config = (*harness_config(true, false)).clone();
    config.control_api.enabled = switch(&seeded["controlApi"]["enabled"]);
    config.control_api.allow_actions = switch(&seeded["controlApi"]["allowActions"]);
    config.multi_agent.enabled = switch(&seeded["multiAgent"]["enabled"]);
    Arc::new(config)
}

/// The values the corpus normalizer replaces, replaced the same way.
fn normalize(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object.iter_mut() {
                match key.as_str() {
                    "pid" => *value = json!("<PID>"),
                    "startedAt" if value.is_string() => *value = json!("<ISO_TIME>"),
                    "uptimeSeconds" => *value = json!("<DURATION>"),
                    "chars" if value.is_u64() => *value = json!("<CHARS>"),
                    key if key.ends_with("At")
                        && value.as_u64().is_some_and(|ms| {
                            (1_000_000_000_000..10_000_000_000_000).contains(&ms)
                        }) =>
                    {
                        *value = json!("<EPOCH_MS>");
                    }
                    _ => normalize(value),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize),
        Value::String(text) if text == ID => *value = json!("<UUID:1>"),
        _ => {}
    }
}

/// What the corpus keeps of an answer: status, kept headers, normalized body.
fn kept(got: &Got) -> Value {
    let headers: serde_json::Map<String, Value> = HEADERS_KEPT
        .iter()
        .filter_map(|name| {
            got.header(name)
                .map(|value| ((*name).to_owned(), json!(value)))
        })
        .collect();
    let mut body = got.json();
    normalize(&mut body);
    json!({ "status": got.status, "headers": headers, "body": body })
}

fn recorded_answer(case: &Value) -> Value {
    let response = &case["response"];
    json!({ "status": response["status"], "headers": response["headers"], "body": response["body"] })
}

async fn replay(harness: &Harness, variant: &str, name: &str) -> (Value, Value) {
    let case = case(variant, name);
    let got = Connection::open(harness.port)
        .await
        .send(&request(harness, name, &case["request"]))
        .await;
    (kept(&got), recorded_answer(&case))
}

/// Equal as JSON and equal as text, so key order is compared too.
fn assert_same(got: &Value, want: &Value, name: &str) {
    assert_eq!(got, want, "{name}");
    assert_eq!(got.to_string(), want.to_string(), "{name}: key order");
}

async fn rate_limited(harness: &Harness, variant: &str, sent: &Sent, attempts: usize) -> Value {
    let name = "rate-limited";
    let mut connection = Connection::open(harness.port).await;
    for _ in 0..attempts {
        let got = connection.send(sent).await;
        if got.status == 429 {
            let want = recorded_answer(&case(variant, name));
            let got = kept(&got);
            assert_same(&got, &want, &format!("{variant}/{name}"));
            return got;
        }
    }
    panic!("{variant}/{name}: never refused");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_base_variant_answers_as_recorded() {
    let harness = Harness::start(Options {
        config: Some(variant_config("base")),
        ..Options::default()
    })
    .await;
    harness.sessions.add(session_row(UNATTRIBUTED, None, None));
    for name in BASE {
        let (got, want) = replay(&harness, "base", name).await;
        assert_same(&got, &want, &format!("base/{name}"));
    }

    let log = case("base", "log");
    let got = Connection::open(harness.port)
        .await
        .send(&request(&harness, "log", &log["request"]))
        .await;
    // The listener logged that it started, so the page has an entry to describe.
    let body = got.json();
    let first = &body["entries"][0];
    let shape = json!({
        "entries": [{
            "time": first["time"].is_u64().then_some("<number>"),
            "level": first["level"].is_string().then_some("<string>"),
            "message": first["message"].is_string().then_some("<string>"),
        }],
        "ringSize": body["ringSize"].is_u64().then_some("<number>"),
    });
    assert_eq!(
        first.as_object().map(|entry| entry.len()),
        Some(3),
        "base/log: {first}"
    );
    assert_eq!(shape, log["response"]["bodyShape"], "base/log");

    // The ring holds this process's own lines, so its size is the one value that differs.
    let (mut got, mut want) = replay(&harness, "base", "log-future").await;
    for answer in [&mut got, &mut want] {
        answer["body"]["ringSize"] = json!("<RING_SIZE>");
    }
    assert_same(&got, &want, "base/log-future");

    let health = Sent::get("/v1/health").header("authorization", &harness.auth());
    rate_limited(&harness, "base", &health, 700).await;
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_actions_variant_answers_as_recorded() {
    let harness = Harness::start(Options {
        config: Some(variant_config("actions")),
        ..Options::default()
    })
    .await;
    harness.sessions.add(session_row(UNATTRIBUTED, None, None));
    for name in ACTIONS {
        let (got, want) = replay(&harness, "actions", name).await;
        let path = format!("actions/{name}");
        match KNOWN.iter().find(|(known, ..)| *known == path) {
            None => assert_same(&got, &want, &path),
            Some((_, status, error, why)) => {
                assert_ne!(
                    got, want,
                    "{path} now matches the corpus; drop it from KNOWN"
                );
                assert_eq!(
                    (got["status"].as_u64(), got["body"]["error"].as_str()),
                    (Some(u64::from(*status)), Some(*error)),
                    "{path}: {why}"
                );
            }
        }
    }
    let cancel =
        Sent::post(&format!("/v1/inputs/{ID}/cancel")).header("authorization", &harness.auth());
    rate_limited(&harness, "actions", &cancel, 40).await;
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_matches_the_corpus_except_the_owners_this_build_does_not_have() {
    let recorded = case("base", "status");
    let mut connection = recorded["response"]["body"]["connection"].clone();
    // Fill the fields the projection drops. The clocks are the kernel's, so the snapshot's are
    // left empty and the kernel is driven below as the recorder's calls drove it.
    connection["publicUrl"] = Value::Null;
    connection["localUrl"] = Value::Null;
    connection["health"] = connection["tunnel"].take();
    connection
        .as_object_mut()
        .expect("an object")
        .remove("tunnel");
    let clocks = ["lastRequestAt", "lastToolCallAt"];
    for key in clocks {
        connection[key] = Value::Null;
    }
    let mut driven = Vec::new();
    for surface in connection["surfaces"].as_array_mut().expect("surfaces") {
        let tools = surface["tools"].as_u64().expect("a count");
        surface["tools"] = json!(
            (0..tools)
                .map(|index| format!("tool-{index}"))
                .collect::<Vec<_>>()
        );
        for key in ["connectorName", "description", "cardSummary"] {
            surface[key] = json!("x");
        }
        surface["localUrl"] = Value::Null;
        surface["publicUrl"] = Value::Null;
        let id: SurfaceId = serde_json::from_value(surface["id"].clone()).expect("a surface id");
        let set = clocks.map(|key| surface[key] == "<EPOCH_MS>");
        driven.push((id, set));
        for key in clocks {
            surface[key] = Value::Null;
        }
    }
    let connection = serde_json::from_value(connection).expect("a connection status");
    let harness = Harness::start(Options {
        connection,
        ..Options::default()
    })
    .await;
    for (surface, [requested, called]) in driven {
        if requested {
            drop(harness.kernel.begin_request(surface));
        }
        if called {
            harness
                .kernel
                .call(
                    surface,
                    "update_plan",
                    json!({ "plan": [] }),
                    Inbound::default(),
                )
                .await
                .expect("update_plan is listed");
        }
    }
    let got = Connection::open(harness.port)
        .await
        .send(&request(&harness, "status", &recorded["request"]))
        .await;
    let mut got = kept(&got);
    let text = got
        .to_string()
        .replace(&BRIDGE_PORT.to_string(), "\"<PORT>\"");
    got = serde_json::from_str(&text).expect("json");

    let mut want = recorded_answer(&recorded);
    let body = want["body"].as_object_mut().expect("a body");
    for missing in ["plugins", "update"] {
        assert!(
            body.remove(missing).is_some(),
            "{missing} is no longer in the corpus"
        );
    }
    assert_same(&got, &want, "base/status without plugins and update");
    harness.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_endpoint_files_are_written_as_recorded() {
    let harness = Harness::start(Options::default()).await;
    let recorded: Value = serde_json::from_str(
        &std::fs::read_to_string(golden().join("base/api/endpoint-files.json")).expect("the case"),
    )
    .expect("json");
    let endpoint =
        std::fs::read_to_string(harness.control_dir().join("endpoint.json")).expect("endpoint");
    let parsed: Value = serde_json::from_str(&endpoint).expect("json");
    let normalized = endpoint
        .replace(
            &format!("\"port\": {}", harness.port),
            "\"port\": <API_PORT>",
        )
        .replace(
            &format!("\"pid\": {}", std::process::id()),
            "\"pid\": <PID>",
        )
        .replace(parsed["startedAt"].as_str().expect("a time"), "<ISO_TIME>");
    assert_eq!(
        normalized,
        recorded["endpoint.json"]["text"].as_str().expect("text")
    );
    let token = std::fs::read_to_string(harness.control_dir().join("token")).expect("token");
    assert_eq!(
        token.replace(&harness.token, "<CONTROL_TOKEN>"),
        recorded["token"]["text"].as_str().expect("text")
    );
    let iso = parsed["startedAt"].as_str().expect("a time");
    assert!(
        iso.len() == 24 && iso.ends_with('Z') && iso.as_bytes()[10] == b'T',
        "{iso}"
    );
    harness.shutdown().await;
}
