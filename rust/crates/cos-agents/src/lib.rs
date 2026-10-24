//! Prime-owned worker families (E2.6, a port of `main/agents.ts` and the `agents` tool of
//! `main/mcp/tools-core.ts`).
//!
//! [`Agents`] is the only writer of the broker, `state/swarm.json` and
//! `state/retired-workers.json`. A mutation a model is told about runs on a copy of the
//! broker; the copy's snapshot is written to disk, and only then does the copy replace the
//! live state and reach readers. That is the TypeScript durable acceptance barrier with the
//! staged overlays replaced by copy-on-write: a refused or failed operation leaves nothing
//! behind, and no reader ever sees a revision disk has not accepted. Readers get
//! [`SwarmState`] snapshots through [`Agents::watch`].

mod broker;
mod snapshot;
mod text;
mod tool;
pub mod worktrees;

use std::sync::Arc;

use cos_store::{Durable, DurableStore, Logger};
use cos_tools::{Connectors, DynTool, EpochMs, SurfaceId};
use cos_types::config::{Config, DefaultReasoning};
use cos_types::session::SwarmState;
use cos_types::state::{RetiredWorkers, SwarmSnapshot};
use tokio::sync::{Mutex, watch};

pub use broker::{
    AgentError, Broker, Caller, CallerStatus, ClearOutcome, FamilyChoice, FinishResult,
    MAX_BATCH_MESSAGES, MAX_MESSAGE_CHARS, MessageItem, ObservedModel, Ownership, PRIME_ID, Policy,
    PrimeMessage, SpawnResult, StagedMessages, WAKE_FAILURES_BEFORE_GIVING_UP,
    WORKER_CONTEXT_CEILING_TOKENS, WorkerPrimeOwner, WorkerRequest, WorkerRevival, WorkerSpawn,
};

const SWARM_STATE: &str = "swarm";
const RETIRED_WORKERS_STATE: &str = "retired-workers";

/// Reads the wall clock. Owners take one so tests can move time.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| EpochMs::now().0)
}

/// How the broker asks the browser to open or reopen worker chats. The bridge's durable
/// command ledger implements it; it is only ever called after the revision that owes the tab
/// is durable.
pub trait WorkerBrowser: Send + Sync + 'static {
    fn bootstrap(&self, workers: Vec<WorkerSpawn>);
    fn revive(&self, revivals: Vec<WorkerRevival>);
}

/// No browser plane: the request is logged, as TypeScript logs it with no extension paired.
pub struct NoWorkerBrowser(pub Logger);

impl WorkerBrowser for NoWorkerBrowser {
    fn bootstrap(&self, _workers: Vec<WorkerSpawn>) {
        self.0.warn(
            "multi-agent: no browser extension is paired, so worker chats cannot be opened automatically",
        );
    }

    fn revive(&self, _revivals: Vec<WorkerRevival>) {
        self.0.warn(
            "multi-agent: no browser extension is paired, so sleeping worker chats cannot be reopened",
        );
    }
}

/// The models this ChatGPT account was last seen to offer (`getChatModels().models`).
pub type ObservedModels = Arc<dyn Fn() -> Vec<ObservedModel> + Send + Sync>;

pub struct AgentsDeps<'a> {
    pub state: &'a DurableStore,
    pub config: watch::Receiver<Arc<Config>>,
    pub logger: Logger,
    pub clock: Clock,
    pub browser: Arc<dyn WorkerBrowser>,
    pub models: ObservedModels,
}

/// Why an accepted mutation did not happen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AcceptError {
    /// The broker refused it; nothing changed.
    Refused(AgentError),
    /// The broker planned it, but disk did not accept the revision; nothing changed.
    NotDurable(String),
}

struct Shared {
    broker: Mutex<Broker>,
    swarm: Durable<SwarmSnapshot>,
    retired: Durable<RetiredWorkers>,
    config: watch::Receiver<Arc<Config>>,
    logger: Logger,
    clock: Clock,
    browser: Arc<dyn WorkerBrowser>,
    models: ObservedModels,
    published: watch::Sender<Arc<SwarmState>>,
    worktrees: Arc<worktrees::Worktrees>,
    /// Worker chat ownership for synchronous policy readers; replaced after every change.
    ownership: std::sync::RwLock<Arc<Ownership>>,
}

