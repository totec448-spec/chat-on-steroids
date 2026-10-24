//! The handle a UI holds. It replaces the TypeScript app's ~131 IPC channels and its
//! `AppState` push with two things: snapshots to watch and work to run.
//!
//! Everything here is safe on any executor. A `watch` receiver needs no runtime, and
//! [`AppCore::spawn`] runs the work on the Core's own Tokio runtime and hands back a future
//! that completes on whichever executor awaits it, GPUI's included. Owners' async methods may
//! use Tokio IO freely, because they only ever run inside that runtime.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use cos_bridge::Bridge;
use cos_companion::{ChatModelCatalog, UsageSnapshot};
use cos_connection::Connection;
use cos_exec::ExecManager;
use cos_recorder::Recorder;
use cos_sessions::{BlockedChatsLedger, SessionIndex, SessionStore, TrustedChatsLedger};
use cos_store::Logger;
use cos_store::logger::LogEntry;
use cos_tools::{Admission, Kernel};
use cos_types::app_state::{BridgeStatus, ConnectionStatus};
use cos_types::config::Config;
use tokio::runtime::Handle;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

use crate::companion::CompanionDomains;
use crate::settings::Settings;

/// Every owner, for work run through [`AppCore::spawn`].
#[derive(Clone)]
pub struct Domains {
    pub settings: Settings,
    pub sessions: SessionStore,
    /// Page observations and the request-id proof ledger.
    pub recorder: Recorder,
    /// Chats the user stopped from using local tools; read before the endpoint takes a call.
    pub blocked_chats: BlockedChatsLedger,
    /// Chats the user trusts while the strict chat allowlist is on.
    pub trusted_chats: TrustedChatsLedger,
    pub connection: Connection,
    pub bridge: Bridge,
    pub kernel: Arc<Kernel>,
    pub exec: Arc<ExecManager>,
    /// The account's model catalog and usage limits, the extension's preferences and diagnostics.
    pub companion: CompanionDomains,
    /// Compact & Resume (E2.5).
    pub continuations: cos_continuation::Continuations,
    /// Prime-owned worker families and the `agents` tool.
    pub agents: cos_agents::Agents,
    pub logger: Logger,
}

impl Domains {
    /// The person's Disconnect for the browser (`unpair`): the bridge forgets its pairing and
    /// its sightings, and the extension's last diagnostics go with them.
    pub async fn disconnect_browser(&self) -> Result<(), cos_secrets::Error> {
        self.bridge.disconnect().await?;
        self.companion.diagnostics.clear();
        Ok(())
    }
}

/// Fresh receivers for every published snapshot. Each owner is the only writer of its own.
pub struct Watches {
    pub config: watch::Receiver<Arc<Config>>,
    pub connection: watch::Receiver<Arc<ConnectionStatus>>,
    pub bridge: watch::Receiver<Arc<BridgeStatus>>,
    pub sessions: watch::Receiver<Arc<SessionIndex>>,
    /// The account's ChatGPT model catalog (`chatModels:changed`).
    pub chat_models: watch::Receiver<Arc<ChatModelCatalog>>,
    /// The account's usage limits; read them through `UsageSnapshot::fresh`.
    pub usage: watch::Receiver<Arc<UsageSnapshot>>,
    /// Restoring, serving or draining.
    pub admission: Admission,
    /// Activity log lines as they are written.
    pub log: broadcast::Receiver<LogEntry>,
}

/// A cheap, cloneable handle to a running Core. Only [`crate::Core`] can shut it down.
#[derive(Clone)]
pub struct AppCore {
    shared: Arc<Shared>,
}

pub(crate) struct Shared {
    pub(crate) runtime: Handle,
    pub(crate) domains: Domains,
    pub(crate) admission: Admission,
    pub(crate) log: broadcast::Sender<LogEntry>,
}

impl AppCore {
    pub(crate) fn new(shared: Shared) -> Self {
        Self {
            shared: Arc::new(shared),
        }
    }

    pub(crate) fn domains(&self) -> &Domains {
        &self.shared.domains
    }

    pub fn watches(&self) -> Watches {
        let domains = &self.shared.domains;
        Watches {
            config: domains.settings.config(),
            connection: domains.connection.status(),
            bridge: domains.bridge.status(),
            sessions: domains.sessions.index(),
            chat_models: domains.companion.chat_models.watch(),
            usage: domains.companion.usage.watch(),
            admission: self.shared.admission.clone(),
            log: self.shared.log.subscribe(),
        }
    }

    /// The Core's activity log, for a UI that writes its own lines (startup trace, ledgers).
    pub fn logger(&self) -> Logger {
        self.shared.domains.logger.clone()
    }

    /// Runs `work` on the Core runtime with every owner at hand.
    pub fn spawn<F, Fut, T>(&self, work: F) -> CoreTask<T>
    where
        F: FnOnce(Domains) -> Fut,
        Fut: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        CoreTask(self.shared.runtime.spawn(work(self.shared.domains.clone())))
    }
}

/// Work running on the Core runtime. Await it from any executor.
pub struct CoreTask<T>(JoinHandle<T>);

/// The work panicked, or the Core shut down before it finished.
#[derive(Debug)]
pub struct TaskFailed;

impl<T> Future for CoreTask<T> {
    type Output = Result<T, TaskFailed>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0)
            .poll(cx)
            .map(|joined| joined.map_err(|_| TaskFailed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::{Wake, Waker};
    use std::thread::{self, Thread};
    use std::time::Duration;

    struct Unpark(Thread);

    impl Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }

    /// A bare executor with no Tokio context, standing in for GPUI's.
    fn block_on<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let waker = Waker::from(Arc::new(Unpark(thread::current())));
        let mut cx = Context::from_waker(&waker);
        loop {
            if let Poll::Ready(output) = future.as_mut().poll(&mut cx) {
                return output;
            }
            thread::park();
        }
    }

    #[test]
    fn core_work_and_snapshots_complete_on_a_foreign_executor() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("runtime");
        let (publish, mut snapshot) = watch::channel(0);
        // The sleep needs Tokio's timer, so the work can only finish inside the Core runtime.
        let task = CoreTask(runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            publish.send(1).expect("a receiver is alive");
            7
        }));

        block_on(snapshot.changed()).expect("the sender published");
        assert_eq!(*snapshot.borrow(), 1);
        assert_eq!(block_on(task).expect("the task finished"), 7);
    }
}
