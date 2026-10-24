//! A control API on a fresh profile, with the owners it reads replaced by ones a test controls.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cos_input::{Outbox, OutboxDeps};
use cos_sessions::{Appended, EventPosition, EventQuery, EventsError, ListQuery, SessionStore};
use cos_store::config::first_launch_config;
use cos_store::{AppPaths, DurableStore, Logger, Platform};
use cos_tools::{
    Admission, AdmissionGate, BoxFuture, EpochMs, GrantEnv, Kernel, KernelDeps, Phase,
    SurfaceTools, Unattributed,
};
use cos_types::app_state::{BridgeStatus, ConnectionStatus, SurfaceId};
use cos_types::config::Config;
use cos_types::control_api::{
    ControlApiEvent, ControlApiEvents, ControlApiSession, ControlApiSessionDetail,
    ControlApiSessionList,
};
use cos_types::ids::SessionId;
use serde_json::json;
use tokio::sync::{Notify, broadcast, watch};

use crate::server::Timing;
use crate::sessions::Sessions;
use crate::{ControlApi, Shared};

/// Session history held in memory: what the store would return, without its files.
#[derive(Default)]
pub(crate) struct FakeSessions {
    sessions: Mutex<HashMap<String, (ControlApiSession, Vec<ControlApiEvent>)>>,
    appended: Mutex<Option<broadcast::Sender<Appended>>>,
    /// While set, every read waits on it: an owner that is stuck.
    pub(crate) hold: Mutex<Option<Arc<Notify>>>,
    /// While set, an event read fails the way an owner with a bug does.
    pub(crate) broken: std::sync::atomic::AtomicBool,
}

pub(crate) fn session_row(
    id: &str,
    conversation: Option<&str>,
    origin: Option<&str>,
) -> ControlApiSession {
    serde_json::from_value(json!({
        "id": id, "title": "Stream me", "conversationId": conversation, "projectId": null,
        "startedAt": 1_700_000_000_000_u64, "updatedAt": 1_700_000_000_000_u64, "endedAt": null,
        "events": 0, "userMessages": 0, "toolCalls": 0, "lastToolCallAt": null,
        "lastAssistantFinalAt": null, "lastTurnEndAt": null, "activityExpiresAt": null, "errors": 0,
        "toolRejected": 0, "toolInternalErrors": 0, "processExitNonzero": 0, "estimatedTokens": 0,
        "contextTokens": 0, "lastTurnOutcome": null, "activeTurnId": null, "model": null, "agents": [],
        "origin": origin.map(|kind| json!({ "kind": kind, "fromSessionId": null, "agentId": null, "task": "" }))
    }))
    .expect("a session row")
}

pub(crate) fn note(seq: u64, text: &str) -> ControlApiEvent {
    let kind = if seq.is_multiple_of(2) {
        "note"
    } else {
        "user_message"
    };
    serde_json::from_value(json!({
        "seq": seq, "position": seq, "time": 1_700_000_000_000_u64 + seq, "kind": kind, "source": "app",
        "message": { "text": text, "chars": text.len(), "truncated": false }
    }))
    .expect("an event")
}

impl FakeSessions {
    pub(crate) fn add(&self, session: ControlApiSession) {
        let id = session.id.clone();
        self.sessions
            .lock()
            .expect("lock")
            .insert(id, (session, Vec::new()));
    }

    pub(crate) fn append(&self, id: &str, event: ControlApiEvent) {
        let seq = event.seq;
        self.sessions
            .lock()
            .expect("lock")
            .get_mut(id)
            .expect("a recorded session")
            .1
            .push(event);
        if let Some(sender) = &*self.appended.lock().expect("lock") {
            let _ = sender.send(Appended {
                session: SessionId::parse(id).expect("an id"),
                seq,
            });
        }
    }

    pub(crate) fn remove(&self, id: &str) {
        self.sessions.lock().expect("lock").remove(id);
    }

    async fn wait_if_held(&self) {
        let hold = self.hold.lock().expect("lock").clone();
        if let Some(hold) = hold {
            hold.notified().await;
        }
    }
}