/// The broker's owner.
#[derive(Clone)]
pub struct Agents {
    shared: Arc<Shared>,
}

/// The live settings, as one operation reads them.
pub fn policy(config: &Config) -> Policy {
    let multi = &config.multi_agent;
    let connectors = Connectors::from_config(config);
    let core = connectors.name(SurfaceId::Core);
    let core_hint = if core == Connectors::default().name(SurfaceId::Core) {
        String::new()
    } else {
        format!(" of {core}")
    };
    Policy {
        enabled: multi.enabled,
        max_workers: u64::from(multi.max_workers),
        global_max_workers: multi.global_max_workers.map_or(0, u64::from),
        allow_unattributed: multi.allow_unattributed_calls,
        default_model: multi.default_model.clone(),
        default_reasoning: match multi.default_reasoning {
            Some(DefaultReasoning::Effort(effort)) => Some(effort),
            _ => None,
        },
        auto_worktrees: multi.auto_worktrees == Some(true),
        core_connector: core,
        core_hint,
    }
}

fn ledger<T: serde::Serialize>(state: &DurableStore, name: &str) -> Durable<T> {
    state.ledger(name).unwrap_or_else(|error| {
        // Both names are constants that satisfy the ledger rule.
        unreachable!("invalid ledger name {name}: {error}")
    })
}

impl Agents {
    pub fn new(deps: AgentsDeps<'_>) -> Self {
        let policy = policy(&deps.config.borrow());
        let empty = Broker::default().swarm_state(&policy);
        let (published, _) = watch::channel(Arc::new(empty));
        Self {
            shared: Arc::new(Shared {
                broker: Mutex::new(Broker::default()),
                swarm: ledger(deps.state, SWARM_STATE),
                retired: ledger(deps.state, RETIRED_WORKERS_STATE),
                config: deps.config,
                logger: deps.logger,
                clock: deps.clock,
                browser: deps.browser,
                models: deps.models,
                published,
                worktrees: Arc::default(),
                ownership: std::sync::RwLock::default(),
            }),
        }
    }

    /// The swarm as the app and `/v1/agents` show it, after every accepted change.
    pub fn watch(&self) -> watch::Receiver<Arc<SwarmState>> {
        self.shared.published.subscribe()
    }

    /// The model-facing `agents` tool, listed while multi-agent mode is on.
    pub fn tool(&self) -> Arc<dyn DynTool> {
        Arc::new(tool::AgentsTool::new(self.clone()))
    }

    pub fn policy(&self) -> Policy {
        policy(&self.shared.config.borrow())
    }

    fn now(&self) -> u64 {
        (self.shared.clock)()
    }

    pub(crate) fn observed_models(&self) -> Vec<ObservedModel> {
        (self.shared.models)()
    }

