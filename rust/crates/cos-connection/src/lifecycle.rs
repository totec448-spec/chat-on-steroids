//! The lifecycle actor (`connection.ts`). It is the only writer of the connection status.
//!
//! Commands are taken in order. While a step awaits (an endpoint binding, a key lookup, a
//! drain), the actor still reads its inbox, so Disconnect is published at once and final
//! shutdown is noticed before the step finishes. Each connect attempt has a generation;
//! Disconnect, Shutdown and every teardown bump it, so whatever an older attempt produces
//! afterwards is torn down instead of published. Each tunnel has its own lifetime id, and a
//! report is applied only while the lifetime that sent it is still running.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use cos_http::Drain;
use cos_store::{Logger, Platform};
use cos_tools::{EpochMs, Grants};
use cos_types::app_state::{
    ConnectionState, ConnectionStatus, SurfaceConnectionState, SurfaceId, TunnelHealth,
};
use cos_types::config::{Config, TunnelSettings};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::time::Instant;

use crate::Command;
use crate::ports::{Endpoint, Ports};
use crate::surfaces::{self, Clocks, PerSurface, SurfaceReport, View};
use crate::tunnel::{self, Launch, Reported, Reporter, Transport, TunnelHandle, TunnelReport};

const STARTING_SERVER: &str = "Starting the local server\u{2026}";
const CONNECTING: &str = "Connecting\u{2026}";
const DISCONNECTING: &str = "Disconnecting; waiting for accepted requests to finish\u{2026}";
const ADD_A_FOLDER: &str = "Add a folder before connecting.";
const NOT_PUBLISHED: &str = "Not published yet. Create a separate Secure Tunnel for it and paste its tunnel id in Settings.";
const PERMISSION_OFF: &str = "Turn a desktop permission back on to publish this connector.";
const NEW_TUNNEL: &str = "Reconnecting with the new tunnel\u{2026}";
/// An established tunnel must stay down this long before the user is told.
pub(crate) const CONNECTION_LOSS_GRACE: Duration = Duration::from_secs(30);
const OPTIONAL: [SurfaceId; 2] = [SurfaceId::Desktop, SurfaceId::Plugins];

/// The whole-connection line of the status.
#[derive(Clone, Debug, PartialEq)]
struct Headline {
    state: ConnectionState,
    detail: String,
    public_url: Option<String>,
    handshake_at: Option<u64>,
    health: Option<TunnelHealth>,
}

impl Headline {
    fn disconnected(detail: impl Into<String>) -> Self {
        Self {
            state: ConnectionState::Disconnected,
            detail: detail.into(),
            public_url: None,
            handshake_at: None,
            health: None,
        }
    }
}

/// One delayed connection-loss notice per tunnel lifetime. A brief outage that recovers
/// inside the grace window says nothing; one notice per outage; sleep never counts.
#[derive(Default)]
struct LossWatch {
    /// The tunnel has been connected, so a later failure is a loss, not a failed start.
    armed: bool,
    outage: bool,
    retired: bool,
    due: Option<Instant>,
}

impl LossWatch {
    fn report(&mut self, state: ConnectionState, suspended: bool) {
        if self.retired {
            return;
        }
        if state == ConnectionState::Connected {
            self.outage = false;
            self.due = None;
            self.armed = true;
            return;
        }
        // Unknown health and retries prove neither recovery nor an outage.
        let lost = matches!(
            state,
            ConnectionState::Offline
                | ConnectionState::AuthFailed
                | ConnectionState::TunnelUnavailable
        );
        if self.armed && lost {
            self.outage = true;
            self.schedule(suspended);
        }
    }

    /// Sleep never counts toward the grace period.
    fn suspend(&mut self) {
        self.due = None;
    }

    /// An outage that survived sleep gets a fresh full grace period.
    fn resume(&mut self) {
        self.schedule(false);
    }

    fn schedule(&mut self, suspended: bool) {
        if !self.retired && !suspended && self.armed && self.outage && self.due.is_none() {
            self.due = Some(Instant::now() + CONNECTION_LOSS_GRACE);
        }
    }
}

/// One tunnel and the connector it publishes.
struct Lifetime {
    id: u64,
    surface: SurfaceId,
    /// The Secure Tunnel ID an optional OpenAI tunnel runs on; empty otherwise.
    tunnel_id: String,
    handle: TunnelHandle,
    loss: LossWatch,
}

