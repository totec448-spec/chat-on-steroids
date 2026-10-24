//! Replays every recorded `read`, `view_image`, `find` and `save_image` call of the golden
//! corpus through the real kernel and the real tools, on the recorder's fixture project, and
//! compares the whole result with the recording.

mod support;

use std::fs;

use serde_json::{Value, json};
use support::{Served, denormalize, golden, normalize_value, read_json};

const FILE_TOOLS: &[&str] = &["read", "view_image", "find", "save_image"];

/// The arguments that were sent. The corpus stores one oversized argument as a note.
fn sent_arguments(case: &str, recorded: &Value, served: &Served) -> Value {
    match case {
        "read-path-too-long" => json!({ "paths": [format!("/project/{}", "a".repeat(4100))] }),
        _ => denormalize(recorded, &served.dirs.placeholders()),
    }
}

fn is_file_tool_case(case: &Value) -> bool {
    FILE_TOOLS.contains(&case["request"]["tool"].as_str().unwrap_or_default())
}

/// Cases run in order and a later read sees the files an earlier patch left. Another unit
/// owns those calls, so their recorded effect on disk is applied instead of running them.
fn leave_what_the_case_left(case: &Value, served: &Served) {
    let project = &served.dirs.project;
    if case["case"] == "patch-large-add" {
        let big: String = (0..20_000)
            .map(|i| {
                format!(
                    "big {i}
"
                )
            })
            .collect();
        fs::write(project.join("src/big.txt"), big).expect("big.txt");
    }
    for (file, content) in case["disk"].as_object().into_iter().flatten() {
        let path = project.join(file);
        match content.as_str() {
            Some(text) => fs::write(&path, text).expect("recorded file"),
            None => {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

fn first_difference(expected: &str, actual: &str) -> String {
    let at = expected
        .char_indices()
        .zip(actual.chars())
        .find(|((_, want), got)| want != got)
        .map_or(expected.len().min(actual.len()), |((index, _), _)| index);
    let window = |text: &str| {
        let start = text.floor_char_boundary(at.saturating_sub(80));
        let end = text.ceil_char_boundary((at + 120).min(text.len()));
        text[start..end].to_owned()
    };
    format!(
        "first difference at byte {at}\n  expected: {:?}\n  actual:   {:?}",
        window(expected),
        window(actual)
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_file_tool_call_matches_the_corpus() {
    let mut checked = Vec::new();
    let mut failures = Vec::new();
    let mut variants: Vec<String> = fs::read_dir(golden())
        .expect("golden corpus")
        .filter_map(Result::ok)
        .filter(|entry| entry.path().join("config.json").exists())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    variants.sort();
    for variant in variants {
        let dir = golden().join(&variant).join("mcp/core/calls");
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut files: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect();
        files.sort();
        let cases: Vec<Value> = files.iter().map(|file| read_json(file)).collect();
        if !cases.iter().any(is_file_tool_case) {
            continue;
        }
        let served = Served::variant(&variant);
        let placeholders = served.dirs.placeholders();
        for case in cases {
            let id = case["case"].as_str().unwrap_or_default();
            if !is_file_tool_case(&case) {
                leave_what_the_case_left(&case, &served);
                continue;
            }
            let name = format!("{variant}/{id}");
            let tool = case["request"]["tool"].as_str().unwrap_or_default();
            let arguments = sent_arguments(id, &case["request"]["arguments"], &served);
            let expected = &case["response"]["messages"][0];
            let actual = match served.call(tool, arguments).await {
                Ok(result) => json!({ "result": normalize_value(&result, &placeholders) }),
                Err(message) => json!({ "error": { "code": -32602, "message": message } }),
            };
            let expected = match expected.get("result") {
                Some(result) => json!({ "result": result }),
                None => json!({ "error": {
                    "code": expected["error"]["code"],
                    "message": expected["error"]["message"],
                } }),
            };
            let (want, got) = (expected.to_string(), actual.to_string());
            if want == got {
                checked.push(name);
            } else {
                failures.push(format!("{name}: {}", first_difference(&want, &got)));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        failures.len() + checked.len(),
        failures.join("\n")
    );
    // base 01-33, no-command 01-07, two-roots 01-04 and 08, read-only 01 and 06, no-files 01 and
    // 03, no-capabilities 01, actions 01.
    assert_eq!(checked.len(), 52, "cases replayed: {checked:#?}");
}

/// The recorded refusal names the Core that answered. With a connector suffix, that name is
/// the suffixed one the user gave this computer's connector; the advice keeps the plain name.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_save_image_refusal_names_this_computers_core() {
    let recorded = read_json(&golden().join("base/mcp/core/calls/32-save-image-unattributed.json"));
    let corpus = recorded["response"]["messages"][0]["result"]["content"][0]["text"]
        .as_str()
        .expect("recorded refusal");
    let mut config = read_json(&golden().join("base/config.json"))["config"].clone();
    config["connectorSuffix"] = json!("  Work   PC ");
    let served = Served::with_config("save-image-suffix", &config);
    let (text, is_error) = served
        .text("save_image", recorded["request"]["arguments"].clone())
        .await;
    assert!(is_error);
    let expected = corpus.replacen(
        "Chat On Steroids Core could not",
        "Chat On Steroids Core (Work PC) could not",
        1,
    );
    assert_ne!(expected, corpus, "the corpus text names Core first");
    assert_eq!(text, expected);
}
