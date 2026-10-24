//! The opt-in local control API on loopback. Unit C1.9 owns this crate (port of
//! `src/main/control-{api,reads,actions,stream}.ts`).
//!
//! It owns no fact. Every route reads a snapshot or a store another owner publishes. It owns
//! only its listener, its per-launch token, `control-api/endpoint.json`, and its rate limits.
//! The token file is written before `endpoint.json`, and `endpoint.json` is removed first on
//! stop, so a reader that finds an endpoint always finds its token.
//!
//! The API follows `controlApi.enabled` itself: it starts, stops and restarts as the published
//! config changes, without the Core's startup or Settings code knowing about it.

mod actions;
mod files;
mod inputs;
mod iso;
mod limits;
mod query;
mod reads;
mod reply;
mod server;
mod sessions;
mod stream;
mod text;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use cos_http::{Drain, Listener, ListenerOptions};
use cos_store::{AppPaths, Logger};
use cos_tools::{Admission, EpochMs, Kernel};
use cos_types::app_state::{BridgeStatus, ConnectionStatus};
use cos_types::config::Config;
use cos_types::control_api::{CONTROL_API_PROTOCOL, ControlApiEndpoint};
use cos_types::session::SwarmState;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

use crate::files::{EndpointFiles, Token};
use crate::server::{Server, Timing};

pub struct ControlApiDeps {
    pub paths: AppPaths,
    pub app_version: &'static str,
    pub started_at: EpochMs,
    pub config: watch::Receiver<Arc<Config>>,
    pub connection: watch::Receiver<Arc<ConnectionStatus>>,
    /// The browser bridge, for the `bridge` object of `/v1/status`.
    pub bridge: watch::Receiver<Arc<BridgeStatus>>,
    /// The agent broker, for `/v1/agents`.
    pub agents: watch::Receiver<Arc<SwarmState>>,
    pub sessions: cos_sessions::SessionStore,
    /// The message outbox: `/v1/inputs`, its send and its cancel.
    pub inputs: cos_input::Outbox,
    pub kernel: Arc<Kernel>,
    pub logger: Logger,
    /// Session reads wait behind the startup fence; `/v1/health` does not.
    pub admission: Admission,
}

/// The running API owner. Dropping it without [`ControlApi::shutdown`] leaves the endpoint
/// files in place.
pub struct ControlApi {
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl ControlApi {
    /// Starts following `controlApi.enabled` on the current Tokio runtime.
    pub fn spawn(deps: ControlApiDeps) -> Self {
        Self::spawn_shared(Arc::new(Shared::from(deps)), Timing::default())
    }

    fn spawn_shared(shared: Arc<Shared>, timing: Timing) -> Self {
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(run(shared, stopped, timing));
        Self { stop, task }
    }

    /// Shutdown phase 1: removes `endpoint.json`, then the token, then drains (2 s bound).
    pub async fn shutdown(self) {
        let _ = self.stop.send(());
        // A run task that already ended (or panicked) has nothing left to stop.
        let _ = self.task.await;
    }
}

/// What every route reads, shared by the listeners this owner starts.
pub(crate) struct Shared {
    pub(crate) paths: AppPaths,
    pub(crate) app_version: &'static str,
    pub(crate) started_at: EpochMs,
    pub(crate) config: watch::Receiver<Arc<Config>>,
    pub(crate) connection: watch::Receiver<Arc<ConnectionStatus>>,
    pub(crate) bridge: watch::Receiver<Arc<BridgeStatus>>,
    pub(crate) agents: watch::Receiver<Arc<SwarmState>>,
    pub(crate) sessions: Arc<dyn sessions::Sessions>,
    pub(crate) inputs: Arc<dyn inputs::Inputs>,
    pub(crate) kernel: Arc<Kernel>,
    pub(crate) logger: Logger,
    pub(crate) admission: Admission,
}

/// One bound listener and what stops it.
struct Running {
    listener: Listener,
    stopping: watch::Sender<bool>,
}

impl From<ControlApiDeps> for Shared {
    fn from(deps: ControlApiDeps) -> Self {
        Self {
            paths: deps.paths,
            app_version: deps.app_version,
            started_at: deps.started_at,
            config: deps.config,
            connection: deps.connection,
            bridge: deps.bridge,
            agents: deps.agents,
            sessions: Arc::new(deps.sessions),
            inputs: Arc::new(deps.inputs),
            kernel: deps.kernel,
            logger: deps.logger,
            admission: deps.admission,
        }
    }
}

async fn run(shared: Arc<Shared>, mut stopped: oneshot::Receiver<()>, timing: Timing) {
    let files = EndpointFiles::under(shared.paths.user_data());
    let mut config = shared.config.clone();
    let mut running: Option<Running> = None;
    loop {
        let enabled = config.borrow_and_update().control_api.enabled;
        if enabled && running.is_none() {
            running = start(&shared, &files, timing).await;
        } else if !enabled && running.is_some() {
            stop(&shared, &files, running.take(), timing).await;
        }
        tokio::select! {
            _ = &mut stopped => break,
            changed = config.changed() => {
                if changed.is_err() {
                    // Settings is gone; nothing will change until the Core stops this owner.
                    let _ = (&mut stopped).await;
                    break;
                }
            }
        }
    }
    stop(&shared, &files, running.take(), timing).await;
}

async fn start(shared: &Arc<Shared>, files: &EndpointFiles, timing: Timing) -> Option<Running> {
    let started = async {
        let token = Token::generate()?;
        let (stopping, stopping_seen) = watch::channel(false);
        let server = Arc::new(Server::new(
            shared.clone(),
            timing,
            token.clone(),
            stopping_seen,
        ));
        let options = ListenerOptions {
            header_read_timeout: std::time::Duration::from_secs(15),
        };
        let listener = Listener::bind_loopback(server.clone(), options).await?;
        let port = listener.local_addr().port();
        server.bound(port);
        let endpoint = ControlApiEndpoint {
            protocol: CONTROL_API_PROTOCOL,
            port,
            pid: std::process::id(),
            app_version: shared.app_version.to_owned(),
            started_at: iso::iso_time(EpochMs::now()),
        };
        let running = Running { listener, stopping };
        // Token before endpoint: a caller that finds the endpoint can always read its token.
        if let Err(error) = files.publish(&token, &endpoint).await {
            running
                .listener
                .shutdown(Drain::ForceAfter(timing.drain))
                .await;
            let _ = files.remove().await;
            return Err(error);
        }
        Ok::<_, std::io::Error>((running, port))
    };
    match started.await {
        Ok((running, port)) => {
            shared
                .logger
                .info(&format!("control API listening on 127.0.0.1:{port}"));
            Some(running)
        }
        Err(error) => {
            shared
                .logger
                .warn(&format!("control API could not start: {error}"));
            None
        }
    }
}

/// Endpoint, then token, then every open stream, then the connections still serving.
async fn stop(shared: &Shared, files: &EndpointFiles, running: Option<Running>, timing: Timing) {
    if let Err(error) = files.remove().await {
        shared
            .logger
            .warn(&format!("control API files were not removed: {error}"));
    }
    let Some(Running { listener, stopping }) = running else {
        return;
    };
    // A stream never finishes on its own; without this the drain would wait out its grace.
    let _ = stopping.send(true);
    listener.shutdown(Drain::ForceAfter(timing.drain)).await;
    shared.logger.info("control API stopped");
}
