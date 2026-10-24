//! A kernel on a golden variant's config with the real exec tools, the recorder's fixture
//! project, and the corpus normalizer for the values that change between runs.

#![allow(dead_code, reason = "each test file uses a different part")]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use cos_exec::{ExecDeps, ExecManager, Launcher};
use cos_store::{ConfigStore, Logger, Platform};
use cos_tools::{
    Admission, BoxFuture, CallRecord, CallRecorder, GrantEnv, Inbound, Kernel, KernelDeps, Phase,
    SurfaceId, SurfaceTools, Unattributed,
};
use serde_json::Value;
use tokio::sync::watch;

pub const APP_VERSION: &str = "2.1.35";

pub fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden")
}

pub fn read_json(path: &Path) -> Value {
    let text =
        fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

struct NoRecorder;

impl CallRecorder for NoRecorder {
    fn record<'a>(&'a self, _call: CallRecord<'a>) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// The recorder's fixture project (`record.mjs`), with the files earlier `base` cases create.
pub struct Project {
    pub run: PathBuf,
    pub root: PathBuf,
    pub profile: PathBuf,
}

impl Project {
    pub fn new(label: &str) -> Self {
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let run = std::env::temp_dir().join(format!("cos-exec-{}-{n}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&run);
        let root = run.join("project");
        let profile = run.join("profile");
        fs::create_dir_all(root.join("src")).expect("fixture folders");
        fs::create_dir_all(profile.join("skills")).expect("profile");
        let write =
            |path: &str, bytes: &[u8]| fs::write(root.join(path), bytes).expect("fixture file");
        write(
            "README.md",
            b"# Fixture project\n\nGolden corpus fixture.\n",
        );
        write("src/greeting.txt", b"hello world\nsecond line\n");
        write("src/notes.md", b"The needle phrase is quartz-lantern.\n");
        write("src/data.bin", &(0..=255u8).collect::<Vec<_>>());
        write("src/pixel.png", b"\x89PNG\r\n\x1a\n");
        write("src/a.txt", b"a\n");
        write("src/b.txt", b"b\n");
        write("src/big.txt", b"big 0\n");
        let large: String = (1..=12_000)
            .map(|i| format!("line {i:05} {}\n", "x".repeat(40)))
            .collect();
        write("src/large.txt", large.as_bytes());
        let git = Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status();
        assert!(
            git.is_ok_and(|status| status.success()),
            "git init in the fixture"
        );
        Self { run, root, profile }
    }

    pub fn native(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.run);
    }
}

pub struct Harness {
    pub kernel: Arc<Kernel>,
    pub exec: Arc<ExecManager>,
    pub project: Project,
}

impl Harness {
    /// A serving kernel on `variant`'s recorded config, Core listing only the exec tools.
    pub fn new(variant: &str, launcher: Arc<dyn Launcher>) -> Self {
        let project = Project::new(variant);
        let recorded = read_json(&golden().join(variant).join("config.json"));
        let text = serde_json::to_string(&recorded["config"])
            .expect("config serializes")
            .replace("<PROJECT>", &project.native().replace('\\', "\\\\"));
        let file = project.profile.join("config.json");
        fs::write(&file, text).expect("config written");
        let config = ConfigStore::new(file, Platform::Windows, Logger::new()).load(APP_VERSION);
        let (_sender, receiver) = watch::channel(Arc::new(config));
        let (gate, admission) = Admission::channel();
        gate.advance(Phase::Serving);
        let exec = ExecManager::new(ExecDeps { launcher });
        let mut tools = SurfaceTools::default();
        for tool in exec.tools() {
            tools.add(SurfaceId::Core, tool);
        }
        let kernel = Kernel::new(KernelDeps {
            app_version: APP_VERSION,
            config: receiver,
            env: GrantEnv {
                skills_dir: project.profile.join("skills"),
                platform: Platform::Windows,
            },
            tools,
            attribution: Arc::new(Unattributed),
            chat_policy: Arc::new(cos_tools::AnyChat),
            recorder: Arc::new(NoRecorder),
            admission,
            logger: Logger::new(),
        });
        std::mem::forget(_sender);
        Self {
            kernel,
            exec,
            project,
        }
    }

    pub async fn call(&self, tool: &str, arguments: Value) -> Value {
        let _request = self.kernel.begin_request(SurfaceId::Core);
        match self
            .kernel
            .call(SurfaceId::Core, tool, arguments, Inbound::default())
            .await
        {
            Ok(result) => serde_json::to_value(result).expect("result serializes"),
            Err(unknown) => serde_json::json!({ "unknown": unknown.0 }),
        }
    }
}

/// Replaces the run-to-run values the corpus normalizer replaces, with session ids numbered by
/// first appearance across one variant run, as `normalize.mjs` numbers them.
pub struct Normalizer {
    sessions: HashMap<String, usize>,
    pub project: String,
}

impl Normalizer {
    pub fn new(project: String) -> Self {
        Self {
            sessions: HashMap::new(),
            project,
        }
    }

    fn session(&mut self, id: &str) -> String {
        let next = self.sessions.len() + 1;
        let n = *self.sessions.entry(id.to_owned()).or_insert(next);
        format!("<EXEC_SESSION:{n}>")
    }

    /// The concrete id a corpus placeholder stands for in this run, if it has appeared.
    pub fn concrete(&self, placeholder: usize) -> Option<u64> {
        self.sessions
            .iter()
            .find(|(_, n)| **n == placeholder)
            .and_then(|(id, _)| id.parse().ok())
    }

    pub fn value(&mut self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(text)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.value(item)).collect())
            }
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(key, item)| {
                        let item = match (key.as_str(), item) {
                            ("chunk_id", _) => Value::String("<CHUNK_ID>".into()),
                            ("wall_time_seconds", _) => Value::String("<DURATION>".into()),
                            ("session_id" | "completed_session_id", Value::Number(n)) => {
                                Value::String(self.session(&n.to_string()))
                            }
                            _ => self.value(item),
                        };
                        (key.clone(), item)
                    })
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    fn text(&mut self, text: &str) -> String {
        let mut out = text.replace(&self.project, "<PROJECT>");
        out = replace_number_after(&out, "Chunk ID: ", |_| "<CHUNK_ID>".into(), true);
        out = replace_number_after(&out, "Wall time: ", |_| "<DURATION>".into(), false);
        for prefix in ["Completed session ID: ", "session ID ", "session "] {
            out = replace_number_after(&out, prefix, |id| self.session(id), false);
        }
        // The pseudo-console names the shell (and elevation) in an OSC 0 title.
        while let Some(start) = out.find("\u{1b}]0;") {
            let Some(end) = out[start..].find('\u{7}') else {
                break;
            };
            let title = &out[start + 4..start + end];
            if title == "<CONSOLE_TITLE>" {
                break;
            }
            out.replace_range(start + 4..start + end, "<CONSOLE_TITLE>");
        }
        out
    }
}

/// Replaces the token after each `prefix` (digits and dots, or hex for chunk ids).
fn replace_number_after(
    text: &str,
    prefix: &str,
    mut with: impl FnMut(&str) -> String,
    hex: bool,
) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(prefix) {
        out.push_str(&rest[..at + prefix.len()]);
        rest = &rest[at + prefix.len()..];
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.' || (hex && c.is_ascii_hexdigit())))
            .unwrap_or(rest.len());
        if end == 0 {
            continue;
        }
        out.push_str(&with(&rest[..end]));
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}
