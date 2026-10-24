//! The Rust half of `differential/run.mjs`: sends each case's exchanges to the recorder on a
//! fresh profile and leaves `sessions/`, `state/` and the answers beside the TypeScript ones.
//! Without `COS_RECORDER_CASES` it does nothing.

use std::path::Path;
use std::sync::Arc;

use cos_recorder::{Recorder, Refusal};
use cos_sessions::SessionStore;
use cos_store::config::first_launch_config;
use cos_store::{AppPaths, DurableStore, Logger, Platform};
use cos_tools::{
    Attribution, CallNotes, CallRecord, EpochMs, RequestId, SurfaceId, ToolOutcome, ToolResult,
};
use serde_json::{Value, json};
use tokio::sync::watch;

async fn answer(sessions: &SessionStore, recorder: &Recorder, route: &str, body: &Value) -> Value {
    let now = EpochMs::now();
    let refused = |Refusal(word)| json!({ "status": 400, "body": { "error": word } });
    let ok = |body: Value| json!({ "status": 200, "body": body });
    match route {
        "/events" => match recorder.events(body, now).await {
            Ok(stored) => ok(serde_json::to_value(stored).unwrap_or_default()),
            Err(refusal) => refused(refusal),
        },
        "/correlations" => match recorder.correlate(body, now).await {
            Ok(reply) => ok(serde_json::to_value(reply).unwrap_or_default()),
            Err(refusal) => refused(refusal),
        },
        "/closed" => {
            recorder.closed(body).await;
            ok(json!({ "ok": true }))
        }
        "tool_call" => {
            tool_call(sessions, recorder, body).await;
            ok(json!({ "ok": true }))
        }
        "request_plan" => {
            let update = serde_json::from_value(body["update"].clone()).expect("plan update");
            let started_at = body["startedAt"].as_u64().unwrap_or_default();
            let request = body["requestId"].as_str().unwrap_or_default();
            sessions
                .update_request_plan(request, update, started_at)
                .await
                .expect("plan held");
            ok(json!({ "ok": true }))
        }
        "settle" => {
            recorder.settle().await;
            ok(json!({ "ok": true }))
        }
        other => json!({ "status": 404, "body": { "error": format!("unscripted route {other}") } }),
    }
}

/// One MCP `read` call that carried this `x-request-id`, resolved and recorded as the kernel
/// does it.
async fn tool_call(sessions: &SessionStore, recorder: &Recorder, body: &Value) {
    let request = body["requestId"].as_str().and_then(RequestId::from_header);
    let started_at = EpochMs(body["startedAt"].as_u64().unwrap_or_default());
    let caller = recorder.resolve("read", started_at, request.as_ref()).await;
    let result = ToolResult::text(body["text"].as_str().unwrap_or_default());
    sessions
        .recorder()
        .record(CallRecord {
            surface: SurfaceId::Core,
            tool: "read",
            nested: false,
            caller: &caller,
            started_at,
            finished_at: started_at,
            outcome: ToolOutcome::Ok,
            arguments: &json!({ "paths": [body["path"].clone()] }),
            result: &result,
            notes: &CallNotes::default(),
        })
        .await;
}

async fn record_case(dir: &Path) {
    let ops: Vec<Value> =
        serde_json::from_slice(&std::fs::read(dir.join("ops.json")).expect("ops"))
            .expect("ops json");
    let profile = dir.join("rust");
    let paths = AppPaths::at(&profile);
    let logger = Logger::new();
    let sessions = SessionStore::open(&paths, logger.clone());
    let config = Arc::new(first_launch_config(Platform::current()));
    let recorder = Recorder::new(
        sessions.clone(),
        &DurableStore::new(paths.state(), logger.clone()),
        watch::channel(config).1,
        logger,
    );
    sessions.restore().await;
    recorder.restore().await;
    let mut answers = Vec::new();
    for op in &ops {
        let route = op["route"].as_str().unwrap_or_default();
        let mut answered = answer(&sessions, &recorder, route, &op["request"]).await;
        if let Some(object) = answered.as_object_mut() {
            object.insert("route".into(), json!(route));
        }
        answers.push(answered);
    }
    recorder.settle().await;
    sessions.flush().await;
    recorder.flush();
    std::fs::write(
        profile.join("answers.json"),
        serde_json::to_vec_pretty(&answers).expect("answers"),
    )
    .expect("write answers");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn records_the_bridge_exchanges() {
    let Ok(root) = std::env::var("COS_RECORDER_CASES") else {
        return;
    };
    let root = Path::new(&root);
    let cases: Vec<String> =
        serde_json::from_slice(&std::fs::read(root.join("cases.json")).expect("cases"))
            .expect("cases json");
    for case in cases {
        record_case(&root.join(case)).await;
    }
}
