//! The script corpus recorded from the TypeScript runtime (`tests/corpus/corpus.json`, written
//! by `tests/corpus/record.test.ts`), replayed through the Rust runtime against the same fixture
//! tools. Each case must give the same result, content and `isError` included, and the same
//! child calls in the same order.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cos_codemode::{Invoke, LIMITS, Limits, NestedTool, Options, run};
use cos_tools::{BoxFuture, Content, ToolResult};
use serde_json::{Value, json};

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

fn text(text: impl Into<String>) -> Content {
    Content::Text { text: text.into() }
}

fn png() -> Content {
    Content::Image {
        data: PNG.to_owned(),
        mime_type: "image/png".to_owned(),
    }
}

fn answer(content: Vec<Content>, structured: Option<Value>, is_error: bool) -> ToolResult {
    ToolResult {
        content,
        structured_content: structured,
        is_error,
    }
}

/// The fixture tools of `cases.mjs`, answering exactly what they answer there.
#[derive(Default)]
struct Fixtures {
    calls: Mutex<Vec<Value>>,
    /// Children that have not finished: a script's unawaited calls outlive its result.
    running: Arc<AtomicUsize>,
}

/// Counts one running child until it finishes, panicked or not.
struct Running(Arc<AtomicUsize>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Fixtures {
    /// What the TypeScript recorder waited 700 ms for: every child of the case finished.
    async fn settled(&self) {
        for _ in 0..2_000 {
            if self.running.load(Ordering::SeqCst) == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("a child call never finished");
    }
}

impl Invoke for Fixtures {
    fn invoke(&self, tool: String, arguments: Value) -> BoxFuture<'static, ToolResult> {
        self.calls
            .lock()
            .expect("calls")
            .push(json!([tool, arguments]));
        self.running.fetch_add(1, Ordering::SeqCst);
        let running = Running(self.running.clone());
        Box::pin(async move {
            let _running = running;
            let window = json!({"id": 42, "app": "fixture.exe", "title": "Fixture"});
            match tool.as_str() {
                "lookup" => answer(vec![text(format!("PRIVATE-{arguments}"))], None, false),
                "fail" | "type_text" => {
                    answer(vec![text("STALE_WINDOW: observe again")], None, true)
                }
                "pixel" => answer(vec![png()], None, false),
                "slow" => {
                    let ms = arguments["ms"].as_u64().unwrap_or(0);
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    answer(vec![text(format!("slow {ms}"))], None, false)
                }
                "big" => {
                    let n = arguments["n"].as_u64().unwrap_or(0) as usize;
                    answer(vec![text("B".repeat(n))], None, false)
                }
                "structured" => answer(vec![text("5")], Some(json!({"value": 5})), false),
                "list_windows" => answer(vec![], Some(json!({"value": [window]})), false),
                "get_window_state" => answer(
                    vec![png()],
                    Some(
                        json!({"value": {"window": window, "accessibility": {"tree": "0: Button \"Fixture\""}}}),
                    ),
                    false,
                ),
                "press_key" => answer(vec![], Some(json!({"value": null})), false),
                other => panic!("no fixture named {other}"),
            }
        })
    }
}

fn limits(overrides: &Value) -> Limits {
    let mut limits = LIMITS;
    let Some(overrides) = overrides.as_object() else {
        return limits;
    };
    for (key, value) in overrides {
        let value = value.as_u64().expect("numeric limit");
        let bytes = usize::try_from(value).expect("limit fits");
        match key.as_str() {
            "cpuMs" => limits.cpu = Duration::from_millis(value),
            "wallMs" => limits.wall = Duration::from_millis(value),
            "memoryBytes" => limits.memory_bytes = bytes,
            "textBytes" => limits.text_bytes = bytes,
            "resultBytes" => limits.result_bytes = bytes,
            other => panic!("unknown limit {other}"),
        }
    }
    limits
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_corpus_case_matches_the_typescript_runtime() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/corpus.json");
    let corpus: Value =
        serde_json::from_str(&std::fs::read_to_string(&file).expect("corpus.json")).expect("json");
    let tools: Vec<NestedTool> = corpus["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| NestedTool {
            name: tool["name"].as_str().expect("name").to_owned(),
            description: tool["description"]
                .as_str()
                .expect("description")
                .to_owned(),
        })
        .collect();

    let mut mismatches = Vec::new();
    let mut known = Vec::new();
    for case in corpus["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let code = case["code"].as_str().expect("code");
        let fixtures = Fixtures::default();
        let options = Options {
            windows_desktop: case["windowsDesktop"] == true,
        };
        let result = run(code, &tools, &fixtures, &limits(&case["limits"]), options).await;
        fixtures.settled().await;
        let result = serde_json::to_value(&result).expect("result serializes");
        let calls = Value::Array(fixtures.calls.into_inner().expect("calls"));
        let same = result == case["result"] && calls == case["calls"];
        let report = format!(
            "{name}\n  ts:   {} calls {}\n  rust: {result} calls {calls}",
            case["result"], case["calls"]
        );
        match (same, case["known"].as_str()) {
            (true, _) => {}
            (false, Some(why)) => known.push(format!("{report}\n  known: {why}")),
            (false, None) => mismatches.push(report),
        }
    }
    for difference in &known {
        println!("known difference: {difference}");
    }
    assert!(
        mismatches.is_empty(),
        "{} cases differ from the TypeScript runtime:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
