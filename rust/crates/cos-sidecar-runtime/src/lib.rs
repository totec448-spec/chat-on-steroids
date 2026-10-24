//! The desktop helper's error envelope, shared by the Windows desktop, UI Automation and
//! capture crates. A refusal travels as `{"ok": false, "error_code": ..., "message": ...}`,
//! the reply shape the TypeScript app's native helper used.

use serde_json::{Value, json};

#[derive(Debug)]
pub struct DesktopError {
    pub code: &'static str,
    pub message: String,
}

impl DesktopError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The helper's refusal reply. Native handlers and their callers use this one shape.
    pub fn into_reply(self) -> Value {
        json!({ "ok": false, "error_code": self.code, "message": self.message })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::DesktopError;

    #[test]
    fn a_refusal_reply_carries_its_code_and_message() {
        assert_eq!(
            DesktopError::new("WINDOW_NOT_FOUND", "No visible target").into_reply(),
            json!({"ok": false, "error_code": "WINDOW_NOT_FOUND", "message": "No visible target"})
        );
    }
}
