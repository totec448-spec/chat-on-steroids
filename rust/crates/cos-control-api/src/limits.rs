//! What the API lets a caller queue behind the app: rate windows, the read deadline, and the
//! few places for journal reads, event streams and actions.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::reply::Refusal;

const WINDOW: Duration = Duration::from_secs(60);

/// Requests per rolling minute.
#[derive(Debug)]
pub(crate) struct RateWindow {
    limit: usize,
    recent: Mutex<VecDeque<Instant>>,
}

impl RateWindow {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            limit,
            recent: Mutex::new(VecDeque::new()),
        }
    }

    /// Spends one request, or says the minute's budget is gone. A refusal spends nothing.
    pub(crate) fn spend(&self) -> bool {
        let now = Instant::now();
        let mut recent = self.recent.lock().unwrap_or_else(PoisonError::into_inner);
        while recent
            .front()
            .is_some_and(|at| now.duration_since(*at) >= WINDOW)
        {
            recent.pop_front();
        }
        if recent.len() >= self.limit {
            return false;
        }
        recent.push_back(now);
        true
    }
}

/// A fixed number of places; a request that finds none is turned away at once.
#[derive(Clone, Debug)]
pub(crate) struct Places {
    places: Arc<Semaphore>,
    busy: &'static str,
}

impl Places {
    pub(crate) fn new(count: usize, busy: &'static str) -> Self {
        Self {
            places: Arc::new(Semaphore::new(count)),
            busy,
        }
    }

    pub(crate) fn take(&self) -> Result<OwnedSemaphorePermit, Refusal> {
        self.places
            .clone()
            .try_acquire_owned()
            .map_err(|_| Refusal::Busy(self.busy))
    }
}

/// `withReadDeadline`: a read that waits on a stuck owner is answered 504 at the deadline. The
/// read itself runs on as its own task and keeps its place until it ends, so a watcher that
/// keeps polling cannot pile up stuck reads behind the owner. A read whose owner panics is
/// answered 500.
#[derive(Clone, Debug)]
pub(crate) struct Reads {
    unfinished: Places,
    deadline: Duration,
}

impl Reads {
    pub(crate) fn new(places: usize, deadline: Duration) -> Self {
        Self {
            unfinished: Places::new(
                places,
                "too many reads are waiting on the app; retry shortly",
            ),
            deadline,
        }
    }

    pub(crate) async fn run<T, F>(&self, read: F) -> Result<T, Refusal>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, Refusal>> + Send + 'static,
    {
        let place = self.unfinished.take()?;
        let task = tokio::spawn(async move {
            let _place = place;
            read.await
        });
        match tokio::time::timeout(self.deadline, task).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(Refusal::Internal),
            Err(_) => Err(Refusal::Timeout(
                "the app did not answer in time; /v1/health may still answer",
            )),
        }
    }
}

#[derive(Default)]
struct Turn {
    expired: bool,
    started: bool,
}

/// `runAction`: actions run one at a time, in arrival order, each under a deadline. One answered
/// 504 before its turn came never runs; one answered while it ran may still finish.
#[derive(Clone, Debug)]
pub(crate) struct Actions {
    pending: Places,
    chain: Arc<tokio::sync::Mutex<()>>,
    deadline: Duration,
}

impl Actions {
    pub(crate) fn new(pending: usize, deadline: Duration) -> Self {
        Self {
            pending: Places::new(pending, "too many actions are waiting; retry shortly"),
            chain: Arc::new(tokio::sync::Mutex::new(())),
            deadline,
        }
    }

    pub(crate) async fn run<T, F>(&self, action: F) -> Result<T, Refusal>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, Refusal>> + Send + 'static,
    {
        let place = self.pending.take()?;
        let turn = Arc::new(Mutex::new(Turn::default()));
        let chain = self.chain.clone();
        let mine = turn.clone();
        let task = tokio::spawn(async move {
            let _place = place;
            let _turn = chain.lock().await;
            {
                let mut turn = mine.lock().unwrap_or_else(PoisonError::into_inner);
                if turn.expired {
                    return Err(Refusal::Timeout("expired before it started"));
                }
                turn.started = true;
            }
            action.await
        });
        match tokio::time::timeout(self.deadline, task).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(Refusal::Internal),
            Err(_) => {
                let mut turn = turn.lock().unwrap_or_else(PoisonError::into_inner);
                turn.expired = true;
                Err(Refusal::Timeout(if turn.started {
                    "the action may still complete; check GET /v1/inputs before repeating it"
                } else {
                    "the action did not start and will not run; it is safe to send again"
                }))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_refuses_past_its_limit_and_a_refusal_spends_nothing() {
        let window = RateWindow::new(2);
        assert!(window.spend());
        assert!(window.spend());
        assert!(!window.spend());
        assert_eq!(window.recent.lock().expect("lock").len(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stuck_read_is_answered_at_the_deadline_and_keeps_its_place() {
        let reads = Reads::new(1, Duration::from_millis(50));
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let stuck = reads
            .run(async move {
                let _ = released.await;
                Ok(())
            })
            .await;
        assert!(matches!(stuck, Err(Refusal::Timeout(_))));
        assert!(matches!(
            reads.run(async { Ok(()) }).await,
            Err(Refusal::Busy(_))
        ));
        release.send(()).expect("the stuck read is still waiting");
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(reads.run(async { Ok(7) }).await, Ok(7));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_read_whose_owner_panics_is_an_internal_error() {
        let reads = Reads::new(1, Duration::from_secs(5));
        let failed: Result<(), Refusal> = reads.run(async { panic!("owner failed") }).await;
        assert_eq!(failed, Err(Refusal::Internal));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_action_answered_before_its_turn_never_runs() {
        let actions = Actions::new(4, Duration::from_millis(50));
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let first = actions.clone();
        let blocking = tokio::spawn(async move {
            first
                .run(async move {
                    let _ = released.await;
                    Ok(())
                })
                .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        let flag = ran.clone();
        let second = actions
            .run(async move {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert_eq!(
            second,
            Err(Refusal::Timeout(
                "the action did not start and will not run; it is safe to send again"
            ))
        );
        assert_eq!(
            blocking.await.expect("joins"),
            Err(Refusal::Timeout(
                "the action may still complete; check GET /v1/inputs before repeating it"
            ))
        );
        release.send(()).ok();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
    }
}
