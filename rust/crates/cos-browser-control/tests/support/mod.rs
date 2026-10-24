//! A kernel serving the browser tools on the `desktop` variant's recorded config, a chat proof
//! the test controls, and a stand-in browser that claims commands through the broker.

#![allow(dead_code, reason = "each test file uses a different part")]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use cos_browser_control::{BrowserControl, BrowserControlDeps, Chat, ChatProof};
use cos_store::{ConfigStore, Logger, Platform};
use cos_tools::{
    Admission, AdmissionGate, Attribution, BoxFuture, CallRecord, CallRecorder, Caller, EpochMs,
    GrantEnv, Inbound, Kernel, KernelDeps, Phase, RequestId, SurfaceId, SurfaceTools,
};
use cos_types::config::Config;
use cos_types::ids::{ConversationId, SessionId};
use cos_types::mcp::{BrowserCommand, BrowserResult};
use serde_json::Value;
use tokio::sync::watch;

pub const BROWSER: &str = "11111111-1111-4111-8111-111111111111";

pub fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden")
}

pub fn read_json(path: &Path) -> Value {
    let text =
        fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

pub fn chat(conversation: &str, session: &str) -> Chat {
    Chat {
        conversation: ConversationId::parse(conversation).expect("conversation id"),
        session: SessionId::parse(session).expect("session id"),
    }
}

/// Request ids a page has proved, and the chats that may still act.
#[derive(Default)]
pub struct Proofs {
    pub proven: Mutex<HashMap<String, Chat>>,
    pub dead: Mutex<Vec<Chat>>,
}

impl ChatProof for Proofs {
    fn proven(&self, request_id: &str) -> Option<Chat> {
        self.proven.lock().unwrap().get(request_id).cloned()
    }

    fn live<'a>(&'a self, chat: &'a Chat) -> BoxFuture<'a, bool> {
        let live = !self.dead.lock().unwrap().contains(chat);
        Box::pin(async move { live })
    }
}

/// Places a call by the ids proved when it is made, like the recorder's attribution port.
struct AtCall(Arc<Proofs>);

impl Attribution for AtCall {
    fn resolve<'a>(
        &'a self,
        _tool: &'a str,
        _started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller> {
        let chat = request_id
            .and_then(|id| self.0.proven(id.as_str()))
            .map(|chat| (chat.conversation, chat.session));
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

pub struct Served {
    pub kernel: Arc<Kernel>,
    pub control: BrowserControl,
    pub proofs: Arc<Proofs>,
    pub config: watch::Sender<Arc<Config>>,
    run: PathBuf,
    _gate: AdmissionGate,
}

impl Served {
    /// The `desktop` variant's config, changed by `adjust`, serving only the browser tools.
    pub fn new(label: &str, adjust: impl FnOnce(&mut Config)) -> Self {
        let run = std::env::temp_dir().join(format!("cos-browser-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&run);
        let project = run.join("project");
        fs::create_dir_all(&project).expect("project folder");
        fs::create_dir_all(run.join("profile/skills")).expect("profile folder");
        let config = read_json(&golden().join("desktop/config.json"))["config"].clone();
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
        let env = || GrantEnv {
            skills_dir: run.join("profile/skills"),
            platform: Platform::Windows,
        };
        let proofs = Arc::new(Proofs::default());
        let control = BrowserControl::new(BrowserControlDeps {
            config: receiver.clone(),
            env: env(),
            proof: proofs.clone(),
            wake: Arc::new(|| {}),
        });
        let mut tools = SurfaceTools::default();
        for tool in cos_browser_control::tools(&control) {
            tools.add(SurfaceId::Desktop, tool);
        }
        let kernel = Kernel::new(KernelDeps {
            app_version: "2.1.35",
            config: receiver,
            env: env(),
            tools,
            attribution: Arc::new(AtCall(proofs.clone())),
            chat_policy: Arc::new(cos_tools::AnyChat),
            recorder: Arc::new(Discard),
            admission,
            logger: Logger::with_clock(|| 0, false),
        });
        Self {
            kernel,
            control,
            proofs,
            config: sender,
            run,
            _gate: gate,
        }
    }

    /// Changes the live config.
    pub fn configure(&self, adjust: impl FnOnce(&mut Config)) {
        let mut config = (**self.config.borrow()).clone();
        adjust(&mut config);
        self.config.send_replace(Arc::new(config));
    }

    /// `tools/call` on Desktop: the result as JSON, or the `-32602` message.
    pub async fn call(&self, tool: &str, arguments: Value) -> Result<Value, String> {
        self.call_as(tool, arguments, None).await
    }

    pub async fn call_as(
        &self,
        tool: &str,
        arguments: Value,
        request_id: Option<&str>,
    ) -> Result<Value, String> {
        let inbound = Inbound {
            request_id: request_id.and_then(RequestId::from_header),
            setup_profile_id: None,
        };
        match self
            .kernel
            .call(SurfaceId::Desktop, tool, arguments, inbound)
            .await
        {
            Ok(result) => Ok(serde_json::to_value(result).expect("result serializes")),
            Err(unknown) => Err(format!("Tool {} not found", unknown.0)),
        }
    }

    /// Starts a call on its own task, so the test can play the browser meanwhile.
    pub fn spawn_call(
        self: &Arc<Self>,
        tool: &str,
        arguments: Value,
        request_id: Option<&str>,
    ) -> tokio::task::JoinHandle<Result<Value, String>> {
        let served = self.clone();
        let tool = tool.to_owned();
        let request_id = request_id.map(str::to_owned);
        tokio::spawn(async move {
            served
                .call_as(&tool, arguments, request_id.as_deref())
                .await
        })
    }

    /// Plays the browser: waits for one command, claims it and returns it with the epoch.
    pub async fn claim_next(&self) -> (BrowserCommand, String) {
        let broker = self.control.broker();
        for _ in 0..2000 {
            let poll = broker.poll(BROWSER, "Test Chrome", true).expect("polls");
            if let Some(request) = poll.requests.first() {
                let command = broker
                    .claim(BROWSER, request, &poll.epoch, &[])
                    .await
                    .expect("claimed");
                return (command, poll.epoch);
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        panic!("no command was queued");
    }

    /// Answers a claimed command.
    pub fn answer(&self, command: &BrowserCommand, epoch: &str, result: BrowserResult) {
        assert!(
            self.control
                .broker()
                .result(BROWSER, &command.id, epoch, result),
            "the result was accepted"
        );
    }

    /// Makes [`BROWSER`] known, so calls without a browser id go to it.
    pub fn connect(&self) {
        self.control
            .broker()
            .poll(BROWSER, "Test Chrome", true)
            .expect("polls");
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.run);
    }
}

pub fn first_text(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap_or_default()
}

pub fn ok(value: Value) -> BrowserResult {
    BrowserResult {
        value: Some(value),
        image: None,
        error: None,
    }
}
