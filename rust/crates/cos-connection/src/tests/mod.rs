//! The lifecycle through its public handle, with a fake endpoint whose start and drain the
//! test can hold, the way `test/connection.test.ts` gates `startMcpServer`.

use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cos_fs::Roots;
use cos_http::{Drain, Drained};
use cos_mcp::SurfaceUrls;
use cos_store::{Logger, Platform};
use cos_tools::{Capability, CapabilitySet, Feature, FeatureSet, Grants, SurfaceId};
use cos_types::app_state::{
    ConnectionState, ConnectionStatus, SurfaceConnectionState, SurfaceStatus,
};
use cos_types::config::{Capabilities, Config, TunnelKind};
use serde_json::Value;
use tokio::sync::{Semaphore, watch};

use crate::Connection;
use crate::ports::{BoxFuture, Endpoint, Ports};
use crate::surfaces::Clocks;
use crate::tunnel::Host;

mod tunnels;

const WAIT: Duration = Duration::from_secs(5);
const MANUAL: &str = "Local server running. Expose it with your own tunnel and use the URL below.";

#[derive(Default)]
pub(crate) struct Shared {
    generations: AtomicU64,
    /// Setup profile id of each start, in order.
    profiles: Mutex<Vec<String>>,
    /// How each generation was stopped, in order.
    stops: Mutex<Vec<(u64, Drain)>>,
    start_gate: Mutex<Option<Arc<Semaphore>>>,
    stop_gate: Mutex<Option<Arc<Semaphore>>>,
    start_error: Mutex<Option<String>>,
    key_gate: Mutex<Option<Arc<Semaphore>>>,
    key_lookups: Mutex<Vec<Option<String>>>,
    api_key: Mutex<Option<String>>,
    host: Mutex<Arc<Host>>,
}

/// A host whose PATH and install folders hold no tunnel program, so no test can find a real
/// one. Windows needs `SystemRoot` to start any child.
impl Default for Host {
    fn default() -> Self {
        Host::isolated(None)
    }
}

impl Host {
    pub(crate) fn isolated(path: Option<&Path>) -> Self {
        let nowhere = std::env::temp_dir().join("cos-connection-no-tunnel-programs");
        let mut env: Vec<(OsString, OsString)> = ["SystemRoot", "windir", "SystemDrive"]
            .into_iter()
            .filter_map(|name| std::env::var_os(name).map(|value| (name.into(), value)))
            .collect();
        for name in ["ProgramFiles", "LOCALAPPDATA", "USERPROFILE", "HOME"] {
            env.push((name.into(), nowhere.clone().into_os_string()));
        }
        env.push((
            "PATH".into(),
            path.map_or_else(OsString::new, |path| path.as_os_str().to_owned()),
        ));
        Self {
            env,
            temp_dir: std::env::temp_dir(),
            bundled_dir: None,
        }
    }
}

#[derive(Clone, Default)]
struct Fake(Arc<Shared>);

impl Fake {
    fn hold_starts(&self) -> Arc<Semaphore> {
        let gate = Arc::new(Semaphore::new(0));
        *self.0.start_gate.lock().unwrap() = Some(gate.clone());
        gate
    }

    fn hold_stops(&self) -> Arc<Semaphore> {
        let gate = Arc::new(Semaphore::new(0));
        *self.0.stop_gate.lock().unwrap() = Some(gate.clone());
        gate
    }

    fn fail_starts(&self, message: &str) {
        *self.0.start_error.lock().unwrap() = Some(message.to_owned());
    }

    fn starts(&self) -> u64 {
        self.0.generations.load(Ordering::SeqCst)
    }

    fn profiles(&self) -> Vec<String> {
        self.0.profiles.lock().unwrap().clone()
    }

    fn stops(&self) -> Vec<(u64, Drain)> {
        self.0.stops.lock().unwrap().clone()
    }
}

struct FakeEndpoint {
    generation: u64,
    urls: SurfaceUrls,
    shared: Arc<Shared>,
}

