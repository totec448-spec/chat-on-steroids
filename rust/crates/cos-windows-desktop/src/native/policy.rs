//! What one desktop thread may see and touch, fixed when the thread starts.
//!
//! Every Win32 and UIA call runs on the thread that owns a [`crate::Desktop`], so a
//! thread-local is exactly that desktop's policy. A thread that never installed one (a unit
//! test calling these functions directly) gets the safe default: no native effects.

use std::cell::Cell;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    /// This process's windows are left out of every lookup, so the model cannot drive the app
    /// that serves it.
    pub hidden_pid: Option<u32>,
    /// Synthetic input, foreground changes, app launches and the clipboard.
    pub native_effects: bool,
}

thread_local! {
    static POLICY: Cell<Policy> = const {
        Cell::new(Policy { hidden_pid: None, native_effects: false })
    };
}

pub(crate) fn install(policy: Policy) {
    POLICY.with(|cell| cell.set(policy));
}

pub(crate) fn current() -> Policy {
    POLICY.with(Cell::get)
}

pub(crate) fn require_native_effects() -> Result<(), cos_sidecar_runtime::DesktopError> {
    if current().native_effects {
        Ok(())
    } else {
        Err(cos_sidecar_runtime::DesktopError::new(
            "INPUT_REFUSED",
            "this desktop observes its own windows only and never sends input, changes the foreground, launches apps or uses the clipboard",
        ))
    }
}