/// A running generation: its endpoint and the tunnels that carry it.
struct Up<E> {
    endpoint: E,
    transport: Transport,
    tunnels: Vec<Lifetime>,
}

struct Stopping {
    force_after: Duration,
    done: Vec<oneshot::Sender<()>>,
}

pub(crate) struct Actor<P: Ports> {
    ports: P,
    platform: Platform,
    config: watch::Receiver<Arc<Config>>,
    config_open: bool,
    logger: Logger,
    publish: watch::Sender<Arc<ConnectionStatus>>,
    lost: broadcast::Sender<SurfaceId>,
    inbox: mpsc::UnboundedReceiver<Command>,
    inbox_open: bool,
    reports: mpsc::UnboundedReceiver<Reported>,
    reporter: mpsc::UnboundedSender<Reported>,
    queued: VecDeque<Command>,
    generation: u64,
    lifetimes: u64,
    /// A Disconnect has been published but its teardown has not finished.
    disconnecting: bool,
    stopping: Option<Stopping>,
    suspended: bool,
    headline: Headline,
    cards: PerSurface<SurfaceReport>,
    /// OpenAI holds an existing chat's calls on the old route until then (epoch ms).
    route_settling_until: Option<u64>,
    up: Option<Up<P::Endpoint>>,
}

impl<P: Ports> Actor<P> {
    pub fn new(
        ports: P,
        config: watch::Receiver<Arc<Config>>,
        logger: Logger,
        inbox: mpsc::UnboundedReceiver<Command>,
        publish: watch::Sender<Arc<ConnectionStatus>>,
        lost: broadcast::Sender<SurfaceId>,
    ) -> Self {
        let (reporter, reports) = mpsc::unbounded_channel();
        Self {
            ports,
            platform: Platform::current(),
            config,
            config_open: true,
            logger,
            publish,
            lost,
            inbox,
            inbox_open: true,
            reports,
            reporter,
            queued: VecDeque::new(),
            generation: 0,
            lifetimes: 0,
            disconnecting: false,
            stopping: None,
            suspended: false,
            headline: Headline::disconnected(""),
            cards: PerSurface::default(),
            route_settling_until: None,
            up: None,
        }
    }

    pub async fn run(mut self) {
        let auto_connect = self.config.borrow_and_update().ui.auto_connect;
        self.publish();
        if auto_connect {
            self.queued.push_back(Command::Connect);
        }
        loop {
            self.take_waiting();
            while let Some(command) = self.queued.pop_front() {
                if self.stopping.is_some() {
                    break;
                }
                match command {
                    Command::Connect => self.connect().await,
                    Command::Disconnect => self.disconnect().await,
                    // Never queued: `note` acts on them at once.
                    Command::Shutdown { .. }
                    | Command::SuspendLossNotices
                    | Command::ResumeLossNotices => {}
                }
                self.take_waiting();
            }
            if self.stopping.is_some() || !self.inbox_open {
                return self.finish().await;
            }
            let due = self.next_loss_notice();
            tokio::select! {
                command = self.inbox.recv() => match command {
                    Some(command) => self.note(command),
                    None => self.inbox_open = false,
                },
                Some(reported) = self.reports.recv() => self.apply(reported),
                changed = self.config.changed(), if self.config_open => match changed {
                    Ok(()) => self.settings_changed().await,
                    Err(_) => self.config_open = false,
                },
                () = sleep_until(due) => self.notify_losses(),
            }
        }
    }

    /// The immediate part of a command: what callers must see before the queue reaches it.
    fn note(&mut self, command: Command) {
        match command {
            Command::Connect => self.queued.push_back(Command::Connect),
            Command::Disconnect => {
                if !self.disconnecting {
                    self.disconnecting = true;
                    self.generation += 1;
                    self.retire_loss_watches();
                    self.logger.info("disconnect requested");
                    self.headline.state = ConnectionState::Disconnecting;
                    self.headline.detail = DISCONNECTING.to_owned();
                    self.publish();
                }
                self.queued.push_back(Command::Disconnect);
            }
            Command::Shutdown { force_after, done } => {
                self.generation += 1;
                self.retire_loss_watches();
                match &mut self.stopping {
                    Some(stopping) => stopping.done.push(done),
                    None => {
                        self.stopping = Some(Stopping {
                            force_after,
                            done: vec![done],
                        });
                    }
                }
            }
            Command::SuspendLossNotices => {
                self.suspended = true;
                for lifetime in self.lifetimes_mut() {
                    lifetime.loss.suspend();
                }
            }
            Command::ResumeLossNotices => {
                self.suspended = false;
                for lifetime in self.lifetimes_mut() {
                    lifetime.loss.resume();
                }
            }
        }
    }