impl Endpoint for FakeEndpoint {
    fn urls(&self) -> &SurfaceUrls {
        &self.urls
    }

    fn tunnel_probe(&self) -> (String, String) {
        (
            "x-cos-tunnel-probe".to_owned(),
            format!("probe-{}", self.generation),
        )
    }

    fn stop(self, drain: Drain) -> BoxFuture<Drained> {
        self.shared
            .stops
            .lock()
            .unwrap()
            .push((self.generation, drain));
        let gate = self.shared.stop_gate.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                let _permit = gate.acquire().await;
            }
            Drained::Clean
        })
    }
}

impl Ports for Fake {
    type Endpoint = FakeEndpoint;

    fn start_endpoint(&self, setup_profile_id: String) -> BoxFuture<io::Result<FakeEndpoint>> {
        let shared = self.0.clone();
        Box::pin(async move {
            let gate = shared.start_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.acquire().await.expect("gate open").forget();
            }
            shared.profiles.lock().unwrap().push(setup_profile_id);
            if let Some(message) = shared.start_error.lock().unwrap().clone() {
                return Err(io::Error::other(message));
            }
            let generation = shared.generations.fetch_add(1, Ordering::SeqCst) + 1;
            let url = |surface: &str| {
                format!(
                    "http://127.0.0.1:4567{generation}/mcp/{surface}/{surface}-token-{generation}"
                )
            };
            Ok(FakeEndpoint {
                generation,
                urls: SurfaceUrls {
                    core: url("core"),
                    desktop: url("desktop"),
                    plugins: url("plugins"),
                },
                shared: shared.clone(),
            })
        })
    }

    /// `effectiveCapabilities` and the feature switches, standing in for `Grants::derive`.
    fn grants(&self, config: &Config) -> Grants {
        const WRITE: [Capability; 4] = [
            Capability::Create,
            Capability::Edit,
            Capability::Move,
            Capability::DeleteFile,
        ];
        let mut capabilities = CapabilitySet::EMPTY;
        for &capability in Capability::ALL {
            if config.capabilities.get(capability)
                && !(config.read_only && WRITE.contains(&capability))
            {
                capabilities = capabilities.with(capability);
            }
        }
        let mut features = FeatureSet::default();
        if config.sessions.record {
            features = features.with(Feature::SessionRecording);
        }
        if config.multi_agent.enabled {
            features = features.with(Feature::MultiAgent);
        }
        Grants {
            capabilities,
            read_only: config.read_only,
            features,
            allow_unattributed: false,
            roots: Roots::from_config(&config.roots, Path::new("skills")),
            platform: Platform::Windows,
        }
    }

    fn clocks(&self, _surface: SurfaceId) -> Clocks {
        Clocks::default()
    }

    fn api_key(&self, profile_id: Option<String>) -> BoxFuture<Option<String>> {
        let shared = self.0.clone();
        Box::pin(async move {
            let gate = shared.key_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.acquire().await.expect("gate open").forget();
            }
            shared.key_lookups.lock().unwrap().push(profile_id);
            shared.api_key.lock().unwrap().clone()
        })
    }

    fn host(&self) -> Arc<Host> {
        self.0.host.lock().unwrap().clone()
    }
}

/// The `base` variant's seeded config from the golden corpus.
fn base_config() -> Config {
    let file = concat!(env!("CARGO_MANIFEST_DIR"), "/../../golden/base/config.json");
    let recorded: Value =
        serde_json::from_slice(&std::fs::read(file).expect("corpus config")).expect("corpus json");
    cos_store::config::parse_config(&recorded["config"]).expect("the seeded config parses")
}

struct Harness {
    fake: Fake,
    connection: Connection,
    status: watch::Receiver<Arc<ConnectionStatus>>,
    config: watch::Sender<Arc<Config>>,
    logger: Logger,
    task: Option<crate::ConnectionTask>,
}

impl Harness {
    fn start(config: Config) -> Self {
        Self::start_with(Fake::default(), config)
    }

