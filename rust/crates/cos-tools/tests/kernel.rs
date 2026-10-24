//! Kernel behavior through its public interface: exposure, grants and their refusal texts,
//! the call pipeline, error mapping, the identity notice, nested calls, counters and clocks.

mod support;

use std::io;
use std::sync::Arc;
use std::time::Duration;

use cos_store::Platform;
use cos_tools::{
    ArgIssue, Attribution, BoxFuture, CallContext, CallNotes, CallRecord, CallRecorder, Caller,
    Capability, ChatPolicy, Connectors, EpochMs, Exposure, Feature, GrantEnv, Grants, Inbound,
    Kernel, KernelDeps, Listing, NestedInvoker, Phase, ProcessNotes, RequestId, Requirement,
    SurfaceId, SurfaceTools, Tool, ToolError, ToolOutput, ToolResult, ToolSpec, Unattributed,
    UnknownTool,
};
use cos_types::ids::{ConversationId, SessionId};
use cos_types::session::ToolOutcome;
use serde::Deserialize;
use serde_json::{Value, json};
use support::{Fixture, Options, base_config};
use tokio::sync::{Notify, watch};

fn base() -> Fixture {
    Fixture::new("base", &base_config(), Options::default())
}

fn ok(text: &str) -> Result<ToolOutput, ToolError> {
    Ok(ToolResult::text(text).into())
}

fn texts(result: &ToolResult) -> Vec<String> {
    result
        .content
        .iter()
        .map(|part| match part {
            cos_tools::Content::Text { text } => text.clone(),
            cos_tools::Content::Image { mime_type, .. } => mime_type.clone(),
        })
        .collect()
}

const NOTICE_OFF: &str =
    "\n--- Identity notice ---\nThis app could not tell which ChatGPT conversation made this call";

// ------------------------------------------------------------------ exposure

#[test]
fn exposure_widens_and_keeps_its_first_find_decision_until_reset() {
    let exposure = Exposure::default();
    let env = GrantEnv {
        skills_dir: "skills".into(),
        platform: Platform::Windows,
    };
    let fixture = base();
    let mut config = (**fixture.config.borrow()).clone();
    config.capabilities.command = false;
    let search_only = Grants::derive(&config, &env);
    config.capabilities.command = true;
    let with_command = Grants::derive(&config, &env);

    let first = exposure.observe(SurfaceId::Core, &search_only);
    assert!(first.find, "search without commands lists find");
    let widened = exposure.observe(SurfaceId::Core, &with_command);
    assert!(widened.capabilities.contains(Capability::Command));
    assert!(
        widened.find,
        "a later grant cannot delete find from a cached list"
    );
    let narrowed = exposure.observe(SurfaceId::Core, &search_only);
    assert!(
        narrowed.capabilities.contains(Capability::Command),
        "exposure never narrows"
    );

    assert!(
        !exposure.observe(SurfaceId::Desktop, &with_command).find,
        "each surface decides alone"
    );
    exposure.reset();
    assert!(!exposure.observe(SurfaceId::Core, &with_command).find);
}

#[test]
fn a_settings_change_relists_from_the_new_settings() {
    let fixture = base();
    assert!(
        fixture
            .names(SurfaceId::Core)
            .contains(&"exec_command".to_owned())
    );
    fixture.change(|config| config.capabilities.command = false);
    let names = fixture.names(SurfaceId::Core);
    assert!(!names.contains(&"exec_command".to_owned()), "{names:?}");
    assert!(
        names.contains(&"find".to_owned()),
        "find is decided again: {names:?}"
    );
}

#[tokio::test]
async fn a_tool_the_settings_no_longer_list_is_unknown() {
    let fixture = base();
    fixture.kernel.list(SurfaceId::Core);
    fixture.change(|config| config.capabilities.command = false);
    let answer = fixture
        .kernel
        .call(
            SurfaceId::Core,
            "exec_command",
            json!({"cmd": "x"}),
            Inbound::default(),
        )
        .await;
    assert_eq!(answer, Err(UnknownTool("exec_command".to_owned())));
    assert!(
        fixture.records().is_empty(),
        "an unknown tool is not recorded"
    );
}

#[test]
fn turning_a_feature_off_removes_its_tool() {
    let fixture = base();
    assert!(
        fixture
            .names(SurfaceId::Core)
            .contains(&"update_plan".to_owned())
    );
    fixture.change(|config| config.sessions.record = false);
    assert!(
        !fixture
            .names(SurfaceId::Core)
            .contains(&"update_plan".to_owned())
    );
}

#[test]
fn desktop_with_its_permissions_off_lists_nothing_not_even_code_mode() {
    assert!(base().names(SurfaceId::Desktop).is_empty());
    assert!(base().names(SurfaceId::Plugins).is_empty());
}

// ------------------------------------------------------------------ grants

fn grants(edit: impl FnOnce(&mut cos_types::config::Config), platform: Platform) -> Grants {
    let fixture = base();
    let mut config = (**fixture.config.borrow()).clone();
    edit(&mut config);
    Grants::derive(
        &config,
        &GrantEnv {
            skills_dir: "skills".into(),
            platform,
        },
    )
}

#[test]
fn read_only_switches_off_every_writing_capability_and_nothing_else() {
    let live = grants(
        |config| {
            config.read_only = true;
            config.capabilities.clipboard_write = true;
            config.capabilities.screen = true;
        },
        Platform::Windows,
    );
    for capability in [
        Capability::Create,
        Capability::Edit,
        Capability::Move,
        Capability::DeleteFile,
        Capability::Command,
        Capability::Control,
        Capability::ClipboardWrite,
    ] {
        assert!(
            !live.capabilities.contains(capability),
            "{capability:?} stayed on"
        );
    }
    assert!(live.capabilities.contains(Capability::Read));
    assert!(live.capabilities.contains(Capability::Screen));
    assert!(live.read_only);
}

