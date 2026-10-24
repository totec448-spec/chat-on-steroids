//! Replays the `base` exec cases of the golden corpus (`calls/52` to `78`) through the real
//! kernel and the real exec tools, in recorded order, and compares each answer with the recorded
//! one after normalization. Runs once per launcher: the fresh-process baseline must match every
//! case; the pre-started launcher may differ only where the recorded answer depends on
//! PowerShell's start-up time.

mod support;

use std::fs;
use std::sync::Arc;

use cos_exec::{FreshProcess, Launcher, PrestartedPowerShell};
use serde_json::{Value, json};
use support::{Harness, Normalizer, golden, read_json};

/// The pseudo-console title names the shell and whether it runs elevated (the corpus was
/// recorded elevated), and the token count includes it.
fn without_title_tokens(case: &str, value: &mut Value) {
    if !matches!(
        case,
        "exec-tty" | "exec-stdin-session" | "stdin-replay-completed"
    ) {
        return;
    }
    let Some(result) = value.pointer_mut("/result") else {
        return;
    };
    if let Some(Value::Object(fields)) = result.get_mut("structuredContent") {
        fields.insert("original_token_count".into(), json!("<N>"));
    }
    if let Some(Value::Array(parts)) = result.get_mut("content")
        && let Some(Value::String(text)) = parts.first_mut().and_then(|part| part.get_mut("text"))
        && let Some(at) = text.find("Original token count: ")
    {
        let start = at + "Original token count: ".len();
        let end = text[start..]
            .find('\n')
            .map_or(text.len(), |end| start + end);
        text.replace_range(start..end, "<N>");
    }
}

fn denormalize(value: &Value, normalizer: &Normalizer, project: &str) -> Value {
    match value {
        Value::String(text) => {
            if let Some(n) = text
                .strip_prefix("<EXEC_SESSION:")
                .and_then(|rest| rest.strip_suffix('>'))
                .and_then(|n| n.parse::<usize>().ok())
            {
                // A session this run has not seen stands for an id no session has.
                return json!(normalizer.concrete(n).unwrap_or(1));
            }
            Value::String(text.replace("<PROJECT>", project))
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), denormalize(item, normalizer, project)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| denormalize(item, normalizer, project))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn exec_cases() -> Vec<(String, Value)> {
    let dir = golden().join("base/mcp/core/calls");
    let mut files: Vec<_> = fs::read_dir(&dir)
        .expect("base calls")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            name[..2]
                .parse::<u32>()
                .is_ok_and(|n| (52..=78).contains(&n))
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let case = read_json(&path);
            (case["case"].as_str().unwrap_or_default().to_owned(), case)
        })
        .collect()
}

/// Every case's differences, as `case: expected / actual` lines.
async fn replay(launcher: Arc<dyn Launcher>) -> (usize, Vec<String>) {
    let harness = Harness::new("base", launcher);
    let mut normalizer = Normalizer::new(harness.project.native());
    let cases = exec_cases();
    let mut differences = Vec::new();
    for (name, case) in &cases {
        let tool = case["request"]["tool"].as_str().unwrap_or_default();
        let arguments = denormalize(
            &case["request"]["arguments"],
            &normalizer,
            &harness.project.native(),
        );
        let result = harness.call(tool, arguments).await;
        let mut actual = json!({ "result": normalizer.value(&result) });
        let mut expected = json!({ "result": case["response"]["messages"][0]["result"].clone() });
        without_title_tokens(name, &mut actual);
        without_title_tokens(name, &mut expected);
        if actual != expected {
            differences.push(format!(
                "{name}:\n  expected {}\n  actual   {}",
                serde_json::to_string(&expected).unwrap_or_default(),
                serde_json::to_string(&actual).unwrap_or_default()
            ));
        }
    }
    harness.exec.terminate_all().await;
    (cases.len(), differences)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fresh_processes_answer_every_recorded_exec_case() {
    let (count, differences) = replay(Arc::new(FreshProcess)).await;
    assert_eq!(count, 27, "cases 52 to 78");
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_prestarted_shell_differs_only_where_startup_time_was_recorded() {
    let (count, differences) = replay(Arc::new(PrestartedPowerShell::new())).await;
    assert_eq!(count, 27, "cases 52 to 78");
    // `exec-yield-out-of-range` asks for a 10 ms yield (raised to 250 ms). Windows PowerShell
    // took longer than that to start, so the corpus records a running session; a pre-started
    // shell finishes `Write-Output y` inside the window and reports the exit instead.
    let unexpected: Vec<&String> = differences
        .iter()
        .filter(|difference| !difference.starts_with("exec-yield-out-of-range:"))
        .collect();
    assert!(
        unexpected.is_empty(),
        "{}",
        unexpected
            .iter()
            .map(|d| d.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
}
