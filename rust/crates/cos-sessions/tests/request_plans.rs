//! The corpus's `update_plan` calls through the kernel, as a transport sends them: the
//! arguments and the `x-request-id` header the recorder captured. Each answer must be the
//! recorded one, and a plan held for a request must reach `state/request-plans.json`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cos_sessions::{ListQuery, SessionStore};
use cos_store::{AppPaths, ConfigStore, Logger, Platform};
use cos_tools::{
    Admission, AdmissionGate, GrantEnv, Inbound, Kernel, KernelDeps, Phase, RequestId, SurfaceId,
    SurfaceTools, Unattributed,
};
use serde_json::{Value, json};
use tokio::sync::watch;

const APP_VERSION: &str = "2.1.35";

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).expect("file")).expect("json")
}

fn variant(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../golden")
        .join(name)
}

/// One profile and one kernel serving only `update_plan`, configured as a corpus variant.
struct Run {
    dir: PathBuf,
    paths: AppPaths,
    sessions: SessionStore,
    kernel: Arc<Kernel>,
    _gate: AdmissionGate,
}

impl Run {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("cos-sessions-plans-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let project = dir.join("project");
        let profile = dir.join("profile");
        std::fs::create_dir_all(&project).expect("project");
        std::fs::create_dir_all(&profile).expect("profile");
        let recorded = read_json(&variant(name).join("config.json"))["config"].to_string();
        let text = recorded.replace(
            "<PROJECT>",
            &project.to_string_lossy().replace('\\', "\\\\"),
        );
        std::fs::write(profile.join("config.json"), text).expect("config");
        let config = ConfigStore::new(
            profile.join("config.json"),
            Platform::Windows,
            Logger::new(),
        )
        .load(APP_VERSION);

        let paths = AppPaths::at(&profile);
        let sessions = SessionStore::open(&paths, Logger::new());
        let (gate, admission) = Admission::channel();
        gate.advance(Phase::Serving);
        let mut tools = SurfaceTools::default();
        tools.add(SurfaceId::Core, sessions.plan_tool());
        let kernel = Kernel::new(KernelDeps {
            app_version: APP_VERSION,
            config: watch::channel(Arc::new(config)).1,
            env: GrantEnv {
                skills_dir: profile.join("skills"),
                platform: Platform::Windows,
            },
            tools,
            attribution: Arc::new(Unattributed),
            chat_policy: Arc::new(cos_tools::AnyChat),
            recorder: sessions.recorder(),
            admission,
            logger: Logger::new(),
        });
        Self {
            dir,
            paths,
            sessions,
            kernel,
            _gate: gate,
        }
    }

    /// Sends one recorded case and checks the answer against the recorded one.
    async fn replay(&self, case: &Path) {
        let case = read_json(case);
        let request = &case["request"];
        let inbound = Inbound {
            request_id: request["headers"]["x-request-id"]
                .as_str()
                .and_then(RequestId::from_header),
            setup_profile_id: None,
        };
        let result = self
            .kernel
            .call(
                SurfaceId::Core,
                "update_plan",
                request["arguments"].clone(),
                inbound,
            )
            .await
            .expect("update_plan is listed");
        assert_eq!(
            serde_json::to_value(&result).expect("result"),
            case["response"]["messages"][0]["result"],
            "{}",
            case["case"]
        );
    }

    fn held_plans(&self) -> Value {
        read_json(&self.paths.state().join("request-plans.json"))["entries"].clone()
    }

    /// The `tool_call` records of the only session.
    async fn filed(&self) -> Vec<Value> {
        self.sessions.flush_recorder().await;
        let list = self
            .sessions
            .list(ListQuery {
                limit: 20,
                cursor: None,
                live: false,
            })
            .await;
        assert_eq!(list.sessions.len(), 1, "one Unattributed session");
        let journal = std::fs::read_to_string(
            self.paths
                .user_data()
                .join("sessions")
                .join(&list.sessions[0].session.id)
                .join("events.jsonl"),
        )
        .expect("journal");
        journal
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("event"))
            .filter(|event| event["kind"] == "tool_call")
            .map(|event| event["call"].clone())
            .collect()
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn unattributed_plan_calls_answer_as_recorded_and_hold_the_plan_for_their_request() {
    let run = Run::new("unattributed");
    let calls = variant("unattributed").join("mcp/core/calls");

    run.replay(&calls.join("01-plan-set.json")).await;
    let set = run.held_plans();
    for refused in [
        "02-plan-two-in-progress.json",
        "03-plan-too-many.json",
        "04-plan-bad-status.json",
    ] {
        run.replay(&calls.join(refused)).await;
    }
    assert_eq!(run.held_plans(), set, "a refused update changes nothing");
    run.replay(&calls.join("05-plan-clear.json")).await;
    let cleared = run.held_plans();

    for entries in [&set, &cleared] {
        assert_eq!(entries.as_array().map(Vec::len), Some(1), "{entries}");
        assert_eq!(entries[0]["requestId"], "golden-request-1");
    }
    assert_eq!(
        set[0]["update"],
        json!({ "explanation": "golden", "plan": [
            { "step": "First", "status": "completed", "details": "done" },
            { "step": "Second", "status": "in_progress" },
            { "step": "Third", "status": "pending" }
        ] })
    );
    assert_eq!(cleared[0]["update"], json!({ "plan": [] }));

    let filed = run.filed().await;
    assert_eq!(filed.len(), 2, "schema refusals are not recorded");
    for call in &filed {
        assert_eq!(
            (&call["tool"], &call["requestId"], &call["attribution"]),
            (
                &json!("update_plan"),
                &json!("golden-request-1"),
                &json!("unattributed")
            )
        );
    }
}

#[tokio::test]
async fn base_plan_calls_answer_as_recorded() {
    let run = Run::new("base");
    let calls = variant("base").join("mcp/core/calls");
    for name in [
        "79-plan-set.json",
        "80-plan-two-in-progress.json",
        "81-plan-too-many.json",
        "82-plan-bad-status.json",
        "83-plan-clear.json",
    ] {
        run.replay(&calls.join(name)).await;
    }
    assert_eq!(run.filed().await.len(), 2, "the two identity refusals");
}