#[test]
fn without_native_automation_only_the_clipboard_goes() {
    let live = grants(
        |config| {
            config.capabilities.screen = true;
            config.capabilities.clipboard_read = true;
        },
        Platform::Linux,
    );
    assert!(live.capabilities.contains(Capability::Screen));
    assert!(!live.capabilities.contains(Capability::ClipboardRead));
}

#[test]
fn feature_switches_and_the_unattributed_opt_in_follow_the_config() {
    let live = grants(
        |config| {
            config.multi_agent.enabled = true;
            config.multi_agent.allow_unattributed_calls = true;
            config.ui.finish_tool = Some(true);
            config.sessions.record = false;
        },
        Platform::Windows,
    );
    assert!(live.features.contains(Feature::MultiAgent));
    assert!(live.features.contains(Feature::FinishTool));
    assert!(!live.features.contains(Feature::SessionRecording));
    assert!(live.allow_unattributed);
    let names: Vec<String> = live
        .roots
        .iter()
        .map(|root| root.name.to_string())
        .collect();
    assert_eq!(names, ["/project", "/skills"]);
}

#[test]
fn a_revoked_capability_names_its_settings_permission() {
    let live = grants(
        |config| config.capabilities.screen = false,
        Platform::Windows,
    );
    let refusal = live
        .require(Requirement::Capability(Capability::Screen), "observe")
        .expect_err("screen is off");
    assert_eq!(
        refusal.to_string(),
        "TOOL_DISABLED: observe requires the \"See the screen\" permission. Ask the user to enable \"See the screen\" in the app, then retry."
    );
    assert_eq!(refusal.outcome(), ToolOutcome::ToolRejected);
    assert!(
        live.require(Requirement::Capability(Capability::Read), "read")
            .is_ok()
    );
}

#[test]
fn read_only_is_named_only_for_the_capabilities_it_turned_off() {
    let live = grants(|config| config.read_only = true, Platform::Windows);
    let refusal = live
        .require(Requirement::Capability(Capability::Edit), "mutation")
        .expect_err("read-only");
    assert_eq!(
        refusal.to_string(),
        "TOOL_DISABLED: mutation is disabled because Read-only mode is on. Ask the user to turn Read-only off in the app, then retry."
    );
    let screen = live
        .require(Requirement::Capability(Capability::Screen), "observe")
        .expect_err("screen is off");
    assert!(screen.to_string().contains("See the screen"));
    assert!(!screen.to_string().contains("Read-only"));
}

#[test]
fn a_switched_off_feature_names_its_setting() {
    let live = grants(
        |config| {
            config.sessions.record = false;
            config.multi_agent.enabled = false;
        },
        Platform::Windows,
    );
    assert_eq!(
        live.require(
            Requirement::Feature(Feature::SessionRecording),
            "update_plan"
        )
        .expect_err("off")
        .to_string(),
        "FEATURE_DISABLED: Session recording is switched off in Chat On Steroids. Ask the user to enable \"Settings → Chat\" in the app, then try again."
    );
    assert!(
        live.require(Requirement::Feature(Feature::MultiAgent), "agents")
            .expect_err("off")
            .to_string()
            .contains("\"Multi-agent mode (experimental)\"")
    );
}

// ------------------------------------------------------------------ request ids and errors

#[test]
fn request_ids_drop_the_per_attempt_suffix_once_at_ingress() {
    let id = |raw: &str| RequestId::from_header(raw).map(|id| id.as_str().to_owned());
    assert_eq!(
        id("wfr_00000000000000000000000000000001/yqy1").as_deref(),
        Some("wfr_00000000000000000000000000000001")
    );
    assert_eq!(
        id("  wfr_abc_123/relay-hop").as_deref(),
        Some("wfr_abc_123")
    );
    assert_eq!(id("/missing-base"), None);
    assert_eq!(id("wfr.bad/suffix"), None);
    assert_eq!(id(&"x".repeat(101)), None);
    assert_eq!(id(&"x".repeat(100)).map(|id| id.len()), Some(100));
    assert_eq!(id(""), None);
}

#[test]
fn os_errors_become_short_text_without_the_host_path() {
    let text = |error: io::Error| ToolError::from_io(&error).to_string();
    let secret = "C:\\Users\\someone\\secret.txt";
    assert_eq!(
        text(io::Error::new(io::ErrorKind::NotFound, secret)),
        "Not found"
    );
    assert_eq!(
        text(io::Error::new(io::ErrorKind::PermissionDenied, secret)),
        "Access denied by the operating system"
    );
    assert_eq!(
        text(io::Error::new(io::ErrorKind::AlreadyExists, secret)),
        "Already exists"
    );
    assert_eq!(
        text(io::Error::new(io::ErrorKind::DirectoryNotEmpty, secret)),
        "Directory is not empty"
    );
    assert_eq!(
        text(io::Error::new(io::ErrorKind::InvalidInput, secret)),
        "Filesystem error (EINVAL)"
    );
    assert_eq!(text(io::Error::other(secret)), "Filesystem error (UNKNOWN)");
    if cfg!(windows) {
        assert_eq!(
            text(io::Error::from_raw_os_error(32)),
            "The file is in use by another program"
        );
    }
    assert_eq!(
        ToolError::from_io(&io::Error::new(io::ErrorKind::NotFound, secret)).outcome(),
        ToolOutcome::ToolRejected
    );
}

