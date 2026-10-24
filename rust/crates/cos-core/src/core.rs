//! Startup and the process-lifetime resources only the Core's owner may release.
//!
//! Startup does no awaited IO beyond reading `config.json`. It builds every owner, starts the
//! listeners' owners (which bind at once), and moves ledger restore into the background
//! behind the admission fence. So `/v1/health`, `initialize` and `tools/list` answer while
//! sessions are still being read, and a UI can show its window without waiting for either.

use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use cos_bridge::families::browser_control::BrowserControlRoutes;
use cos_bridge::families::finish::ContinuationRoutes;
use cos_bridge::families::goal::GoalRoutes;
use cos_bridge::families::input::Input;
use cos_bridge::families::recorder::Observations;
use cos_bridge::{Bridge, BridgeDeps, BridgeTask, ExtensionFolder, Routes};
use cos_companion::ChatModels;
use cos_connection::{Connection, ConnectionDeps, ConnectionTask};
use cos_control_api::{ControlApi, ControlApiDeps};
use cos_exec::{
    CommandPolicy, ExecDeps, ExecManager, PolicyMode, PolicySource, PrestartedPowerShell,
};
use cos_files::FileToolsDeps;
use cos_input::{Commands, Outbox, OutboxDeps};
use cos_recorder::Recorder;
use cos_secrets::SecretStore;
use cos_sessions::{BlockedChatsLedger, ChatAccess, SessionStore, TrustedChatsLedger};
use cos_store::{
    AppPaths, BridgePortOverride, ConfigStore, DurableStore, Instance, LaunchArgs, Logger, Platform,
};
use cos_tools::{Admission, AdmissionGate, EpochMs, GrantEnv, Kernel, KernelDeps, Phase};
use cos_types::bridge::WakeSignal;
use cos_types::config::{CommandPolicyMode, Config};
use tokio::runtime::Runtime;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::APP_VERSION;
use crate::app::{AppCore, Domains, Shared};
use crate::launches::LaunchForwarder;
use crate::settings::Settings;
use crate::shutdown::{self, PhaseTasks, ShutdownPhase, ShutdownReport};
use crate::urls_file;

/// How long restore may hold the admission fence before the Core serves without it.
const RESTORE_BUDGET: Duration = Duration::from_secs(10);
/// The MCP endpoint's forced drain on final shutdown.
const ENDPOINT_DRAIN: Duration = Duration::from_secs(30);
const LOG_FLUSH: Duration = Duration::from_secs(2);
/// Blocking tasks still running after the last phase are abandoned after this.
const RUNTIME_STOP: Duration = Duration::from_secs(1);

/// The parsed command line and the profile it names, from the binary's boundary.
#[derive(Clone, Debug)]
pub struct Launch {
    pub args: LaunchArgs,
    pub paths: AppPaths,
}

#[derive(Debug)]
pub enum StartupError {
    /// The Tokio runtime could not be built.
    Runtime(io::Error),
    /// The thread that forwards later launches could not start.
    Launches(io::Error),
}

impl std::fmt::Display for StartupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Runtime(error) => write!(f, "could not start the Core runtime: {error}"),
            Self::Launches(error) => write!(f, "could not watch for later launches: {error}"),
        }
    }
}

impl std::error::Error for StartupError {}

/// A running Core and everything only its owner may release. Not `Clone`: exactly one place
/// decides when the process stops.
pub struct Core {
    args: LaunchArgs,
    runtime: Runtime,
    app: AppCore,
    gate: Arc<AdmissionGate>,
    control_api: ControlApi,
    connection_task: ConnectionTask,
    bridge_task: BridgeTask,
    launches: Option<mpsc::UnboundedReceiver<Vec<String>>>,
    /// Holds the profile lock. Released last, after every writer has flushed, so a later
    /// launch never shares the profile with this one.
    lock: LaunchForwarder,
}

impl Core {
    /// Starts the Core on a profile whose lock the caller already holds. The bridge's ports
    /// follow `CLF_BRIDGE_PORTS` when it is set, and the surface URLs are written to the file
    /// `COS_MCP_URLS_FILE` names, when it is set, each time they change.
    pub fn start(launch: Launch, instance: Instance) -> Result<Self, StartupError> {
        Self::start_with_bridge_ports(launch, instance, BridgePortOverride::from_env())
    }

