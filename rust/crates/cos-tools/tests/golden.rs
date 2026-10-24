//! The kernel against the golden corpus: `tools/list` and `initialize` of every variant and
//! surface, and the envelope of every recorded `tools/call` (unknown tools, schema refusals and
//! the identity notice), with stand-in tools that answer what the real tool answered.

mod support;

use std::fs;

use cos_tools::{Content, Inbound, RequestId, SurfaceId, ToolOutput, ToolResult, UnknownTool};
use serde_json::{Value, json};
use support::{Fixture, golden, read_json, variants};

const SURFACES: [(SurfaceId, &str); 3] = [
    (SurfaceId::Core, "core"),
    (SurfaceId::Desktop, "desktop"),
    (SurfaceId::Plugins, "plugins"),
];

/// The corpus numbers UUIDs by first appearance in a file (`<UUID:n>`).
fn normalize_uuids(text: &str) -> String {
    let mut seen: Vec<String> = Vec::new();
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(|c: char| c.is_ascii_hexdigit()) {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let candidate = rest.get(..36).filter(|slice| is_uuid(slice));
        let boundary = out
            .chars()
            .last()
            .is_none_or(|c| !c.is_ascii_alphanumeric());
        match candidate {
            Some(uuid) if boundary => {
                let key = uuid.to_ascii_lowercase();
                let n = match seen.iter().position(|known| *known == key) {
                    Some(index) => index + 1,
                    None => {
                        seen.push(key);
                        seen.len()
                    }
                };
                out.push_str(&format!("<UUID:{n}>"));
                rest = &rest[36..];
            }
            _ => {
                let width = rest.chars().next().map_or(1, char::len_utf8);
                out.push_str(&rest[..width]);
                rest = &rest[width..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// Where two serializations first part, for a readable failure.
fn first_difference(expected: &str, actual: &str) -> String {
    let at = expected
        .bytes()
        .zip(actual.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| expected.len().min(actual.len()));
    let start = at.saturating_sub(80);
    let clip = |text: &str| {
        text.get(start..(at + 120).min(text.len()))
            .unwrap_or("")
            .to_owned()
    };
    format!(
        "at byte {at}\n    expected …{}…\n    actual   …{}…",
        clip(expected),
        clip(actual)
    )
}

#[test]
fn tools_list_is_byte_equal_for_every_variant_and_surface() {
    let mut checked = 0;
    let mut failures = Vec::new();
    for variant in variants() {
        let fixture = Fixture::variant(&variant);
        for (surface, folder) in SURFACES {
            let file = golden()
                .join(&variant)
                .join("mcp")
                .join(folder)
                .join("tools-list.json");
            if !file.exists() {
                continue;
            }
            let expected =
                serde_json::to_string(&read_json(&file)["response"]["messages"][0]["result"])
                    .expect("serializes");
            let actual = serde_json::to_string(&json!({ "tools": fixture.kernel.list(surface) }))
                .expect("serializes");
            let actual = normalize_uuids(&actual);
            checked += 1;
            if expected != actual {
                failures.push(format!(
                    "{variant}/{folder}: {}",
                    first_difference(&expected, &actual)
                ));
            }
        }
    }
    assert_eq!(checked, 17, "tool lists found");
    assert!(
        failures.is_empty(),
        "{} lists differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn initialize_names_version_and_instructions_match_every_variant() {
    let mut checked = 0;
    let mut failures = Vec::new();
    for variant in variants() {
        let fixture = Fixture::variant(&variant);
        let profile = fixture.dirs.profile.to_string_lossy().replace('\\', "\\\\");
        for (surface, folder) in SURFACES {
            let file = golden()
                .join(&variant)
                .join("mcp")
                .join(folder)
                .join("initialize.json");
            if !file.exists() {
                continue;
            }
            let expected = &read_json(&file)["response"]["messages"][0]["result"];
            let info = fixture.kernel.server_info(surface);
            let instructions = info.instructions.replace(&profile, "<PROFILE>");
            checked += 1;
            if expected["serverInfo"] != json!({ "name": info.name, "version": info.version }) {
                failures.push(format!(
                    "{variant}/{folder}: serverInfo {}",
                    expected["serverInfo"]
                ));
            }
            let recorded = expected["instructions"].as_str().unwrap_or_default();
            if recorded != instructions {
                failures.push(format!(
                    "{variant}/{folder}: {}",
                    first_difference(recorded, &instructions)
                ));
            }
        }
    }
    assert_eq!(checked, 17, "initialize results found");
    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

const NOTICE: &str = "\n--- Identity notice ---\n";

/// The arguments that were sent. The corpus stores two oversized ones as a note and replaces
/// session ids, window handles and UUIDs with placeholders.
fn sent_arguments(case: &str, recorded: &Value) -> Value {
    match case {
        "read-path-too-long" => json!({ "paths": [format!("/project/{}", "a".repeat(4100))] }),
        "patch-large-add" => {
            json!({ "patch": "*** Begin Patch\n*** Add File: /project/src/big.txt\n+big 0\n*** End Patch\n" })
        }
        _ => denormalize(recorded),
    }
}

fn denormalize(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            if let Some(n) = text
                .strip_prefix("<EXEC_SESSION:")
                .and_then(|rest| rest.strip_suffix('>'))
            {
                return json!(n.parse::<u64>().unwrap_or(1));
            }
            if matches!(text.as_str(), "<HWND>" | "<PID>" | "<TARGET_PID>") {
                return json!(4242);
            }
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

fn content(part: &Value) -> Content {
    match part["type"].as_str() {
        Some("image") => Content::Image {
            data: part["data"].as_str().unwrap_or_default().to_owned(),
            mime_type: part["mimeType"].as_str().unwrap_or_default().to_owned(),
        },
        _ => Content::Text {
            text: part["text"].as_str().unwrap_or_default().to_owned(),
        },
    }
}

/// What the real tool returned before the kernel appended the identity notice.
fn handler_answer(result: &Value) -> ToolOutput {
    let mut parts: Vec<Value> = result["content"].as_array().cloned().unwrap_or_default();
    let notice = parts
        .last()
        .and_then(|part| part["text"].as_str())
        .filter(|text| text.starts_with(NOTICE))
        .map(str::to_owned);
    if notice.is_some() {
        parts.pop();
    }
    let mut structured = result.get("structuredContent").cloned();
    if let (Some(Value::Object(fields)), Some(notice)) = (&mut structured, &notice) {
        let own = fields
            .get("supplemental_context")
            .and_then(Value::as_str)
            .map(|text| text.strip_suffix(notice.as_str()).unwrap_or(text))
            .map(|text| text.strip_suffix('\n').unwrap_or(text).to_owned());
        match own {
            Some(own) if !own.is_empty() => {
                fields.insert("supplemental_context".to_owned(), Value::String(own));
            }
            _ => {
                fields.shift_remove("supplemental_context");
            }
        }
    }
    ToolOutput::from(ToolResult {
        content: parts.iter().map(content).collect(),
        structured_content: structured,
        is_error: result["isError"] == true,
    })
}

#[tokio::test]
async fn every_recorded_call_gets_the_recorded_envelope() {
    let mut checked = 0;
    let mut failures = Vec::new();
    for variant in variants() {
        let fixture = Fixture::variant(&variant);
        for (surface, folder) in SURFACES {
            let dir = golden()
                .join(&variant)
                .join("mcp")
                .join(folder)
                .join("calls");
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            let mut files: Vec<_> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect();
            files.sort();
            for file in files {
                let case = read_json(&file);
                let id = case["case"].as_str().unwrap_or_default();
                let name = format!("{variant}/{folder}/{id}");
                let tool = case["request"]["tool"].as_str().unwrap_or_default();
                let recorded = case["request"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or(Value::Null);
                let arguments = sent_arguments(id, &recorded);
                let inbound = Inbound {
                    request_id: case["request"]["headers"]["x-request-id"]
                        .as_str()
                        .and_then(RequestId::from_header),
                    setup_profile_id: None,
                };
                let message = &case["response"]["messages"][0];
                let validation = message["result"]["content"][0]["text"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("Input validation error:"));
                if message.get("result").is_some() && !validation {
                    fixture.answer(Ok(handler_answer(&message["result"])));
                }
                let before = fixture.calls.load(std::sync::atomic::Ordering::SeqCst);
                let outcome = fixture.kernel.call(surface, tool, arguments, inbound).await;
                let ran = fixture.calls.load(std::sync::atomic::Ordering::SeqCst) != before;
                *fixture.answer.lock().expect("answer") = None;
                checked += 1;
                match (message.get("error"), outcome) {
                    (Some(error), Err(UnknownTool(unknown))) => {
                        let wire = format!("Tool {unknown} not found");
                        if error["code"] != -32602 || error["message"] != wire.as_str() {
                            failures.push(format!("{name}: error {error} vs {wire}"));
                        }
                    }
                    (Some(error), Ok(result)) => {
                        failures.push(format!("{name}: expected {error}, got {}", json!(result)));
                    }
                    (None, Err(UnknownTool(unknown))) => {
                        failures.push(format!("{name}: {unknown} is not listed"));
                    }
                    (None, Ok(result)) => {
                        let expected =
                            serde_json::to_string(&message["result"]).expect("serializes");
                        let actual = serde_json::to_string(&result).expect("serializes");
                        if expected != actual {
                            failures
                                .push(format!("{name}: {}", first_difference(&expected, &actual)));
                        }
                        if ran == validation {
                            failures.push(format!(
                                "{name}: handler ran={ran} for a validation case={validation}"
                            ));
                        }
                    }
                }
            }
        }
    }
    assert!(checked >= 150, "only {checked} calls replayed");
    assert!(
        failures.is_empty(),
        "{} of {checked} calls differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn the_declarations_file_is_current_with_the_corpus() {
    let script = golden().join("../../scripts/golden/extract-declarations.mjs");
    let status = std::process::Command::new("node")
        .arg(&script)
        .arg("--check")
        .status();
    match status {
        Ok(status) => assert!(
            status.success(),
            "rerun node scripts/golden/extract-declarations.mjs"
        ),
        // Without Node the corpus cannot be read the way the extractor reads it; the other
        // tests still compare the served bytes with the corpus.
        Err(error) => eprintln!("skipped: node is not available ({error})"),
    }
}

/// `ALL_TOOLS` is the registrar's `descriptions()` minus `exec`: every tool the surface lists,
/// in listing order, with its listed description. Code mode reads it from the call context.
#[tokio::test]
async fn nested_tools_are_the_listed_tools_without_exec_for_every_variant() {
    let mut checked = 0;
    let mut failures = Vec::new();
    for variant in variants() {
        let fixture = Fixture::variant(&variant);
        for (surface, folder) in SURFACES {
            let file = golden()
                .join(&variant)
                .join("mcp")
                .join(folder)
                .join("tools-list.json");
            if !file.exists() {
                continue;
            }
            let listed = read_json(&file)["response"]["messages"][0]["result"]["tools"].clone();
            let listed = listed.as_array().expect("recorded tools");
            if !listed.iter().any(|tool| tool["name"] == "exec") {
                continue;
            }
            let expected: Vec<Value> = listed
                .iter()
                .filter(|tool| tool["name"] != "exec")
                .map(|tool| json!({ "name": tool["name"], "description": tool["description"] }))
                .collect();
            fixture.answer(Ok(ToolResult::text("ran").into()));
            let ran = fixture
                .kernel
                .call(surface, "exec", json!({ "code": "1" }), Inbound::default())
                .await;
            assert!(ran.is_ok(), "{variant}/{folder}: exec is listed");
            let seen = fixture.nested.lock().expect("nested").clone();
            let actual = serde_json::to_value(&seen).expect("serializes");
            checked += 1;
            if actual != Value::Array(expected.clone()) {
                failures.push(format!(
                    "{variant}/{folder}: {}",
                    first_difference(&Value::Array(expected).to_string(), &actual.to_string())
                ));
            }
        }
    }
    assert_eq!(checked, 12, "surfaces that list code mode");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
