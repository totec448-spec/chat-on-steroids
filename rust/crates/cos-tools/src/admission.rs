//! The startup fence. Listeners bind and answer discovery at once; work that depends on
//! restored ledgers waits here until restore has finished.

use tokio::sync::watch;

/// The Core's lifecycle as admission sees it. Moves forward only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Phase {
    /// Ledgers are being restored. Discovery (`initialize`, `tools/list`, `/v1/health`) is
    /// answered; tool calls and session reads wait.
    Restoring,
    Serving,
    /// Shutdown has begun. Nothing new is admitted.
    Draining,
}

/// Admission refused because the Core is shutting down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Closed;

/// The reader side, cloned into every listener.
#[derive(Clone, Debug)]
pub struct Admission(watch::Receiver<Phase>);

/// The writer side. Only the Core's startup and shutdown sequence holds it.
#[derive(Debug)]
pub struct AdmissionGate(watch::Sender<Phase>);

impl Admission {
    /// A fence that starts in [`Phase::Restoring`].
    pub fn channel() -> (AdmissionGate, Admission) {
        let (sender, receiver) = watch::channel(Phase::Restoring);
        (AdmissionGate(sender), Admission(receiver))
    }

    pub fn phase(&self) -> Phase {
        *self.0.borrow()
    }

    /// Waits until restore has finished. Fails once shutdown has begun.
    pub async fn admit(&self) -> Result<(), Closed> {
        let mut phase = self.0.clone();
        match phase.wait_for(|phase| *phase != Phase::Restoring).await {
            Ok(phase) if *phase == Phase::Serving => Ok(()),
            _ => Err(Closed),
        }
    }
}

impl AdmissionGate {
    /// Moves the fence forward. A step backwards is ignored, so a late restore report cannot
    /// reopen admission during shutdown.
    pub fn advance(&self, next: Phase) {
        self.0.send_if_modified(|phase| {
            let forward = next > *phase;
            if forward {
                *phase = next;
            }
            forward
        });
    }

    pub fn admission(&self) -> Admission {
        Admission(self.0.subscribe())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn calls_wait_for_restore_and_are_refused_once_draining() {
        let (gate, admission) = Admission::channel();
        let waiting = tokio::spawn({
            let admission = admission.clone();
            async move { admission.admit().await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(), "admitted before restore finished");

        gate.advance(Phase::Serving);
        assert_eq!(waiting.await.expect("joins"), Ok(()));

        gate.advance(Phase::Draining);
        gate.advance(Phase::Serving);
        assert_eq!(
            admission.phase(),
            Phase::Draining,
            "the fence moved backwards"
        );
        assert_eq!(admission.admit().await, Err(Closed));
    }
}
