//! The desktop thread: the one place Win32 and UI Automation run.
//!
//! UIA handles live in a COM apartment that belongs to the thread that created them, and a
//! blocking native call must never stall the async runtime. So one dedicated thread owns the
//! [`Helper`] for the life of the [`crate::Desktop`], and callers queue requests to it. The
//! queue serializes every native effect, as the single helper process did.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::computer::{ComputerError, Route};
use crate::native::Helper;
use crate::native::policy::{self, Policy};

type Job = Box<dyn FnOnce(&mut Helper) + Send>;

pub(crate) struct DesktopThread {
    policy: Policy,
    /// Started on the first request, so a profile that never uses Desktop pays nothing.
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
    /// Held across one request, so a deadline measures native time, not queueing.
    turn: tokio::sync::Mutex<()>,
}

impl DesktopThread {
    pub(crate) fn new(policy: Policy) -> Self {
        Self {
            policy,
            jobs: Mutex::new(None),
            turn: tokio::sync::Mutex::new(()),
        }
    }

    fn sender(&self) -> Result<mpsc::Sender<Job>, ComputerError> {
        let mut jobs = self
            .jobs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(sender) = jobs.as_ref() {
            return Ok(sender.clone());
        }
        let (sender, receiver) = mpsc::channel::<Job>();
        let policy = self.policy;
        std::thread::Builder::new()
            .name("cos-desktop".to_owned())
            .spawn(move || {
                policy::install(policy);
                crate::native::keep_multithreaded_apartment();
                let mut helper = Helper::new();
                for job in receiver {
                    job(&mut helper);
                }
            })
            .map_err(|error| {
                ComputerError::new(format!("Could not start the desktop helper: {error}"))
            })?;
        *jobs = Some(sender.clone());
        Ok(sender)
    }

    /// Runs one helper request. A `{"ok": false}` reply becomes the same `CODE: message`
    /// error, with the completed-action evidence, that the TypeScript transport raised.
    pub(crate) async fn request(&self, request: Value) -> Result<Value, ComputerError> {
        let _turn = self.turn.lock().await;
        let deadline = deadline(&request);
        let (answer, reply) = oneshot::channel();
        let job: Job = Box::new(move |helper: &mut Helper| {
            let reply = catch_unwind(AssertUnwindSafe(|| helper.handle(&request)))
                .unwrap_or_else(|_| {
                    json!({"ok": false, "error_code": "HELPER_ERROR", "message": "the desktop helper failed"})
                });
            let _ = answer.send(reply);
        });
        self.sender()?
            .send(job)
            .map_err(|_| ComputerError::new("The desktop helper is shutting down."))?;
        let reply = match tokio::time::timeout(deadline, reply).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => {
                return Err(ComputerError::new(
                    "Desktop helper failed: the desktop thread stopped",
                ));
            }
            Err(_) => {
                return Err(ComputerError::new(
                    "The desktop helper did not answer in time.",
                ));
            }
        };
        match protocol_failure(&reply) {
            Some(error) => Err(error),
            None => Ok(reply),
        }
    }
}

/// `helperTimeoutMs` on Windows.
fn deadline(request: &Value) -> Duration {
    let millis = match request["op"].as_str().unwrap_or_default() {
        "windows" | "active" | "focus" | "cursor" => 5_000,
        "find_ui" => 8_000,
        "capture" | "snapshot" | "warm" => 10_000,
        "act" => {
            let drags: u64 = request["actions"]
                .as_array()
                .map(|actions| {
                    actions
                        .iter()
                        .take(20)
                        .filter(|action| action["type"] == "drag")
                        .map(|action| action["durationMs"].as_u64().unwrap_or(350).clamp(50, 2000))
                        .sum()
                })
                .unwrap_or(0);
            15_000 + drags
        }
        _ => 30_000,
    };
    Duration::from_millis(millis)
}

fn protocol_failure(reply: &Value) -> Option<ComputerError> {
    if reply["ok"] != false {
        return None;
    }
    let code = reply["error_code"].as_str().unwrap_or("HELPER_ERROR");
    let message = reply["message"].as_str().unwrap_or("Desktop helper failed");
    let completed = reply["completed_count"].as_u64();
    let routes = completed.and_then(|completed| {
        let routes = reply["routes"].as_array()?;
        if routes.len() as u64 != completed {
            return None;
        }
        routes
            .iter()
            .map(|route| route.as_str().and_then(Route::parse))
            .collect()
    });
    Some(ComputerError {
        message: format!("{code}: {message}"),
        completed_count: completed,
        failed_index: reply["failed_index"].as_u64(),
        completed_routes: routes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_reply_keeps_its_code_and_exact_completed_routes() {
        let error = protocol_failure(&json!({"ok": false, "error_code": "INPUT_FAILED",
            "message": "blocked", "completed_count": 1, "failed_index": 1,
            "routes": ["uia"]}))
        .expect("failure");
        assert_eq!(error.message, "INPUT_FAILED: blocked");
        assert_eq!(error.completed_count, Some(1));
        assert_eq!(error.failed_index, Some(1));
        assert_eq!(error.completed_routes, Some(vec![Route::Uia]));

        let mismatched = protocol_failure(&json!({"ok": false, "error_code": "X", "message": "m",
            "completed_count": 2, "routes": ["uia"]}))
        .expect("failure");
        assert_eq!(mismatched.completed_routes, None);
        assert!(protocol_failure(&json!({"ok": true})).is_none());
    }

    #[test]
    fn deadlines_follow_the_operation_and_drag_durations() {
        assert_eq!(deadline(&json!({"op": "windows"})), Duration::from_secs(5));
        assert_eq!(
            deadline(&json!({"op": "snapshot"})),
            Duration::from_secs(10)
        );
        let drag = json!({"op": "act", "actions": [{"type": "drag", "durationMs": 5000}, {"type": "click"}]});
        assert_eq!(deadline(&drag), Duration::from_millis(17_000));
    }
}