    /// [`Core::start`] with the bridge's ports given instead of read from the environment.
    /// A test passes `0`, so it never listens where a real extension looks.
    pub fn start_with_bridge_ports(
        launch: Launch,
        instance: Instance,
        bridge_ports: Option<BridgePortOverride>,
    ) -> Result<Self, StartupError> {
        let Launch { args, paths } = launch;
        let logger = Logger::new();
        logger.mirror_to(paths.log());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(worker_threads())
            .thread_name("cos-core")
            .enable_all()
            .build()
            .map_err(StartupError::Runtime)?;
        let started = Instant::now();
        let entered = runtime.enter();

        let platform = Platform::current();
        let settings = Settings::load(
            ConfigStore::new(paths.config(), platform, logger.clone()),
            APP_VERSION,
            bridge_ports.clone(),
        );
        let (gate, admission) = Admission::channel();
        let gate = Arc::new(gate);
        let skills_dir = paths.user_data().join("skills");
        create_skills_dir(&skills_dir, &logger);
        let sessions = SessionStore::open(&paths, logger.clone());
        sessions.watch_config(settings.config());
        let recorder = Recorder::new(
            sessions.clone(),
            &DurableStore::new(paths.state(), logger.clone()),
            settings.config(),
            logger.clone(),
        );
        cos_exec::restore_ctrl_c();
        let exec = ExecManager::with_policy(
            ExecDeps {
                launcher: Arc::new(PrestartedPowerShell::new()),
            },
            command_policy(settings.config()),
        );
        runtime.spawn(follow_commands(settings.config(), exec.clone()));
        // One store per profile: each keeps a decrypted snapshot, so two would write back
        // stale maps over each other's keys.
        let secrets = Arc::new(Mutex::new(SecretStore::new(paths.user_data())));
        let extension = ExtensionFolder::locate(paths.user_data());
        let bridge = Bridge::new(BridgeDeps {
            app_version: APP_VERSION,
            config: settings.config(),
            secrets: secrets.clone(),
            admission: admission.clone(),
            logger: logger.clone(),
            extension: extension.clone(),
            ports_override: bridge_ports,
        });
        let state = DurableStore::new(paths.state(), logger.clone());
        let blocked_chats = BlockedChatsLedger::new(&state);
        let trusted_chats = TrustedChatsLedger::new(&state);
        let browser = crate::browser::build(
            settings.config(),
            skills_dir.clone(),
            platform,
            &recorder,
            &sessions,
            &blocked_chats,
            &bridge,
        );
        runtime.spawn(browser.clone().follow_bridge(bridge.status()));
        let wake = bridge.wake();
        let notify: cos_input::Notify = Arc::new(move || wake.signal(WakeSignal::Wake));
        let outbox = Outbox::new(OutboxDeps {
            sessions: sessions.clone(),
            state: &state,
            user_data: paths.user_data().to_owned(),
            config: settings.config(),
            logger: logger.clone(),
            notify: notify.clone(),
            clock: cos_input::system_clock(),
        });
        let continuation = crate::continuation::build(
            &sessions,
            &state,
            settings.config(),
            &outbox,
            &blocked_chats,
            &recorder,
            &logger,
        );
        let chat_models: Arc<OnceLock<ChatModels>> = Arc::default();
        let agents = crate::agents::build(&state, settings.config(), chat_models.clone(), &logger);
        let kernel = Kernel::new(KernelDeps {
            app_version: APP_VERSION,
            config: settings.config(),
            env: GrantEnv {
                skills_dir,
                platform,
            },
            tools: crate::surfaces::assemble(
                FileToolsDeps::default(),
                &sessions,
                &exec,
                &browser,
                &continuation.finish,
                &agents,
                &logger,
            ),
            attribution: Arc::new(recorder.clone()),
            chat_policy: Arc::new(ChatAccess {
                blocked: blocked_chats.clone(),
                trusted: trusted_chats.clone(),
                sessions: sessions.clone(),
                config: settings.config(),
            }),
            recorder: sessions.recorder(),
            admission: admission.clone(),
            logger: logger.clone(),
        });
        let (connection, connection_task) = Connection::spawn(ConnectionDeps {
            config: settings.config(),
            kernel: kernel.clone(),
            secrets: secrets.clone(),
            logger: logger.clone(),
        });
        if let Some(file) = urls_file::from_env() {
            runtime.spawn(urls_file::publish(
                connection.status(),
                file,
                logger.clone(),
            ));
        }
        let commands = Commands::new(
            sessions.clone(),
            &state,
            logger.clone(),
            notify,
            cos_input::system_clock(),
        );
        let goal_catalog = Arc::new(std::sync::OnceLock::new());
        let goal = crate::goal::build(crate::goal::GoalSources {
            config: settings.config(),
            sessions: sessions.clone(),
            state: &state,
            secrets: secrets.clone(),
            recorder: recorder.clone(),
            blocked: blocked_chats.clone(),
            outbox: outbox.clone(),
            kernel: kernel.clone(),
            catalog: goal_catalog.clone(),
            logger: logger.clone(),
        });
        let companion = crate::companion::build(
            &state,
            &settings,
            &bridge,
            extension.clone(),
            secrets,
            (
                crate::companion::Work::new(
                    recorder.clone(),
                    outbox.clone(),
                    commands.clone(),
                    kernel.clone(),
                    continuation.continuations.clone(),
                ),
                Arc::new(crate::continuation::Policy {
                    sessions: sessions.clone(),
                    blocked: blocked_chats.clone(),
                    compact: continuation.compact.clone(),
                    goal: goal.clone(),
                }),
                goal.clone(),
            ),
            &logger,
        );
        let _ = goal_catalog.set(companion.domains.chat_models.clone());
        let bridge_task = bridge.spawn(
            Routes::new(extension, logger.clone())
                .family(Arc::new(Observations::new(recorder.clone())))
                .family(Arc::new(companion.family))
                .family(Arc::new(Input::new(outbox.clone(), commands.clone())))
                .family(Arc::new(BrowserControlRoutes::new(browser)))
                .family(Arc::new(ContinuationRoutes::new(
                    continuation.compact.clone(),
                    continuation.repairs.clone(),
                )))
                .family(Arc::new(GoalRoutes::new(goal.clone()))),
        );
        let control_api = ControlApi::spawn(ControlApiDeps {
            paths: paths.clone(),
            app_version: APP_VERSION,
            started_at: EpochMs::now(),
            config: settings.config(),
            connection: connection.status(),
            bridge: bridge.status(),
            agents: agents.watch(),
            sessions: sessions.clone(),
            inputs: outbox.clone(),
            kernel: kernel.clone(),
            logger: logger.clone(),
            admission: admission.clone(),
        });
        let _ = chat_models.set(companion.domains.chat_models.clone());
        runtime.spawn(restore(
            gate.clone(),
            sessions.clone(),
            (recorder.clone(), continuation.continuations.clone()),
            companion.domains.chat_models.clone(),
            (commands, goal, agents.clone()),
            (blocked_chats.clone(), trusted_chats.clone()),
            logger.clone(),
        ));

        let (log, _) = broadcast::channel(256);
        let forward = log.clone();
        logger.on_log(move |entry| {
            // No subscriber is not an error; the Activity ring keeps the line.
            let _ = forward.send(entry.clone());
        });
        let (launched, launches) = mpsc::unbounded_channel();
        let lock = LaunchForwarder::spawn(instance, launched).map_err(StartupError::Launches)?;
        logger.info(&format!(
            "core started in {} ms",
            started.elapsed().as_millis()
        ));
        let app = AppCore::new(Shared {
            runtime: runtime.handle().clone(),
            domains: Domains {
                settings,
                sessions,
                recorder,
                blocked_chats,
                trusted_chats,
                connection,
                bridge,
                kernel,
                exec,
                companion: companion.domains,
                continuations: continuation.continuations,
                agents,
                logger,
            },
            admission,
            log,
        });
        drop(entered);
        Ok(Self {
            args,
            runtime,
            app,
            gate,
            control_api,
            connection_task,
            bridge_task,
            launches: Some(launches),
            lock,
        })
    }

