//! A kernel wired to stand-in tools, a config snapshot it can change and a recorder it can read.

#![allow(dead_code, reason = "each test file uses a different part")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cos_store::{ConfigStore, Logger, Platform};
use cos_tools::{
    Admission, AdmissionGate, ArgIssue, BoxFuture, CallContext, CallNotes, CallRecord,
    CallRecorder, Capability, DynTool, Feature, GrantEnv, Kernel, KernelDeps, Listing, NestedTool,
    Phase, Requirement, StringCheck, SurfaceId, SurfaceTools, ToolError, ToolOutput, ToolSpec,
    Unattributed,
};
use cos_types::config::Config;
use cos_types::session::ToolOutcome;
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

/// Every recorded variant, by folder name.
pub fn variants() -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(golden())
        .expect("golden corpus")
        .filter_map(Result::ok)
        .filter(|entry| entry.path().join("config.json").exists())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// What a stand-in tool answers next. The golden replay sets it before each call.
pub type Answer = Arc<Mutex<Option<Result<ToolOutput, ToolError>>>>;

/// The nested tools the last handler that ran saw on its context.
pub type Nested = Arc<Mutex<Vec<NestedTool>>>;

/// A finished call, copied out of the borrowed [`CallRecord`].
#[derive(Clone, Debug)]
pub struct Recorded {
    pub tool: &'static str,
    pub nested: bool,
    pub outcome: ToolOutcome,
    pub arguments: Value,
    pub result: Value,
    pub notes: CallNotes,
}

#[derive(Default)]
pub struct Recorder(pub Mutex<Vec<Recorded>>);

impl CallRecorder for Recorder {
    fn record<'a>(&'a self, call: CallRecord<'a>) -> BoxFuture<'a, ()> {
        let copy = Recorded {
            tool: call.tool,
            nested: call.nested,
            outcome: call.outcome,
            arguments: call.arguments.clone(),
            result: serde_json::to_value(call.result).expect("results serialize"),
            notes: call.notes.clone(),
        };
        self.0.lock().expect("recorder").push(copy);
        Box::pin(async {})
    }
}

/// What the browser tools tell the kernel about their string properties.
const BROWSER_STRINGS: &[StringCheck] = &[
    StringCheck {
        path: "tabId",
        flags: "i",
        message: None,
    },
    StringCheck {
        path: "pageId",
        flags: "",
        message: Some(
            "Copy the top-level pageId from the observation, not a frameId or element ref.",
        ),
    },
];

/// A tool that answers whatever the test put in its slot.
pub struct Stand {
    pub spec: &'static ToolSpec,
    pub answer: Answer,
    pub calls: Arc<AtomicUsize>,
    pub nested: Nested,
}

