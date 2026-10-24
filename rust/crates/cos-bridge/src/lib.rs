//! The local bridge between the browser extension and this app (`src/main/bridge.ts`, protocol
//! 14). Unit E2.1 owns the transport; every other Track 2 unit adds a route family in
//! `families/`.
//!
//! It is a second loopback server beside the MCP endpoint because the two need opposite things:
//! the endpoint refuses every browser origin, and this one exists to be called by an extension.
//! What keeps it safe:
//!
//! - 127.0.0.1 only.
//! - The only unauthenticated routes are `/hello`, a fixed self-description, and `/pair`, which
//!   issues the bearer token to any caller on loopback. Any program already running as this user
//!   can therefore get the token. With it, it can read recorded ChatGPT activity and queue work
//!   for the browser, but no route reads a file, runs a process or changes a permission.
//! - Every other route needs that token, compared in constant time and stored encrypted in
//!   `secrets.bin`, never in `config.json`.
//! - An Origin, when present, must be `chrome-extension://`, so a web page cannot drive it.
//! - Bodies are capped and requests are rate limited.

mod extension;
pub mod families;
mod gate;
mod lifecycle;
mod limits;
mod pairing;
mod ports;
mod presence;
mod router;
mod server;
mod wake;

use std::sync::{Arc, Mutex, PoisonError};