impl Sessions for FakeSessions {
    fn list(&self, query: ListQuery) -> BoxFuture<'_, ControlApiSessionList> {
        Box::pin(async move {
            self.wait_if_held().await;
            let sessions = self.sessions.lock().expect("lock");
            serde_json::from_value(json!({
                "sessions": sessions.values().take(query.limit as usize).map(|(session, _)| {
                    let mut row = serde_json::to_value(session).expect("a row");
                    row["pressure"] = json!({ "level": "ok", "advisory": 0, "limit": 0 });
                    row
                }).collect::<Vec<_>>(),
                "total": sessions.len(), "nextCursor": null, "activeId": null
            }))
            .expect("a page")
        })
    }

    fn detail<'a>(&'a self, id: &'a SessionId) -> BoxFuture<'a, Option<ControlApiSessionDetail>> {
        Box::pin(async move {
            self.wait_if_held().await;
            let sessions = self.sessions.lock().expect("lock");
            sessions
                .get(id.as_str())
                .map(|(session, _)| ControlApiSessionDetail {
                    session: session.clone(),
                    live: None,
                })
        })
    }

    fn events<'a>(
        &'a self,
        id: &'a SessionId,
        query: EventQuery,
    ) -> BoxFuture<'a, Result<ControlApiEvents, EventsError>> {
        Box::pin(async move {
            self.wait_if_held().await;
            assert!(
                !self.broken.load(std::sync::atomic::Ordering::SeqCst),
                "the store failed"
            );
            let sessions = self.sessions.lock().expect("lock");
            let (_, events) = sessions.get(id.as_str()).ok_or(EventsError::NotFound)?;
            let kept = |event: &&ControlApiEvent| {
                query
                    .kinds
                    .as_ref()
                    .is_none_or(|kinds| kinds.contains(&event.kind))
            };
            let limit = query.limit as usize;
            let (page, start): (Vec<ControlApiEvent>, u64) = match query.position {
                EventPosition::From(from) => (
                    events
                        .iter()
                        .filter(|event| event.seq >= from)
                        .filter(kept)
                        .take(limit)
                        .cloned()
                        .collect(),
                    from,
                ),
                EventPosition::After(after) => (
                    events
                        .iter()
                        .filter(|event| event.position > after)
                        .filter(kept)
                        .take(limit)
                        .cloned()
                        .collect(),
                    0,
                ),
                EventPosition::Before(before) => {
                    let older: Vec<_> = events
                        .iter()
                        .filter(|event| event.position < before)
                        .filter(kept)
                        .collect();
                    (
                        older[older.len().saturating_sub(limit)..]
                            .iter()
                            .map(|event| (*event).clone())
                            .collect(),
                        0,
                    )
                }
                EventPosition::Latest => {
                    let all: Vec<_> = events.iter().filter(kept).collect();
                    (
                        all[all.len().saturating_sub(limit)..]
                            .iter()
                            .map(|event| (*event).clone())
                            .collect(),
                        0,
                    )
                }
            };
            let next_from = page.iter().map(|event| event.seq + 1).fold(start, u64::max);
            Ok(ControlApiEvents {
                total: events.len() as u64,
                events: page,
                next_from,
            })
        })
    }

    fn appended(&self) -> broadcast::Receiver<Appended> {
        let mut sender = self.appended.lock().expect("lock");
        sender
            .get_or_insert_with(|| broadcast::channel(64).0)
            .subscribe()
    }
}

/// The bridge port the default status names, replaced by `<PORT>` before a corpus compare.
pub(crate) const BRIDGE_PORT: u16 = 41_234;

pub(crate) struct Options {
    pub(crate) enabled: bool,
    pub(crate) allow_actions: bool,
    pub(crate) timing: Timing,
    pub(crate) connection: ConnectionStatus,
    pub(crate) bridge: BridgeStatus,
    /// Serve sessions from the Core's session store instead of the recorded history.
    pub(crate) real_store: bool,
    /// The whole config to start with, instead of the first-launch one with the two switches.
    pub(crate) config: Option<Arc<Config>>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            enabled: true,
            allow_actions: false,
            timing: Timing::default(),
            real_store: false,
            config: None,
            connection: serde_json::from_value(json!({
                "state": "disconnected", "detail": "Not connected", "publicUrl": null, "localUrl": null,
                "handshakeAt": null, "lastRequestAt": null, "lastToolCallAt": null, "health": null, "surfaces": []
            }))
            .expect("a connection status"),
            // The recorder's bridge: `CLF_BRIDGE_PORTS=0`, nothing paired.
            bridge: serde_json::from_value(json!({
                "portOverridden": true, "error": null, "running": true, "port": BRIDGE_PORT, "paired": false,
                "present": false, "lastSeenAt": null, "extensionVersion": null, "externalExtension": null,
                "cosExtension": { "present": false }
            }))
            .expect("a bridge status"),
        }
    }
}