    /// Reads both ledgers and restores the broker (`restoreRetiredWorkers`, `restoreSwarm`),
    /// then parks everything when the feature is off. Workers still owed a tab or a revival
    /// are asked for again.
    pub async fn restore(&self) {
        let shared = self.shared.clone();
        let (swarm, retired) =
            tokio::task::spawn_blocking(move || (shared.swarm.read(), shared.retired.read()))
                .await
                .unwrap_or_default();
        let now = self.now();
        let policy = self.policy();
        let mut broker = self.shared.broker.lock().await;
        snapshot::restore_retired(&mut broker, retired.as_ref(), now);
        let mut repaired = snapshot::restore(&mut broker, swarm.as_ref(), now);
        let recovery = broker.managed_recovery_identities();
        if !policy.enabled {
            broker.pause_for_disable("multi-agent mode is disabled", now);
            repaired = true;
        }
        broker.retired_changed = false;
        let pending = broker.pending_worker_spawns();
        let revivals = broker.pending_worker_revivals(&policy);
        let active: Vec<String> = broker.runs.keys().cloned().collect();
        let dormant = broker.dormant.len();
        let undelivered: u64 = broker
            .runs
            .values()
            .flat_map(|family| family.agents.values())
            .map(|agent| agent.info.pending)
            .sum();
        broker.log.push((
            broker::Level::Info,
            format!(
                "multi-agent: restored {} with {dormant} dormant owner histor{} and {undelivered} active undelivered message(s)",
                if active.is_empty() {
                    "no active run".to_owned()
                } else {
                    format!("active runs {}", active.join(", "))
                },
                if dormant == 1 { "y" } else { "ies" }
            ),
        ));
        if repaired && let Err(error) = self.write_now(&mut broker, now).await {
            self.shared
                .logger
                .warn(&format!("could not save swarm state: {error}"));
        }
        self.finish(&mut broker, &policy);
        drop(broker);
        self.restore_worktrees(recovery).await;
        if !pending.is_empty() {
            self.shared.logger.info(&format!(
                "multi-agent: {} worker chat(s) still owed a tab",
                pending.len()
            ));
            self.shared.browser.bootstrap(pending);
        }
        if !revivals.is_empty() {
            self.shared.logger.info(&format!(
                "multi-agent: {} worker chat(s) still owed a revival",
                revivals.len()
            ));
            self.shared.browser.revive(revivals);
        }
    }

    /// Worker chat ownership as of the last accepted change, without waiting on the broker.
    /// The policy ports that answer synchronously (`ChatPolicy::worker`, the continuation's
    /// `FinishChats` and `CompactChats`, and the strict allowlist's worker rule) read this.
    pub fn ownership(&self) -> Arc<Ownership> {
        self.shared
            .ownership
            .read()
            .map(|ownership| ownership.clone())
            .unwrap_or_default()
    }

    /// The marker-verified worker checkouts of this process.
    pub fn worktrees(&self) -> Arc<worktrees::Worktrees> {
        self.shared.worktrees.clone()
    }

    /// Restores only the checkouts the restored broker still owns, before any worker can run.
    async fn restore_worktrees(&self, accepted: Vec<(String, String)>) {
        let roots = self.shared.config.borrow().roots.clone();
        if roots.is_empty() {
            return;
        }
        let worktrees = self.shared.worktrees.clone();
        let restored =
            tokio::task::spawn_blocking(move || worktrees.restore(&roots, &accepted)).await;
        let logger = &self.shared.logger;
        match restored {
            Ok(Ok(result)) => logger.info(&format!(
                "worktrees: restored {} worker workspace(s); refused {} invalid marker(s)",
                result.restored.len(),
                result.rejected.len()
            )),
            Ok(Err(error)) => logger.warn(&format!("worktrees: restore failed: {error}")),
            Err(error) => logger.warn(&format!("worktrees: restore failed: {error}")),
        }
    }

    /// Runs `op` on a copy, makes the copy durable and only then publishes it.
    pub async fn accept<T>(
        &self,
        failure: &str,
        op: impl FnOnce(&mut Broker, &Policy, u64) -> Result<T, AgentError>,
    ) -> Result<T, AcceptError> {
        let policy = self.policy();
        let now = self.now();
        let mut live = self.shared.broker.lock().await;
        let mut next = live.clone();
        next.log.clear();
        next.retired_changed = false;
        let value = match op(&mut next, &policy, now) {
            Ok(value) => value,
            Err(error) => {
                self.forward(&mut next);
                return Err(AcceptError::Refused(error));
            }
        };
        if let Err(error) = self.write_now(&mut next, now).await {
            return Err(AcceptError::NotDurable(format!("{failure} ({error})")));
        }
        *live = next;
        self.finish(&mut live, &policy);
        Ok(value)
    }

