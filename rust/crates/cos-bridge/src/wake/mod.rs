//! The wake socket (`browser-wake.ts`): tells the extension when to read work over HTTP. It
//! never carries work, so a lost signal costs nothing: every reconnection is sent `wake` and
//! reads current work, and the durable HTTP claims stay the only delivery authority.

mod frame;
mod socket;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use cos_store::Logger;
use cos_types::bridge::{WAKE_MAX_CLIENTS, WAKE_STALE_MS, WakeHost, WakeSignal};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::time::Instant;

pub(crate) use frame::accept_key;
pub(crate) use socket::serve;

/// Frames waiting to be written to one socket. A client that lets this many pile up is not
/// reading, the counterpart of `bufferedAmount >= 1024` in `ws` (a frame is at most 16 bytes).
const OUTBOX_FRAMES: usize = 64;

/// Publishes work to the extension. Cloned into every owner that has work to announce.
#[derive(Clone)]
pub struct Wake(pub(crate) Arc<Hub>);

impl Wake {
    /// `wakeBrowserWork(topic)`: every authenticated socket reads its work now. A socket that
    /// cannot take the frame is closed; its extension reconnects and reads the work then.
    pub fn signal(&self, signal: WakeSignal) {
        self.0.signal(signal);
    }

    /// An authenticated socket is open and answering, from the given copy of the extension or
    /// from any.
    pub fn connected(&self, host: Option<WakeHost>) -> bool {
        self.0.connected(host, Instant::now())
    }
}

pub(crate) struct Hub {
    state: Mutex<HubState>,
    changed: Arc<Notify>,
    logger: Logger,
}

#[derive(Default)]
struct HubState {
    /// Bumped by revoke. An authentication that finishes after it is refused.
    epoch: u64,
    next_id: u64,
    clients: HashMap<u64, Client>,
}

struct Client {
    host: Option<WakeHost>,
    /// Set by authentication and every `pong`; `None` before authentication or after revoke.
    seen: Option<Instant>,
    outbox: mpsc::Sender<Vec<u8>>,
    /// Taken when the socket is told to close, so a closing socket is no longer open.
    kill: Option<oneshot::Sender<()>>,
}

impl Client {
    fn open(&self) -> bool {
        self.kill.is_some()
    }

    fn reading(&self) -> bool {
        self.outbox.capacity() > 0
    }

    fn terminate(&mut self) {
        if let Some(kill) = self.kill.take() {
            let _ = kill.send(());
        }
    }
}

/// A socket the hub has counted, before and after its upgrade completes.
pub(crate) struct Admitted {
    pub(crate) id: u64,
    pub(crate) generation: u64,
    pub(crate) outbox: mpsc::Sender<Vec<u8>>,
    pub(crate) outgoing: mpsc::Receiver<Vec<u8>>,
    pub(crate) kill: oneshot::Receiver<()>,
}

impl Hub {
    pub(crate) fn new(changed: Arc<Notify>, logger: Logger) -> Self {
        Self {
            state: Mutex::default(),
            changed,
            logger,
        }
    }

    /// Counts a new socket, or `None` when [`WAKE_MAX_CLIENTS`] are already open.
    pub(crate) fn admit(&self, host: Option<WakeHost>) -> Option<Admitted> {
        let mut state = self.lock();
        if state.clients.len() >= WAKE_MAX_CLIENTS {
            return None;
        }
        state.next_id += 1;
        let id = state.next_id;
        let (outbox, outgoing) = mpsc::channel(OUTBOX_FRAMES);
        let (kill, killed) = oneshot::channel();
        state.clients.insert(
            id,
            Client {
                host,
                seen: None,
                outbox: outbox.clone(),
                kill: Some(kill),
            },
        );
        Some(Admitted {
            id,
            generation: state.epoch,
            outbox,
            outgoing,
            kill: killed,
        })
    }

    /// The socket's token matched. Refused when a revoke happened since the socket opened.
    pub(crate) fn authorize(&self, id: u64, generation: u64) -> bool {
        let mut state = self.lock();
        if state.epoch != generation {
            return false;
        }
        let Some(client) = state.clients.get_mut(&id).filter(|client| client.open()) else {
            return false;
        };
        client.seen = Some(Instant::now());
        drop(state);
        self.logger
            .info("bridge: browser wake channel authenticated");
        self.changed.notify_one();
        true
    }

