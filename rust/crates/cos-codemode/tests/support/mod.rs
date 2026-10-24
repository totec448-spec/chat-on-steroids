//! A real cos-tools kernel with code mode and stand-in `read` and `view_image` tools that
//! answer what the recorded TypeScript tools answered.

#![allow(dead_code, reason = "each test file uses a different part")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cos_store::{ConfigStore, Logger, Platform};
use cos_tools::{
    Admission, Attribution, BoxFuture, CallContext, CallRecord, CallRecorder, Capability, Content,
    GrantEnv, Inbound, Kernel, KernelDeps, Listing, Phase, RequestId, Requirement, SurfaceId,
    SurfaceTools, Tool, ToolError, ToolOutput, ToolResult, ToolSpec, Unattributed,
};
use cos_types::config::Config;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::watch;

pub const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

pub fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden")
}

pub fn read_json(path: &Path) -> Value {
    let text =
        fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// `read` as the corpus saw it answer for the fixture project's files.
pub struct Read;

#[derive(Deserialize)]
pub struct ReadArgs {
    paths: Vec<String>,
}

impl Tool for Read {
    type Args = ReadArgs;
    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "read",
        listing: Listing::AnyCapability(&[
            Capability::Read,
            Capability::Browse,
            Capability::Metadata,
        ]),
        requires: Requirement::None,
    };

    async fn call(&self, _cx: &CallContext, args: ReadArgs) -> Result<ToolOutput, ToolError> {
        match args.paths.first().map(String::as_str) {
            Some("/project/src/notes.md") => Ok(ToolResult::text(
                "--- /project/src/notes.md — lines 1-1 of 1, 37 B, modified <ISO_TIME> ---\n# Notes",
            )
            .into()),
            Some("/project/README.md") => Ok(ToolResult::text("--- /project/README.md ---").into()),
            _ => Err(ToolError::Refused("Not found".to_owned())),
        }
    }
}

/// `view_image` answering the fixture's 1x1 PNG.
pub struct ViewImage;

#[derive(Deserialize)]
pub struct ViewImageArgs {
    #[allow(dead_code, reason = "the stand-in answers one image")]
    path: String,
}

impl Tool for ViewImage {
    type Args = ViewImageArgs;
    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "view_image",
        listing: Listing::Capability(Capability::Read),
        requires: Requirement::Capability(Capability::Read),
    };

    async fn call(&self, _cx: &CallContext, _args: ViewImageArgs) -> Result<ToolOutput, ToolError> {
        Ok(ToolResult {
            content: vec![Content::Image {
                data: PNG.to_owned(),
                mime_type: "image/png".to_owned(),
            }],
            structured_content: None,
            is_error: false,
        }
        .into())
    }
}

/// A finished call, copied out of the borrowed record.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub tool: &'static str,
    pub nested: bool,
    pub arguments: Value,
}

#[derive(Default)]
pub struct Recorder(pub Mutex<Vec<Recorded>>);

impl CallRecorder for Recorder {
    fn record<'a>(&'a self, call: CallRecord<'a>) -> BoxFuture<'a, ()> {
        self.0.lock().expect("recorder").push(Recorded {
            tool: call.tool,
            nested: call.nested,
            arguments: call.arguments.clone(),
        });
        Box::pin(async {})
    }
}

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

/// Scripts in one test binary run one at a time: the process allows four at once, and tests
/// running in parallel would otherwise see `CODE_MODE_BUSY`.
static ONE_SCRIPT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub struct Fixture {
    pub kernel: Arc<Kernel>,
    pub recorder: Arc<Recorder>,
    config: watch::Sender<Arc<Config>>,
    run: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.run);
    }
}

impl Fixture {
    /// A serving kernel on `variant`'s recorded config.
    pub fn variant(variant: &str, attribution: Arc<dyn Attribution>) -> Self {
        let n = NEXT_DIR.fetch_add(1, Ordering::SeqCst);
        let run =
            std::env::temp_dir().join(format!("cos-codemode-{}-{n}-{variant}", std::process::id()));
        let project = run.join("project");
        let profile = run.join("profile");
        fs::create_dir_all(&project).expect("project folder");
        fs::create_dir_all(&profile).expect("profile folder");
        let recorded = read_json(&golden().join(variant).join("config.json"));
        let text = serde_json::to_string(&recorded["config"])
            .expect("config serializes")
            .replace(
                "<PROJECT>",
                &project.to_string_lossy().replace('\\', "\\\\"),
            );
        let file = profile.join("config.json");
        fs::write(&file, text).expect("config written");
        let config = ConfigStore::new(file, Platform::Windows, Logger::new()).load("2.1.35");
        let (config, receiver) = watch::channel(Arc::new(config));
        let (gate, admission) = Admission::channel();
        gate.advance(Phase::Serving);
        let mut tools = SurfaceTools::default();
        tools
            .add(SurfaceId::Core, Arc::new(Read))
            .add(SurfaceId::Core, Arc::new(ViewImage))
            .add(SurfaceId::Core, cos_codemode::tool());
        let recorder = Arc::new(Recorder::default());
        let kernel = Kernel::new(KernelDeps {
            app_version: "2.1.35",
            config: receiver,
            env: GrantEnv {
                skills_dir: profile.join("skills"),
                platform: Platform::Windows,
            },
            tools,
            attribution,
            chat_policy: Arc::new(cos_tools::AnyChat),
            recorder: recorder.clone(),
            admission,
            logger: Logger::with_clock(|| 0, false),
        });
        Self {
            kernel,
            recorder,
            config,
            run,
        }
    }

    pub fn unattributed(variant: &str) -> Self {
        Self::variant(variant, Arc::new(Unattributed))
    }

    /// One `exec` call on Core, as the transport makes it.
    pub async fn exec(&self, code: &str, request_id: Option<&str>) -> ToolResult {
        let _one = ONE_SCRIPT.lock().await;
        let inbound = Inbound {
            request_id: request_id.and_then(RequestId::from_header),
            setup_profile_id: None,
        };
        self.kernel
            .call(
                SurfaceId::Core,
                "exec",
                serde_json::json!({ "code": code }),
                inbound,
            )
            .await
            .expect("exec is listed")
    }

    /// Saves a settings change, as the Settings owner publishes one.
    pub fn edit(&self, change: impl FnOnce(&mut Config)) {
        self.config
            .send_modify(|config| change(Arc::make_mut(config)));
    }

    pub fn records(&self) -> Vec<Recorded> {
        self.recorder.0.lock().expect("recorder").clone()
    }
}

pub fn texts(result: &ToolResult) -> Vec<String> {
    result
        .content
        .iter()
        .filter_map(|part| match part {
            Content::Text { text } => Some(text.clone()),
            Content::Image { .. } => None,
        })
        .collect()
}
