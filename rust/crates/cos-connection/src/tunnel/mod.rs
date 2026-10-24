//! Tunnel adapters (`src/main/tunnel/index.ts`). The MCP endpoint knows nothing about
//! tunnels; an adapter makes one loopback URL reachable from ChatGPT and reports its state.
//!
//! - `manual`: the user exposes the URL with their own tunnel; nothing runs.
//! - `openai`: OpenAI's Secure MCP Tunnel (`tunnel-client`), supervised and health-polled.
//! - `cloudflared`: a public quick tunnel, where the secret path token keeps the URL private.

mod cloudflared;
mod health;
mod locate;
mod openai;
mod process;

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use cos_store::Logger;
use cos_types::app_state::{ConnectionState, SurfaceId, TunnelHealth};
use cos_types::config::{TunnelKind, TunnelSettings};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

#[cfg(test)]
pub(crate) use health::get as health_get;
pub(crate) use health::shared_tunnel_ids;
pub(crate) use openai::ROUTE_SETTLE_MS;
pub(crate) use process::Host;

/// The transport a connection runs on, normalized so that only fields that change Core's
/// transport compare (`coreTransport`). Editing a hidden OpenAI id while cloudflared is active
/// is not a different transport.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Transport {
    /// The user exposes the local URL with their own tunnel; no process runs.
    Manual,
    Cloudflared {
        binary_path: String,
    },
    OpenAi {
        tunnel_id: String,
        binary_path: String,
        profile_epoch: u64,
    },
}

impl Transport {
    pub fn of(settings: &TunnelSettings) -> Self {
        match settings.kind {
            TunnelKind::Manual => Self::Manual,
            TunnelKind::Cloudflared => Self::Cloudflared {
                binary_path: settings.binary_path.clone(),
            },
            TunnelKind::Openai => Self::OpenAi {
                tunnel_id: settings.tunnel_id.clone(),
                binary_path: settings.binary_path.clone(),
                profile_epoch: settings.profile_epoch.unwrap_or(0),
            },
        }
    }

    /// cloudflared and a manual proxy publish one whole origin, so the optional surfaces are
    /// projections of Core's tunnel. OpenAI needs one tunnel per surface.
    pub fn shares_origin(&self) -> bool {
        !matches!(self, Self::OpenAi { .. })
    }
}

/// One state report from an adapter. A field that is `None` leaves the published value as it
/// was; `Some(None)` clears it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TunnelReport {
    pub state: ConnectionState,
    pub detail: String,
    pub public_url: Option<Option<String>>,
    pub handshake_at: Option<Option<u64>>,
    pub health: Option<Option<TunnelHealth>>,
    /// A new tunnel-client process connected for the first time: OpenAI moves existing chats
    /// to it only after a few seconds (`noteTunnelClientConnected`).
    pub new_client: bool,
}

impl TunnelReport {
    pub fn new(state: ConnectionState, detail: impl Into<String>) -> Self {
        Self {
            state,
            detail: detail.into(),
            public_url: None,
            handshake_at: None,
            health: None,
            new_client: false,
        }
    }
}

pub(crate) const MANUAL_DETAIL: &str =
    "Local server running. Expose it with your own tunnel and use the URL below.";

/// A report tagged with the tunnel lifetime that sent it.
pub(crate) struct Reported {
    pub lifetime: u64,
    pub report: TunnelReport,
}

/// Where an adapter sends its reports. The lifecycle accepts a report only while the
/// lifetime that sent it is still current.
#[derive(Clone)]
pub(crate) struct Reporter {
    sender: mpsc::UnboundedSender<Reported>,
    lifetime: u64,
}

impl Reporter {
    pub fn new(sender: mpsc::UnboundedSender<Reported>, lifetime: u64) -> Self {
        Self { sender, lifetime }
    }

    pub fn send(&self, report: TunnelReport) {
        // A closed channel means the lifecycle ended; nobody is left to tell.
        let _ = self.sender.send(Reported {
            lifetime: self.lifetime,
            report,
        });
    }
}