use cos_secrets::SecretStore;
use cos_store::{BridgePortOverride, Logger};
use cos_tools::{Admission, EpochMs};
use cos_types::app_state::{BridgeStatus, CosExtension};
use cos_types::bridge::WakeHost;
use cos_types::config::Config;
use tokio::sync::{Notify, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

pub use extension::{ExtensionFolder, PreparedUpdate, UpdateOffer};
pub use gate::Peer;
pub use limits::{BodyRefusal, MAX_BODY_BYTES, RATE_LIMIT};
pub use ports::{PortSelection, auto_ports};
pub use router::{BoxFuture, Exchange, Family, Methods, Reply, Route, Routes};
pub use wake::Wake;

use crate::limits::RateWindow;
use crate::pairing::Pairing;
use crate::presence::Presence;
use crate::wake::Hub;

pub struct BridgeDeps {
    pub app_version: &'static str,
    /// The bridge follows `ui.browserBridgePort` itself.
    pub config: watch::Receiver<Arc<Config>>,
    /// The Core's one secret store, shared with the connection owner. Two stores on one
    /// profile would each write back a stale map and lose the other's keys.
    pub secrets: Arc<Mutex<SecretStore>>,
    /// Routed requests answer `503 bridge_recovering` until restore has finished.
    pub admission: Admission,
    pub logger: Logger,
    pub extension: ExtensionFolder,
    /// `CLF_BRIDGE_PORTS`, read once at the process boundary.
    pub ports_override: Option<BridgePortOverride>,
}

/// The bridge owner's handle: status, the wake socket and Disconnect. Cloned freely.
#[derive(Clone)]
pub struct Bridge {
    shared: Arc<Shared>,
}

/// The running listener. Only its one owner may stop it.
pub struct BridgeTask {
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl Bridge {
    /// Builds the owner without touching the network or the disk.
    pub fn new(deps: BridgeDeps) -> Self {
        let changed = Arc::new(Notify::new());
        let overridden = deps.ports_override.is_some();
        let shared = Shared {
            app_version: deps.app_version,
            logger: deps.logger.clone(),
            pairing: Arc::new(Pairing::new(deps.secrets)),
            presence: Presence::default(),
            rate: Mutex::new(RateWindow::new(Instant::now())),
            hub: Arc::new(Hub::new(changed.clone(), deps.logger)),
            admission: deps.admission,
            extension: deps.extension,
            config: deps.config,
            ports_override: deps.ports_override,
            overridden,
            changed,
            listening: Mutex::default(),
            status: watch::Sender::new(Arc::new(stopped_status(overridden))),
        };
        Self {
            shared: Arc::new(shared),
        }
    }

    /// Binds the first free port of the selection and serves `routes` on the current Tokio
    /// runtime. A port that cannot be bound is reported in status; the bridge tries again on
    /// the next config change.
    pub fn spawn(&self, routes: Routes) -> BridgeTask {
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(lifecycle::run(
            self.shared.clone(),
            Arc::new(routes),
            stopped,
        ));
        BridgeTask { stop, task }
    }

    pub fn status(&self) -> watch::Receiver<Arc<BridgeStatus>> {
        self.shared.status.subscribe()
    }

    pub fn wake(&self) -> Wake {
        Wake(self.shared.hub.clone())
    }

    pub fn extension(&self) -> &ExtensionFolder {
        &self.shared.extension
    }

    /// `unpair`, the Disconnect button: latches the token slot, so no browser gets a token until
    /// one reconnects explicitly, and closes every wake socket.
    pub async fn disconnect(&self) -> Result<(), cos_secrets::Error> {
        self.shared.pairing.disconnect().await?;
        self.shared.presence.forget_sightings();
        self.shared.hub.revoke();
        self.shared.logger.info("bridge: browser disconnected");
        self.shared.changed.notify_one();
        Ok(())
    }
}

impl BridgeTask {
    /// Shutdown phase 1: closes the wake sockets, then drains accepted requests for at most
    /// 15 s, as `drainBridgeListener` does.
    pub async fn shutdown(self) {
        let _ = self.stop.send(());
        // A run task that already ended (or panicked) has nothing left to stop.
        let _ = self.task.await;
    }
}

/// What every request and the run task read. Each fact has one writer; status is composed
/// from all of them and published through one sender.
pub(crate) struct Shared {
    pub(crate) app_version: &'static str,
    pub(crate) logger: Logger,
    pub(crate) pairing: Arc<Pairing>,
    pub(crate) presence: Presence,
    pub(crate) rate: Mutex<RateWindow>,
    pub(crate) hub: Arc<Hub>,
    pub(crate) admission: Admission,
    pub(crate) extension: ExtensionFolder,
    pub(crate) config: watch::Receiver<Arc<Config>>,
    pub(crate) ports_override: Option<BridgePortOverride>,
    pub(crate) overridden: bool,
    /// `changed()` in `bridge.ts`: some fact moved, publish status again.
    pub(crate) changed: Arc<Notify>,
    listening: Mutex<Listening>,
    status: watch::Sender<Arc<BridgeStatus>>,
}

/// The listener's facts, written only by the run task.
#[derive(Clone, Debug, Default)]
pub(crate) struct Listening {
    pub(crate) port: Option<u16>,
    pub(crate) error: Option<String>,
}

impl Shared {
    pub(crate) fn set_listening(&self, listening: Listening) {
        *self
            .listening
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = listening;
    }

    pub(crate) fn listening(&self) -> Listening {
        self.listening
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn rate_exceeded(&self) -> bool {
        self.rate
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .exceeded(Instant::now())
    }

    /// Publishes the current status and returns when a presence runs out, so the run task can
    /// publish again at that moment.
    pub(crate) fn publish(&self) -> Option<EpochMs> {
        let listening = self.listening();
        let running = listening.port.is_some();
        let sighting = self.presence.sighting(EpochMs::now());
        let now = Instant::now();
        let next = BridgeStatus {
            port_overridden: Some(self.overridden),
            error: Some(listening.error),
            running,
            port: listening.port,
            paired: self.pairing.paired(),
            present: running && (sighting.recent || self.hub.connected(None, now)),
            last_seen_at: sighting.last_seen_at.map(|at| at.0),
            extension_version: sighting.extension_version,
            external_extension: Some(None),
            cos_extension: Some(CosExtension {
                present: running
                    && (sighting.cos_recent || self.hub.connected(Some(WakeHost::Cos), now)),
            }),
        };
        self.status.send_if_modified(|current| {
            let differs = **current != next;
            if differs {
                *current = Arc::new(next);
            }
            differs
        });
        sighting.next_expiry
    }
}

fn stopped_status(overridden: bool) -> BridgeStatus {
    BridgeStatus {
        port_overridden: Some(overridden),
        error: Some(None),
        running: false,
        port: None,
        paired: false,
        present: false,
        last_seen_at: None,
        extension_version: None,
        external_extension: Some(None),
        cos_extension: Some(CosExtension { present: false }),
    }
}
