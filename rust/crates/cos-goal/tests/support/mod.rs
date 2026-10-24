//! A profile with a session store, the Goal owner on a hand-driven clock, and a loopback stub
//! provider that answers recorded replies and keeps every request it was sent.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cos_goal::{Goal, GoalDeps, NoChats, NoHelper};
use cos_secrets::{SecretKey, SecretStore};
use cos_sessions::SessionStore;
use cos_store::config::first_launch_config;
use cos_store::{AppPaths, DurableStore, Logger, Platform};
use cos_types::config::{Config, GoalBackend, GoalProviderKind};
use cos_types::ids::SessionId;
use cos_types::session::SessionEvent;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

pub const CHAT: &str = "cafe0003-0000-4000-8000-000000000003";
pub const OTHER: &str = "cafe0004-0000-4000-8000-000000000004";
pub const START: u64 = 1_767_225_600_000;

/// One request the stub received.
#[derive(Clone, Debug)]
pub struct Seen {
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// A recorded provider reply.
#[derive(Clone, Debug)]
pub struct Canned {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
    pub headers: Vec<(&'static str, String)>,
}

impl Canned {
    pub fn json(body: Value) -> Self {
        Self {
            status: 200,
            content_type: "application/json",
            body: body.to_string(),
            headers: Vec::new(),
        }
    }

    /// A non-streaming completion whose message content is `content`.
    pub fn completion(content: &str) -> Self {
        Self::json(
            json!({ "choices": [{ "message": { "role": "assistant", "content": content } }] }),
        )
    }

    pub fn decision(action: &str, reply: &str) -> Self {
        Self::completion(&json!({ "action": action, "reply": reply }).to_string())
    }

    pub fn sse(records: &[&str]) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream",
            body: records.concat(),
            headers: Vec::new(),
        }
    }

    pub fn status(status: u16, body: Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.to_string(),
            headers: Vec::new(),
        }
    }
}

#[derive(Clone, Default)]
pub struct Stub {
    pub base: String,
    replies: Arc<Mutex<Vec<Canned>>>,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Stub {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("stub bind");
        let port = listener.local_addr().expect("stub addr").port();
        let stub = Self {
            base: format!("http://127.0.0.1:{port}/v1"),
            ..Self::default()
        };
        let serving = stub.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let serving = serving.clone();
                tokio::spawn(async move {
                    let mut buffer = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let (head_end, length) = loop {
                        let Ok(read) = socket.read(&mut chunk).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        buffer.extend_from_slice(&chunk[..read]);
                        if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buffer[..at]).to_string();
                            let length = head
                                .lines()
                                .find_map(|line| {
                                    let (name, value) = line.split_once(':')?;
                                    name.eq_ignore_ascii_case("content-length")
                                        .then(|| value.trim().parse::<usize>().ok())
                                        .flatten()
                                })
                                .unwrap_or(0);
                            break (at + 4, length);
                        }
                    };
                    while buffer.len() < head_end + length {
                        let Ok(read) = socket.read(&mut chunk).await else {
                            return;
                        };
                        if read == 0 {
                            break;
                        }
                        buffer.extend_from_slice(&chunk[..read]);
                    }
                    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
                    let mut lines = head.lines();
                    let path = lines
                        .next()
                        .and_then(|line| line.split(' ').nth(1))
                        .unwrap_or_default()
                        .to_owned();
                    let headers = lines
                        .filter_map(|line| line.split_once(':'))
                        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
                        .collect();
                    let body = serde_json::from_slice(&buffer[head_end..]).unwrap_or(Value::Null);
                    serving.seen.lock().expect("seen").push(Seen {
                        path,
                        headers,
                        body,
                    });
                    let canned = {
                        let mut replies = serving.replies.lock().expect("replies");
                        if replies.is_empty() {
                            Canned::status(
                                500,
                                json!({ "error": { "message": "no recorded reply" } }),
                            )
                        } else {
                            replies.remove(0)
                        }
                    };
                    let mut response = format!(
                        "HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n",
                        canned.status,
                        canned.content_type,
                        canned.body.len()
                    );
                    for (name, value) in &canned.headers {
                        response.push_str(&format!("{name}: {value}\r\n"));
                    }
                    response.push_str("\r\n");
                    response.push_str(&canned.body);
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        stub
    }

    pub fn reply(&self, canned: Canned) {
        self.replies.lock().expect("replies").push(canned);
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().expect("seen").clone()
    }
}

