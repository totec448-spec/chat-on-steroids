//! `COS_APP_TRACE=1`: startup phases written to the Activity log, in milliseconds since `main`
//! began, so a cold-start number can be split into its parts.

use std::time::Instant;

use cos_store::Logger;

pub const ENV: &str = "COS_APP_TRACE";

#[derive(Clone)]
pub struct Trace {
    started: Instant,
    logger: Option<Logger>,
}

impl Trace {
    pub fn new(started: Instant, logger: &Logger) -> Self {
        let enabled = std::env::var(ENV).is_ok_and(|value| value == "1");
        Self {
            started,
            logger: enabled.then(|| logger.clone()),
        }
    }

    pub fn mark(&self, phase: &str) {
        if let Some(logger) = &self.logger {
            let ms = self.started.elapsed().as_secs_f64() * 1000.;
            logger.info(&format!("startup {phase} at {ms:.1} ms after main"));
        }
    }

    /// Marks a phase that happened earlier, at `at`.
    pub fn mark_at(&self, phase: &str, at: Instant) {
        if let Some(logger) = &self.logger {
            let ms = at.duration_since(self.started).as_secs_f64() * 1000.;
            logger.info(&format!("startup {phase} at {ms:.1} ms after main"));
        }
    }
}