    fn start_with(fake: Fake, config: Config) -> Self {
        let (config, receiver) = watch::channel(Arc::new(config));
        let logger = Logger::with_clock(|| 0, false);
        let (connection, task) = Connection::spawn_with(fake.clone(), receiver, logger.clone());
        let status = connection.status();
        Self {
            fake,
            connection,
            status,
            config,
            logger,
            task: Some(task),
        }
    }

    async fn until(
        &mut self,
        what: &str,
        done: impl Fn(&ConnectionStatus) -> bool,
    ) -> Arc<ConnectionStatus> {
        let waited = tokio::time::timeout(WAIT, self.status.wait_for(|status| done(status)))
            .await
            .map(|seen| seen.map(|status| status.clone()));
        match waited {
            Ok(Ok(status)) => status,
            _ => panic!("{what}; last status: {:#?}", self.status.borrow()),
        }
    }

    async fn connected(&mut self) -> Arc<ConnectionStatus> {
        self.until("connected", |status| {
            status.state == ConnectionState::Connected
        })
        .await
    }

    async fn disconnected(&mut self, detail: &str) -> Arc<ConnectionStatus> {
        self.until("disconnected", |status| {
            status.state == ConnectionState::Disconnected
                && status.detail == detail
                && !status.surfaces.is_empty()
        })
        .await
    }

    fn edit(&self, change: impl FnOnce(&mut Config)) {
        self.config
            .send_modify(|config| change(Arc::make_mut(config)));
    }

    fn logged(&self, message: &str) -> bool {
        self.logger
            .entries()
            .iter()
            .any(|entry| entry.message == message)
    }

    async fn until_logged(&self, message: &str) {
        for _ in 0..250 {
            if self.logged(message) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("never logged {message:?}");
    }

    async fn join(&mut self) {
        let task = self.task.take().expect("joined once");
        tokio::time::timeout(WAIT, task.join())
            .await
            .expect("the actor ends");
    }
}

fn surface(status: &ConnectionStatus, id: SurfaceId) -> &SurfaceStatus {
    status
        .surfaces
        .iter()
        .find(|surface| surface.id == id)
        .expect("every surface is described")
}

fn set(capabilities: &mut Capabilities, capability: Capability, on: bool) {
    let flag = match capability {
        Capability::Browse => &mut capabilities.browse,
        Capability::Search => &mut capabilities.search,
        Capability::Read => &mut capabilities.read,
        Capability::Metadata => &mut capabilities.metadata,
        Capability::Create => &mut capabilities.create,
        Capability::Edit => &mut capabilities.edit,
        Capability::Move => &mut capabilities.move_,
        Capability::DeleteFile => &mut capabilities.delete_file,
        Capability::Command => &mut capabilities.command,
        Capability::Screen => &mut capabilities.screen,
        Capability::Control => &mut capabilities.control,
        Capability::ClipboardRead => &mut capabilities.clipboard_read,
        Capability::ClipboardWrite => &mut capabilities.clipboard_write,
    };
    *flag = on;
}

fn manual(auto_connect: bool) -> Config {
    let mut config = base_config();
    config.ui.auto_connect = auto_connect;
    config
}

/// The `connection` object of `base/api/status.json`, the fields `/v1/status` projects.
#[tokio::test]
async fn auto_connect_in_manual_mode_matches_the_recorded_status() {
    let mut harness = Harness::start(base_config());
    let status = harness.connected().await;

    let file = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../golden/base/api/status.json"
    );
    let recorded: Value =
        serde_json::from_slice(&std::fs::read(file).expect("corpus status")).expect("corpus json");
    let expected = &recorded["response"]["body"]["connection"];
    assert_eq!(status.state.as_str(), expected["state"]);
    assert_eq!(status.detail, expected["detail"]);
    assert_eq!(status.handshake_at, None);
    assert!(expected["handshakeAt"].is_null());
    let projected: Vec<Value> = status
        .surfaces
        .iter()
        .map(|surface| {
            serde_json::json!({
                "id": surface.id.as_str(),
                "state": surface.state.as_str(),
                "available": surface.available,
                "optional": surface.optional,
                "detail": surface.detail,
                "tools": surface.tools.len(),
            })
        })
        .collect();
    let recorded: Vec<Value> = expected["surfaces"]
        .as_array()
        .expect("surfaces")
        .iter()
        .map(|surface| {
            let mut surface = surface.clone();
            let object = surface.as_object_mut().expect("object");
            object.remove("lastRequestAt");
            object.remove("lastToolCallAt");
            surface
        })
        .collect();
    assert_eq!(projected, recorded);
    assert_eq!(
        surface(&status, SurfaceId::Core).tools,
        [
            "read",
            "view_image",
            "apply_patch",
            "exec_command",
            "write_stdin",
            "update_plan"
        ]
    );
}