    fn take_waiting(&mut self) {
        while let Ok(command) = self.inbox.try_recv() {
            self.note(command);
        }
    }

    fn superseded(&self, generation: u64) -> bool {
        self.stopping.is_some() || generation != self.generation
    }

    fn lifetimes_mut(&mut self) -> impl Iterator<Item = &mut Lifetime> {
        self.up.iter_mut().flat_map(|up| up.tunnels.iter_mut())
    }

    fn retire_loss_watches(&mut self) {
        for lifetime in self.lifetimes_mut() {
            lifetime.loss.retired = true;
            lifetime.loss.due = None;
        }
    }

    fn next_loss_notice(&self) -> Option<Instant> {
        self.up
            .iter()
            .flat_map(|up| up.tunnels.iter())
            .filter_map(|lifetime| lifetime.loss.due)
            .min()
    }

    fn notify_losses(&mut self) {
        let now = Instant::now();
        let mut lost = Vec::new();
        for lifetime in self.lifetimes_mut() {
            if lifetime.loss.due.is_some_and(|due| due <= now) {
                // Spent even if nobody listens: the same outage is never announced twice.
                lifetime.loss.due = None;
                lifetime.loss.armed = false;
                lost.push(lifetime.surface);
            }
        }
        for surface in lost {
            // No subscriber means no window to notify; the status still shows the outage.
            let _ = self.lost.send(surface);
        }
    }

    /// Awaits `step` while still taking commands.
    async fn during<T>(&mut self, step: impl Future<Output = T>) -> T {
        let mut step = pin!(step);
        loop {
            tokio::select! {
                biased;
                out = &mut step => return out,
                command = self.inbox.recv(), if self.inbox_open => match command {
                    Some(command) => self.note(command),
                    None => self.inbox_open = false,
                },
            }
        }
    }

    /// Like [`Self::during`], but final shutdown abandons the step: quitting must not wait
    /// for a credential lookup that is parked behind a system prompt.
    async fn unless_stopping<T>(&mut self, step: impl Future<Output = T>) -> Option<T> {
        let mut step = pin!(step);
        loop {
            if self.stopping.is_some() {
                return None;
            }
            tokio::select! {
                biased;
                out = &mut step => return Some(out),
                command = self.inbox.recv(), if self.inbox_open => match command {
                    Some(command) => self.note(command),
                    None => self.inbox_open = false,
                },
            }
        }
    }