impl DynTool for Stand {
    fn spec(&self) -> &'static ToolSpec {
        self.spec
    }

    fn string_checks(&self) -> &'static [StringCheck] {
        if self.spec.name.starts_with("browser_") {
            BROWSER_STRINGS
        } else {
            &[]
        }
    }

    /// The refinements the real tools declare, so the kernel's wording of them is checked.
    fn refine_json(&self, args: &Value) -> Result<(), Vec<ArgIssue>> {
        let filled =
            |key: &str| matches!(args.get(key), Some(Value::String(text)) if !text.is_empty());
        let action = args["action"].as_str().unwrap_or_default();
        let issues = |issues: Vec<(&str, &str)>| {
            let issues: Vec<ArgIssue> = issues
                .into_iter()
                .map(|(path, message)| ArgIssue::new(path, message))
                .collect();
            if issues.is_empty() {
                Ok(())
            } else {
                Err(issues)
            }
        };
        match self.spec.name {
            "browser_tabs"
                if matches!(action, "attach" | "release" | "close") && !filled("tabId") =>
            {
                issues(vec![("tabId", "Required for this action")])
            }
            "browser_navigate" if action == "url" && !filled("url") => {
                issues(vec![("url", "URL required")])
            }
            "browser_action" if matches!(action, "fill" | "type") => {
                let mut found = Vec::new();
                if !filled("ref") {
                    found.push(("ref", "Editable/select ref required"));
                }
                if args.get("text").is_none_or(Value::is_null) {
                    found.push(("text", "Text required (empty fill clears the field)"));
                }
                issues(found)
            }
            "exec_command" if args.get("cmd").is_some() == args.get("cmds").is_some() => {
                Err(vec![ArgIssue::new(
                    "",
                    "exec_command requires exactly one of cmd or cmds",
                )])
            }
            "update_plan" => {
                let steps = args["plan"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                let running = steps
                    .iter()
                    .filter(|step| step["status"] == "in_progress")
                    .count();
                if running > 1 {
                    Err(vec![ArgIssue::new(
                        "plan",
                        "At most one step may be in_progress.",
                    )])
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        }
    }

    fn call_json<'a>(
        &'a self,
        cx: &'a CallContext,
        _args: Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.nested.lock().expect("nested") = cx.nested_tools();
        let answer = self.answer.lock().expect("answer").take();
        Box::pin(async move {
            answer.unwrap_or_else(|| {
                Err(ToolError::Internal(format!(
                    "{} was not expected to run",
                    self.spec.name
                )))
            })
        })
    }
}

macro_rules! spec {
    ($name:literal, $listing:expr, $requires:expr) => {
        &ToolSpec {
            name: $name,
            listing: $listing,
            requires: $requires,
        }
    };
}

use Capability as C;

/// The specs the tool crates declare, per surface (`cos-core/src/surfaces.rs` and the units
/// that add Desktop tools).
pub fn specs(surface: SurfaceId) -> Vec<&'static ToolSpec> {
    const READ_ANY: &[Capability] = &[C::Read, C::Browse, C::Metadata];
    const WRITE_ANY: &[Capability] = &[C::Create, C::Edit, C::Move, C::DeleteFile];
    match surface {
        SurfaceId::Core => vec![
            spec!("read", Listing::AnyCapability(READ_ANY), Requirement::None),
            spec!(
                "view_image",
                Listing::Capability(C::Read),
                Requirement::Capability(C::Read)
            ),
            spec!(
                "save_image",
                Listing::Capability(C::Create),
                Requirement::Capability(C::Create)
            ),
            spec!(
                "find",
                Listing::FindInsteadOfCommand,
                Requirement::Capability(C::Search)
            ),
            spec!(
                "apply_patch",
                Listing::AnyCapability(WRITE_ANY),
                Requirement::None
            ),
            spec!(
                "exec_command",
                Listing::Capability(C::Command),
                Requirement::Capability(C::Command)
            ),
            spec!(
                "write_stdin",
                Listing::Capability(C::Command),
                Requirement::Capability(C::Command)
            ),
            spec!(
                "update_plan",
                Listing::Feature(Feature::SessionRecording),
                Requirement::Feature(Feature::SessionRecording)
            ),
            spec!(
                "session_finish",
                Listing::Feature(Feature::FinishTool),
                Requirement::None
            ),
            spec!(
                "agents",
                Listing::Feature(Feature::MultiAgent),
                Requirement::Feature(Feature::MultiAgent)
            ),
            spec!("exec", Listing::WithOtherTools, Requirement::None),
        ],
        SurfaceId::Desktop => vec![
            spec!(
                "browser_tabs",
                Listing::Capability(C::Screen),
                Requirement::Capability(C::Screen)
            ),
            spec!(
                "browser_snapshot",
                Listing::Capability(C::Screen),
                Requirement::Capability(C::Screen)
            ),
            spec!(
                "browser_screenshot",
                Listing::Capability(C::Screen),
                Requirement::Capability(C::Screen)
            ),
            spec!(
                "browser_navigate",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "browser_action",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "browser_evaluate",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "browser_console",
                Listing::Capability(C::Screen),
                Requirement::Capability(C::Screen)
            ),
            spec!(
                "browser_network",
                Listing::Capability(C::Screen),
                Requirement::Capability(C::Screen)
            ),
            spec!(
                "list_windows",
                Listing::Capability(C::Screen),
                Requirement::Capability(C::Screen)
            ),
            spec!(
                "get_window",
                Listing::Capability(C::Screen),
                Requirement::Capability(C::Screen)
            ),
            spec!(
                "list_apps",
                Listing::Capability(C::Screen),
                Requirement::Capability(C::Screen)
            ),
            spec!(
                "get_window_state",
                Listing::Capability(C::Screen),
                Requirement::Capability(C::Screen)
            ),
            spec!(
                "launch_app",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "click",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "press_key",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "type_text",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "scroll",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "set_value",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "drag",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "perform_secondary_action",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "activate_window",
                Listing::Capability(C::Control),
                Requirement::Capability(C::Control)
            ),
            spec!(
                "read_clipboard",
                Listing::Capability(C::ClipboardRead),
                Requirement::Capability(C::ClipboardRead)
            ),
            spec!(
                "write_clipboard",
                Listing::Capability(C::ClipboardWrite),
                Requirement::Capability(C::ClipboardWrite)
            ),
            spec!("exec", Listing::WithOtherTools, Requirement::None),
        ],
        SurfaceId::Plugins => vec![spec!("exec", Listing::WithOtherTools, Requirement::None)],
    }
}

/// Folders laid out like the recorder's run folder: a Git work tree above all of them.
pub struct Dirs {
    pub run: PathBuf,
    pub profile: PathBuf,
    pub project: PathBuf,
    pub second: PathBuf,
}

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

