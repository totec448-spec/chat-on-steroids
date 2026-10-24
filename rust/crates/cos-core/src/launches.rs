//! The profile lock and later launches on it. The lock's channel is blocking, so one thread
//! owns the lock and moves each forwarded command line onto an async channel the UI
//! (activate the window) or the headless binary (`--quit`) can await.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cos_store::Instance;
use tokio::sync::mpsc;

/// How long a forwarded launch can wait before the thread notices it, and how long releasing
/// the lock waits for the thread.
const POLL: Duration = Duration::from_millis(100);

/// Owns the profile lock until [`LaunchForwarder::release`].
pub(crate) struct LaunchForwarder {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl LaunchForwarder {
    pub(crate) fn spawn(
        instance: Instance,
        launches: mpsc::UnboundedSender<Vec<String>>,
    ) -> std::io::Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = thread::Builder::new()
            .name("cos-launches".into())
            .spawn(move || {
                // Runs until released, whatever happens to either channel: leaving early would
                // release the lock while the Core still writes to the profile.
                while !stopping.load(Ordering::SeqCst) {
                    match instance.second_launches().recv_timeout(POLL) {
                        Ok(argv) => {
                            // With no listener the launch has nothing to activate.
                            let _ = launches.send(argv);
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => thread::sleep(POLL),
                    }
                }
                drop(instance);
            })?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }

    /// Stops forwarding and releases the profile lock.
    pub(crate) fn release(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            // A thread that panicked has already dropped the lock.
            let _ = thread.join();
        }
    }
}
