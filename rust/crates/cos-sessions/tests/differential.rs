//! Feeds `differential/ops.json` to this store and leaves its `sessions/` tree in
//! `COS_SESSIONS_OUT`. `differential/run.mjs` feeds the same script to the TypeScript recorder
//! and compares the two trees. Without the variable this test only checks that the script parses.

use std::path::Path;

use cos_sessions::SessionStore;
use cos_store::{AppPaths, Logger};
use cos_tools::{
    CallNotes, CallRecord, Caller, Content, EpochMs, ProcessNotes, SurfaceId, ToolResult,
};
use cos_types::json::Extra;
use cos_types::session::{FileChange, ToolOutcome};
use serde_json::Value;

fn content(call: &Value) -> Vec<Content> {
    let mut parts: Vec<Content> = match call.get("repeat") {
        Some(repeat) => {
            let line = repeat["line"].as_str().expect("line");
            let count = repeat["count"].as_u64().expect("count");
            let text = (1..=count)
                .map(|n| line.replace("{n}", &n.to_string()))
                .collect::<Vec<_>>()
                .join("\n");
            vec![Content::Text { text }]
        }
        None => call["text"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|text| Content::Text {
                text: text.as_str().expect("text").to_owned(),
            })
            .collect(),
    };
    if let Some(image) = call.get("image").and_then(Value::as_str) {
        parts.push(Content::Image {
            data: image.to_owned(),
            mime_type: "image/png".into(),
        });
    }
    parts
}

fn changes(call: &Value) -> Vec<FileChange> {
    if let Some(many) = call.get("manyChanges").and_then(Value::as_u64) {
        return (0..many)
            .map(|index| FileChange {
                path: format!("/project/{index}/{}", "p".repeat(200)),
                added: 1,
                removed: 0,
                approximate: false,
                review_asset_id: None,
                review_unavailable: None,
                extra: Extra::new(),
            })
            .collect();
    }
    call.get("changes")
        .map(|changes| serde_json::from_value(changes.clone()).expect("changes"))
        .unwrap_or_default()
}

fn process(process: &Value) -> ProcessNotes {
    ProcessNotes {
        exit_code: process.get("exitCode").and_then(Value::as_i64),
        running: process.get("running").and_then(Value::as_bool),
        timed_out: process["timedOut"] == Value::Bool(true),
        benign_exit: process["benignExit"] == Value::Bool(true),
        duration_ms: process.get("durationMs").and_then(Value::as_u64),
        session_id: process
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

fn tool_name(name: &str) -> &'static str {
    match name {
        "read" => "read",
        "apply_patch" => "apply_patch",
        "exec_command" => "exec_command",
        "update_plan" => "update_plan",
        "view_image" => "view_image",
        "write_clipboard" => "write_clipboard",
        "find" => "find",
        "write_stdin" => "write_stdin",
        other => panic!("add {other} to the differential tool table"),
    }
}

#[tokio::test]
async fn records_the_operation_script() {
    let ops: Value = serde_json::from_slice(
        &std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("differential/ops.json"))
            .expect("ops"),
    )
    .expect("ops json");
    let calls = ops["calls"].as_array().expect("calls");
    let Ok(out) = std::env::var("COS_SESSIONS_OUT") else {
        assert!(calls.iter().all(|call| call["outcome"].is_string()));
        return;
    };
    let store = SessionStore::open(&AppPaths::at(&out), Logger::new());
    let recorder = store.recorder();
    let caller = Caller::unattributed(None);
    for call in calls {
        let started = call["startedAt"].as_u64().expect("startedAt");
        let duration = call["durationMs"].as_u64().expect("durationMs");
        let outcome: ToolOutcome =
            serde_json::from_value(call["outcome"].clone()).expect("outcome");
        let result = ToolResult {
            content: content(call),
            structured_content: None,
            is_error: outcome != ToolOutcome::Ok,
        };
        let notes = CallNotes {
            outcome: None,
            changes: changes(call),
            count: call.get("count").and_then(Value::as_u64),
            detail: call
                .get("detail")
                .and_then(Value::as_str)
                .map(str::to_owned),
            process: call.get("process").map(process),
        };
        recorder
            .record(CallRecord {
                surface: SurfaceId::Core,
                tool: tool_name(call["tool"].as_str().expect("tool")),
                nested: call["nested"] == Value::Bool(true),
                caller: &caller,
                started_at: EpochMs(started),
                finished_at: EpochMs(started + duration),
                outcome,
                arguments: &call["args"],
                result: &result,
                notes: &notes,
            })
            .await;
    }
    store.flush_recorder().await;
    store.flush().await;
}