    pub fn app(&self) -> AppCore {
        self.app.clone()
    }

    pub fn args(&self) -> &LaunchArgs {
        &self.args
    }

    /// The command lines of later launches on this profile. Taken once, by the UI or the
    /// headless binary.
    pub fn take_launches(&mut self) -> Option<mpsc::UnboundedReceiver<Vec<String>>> {
        self.launches.take()
    }

    /// Runs `future` to completion on the Core runtime, blocking this thread.
    pub fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }

    /// Runs the bounded shutdown sequence, flushes the log, stops the runtime and releases
    /// the profile lock, in that order.
    pub fn shutdown(self) -> ShutdownReport {
        let Self {
            runtime,
            app,
            gate,
            control_api,
            connection_task,
            bridge_task,
            lock,
            ..
        } = self;
        let domains = app.domains().clone();
        let mut drain = Some((control_api, connection_task, bridge_task));
        let report = runtime.block_on(shutdown::run(&domains.logger, |phase| {
            phase_tasks(phase, &domains, &gate, &mut drain)
        }));
        domains.logger.flush_before_exit(LOG_FLUSH);
        drop((app, domains));
        runtime.shutdown_timeout(RUNTIME_STOP);
        lock.release();
        report
    }
}

fn phase_tasks(
    phase: ShutdownPhase,
    domains: &Domains,
    gate: &AdmissionGate,
    drain: &mut Option<(ControlApi, ConnectionTask, BridgeTask)>,
) -> PhaseTasks {
    match phase {
        ShutdownPhase::Drain => {
            gate.advance(Phase::Draining);
            let Some((control_api, connection_task, bridge_task)) = drain.take() else {
                return Vec::new();
            };
            let connection = domains.connection.clone();
            vec![
                Box::pin(async move {
                    connection.shutdown(ENDPOINT_DRAIN).await;
                    connection_task.join().await;
                }),
                Box::pin(control_api.shutdown()),
                Box::pin(bridge_task.shutdown()),
            ]
        }
        ShutdownPhase::Processes => {
            let exec = domains.exec.clone();
            vec![Box::pin(async move { exec.terminate_all().await })]
        }
        ShutdownPhase::Recorder => {
            let sessions = domains.sessions.clone();
            let recorder = domains.recorder.clone();
            vec![Box::pin(async move {
                sessions.flush_recorder().await;
                recorder.settle().await;
            })]
        }
        ShutdownPhase::Durable => {
            let sessions = domains.sessions.clone();
            let recorder = domains.recorder.clone();
            let blocked_chats = domains.blocked_chats.clone();
            let trusted_chats = domains.trusted_chats.clone();
            let chat_models = domains.companion.chat_models.clone();
            let continuations = domains.continuations.clone();
            let agents = domains.agents.clone();
            vec![
                Box::pin(async move { sessions.flush().await }),
                Box::pin(async move {
                    let _ = tokio::task::spawn_blocking(move || {
                        recorder.flush();
                        blocked_chats.flush();
                        trusted_chats.flush();
                    })
                    .await;
                }),
                Box::pin(async move {
                    let _ = tokio::task::spawn_blocking(move || {
                        chat_models.flush();
                        continuations.flush();
                    })
                    .await;
                }),
                Box::pin(async move {
                    let _ = tokio::task::spawn_blocking(move || agents.flush()).await;
                }),
            ]
        }
        ShutdownPhase::UpdateHandoff => Vec::new(),
    }
}

