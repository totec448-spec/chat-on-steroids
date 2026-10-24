//! When a page proves a request id, calls already filed as Unattributed under that id move to
//! the chat (`scheduleAttributionRepair` and `startAttributionRepair` in
//! `src/main/session/recorder.ts`). A burst of new owners becomes one pass, 250 ms after the
//! first, and passes never overlap. The kernel's recording step never waits for any of this.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use cos_sessions::SessionStore;
use cos_types::config::Config;
use tokio::sync::watch;

use crate::correlation::Correlations;

const COALESCE: Duration = Duration::from_millis(250);
/// More named ids than this become one pass over every bucket.
const MAX_NAMED: usize = 50_000;

#[derive(Default)]
enum Wanted {
    #[default]
    Nothing,
    Ids(HashSet<String>),
    Everything,
}

#[derive(Default)]
struct Pending {
    wanted: Wanted,
    timer: bool,
}

/// The repair queue. Clones share one.
#[derive(Clone)]
pub(crate) struct Repairs {
    inner: Arc<Inner>,
}

struct Inner {
    sessions: SessionStore,
    correlations: Correlations,
    config: watch::Receiver<Arc<Config>>,
    pending: Mutex<Pending>,
    /// One pass at a time.
    running: tokio::sync::Mutex<()>,
}

fn lock(pending: &Mutex<Pending>) -> MutexGuard<'_, Pending> {
    pending.lock().unwrap_or_else(|poison| poison.into_inner())
}

impl Repairs {
    pub(crate) fn new(
        sessions: SessionStore,
        correlations: Correlations,
        config: watch::Receiver<Arc<Config>>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions,
                correlations,
                config,
                pending: Mutex::new(Pending::default()),
                running: tokio::sync::Mutex::new(()),
            }),
        }
    }

    /// A new owner for this id: repair within 250 ms, together with any others that arrive.
    pub(crate) fn proved(&self, request_id: &str) {
        let arm = {
            let mut pending = lock(&self.inner.pending);
            match &mut pending.wanted {
                Wanted::Everything => {}
                Wanted::Nothing => {
                    pending.wanted = Wanted::Ids(HashSet::from([request_id.to_owned()]));
                }
                Wanted::Ids(ids) => {
                    ids.insert(request_id.to_owned());
                    if ids.len() > MAX_NAMED {
                        pending.wanted = Wanted::Everything;
                    }
                }
            }
            !std::mem::replace(&mut pending.timer, true)
        };
        if arm && let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let repairs = self.clone();
            runtime.spawn(async move {
                tokio::time::sleep(COALESCE).await;
                repairs.drain().await;
            });
        }
    }

    /// `queueDeterministicAttributionRepair`: one pass over every bucket, started now and not
    /// awaited, so startup never waits behind old history.
    pub(crate) fn everything(&self) {
        lock(&self.inner.pending).wanted = Wanted::Everything;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let repairs = self.clone();
            runtime.spawn(async move { repairs.drain().await });
        }
    }

    /// Runs what is wanted now, and returns once every pass that was queued has finished.
    pub(crate) async fn drain(&self) {
        let _running = self.inner.running.lock().await;
        loop {
            let wanted = {
                let mut pending = lock(&self.inner.pending);
                pending.timer = false;
                std::mem::take(&mut pending.wanted)
            };
            let affected = match wanted {
                Wanted::Nothing => return,
                Wanted::Ids(ids) => Some(ids),
                Wanted::Everything => None,
            };
            if !self.inner.config.borrow().sessions.record {
                continue;
            }
            let correlations = &self.inner.correlations;
            let owner_of = |request_id: &str| correlations.lookup(request_id);
            self.inner
                .sessions
                .repair_attribution(&owner_of, affected.as_ref())
                .await;
        }
    }
}
