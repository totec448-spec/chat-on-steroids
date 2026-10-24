//! A kernel serving the real Desktop tools on the `desktop` variant's recorded config.

#![allow(dead_code, reason = "each test file uses a different part")]

pub mod window;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cos_store::{ConfigStore, Logger, Platform};
use cos_tools::{
    Admission, AdmissionGate, BoxFuture, CallRecord, CallRecorder, GrantEnv, Inbound, Kernel,
    KernelDeps, Phase, SurfaceId, SurfaceTools, Unattributed,
};
use cos_windows_desktop::Desktop;
use serde_json::Value;
use tokio::sync::watch;

pub fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden")
}

pub fn read_json(path: &Path) -> Value {
    let text =
        fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

struct Discard;

impl CallRecorder for Discard {
    fn record<'a>(&'a self, _call: CallRecord<'a>) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

pub struct Served {
    pub kernel: Arc<Kernel>,
    run: PathBuf,
    _config: watch::Sender<Arc<cos_types::config::Config>>,
    _gate: AdmissionGate,
}

impl Served {
    /// The `desktop` variant's config, changed by `adjust`, serving only `desktop`'s tools.
    pub fn new(label: &str, desktop: &Arc<Desktop>, adjust: impl FnOnce(&mut Value)) -> Self {
        let run = std::env::temp_dir().join(format!("cos-desktop-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&run);
        let project = run.join("project");
        fs::create_dir_all(&project).expect("project folder");
        fs::create_dir_all(run.join("profile/skills")).expect("profile folder");
        let mut config = read_json(&golden().join("desktop/config.json"))["config"].clone();
        adjust(&mut config);
        let text = serde_json::to_string(&config)
            .expect("config serializes")
            .replace(
                "<PROJECT>",
                &project.to_string_lossy().replace('\\', "\\\\"),
            );
        let file = run.join("profile/config.json");
        fs::write(&file, text).expect("config written");
        let config = ConfigStore::new(file, Platform::Windows, Logger::new()).load("2.1.35");
        let (sender, receiver) = watch::channel(Arc::new(config));
        let (gate, admission) = Admission::channel();
        gate.advance(Phase::Serving);
        let mut tools = SurfaceTools::default();
        for tool in cos_windows_desktop::tools(desktop) {
            tools.add(SurfaceId::Desktop, tool);
        }
        let kernel = Kernel::new(KernelDeps {
            app_version: "2.1.35",
            config: receiver,
            env: GrantEnv {
                skills_dir: run.join("profile/skills"),
                platform: Platform::Windows,
            },
            tools,
            attribution: Arc::new(Unattributed),
            chat_policy: Arc::new(cos_tools::AnyChat),
            recorder: Arc::new(Discard),
            admission,
            logger: Logger::with_clock(|| 0, false),
        });
        Self {
            kernel,
            run,
            _config: sender,
            _gate: gate,
        }
    }

    /// `tools/call` on Desktop: the result as JSON, or the `-32602` message.
    pub async fn call(&self, tool: &str, arguments: Value) -> Result<Value, String> {
        match self
            .kernel
            .call(SurfaceId::Desktop, tool, arguments, Inbound::default())
            .await
        {
            Ok(result) => Ok(serde_json::to_value(result).expect("result serializes")),
            Err(unknown) => Err(format!("Tool {} not found", unknown.0)),
        }
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.run);
    }
}

/// The first text part of a result.
pub fn first_text(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap_or_default()
}

/// Replaces the recorded window handle the way `normalize.mjs` does: a number equal to it
/// becomes `"<HWND>"`, and inside text it follows a JSON key. Window screenshots become
/// `<IMAGE_DATA>`.
pub fn normalize_hwnd(value: &Value, hwnd: i64) -> Value {
    match value {
        Value::Number(number) if number.as_i64() == Some(hwnd) => {
            Value::String("<HWND>".to_owned())
        }
        Value::String(text) => Value::String(text.replace(&format!("\":{hwnd}"), "\":<HWND>")),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| normalize_hwnd(item, hwnd))
                .collect(),
        ),
        Value::Object(fields) => {
            let image = fields.get("type").and_then(Value::as_str) == Some("image");
            Value::Object(
                fields
                    .iter()
                    .map(|(key, item)| {
                        if image && key == "data" {
                            (key.clone(), Value::String("<IMAGE_DATA>".to_owned()))
                        } else {
                            (key.clone(), normalize_hwnd(item, hwnd))
                        }
                    })
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

/// Puts `hwnd` where the recorded request has `<HWND>`.
pub fn with_hwnd(value: &Value, hwnd: i64) -> Value {
    match value {
        Value::String(text) if text == "<HWND>" => Value::from(hwnd),
        Value::String(text) => Value::String(text.replace("<HWND>", &hwnd.to_string())),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| with_hwnd(item, hwnd)).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), with_hwnd(item, hwnd)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The recorded `desktop` cases of the Window2 and clipboard tools, in execution order.
pub fn desktop_cases() -> Vec<(String, Value)> {
    const TOOLS: [&str; 15] = [
        "list_windows",
        "get_window",
        "list_apps",
        "get_window_state",
        "launch_app",
        "click",
        "press_key",
        "type_text",
        "scroll",
        "set_value",
        "drag",
        "perform_secondary_action",
        "activate_window",
        "read_clipboard",
        "write_clipboard",
    ];
    let folder = golden().join("desktop/mcp/desktop/calls");
    let mut names: Vec<_> = fs::read_dir(&folder)
        .expect("desktop calls")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let case = read_json(&folder.join(&name));
            (name, case)
        })
        .filter(|(_, case)| TOOLS.contains(&case["request"]["tool"].as_str().unwrap_or_default()))
        .collect()
}

/// Where two serializations first part, for a readable failure.
pub fn first_difference(expected: &str, actual: &str) -> String {
    let at = expected
        .bytes()
        .zip(actual.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| expected.len().min(actual.len()));
    let clip = |text: &str| {
        let start = text.floor_char_boundary(at.saturating_sub(80));
        let end = text.ceil_char_boundary((at + 120).min(text.len()));
        text[start..end].to_owned()
    };
    format!(
        "at byte {at}\n    expected …{}…\n    actual   …{}…",
        clip(expected),
        clip(actual)
    )
}
