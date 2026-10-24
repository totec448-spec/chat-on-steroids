//! What the Compact & Resume transaction asks of owners other units port: the agent broker's
//! prime handover (E2.6), and the per-chat projections that move with the session (the
//! recorder's live mapping, the workspace, Goal and Loop). Each port has a `No…`
//! implementation that answers as TypeScript does when that owner holds nothing.

use cos_types::ids::SessionId;

/// `freezePrimeTransfer`: whether this chat leads a sub-agent run that the commit must carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freeze {
    /// The run's handover is pinned for the durable write.
    Frozen,
    /// The chat leads no run; nothing travels.
    Absent,
    /// The chat leads a run whose handover cannot be used; the commit is refused.
    Unavailable,
}

/// The agent broker's prime handover (`beginPrimeTransfer` and its siblings in `agents.ts`).
pub trait PrimeTransfer: Send + Sync + 'static {
    /// The continuation opened: the run must not end because chat A goes away.
    fn begin(&self, from: &str);
    /// The continuation ended without moving: release the pin.
    fn cancel(&self, from: &str);
    fn freeze(&self, from: &str) -> Freeze;
    /// The durable write failed after `freeze`: the handover is open again.
    fn thaw(&self, from: &str);
    /// The durable move landed: the prime is now chat `to`.
    fn commit(&self, from: &str, to: &str) -> bool;
    /// Recovery only: the WAL proves A to B landed in an earlier process.
    fn repair(&self, from: &str, to: &str) -> bool;
    /// Whether a sub-agent fleet is led from this chat.
    fn has_fleet(&self, conversation: &str) -> bool;
}

/// No agent broker: no chat leads a run.
pub struct NoPrime;

impl PrimeTransfer for NoPrime {
    fn begin(&self, _from: &str) {}
    fn cancel(&self, _from: &str) {}
    fn freeze(&self, _from: &str) -> Freeze {
        Freeze::Absent
    }
    fn thaw(&self, _from: &str) {}
    fn commit(&self, _from: &str, _to: &str) -> bool {
        false
    }
    fn repair(&self, _from: &str, _to: &str) -> bool {
        false
    }
    fn has_fleet(&self, _conversation: &str) -> bool {
        false
    }
}

/// The in-memory facts that follow the session once the durable record says chat B
/// (`publishCommittedProjection`): the recorder's live mapping, the chat's workspace, its Goal
/// objective and switch, and retiring A's Goal drafts. Total: it cannot fail or refuse.
pub trait Projections: Send + Sync + 'static {
    fn committed(&self, session: &SessionId, from: &str, to: &str);
}

/// Nothing outside the session store follows a chat.
pub struct NoProjections;

impl Projections for NoProjections {
    fn committed(&self, _session: &SessionId, _from: &str, _to: &str) {}
}