#[tokio::test]
async fn publishes_every_local_url_of_the_running_generation() {
    let mut harness = Harness::start(base_config());
    let status = harness.connected().await;
    let token = |id: SurfaceId| {
        surface(&status, id)
            .local_url
            .clone()
            .expect("a running endpoint publishes every surface")
    };
    assert_eq!(
        token(SurfaceId::Core),
        "http://127.0.0.1:45671/mcp/core/core-token-1"
    );
    assert_eq!(
        status.local_url.as_deref(),
        Some(token(SurfaceId::Core).as_str())
    );
    assert!(token(SurfaceId::Desktop).ends_with("/mcp/desktop/desktop-token-1"));
    assert!(token(SurfaceId::Plugins).ends_with("/mcp/plugins/plugins-token-1"));
    assert_eq!(status.public_url, None);
    assert!(
        status
            .surfaces
            .iter()
            .all(|surface| surface.public_url.is_none())
    );
    assert_eq!(harness.fake.profiles(), ["default"]);
}

#[tokio::test]
async fn without_auto_connect_describes_the_cards_and_starts_nothing() {
    let mut harness = Harness::start(manual(false));
    let status = harness.disconnected("").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(harness.fake.starts(), 0);
    assert_eq!(status.local_url, None);
    let core = surface(&status, SurfaceId::Core);
    assert_eq!(core.connector_name, "Chat On Steroids Core");
    assert_eq!(core.card_summary, "Files, patches and terminal.");
    assert!(!core.optional && core.available);
    assert_eq!(core.state, SurfaceConnectionState::Off);
    assert_eq!(core.local_url, None);
    let desktop = surface(&status, SurfaceId::Desktop);
    assert!(desktop.optional && !desktop.available);
    assert_eq!(
        desktop.detail,
        "Turn on \"See the screen\", \"Control mouse and keyboard\" or a clipboard permission to use this connector."
    );
    assert!(desktop.tools.is_empty());
}

#[tokio::test]
async fn each_connect_is_a_new_generation_with_its_own_urls_and_profile() {
    let mut config = manual(false);
    config.tunnel.profile_id = Some("work".to_owned());
    let mut harness = Harness::start(config);
    harness.connection.connect();
    let first = harness.connected().await;
    harness.connection.disconnect();
    harness.disconnected("").await;
    harness.edit(|config| config.tunnel.profile_id = Some("home".to_owned()));
    harness.connection.connect();
    let second = harness
        .until("second generation", |status| {
            status.state == ConnectionState::Connected && status.local_url != first.local_url
        })
        .await;
    assert_ne!(
        surface(&first, SurfaceId::Desktop).local_url,
        surface(&second, SurfaceId::Desktop).local_url
    );
    assert_eq!(harness.fake.profiles(), ["work", "home"]);
}

#[tokio::test]
async fn connect_while_connected_changes_nothing() {
    let mut harness = Harness::start(base_config());
    let before = harness.connected().await;
    harness.connection.connect();
    harness.connection.connect();
    harness.connection.disconnect();
    harness.disconnected("").await;
    assert_eq!(harness.fake.starts(), 1);
    assert_eq!(harness.fake.stops().len(), 1);
    assert_eq!(before.state, ConnectionState::Connected);
}