    /// A Disconnect that arrived after this Connect was queued cancels it; one that finished
    /// before it does not.
    async fn connect(&mut self) {
        if self.stopping.is_some() || self.disconnecting {
            return;
        }
        // Offline counts as running: the tunnel is alive and retrying on its own.
        if self.up.is_some()
            && matches!(
                self.headline.state,
                ConnectionState::Connected
                    | ConnectionState::Offline
                    | ConnectionState::StartingServer
                    | ConnectionState::ConnectingTunnel
            )
        {
            return;
        }
        self.teardown().await;
        if self.stopping.is_some() || self.disconnecting {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        let config = self.config.borrow_and_update().clone();
        let grants = self.ports.grants(&config);
        if config.roots.is_empty() && surfaces::requires_root(&grants) {
            self.headline = Headline::disconnected(ADD_A_FOLDER);
            self.publish();
            return;
        }
        self.headline = Headline {
            state: ConnectionState::StartingServer,
            detail: STARTING_SERVER.to_owned(),
            ..Headline::disconnected("")
        };
        self.publish();

        // The generation keeps the Setup profile it started with, even if a profile switch
        // is saved before the old endpoint has drained.
        let profile = config
            .tunnel
            .profile_id
            .clone()
            .unwrap_or_else(|| "default".to_owned());
        let start = self.ports.start_endpoint(profile);
        let endpoint = match self.during(start).await {
            Ok(endpoint) => endpoint,
            Err(error) => {
                if self.superseded(generation) {
                    return self.teardown().await;
                }
                return self
                    .fail(ConnectionState::Disconnected, error.to_string())
                    .await;
            }
        };
        let transport = Transport::of(&config.tunnel);
        self.up = Some(Up {
            endpoint,
            transport: transport.clone(),
            tunnels: Vec::new(),
        });
        if self.superseded(generation) {
            return self.teardown().await;
        }
        self.cards.set(
            SurfaceId::Core,
            SurfaceReport {
                state: SurfaceConnectionState::Starting,
                detail: CONNECTING.to_owned(),
                public_url: None,
            },
        );
        self.publish();

        let api_key = self.api_key(&transport, &config.tunnel).await;
        if self.superseded(generation) {
            return self.teardown().await;
        }
        let started = self.start_tunnel(
            SurfaceId::Core,
            transport.clone(),
            String::new(),
            api_key.clone(),
        );
        if let Err(error) = started {
            return self.fail(ConnectionState::TunnelUnavailable, error.0).await;
        }
        self.warn_on_shared_tunnel_ids(&config.tunnel);
        if let Transport::OpenAi { .. } = transport {
            for id in OPTIONAL {
                self.start_optional(id, &config, &grants, api_key.clone());
            }
        }
    }

    /// The OpenAI control-plane key of the active setup; other transports need none.
    async fn api_key(&mut self, transport: &Transport, tunnel: &TunnelSettings) -> Option<String> {
        if !matches!(transport, Transport::OpenAi { .. }) {
            return None;
        }
        let lookup = self.ports.api_key(tunnel.profile_id.clone());
        self.unless_stopping(lookup).await.flatten()
    }

    fn start_tunnel(
        &mut self,
        surface: SurfaceId,
        transport: Transport,
        tunnel_id: String,
        api_key: Option<String>,
    ) -> Result<(), tunnel::TunnelError> {
        let Some(up) = &mut self.up else {
            return Ok(());
        };
        self.lifetimes += 1;
        let id = self.lifetimes;
        let handle = tunnel::start(Launch {
            local_url: up.endpoint.urls().of(surface).to_owned(),
            transport,
            api_key,
            discovery_header: up.endpoint.tunnel_probe(),
            surface,
            host: self.ports.host(),
            logger: self.logger.clone(),
            reporter: Reporter::new(self.reporter.clone(), id),
        })?;
        up.tunnels.push(Lifetime {
            id,
            surface,
            tunnel_id,
            handle,
            loss: LossWatch::default(),
        });
        Ok(())
    }

    /// Publishes one optional connector on its own OpenAI tunnel, with its own failure state.
    fn start_optional(
        &mut self,
        id: SurfaceId,
        config: &Config,
        grants: &Grants,
        api_key: Option<String>,
    ) {
        if self.up.is_none() || !surfaces::available(id, grants, self.platform) {
            return;
        }
        let tunnel_id = optional_tunnel_id(&config.tunnel, id).trim().to_owned();
        if tunnel_id.is_empty() {
            self.set_card(id, SurfaceConnectionState::Off, NOT_PUBLISHED.to_owned());
            return;
        }
        self.set_card(id, SurfaceConnectionState::Starting, CONNECTING.to_owned());
        let transport = Transport::OpenAi {
            tunnel_id: tunnel_id.clone(),
            binary_path: config.tunnel.binary_path.clone(),
            profile_epoch: config.tunnel.profile_epoch.unwrap_or(0),
        };
        if let Err(error) = self.start_tunnel(id, transport, tunnel_id, api_key) {
            self.logger.warn(&format!(
                "{} connector not published: {}",
                id.as_str(),
                error.0
            ));
            self.set_card(id, SurfaceConnectionState::Error, error.0);
        }
    }

    /// Retires the optional tunnel's report authority, then stops it.
    async fn stop_optional(&mut self, id: SurfaceId, detail: &str) {
        let Some(up) = &mut self.up else { return };
        let Some(at) = up
            .tunnels
            .iter()
            .position(|lifetime| lifetime.surface == id)
        else {
            return;
        };
        let lifetime = up.tunnels.remove(at);
        lifetime.handle.stop().await;
        self.logger
            .info(&format!("{} connector unpublished", id.as_str()));
        self.set_card(id, SurfaceConnectionState::Off, detail.to_owned());
    }

    fn set_card(&mut self, id: SurfaceId, state: SurfaceConnectionState, detail: String) {
        self.cards.set(
            id,
            SurfaceReport {
                state,
                detail,
                public_url: None,
            },
        );
        self.publish();
    }

    /// Says so when two connectors share one Secure Tunnel ID. Only a warning: the IDs are
    /// the user's to choose. The IDs themselves are never logged.
    fn warn_on_shared_tunnel_ids(&self, settings: &TunnelSettings) {
        let groups = tunnel::shared_tunnel_ids([
            (SurfaceId::Core, settings.tunnel_id.as_str()),
            (SurfaceId::Desktop, settings.desktop_tunnel_id.as_str()),
            (
                SurfaceId::Plugins,
                settings.plugins_tunnel_id.as_deref().unwrap_or(""),
            ),
        ]);
        for surfaces in groups {
            let names: Vec<&str> = surfaces.iter().map(|surface| surface.as_str()).collect();
            self.logger.warn(&format!(
                "connection: {} are configured on the same Secure Tunnel ID. OpenAI dispatches round-robin across every client on one ID, so roughly one call in {} will reach the wrong connector and come back as UNKNOWN_TOOL for a tool that exists. Give each connector its own tunnel ID.",
                names.join(" and "),
                surfaces.len()
            ));
        }
    }

    async fn fail(&mut self, state: ConnectionState, message: String) {
        self.logger.error(&format!("connect failed: {message}"));
        self.teardown().await;
        self.headline.state = state;
        self.headline.detail = message;
        self.publish();
    }

    async fn disconnect(&mut self) {
        self.teardown().await;
        self.disconnecting = false;
    }

    /// A report from a running tunnel.
    fn apply(&mut self, reported: Reported) {
        if self.stopping.is_some() {
            return;
        }
        let suspended = self.suspended;
        let Some(lifetime) = self
            .lifetimes_mut()
            .find(|lifetime| lifetime.id == reported.lifetime)
        else {
            return;
        };
        let surface = lifetime.surface;
        let report = reported.report;
        lifetime.loss.report(report.state, suspended);
        if report.new_client {
            let until = EpochMs::now().0 + tunnel::ROUTE_SETTLE_MS;
            self.route_settling_until = Some(self.route_settling_until.unwrap_or(0).max(until));
        }
        if surface == SurfaceId::Core {
            self.apply_core_report(report);
        } else {
            let mut card = self.cards.get(surface).clone();
            card.state = surface_state(report.state);
            card.detail = report.detail;
            if let Some(public_url) = report.public_url {
                card.public_url = public_url;
            }
            self.cards.set(surface, card);
            self.publish();
        }
    }

    /// Projects a Core tunnel report onto the headline and the cards.
    fn apply_core_report(&mut self, report: TunnelReport) {
        let Some(up) = &self.up else { return };
        let shares_origin = up.transport.shares_origin();
        self.headline.state = report.state;
        self.headline.detail.clone_from(&report.detail);
        if let Some(public_url) = &report.public_url {
            self.headline.public_url.clone_from(public_url);
        }
        if let Some(handshake_at) = report.handshake_at {
            self.headline.handshake_at = handshake_at;
        }
        if let Some(health) = report.health {
            self.headline.health = health;
        }
        let mut core = self.cards.get(SurfaceId::Core).clone();
        core.state = surface_state(report.state);
        core.detail.clone_from(&report.detail);
        if let Some(public_url) = &report.public_url {
            core.public_url.clone_from(public_url);
        }
        self.cards.set(SurfaceId::Core, core);
        // On a shared-origin transport the optional surfaces are already published by this
        // same tunnel at their own paths.
        if shares_origin && report.public_url.is_some() {
            self.project_shared_origin(&self.current_grants());
        }
        self.publish();
    }

    fn project_shared_origin(&mut self, grants: &Grants) {
        let Some(up) = &self.up else { return };
        let urls = up.endpoint.urls().clone();
        for id in OPTIONAL {
            if !surfaces::available(id, grants, self.platform) {
                continue;
            }
            self.cards.set(
                id,
                SurfaceReport {
                    state: surface_state(self.headline.state),
                    detail: self.headline.detail.clone(),
                    public_url: surfaces::sibling_public_url(
                        self.headline.public_url.as_deref(),
                        urls.of(id),
                    ),
                },
            );
        }
    }

    /// A saved config. A change of Core's transport reconnects. Otherwise the cards are
    /// re-described (permissions decide which tools each surface would advertise), and on
    /// OpenAI each optional tunnel follows its permission and its own tunnel ID.
    async fn settings_changed(&mut self) {
        let config = self.config.borrow_and_update().clone();
        let Some(up) = &self.up else {
            self.publish();
            return;
        };
        if self.stopping.is_some() || self.disconnecting {
            return;
        }
        if up.transport != Transport::of(&config.tunnel) {
            self.logger
                .info("core connection settings changed; reconnecting");
            self.teardown().await;
            self.connect().await;
            return;
        }
        let grants = self.ports.grants(&config);
        if up.transport.shares_origin() {
            self.project_shared_origin(&grants);
            self.publish();
            return;
        }
        self.publish();
        for id in OPTIONAL {
            if !surfaces::available(id, &grants, self.platform) {
                self.stop_optional(id, PERMISSION_OFF).await;
                continue;
            }
            let wanted = optional_tunnel_id(&config.tunnel, id).trim().to_owned();
            let running = self
                .up
                .iter()
                .flat_map(|up| up.tunnels.iter())
                .find(|lifetime| lifetime.surface == id)
                .map(|lifetime| lifetime.tunnel_id.clone());
            if running.as_deref() == Some(wanted.as_str()) {
                continue;
            }
            self.stop_optional(id, NEW_TUNNEL).await;
            let generation = self.generation;
            let transport = Transport::of(&config.tunnel);
            let api_key = self.api_key(&transport, &config.tunnel).await;
            if self.superseded(generation) || self.disconnecting {
                return;
            }
            self.start_optional(id, &config, &grants, api_key);
        }
    }

    /// Stops whatever runs and publishes the disconnected status. Safe to repeat.
    async fn teardown(&mut self) {
        self.generation += 1;
        self.retire_loss_watches();
        let was_running = self.headline.state != ConnectionState::Disconnected;
        if was_running {
            self.headline.state = ConnectionState::Disconnecting;
            self.headline.detail = DISCONNECTING.to_owned();
            self.publish();
        }
        if let Some(mut up) = self.up.take() {
            // Local admission stops first, so accepted calls finish recording before any
            // tunnel goes; the tunnel briefly seeing a closed endpoint is the lesser harm.
            self.drain(up.endpoint).await;
            up.tunnels
                .sort_by_key(|lifetime| lifetime.surface == SurfaceId::Core);
            for lifetime in up.tunnels {
                lifetime.handle.stop().await;
            }
        }
        if was_running {
            self.logger.info("disconnected");
        }
        self.headline = Headline::disconnected("");
        self.cards = PerSurface::default();
        self.publish();
    }

    /// Lets accepted requests finish. An ordinary disconnect waits for all of them; final
    /// shutdown bounds the wait, including a graceful drain that was already running.
    async fn drain(&mut self, endpoint: P::Endpoint) {
        let bound = self.stopping.as_ref().map(|stopping| stopping.force_after);
        let mut stopping = endpoint.stop(match bound {
            Some(limit) => Drain::ForceAfter(limit),
            None => Drain::Graceful,
        });
        if bound.is_some() {
            stopping.await;
            return;
        }
        let mut deadline = None;
        loop {
            tokio::select! {
                biased;
                _ = &mut stopping => return,
                () = sleep_until(deadline) => return,
                command = self.inbox.recv(), if self.inbox_open && deadline.is_none() => {
                    match command {
                        Some(command) => self.note(command),
                        None => self.inbox_open = false,
                    }
                    if let Some(stopping) = &self.stopping {
                        deadline = Some(Instant::now() + stopping.force_after);
                    }
                }
            }
        }
    }

    async fn finish(&mut self) {
        self.teardown().await;
        if let Some(stopping) = self.stopping.take() {
            for done in stopping.done {
                // A caller that stopped waiting has nothing to be told.
                let _ = done.send(());
            }
        }
    }

    fn current_grants(&self) -> Grants {
        self.ports.grants(&self.config.borrow())
    }

    fn publish(&self) {
        let status = self.render();
        self.publish.send_if_modified(|current| {
            if **current == status {
                return false;
            }
            *current = Arc::new(status);
            true
        });
    }

    fn render(&self) -> ConnectionStatus {
        let config = self.config.borrow();
        let grants = self.ports.grants(&config);
        let mut clocks = PerSurface::<Clocks>::default();
        for &id in SurfaceId::ALL {
            clocks.set(id, self.ports.clocks(id));
        }
        let urls = self.up.as_ref().map(|up| up.endpoint.urls());
        let latest = |pick: fn(&Clocks) -> Option<u64>| {
            SurfaceId::ALL
                .iter()
                .filter_map(|&id| pick(clocks.get(id)))
                .max()
        };
        let now = EpochMs::now().0;
        ConnectionStatus {
            state: self.headline.state,
            detail: self.headline.detail.clone(),
            public_url: self.headline.public_url.clone(),
            local_url: urls.map(|urls| urls.core.clone()),
            handshake_at: self.headline.handshake_at,
            last_request_at: latest(|clocks| clocks.request_at),
            last_tool_call_at: latest(|clocks| clocks.tool_call_at),
            health: self.headline.health.clone(),
            route_settling_until: Some(self.route_settling_until.filter(|until| now < *until)),
            surfaces: surfaces::describe(&View {
                grants: &grants,
                platform: self.platform,
                connector_suffix: config.connector_suffix.as_deref(),
                urls,
                reports: &self.cards,
                clocks: &clocks,
            }),
        }
    }
}

fn optional_tunnel_id(settings: &TunnelSettings, id: SurfaceId) -> &str {
    match id {
        SurfaceId::Desktop => &settings.desktop_tunnel_id,
        SurfaceId::Plugins => settings.plugins_tunnel_id.as_deref().unwrap_or(""),
        SurfaceId::Core => &settings.tunnel_id,
    }
}

/// A whole-connection report as one card's state.
fn surface_state(state: ConnectionState) -> SurfaceConnectionState {
    match state {
        ConnectionState::Connected => SurfaceConnectionState::Live,
        ConnectionState::StartingServer | ConnectionState::ConnectingTunnel => {
            SurfaceConnectionState::Starting
        }
        _ => SurfaceConnectionState::Error,
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOST: [ConnectionState; 3] = [
        ConnectionState::Offline,
        ConnectionState::AuthFailed,
        ConnectionState::TunnelUnavailable,
    ];

    fn due_after(watch: &LossWatch) -> Option<Duration> {
        watch.due.map(|due| due - Instant::now())
    }

    #[tokio::test(start_paused = true)]
    async fn an_established_tunnel_that_stays_down_is_announced_after_the_grace() {
        for state in LOST {
            let mut watch = LossWatch::default();
            watch.report(ConnectionState::Connected, false);
            watch.report(state, false);
            assert_eq!(due_after(&watch), Some(CONNECTION_LOSS_GRACE), "{state:?}");
            // Repeated samples and retries neither restart nor cancel the grace.
            tokio::time::advance(Duration::from_secs(10)).await;
            watch.report(state, false);
            watch.report(ConnectionState::ConnectingTunnel, false);
            assert_eq!(due_after(&watch), Some(Duration::from_secs(20)));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_brief_outage_says_nothing_and_stays_armed() {
        let mut watch = LossWatch::default();
        watch.report(ConnectionState::Connected, false);
        watch.report(ConnectionState::Offline, false);
        watch.report(ConnectionState::Connected, false);
        assert_eq!(watch.due, None);
        watch.report(ConnectionState::Offline, false);
        assert_eq!(due_after(&watch), Some(CONNECTION_LOSS_GRACE));
    }

    #[tokio::test(start_paused = true)]
    async fn a_tunnel_that_never_connected_is_never_announced() {
        let mut watch = LossWatch::default();
        for state in LOST {
            watch.report(state, false);
        }
        assert_eq!(watch.due, None);
    }

    #[tokio::test(start_paused = true)]
    async fn sleep_does_not_count_and_resume_gives_a_fresh_grace() {
        let mut watch = LossWatch::default();
        watch.report(ConnectionState::Connected, false);
        watch.report(ConnectionState::Offline, false);
        tokio::time::advance(Duration::from_secs(25)).await;
        watch.suspend();
        watch.report(ConnectionState::Offline, true);
        assert_eq!(watch.due, None);
        tokio::time::advance(Duration::from_secs(600)).await;
        watch.resume();
        assert_eq!(due_after(&watch), Some(CONNECTION_LOSS_GRACE));
    }

    #[tokio::test(start_paused = true)]
    async fn a_retired_watch_never_schedules() {
        let mut watch = LossWatch::default();
        watch.report(ConnectionState::Connected, false);
        watch.retired = true;
        watch.report(ConnectionState::Offline, false);
        assert_eq!(watch.due, None);
    }
}
