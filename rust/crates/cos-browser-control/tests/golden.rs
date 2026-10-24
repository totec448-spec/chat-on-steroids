//! Replays the recorded `desktop` calls of the browser tools (cases 20 to 31) through the real
//! kernel and the real tools, and compares the whole result, key order included, with the
//! corpus. The recorded app had no browser connected and "Allow unattributed calls" off.

mod support;

use std::fs;

use serde_json::Value;
use support::{Served, golden, read_json};

/// The corpus replaces UUIDs with numbered placeholders; any valid UUID stands in for them.
fn denormalize(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            let mut out = text.clone();
            for n in 1..=9 {
                out = out.replace(
                    &format!("<UUID:{n}>"),
                    &format!("123e4567-e89b-42d3-a456-42661417400{n}"),
                );
            }
            Value::String(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(denormalize).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), denormalize(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recorded_browser_calls_match_the_corpus() {
    let served = Served::new("golden", |_| {});
    let folder = golden().join("desktop/mcp/desktop/calls");
    let mut names: Vec<String> = fs::read_dir(&folder)
        .expect("desktop calls")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut replayed = Vec::new();
    let mut failures = Vec::new();
    for name in names {
        let case = read_json(&folder.join(&name));
        let tool = case["request"]["tool"].as_str().unwrap_or_default();
        if !tool.starts_with("browser_") {
            continue;
        }
        let expected = &case["response"]["messages"][0]["result"];
        let actual = served
            .call(tool, denormalize(&case["request"]["arguments"]))
            .await
            .unwrap_or_else(Value::String);
        let (expected, actual) = (
            serde_json::to_string(expected).unwrap(),
            serde_json::to_string(&actual).unwrap(),
        );
        if expected != actual {
            failures.push(format!(
                "{name}\n    expected {expected}\n    actual   {actual}"
            ));
        }
        replayed.push(name);
    }
    assert_eq!(
        replayed.first().map(String::as_str),
        Some("20-browser-tabs-identity-refused.json")
    );
    assert_eq!(
        replayed.last().map(String::as_str),
        Some("31-browser-network-identity-refused.json")
    );
    assert_eq!(replayed.len(), 12, "{replayed:?}");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
