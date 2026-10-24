//! The bridge's run task: bind, follow `ui.browserBridgePort`, keep status current, drain.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use cos_http::{Drain, Listener, ListenerOptions};
use cos_tools::EpochMs;
use cos_types::bridge::WAKE_HEARTBEAT_MS;
use cos_types::config::{BrowserBridgePort, Config};
use tokio::sync::oneshot;
use tokio::time::{Instant, MissedTickBehavior};

use crate::router::Routes;
use crate::server::Server;
use crate::{Listening, PortSelection, Shared, ports};

/// `drainBridgeListener`: accepted requests finish, a wedged client is cut off after this.
const DRAIN: Duration = Duration::from_secs(15);
/// `headersTimeout`.
const HEADERS: Duration = Duration::from_secs(15);

pub(crate) async fn run(shared: Arc<Shared>, routes: Arc<Routes>, mut stop: oneshot::Receiver<()>) {
    // Status says whether a browser is paired from the first moment.
    let _ = shared.pairing.stored().await;
    // Mirrored on each launch, so Chrome finds the current build in the folder it remembers.
    let extension = shared.extension.clone();
    tokio::task::spawn_blocking(move || extension.dir());

    let service = Arc::new(Server::new(shared.clone(), routes));
    let mut config = shared.config.clone();
    let mut choice = port_choice(&config.borrow_and_update());
    let mut listener = start(&shared, &service, choice).await;
    let period = Duration::from_millis(WAKE_HEARTBEAT_MS);
    let mut heartbeat = tokio::time::interval_at(Instant::now() + period, period);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut config_open = true;
    loop {
        let expiry = shared.publish().map_or(Duration::from_secs(3600), |at| {
            until(at) + Duration::from_millis(1)
        });
        tokio::select! {
            _ = &mut stop => break,
            () = shared.changed.notified() => {}
            () = tokio::time::sleep(expiry) => {}
            _ = heartbeat.tick() => shared.hub.heartbeat(Instant::now()),
            changed = config.changed(), if config_open => {
                if changed.is_err() {
                    config_open = false;
                    continue;
                }
                let next = port_choice(&config.borrow_and_update());
                if listener.is_none() {
                    // A settings save starts a bridge that could not start before.
                    listener = start(&shared, &service, next).await;
                } else if next != choice
                    && !shared.overridden
                    && let Some(moved) = switch(&shared, &service, next).await
                    && let Some(old) = listener.replace(moved)
                {
                    // The config queue never waits for the old listener's drain.
                    tokio::spawn(old.shutdown(Drain::ForceAfter(DRAIN)));
                }
                choice = next;
            }
        }
    }
    shared.hub.revoke();
    shared.presence.forget_sightings();
    if let Some(listener) = listener {
        shared.set_listening(Listening::default());
        shared.publish();
        listener.shutdown(Drain::ForceAfter(DRAIN)).await;
        shared.logger.info("bridge stopped");
    }
    shared.publish();
}

fn port_choice(config: &Config) -> BrowserBridgePort {
    config
        .ui
        .browser_bridge_port
        .unwrap_or(BrowserBridgePort::Auto)
}

fn until(at: EpochMs) -> Duration {
    Duration::from_millis(at.0.saturating_sub(EpochMs::now().0))
}

/// `startBridgeOnce`: binds, or records why it could not.
async fn start(
    shared: &Shared,
    service: &Arc<Server>,
    choice: BrowserBridgePort,
) -> Option<Listener> {
    let selection = PortSelection::new(choice, shared.ports_override.as_ref());
    match bind(service, &selection.candidates).await {
        Ok(listener) => {
            let port = listener.local_addr().port();
            shared.set_listening(Listening {
                port: Some(port),
                error: None,
            });
            shared
                .logger
                .info(&format!("bridge listening on 127.0.0.1:{port}"));
            Some(listener)
        }
        Err(error) => {
            shared.logger.warn(&error);
            shared.set_listening(Listening {
                port: None,
                error: Some(error),
            });
            None
        }
    }
}

/// `publishBridgePortChange`: the new port is bound before the old one is let go, so a taken
/// port leaves the bridge where it was. A browser seen on the old port proves nothing about the
/// new one, so presence and wake sockets start over.
async fn switch(
    shared: &Shared,
    service: &Arc<Server>,
    choice: BrowserBridgePort,
) -> Option<Listener> {
    let selection = PortSelection::new(choice, shared.ports_override.as_ref());
    match bind(service, &selection.candidates).await {
        Ok(listener) => {
            let port = listener.local_addr().port();
            shared.hub.revoke();
            shared.presence.forget_sightings();
            shared.set_listening(Listening {
                port: Some(port),
                error: None,
            });
            shared
                .logger
                .info(&format!("bridge listening on 127.0.0.1:{port}"));
            Some(listener)
        }
        Err(error) => {
            shared.logger.warn(&error);
            let mut listening = shared.listening();
            listening.error = Some(error);
            shared.set_listening(listening);
            None
        }
    }
}

/// The first candidate that binds, or the error text `prepareBridgeListener` reports.
async fn bind(service: &Arc<Server>, candidates: &[u16]) -> Result<Listener, String> {
    let options = ListenerOptions {
        header_read_timeout: HEADERS,
    };
    let mut failure: Option<(u16, io::Error)> = None;
    for &port in candidates {
        match Listener::bind_loopback_on(port, service.clone(), options).await {
            Ok(listener) => return Ok(listener),
            Err(error) => failure = Some((port, error)),
        }
    }
    Err(ports::bind_failure(candidates, failure))
}