/// Everything an adapter needs for one tunnel lifetime.
pub(crate) struct Launch {
    /// The loopback MCP URL, secret path included.
    pub local_url: String,
    pub transport: Transport,
    /// The OpenAI control-plane key; only the OpenAI adapter reads it.
    pub api_key: Option<String>,
    /// Added only to tunnel-client's own MCP discovery and startup probes.
    pub discovery_header: (String, String),
    pub surface: SurfaceId,
    pub host: Arc<Host>,
    pub logger: Logger,
    pub reporter: Reporter,
}

/// A running tunnel, owned by the lifecycle until it is stopped.
pub(crate) enum TunnelHandle {
    Manual,
    /// A supervisor task that owns the child process tree.
    Supervised {
        stop: oneshot::Sender<()>,
        task: JoinHandle<()>,
    },
}

impl TunnelHandle {
    fn supervised(run: impl FnOnce(oneshot::Receiver<()>) -> JoinHandle<()>) -> Self {
        let (stop, stopped) = oneshot::channel();
        Self::Supervised {
            stop,
            task: run(stopped),
        }
    }

    /// Stops the process tree and waits until it is gone.
    pub async fn stop(self) {
        match self {
            Self::Manual => {}
            Self::Supervised { stop, task } => {
                // A supervisor that already ended has nothing left to stop.
                let _ = stop.send(());
                let _ = task.await;
            }
        }
    }
}

/// Why a tunnel could not start; the text is shown to the user as is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TunnelError(pub String);

/// Starts the adapter for `launch.transport`.
pub(crate) fn start(launch: Launch) -> Result<TunnelHandle, TunnelError> {
    match &launch.transport {
        Transport::Manual => {
            let mut report = TunnelReport::new(ConnectionState::Connected, MANUAL_DETAIL);
            report.public_url = Some(None);
            launch.reporter.send(report);
            Ok(TunnelHandle::Manual)
        }
        Transport::Cloudflared { binary_path } => {
            let binary = locate::locate("cloudflared", binary_path, &launch.host).ok_or_else(|| {
                TunnelError(
                    "cloudflared was not found. It ships alongside tunnel-client, or install it from Cloudflare, then point at it in Connection settings."
                        .to_owned(),
                )
            })?;
            Ok(TunnelHandle::supervised(|stopped| {
                tokio::spawn(cloudflared::supervise(binary, launch, stopped))
            }))
        }
        Transport::OpenAi {
            tunnel_id,
            binary_path,
            ..
        } => {
            let binary = locate::locate("tunnel-client", binary_path, &launch.host).ok_or_else(|| {
                TunnelError(
                    "tunnel-client was not found. Install it from github.com/openai/tunnel-client, or point at it in Connection settings."
                        .to_owned(),
                )
            })?;
            if !openai::valid_tunnel_id(tunnel_id) {
                return Err(TunnelError(
                    "Enter a tunnel ID that looks like tunnel_ followed by 32 hex characters."
                        .to_owned(),
                ));
            }
            let Some(api_key) = launch.api_key.clone().filter(|key| !key.is_empty()) else {
                return Err(TunnelError(
                    "Add your OpenAI tunnel API key first.".to_owned(),
                ));
            };
            let work_dir = work_dir(&launch.host).map_err(|error| {
                TunnelError(format!("Could not prepare tunnel-client: {error}"))
            })?;
            let tunnel_id = tunnel_id.clone();
            Ok(TunnelHandle::supervised(|stopped| {
                tokio::spawn(openai::supervise(
                    binary, tunnel_id, api_key, work_dir, launch, stopped,
                ))
            }))
        }
    }
}

/// `tag` for log lines: two tunnels can run at once, so each line names its connector.
fn tag(surface: SurfaceId) -> String {
    format!("{} tunnel", surface.as_str())
}

/// An empty work folder for one OpenAI supervisor (`mkdtemp(<tmp>/cglf-)`).
fn work_dir(host: &Host) -> std::io::Result<PathBuf> {
    use std::hash::{BuildHasher, RandomState};
    for _ in 0..16 {
        let suffix = RandomState::new().hash_one(std::time::SystemTime::now()) & 0xff_ffff;
        let dir = host.temp_dir.join(format!("cglf-{suffix:06x}"));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::other("no free work folder name"))
}

fn os(value: &str) -> OsString {
    OsString::from(value)
}