/// Keeps one shell pre-started while commands are on, from start, and none while they are off.
async fn follow_commands(mut config: watch::Receiver<Arc<Config>>, exec: Arc<ExecManager>) {
    let mut on = false;
    loop {
        let now = config.borrow_and_update().capabilities.command;
        if now && !on {
            exec.prestart();
        } else if on && !now {
            exec.release_prestarted();
        }
        on = now;
        if config.changed().await.is_err() {
            return;
        }
    }
}

/// Restores every ledger owner concurrently, then opens the fence. An owner that fails or
/// panics is logged and skipped; one that overruns the budget is left running.
async fn restore(
    gate: Arc<AdmissionGate>,
    sessions: SessionStore,
    (recorder, continuations): (Recorder, cos_continuation::Continuations),
    chat_models: ChatModels,
    (commands, goal, agents): (Commands, cos_goal::Goal, cos_agents::Agents),
    (blocked_chats, trusted_chats): (BlockedChatsLedger, TrustedChatsLedger),
    logger: Logger,
) {
    let started = Instant::now();
    let mut owners = JoinSet::new();
    owners.spawn(async move {
        let read = tokio::task::spawn_blocking(move || {
            blocked_chats.restore();
            trusted_chats.restore();
        });
        match read.await {
            Ok(()) => "blocked and trusted chats: read".to_owned(),
            Err(error) => format!("blocked and trusted chats: {error}"),
        }
    });
    owners.spawn(async move {
        match tokio::task::spawn_blocking(move || chat_models.restore()).await {
            Ok(()) => "chat models: read".to_owned(),
            Err(error) => format!("chat models: {error}"),
        }
    });
    owners.spawn(async move {
        let report = sessions.restore().await;
        recorder.restore().await;
        // After the sessions: a committing record is resolved from the session itself.
        continuations.restore().await;
        format!(
            "sessions: {} restored, {} skipped",
            report.sessions,
            report.skipped.len()
        )
    });
    owners.spawn(async move {
        commands.restore().await;
        "bridge commands".to_owned()
    });
    owners.spawn(async move {
        goal.restore().await;
        "goal ledgers".to_owned()
    });
    owners.spawn(async move {
        agents.restore().await;
        "agents".to_owned()
    });
    let settled = tokio::time::timeout(RESTORE_BUDGET, async {
        while let Some(joined) = owners.join_next().await {
            match joined {
                Ok(summary) => logger.info(&format!("restore {summary}")),
                Err(error) => logger.warn(&format!("restore owner failed: {error}")),
            }
        }
    })
    .await;
    if settled.is_err() {
        logger.warn(&format!(
            "restore still running after {} s; serving without it",
            RESTORE_BUDGET.as_secs()
        ));
        owners.detach_all();
    }
    logger.info(&format!(
        "admission open after {} ms",
        started.elapsed().as_millis()
    ));
    gate.advance(Phase::Serving);
}

