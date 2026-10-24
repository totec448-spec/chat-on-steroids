//! Windows UI Automation observation and semantic input for the single desktop helper.
//! A `UiaState` must live and die on its creating COM thread; never share it with
//! another thread, or pass cached UIA handles across helper generations.

#[cfg(windows)]
mod managed;
#[cfg(windows)]
mod windows_uia;

#[cfg(windows)]
pub use windows_uia::{UiaAvailability, UiaState};

use cos_sidecar_runtime::DesktopError;
use serde_json::Value;

/// Physical-input authority remains with the desktop process. Every native mutation
/// revalidates the owner against its original complete action envelope.
pub trait UiaInputHost {
    fn assert_input_owner(&mut self, request: &Value) -> Result<(), DesktopError>;
    fn assert_focused(&mut self, window: i64) -> Result<(), DesktopError>;
    fn click(&mut self, x: i32, y: i32, button: &str, count: u32) -> Result<(), DesktopError>;
}

#[cfg(not(windows))]
pub struct UiaState;

#[cfg(not(windows))]
impl UiaState {
    pub fn new() -> Result<Self, DesktopError> {
        Err(DesktopError::new(
            "UIA_FAILED",
            "Windows UI Automation is unavailable on this operating system",
        ))
    }

    pub fn warm(&mut self) -> Result<(), DesktopError> {
        Err(DesktopError::new(
            "UIA_FAILED",
            "Windows UI Automation is unavailable",
        ))
    }

    pub fn find(&mut self, _request: &Value) -> Result<Value, DesktopError> {
        Err(DesktopError::new(
            "UIA_FAILED",
            "Windows UI Automation is unavailable",
        ))
    }

    pub fn act(
        &mut self,
        _request: &Value,
        _host: &mut impl UiaInputHost,
    ) -> Result<Value, DesktopError> {
        Err(DesktopError::new(
            "UIA_FAILED",
            "Windows UI Automation is unavailable",
        ))
    }
}
