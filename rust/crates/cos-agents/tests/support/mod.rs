//! A kernel serving only `agents` on the `multi-agent` variant's recorded config, with chats
//! the test places by request id, a profile under the temp folder and a stand-in browser that
//! records every tab the broker asks for.

#![allow(dead_code, reason = "each test file uses a different part")]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cos_agents::{
    Agents, AgentsDeps, Broker, Clock, ObservedModel, Policy, WorkerBrowser, WorkerRevival,
    WorkerSpawn,
};
use cos_store::{ConfigStore, DurableStore, Logger, Platform};
use cos_tools::{
    Admission, AdmissionGate, Attribution, BoxFuture, CallRecord, CallRecorder, Caller, EpochMs,
    GrantEnv, Inbound, Kernel, KernelDeps, Phase, RequestId, SurfaceId, SurfaceTools,
};
use cos_types::config::Config;
use cos_types::ids::{ConversationId, SessionId};
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

/// A ChatGPT-shaped conversation id for test chat `n`.
pub fn conversation(n: u32) -> String {
    format!("68f1c2d4-1111-4bbb-8ccc-{n:012}")
}

/// Places each call by the request id the test proved for a chat.
#[derive(Default)]
pub struct Chats(Mutex<HashMap<String, String>>);

impl Attribution for Chats {
    fn resolve<'a>(
        &'a self,
        _tool: &'a str,
        _started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller> {
        let chat = request_id
            .and_then(|id| self.0.lock().unwrap().get(id.as_str()).cloned())
            .map(|conversation| {
                (
                    ConversationId::parse(&conversation).expect("conversation id"),
                    SessionId::parse("2026-01-01-1a2b3c4d").expect("session id"),
                )
            });
        let caller = Caller {
            request_id: request_id.cloned(),
            chat,
        };
        Box::pin(async move { caller })
    }
}

struct Discard;

impl CallRecorder for Discard {
    fn record<'a>(&'a self, _call: CallRecord<'a>) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

/// Every tab the broker asked for, in order.
#[derive(Default)]
pub struct Tabs {
    pub spawns: Mutex<Vec<WorkerSpawn>>,
    pub revivals: Mutex<Vec<WorkerRevival>>,
}

impl WorkerBrowser for Tabs {
    fn bootstrap(&self, workers: Vec<WorkerSpawn>) {
        self.spawns.lock().unwrap().extend(workers);
    }

    fn revive(&self, revivals: Vec<WorkerRevival>) {
        self.revivals.lock().unwrap().extend(revivals);
    }
}

pub struct Served {
    pub kernel: Arc<Kernel>,
    pub agents: Agents,
    pub chats: Arc<Chats>,
    pub tabs: Arc<Tabs>,
    pub config: watch::Sender<Arc<Config>>,
    pub profile: PathBuf,
    pub clock: Arc<AtomicU64>,
    pub models: Arc<Mutex<Vec<ObservedModel>>>,
    requests: AtomicU64,
    _gate: AdmissionGate,
}

impl Served {
    /// The `multi-agent` variant's config, changed by `adjust`.
    pub fn new(label: &str, adjust: impl FnOnce(&mut Config)) -> Self {
        let run = std::env::temp_dir().join(format!("cos-agents-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&run);
        Self::at(run, adjust)
    }

    /// A served Core on an existing run folder, as a restart finds it.
    pub fn at(run: PathBuf, adjust: impl FnOnce(&mut Config)) -> Self {
        let project = run.join("project");
        fs::create_dir_all(&project).expect("project folder");
        fs::create_dir_all(run.join("profile/skills")).expect("profile folder");
        fs::create_dir_all(run.join("profile/state")).expect("state folder");
        let config = read_json(&golden().join("multi-agent/config.json"))["config"].clone();
        let text = serde_json::to_string(&config)
            .expect("config serializes")
            .replace(
                "<PROJECT>",
                &project.to_string_lossy().replace('\\', "\\\\"),
            );
        let file = run.join("profile/config.json");
        fs::write(&file, text).expect("config written");
        let mut config = ConfigStore::new(file, Platform::Windows, Logger::new()).load("2.1.35");
        adjust(&mut config);
        let (sender, receiver) = watch::channel(Arc::new(config));
        let (gate, admission) = Admission::channel();
        gate.advance(Phase::Serving);
        let logger = Logger::with_clock(|| 0, false);
        let clock = Arc::new(AtomicU64::new(1_767_225_600_000));
        let ticking = clock.clone();
        let now: Clock = Arc::new(move || ticking.fetch_add(1, Ordering::SeqCst));
        let tabs = Arc::new(Tabs::default());
        let models: Arc<Mutex<Vec<ObservedModel>>> = Arc::default();
        let observed = models.clone();
        let agents = Agents::new(AgentsDeps {
            state: &DurableStore::new(run.join("profile/state"), logger.clone()),
            config: receiver.clone(),
            logger: logger.clone(),
            clock: now,
            browser: tabs.clone(),
            models: Arc::new(move || observed.lock().unwrap().clone()),
        });
        let mut tools = SurfaceTools::default();
        tools.add(SurfaceId::Core, agents.tool());
        let chats = Arc::new(Chats::default());
        let env = GrantEnv {
            skills_dir: run.join("profile/skills"),
            platform: Platform::Windows,
        };
        let kernel = Kernel::new(KernelDeps {
            app_version: "2.1.35",
            config: receiver,
            env,
            tools,
            attribution: chats.clone(),
            chat_policy: Arc::new(cos_tools::AnyChat),
            recorder: Arc::new(Discard),
            admission,
            logger,
        });
        Self {
            kernel,
            agents,
            chats,
            tabs,
            config: sender,
            profile: run.join("profile"),
            clock,
            models,
            requests: AtomicU64::new(0),
            _gate: gate,
        }
    }

    pub fn configure(&self, adjust: impl FnOnce(&mut Config)) {
        let mut config = (**self.config.borrow()).clone();
        adjust(&mut config);
        self.config.send_replace(Arc::new(config));
    }

    /// `tools/call agents` from no chat at all.
    pub async fn call(&self, arguments: Value) -> Value {
        self.call_from(None, arguments).await
    }

    /// `tools/call agents` from `conversation`, proved by a fresh request id.
    pub async fn call_from(&self, conversation: Option<&str>, arguments: Value) -> Value {
        let id = format!("wfr_{}", self.requests.fetch_add(1, Ordering::SeqCst));
        if let Some(conversation) = conversation {
            self.chats
                .0
                .lock()
                .unwrap()
                .insert(id.clone(), conversation.to_owned());
        }
        let inbound = Inbound {
            request_id: RequestId::from_header(&id),
            setup_profile_id: None,
        };
        let result = self
            .kernel
            .call(SurfaceId::Core, "agents", arguments, inbound)
            .await
            .unwrap_or_else(|unknown| panic!("Tool {} not found", unknown.0));
        serde_json::to_value(result).expect("result serializes")
    }

    /// The text of a result's first content item.
    pub fn text(result: &Value) -> String {
        result["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    pub async fn broker<T>(&self, op: impl FnOnce(&mut Broker, &Policy, u64) -> T) -> T {
        self.agents.update(op).await
    }

    pub fn swarm_file(&self) -> Option<Value> {
        let path = self.profile.join("state/swarm.json");
        fs::read_to_string(path)
            .ok()
            .map(|text| serde_json::from_str(&text).expect("swarm.json parses"))
    }
}