    pub(crate) fn pong(&self, id: u64) {
        if let Some(client) = self.lock().clients.get_mut(&id)
            && client.seen.is_some()
        {
            client.seen = Some(Instant::now());
        }
    }

    /// The socket ended, for any reason.
    pub(crate) fn leave(&self, id: u64) {
        let removed = self.lock().clients.remove(&id);
        if removed.is_some_and(|client| client.seen.is_some()) {
            self.logger
                .info("bridge: browser wake channel disconnected");
            self.changed.notify_one();
        }
    }

    fn signal(&self, signal: WakeSignal) {
        let frame = frame::text(signal.as_str());
        for client in self.lock().clients.values_mut() {
            if client.seen.is_none() {
                continue;
            }
            if !client.open() || client.outbox.try_send(frame.clone()).is_err() {
                client.terminate();
            }
        }
    }

    /// Every 20 s: a socket silent for 45 s, or not reading, is closed, and the rest get a
    /// `ping`. Chrome keeps an extension worker alive while its WebSocket is active.
    pub(crate) fn heartbeat(&self, now: Instant) {
        let ping = frame::text(WakeSignal::Ping.as_str());
        for client in self.lock().clients.values_mut() {
            let Some(seen) = client.seen else { continue };
            let silent = now.duration_since(seen) > stale() || !client.reading();
            if silent || (client.open() && client.outbox.try_send(ping.clone()).is_err()) {
                client.terminate();
            }
        }
    }

    /// Disconnect, a port change or shutdown: every socket closes, and an authentication still
    /// in flight is refused when it finishes.
    pub(crate) fn revoke(&self) {
        let mut state = self.lock();
        state.epoch += 1;
        let mut had = false;
        for client in state.clients.values_mut() {
            had |= client.seen.take().is_some();
            client.terminate();
        }
        drop(state);
        if had {
            self.changed.notify_one();
        }
    }

    pub(crate) fn connected(&self, host: Option<WakeHost>, now: Instant) -> bool {
        self.lock().clients.values().any(|client| {
            client.open()
                && client.reading()
                && client
                    .seen
                    .is_some_and(|seen| now.duration_since(seen) <= stale())
                && (host.is_none() || client.host == host)
        })
    }

    fn lock(&self) -> MutexGuard<'_, HubState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn stale() -> Duration {
    Duration::from_millis(WAKE_STALE_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub() -> Hub {
        Hub::new(Arc::new(Notify::new()), Logger::new())
    }

    #[tokio::test]
    async fn the_heartbeat_pings_a_live_socket_and_closes_a_silent_one() {
        let hub = hub();
        let mut live = hub.admit(None).expect("admitted");
        let mut silent = hub.admit(None).expect("admitted");
        assert!(hub.authorize(live.id, live.generation));
        assert!(hub.authorize(silent.id, silent.generation));
        let now = Instant::now();
        hub.pong(live.id);
        hub.heartbeat(now + Duration::from_secs(1));
        assert_eq!(live.outgoing.try_recv().ok(), Some(frame::text("ping")));
        hub.pong(live.id);
        let later = Instant::now() + stale() + Duration::from_millis(1);
        hub.lock().clients.get_mut(&live.id).expect("live").seen = Some(later);
        hub.heartbeat(later);
        assert!(
            live.kill.try_recv().is_err(),
            "a socket that answered was closed"
        );
        assert!(
            silent.kill.try_recv().is_ok(),
            "a silent socket stayed open"
        );
    }

    #[tokio::test]
    async fn a_socket_that_stops_reading_is_closed_instead_of_queued_without_end() {
        let hub = hub();
        let mut stuck = hub.admit(None).expect("admitted");
        assert!(hub.authorize(stuck.id, stuck.generation));
        for _ in 0..OUTBOX_FRAMES {
            hub.signal(WakeSignal::Wake);
        }
        assert!(
            !hub.connected(None, Instant::now()),
            "a full outbox still counts as connected"
        );
        hub.signal(WakeSignal::Wake);
        assert!(stuck.kill.try_recv().is_ok());
    }

    #[tokio::test]
    async fn an_authentication_that_finishes_after_a_revoke_is_refused() {
        let hub = hub();
        let pending = hub.admit(None).expect("admitted");
        hub.revoke();
        assert!(!hub.authorize(pending.id, pending.generation));
        assert!(!hub.connected(None, Instant::now()));
    }
}