// ------------------------------------------------------------------ the call pipeline

#[tokio::test]
async fn a_call_that_ran_gets_the_identity_notice_a_log_line_and_a_record() {
    let fixture = base();
    fixture.answer(ok("contents"));
    let result = fixture
        .kernel
        .call(
            SurfaceId::Core,
            "view_image",
            json!({"path": "/project/a.png"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    let parts = texts(&result);
    assert_eq!(parts[0], "contents");
    assert!(parts[1].starts_with(NOTICE_OFF), "{parts:?}");
    assert!(!result.is_error);
    let records = fixture.records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].tool, "view_image");
    assert_eq!(records[0].outcome, ToolOutcome::Ok);
    assert!(!records[0].nested);
    assert_eq!(
        records[0].result,
        json!(result),
        "the delivered result is what is recorded"
    );
    assert!(
        fixture
            .log()
            .iter()
            .any(|line| line.starts_with("tool view_image ok in "))
    );
    assert!(fixture.kernel.last_tool_call_at(SurfaceId::Core).is_some());
    assert_eq!(fixture.kernel.last_tool_call_at(SurfaceId::Desktop), None);
}

#[tokio::test]
async fn refusals_and_internal_failures_are_results_with_their_outcomes() {
    let fixture = base();
    fixture.answer(Err(ToolError::Refused(
        "first line\nsecond line".to_owned(),
    )));
    let refused = fixture
        .kernel
        .call(
            SurfaceId::Core,
            "view_image",
            json!({"path": "/x"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert!(refused.is_error);
    assert_eq!(texts(&refused)[0], "first line\nsecond line");

    fixture.answer(Err(ToolError::Internal("broke".to_owned())));
    let failed = fixture
        .kernel
        .call(
            SurfaceId::Core,
            "view_image",
            json!({"path": "/x"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert!(failed.is_error);

    let outcomes: Vec<ToolOutcome> = fixture
        .records()
        .iter()
        .map(|record| record.outcome)
        .collect();
    assert_eq!(
        outcomes,
        [ToolOutcome::ToolRejected, ToolOutcome::ToolInternalError]
    );
    let log = fixture.log();
    assert!(
        log.iter()
            .any(|line| line.contains("tool view_image rejected in ")
                && line.ends_with(": first line")),
        "{log:?}"
    );
    assert!(
        log.iter()
            .any(|line| line.contains("tool view_image failed in ") && line.ends_with(": broke")),
        "{log:?}"
    );
}

#[tokio::test]
async fn a_tool_noted_outcome_overrides_ok() {
    let fixture = base();
    fixture.answer(Ok(ToolOutput {
        result: ToolResult::text("exit 1"),
        notes: CallNotes {
            outcome: Some(ToolOutcome::ProcessExitNonzero),
            ..CallNotes::default()
        },
    }));
    fixture
        .kernel
        .call(
            SurfaceId::Core,
            "view_image",
            json!({"path": "/x"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert_eq!(
        fixture.records()[0].outcome,
        ToolOutcome::ProcessExitNonzero
    );
}

#[tokio::test]
async fn the_recorder_gets_the_count_and_process_a_tool_noted() {
    let fixture = base();
    let notes = CallNotes {
        outcome: Some(ToolOutcome::ProcessExitNonzero),
        count: Some(7),
        process: Some(ProcessNotes {
            exit_code: Some(3),
            running: Some(false),
            timed_out: false,
            benign_exit: false,
            duration_ms: Some(640),
            session_id: Some("41".into()),
        }),
        ..CallNotes::default()
    };
    fixture.answer(Ok(ToolOutput {
        result: ToolResult::text("Process exited with code 3"),
        notes: notes.clone(),
    }));
    fixture
        .kernel
        .call(
            SurfaceId::Core,
            "view_image",
            json!({"path": "/x"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert_eq!(fixture.records()[0].notes, notes);
}

#[tokio::test]
async fn a_schema_refusal_runs_nothing_and_records_nothing() {
    let fixture = base();
    let result = fixture
        .kernel
        .call(
            SurfaceId::Core,
            "read",
            json!({"paths": "/project/README.md"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert_eq!(
        texts(&result),
        [
            "Input validation error: Invalid arguments for tool read: paths: Invalid input: expected array, received string"
        ]
    );
    assert!(result.is_error);
    assert_eq!(fixture.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(fixture.records().is_empty());
    assert_eq!(fixture.kernel.last_tool_call_at(SurfaceId::Core), None);
}

#[tokio::test]
async fn missing_arguments_validate_as_an_empty_object() {
    let fixture = base();
    let result = fixture
        .kernel
        .call(
            SurfaceId::Core,
            "view_image",
            Value::Null,
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert_eq!(
        texts(&result),
        [
            "Input validation error: Invalid arguments for tool view_image: path: Invalid input: expected string, received undefined"
        ]
    );
}

#[tokio::test]
async fn the_opt_in_notice_says_who_owns_request_state() {
    let mut config = base_config();
    config["multiAgent"]["allowUnattributedCalls"] = json!(true);
    let fixture = Fixture::new("opt-in", &config, Options::default());
    let with_id = Inbound {
        request_id: RequestId::from_header("golden-request-1"),
        setup_profile_id: None,
    };
    fixture.answer(ok("done"));
    let result = fixture
        .kernel
        .call(
            SurfaceId::Core,
            "view_image",
            json!({"path": "/x"}),
            with_id,
        )
        .await
        .expect("listed");
    assert!(texts(&result)[1].contains("This request id owns its workspace"));
    fixture.answer(ok("done"));
    let result = fixture
        .kernel
        .call(
            SurfaceId::Core,
            "view_image",
            json!({"path": "/x"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert!(texts(&result)[1].contains("This call has no request id"));
}

#[tokio::test]
async fn the_core_notice_also_reaches_structured_content() {
    let fixture = base();
    fixture.answer(Ok(ToolResult {
        content: vec![cos_tools::Content::Text {
            text: "out".to_owned(),
        }],
        structured_content: Some(json!({"exit_code": 0, "supplemental_context": "own note"})),
        is_error: false,
    }
    .into()));
    let result = fixture
        .kernel
        .call(
            SurfaceId::Core,
            "exec_command",
            json!({"cmd": "x"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    let supplemental = result.structured_content.expect("kept")["supplemental_context"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(
        supplemental.starts_with("own note\n\n--- Identity notice ---"),
        "{supplemental}"
    );
}

struct Proven;

impl Attribution for Proven {
    fn resolve<'a>(
        &'a self,
        _tool: &'a str,
        _started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller> {
        let caller = Caller {
            request_id: request_id.cloned(),
            chat: Some((
                ConversationId::parse("conversation-1").expect("id"),
                SessionId::parse("2026-10-20-abcdef12").expect("id"),
            )),
        };
        Box::pin(async move { caller })
    }
}

/// A one-tool kernel with its own attribution and tools, for the cases the stand-ins cannot show.
fn kernel_with(
    tools: SurfaceTools,
    attribution: Arc<dyn Attribution>,
    recorder: Arc<dyn CallRecorder>,
) -> (
    Arc<Kernel>,
    cos_tools::AdmissionGate,
    support::Dirs,
    watch::Sender<Arc<cos_types::config::Config>>,
) {
    policed_kernel(tools, attribution, recorder, Arc::new(cos_tools::AnyChat))
}

fn policed_kernel(
    tools: SurfaceTools,
    attribution: Arc<dyn Attribution>,
    recorder: Arc<dyn CallRecorder>,
    chat_policy: Arc<dyn ChatPolicy>,
) -> (
    Arc<Kernel>,
    cos_tools::AdmissionGate,
    support::Dirs,
    watch::Sender<Arc<cos_types::config::Config>>,
) {
    let dirs = support::Dirs::new("custom");
    let config = dirs.config(&base_config());
    let (sender, receiver) = watch::channel(Arc::new(config));
    let (gate, admission) = cos_tools::Admission::channel();
    let kernel = Kernel::new(KernelDeps {
        app_version: support::APP_VERSION,
        config: receiver,
        env: GrantEnv {
            skills_dir: dirs.skills(),
            platform: Platform::Windows,
        },
        tools,
        attribution,
        chat_policy,
        recorder,
        admission,
        logger: cos_store::Logger::with_clock(|| 0, false),
    });
    (kernel, gate, dirs, sender)
}

#[derive(Default)]
struct Records(std::sync::Mutex<Vec<(&'static str, bool, ToolOutcome, Value)>>);

impl CallRecorder for Records {
    fn record<'a>(&'a self, call: CallRecord<'a>) -> BoxFuture<'a, ()> {
        self.0.lock().expect("records").push((
            call.tool,
            call.nested,
            call.outcome,
            serde_json::to_value(call.result).expect("serializes"),
        ));
        Box::pin(async {})
    }
}

/// `view_image` with typed arguments, answering with its own path.
struct ViewImage;

#[derive(Deserialize)]
struct PathArgs {
    path: String,
}

impl Tool for ViewImage {
    type Args = PathArgs;
    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "view_image",
        listing: Listing::Capability(Capability::Read),
        requires: Requirement::Capability(Capability::Read),
    };

    async fn call(&self, _cx: &CallContext, args: PathArgs) -> Result<ToolOutput, ToolError> {
        Ok(ToolResult::text(format!("saw {}", args.path)).into())
    }
}

#[tokio::test]
async fn an_attributed_caller_gets_no_notice() {
    let mut tools = SurfaceTools::default();
    tools.add(SurfaceId::Core, Arc::new(ViewImage));
    let (kernel, gate, _dirs, _config) =
        kernel_with(tools, Arc::new(Proven), Arc::new(Records::default()));
    gate.advance(Phase::Serving);
    let result = kernel
        .call(
            SurfaceId::Core,
            "view_image",
            json!({"path": "/p"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert_eq!(texts(&result), ["saw /p"]);
}

/// `view_image` that refuses with data, as a desktop tool reports a stale window.
struct StaleImage;

impl Tool for StaleImage {
    type Args = PathArgs;
    const SPEC: &'static ToolSpec = ViewImage::SPEC;

    async fn call(&self, _cx: &CallContext, _args: PathArgs) -> Result<ToolOutput, ToolError> {
        Err(ToolError::RefusedWithDetail {
            text: "STALE_WINDOW: gone\nNext step: list_windows".to_owned(),
            detail: json!({ "code": "STALE_WINDOW", "completed_count": 0 }),
        })
    }
}

#[tokio::test]
async fn a_refusal_with_detail_is_an_error_result_with_structured_error() {
    let mut tools = SurfaceTools::default();
    tools.add(SurfaceId::Core, Arc::new(StaleImage));
    let records = Arc::new(Records::default());
    let (kernel, gate, _dirs, _config) = kernel_with(tools, Arc::new(Proven), records.clone());
    gate.advance(Phase::Serving);
    let result = kernel
        .call(
            SurfaceId::Core,
            "view_image",
            json!({"path": "/p"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert_eq!(
        serde_json::to_value(&result).expect("serializes"),
        json!({
            "content": [{ "type": "text", "text": "STALE_WINDOW: gone\nNext step: list_windows" }],
            "structuredContent": { "error": { "code": "STALE_WINDOW", "completed_count": 0 } },
            "isError": true
        })
    );
    let recorded = records.0.lock().expect("records");
    assert_eq!(recorded[0].2, ToolOutcome::ToolRejected);
}

/// `exec_command` with the refinement its schema cannot express.
struct ExecCommand;

#[derive(Deserialize)]
struct ExecArgs {
    cmd: Option<String>,
    cmds: Option<Vec<String>>,
}

impl Tool for ExecCommand {
    type Args = ExecArgs;
    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "exec_command",
        listing: Listing::Capability(Capability::Command),
        requires: Requirement::Capability(Capability::Command),
    };

    fn refine(args: &ExecArgs) -> Result<(), Vec<ArgIssue>> {
        if args.cmd.is_some() == args.cmds.is_some() {
            return Err(vec![ArgIssue::new(
                "",
                "exec_command requires exactly one of cmd or cmds",
            )]);
        }
        Ok(())
    }

    async fn call(&self, _cx: &CallContext, _args: ExecArgs) -> Result<ToolOutput, ToolError> {
        Ok(ToolResult::text("ran").into())
    }
}

/// `read` with an integer argument, to show `2.0` arrives as the integer 2.
struct Read;

#[derive(Deserialize)]
struct ReadArgs {
    max_bytes: Option<u32>,
}

impl Tool for Read {
    type Args = ReadArgs;
    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "read",
        listing: Listing::AnyCapability(&[Capability::Read]),
        requires: Requirement::None,
    };

    async fn call(&self, _cx: &CallContext, args: ReadArgs) -> Result<ToolOutput, ToolError> {
        Ok(ToolResult::text(format!("max {:?}", args.max_bytes)).into())
    }
}

/// Code mode: runs the nested call named in its code.
struct CodeMode;

#[derive(Deserialize)]
struct CodeArgs {
    code: String,
}

impl Tool for CodeMode {
    type Args = CodeArgs;
    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "exec",
        listing: Listing::WithOtherTools,
        requires: Requirement::None,
    };

    async fn call(&self, cx: &CallContext, args: CodeArgs) -> Result<ToolOutput, ToolError> {
        let (tool, arguments) = args.code.split_once(' ').unwrap_or((&args.code, "{}"));
        let arguments: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
        match cx.nested_invoker().invoke(tool.to_owned(), arguments).await {
            Ok(result) => Ok(result.into()),
            Err(UnknownTool(name)) => Err(ToolError::Refused(format!("no {name}"))),
        }
    }
}

fn typed_kernel(
    records: Arc<Records>,
) -> (
    Arc<Kernel>,
    cos_tools::AdmissionGate,
    support::Dirs,
    watch::Sender<Arc<cos_types::config::Config>>,
) {
    let mut tools = SurfaceTools::default();
    tools
        .add(SurfaceId::Core, Arc::new(Read))
        .add(SurfaceId::Core, Arc::new(ExecCommand))
        .add(SurfaceId::Core, Arc::new(CodeMode));
    let parts = kernel_with(tools, Arc::new(Unattributed), records);
    parts.1.advance(Phase::Serving);
    parts
}

#[tokio::test]
async fn a_tool_refinement_is_worded_as_a_schema_error_before_anything_runs() {
    let records = Arc::new(Records::default());
    let (kernel, _gate, _dirs, _config) = typed_kernel(records.clone());
    let both = kernel
        .call(
            SurfaceId::Core,
            "exec_command",
            json!({"cmd": "a", "cmds": ["b"]}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert_eq!(
        texts(&both),
        [
            "Input validation error: Invalid arguments for tool exec_command: exec_command requires exactly one of cmd or cmds"
        ]
    );
    let typed = kernel
        .call(
            SurfaceId::Core,
            "exec_command",
            json!({"cmd": 5}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert_eq!(
        texts(&typed),
        [
            "Input validation error: Invalid arguments for tool exec_command: cmd: Invalid input: expected string, received number"
        ],
        "a refinement does not run after a type error"
    );
    assert!(records.0.lock().expect("records").is_empty());
}

#[tokio::test]
async fn integral_numbers_reach_integer_arguments() {
    let (kernel, _gate, _dirs, _config) = typed_kernel(Arc::new(Records::default()));
    let result = kernel
        .call(
            SurfaceId::Core,
            "read",
            json!({"paths": ["/p"], "max_bytes": 1024.0}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert_eq!(texts(&result)[0], "max Some(1024)");
}

#[tokio::test]
async fn nested_calls_recheck_arguments_record_separately_and_carry_no_notice() {
    let records = Arc::new(Records::default());
    let (kernel, _gate, _dirs, _config) = typed_kernel(records.clone());
    let run = |code: &str| {
        let kernel = kernel.clone();
        let code = code.to_owned();
        async move {
            let result = kernel
                .call(
                    SurfaceId::Core,
                    "exec",
                    json!({ "code": code }),
                    Inbound::default(),
                )
                .await
                .expect("listed");
            texts(&result)
        }
    };

    let child = run(r#"read {"paths":["/p"],"max_bytes":7}"#).await;
    assert_eq!(child[0], "max Some(7)");
    assert!(
        child[1].starts_with(NOTICE_OFF),
        "the outer result gets the notice once"
    );
    assert_eq!(child.len(), 2);

    let invalid = run(r#"read {"paths":"x"}"#).await;
    assert_eq!(
        invalid[0],
        "INVALID_ARGUMENTS: paths: Invalid input: expected array, received string"
    );

    let lifecycle = run("exec {}").await;
    assert_eq!(
        lifecycle[0],
        "DIRECT_CALL_REQUIRED: call this lifecycle tool directly, outside exec. No action was taken."
    );
    assert_eq!(run("no_such_tool {}").await[0], "no no_such_tool");

    let records = records.0.lock().expect("records").clone();
    let filed: Vec<(&str, bool)> = records.iter().map(|record| (record.0, record.1)).collect();
    assert_eq!(
        filed,
        [
            ("read", true),
            ("exec", false),
            ("read", true),
            ("exec", false),
            ("exec", true),
            ("exec", false),
            ("exec", false)
        ]
    );
    assert_eq!(
        records[2].2,
        ToolOutcome::ToolRejected,
        "a nested schema refusal is a recorded rejection"
    );
    assert_eq!(
        texts_of(&records[0].3),
        ["max Some(7)"],
        "the child record has no notice"
    );
}

fn texts_of(result: &Value) -> Vec<String> {
    result["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part["text"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn calls_wait_for_restore_and_are_refused_once_draining() {
    let fixture = Fixture::new(
        "restoring",
        &base_config(),
        Options {
            serving: false,
            ..Options::default()
        },
    );
    fixture.answer(ok("after restore"));
    let kernel = fixture.kernel.clone();
    let waiting = tokio::spawn(async move {
        kernel
            .call(
                SurfaceId::Core,
                "view_image",
                json!({"path": "/x"}),
                Inbound::default(),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!waiting.is_finished(), "ran before restore finished");
    assert_eq!(
        fixture.kernel.list(SurfaceId::Core).len(),
        8,
        "discovery does not wait"
    );
    fixture.gate.advance(Phase::Serving);
    let result = waiting.await.expect("joins").expect("listed");
    assert_eq!(texts(&result)[0], "after restore");

    fixture.gate.advance(Phase::Draining);
    let refused = fixture
        .kernel
        .call(
            SurfaceId::Core,
            "view_image",
            json!({"path": "/x"}),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert!(refused.is_error);
    assert!(texts(&refused)[0].starts_with("SERVER_STOPPING"));
}

/// A tool that waits until the test lets it finish.
struct Held(Arc<Notify>);

impl Tool for Held {
    type Args = PathArgs;
    const SPEC: &'static ToolSpec = ViewImage::SPEC;

    async fn call(&self, _cx: &CallContext, _args: PathArgs) -> Result<ToolOutput, ToolError> {
        self.0.notified().await;
        Ok(ToolResult::text("released").into())
    }
}

/// A recorder that waits until the test lets it finish.
struct HeldRecorder(Arc<Notify>);

impl CallRecorder for HeldRecorder {
    fn record<'a>(&'a self, _call: CallRecord<'a>) -> BoxFuture<'a, ()> {
        Box::pin(async move { self.0.notified().await })
    }
}

#[tokio::test]
async fn counters_follow_a_call_from_handler_to_recorder_to_answer() {
    let handler = Arc::new(Notify::new());
    let recorder = Arc::new(Notify::new());
    let mut tools = SurfaceTools::default();
    tools.add(SurfaceId::Core, Arc::new(Held(handler.clone())));
    let (kernel, gate, _dirs, _config) = kernel_with(
        tools,
        Arc::new(Unattributed),
        Arc::new(HeldRecorder(recorder.clone())),
    );
    gate.advance(Phase::Serving);

    let request = kernel.begin_request(SurfaceId::Core);
    assert!(kernel.last_request_at(SurfaceId::Core).is_some());
    let call = tokio::spawn({
        let kernel = kernel.clone();
        async move {
            kernel
                .call(
                    SurfaceId::Core,
                    "view_image",
                    json!({"path": "/x"}),
                    Inbound::default(),
                )
                .await
        }
    });
    let settle = || tokio::time::sleep(Duration::from_millis(20));
    settle().await;
    let counts = kernel.counts();
    assert_eq!(
        (
            counts.running,
            counts.settling,
            counts.in_flight,
            counts.in_flight_mcp_requests
        ),
        (1, 0, 1, 1)
    );

    handler.notify_one();
    settle().await;
    let counts = kernel.counts();
    assert_eq!(
        (counts.running, counts.settling, counts.in_flight),
        (0, 1, 1)
    );
    assert!(!call.is_finished(), "the answer waits for the recorder");

    recorder.notify_one();
    let result = call.await.expect("joins").expect("listed");
    assert_eq!(texts(&result)[0], "released");
    drop(request);
    assert_eq!(kernel.counts(), cos_tools::CallCounts::default());

    kernel.begin_generation();
    assert_eq!(kernel.last_request_at(SurfaceId::Core), None);
    assert_eq!(kernel.last_tool_call_at(SurfaceId::Core), None);
}

// ------------------------------------------------------------------ server info

#[test]
fn every_surface_reports_its_server_name_and_the_app_version() {
    let fixture = base();
    let names: Vec<&str> = [SurfaceId::Core, SurfaceId::Desktop, SurfaceId::Plugins]
        .map(|surface| fixture.kernel.server_info(surface).name)
        .into();
    assert_eq!(
        names,
        [
            "chat-on-steroids-core",
            "chat-on-steroids-desktop",
            "chat-on-steroids-plugins"
        ]
    );
    assert_eq!(
        fixture.kernel.server_info(SurfaceId::Core).version,
        "2.1.35"
    );
}

#[test]
fn the_users_own_instructions_close_every_described_surface_trimmed_and_capped() {
    let mut config = base_config();
    config["mcp"] = json!({ "instructions": format!("  Prefer pnpm.{}  ", "x".repeat(5000)) });
    let fixture = Fixture::new("user-instructions", &config, Options::default());
    for surface in [SurfaceId::Core, SurfaceId::Desktop] {
        let text = fixture.kernel.server_info(surface).instructions;
        let (_, tail) = text
            .split_once("\n\nThe user's own standing instructions for this connector:\n")
            .expect("fenced under its heading");
        assert!(tail.starts_with("Prefer pnpm."), "trimmed");
        assert!(tail.encode_utf16().count() <= 4000, "capped");
    }
    let plain = base().kernel.server_info(SurfaceId::Core).instructions;
    assert!(
        !plain.contains("standing instructions"),
        "empty adds nothing, not even the heading"
    );
}

#[test]
fn connector_names_carry_this_computers_suffix() {
    let mut config = base_config();
    config["connectorSuffix"] = json!("Work PC");
    let fixture = Fixture::new("suffix", &config, Options::default());
    let text = fixture.kernel.server_info(SurfaceId::Desktop).instructions;
    assert!(
        text.contains("\"Chat On Steroids Core (Work PC)\""),
        "{}",
        &text[text.len() - 300..]
    );
}

#[test]
fn linux_routes_desktop_users_to_core_without_native_tools() {
    let fixture = Fixture::new(
        "linux",
        &base_config(),
        Options {
            platform: Platform::Linux,
            ..Options::default()
        },
    );
    let desktop = fixture.kernel.server_info(SurfaceId::Desktop).instructions;
    assert!(desktop.contains("Files, patches and shell commands live in the separate \"Chat On Steroids Core\" connector."));
    assert!(!desktop.contains("Windows Computer Use"));
    let core = fixture.kernel.server_info(SurfaceId::Core).instructions;
    assert!(core.contains("Host: Linux."));
    assert!(core.contains("for background browser tabs, DOM, console, screenshots and input; "));
    assert!(core.contains("exec_command uses the host’s normal POSIX shell"));
}

#[test]
fn a_command_policy_is_explained_beside_the_command_tools() {
    let mut config = base_config();
    config["commandAllowlist"] = json!({ "enabled": true, "mode": "deny", "rules": [] });
    let fixture = Fixture::new("policy", &config, Options::default());
    let text = fixture.kernel.server_info(SurfaceId::Core).instructions;
    assert!(
        text.contains("Command launch policy is enabled in denylist mode."),
        "policy line"
    );
}

#[test]
fn every_tool_the_tool_crates_declare_has_exactly_one_recorded_declaration() {
    let mut tools = SurfaceTools::default();
    for surface in [SurfaceId::Core, SurfaceId::Desktop, SurfaceId::Plugins] {
        for spec in support::specs(surface) {
            tools.add(
                surface,
                Arc::new(support::Stand {
                    spec,
                    answer: Arc::default(),
                    calls: Arc::default(),
                    nested: Arc::default(),
                }),
            );
        }
    }
    assert_eq!(tools.undeclared(), []);
    struct Plugin;
    impl Tool for Plugin {
        type Args = Value;
        const SPEC: &'static ToolSpec = &ToolSpec {
            name: "blender_render",
            listing: Listing::Capability(Capability::Read),
            requires: Requirement::None,
        };
        async fn call(&self, _cx: &CallContext, _args: Value) -> Result<ToolOutput, ToolError> {
            Ok(ToolResult::text("").into())
        }
    }
    tools.add(SurfaceId::Plugins, Arc::new(Plugin));
    assert_eq!(tools.undeclared(), [(SurfaceId::Plugins, "blender_render")]);
}

#[test]
fn connectors_carry_the_suffix_and_name_shared_tunnel_ids() {
    let mut config = cos_store::config::parse_config(&base_config()).expect("config");
    let plain = Connectors::from_config(&config);
    assert_eq!(plain.name(SurfaceId::Plugins), "Chat On Steroids Plugins");
    assert!(
        plain.sharing_tunnel(SurfaceId::Core).is_empty(),
        "empty IDs share nothing"
    );

    config.connector_suffix = Some(" Work \t PC ".to_owned());
    config.tunnel.tunnel_id = "tunnel_a ".to_owned();
    config.tunnel.desktop_tunnel_id = "tunnel_b".to_owned();
    config.tunnel.plugins_tunnel_id = Some(" tunnel_a".to_owned());
    let connectors = Connectors::from_config(&config);
    assert_eq!(
        connectors.name(SurfaceId::Desktop),
        "Chat On Steroids Desktop (Work PC)"
    );
    assert_eq!(
        connectors.sharing_tunnel(SurfaceId::Core),
        [SurfaceId::Plugins]
    );
    assert_eq!(
        connectors.sharing_tunnel(SurfaceId::Plugins),
        [SurfaceId::Core]
    );
    assert!(connectors.sharing_tunnel(SurfaceId::Desktop).is_empty());

    config.connector_suffix = Some("bad/suffix".to_owned());
    assert_eq!(
        Connectors::from_config(&config).name(SurfaceId::Core),
        "Chat On Steroids Core"
    );
}

/// Code mode that keeps its call's nested invoker and answers at once, as a script that does
/// not await its child does.
struct Detaching(Arc<std::sync::Mutex<Option<NestedInvoker>>>);

impl Tool for Detaching {
    type Args = CodeArgs;
    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "exec",
        listing: Listing::WithOtherTools,
        requires: Requirement::None,
    };

    async fn call(&self, cx: &CallContext, _args: CodeArgs) -> Result<ToolOutput, ToolError> {
        *self.0.lock().expect("slot") = Some(cx.nested_invoker());
        Ok(ToolResult::text("answered").into())
    }
}

#[tokio::test]
async fn a_nested_invoker_runs_children_after_its_parent_answered() {
    let records = Arc::new(Records::default());
    let slot = Arc::default();
    let mut tools = SurfaceTools::default();
    tools
        .add(SurfaceId::Core, Arc::new(Read))
        .add(SurfaceId::Core, Arc::new(Detaching(Arc::clone(&slot))));
    let (kernel, gate, _dirs, _config) =
        kernel_with(tools, Arc::new(Unattributed), records.clone());
    gate.advance(Phase::Serving);
    let parent = kernel
        .call(
            SurfaceId::Core,
            "exec",
            json!({ "code": "tools.read({})" }),
            Inbound {
                request_id: RequestId::from_header("wfr_parent/1"),
                setup_profile_id: None,
            },
        )
        .await
        .expect("listed");
    assert_eq!(texts(&parent)[0], "answered");

    let invoker = slot.lock().expect("slot").take().expect("kept");
    let child =
        tokio::spawn(invoker.invoke("read".to_owned(), json!({"paths": ["/p"], "max_bytes": 3})))
            .await
            .expect("the child runs on its own task")
            .expect("listed");
    assert_eq!(texts(&child), ["max Some(3)"], "a child carries no notice");
    let filed: Vec<(&str, bool)> = records
        .0
        .lock()
        .expect("records")
        .iter()
        .map(|record| (record.0, record.1))
        .collect();
    assert_eq!(filed, [("exec", false), ("read", true)]);
}

// ------------------------------------------------------------------ chat policy

/// A block the test switches on, as the user pressing Block does.
struct Switch(Arc<std::sync::atomic::AtomicBool>);

impl ChatPolicy for Switch {
    fn needs_proof(&self) -> bool {
        true
    }

    fn refusal(&self, caller: &Caller) -> Option<String> {
        (caller.is_attributed() && self.0.load(std::sync::atomic::Ordering::SeqCst))
            .then(|| "CHAT_BLOCKED: stop".to_owned())
    }
}

/// `read` that blocks its own chat while it runs.
struct BlockingRead(Arc<std::sync::atomic::AtomicBool>);

impl Tool for BlockingRead {
    type Args = ReadArgs;
    const SPEC: &'static ToolSpec = Read::SPEC;

    async fn call(&self, _cx: &CallContext, _args: ReadArgs) -> Result<ToolOutput, ToolError> {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(ToolResult::text("read").into())
    }
}

/// Code mode running two reads one after the other.
struct TwoReads;

impl Tool for TwoReads {
    type Args = CodeArgs;
    const SPEC: &'static ToolSpec = CodeMode::SPEC;

    async fn call(&self, cx: &CallContext, _args: CodeArgs) -> Result<ToolOutput, ToolError> {
        let invoker = cx.nested_invoker();
        let mut texts = Vec::new();
        for _ in 0..2 {
            let child = invoker
                .invoke("read".to_owned(), json!({ "paths": ["/p"] }))
                .await
                .map_err(|UnknownTool(name)| ToolError::Internal(name))?;
            texts.extend(self::texts(&child));
        }
        Ok(ToolResult::text(texts.join(" | ")).into())
    }
}

#[tokio::test]
async fn a_chat_policy_refusal_is_a_recorded_rejection_and_nothing_runs() {
    let blocked = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let mut tools = SurfaceTools::default();
    tools.add(SurfaceId::Core, Arc::new(BlockingRead(blocked.clone())));
    let records = Arc::new(Records::default());
    let (kernel, gate, _dirs, _config) = policed_kernel(
        tools,
        Arc::new(Proven),
        records.clone(),
        Arc::new(Switch(blocked.clone())),
    );
    gate.advance(Phase::Serving);
    blocked.store(true, std::sync::atomic::Ordering::SeqCst);
    let result = kernel
        .call(
            SurfaceId::Core,
            "read",
            json!({ "paths": ["/p"] }),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert!(result.is_error);
    assert_eq!(texts(&result), ["CHAT_BLOCKED: stop"]);
    let recorded = records.0.lock().expect("records");
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].2, ToolOutcome::ToolRejected);
}

#[tokio::test]
async fn a_block_during_a_script_refuses_its_next_nested_call() {
    let blocked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut tools = SurfaceTools::default();
    tools
        .add(SurfaceId::Core, Arc::new(BlockingRead(blocked.clone())))
        .add(SurfaceId::Core, Arc::new(TwoReads));
    let (kernel, gate, _dirs, _config) = policed_kernel(
        tools,
        Arc::new(Proven),
        Arc::new(Records::default()),
        Arc::new(Switch(blocked)),
    );
    gate.advance(Phase::Serving);
    let result = kernel
        .call(
            SurfaceId::Core,
            "exec",
            json!({ "code": "two reads" }),
            Inbound::default(),
        )
        .await
        .expect("listed");
    assert_eq!(texts(&result), ["read | CHAT_BLOCKED: stop"]);
}
