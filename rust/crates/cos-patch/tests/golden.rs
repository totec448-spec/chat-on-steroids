//! Replays every recorded `apply_patch` call through a real kernel and compares the whole
//! `tools/call` answer and the files on disk with the corpus.

mod support;

use std::fs;

use serde_json::{Value, json};
use support::{Harness, golden, mask_wall_time, read_json};

/// The corpus stores the 20,000-line patch of `patch-large-add` as a note.
fn sent_arguments(case: &str, recorded: &Value) -> Value {
    if case == "patch-large-add" {
        let lines: String = (0..20_000).map(|i| format!("+big {i}\n")).collect();
        return json!({
            "patch": format!("*** Begin Patch\n*** Add File: /project/src/big.txt\n{lines}*** End Patch\n")
        });
    }
    recorded.clone()
}

/// The JSON-RPC answer as the corpus stores it: `result` with its run time masked, or `error`.
fn answer(result: Option<cos_tools::ToolResult>) -> Value {
    match result {
        None => json!({ "error": { "code": -32602, "message": "Tool apply_patch not found" } }),
        Some(result) => {
            let text = serde_json::to_string(&result).expect("serializes");
            let masked: Value = serde_json::from_str(&mask_wall_time(&text)).expect("still JSON");
            json!({ "result": masked })
        }
    }
}

fn recorded_answer(message: &Value) -> Value {
    match message.get("error") {
        Some(error) => json!({ "error": { "code": error["code"], "message": error["message"] } }),
        None => json!({ "result": message["result"] }),
    }
}

#[tokio::test]
async fn every_recorded_patch_call_matches_the_corpus() {
    let mut checked = 0;
    let mut failures = Vec::new();
    for variant in [
        "base",
        "two-roots",
        "no-files",
        "read-only",
        "no-capabilities",
    ] {
        let dir = golden().join(variant).join("mcp/core/calls");
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut files: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect();
        files.sort();
        let harness = Harness::variant(variant);
        for file in files {
            let case = read_json(&file);
            if case["request"]["tool"] != "apply_patch" {
                continue;
            }
            let id = case["case"].as_str().unwrap_or_default();
            let name = format!("{variant}/{id}");
            let arguments = sent_arguments(id, &case["request"]["arguments"]);
            let actual = answer(harness.call(arguments).await);
            let expected = recorded_answer(&case["response"]["messages"][0]);
            checked += 1;
            if actual != expected {
                failures.push(format!(
                    "{name}:\n  expected {expected}\n  actual   {actual}"
                ));
            }
            if let Some(Value::Object(disk)) = case.get("disk") {
                for (relative, recorded) in disk {
                    let on_disk = harness
                        .tree
                        .read(relative)
                        .map_or(Value::Null, Value::String);
                    if &on_disk != recorded {
                        failures.push(format!(
                            "{name}: {relative} is {on_disk}, the corpus has {recorded}"
                        ));
                    }
                }
            }
            if id == "patch-large-add" {
                let lines = harness
                    .tree
                    .read("src/big.txt")
                    .map(|text| text.lines().count());
                if lines != Some(20_000) {
                    failures.push(format!("{name}: big.txt has {lines:?} lines"));
                }
            }
        }
    }
    assert!(
        checked >= 22,
        "only {checked} recorded patch calls replayed"
    );
    assert!(
        failures.is_empty(),
        "{} of {checked} calls differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