#[tokio::test]
async fn disconnect_drops_tunnel_state_and_urls_from_every_card() {
    let mut harness = Harness::start(base_config());
    harness.connected().await;
    harness.connection.disconnect();
    let status = harness.disconnected("").await;
    assert_eq!(status.local_url, None);
    for card in &status.surfaces {
        assert_eq!(card.state, SurfaceConnectionState::Off);
        assert_eq!(card.local_url, None);
        assert_eq!(card.public_url, None);
    }
    assert_eq!(surface(&status, SurfaceId::Core).detail, "");
    assert!(harness.logged("disconnect requested"));
    assert!(harness.logged("disconnected"));
}

#[tokio::test]
async fn ordinary_disconnect_is_graceful_and_final_shutdown_is_bounded() {
    let mut harness = Harness::start(base_config());
    harness.connected().await;
    harness.connection.disconnect();
    harness.disconnected("").await;
    harness.connection.connect();
    harness.connected().await;
    harness.connection.shutdown(Duration::from_secs(30)).await;
    assert_eq!(
        harness.fake.stops(),
        [
            (1, Drain::Graceful),
            (2, Drain::ForceAfter(Duration::from_secs(30)))
        ]
    );
    assert_eq!(harness.status.borrow().state, ConnectionState::Disconnected);
    harness.join().await;
}

#[tokio::test]
async fn final_shutdown_is_terminal_and_a_later_connect_starts_nothing() {
    let mut harness = Harness::start(manual(false));
    harness.disconnected("").await;
    harness.connection.shutdown(Duration::from_secs(30)).await;
    harness.connection.connect();
    harness.join().await;
    assert_eq!(harness.fake.starts(), 0);
    // A second shutdown of an ended actor returns at once.
    tokio::time::timeout(WAIT, harness.connection.shutdown(Duration::from_secs(30)))
        .await
        .expect("returns");
}

#[tokio::test]
async fn disconnect_is_published_at_once_and_a_hundred_clicks_drain_once() {
    let mut harness = Harness::start(base_config());
    harness.connected().await;
    let gate = harness.fake.hold_stops();
    for _ in 0..100 {
        harness.connection.disconnect();
    }
    let status = harness
        .until("disconnecting", |status| {
            status.state == ConnectionState::Disconnecting
        })
        .await;
    assert_eq!(
        status.detail,
        "Disconnecting; waiting for accepted requests to finish\u{2026}"
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        harness.status.borrow().state,
        ConnectionState::Disconnecting
    );
    gate.add_permits(1);
    harness.disconnected("").await;
    assert_eq!(harness.fake.stops(), [(1, Drain::Graceful)]);
    let requested = harness
        .logger
        .entries()
        .iter()
        .filter(|entry| entry.message == "disconnect requested")
        .count();
    assert_eq!(requested, 1);
}

#[tokio::test(start_paused = true)]
async fn final_shutdown_bounds_a_graceful_drain_already_running() {
    let mut harness = Harness::start(base_config());
    harness.connected().await;
    let _gate = harness.fake.hold_stops();
    harness.connection.disconnect();
    harness
        .until("disconnecting", |status| {
            status.state == ConnectionState::Disconnecting
        })
        .await;
    let started = tokio::time::Instant::now();
    harness.connection.shutdown(Duration::from_secs(30)).await;
    assert_eq!(started.elapsed(), Duration::from_secs(30));
    assert_eq!(harness.fake.stops(), [(1, Drain::Graceful)]);
    assert_eq!(harness.status.borrow().state, ConnectionState::Disconnected);
    harness.join().await;
}

#[tokio::test]
async fn a_disconnect_cancels_a_queued_connect_but_a_later_connect_runs() {
    let mut harness = Harness::start(manual(false));
    harness.disconnected("").await;
    harness.connection.connect();
    harness.connection.disconnect();
    harness.disconnected("").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(harness.fake.starts(), 0);
    harness.connection.connect();
    harness.connected().await;
    assert_eq!(harness.fake.starts(), 1);
}

