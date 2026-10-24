//! One provider request and its bounded pre-delivery retries, from `test/task-request.test.ts`,
//! on Tokio's paused clock.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cos_continuation::task::{
    Cancel, Limits, TaskError, TaskPhase, TaskProgress, TaskRequests, retry_task_request,
};
use tokio::time::Instant;

fn clock() -> impl Fn() -> u64 + Send + Clone + 'static {
    let origin = Instant::now();
    move || origin.elapsed().as_millis() as u64 + 1_000_000
}

#[tokio::test(start_paused = true)]
async fn keeps_retrying_every_fifteen_seconds_until_it_succeeds() {
    let calls = Arc::new(AtomicU32::new(0));
    let counted = calls.clone();
    let result = tokio::spawn(async move {
        retry_task_request(
            move |_| {
                let attempt = counted.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt < 4 {
                        Err(TaskError::retryable("rate_limited", None))
                    } else {
                        Ok("ready")
                    }
                }
            },
            &Cancel::default(),
            |_| {},
            Limits::UNBOUNDED,
            clock(),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(59_999)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert_eq!(result.await.unwrap(), Ok("ready"));
    assert_eq!(calls.load(Ordering::SeqCst), 5);
}

#[tokio::test(start_paused = true)]
async fn honors_a_retry_after_beyond_thirty_days() {
    let delay = 30 * 24 * 60 * 60 * 1000;
    let calls = Arc::new(AtomicU32::new(0));
    let counted = calls.clone();
    let result = tokio::spawn(async move {
        retry_task_request(
            move |_| {
                let attempt = counted.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err(TaskError::retryable("rate_limited", Some(delay)))
                    } else {
                        Ok("ready")
                    }
                }
            },
            &Cancel::default(),
            |_| {},
            Limits::UNBOUNDED,
            clock(),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(delay - 1)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert_eq!(result.await.unwrap(), Ok("ready"));
}

#[tokio::test(start_paused = true)]
async fn coalesces_the_same_invocation_and_refuses_a_different_one() {
    let requests = Arc::new(TaskRequests::<&'static str>::default());
    let calls = Arc::new(AtomicU32::new(0));
    let progress = Arc::new(Mutex::new(Vec::<TaskProgress>::new()));
    let start = |requests: Arc<TaskRequests<&'static str>>| {
        let counted = calls.clone();
        let seen = progress.clone();
        tokio::spawn(async move {
            requests
                .run(
                    "request-1",
                    "same task",
                    move |_| {
                        let attempt = counted.fetch_add(1, Ordering::SeqCst);
                        async move {
                            if attempt == 0 {
                                Err(TaskError::retryable("rate_limited", Some(30_000)))
                            } else {
                                Ok("validated")
                            }
                        }
                    },
                    move |update| seen.lock().unwrap().push(update),
                    clock(),
                )
                .await
        })
    };
    let first = start(requests.clone());
    tokio::task::yield_now().await;
    let joined = start(requests.clone());
    tokio::time::sleep(Duration::from_millis(29_999)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        progress
            .lock()
            .unwrap()
            .iter()
            .any(|update| update.phase == TaskPhase::Retrying && update.attempt == Some(2))
    );
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert_eq!(first.await.unwrap(), Ok("validated"));
    assert_eq!(joined.await.unwrap(), Ok("validated"));
    assert_eq!(start(requests.clone()).await.unwrap(), Ok("validated"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "a settled request is never repeated"
    );
    let conflict = requests
        .run(
            "request-1",
            "different task",
            |_| async { Ok("x") },
            |_| {},
            clock(),
        )
        .await;
    assert_eq!(conflict, Err(TaskError::terminal("task_request_conflict")));
}

#[tokio::test(start_paused = true)]
async fn cancels_a_retry_wait_without_another_attempt() {
    let requests = Arc::new(TaskRequests::<&'static str>::default());
    let calls = Arc::new(AtomicU32::new(0));
    let last = Arc::new(Mutex::new(None::<TaskPhase>));
    let counted = calls.clone();
    let seen = last.clone();
    let running = requests.clone();
    let result = tokio::spawn(async move {
        running
            .run(
                "cancel-me",
                "task",
                move |_| {
                    counted.fetch_add(1, Ordering::SeqCst);
                    async { Err(TaskError::retryable("http_503", None)) }
                },
                move |update| *seen.lock().unwrap() = Some(update.phase),
                clock(),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert!(requests.cancel("cancel-me"));
    assert_eq!(
        result.await.unwrap(),
        Err(TaskError::terminal("task_cancelled"))
    );
    tokio::time::sleep(Duration::from_millis(30_000)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(*last.lock().unwrap(), Some(TaskPhase::Cancelled));
}

#[tokio::test(start_paused = true)]
async fn bounds_transient_retries_and_never_retries_a_terminal_failure() {
    let requests = Arc::new(TaskRequests::<&'static str>::default());
    let calls = Arc::new(AtomicU32::new(0));
    let counted = calls.clone();
    let bounded = requests
        .run(
            "bounded",
            "task",
            move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                async { Err(TaskError::retryable("rate_limited", None)) }
            },
            |_| {},
            clock(),
        )
        .await;
    assert_eq!(bounded.unwrap_err().message, "rate_limited");
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    let refused = Arc::new(AtomicU32::new(0));
    let counted = refused.clone();
    let terminal = requests
        .run(
            "terminal",
            "browser",
            move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                async { Err(TaskError::terminal("goal_browser_send_unconfirmed")) }
            },
            |_| {},
            clock(),
        )
        .await;
    assert_eq!(
        terminal.unwrap_err().message,
        "goal_browser_send_unconfirmed"
    );
    assert_eq!(refused.load(Ordering::SeqCst), 1);
    let delayed = Arc::new(AtomicU32::new(0));
    let counted = delayed.clone();
    let long = requests
        .run(
            "long",
            "long backoff",
            move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                async { Err(TaskError::retryable("rate_limited", Some(600_000))) }
            },
            |_| {},
            clock(),
        )
        .await;
    assert_eq!(long.unwrap_err().message, "rate_limited");
    assert_eq!(delayed.load(Ordering::SeqCst), 1);
}
