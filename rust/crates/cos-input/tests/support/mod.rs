//! A profile with a recorder (to make chats the way a page does), the outbox, the command
//! ledger, a hand-driven clock and a wake counter.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use cos_input::{Commands, Outbox, OutboxDeps};
use cos_recorder::Recorder;
use cos_sessions::SessionStore;
use cos_store::config::first_launch_config;
use cos_store::{AppPaths, DurableStore, Logger, Platform};
use cos_tools::EpochMs;
use serde_json::{Value, json};
use tokio::sync::watch;

pub const CHAT: &str = "c1c1c1c1-0000-4000-8000-000000000001";
pub const OTHER: &str = "c2c2c2c2-0000-4000-8000-000000000002";
/// Page observations happen before this; the outbox clock starts here.
pub const START: u64 = 1_767_225_700_000;

pub struct World {
    pub dir: PathBuf,
    pub sessions: SessionStore,
    pub recorder: Recorder,
    pub outbox: Outbox,
    pub commands: Commands,
    pub clock: Arc<AtomicU64>,
    pub wakes: Arc<AtomicUsize>,
}

pub fn profile(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cos-input-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile");
    dir
}

impl World {
    pub async fn new(name: &str) -> Self {
        Self::open(profile(name), Arc::new(AtomicU64::new(START))).await
    }

    /// The same profile as a new process sees it: nothing held in memory survives.
    pub async fn restart(self) -> Self {
        self.sessions.flush().await;
        self.outbox.flush();
        self.commands.flush();
        Self::open(self.dir, self.clock).await
    }

    async fn open(dir: PathBuf, clock: Arc<AtomicU64>) -> Self {
        let paths = AppPaths::at(&dir);
        let logger = Logger::new();
        let sessions = SessionStore::open(&paths, logger.clone());
        let config = watch::channel(Arc::new(first_launch_config(Platform::current()))).1;
        let state = DurableStore::new(paths.state(), logger.clone());
        let recorder = Recorder::new(sessions.clone(), &state, config.clone(), logger.clone());
        sessions.restore().await;
        recorder.restore().await;
        let wakes = Arc::new(AtomicUsize::new(0));
        let counter = wakes.clone();
        let notify: cos_input::Notify = Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let ticks = clock.clone();
        let now: cos_input::Clock = Arc::new(move || ticks.load(Ordering::SeqCst));
        let outbox = Outbox::new(OutboxDeps {
            sessions: sessions.clone(),
            state: &state,
            user_data: dir.clone(),
            config,
            logger: logger.clone(),
            notify: notify.clone(),
            clock: now.clone(),
        });
        let commands = Commands::new(sessions.clone(), &state, logger, notify, now);
        commands.restore().await;
        Self {
            dir,
            sessions,
            recorder,
            outbox,
            commands,
            clock,
            wakes,
        }
    }

    pub fn now(&self) -> u64 {
        self.clock.load(Ordering::SeqCst)
    }

    pub fn advance(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn wakes(&self) -> usize {
        self.wakes.load(Ordering::SeqCst)
    }

    /// What a ChatGPT page reports about a chat, through `/events`. Answers the chat's session.
    pub async fn page(&self, conversation: &str, events: Value) -> String {
        let stored = self
            .recorder
            .events(
                &json!({ "conversationId": conversation, "events": events }),
                EpochMs(START - 1_000),
            )
            .await
            .expect("events");
        let value = serde_json::to_value(stored).expect("stored");
        value["sessionId"].as_str().expect("session").to_owned()
    }

    /// A chat whose last turn finished at `time`, on a model that is not Pro.
    pub async fn idle_chat(&self, conversation: &str, time: u64) -> String {
        self.page(
            conversation,
            json!([
                { "kind": "model_selection", "model": "GPT-5.6 Sol", "reasoningEffort": "high", "time": time - 300 },
                { "kind": "user_message", "messageId": "m-u0", "text": "Hello", "time": time - 200, "authoredNow": true },
                { "kind": "turn_start", "turnId": "t0", "time": time - 100 },
                { "kind": "assistant_message", "messageId": "m-a0", "turnId": "t0", "text": "Hi", "state": "final", "final": true, "time": time - 50 },
                { "kind": "turn_end", "turnId": "t0", "outcome": "completed", "time": time }
            ]),
        )
        .await
    }

    pub fn ledger(&self) -> Value {
        read_json(&self.dir.join("state").join("session-input.json"))
    }

    pub fn command_ledger(&self) -> Value {
        read_json(&self.dir.join("state").join("bridge-commands.json"))
    }

    pub fn journal(&self, session: &str) -> Vec<Value> {
        let text =
            std::fs::read_to_string(self.dir.join("sessions").join(session).join("events.jsonl"))
                .unwrap_or_default();
        text.lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// Every canonical message shard of a session.
    pub fn messages(&self, session: &str) -> Vec<Value> {
        let root = self.dir.join("sessions").join(session).join("messages");
        let mut found = Vec::new();
        collect(&root, &mut found);
        found
    }

    pub fn args(&self, session: Option<&str>, text: &str) -> Value {
        json!({ "id": uuid(), "sessionId": session, "text": text, "mode": "auto",
            "dueAt": 0, "model": null, "reasoningEffort": null })
    }
}

fn collect(dir: &Path, found: &mut Vec<Value>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, found);
        } else if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                if let Ok(value) = serde_json::from_str(line) {
                    found.push(value);
                }
            }
        }
    }
}

pub fn read_json(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

pub fn uuid() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    format!("0f8fad5b-d9cb-469f-a165-{n:012x}")
}

pub fn row<'a>(rows: &'a Value, id: &str) -> &'a Value {
    rows.as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == id))
        .unwrap_or(&Value::Null)
}
