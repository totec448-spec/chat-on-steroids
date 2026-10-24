//! The blocked-chat gate and the strict chat allowlist through the real kernel, with the cases
//! of the blocked-chat and strict-mode block in `test/mcp.test.ts`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cos_sessions::{
    BLOCKED_CHAT_REFUSAL, BlockedChatsLedger, ChatAccess, STRICT_CHAT_REFUSAL, SessionStore,
    TrustedChatsLedger,
};
use cos_store::{AppPaths, ConfigStore, DurableStore, Logger, Platform};
use cos_tools::{
    Admission, AdmissionGate, Attribution, BoxFuture, CallContext, Caller, Capability, Content,
    DynTool, EpochMs, GrantEnv, Inbound, Kernel, KernelDeps, Listing, Phase, RequestId,
    Requirement, SurfaceId, SurfaceTools, ToolError, ToolOutput, ToolResult, ToolSpec,
};
use cos_types::config::Config;
use cos_types::ids::{ConversationId, SessionId};
use serde_json::{Value, json};
use tokio::sync::watch;

const APP_VERSION: &str = "2.1.35";
const ROGUE: &str = "f0f00001-1111-4111-8111-111111111111";
const BYSTANDER: &str = "f0f00002-1111-4111-8111-111111111111";
const ANSWER: &str = "read /workspace/notes.txt";

/// A tool that only counts that it ran.
struct Stand {
    spec: &'static ToolSpec,
    runs: Arc<AtomicUsize>,
}

impl DynTool for Stand {
    fn spec(&self) -> &'static ToolSpec {
        self.spec
    }

    fn call_json<'a>(
        &'a self,
        _cx: &'a CallContext,
        _args: Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(ToolResult::text(ANSWER).into()) })
    }
}

const READ_ANY: &[Capability] = &[Capability::Read, Capability::Browse, Capability::Metadata];
const WRITE_ANY: &[Capability] = &[
    Capability::Create,
    Capability::Edit,
    Capability::Move,
    Capability::DeleteFile,
];
const SPECS: [&ToolSpec; 3] = [
    &ToolSpec {
        name: "read",
        listing: Listing::AnyCapability(READ_ANY),
        requires: Requirement::None,
    },
    &ToolSpec {
        name: "exec_command",
        listing: Listing::Capability(Capability::Command),
        requires: Requirement::Capability(Capability::Command),
    },
    &ToolSpec {
        name: "apply_patch",
        listing: Listing::AnyCapability(WRITE_ANY),
        requires: Requirement::None,
    },
];

/// What the page has proved: each request id's chat, and how late its proof arrives.
#[derive(Default)]
struct Pages {
    proofs: Mutex<HashMap<String, (Duration, ConversationId, SessionId)>>,
    waits: AtomicUsize,
}

impl Pages {
    fn prove(&self, request: &str, late: Duration, conversation: &str, session: &SessionId) {
        self.proofs.lock().expect("proofs").insert(
            request.to_owned(),
            (
                late,
                ConversationId::parse(conversation).expect("conversation id"),
                session.clone(),
            ),
        );
    }

    fn proof(&self, request_id: Option<&RequestId>) -> Option<(Duration, Caller)> {
        let request_id = request_id?;
        let proofs = self.proofs.lock().expect("proofs");
        let (late, conversation, session) = proofs.get(request_id.as_str())?;
        Some((
            *late,
            Caller {
                request_id: Some(request_id.clone()),
                chat: Some((conversation.clone(), session.clone())),
            },
        ))
    }
}

impl Attribution for Pages {
    fn resolve<'a>(
        &'a self,
        _tool: &'a str,
        _started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller> {
        let caller = match self.proof(request_id) {
            Some((late, caller)) if late.is_zero() => caller,
            _ => Caller::unattributed(request_id.cloned()),
        };
        Box::pin(async move { caller })
    }

    fn resolve_proven<'a>(
        &'a self,
        _tool: &'a str,
        _started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller> {
        self.waits.fetch_add(1, Ordering::SeqCst);
        let proof = self.proof(request_id);
        let unproven = Caller::unattributed(request_id.cloned());
        Box::pin(async move {
            match proof {
                Some((late, caller)) => {
                    tokio::time::sleep(late).await;
                    caller
                }
                None => unproven,
            }
        })
    }
}

struct Run {
    dir: PathBuf,
    sessions: SessionStore,
    blocked: BlockedChatsLedger,
    trusted: TrustedChatsLedger,
    pages: Arc<Pages>,
    config: watch::Sender<Arc<Config>>,
    kernel: Arc<Kernel>,
    runs: Arc<AtomicUsize>,
    _gate: AdmissionGate,
}

