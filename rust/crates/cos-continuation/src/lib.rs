//! Compact & Resume, the handoff brief, the held finish boundary and repair claims (unit E2.5).
//!
//! [`Continuations`] ports `session/continuation.ts`: the transaction that moves one local
//! session from ChatGPT chat A to chat B, and its write-ahead log `state/continuations.json`.
//! [`handoff`] ports `session/handoff.ts`, `handoff-prompt.ts` and `shared/handoff.ts`.
//! [`finish`] ports `session/finish.ts` and the `session_finish` tool. [`compact`] answers
//! `POST /compact`, and [`repairs`] `POST /repairs/claim`, for the bridge family in
//! `cos-bridge`.

pub mod compact;
mod continuation;
mod events;
pub mod finish;
mod gate;
pub mod handoff;
mod js;
mod ports;
pub mod recovery;
pub mod repairs;
pub mod task;

use std::sync::Arc;

pub use continuation::{
    AUTOMATIC_HANDOVER_TTL_MS, CONTINUATION_PRO_WRITING_TTL_MS, CONTINUATION_TTL_MS,
    CONTINUATION_WRITING_TTL_MS, CommitResult, Continuations, ContinuationsDeps, NotDurable,
    SOURCE_UNDELIVERED_AFTER_MS, SendClaim, View, normalize_project_id, send_unattempted,
};
pub use cos_types::state::{
    ContinuationDestinationCheckpoint, ContinuationSendCheckpoint, ContinuationSendState,
    ContinuationState,
};
pub use events::Anchor;
pub use gate::{RESUME_CLAIM_WINDOW_MS, ResumeGate};
pub use ports::{Freeze, NoPrime, NoProjections, PrimeTransfer, Projections};

/// Milliseconds since the epoch. Tests drive it by hand.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The system clock.
pub fn system_clock() -> Clock {
    Arc::new(|| cos_tools::EpochMs::now().0)
}

/// A route's answer: the status and the JSON body `bridge.ts` sends.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: serde_json::Value,
}

impl Answer {
    pub fn new(status: u16, body: serde_json::Value) -> Self {
        Self { status, body }
    }

    /// `{ "error": word }`.
    pub fn error(status: u16, word: &str) -> Self {
        Self::new(status, serde_json::json!({ "error": word }))
    }
}

/// `N` random bytes from the OS; a clock-seeded fallback only when the OS refuses.
pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    if getrandom::getrandom(&mut bytes).is_err() {
        use std::hash::{BuildHasher, RandomState};
        for chunk in bytes.chunks_mut(8) {
            let seed = RandomState::new()
                .hash_one(std::time::Instant::now())
                .to_le_bytes();
            chunk.copy_from_slice(&seed[..chunk.len()]);
        }
    }
    bytes
}

/// `N` random bytes as lowercase hex.
pub(crate) fn random_hex<const N: usize>() -> String {
    random_bytes::<N>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