/// The skills library's folder (`initSkillsPath`): every launch has one, so `/skills` lists as an
/// empty folder before the first skill is added. The Core runs without it if it cannot be made.
fn create_skills_dir(dir: &Path, logger: &Logger) {
    match std::fs::create_dir(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => logger.warn(&format!("Skills library unavailable: {error}")),
    }
}

/// The user's `commandAllowlist`, read from the published config at each launch, so a Settings
/// save applies to the next command without a restart.
fn command_policy(config: watch::Receiver<Arc<Config>>) -> PolicySource {
    Box::new(move || {
        let saved = &config.borrow().command_allowlist;
        CommandPolicy {
            enabled: saved.enabled,
            mode: match saved.mode {
                CommandPolicyMode::Allow => PolicyMode::Allow,
                CommandPolicyMode::Deny => PolicyMode::Deny,
            },
            rules: saved.rules.clone(),
        }
    })
}

/// A small pool: the Core's work is IO-bound, and blocking file work has its own pool.
fn worker_threads() -> usize {
    std::thread::available_parallelism().map_or(2, |threads| threads.get().clamp(2, 4))
}

#[cfg(test)]
mod tests {
    use cos_sessions::ListQuery;
    use cos_store::Acquired;
    use cos_tools::{CallNotes, CallRecord, Caller, SurfaceId, ToolResult};
    use cos_types::session::ToolOutcome;

    use super::*;

