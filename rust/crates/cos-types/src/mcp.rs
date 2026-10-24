//! Model-facing tool vocabulary shared with the extension and the desktop helper
//! (`src/shared/browser-control.ts`, `src/shared/windows-computer.ts`, `src/main/mcp/surfaces.ts`).

use serde::{Deserialize, Serialize};

use crate::json::{Extra, string_enum};

/// MCP server names per surface; ChatGPT caches tools under these names.
pub const SURFACE_SERVER_NAMES: [(&str, &str); 3] = [
    ("core", "chat-on-steroids-core"),
    ("desktop", "chat-on-steroids-desktop"),
    ("plugins", "chat-on-steroids-plugins"),
];

string_enum! {
    /// Desktop-surface browser tools (`BROWSER_TOOLS`).
    pub enum BrowserTool {
        Tabs = "browser_tabs", Snapshot = "browser_snapshot", Screenshot = "browser_screenshot",
        Console = "browser_console", Network = "browser_network", Navigate = "browser_navigate",
        Action = "browser_action", Evaluate = "browser_evaluate",
    }
}

impl BrowserTool {
    /// `BROWSER_READ_TOOLS`: exposed with the `screen` capability.
    pub const READ: [BrowserTool; 5] = [
        Self::Tabs,
        Self::Snapshot,
        Self::Screenshot,
        Self::Console,
        Self::Network,
    ];
    /// `BROWSER_WRITE_TOOLS`: exposed with the `control` capability.
    pub const WRITE: [BrowserTool; 3] = [Self::Navigate, Self::Action, Self::Evaluate];
}

string_enum! {
    /// The Windows desktop helper's public methods (`WINDOWS_COMPUTER_METHODS`).
    pub enum WindowsComputerMethod {
        ListWindows = "list_windows", GetWindow = "get_window", ListApps = "list_apps",
        GetWindowState = "get_window_state", LaunchApp = "launch_app", Click = "click",
        PressKey = "press_key", TypeText = "type_text", Scroll = "scroll", SetValue = "set_value",
        Drag = "drag", PerformSecondaryAction = "perform_secondary_action", ActivateWindow = "activate_window",
    }
}

impl WindowsComputerMethod {
    /// `WINDOWS_COMPUTER_READ_METHODS`: exposed with the `screen` capability.
    pub const READ: [WindowsComputerMethod; 4] = [
        Self::ListWindows,
        Self::GetWindow,
        Self::ListApps,
        Self::GetWindowState,
    ];
    /// `WINDOWS_COMPUTER_STATE_INPUT_METHODS`: inputs that consume the caller's retained observation.
    pub const STATE_INPUT: [WindowsComputerMethod; 5] = [
        Self::Click,
        Self::Scroll,
        Self::SetValue,
        Self::Drag,
        Self::PerformSecondaryAction,
    ];
}

/// A browser tool call handed to the extension (`BrowserCommand`).
///
/// `args` is the tool's own argument object, validated by the tool before it is queued and
/// typed loosely in TypeScript; it stays a JSON map here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCommand {
    pub id: String,
    pub epoch: String,
    pub owner: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_aliases: Option<Vec<String>>,
    pub conversation_id: Option<String>,
    pub tool: BrowserTool,
    pub args: Extra,
    pub expires_at: u64,
}

string_enum! {
    pub enum ImageMimeType { Jpeg = "image/jpeg", Png = "image/png" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImage {
    pub data: String,
    pub mime_type: ImageMimeType,
}

/// What the extension reports for one browser command (`BrowserResult`). `value` is the tool's
/// own result, `unknown` in TypeScript.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BrowserResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<BrowserImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `POST /browser-control` body, by `action`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum BrowserControlRequest {
    #[serde(rename_all = "camelCase")]
    Poll {
        browser_id: String,
        name: String,
        enabled: bool,
    },
    #[serde(rename_all = "camelCase")]
    Claim {
        browser_id: String,
        id: String,
        epoch: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        owners: Option<Vec<String>>,
    },
    #[serde(rename_all = "camelCase")]
    Check {
        browser_id: String,
        id: String,
        epoch: String,
    },
    #[serde(rename_all = "camelCase")]
    Result {
        browser_id: String,
        id: String,
        epoch: String,
        result: BrowserResult,
    },
}

/// Which surface capabilities currently allow browser reads and writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserPolicy {
    pub read: bool,
    pub write: bool,
}

/// `POST /browser-control` reply; each action has its own shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BrowserControlReply {
    Poll {
        epoch: String,
        requests: Vec<String>,
        policy: BrowserPolicy,
    },
    Claim {
        command: Option<BrowserCommand>,
    },
    Check {
        allowed: bool,
    },
    Result {
        ok: bool,
    },
}
