//! Connection lifecycle: MCP endpoint generations, tunnels, health and the published
//! [`ConnectionStatus`]. Unit C1.10 owns this crate (port of `src/main/connection.ts`,
//! `connector-proof.ts`, `diagnostics.ts` and `src/main/tunnel/*`).
//!
//! One actor owns the lifecycle. Connect, disconnect and settings-driven reconnects arrive as
//! [`Command`]s in order, so two of them never interleave, and every transition bumps the
//! generation so a late result of an older one is ignored. The actor is the only writer of
//! the status; everyone else holds a `watch` receiver.
//!
//! The published clocks (`lastRequestAt`, `lastToolCallAt`) are the kernel's as of the last
//! publication. Requests do not pass through the actor, so a reader that needs them live
//! reads `Kernel::last_request_at` and `last_tool_call_at` itself.

mod lifecycle;
mod ports;
mod surfaces;
mod tunnel;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use cos_secrets::SecretStore;
use cos_store::Logger;
use cos_tools::Kernel;
use cos_types::app_state::{ConnectionState, ConnectionStatus, SurfaceId};
use cos_types::config::Config;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::lifecycle::Actor;
use crate::ports::McpPorts;

pub struct ConnectionDeps {
    pub config: watch::Receiver<Arc<Config>>,
    pub kernel: Arc<Kernel>,
    pub secrets: Arc<Mutex<SecretStore>>,
    pub logger: Logger,
}

/// What callers may ask of the lifecycle.
#[derive(Debug)]
pub enum Command {
    Connect,
    Disconnect,
    /// Final shutdown: drain the endpoint for at most `force_after`, stop tunnels, then end.
    Shutdown {
        force_after: Duration,
        done: oneshot::Sender<()>,
    },
    /// The computer is going to sleep: sleep never counts toward an outage's grace period.
    SuspendLossNotices,
    /// Back from sleep: an outage that survived it gets a fresh full grace period.
    ResumeLossNotices,
}

/// A handle to the lifecycle actor. Clones share one actor.
#[derive(Clone)]
pub struct Connection {
    commands: mpsc::UnboundedSender<Command>,
    status: watch::Receiver<Arc<ConnectionStatus>>,
    lost: broadcast::Sender<SurfaceId>,
}

/// The actor task, owned by whoever owns shutdown.
pub struct ConnectionTask(JoinHandle<()>);

impl Connection {
    /// Starts the actor on the current Tokio runtime. With `ui.autoConnect` on it connects at
    /// once: the local endpoint binds before secrets are read or a tunnel starts.
    pub fn spawn(deps: ConnectionDeps) -> (Self, ConnectionTask) {
        let (commands, inbox) = mpsc::unbounded_channel();
        let (publish, status) = watch::channel(Arc::new(initial_status()));
        let (lost, _) = broadcast::channel(16);
        let task = tokio::spawn(run(deps, inbox, publish, lost.clone()));
        let connection = Self {
            commands,
            status,
            lost,
        };
        (connection, ConnectionTask(task))
    }

    #[cfg(test)]
    fn spawn_with<P: ports::Ports>(
        ports: P,
        config: watch::Receiver<Arc<Config>>,
        logger: Logger,
    ) -> (Self, ConnectionTask) {
        let (commands, inbox) = mpsc::unbounded_channel();
        let (publish, status) = watch::channel(Arc::new(initial_status()));
        let (lost, _) = broadcast::channel(16);
        let actor = Actor::new(ports, config, logger, inbox, publish, lost.clone());
        let task = tokio::spawn(actor.run());
        let connection = Self {
            commands,
            status,
            lost,
        };
        (connection, ConnectionTask(task))
    }

    pub fn status(&self) -> watch::Receiver<Arc<ConnectionStatus>> {
        self.status.clone()
    }

    /// The surface of each established tunnel that stayed down for 30 s, once per outage.
    /// Retries and failures of a tunnel that never connected are not announced.
    pub fn connection_lost(&self) -> broadcast::Receiver<SurfaceId> {
        self.lost.subscribe()
    }

    pub fn suspend_loss_notices(&self) {
        self.send(Command::SuspendLossNotices);
    }

    pub fn resume_loss_notices(&self) {
        self.send(Command::ResumeLossNotices);
    }

    pub fn connect(&self) {
        self.send(Command::Connect);
    }

    pub fn disconnect(&self) {
        self.send(Command::Disconnect);
    }

    /// Shutdown phase 1. Returns when the endpoint has drained and tunnels have stopped, or
    /// at once if the actor is already gone.
    pub async fn shutdown(&self, force_after: Duration) {
        let (done, finished) = oneshot::channel();
        self.send(Command::Shutdown { force_after, done });
        let _ = finished.await;
    }

    fn send(&self, command: Command) {
        // A closed inbox means the actor ended; the command has nothing left to act on.
        let _ = self.commands.send(command);
    }
}

impl ConnectionTask {
    pub async fn join(self) {
        // A panicked actor already published its last status; there is nothing to recover.
        let _ = self.0.await;
    }
}

/// The status until the actor's first publication, which describes the three surfaces. That
/// needs the live grants, so it is built in the actor's task rather than on the startup path.
fn initial_status() -> ConnectionStatus {
    ConnectionStatus {
        state: ConnectionState::Disconnected,
        detail: String::new(),
        public_url: None,
        local_url: None,
        handshake_at: None,
        last_request_at: None,
        last_tool_call_at: None,
        health: None,
        route_settling_until: None,
        surfaces: Vec::new(),
    }
}

async fn run(
    deps: ConnectionDeps,
    inbox: mpsc::UnboundedReceiver<Command>,
    publish: watch::Sender<Arc<ConnectionStatus>>,
    lost: broadcast::Sender<SurfaceId>,
) {
    let ConnectionDeps {
        config,
        kernel,
        secrets,
        logger,
    } = deps;
    let ports = McpPorts::new(kernel, config.clone(), logger.clone(), secrets);
    Actor::new(ports, config, logger, inbox, publish, lost)
        .run()
        .await;
}