#[tokio::test]
async fn an_endpoint_that_finishes_starting_after_shutdown_is_stopped_not_published() {
    let fake = Fake::default();
    let gate = fake.hold_starts();
    let mut harness = Harness::start_with(fake, base_config());
    harness
        .until("starting", |status| {
            status.state == ConnectionState::StartingServer
        })
        .await;
    let connection = harness.connection.clone();
    let shutdown = tokio::spawn(async move { connection.shutdown(Duration::from_secs(30)).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    gate.add_permits(1);
    tokio::time::timeout(WAIT, shutdown)
        .await
        .expect("shutdown ends")
        .expect("joins");
    assert_eq!(
        harness.fake.stops(),
        [(1, Drain::ForceAfter(Duration::from_secs(30)))]
    );
    let status = harness.status.borrow().clone();
    assert_eq!(status.state, ConnectionState::Disconnected);
    assert_eq!(status.local_url, None);
    harness.join().await;
}

#[tokio::test]
async fn a_disconnect_during_startup_shows_at_once_and_retires_the_late_endpoint() {
    let fake = Fake::default();
    let gate = fake.hold_starts();
    let mut harness = Harness::start_with(fake, base_config());
    harness
        .until("starting", |status| {
            status.state == ConnectionState::StartingServer
        })
        .await;
    harness.connection.disconnect();
    harness
        .until("disconnecting", |status| {
            status.state == ConnectionState::Disconnecting
        })
        .await;
    gate.add_permits(1);
    harness.disconnected("").await;
    assert_eq!(harness.fake.stops(), [(1, Drain::Graceful)]);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(harness.status.borrow().state, ConnectionState::Disconnected);
    // Disconnect is not terminal.
    harness.connection.connect();
    gate.add_permits(1);
    harness.connected().await;
}

#[tokio::test]
async fn a_failed_endpoint_start_says_why_and_stays_reconnectable() {
    let fake = Fake::default();
    fake.fail_starts("address in use");
    let mut harness = Harness::start_with(fake, base_config());
    let status = harness.disconnected("address in use").await;
    assert_eq!(status.local_url, None);
    assert!(harness.logged("connect failed: address in use"));
    *harness.fake.0.start_error.lock().unwrap() = None;
    harness.connection.connect();
    harness.connected().await;
}

#[tokio::test]
async fn a_file_capability_without_a_folder_refuses_to_connect() {
    let mut config = base_config();
    config.roots.clear();
    let mut harness = Harness::start(config);
    harness
        .disconnected("Add a folder before connecting.")
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(harness.fake.starts(), 0);
}

#[tokio::test]
async fn command_alone_still_needs_a_folder() {
    let mut config = base_config();
    config.roots.clear();
    for &capability in Capability::ALL {
        set(
            &mut config.capabilities,
            capability,
            capability == Capability::Command,
        );
    }
    let mut harness = Harness::start(config);
    harness
        .disconnected("Add a folder before connecting.")
        .await;
    assert_eq!(harness.fake.starts(), 0);
}

#[tokio::test]
async fn a_rootless_desktop_setup_connects_without_a_folder() {
    let mut config = base_config();
    config.roots.clear();
    for &capability in Capability::ALL {
        set(
            &mut config.capabilities,
            capability,
            matches!(capability, Capability::Screen | Capability::ClipboardWrite),
        );
    }
    let mut harness = Harness::start(config);
    let status = harness.connected().await;
    let desktop = surface(&status, SurfaceId::Desktop);
    assert!(desktop.available);
    assert_eq!(desktop.state, SurfaceConnectionState::Live);
    assert_eq!(desktop.detail, MANUAL);
    assert!(desktop.tools.iter().any(|tool| tool == "get_window"));
    assert!(desktop.tools.iter().any(|tool| tool == "write_clipboard"));
    assert!(!desktop.tools.iter().any(|tool| tool == "click"));
}

#[tokio::test]
async fn a_permission_saved_while_connected_publishes_the_desktop_card() {
    let mut harness = Harness::start(base_config());
    harness.connected().await;
    harness.edit(|config| set(&mut config.capabilities, Capability::Screen, true));
    let status = harness
        .until("desktop live", |status| {
            surface(status, SurfaceId::Desktop).state == SurfaceConnectionState::Live
        })
        .await;
    assert_eq!(surface(&status, SurfaceId::Desktop).detail, MANUAL);
    assert_eq!(harness.fake.starts(), 1);
    harness.edit(|config| set(&mut config.capabilities, Capability::Screen, false));
    let status = harness
        .until("desktop off", |status| {
            !surface(status, SurfaceId::Desktop).available
        })
        .await;
    assert_eq!(
        surface(&status, SurfaceId::Desktop).state,
        SurfaceConnectionState::Off
    );
    assert_eq!(status.state, ConnectionState::Connected);
}

#[tokio::test]
async fn editing_fields_the_manual_transport_ignores_does_not_reconnect() {
    let mut harness = Harness::start(base_config());
    harness.connected().await;
    harness.edit(|config| {
        config.tunnel.tunnel_id = "tunnel_0123456789abcdef0123456789abcdef".to_owned();
        config.tunnel.binary_path = "C:\\tools\\tunnel-client.exe".to_owned();
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(harness.fake.starts(), 1);
    assert!(harness.fake.stops().is_empty());
    assert_eq!(harness.status.borrow().state, ConnectionState::Connected);
}

#[tokio::test]
async fn changing_the_transport_reconnects_on_the_new_one() {
    let mut harness = Harness::start(base_config());
    harness.connected().await;
    harness.edit(|config| config.tunnel.kind = TunnelKind::Cloudflared);
    harness
        .until("reconnected", |status| {
            status.state == ConnectionState::TunnelUnavailable
        })
        .await;
    assert!(harness.logged("core connection settings changed; reconnecting"));
    assert_eq!(harness.fake.starts(), 2);
    assert_eq!(harness.fake.stops().first(), Some(&(1, Drain::Graceful)));
}

#[tokio::test]
async fn the_connector_suffix_names_every_card() {
    let mut config = manual(false);
    config.connector_suffix = Some("  Work   laptop ".to_owned());
    let mut harness = Harness::start(config);
    let status = harness.disconnected("").await;
    assert_eq!(
        surface(&status, SurfaceId::Desktop).connector_name,
        "Chat On Steroids Desktop (Work laptop)"
    );
    harness.edit(|config| config.connector_suffix = Some("bad/suffix".to_owned()));
    let status = harness
        .until("plain name", |status| {
            surface(status, SurfaceId::Core).connector_name == "Chat On Steroids Core"
        })
        .await;
    assert_eq!(status.state, ConnectionState::Disconnected);
}

#[test]
fn a_sibling_public_url_takes_the_surface_path_on_the_shared_origin() {
    use crate::surfaces::sibling_public_url;
    assert_eq!(
        sibling_public_url(
            Some("https://a-b.trycloudflare.com/mcp/core/one"),
            "http://127.0.0.1:4000/mcp/desktop/two"
        )
        .as_deref(),
        Some("https://a-b.trycloudflare.com/mcp/desktop/two")
    );
    assert_eq!(
        sibling_public_url(
            Some("https://proxy.example/x?k=1"),
            "http://127.0.0.1:1/mcp/plugins/t"
        )
        .as_deref(),
        Some("https://proxy.example/mcp/plugins/t?k=1")
    );
    assert_eq!(
        sibling_public_url(None, "http://127.0.0.1:1/mcp/core/t"),
        None
    );
    assert_eq!(
        sibling_public_url(Some("not a url"), "http://127.0.0.1:1/mcp/core/t"),
        None
    );
}
