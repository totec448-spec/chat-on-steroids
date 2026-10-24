//! A real kernel with `apply_patch` registered, on a config written for a temp tree.

#![allow(dead_code, reason = "each test file uses a different part")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cos_store::{ConfigStore, Logger, Platform};
use cos_tools::{
    Admission, BoxFuture, CallRecord, CallRecorder, GrantEnv, Inbound, Kernel, KernelDeps, Phase,
    SurfaceId, SurfaceTools, ToolResult, Unattributed,
};
use cos_types::config::Config;
use cos_types::session::{FileChange, ToolOutcome};
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

/// A finished call as the recorder saw it.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub outcome: ToolOutcome,
    pub changes: Vec<FileChange>,
}

#[derive(Default)]
pub struct Recorder(pub Mutex<Vec<Recorded>>);

impl CallRecorder for Recorder {
    fn record<'a>(&'a self, call: CallRecord<'a>) -> BoxFuture<'a, ()> {
        self.0.lock().expect("recorder").push(Recorded {
            outcome: call.outcome,
            changes: call.notes.changes.clone(),
        });
        Box::pin(async {})
    }
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// Temp folders shaped like the recorder's run: `project`, `second` and a profile.
pub struct Tree {
    pub run: PathBuf,
    pub project: PathBuf,
    pub second: PathBuf,
    pub profile: PathBuf,
}

impl Tree {
    pub fn new(label: &str) -> Self {
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let run =
            std::env::temp_dir().join(format!("cos-patch-{}-{n}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&run);
        for dir in ["project", "second", "profile"] {
            fs::create_dir_all(run.join(dir)).expect("test folders");
        }
        // Canonical, so a host path in a message is spelled the way the sandbox spells it.
        let run = cos_fs::canonical(&run).expect("canonical temp folder");
        Self {
            project: run.join("project"),
            second: run.join("second"),
            profile: run.join("profile"),
            run,
        }
    }

    /// The fixture project of the golden corpus, as far as patches read it.
    pub fn with_fixture(self) -> Self {
        self.write("README.md", "# Fixture project\n");
        self.write("src/greeting.txt", "hello world\nsecond line\n");
        self.write("src/notes.md", "# Notes\n\n- first\n- second\n- third\n");
        fs::write(
            self.project.join("src/data.bin"),
            (0..=255u8).collect::<Vec<_>>(),
        )
        .expect("fixture");
        fs::write(self.second.join("other.txt"), "other root\n").expect("fixture");
        self
    }

    pub fn write(&self, relative: &str, contents: impl AsRef<[u8]>) {
        let path = self.project.join(relative);
        fs::create_dir_all(path.parent().expect("parent")).expect("fixture folder");
        fs::write(path, contents).expect("fixture file");
    }

    pub fn read(&self, relative: &str) -> Option<String> {
        fs::read_to_string(self.project.join(relative)).ok()
    }

    pub fn bytes(&self, relative: &str) -> Option<Vec<u8>> {
        fs::read(self.project.join(relative)).ok()
    }

    /// The config `variant` recorded, pointed at this tree.
    pub fn config(&self, recorded: &Value) -> Config {
        let escaped = |path: &Path| path.to_string_lossy().replace('\\', "\\\\");
        let text = serde_json::to_string(recorded)
            .expect("config serializes")
            .replace("<PROJECT>", &escaped(&self.project))
            .replace("<SECOND>", &escaped(&self.second));
        let file = self.profile.join("config.json");
        fs::write(&file, text).expect("config written");
        ConfigStore::new(file, Platform::Windows, Logger::new()).load(APP_VERSION)
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.run);
    }
}

pub struct Harness {
    pub kernel: Arc<Kernel>,
    pub recorder: Arc<Recorder>,
    pub config: watch::Sender<Arc<Config>>,
    pub tree: Tree,
}

impl Harness {
    /// A kernel on the recorded config of `variant` (`base`, `two-roots`, ...).
    pub fn variant(variant: &str) -> Self {
        let recorded = read_json(&golden().join(variant).join("config.json"));
        Self::new(Tree::new(variant).with_fixture(), &recorded["config"])
    }

    pub fn base() -> Self {
        Self::variant("base")
    }

    pub fn new(tree: Tree, recorded: &Value) -> Self {
        let config = tree.config(recorded);
        let (sender, receiver) = watch::channel(Arc::new(config));
        let (gate, admission) = Admission::channel();
        gate.advance(Phase::Serving);
        let mut tools = SurfaceTools::default();
        tools.add(SurfaceId::Core, cos_patch::tool());
        let recorder = Arc::new(Recorder::default());
        let kernel = Kernel::new(KernelDeps {
            app_version: APP_VERSION,
            config: receiver,
            env: GrantEnv {
                skills_dir: tree.profile.join("skills"),
                platform: Platform::Windows,
            },
            tools,
            attribution: Arc::new(Unattributed),
            chat_policy: Arc::new(cos_tools::AnyChat),
            recorder: recorder.clone(),
            admission,
            logger: Logger::with_clock(|| 0, false),
        });
        Self {
            kernel,
            recorder,
            config: sender,
            tree,
        }
    }

    /// Changes the live config, as a settings save does.
    pub fn change(&self, edit: impl FnOnce(&mut Config)) {
        let mut next = (**self.config.borrow()).clone();
        edit(&mut next);
        self.config.send_replace(Arc::new(next));
    }

    /// `tools/call apply_patch`; `None` when the tool is not listed.
    pub async fn call(&self, arguments: Value) -> Option<ToolResult> {
        self.kernel
            .call(
                SurfaceId::Core,
                "apply_patch",
                arguments,
                Inbound::default(),
            )
            .await
            .ok()
    }

    /// The tool's own text (the first content part, run time masked) and `isError`.
    pub async fn patch(&self, patch: &str) -> (String, bool) {
        let result = self
            .call(serde_json::json!({ "patch": patch }))
            .await
            .expect("apply_patch is listed");
        let value = serde_json::to_value(&result).expect("serializes");
        let text = value["content"][0]["text"].as_str().unwrap_or_default();
        (mask_wall_time(text), result.is_error)
    }

    pub fn last_record(&self) -> Recorded {
        self.recorder
            .0
            .lock()
            .expect("recorder")
            .last()
            .cloned()
            .expect("a recorded call")
    }
}

/// `Wall time: 0.1 seconds` becomes `Wall time: <DURATION> seconds`, as the corpus normalizes it.
pub fn mask_wall_time(text: &str) -> String {
    let Some(start) = text.find("Wall time: ") else {
        return text.to_owned();
    };
    let value = start + "Wall time: ".len();
    let Some(end) = text[value..].find(" seconds") else {
        return text.to_owned();
    };
    format!("{}<DURATION>{}", &text[..value], &text[value + end..])
}

/// A patch with the Begin and End markers around `body`.
pub fn wrap(body: &str) -> String {
    format!("*** Begin Patch\n{body}\n*** End Patch\n")
}