fn base_config(dir: &Path) -> Config {
    let recorded = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden/base/config.json");
    let recorded: Value = serde_json::from_slice(&std::fs::read(recorded).expect("corpus config"))
        .expect("corpus json");
    let project = dir.join("project");
    std::fs::create_dir_all(&project).expect("project");
    let text = recorded["config"].to_string().replace(
        "<PROJECT>",
        &project.to_string_lossy().replace('\\', "\\\\"),
    );
    let file = dir.join("profile").join("config.json");
    std::fs::write(&file, text).expect("config");
    ConfigStore::new(file, Platform::Windows, Logger::new()).load(APP_VERSION)
}

impl Run {
    async fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("cos-sessions-access-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("profile")).expect("profile");
        Self::open(dir).await
    }

    /// A fresh process on the profile in `dir`.
    async fn open(dir: PathBuf) -> Self {
        let profile = dir.join("profile");
        let paths = AppPaths::at(&profile);
        let state = DurableStore::new(paths.state(), Logger::new());
        let blocked = BlockedChatsLedger::new(&state);
        let trusted = TrustedChatsLedger::new(&state);
        blocked.restore();
        trusted.restore();
        let sessions = SessionStore::open(&paths, Logger::new());
        sessions.restore().await;
        let (config, receiver) = watch::channel(Arc::new(base_config(&dir)));
        let (gate, admission) = Admission::channel();
        gate.advance(Phase::Serving);
        let runs = Arc::new(AtomicUsize::new(0));
        let mut tools = SurfaceTools::default();
        for spec in SPECS {
            tools.add(
                SurfaceId::Core,
                Arc::new(Stand {
                    spec,
                    runs: runs.clone(),
                }),
            );
        }
        let pages = Arc::new(Pages::default());
        let kernel = Kernel::new(KernelDeps {
            app_version: APP_VERSION,
            config: receiver.clone(),
            env: GrantEnv {
                skills_dir: profile.join("skills"),
                platform: Platform::Windows,
            },
            tools,
            attribution: pages.clone(),
            chat_policy: Arc::new(ChatAccess {
                blocked: blocked.clone(),
                trusted: trusted.clone(),
                sessions: sessions.clone(),
                config: receiver,
            }),
            recorder: sessions.recorder(),
            admission,
            logger: Logger::new(),
        });
        Self {
            dir,
            sessions,
            blocked,
            trusted,
            pages,
            config,
            kernel,
            runs,
            _gate: gate,
        }
    }

    fn strict(&self, on: bool) {
        let mut next = (**self.config.borrow()).clone();
        next.multi_agent.strict_chat_allowlist = Some(on);
        self.config.send_replace(Arc::new(next));
    }

    async fn session(&self, conversation: &str) -> SessionId {
        self.sessions
            .create_for_conversation(conversation, None)
            .await
            .expect("session")
            .id
    }

    /// A request id the page proves belongs to `conversation`, `late` after the call arrives.
    async fn owned(&self, request: &str, conversation: &str, late: Duration) -> String {
        let session = match self.sessions.find_by_conversation(conversation, false) {
            Some(summary) => summary.id,
            None => self.session(conversation).await,
        };
        self.pages.prove(request, late, conversation, &session);
        request.to_owned()
    }

    /// Ends this process and starts the next one on the same profile.
    async fn restart(mut self) -> Self {
        self.sessions.flush().await;
        self.blocked.flush();
        self.trusted.flush();
        let dir = std::mem::take(&mut self.dir);
        drop(self);
        Self::open(dir).await
    }

    async fn call(&self, tool: &str, arguments: Value, request: Option<&str>) -> ToolResult {
        self.kernel
            .call(
                SurfaceId::Core,
                tool,
                arguments,
                Inbound {
                    request_id: request.and_then(RequestId::from_header),
                    setup_profile_id: None,
                },
            )
            .await
            .expect("listed")
    }