    /// Runs `op` on the live broker and queues the write: telemetry and browser observations.
    pub async fn update<T>(&self, op: impl FnOnce(&mut Broker, &Policy, u64) -> T) -> T {
        let policy = self.policy();
        let now = self.now();
        let mut broker = self.shared.broker.lock().await;
        let value = op(&mut broker, &policy, now);
        let snapshot = snapshot::build(&broker, now);
        match snapshot {
            Some(snapshot) => {
                if let Err(error) = self.shared.swarm.write_soon(&snapshot) {
                    self.shared
                        .logger
                        .warn(&format!("could not save swarm state: {error}"));
                }
            }
            None => self.shared.swarm.remove_soon(),
        }
        if broker.retired_changed {
            broker.retired_changed = false;
            let retired = snapshot::build_retired(&mut broker, now);
            if let Err(error) = self.shared.retired.write_soon(&retired) {
                self.shared
                    .logger
                    .warn(&format!("could not save retired workers: {error}"));
            }
        }
        self.finish(&mut broker, &policy);
        value
    }

    /// Reads the live broker.
    pub async fn read<T>(&self, op: impl FnOnce(&Broker, &Policy) -> T) -> T {
        let policy = self.policy();
        let broker = self.shared.broker.lock().await;
        op(&broker, &policy)
    }

    /// Asks the browser for the worker tabs these ids still owe, after their spawn was accepted.
    pub async fn request_bootstraps(&self, ids: &[String], run_id: &str) -> usize {
        let owed: Vec<WorkerSpawn> = self
            .read(|broker, _| {
                broker
                    .pending_worker_spawns()
                    .into_iter()
                    .filter(|spawn| spawn.run_id == run_id && ids.contains(&spawn.id))
                    .collect()
            })
            .await;
        let count = owed.len();
        if count > 0 {
            self.shared.browser.bootstrap(owed);
        }
        count
    }

    /// Asks the browser to reopen these waking workers' chats, after their wake was accepted.
    pub async fn request_revivals(&self, ids: &[String], run_id: &str) -> usize {
        let owed: Vec<WorkerRevival> = self
            .read(|broker, policy| {
                broker
                    .pending_worker_revivals(policy)
                    .into_iter()
                    .filter(|revival| revival.run_id == run_id && ids.contains(&revival.id))
                    .collect()
            })
            .await;
        let count = owed.len();
        if count > 0 {
            self.shared.browser.revive(owed);
        }
        count
    }

    /// Writes the retired fences (first: a missing fence is unintended authority), then the swarm.
    async fn write_now(&self, broker: &mut Broker, now: u64) -> Result<(), String> {
        let retired = broker
            .retired_changed
            .then(|| snapshot::build_retired(broker, now));
        let swarm = snapshot::build(broker, now);
        let shared = self.shared.clone();
        tokio::task::spawn_blocking(move || {
            if let Some(retired) = retired {
                shared
                    .retired
                    .write_now(&retired)
                    .map_err(|error| error.to_string())?;
            }
            match swarm {
                Some(swarm) => shared.swarm.write_now(&swarm),
                None => shared.swarm.remove_now(),
            }
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())??;
        broker.retired_changed = false;
        Ok(())
    }

    fn forward(&self, broker: &mut Broker) {
        for (level, line) in broker.log.drain(..) {
            match level {
                broker::Level::Info => self.shared.logger.info(&line),
                broker::Level::Warn => self.shared.logger.warn(&line),
            }
        }
    }

    fn finish(&self, broker: &mut Broker, policy: &Policy) {
        self.forward(broker);
        if let Ok(mut ownership) = self.shared.ownership.write() {
            *ownership = Arc::new(broker.worker_ownership());
        }
        let state = Arc::new(broker.swarm_state(policy));
        self.shared.published.send_if_modified(|current| {
            if **current == *state {
                return false;
            }
            *current = state;
            true
        });
    }

    /// What `state/swarm.json` and `state/retired-workers.json` would hold now.
    pub async fn snapshots(&self) -> (Option<SwarmSnapshot>, RetiredWorkers) {
        let now = self.now();
        let mut broker = self.shared.broker.lock().await;
        (
            snapshot::build(&broker, now),
            snapshot::build_retired(&mut broker, now),
        )
    }

    /// Writes whatever is queued. Called at shutdown.
    pub fn flush(&self) {
        for result in [self.shared.swarm.flush(), self.shared.retired.flush()] {
            if let Err(error) = result {
                self.shared
                    .logger
                    .warn(&format!("could not flush agent state: {error}"));
            }
        }
    }
}