pub struct World {
    pub dir: PathBuf,
    pub sessions: SessionStore,
    pub goal: Goal,
    pub config: watch::Sender<Arc<Config>>,
    pub secrets: Arc<Mutex<SecretStore>>,
    pub clock: Arc<AtomicU64>,
    pub stub: Stub,
}

pub fn profile(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cos-goal-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile");
    dir
}

/// Goal on, API backend, custom keyless provider at the stub.
pub fn api_config(stub: &Stub) -> Config {
    let mut config = first_launch_config(Platform::current());
    config.goal.enabled = true;
    config.goal.backend = Some(GoalBackend::Api);
    config.goal.provider.kind = GoalProviderKind::Custom;
    config.goal.provider.base_url = stub.base.clone();
    config.goal.model = "deepseek/deepseek-v4-flash".to_owned();
    config
}

impl World {
    pub async fn new(name: &str) -> Self {
        let stub = Stub::start().await;
        let config = api_config(&stub);
        Self::open(profile(name), Arc::new(AtomicU64::new(START)), stub, config).await
    }

    /// The same profile as a new process sees it.
    pub async fn restart(self) -> Self {
        self.sessions.flush().await;
        let config = self.config.borrow().as_ref().clone();
        Self::open(self.dir, self.clock, self.stub, config).await
    }

    async fn open(dir: PathBuf, clock: Arc<AtomicU64>, stub: Stub, config: Config) -> Self {
        let paths = AppPaths::at(&dir);
        let logger = Logger::new();
        let sessions = SessionStore::open(&paths, logger.clone());
        sessions.restore().await;
        let (config, receiver) = watch::channel(Arc::new(config));
        let state = DurableStore::new(paths.state(), logger.clone());
        let secrets = Arc::new(Mutex::new(SecretStore::new(&dir)));
        let ticks = clock.clone();
        let goal = Goal::new(GoalDeps {
            config: receiver,
            sessions: sessions.clone(),
            state: &state,
            secrets: secrets.clone(),
            chats: Arc::new(NoChats),
            helper: Arc::new(NoHelper),
            logger,
            clock: Arc::new(move || ticks.load(Ordering::SeqCst)),
            openrouter_base: stub.base.clone(),
        });
        goal.restore().await;
        Self {
            dir,
            sessions,
            goal,
            config,
            secrets,
            clock,
            stub,
        }
    }

    pub fn advance(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn configure(&self, change: impl FnOnce(&mut Config)) {
        let mut next = self.config.borrow().as_ref().clone();
        change(&mut next);
        self.config.send_replace(Arc::new(next));
    }

    pub fn set_key(&self, key: SecretKey, value: &str) {
        self.secrets
            .lock()
            .expect("secrets")
            .set(&key, value)
            .expect("set secret");
    }

    pub fn state_file(&self, name: &str) -> Option<Value> {
        let text =
            std::fs::read_to_string(self.dir.join("state").join(format!("{name}.json"))).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// A recorded chat with these events, in order. Returns its session id.
    pub async fn record(&self, conversation: &str, events: &[Value]) -> String {
        let summary = self
            .sessions
            .create_for_conversation(conversation, Some("A chat"))
            .await
            .expect("session");
        self.append(&summary.id, events).await;
        summary.id.as_str().to_owned()
    }

    pub async fn append(&self, session: &SessionId, events: &[Value]) {
        for event in events {
            let mut event = event.clone();
            event["seq"] = json!(0);
            event["time"]
                .as_u64()
                .is_none()
                .then(|| event["time"] = json!(START));
            event["source"]
                .as_str()
                .is_none()
                .then(|| event["source"] = json!("extension"));
            let parsed: SessionEvent = serde_json::from_value(event).expect("event shape");
            self.sessions
                .append_event(session, parsed)
                .await
                .expect("append");
        }
        self.sessions.flush().await;
    }

    /// Waits until this chat's draft settles out of `sending`/`answering`.
    pub async fn settled(&self, conversation: &str) -> Option<cos_types::bridge::GoalDraftView> {
        for _ in 0..400 {
            if !self.goal.draft_busy(conversation) {
                return self.goal.view_for(conversation, None);
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("draft never settled");
    }
}

pub fn user(text: &str) -> Value {
    json!({ "kind": "user_message", "message": { "text": text, "truncated": false, "chars": text.encode_utf16().count() } })
}

pub fn answer(text: &str, turn: &str, message: &str) -> Value {
    json!({ "kind": "assistant_message", "turnId": turn, "messageId": message, "final": true,
        "message": { "text": text, "truncated": false, "chars": text.encode_utf16().count() } })
}
