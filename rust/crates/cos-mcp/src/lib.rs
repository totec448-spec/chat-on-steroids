//! The Core MCP endpoint: Streamable HTTP on loopback. Unit C1.1 owns this crate (port of
//! `src/main/mcp/server.ts` and `inbound.ts`).
//!
//! One listener serves all three surfaces at `/mcp/<surface>/<token>`, each with its own
//! 32-byte base64url token regenerated per generation. Before any MCP handling a request must
//! carry a known path token, a loopback `Host`, a loopback `Origin` if it has one, and a body
//! of at most 8 MiB. The endpoint keeps no MCP session and serves both protocol eras the SDK
//! does. A 2025-era request is answered with one SSE `message` frame per request, and
//! `tools/list` works without `initialize`. A 2026-07-28 request carries the `_meta` envelope
//! and is answered with one JSON body, except `subscriptions/listen`, which stays open until
//! the client leaves or the endpoint stops. The first request from each new client logs the
//! protocol it speaks and the name it gives. RFC 9728 metadata is served at
//! `/.well-known/oauth-protected-resource/mcp/<surface>/<token>` only.
//!
//! JSON-RPC envelopes are written in the TypeScript app's key order: a result is
//! `{"result", "jsonrpc", "id"}`, an error `{"jsonrpc", "id", "error"}`, and a Host or Origin
//! refusal `{"jsonrpc", "error", "id": null}`. The listener's own refusals are
//! `{"error": "<code>"}` with the codes in [`Refusal`].

mod guards;
mod modern;
mod port;
mod rpc;
mod service;

use std::io;
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cos_http::{Drain, Drained, Listener, ListenerOptions};
use cos_store::Logger;
use cos_tools::{Kernel, SurfaceId};
use cos_types::config::Config;
use http::StatusCode;
use tokio::sync::watch;

use crate::port::Dispatch;
use crate::service::{Endpoint, PRM_PREFIX, Route, Shared};

/// The body cap, by `content-length` and while reading a chunked body.
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

const SELF_TEST_HEADER: &str = "x-local-self-test";
const TUNNEL_PROBE_HEADER: &str = "x-local-tunnel-probe";

pub struct EndpointDeps {
    pub kernel: Arc<Kernel>,
    /// The Settings owner's published config. The metadata document names the connector with
    /// the live `connectorSuffix`.
    pub config: watch::Receiver<Arc<Config>>,
    pub logger: Logger,
    /// Frozen into every call this generation accepts (`Inbound::setup_profile_id`).
    pub setup_profile_id: Option<String>,
}

/// The local URL of each surface, secret path included.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurfaceUrls {
    pub core: String,
    pub desktop: String,
    pub plugins: String,
}

impl SurfaceUrls {
    pub fn of(&self, surface: SurfaceId) -> &str {
        match surface {
            SurfaceId::Core => &self.core,
            SurfaceId::Desktop => &self.desktop,
            SurfaceId::Plugins => &self.plugins,
        }
    }
}

/// Per-generation header values that mark the app's own requests: the connection self-test
/// and the tunnel probe (C1.10 sends them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProbeHeaders {
    pub self_test: (&'static str, String),
    pub tunnel_probe: (&'static str, String),
}

/// A refusal the listener answers itself, before JSON-RPC: `{"error": "<code>"}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// 404: unknown path, wrong token, trailing slash.
    NotFound,
    /// 413.
    PayloadTooLarge,
    /// 400.
    InvalidJson,
    /// 503 with `connection: close`: a request on a kept-alive connection during drain.
    ServerStopping,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::PayloadTooLarge => "payload_too_large",
            Self::InvalidJson => "invalid_json",
            Self::ServerStopping => "server_stopping",
        }
    }

    pub fn status(self) -> StatusCode {
        match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::InvalidJson => StatusCode::BAD_REQUEST,
            Self::ServerStopping => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

/// One endpoint generation: a listener, three tokens, and the kernel it hands calls to.
pub struct McpEndpoint {
    listener: Listener,
    urls: SurfaceUrls,
    probe: ProbeHeaders,
    shared: Arc<Shared>,
}

impl McpEndpoint {
    /// Binds `127.0.0.1:0`, mints this generation's tokens and starts serving. Calls
    /// `Kernel::begin_generation` first, so exposure and the clocks start empty.
    pub async fn start(deps: EndpointDeps) -> io::Result<Self> {
        Self::start_with(deps.kernel, deps.config, deps.logger, deps.setup_profile_id).await
    }

    pub(crate) async fn start_with<K: Dispatch>(
        kernel: Arc<K>,
        config: watch::Receiver<Arc<Config>>,
        logger: Logger,
        setup_profile_id: Option<String>,
    ) -> io::Result<Self> {
        kernel.begin_generation();
        let probe = ProbeHeaders {
            self_test: (SELF_TEST_HEADER, hex(&random::<16>()?)),
            tunnel_probe: (TUNNEL_PROBE_HEADER, hex(&random::<16>()?)),
        };
        let mut routes = Vec::with_capacity(SurfaceId::ALL.len());
        for &surface in SurfaceId::ALL {
            let token = URL_SAFE_NO_PAD.encode(random::<32>()?);
            let path = format!("/mcp/{}/{token}", surface.as_str());
            routes.push(Route {
                surface,
                prm_path: format!("{PRM_PREFIX}{path}"),
                path,
            });
        }
        let shared = Arc::new(Shared::new(logger.clone()));
        let endpoint = Arc::new(Endpoint {
            kernel,
            routes,
            port: OnceLock::new(),
            probe: probe.clone(),
            config,
            setup_profile_id,
            shared: shared.clone(),
        });
        let listener =
            Listener::bind_loopback(endpoint.clone(), ListenerOptions::default()).await?;
        let port = listener.local_addr().port();
        let _ = endpoint.port.set(port);
        logger.info(&format!("server started on 127.0.0.1:{port}"));
        let url = |surface: SurfaceId| {
            let path = endpoint
                .routes
                .iter()
                .find(|route| route.surface == surface)
                .map_or("", |route| route.path.as_str());
            format!("http://127.0.0.1:{port}{path}")
        };
        let urls = SurfaceUrls {
            core: url(SurfaceId::Core),
            desktop: url(SurfaceId::Desktop),
            plugins: url(SurfaceId::Plugins),
        };
        Ok(Self {
            listener,
            urls,
            probe,
            shared,
        })
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().port()
    }

    pub fn urls(&self) -> &SurfaceUrls {
        &self.urls
    }

    pub fn probe_headers(&self) -> &ProbeHeaders {
        &self.probe
    }

    /// Stops accepting and drains. Disconnect passes `Drain::Graceful`; final shutdown bounds
    /// it with `Drain::ForceAfter(30 s)`. A request whose body is still arriving, or that
    /// arrives on a kept-alive connection from here on, is refused with `server_stopping`.
    pub async fn stop(self, drain: Drain) -> Drained {
        let logger = self.shared.logger.clone();
        self.shared.stopping.send_replace(true);
        let accepted = self.shared.accepted.load(Ordering::Relaxed);
        logger.info(&format!(
            "server stopping: draining {accepted} accepted response(s)"
        ));
        let drained = self.listener.shutdown(drain).await;
        if let (Drain::ForceAfter(limit), Drained::Forced { .. }) = (drain, drained) {
            logger.warn(&format!(
                "server drain timed out after {}ms during final shutdown; forcing remaining connections closed",
                limit.as_millis()
            ));
        }
        logger.info("server stopped");
        drained
    }
}

fn random<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests;