impl Dirs {
    pub fn new(label: &str) -> Self {
        let n = NEXT_DIR.fetch_add(1, Ordering::SeqCst);
        let run =
            std::env::temp_dir().join(format!("cos-tools-{}-{n}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&run);
        let dirs = Self {
            profile: run.join("profile"),
            project: run.join("project"),
            second: run.join("second"),
            run,
        };
        for dir in [
            &dirs.profile,
            &dirs.project,
            &dirs.second,
            &dirs.run.join(".git"),
        ] {
            fs::create_dir_all(dir).expect("test folders");
        }
        dirs
    }

    pub fn skills(&self) -> PathBuf {
        self.profile.join("skills")
    }

    /// A recorded config with this run's folders in place of the corpus placeholders.
    pub fn config(&self, recorded: &Value) -> Config {
        let text = serde_json::to_string(recorded).expect("config serializes");
        let escaped = |path: &Path| path.to_string_lossy().replace('\\', "\\\\");
        let text = text
            .replace("<PROJECT>", &escaped(&self.project))
            .replace("<SECOND>", &escaped(&self.second));
        let file = self.profile.join("config.json");
        fs::write(&file, text).expect("config written");
        ConfigStore::new(file, Platform::Windows, Logger::new()).load(APP_VERSION)
    }
}

impl Drop for Dirs {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.run);
    }
}

pub struct Fixture {
    pub kernel: Arc<Kernel>,
    pub answer: Answer,
    pub calls: Arc<AtomicUsize>,
    pub nested: Nested,
    pub recorder: Arc<Recorder>,
    pub config: watch::Sender<Arc<Config>>,
    pub gate: AdmissionGate,
    pub logger: Logger,
    pub dirs: Dirs,
}

pub struct Options {
    pub serving: bool,
    pub platform: Platform,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            serving: true,
            platform: Platform::Windows,
        }
    }
}

impl Fixture {
    /// A kernel on `variant`'s recorded config, every stand-in tool registered.
    pub fn variant(variant: &str) -> Self {
        let recorded = read_json(&golden().join(variant).join("config.json"));
        Self::new(variant, &recorded["config"], Options::default())
    }

    pub fn new(label: &str, recorded: &Value, options: Options) -> Self {
        let dirs = Dirs::new(label);
        let config = dirs.config(recorded);
        let (sender, receiver) = watch::channel(Arc::new(config));
        let (gate, admission) = Admission::channel();
        if options.serving {
            gate.advance(Phase::Serving);
        }
        let answer: Answer = Arc::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let nested: Nested = Arc::default();
        let mut tools = SurfaceTools::default();
        for surface in [SurfaceId::Core, SurfaceId::Desktop, SurfaceId::Plugins] {
            for spec in specs(surface) {
                tools.add(
                    surface,
                    Arc::new(Stand {
                        spec,
                        answer: answer.clone(),
                        calls: calls.clone(),
                        nested: nested.clone(),
                    }),
                );
            }
        }
        let recorder = Arc::new(Recorder::default());
        let logger = Logger::with_clock(|| 0, false);
        let kernel = Kernel::new(KernelDeps {
            app_version: APP_VERSION,
            config: receiver,
            env: GrantEnv {
                skills_dir: dirs.skills(),
                platform: options.platform,
            },
            tools,
            attribution: Arc::new(Unattributed),
            chat_policy: Arc::new(cos_tools::AnyChat),
            recorder: recorder.clone(),
            admission,
            logger: logger.clone(),
        });
        Self {
            kernel,
            answer,
            calls,
            nested,
            recorder,
            config: sender,
            gate,
            logger,
            dirs,
        }
    }

    pub fn answer(&self, answer: Result<ToolOutput, ToolError>) {
        *self.answer.lock().expect("answer") = Some(answer);
    }

    /// Publishes a changed config, as the Settings owner does after a save.
    pub fn change(&self, edit: impl FnOnce(&mut Config)) {
        let mut next = (**self.config.borrow()).clone();
        edit(&mut next);
        self.config.send_replace(Arc::new(next));
    }

    pub fn records(&self) -> Vec<Recorded> {
        self.recorder.0.lock().expect("recorder").clone()
    }

    pub fn log(&self) -> Vec<String> {
        self.logger
            .entries()
            .into_iter()
            .map(|entry| entry.message)
            .collect()
    }

    pub fn names(&self, surface: SurfaceId) -> Vec<String> {
        self.kernel
            .list(surface)
            .iter()
            .map(|tool| tool["name"].as_str().unwrap_or_default().to_owned())
            .collect()
    }
}

/// The base variant's recorded config, for behavior tests that change it.
pub fn base_config() -> Value {
    read_json(&golden().join("base/config.json"))["config"].clone()
}