    async fn read(&self, request: Option<&str>) -> ToolResult {
        self.call(
            "read",
            json!({ "paths": ["/workspace/notes.txt"] }),
            request,
        )
        .await
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        if !self.dir.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

fn first_text(result: &ToolResult) -> &str {
    match result.content.first() {
        Some(Content::Text { text }) => text,
        _ => "",
    }
}

fn refused_with(result: &ToolResult, refusal: &str) {
    assert!(result.is_error, "{result:?}");
    assert_eq!(first_text(result), refusal);
    assert_eq!(
        result.content.len(),
        1,
        "a proven chat gets no identity notice"
    );
}

fn ran(result: &ToolResult) {
    assert!(!result.is_error, "{result:?}");
    assert_eq!(first_text(result), ANSWER);
}

#[tokio::test]
async fn a_blocked_chat_is_told_to_stop_and_no_tool_runs() {
    let run = Run::new("blocked").await;
    let request = run.owned("wfr_rogue_1", ROGUE, Duration::ZERO).await;
    run.blocked.set(&[ROGUE], true).expect("block");

    let reply = run.read(Some(&request)).await;
    refused_with(&reply, BLOCKED_CHAT_REFUSAL);
    for phrase in [
        "no further tool calls",
        "final answer",
        "The user explicitly asked for this",
    ] {
        assert!(first_text(&reply).contains(phrase), "{phrase}");
    }
    assert_eq!(run.runs.load(Ordering::SeqCst), 0, "nothing ran behind it");
}

#[tokio::test]
async fn every_tool_of_a_blocked_chat_is_refused_before_it_runs() {
    let run = Run::new("every-tool").await;
    let request = run.owned("wfr_rogue_2", ROGUE, Duration::ZERO).await;
    run.blocked.set(&[ROGUE], true).expect("block");

    for (tool, arguments) in [
        ("read", json!({ "paths": ["/workspace/notes.txt"] })),
        (
            "exec_command",
            json!({ "cmd": "echo rogue", "workdir": "/workspace" }),
        ),
        (
            "apply_patch",
            json!({ "patch": "*** Begin Patch\n*** End Patch" }),
        ),
    ] {
        let reply = run.call(tool, arguments, Some(&request)).await;
        refused_with(&reply, BLOCKED_CHAT_REFUSAL);
    }
    assert_eq!(run.runs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn another_chat_and_a_call_with_no_proof_are_never_blocked() {
    let run = Run::new("bystander").await;
    run.blocked.set(&[ROGUE], true).expect("block");
    let other = run
        .owned("wfr_bystander_1", BYSTANDER, Duration::ZERO)
        .await;

    ran(&run.read(Some(&other)).await);
    let unproven = run.read(None).await;
    assert!(!unproven.is_error);
    assert_eq!(first_text(&unproven), ANSWER);
}

#[tokio::test]
async fn a_call_proven_late_to_be_the_blocked_chat_is_refused() {
    let run = Run::new("late").await;
    run.blocked.set(&[ROGUE], true).expect("block");
    let request = run
        .owned("wfr_rogue_late", ROGUE, Duration::from_millis(40))
        .await;

    refused_with(&run.read(Some(&request)).await, BLOCKED_CHAT_REFUSAL);
    assert_eq!(run.runs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_call_the_page_never_proves_still_runs() {
    let run = Run::new("never").await;
    run.blocked.set(&[ROGUE], true).expect("block");

    let reply = run.read(Some("wfr_block_never_proven")).await;
    assert!(!reply.is_error);
    assert_eq!(first_text(&reply), ANSWER);
    assert_eq!(
        run.pages.waits.load(Ordering::SeqCst),
        1,
        "it waited for proof"
    );
}

#[tokio::test]
async fn with_no_block_and_strict_mode_off_nothing_waits_for_proof() {
    let run = Run::new("no-wait").await;
    let reply = run.read(Some("wfr_never_proven_unblocked")).await;
    assert!(!reply.is_error);
    assert_eq!(run.pages.waits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_released_chat_gets_its_tools_back_on_the_same_request_id() {
    let run = Run::new("release").await;
    let request = run.owned("wfr_rogue_release", ROGUE, Duration::ZERO).await;
    run.blocked.set(&[ROGUE], true).expect("block");
    refused_with(&run.read(Some(&request)).await, BLOCKED_CHAT_REFUSAL);

    run.blocked.set(&[ROGUE], false).expect("release");
    ran(&run.read(Some(&request)).await);
}

#[tokio::test]
async fn a_block_survives_a_restart() {
    let run = Run::new("restart").await;
    run.blocked.set(&[ROGUE], true).expect("block");

    let next = run.restart().await;
    let request = next.owned("wfr_rogue_restart", ROGUE, Duration::ZERO).await;
    refused_with(&next.read(Some(&request)).await, BLOCKED_CHAT_REFUSAL);
}

#[tokio::test]
async fn strict_mode_refuses_untrusted_and_unattributed_calls_and_admits_the_trusted_chat() {
    let run = Run::new("strict").await;
    run.strict(true);
    let request = run.owned("wfr_strict_1", BYSTANDER, Duration::ZERO).await;

    let untrusted = run.read(Some(&request)).await;
    refused_with(&untrusted, STRICT_CHAT_REFUSAL);
    for phrase in ["chat list", "sidebar", "Trust"] {
        assert!(first_text(&untrusted).contains(phrase), "{phrase}");
    }
    assert!(!first_text(&untrusted).contains("Sessions"));

    let unattributed = run.read(None).await;
    assert!(unattributed.is_error);
    assert_eq!(first_text(&unattributed), STRICT_CHAT_REFUSAL);

    run.trusted.set(&[BYSTANDER], true).await.expect("trust");
    ran(&run.read(Some(&request)).await);
    assert_eq!(run.runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn strict_mode_waits_for_late_proof_and_a_block_wins_over_trust() {
    let run = Run::new("strict-late").await;
    run.strict(true);
    run.trusted.set(&[ROGUE], true).await.expect("trust");
    let late = run
        .owned("wfr_strict_late", ROGUE, Duration::from_millis(40))
        .await;
    ran(&run.read(Some(&late)).await);

    run.blocked.set(&[ROGUE], true).expect("block");
    let now = run.owned("wfr_strict_now", ROGUE, Duration::ZERO).await;
    refused_with(&run.read(Some(&now)).await, BLOCKED_CHAT_REFUSAL);
}

/// Rewrites a flushed session's `meta.json` and reopens the profile, as a later launch sees it.
async fn edit_meta(run: Run, session: &SessionId, edit: impl FnOnce(&mut Value)) -> Run {
    run.sessions.flush().await;
    let meta = run
        .dir
        .join("profile/sessions")
        .join(session.as_str())
        .join("meta.json");
    let mut summary: Value =
        serde_json::from_slice(&std::fs::read(&meta).expect("meta")).expect("json");
    edit(&mut summary);
    std::fs::write(&meta, serde_json::to_vec(&summary).expect("encode")).expect("write");
    run.restart().await
}

#[tokio::test]
async fn an_app_created_worker_stays_refused_even_with_a_trust_entry_of_its_own() {
    let worker = "f0f00003-1111-4111-8111-111111111111";
    let run = Run::new("worker").await;
    let session = run.session(worker).await;
    run.trusted.set(&[worker], true).await.expect("trust");
    let run = edit_meta(run, &session, |summary| {
        summary["origin"] = json!({
            "kind": "worker", "fromSessionId": null, "agentId": "worker-9", "task": "old worker task"
        });
    })
    .await;
    run.strict(true);
    let request = run.owned("wfr_worker_1", worker, Duration::ZERO).await;

    refused_with(&run.read(Some(&request)).await, STRICT_CHAT_REFUSAL);
}

#[tokio::test]
async fn a_committed_resume_successor_inherits_trust_through_its_lineage() {
    let chat_a = "f0f00009-1111-4111-8111-111111111111";
    let chat_b = "f0f00010-1111-4111-8111-111111111111";
    let chat_c = "f0f00012-1111-4111-8111-111111111111";
    let run = Run::new("resume").await;
    let session = run.session(chat_a).await;
    run.trusted.set(&[chat_a], true).await.expect("trust");

    // B before the handoff commits: B is current, but no committed handoff names the lineage.
    let run = edit_meta(run, &session, |summary| {
        summary["conversationId"] = json!(chat_b);
        summary["chatIds"] = json!([chat_a, chat_b]);
    })
    .await;
    run.strict(true);
    let request = run.owned("wfr_resume_b", chat_b, Duration::ZERO).await;
    refused_with(&run.read(Some(&request)).await, STRICT_CHAT_REFUSAL);

    let run = edit_meta(run, &session, |summary| {
        summary["lastCommittedResumeHandoffId"] = json!("handoff-resume-0001");
    })
    .await;
    run.strict(true);
    let request = run.owned("wfr_resume_b2", chat_b, Duration::ZERO).await;
    ran(&run.read(Some(&request)).await);

    // A -> B -> C: C has no Trust bit of its own and still derives it from A.
    let run = edit_meta(run, &session, |summary| {
        summary["conversationId"] = json!(chat_c);
        summary["chatIds"] = json!([chat_a, chat_b, chat_c]);
        summary["lastCommittedResumeHandoffId"] = json!("handoff-resume-chain-0001");
    })
    .await;
    run.strict(true);
    let request = run.owned("wfr_resume_c", chat_c, Duration::ZERO).await;
    ran(&run.read(Some(&request)).await);

    run.trusted.set(&[chat_a], false).await.expect("untrust");
    refused_with(&run.read(Some(&request)).await, STRICT_CHAT_REFUSAL);

    run.trusted.set(&[chat_a], true).await.expect("trust");
    run.blocked.set(&[chat_b], true).expect("block");
    refused_with(&run.read(Some(&request)).await, STRICT_CHAT_REFUSAL);
    run.blocked.set(&[chat_b], false).expect("release");
    run.blocked.set(&[chat_a], true).expect("block");
    refused_with(&run.read(Some(&request)).await, STRICT_CHAT_REFUSAL);
}
