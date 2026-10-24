//! What the lifecycle needs from the rest of the Core: an endpoint per generation, the live
//! grants and the kernel's clocks. The production ports wrap `cos_mcp::McpEndpoint` and the
//! kernel; tests drive the lifecycle with gated fakes, the way `connection.test.ts` does.

use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use cos_http::{Drain, Drained};
use cos_mcp::{EndpointDeps, McpEndpoint, SurfaceUrls};
use cos_secrets::{SecretKey, SecretStore};
use cos_store::{Logger, Platform};
use cos_tools::{GrantEnv, Grants, Kernel, SurfaceId};
use cos_types::config::Config;

use crate::surfaces::Clocks;
use crate::tunnel::Host;

pub(crate) type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// One running endpoint generation.
pub(crate) trait Endpoint: Send + 'static {
    fn urls(&self) -> &SurfaceUrls;
    /// The header that marks tunnel-client's own discovery probes as the app's.
    fn tunnel_probe(&self) -> (String, String);
    fn stop(self, drain: Drain) -> BoxFuture<Drained>;
}

pub(crate) trait Ports: Send + 'static {
    type Endpoint: Endpoint;
    /// Binds a new generation. `setup_profile_id` is frozen into every call it accepts.
    fn start_endpoint(&self, setup_profile_id: String) -> BoxFuture<io::Result<Self::Endpoint>>;
    fn grants(&self, config: &Config) -> Grants;
    fn clocks(&self, surface: SurfaceId) -> Clocks;
    /// The OpenAI tunnel API key of a Setup profile; `None` when it is unset or unreadable.
    fn api_key(&self, profile_id: Option<String>) -> BoxFuture<Option<String>>;
    fn host(&self) -> Arc<Host>;
}

pub(crate) struct McpPorts {
    pub kernel: Arc<Kernel>,
    pub config: watch::Receiver<Arc<Config>>,
    pub logger: Logger,
    pub secrets: Arc<Mutex<SecretStore>>,
    pub host: Arc<Host>,
    /// Grants are read here only for capabilities and features, which do not depend on the
    /// skills folder; the kernel holds the real environment.
    pub env: GrantEnv,
}

impl McpPorts {
    pub fn new(
        kernel: Arc<Kernel>,
        config: watch::Receiver<Arc<Config>>,
        logger: Logger,
        secrets: Arc<Mutex<SecretStore>>,
    ) -> Self {
        Self {
            kernel,
            config,
            logger,
            secrets,
            host: Arc::new(Host::current()),
            env: GrantEnv {
                skills_dir: PathBuf::new(),
                platform: Platform::current(),
            },
        }
    }
}

impl Endpoint for McpEndpoint {
    fn urls(&self) -> &SurfaceUrls {
        McpEndpoint::urls(self)
    }

    fn tunnel_probe(&self) -> (String, String) {
        let (name, value) = &self.probe_headers().tunnel_probe;
        ((*name).to_owned(), value.clone())
    }

    fn stop(self, drain: Drain) -> BoxFuture<Drained> {
        Box::pin(McpEndpoint::stop(self, drain))
    }
}

impl Ports for McpPorts {
    type Endpoint = McpEndpoint;

    fn start_endpoint(&self, setup_profile_id: String) -> BoxFuture<io::Result<McpEndpoint>> {
        Box::pin(McpEndpoint::start(EndpointDeps {
            kernel: self.kernel.clone(),
            config: self.config.clone(),
            logger: self.logger.clone(),
            setup_profile_id: Some(setup_profile_id),
        }))
    }

    fn grants(&self, config: &Config) -> Grants {
        Grants::derive(config, &self.env)
    }

    fn clocks(&self, surface: SurfaceId) -> Clocks {
        Clocks {
            request_at: self.kernel.last_request_at(surface).map(|at| at.0),
            tool_call_at: self.kernel.last_tool_call_at(surface).map(|at| at.0),
        }
    }

    fn api_key(&self, profile_id: Option<String>) -> BoxFuture<Option<String>> {
        let secrets = self.secrets.clone();
        // `setupApiKeySlot`: the default setup keeps its key in `openaiApiKey`.
        let key = match profile_id.as_deref() {
            None | Some("default") => SecretKey::OpenaiApiKey,
            Some(id) => SecretKey::Setup(id.to_owned()),
        };
        Box::pin(async move {
            tokio::task::spawn_blocking(move || secrets.lock().ok()?.get(&key))
                .await
                .ok()
                .flatten()
        })
    }

    fn host(&self) -> Arc<Host> {
        self.host.clone()
    }
}
