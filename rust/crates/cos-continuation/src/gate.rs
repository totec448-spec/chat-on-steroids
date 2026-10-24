//! Whether a replacement chat is expected to appear right now (`session/resume-gate.ts`).
//!
//! The recorder invents a session for any conversation it has never seen, and the commit moves
//! the existing session onto chat B. While a claim is open, a new conversation is chat B until
//! proven otherwise, so the recorder waits for the commit instead of racing it.

use std::collections::HashMap;
use std::sync::Mutex;

/// `RESUME_CLAIM_WINDOW_MS`: how long after a claim chat B is still expected.
pub const RESUME_CLAIM_WINDOW_MS: u64 = 60_000;

#[derive(Clone, Copy, Debug)]
struct Claim {
    at: u64,
    /// The bootstrap crossed its dispatch fence: the transaction owns the gate until it ends.
    dispatched: bool,
}

/// The claims of every continuation that is opening its replacement chat.
#[derive(Default)]
pub struct ResumeGate {
    claims: Mutex<HashMap<String, Claim>>,
}

impl ResumeGate {
    fn claims(&self) -> std::sync::MutexGuard<'_, HashMap<String, Claim>> {
        self.claims
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// `noteResumeOpening` and `noteResumeClaim`: chat B is expected from `now`.
    pub fn note_claim(&self, token: &str, now: u64) {
        let mut claims = self.claims();
        let dispatched = claims.get(token).is_some_and(|claim| claim.dispatched);
        claims.insert(
            token.to_owned(),
            Claim {
                at: now,
                dispatched,
            },
        );
    }

    /// `noteResumeDispatch`: the bootstrap may already exist server-side.
    pub fn note_dispatch(&self, token: &str, now: u64) {
        self.claims().insert(
            token.to_owned(),
            Claim {
                at: now,
                dispatched: true,
            },
        );
    }

    /// `endResumeClaim`: the move landed or was given up.
    pub fn end(&self, token: &str) {
        self.claims().remove(token);
    }

    /// `resumeOpeningChat`: a dispatched claim holds until its transaction ends; an undispatched
    /// one expires after [`RESUME_CLAIM_WINDOW_MS`].
    pub fn opening_chat(&self, now: u64) -> bool {
        let mut claims = self.claims();
        claims.retain(|_, claim| {
            claim.dispatched || now.saturating_sub(claim.at) <= RESUME_CLAIM_WINDOW_MS
        });
        !claims.is_empty()
    }
}