    #[test]
    fn a_fresh_profile_starts_with_an_empty_skills_folder() {
        let profile = std::env::temp_dir().join(format!("cos-core-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let paths = AppPaths::at(&profile);
        let skills = paths.user_data().join("skills");
        let argv = vec!["cos-core-test".to_owned()];
        let Acquired::Primary(instance) =
            Instance::acquire(paths.user_data(), &argv).expect("locks")
        else {
            panic!("a fresh profile has no other owner");
        };
        let core = Core::start_with_bridge_ports(
            Launch {
                args: LaunchArgs::parse(&argv),
                paths,
            },
            instance,
            BridgePortOverride::parse("0"),
        )
        .expect("starts");
        let listed = std::fs::read_dir(&skills).map(Iterator::count);
        core.shutdown();
        assert_eq!(listed.expect("the skills folder exists"), 0);
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    fn a_line_the_ui_logs_reaches_the_activity_log_and_app_log() {
        let profile = std::env::temp_dir().join(format!("cos-core-logger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let paths = AppPaths::at(&profile);
        let log_file = paths.log();
        let argv = vec!["cos-core-test".to_owned()];
        let Acquired::Primary(instance) =
            Instance::acquire(paths.user_data(), &argv).expect("locks")
        else {
            panic!("a fresh profile has no other owner");
        };
        let core = Core::start_with_bridge_ports(
            Launch {
                args: LaunchArgs::parse(&argv),
                paths,
            },
            instance,
            BridgePortOverride::parse("0"),
        )
        .expect("starts");
        let app = core.app();
        let mut log = app.watches().log;
        app.logger().info("window shown in 12 ms");
        let entry = core.block_on(async {
            loop {
                let entry = log.recv().await.expect("the log is open");
                if entry.message.contains("window shown") {
                    return entry;
                }
            }
        });
        assert_eq!(entry.message, "window shown in 12 ms");
        core.shutdown();
        let mirrored = std::fs::read_to_string(&log_file).expect("app.log");
        assert!(mirrored.contains("window shown in 12 ms"), "{mirrored}");
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    fn disconnecting_the_browser_forgets_the_extensions_diagnostics() {
        let profile =
            std::env::temp_dir().join(format!("cos-core-disconnect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let paths = AppPaths::at(&profile);
        let argv = vec!["cos-core-test".to_owned()];
        let Acquired::Primary(instance) =
            Instance::acquire(paths.user_data(), &argv).expect("locks")
        else {
            panic!("a fresh profile has no other owner");
        };
        let core = Core::start_with_bridge_ports(
            Launch {
                args: LaunchArgs::parse(&argv),
                paths,
            },
            instance,
            BridgePortOverride::parse("0"),
        )
        .expect("starts");
        let domains = core.app().domains().clone();
        let diagnostics = domains.companion.diagnostics.clone();
        diagnostics.record(&serde_json::json!({
            "capturedAt": 1, "status": { "connected": true, "paired": true },
            "preferences": { "overwrite": true, "durations": false }, "preferencesStored": false, "tab": null
        }));
        assert!(diagnostics.watch().borrow().snapshot.is_some(), "recorded");
        core.block_on(domains.disconnect_browser())
            .expect("disconnected");
        assert!(diagnostics.watch().borrow().snapshot.is_none());
        core.shutdown();
        let _ = std::fs::remove_dir_all(&profile);
    }

    #[test]
    fn the_core_serves_the_bridge_and_a_test_core_never_where_an_extension_looks() {
        use std::io::{Read, Write};

        let profile = std::env::temp_dir().join(format!("cos-core-bridge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let paths = AppPaths::at(&profile);
        let argv = vec!["cos-core-test".to_owned()];
        let Acquired::Primary(instance) =
            Instance::acquire(paths.user_data(), &argv).expect("locks")
        else {
            panic!("a fresh profile has no other owner");
        };
        let core = Core::start_with_bridge_ports(
            Launch {
                args: LaunchArgs::parse(&argv),
                paths,
            },
            instance,
            BridgePortOverride::parse("0"),
        )
        .expect("starts");
        let mut status = core.app().watches().bridge;
        let port = core.block_on(async {
            let running = status.wait_for(|status| status.running);
            tokio::time::timeout(Duration::from_secs(10), running)
                .await
                .expect("the bridge starts in time")
                .expect("the bridge publishes")
                .port
                .expect("a port")
        });
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connects");
        stream
            .write_all(b"GET /hello HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n")
            .expect("writes");
        let mut reply = String::new();
        stream.read_to_string(&mut reply).expect("reads");
        core.shutdown();
        let _ = std::fs::remove_dir_all(&profile);
        assert!(
            !cos_bridge::auto_ports().any(|scanned| scanned == port),
            "a test listened on {port}, a port the extension scans"
        );
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains(r#""app":"chat-on-steroids""#), "{reply}");
    }

    #[test]
    fn the_session_list_grades_pressure_against_the_saved_thresholds() {
        let profile =
            std::env::temp_dir().join(format!("cos-core-pressure-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let paths = AppPaths::at(&profile);
        let store = ConfigStore::new(paths.config(), Platform::current(), Logger::new());
        let mut config = store.load(APP_VERSION);
        config.sessions.advisory_tokens = 50_000;
        config.sessions.limit_tokens = 60_000;
        store.save(config).expect("saves");
        let argv = vec!["cos-core-test".to_owned()];
        let Acquired::Primary(instance) =
            Instance::acquire(paths.user_data(), &argv).expect("locks")
        else {
            panic!("a fresh profile has no other owner");
        };
        let core = Core::start_with_bridge_ports(
            Launch {
                args: LaunchArgs::parse(&argv),
                paths,
            },
            instance,
            BridgePortOverride::parse("0"),
        )
        .expect("starts");
        let sessions = core.app().domains().sessions.clone();
        let list = core.block_on(async {
            let caller = Caller::unattributed(None);
            let arguments = serde_json::json!({ "paths": ["/project/a"] });
            sessions
                .recorder()
                .record(CallRecord {
                    surface: SurfaceId::Core,
                    tool: "read",
                    nested: false,
                    caller: &caller,
                    started_at: EpochMs(1_792_000_000_000),
                    finished_at: EpochMs(1_792_000_000_010),
                    outcome: ToolOutcome::Ok,
                    arguments: &arguments,
                    result: &ToolResult::text("a"),
                    notes: &CallNotes::default(),
                })
                .await;
            sessions
                .list(ListQuery {
                    limit: 20,
                    cursor: None,
                    live: false,
                })
                .await
        });
        core.shutdown();
        let pressure = &list.sessions[0].pressure;
        assert_eq!((pressure.advisory, pressure.limit), (50_000, 60_000));
        let _ = std::fs::remove_dir_all(&profile);
    }

    /// Counts what the Core asks of the launcher; the pool's own answer to each request is
    /// proven against the operating system in cos-exec's pool tests.
    #[derive(Default)]
    struct Requests {
        prestarts: std::sync::atomic::AtomicUsize,
        releases: std::sync::atomic::AtomicUsize,
    }

    impl cos_exec::Launcher for Requests {
        fn launch(
            &self,
            _request: cos_exec::LaunchRequest,
        ) -> cos_tools::BoxFuture<'_, Result<cos_exec::Launched, cos_exec::LaunchError>> {
            Box::pin(async { Err(cos_exec::LaunchError("not used".into())) })
        }

        fn prestart(&self, _request: &cos_exec::LaunchRequest) {
            self.prestarts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }

        fn release(&self) {
            self.releases
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn the_core_prestarts_while_commands_are_on_and_releases_when_they_go_off() {
        let profile =
            std::env::temp_dir().join(format!("cos-core-commands-{}", std::process::id()));
        let paths = AppPaths::at(&profile);
        let mut config =
            ConfigStore::new(paths.config(), Platform::current(), Logger::new()).load(APP_VERSION);
        config.capabilities.command = true;
        let (publish, published) = watch::channel(Arc::new(config));
        let requests = Arc::new(Requests::default());
        let exec = ExecManager::new(ExecDeps {
            launcher: requests.clone(),
        });
        let follow = tokio::spawn(follow_commands(published, exec));
        let counts = || {
            (
                requests.prestarts.load(std::sync::atomic::Ordering::SeqCst),
                requests.releases.load(std::sync::atomic::Ordering::SeqCst),
            )
        };
        let until = |want: (usize, usize)| async move {
            for _ in 0..500 {
                if counts() == want {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("prestarts and releases {:?}, not {want:?}", counts());
        };
        until((1, 0)).await;
        let set = |on: bool| {
            publish.send_modify(|config| Arc::make_mut(config).capabilities.command = on);
        };
        set(false);
        until((1, 1)).await;
        set(false);
        set(true);
        until((2, 1)).await;
        drop(publish);
        follow.await.expect("ends with the settings");
        assert_eq!(counts(), (2, 1), "nothing more was asked");
        let _ = std::fs::remove_dir_all(&profile);
    }
}
