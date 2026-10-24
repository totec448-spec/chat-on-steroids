//! The bounded shutdown sequence (`src/main/shutdown.ts`).
//!
//! Phases run strictly in order, and a phase's work is not created until the phase is
//! reached. Within a phase the tasks run concurrently and independently; one failure never
//! skips its siblings. A phase that overruns its budget is abandoned, not awaited: the
//! sequence always reaches its end, because a Core that never exits keeps the profile lock
//! and every later launch does nothing.

use std::future::Future;
use std::time::Duration;

use tokio::task::JoinSet;
use tokio::time::Instant;

use cos_store::Logger;

/// The phases, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShutdownPhase {
    /// Stop admitting work and drain accepted HTTP requests. Its budget is the outer bound on
    /// the drains it contains (the MCP endpoint forces its own at 30 s).
    Drain,
    /// Only after handlers are done may the processes they own go.
    Processes,
    /// Recorder work can still enqueue session and ledger writes.
    Recorder,
    /// Sessions and named durable state, independent writers flushed side by side.
    Durable,
    /// Hand a verified staged update to the installer (G4.4). Last, because its effect is meant
    /// to outlive this process.
    UpdateHandoff,
}

impl ShutdownPhase {
    pub const ALL: [Self; 5] = [
        Self::Drain,
        Self::Processes,
        Self::Recorder,
        Self::Durable,
        Self::UpdateHandoff,
    ];

    pub fn budget(self) -> Duration {
        Duration::from_secs(match self {
            Self::Drain => 40,
            Self::Processes => 15,
            Self::Recorder | Self::Durable => 10,
            Self::UpdateHandoff => 5,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhaseOutcome {
    Completed,
    /// Some tasks panicked; the others finished.
    Failed {
        tasks: usize,
    },
    /// The budget ran out with this many tasks still running.
    Overran {
        tasks: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PhaseReport {
    pub phase: ShutdownPhase,
    pub outcome: PhaseOutcome,
    pub elapsed: Duration,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShutdownReport {
    pub phases: Vec<PhaseReport>,
}

/// The work of one phase, built only when the phase is reached.
pub(crate) type PhaseTasks = Vec<std::pin::Pin<Box<dyn Future<Output = ()> + Send>>>;

/// Runs every phase on the current runtime. Each task is its own Tokio task, so a panic is
/// counted rather than propagated.
pub(crate) async fn run(
    logger: &Logger,
    mut tasks_for: impl FnMut(ShutdownPhase) -> PhaseTasks,
) -> ShutdownReport {
    let mut report = ShutdownReport::default();
    for phase in ShutdownPhase::ALL {
        let started = Instant::now();
        let mut running = JoinSet::new();
        for task in tasks_for(phase) {
            running.spawn(task);
        }
        let mut failed = 0;
        let settled = tokio::time::timeout(phase.budget(), async {
            while let Some(joined) = running.join_next().await {
                if joined.is_err() {
                    failed += 1;
                }
            }
        })
        .await;
        let outcome = match settled {
            Err(_) => PhaseOutcome::Overran {
                tasks: running.len(),
            },
            Ok(()) if failed > 0 => PhaseOutcome::Failed { tasks: failed },
            Ok(()) => PhaseOutcome::Completed,
        };
        // Overrun tasks keep running detached; the runtime shutdown that follows ends them.
        running.detach_all();
        let elapsed = started.elapsed();
        match outcome {
            PhaseOutcome::Completed => {
                logger.info(&format!(
                    "shutdown {phase:?} done in {} ms",
                    elapsed.as_millis()
                ));
            }
            other => logger.warn(&format!(
                "shutdown {phase:?} {other:?} after {} ms",
                elapsed.as_millis()
            )),
        }
        report.phases.push(PhaseReport {
            phase,
            outcome,
            elapsed,
        });
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test(start_paused = true)]
    async fn every_phase_runs_in_order_even_after_a_panic_and_an_overrun() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let report = run(&Logger::new(), |phase| {
            let order = order.clone();
            let mut tasks: PhaseTasks = vec![Box::pin(async move {
                order.lock().expect("unpoisoned").push(phase);
            })];
            match phase {
                ShutdownPhase::Processes => tasks.push(Box::pin(async { panic!("seeded") })),
                ShutdownPhase::Recorder => tasks.push(Box::pin(std::future::pending())),
                _ => {}
            }
            tasks
        })
        .await;

        assert_eq!(*order.lock().expect("unpoisoned"), ShutdownPhase::ALL);
        let outcomes: Vec<_> = report.phases.iter().map(|phase| phase.outcome).collect();
        assert_eq!(
            outcomes,
            [
                PhaseOutcome::Completed,
                PhaseOutcome::Failed { tasks: 1 },
                PhaseOutcome::Overran { tasks: 1 },
                PhaseOutcome::Completed,
                PhaseOutcome::Completed,
            ]
        );
        assert_eq!(report.phases[2].elapsed, ShutdownPhase::Recorder.budget());
    }
}