pub(crate) struct Harness {
    pub(crate) dir: PathBuf,
    pub(crate) port: u16,
    pub(crate) token: String,
    pub(crate) sessions: Arc<FakeSessions>,
    pub(crate) logger: Logger,
    pub(crate) kernel: Arc<Kernel>,
    /// The real outbox, over the real session store on this profile.
    pub(crate) outbox: Outbox,
    pub(crate) store: SessionStore,
    config: watch::Sender<Arc<Config>>,
    api: Option<ControlApi>,
    _gate: AdmissionGate,
}

fn scratch() -> PathBuf {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).expect("random bytes");
    let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    std::env::temp_dir().join(format!("cos-control-api-{name}"))
}

pub(crate) fn config(enabled: bool, allow_actions: bool) -> Arc<Config> {
    let mut config = first_launch_config(Platform::current());
    config.control_api.enabled = enabled;
    config.control_api.allow_actions = allow_actions;
    Arc::new(config)
}

impl Harness {
    pub(crate) async fn start(options: Options) -> Self {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("a profile folder");
        let paths = AppPaths::at(&dir);
        let logger = Logger::with_clock(|| EpochMs::now().0, false);
        let (config, config_seen) = watch::channel(
            options
                .config
                .clone()
                .unwrap_or_else(|| config(options.enabled, options.allow_actions)),
        );
        let (_, connection) = watch::channel(Arc::new(options.connection));
        let (_, bridge) = watch::channel(Arc::new(options.bridge));
        let (_, agents) = watch::channel(Arc::new(cos_types::session::SwarmState {
            enabled: false,
            running: false,
            retained_history: Some(false),
            retained_workers: None,
            agents: Vec::new(),
        }));
        let (gate, admission) = Admission::channel();
        gate.advance(Phase::Serving);
        let store = SessionStore::open(&paths, logger.clone());
        let kernel = Kernel::new(KernelDeps {
            app_version: "2.1.35",
            config: config_seen.clone(),
            env: GrantEnv {
                skills_dir: dir.join("skills"),
                platform: Platform::current(),
            },
            tools: {
                let mut tools = SurfaceTools::default();
                tools.add(SurfaceId::Core, store.plan_tool());
                tools
            },
            attribution: Arc::new(Unattributed),
            chat_policy: Arc::new(cos_tools::AnyChat),
            recorder: store.recorder(),
            admission: admission.clone(),
            logger: logger.clone(),
        });
        let outbox = Outbox::new(OutboxDeps {
            sessions: store.clone(),
            state: &DurableStore::new(paths.state(), logger.clone()),
            user_data: dir.clone(),
            config: config_seen.clone(),
            logger: logger.clone(),
            notify: Arc::new(|| {}),
            clock: cos_input::system_clock(),
        });
        let sessions = Arc::new(FakeSessions::default());
        let shared = Arc::new(Shared {
            paths,
            app_version: "2.1.35",
            started_at: EpochMs::now(),
            config: config_seen,
            connection,
            bridge,
            agents,
            sessions: if options.real_store {
                Arc::new(store.clone())
            } else {
                sessions.clone()
            },
            inputs: Arc::new(outbox.clone()),
            kernel: kernel.clone(),
            logger: logger.clone(),
            admission,
        });
        let api = ControlApi::spawn_shared(shared, options.timing);
        let mut harness = Self {
            dir,
            port: 0,
            token: String::new(),
            sessions,
            logger,
            kernel,
            outbox,
            store,
            config,
            api: Some(api),
            _gate: gate,
        };
        if options.enabled {
            harness.reload_endpoint().await;
        }
        harness
    }

    pub(crate) fn control_dir(&self) -> PathBuf {
        self.dir.join("control-api")
    }

    /// Waits for a listener whose endpoint differs from the last one this harness saw.
    pub(crate) async fn reload_endpoint(&mut self) {
        let previous = self.port;
        for _ in 0..200 {
            if let Some((port, token)) = read_endpoint(&self.control_dir())
                && port != previous
            {
                self.port = port;
                self.token = token;
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the control API never published an endpoint");
    }

    pub(crate) fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    pub(crate) fn set_config(&self, enabled: bool, allow_actions: bool) {
        self.config.send_replace(config(enabled, allow_actions));
    }

    pub(crate) async fn shutdown(mut self) {
        if let Some(api) = self.api.take() {
            api.shutdown().await;
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub(crate) fn read_endpoint(dir: &Path) -> Option<(u16, String)> {
    let endpoint = std::fs::read_to_string(dir.join("endpoint.json")).ok()?;
    let token = std::fs::read_to_string(dir.join("token")).ok()?;
    let endpoint: serde_json::Value = serde_json::from_str(&endpoint).ok()?;
    let port = u16::try_from(endpoint["port"].as_u64()?).ok()?;
    Some((port, token.trim().to_owned()))
}
