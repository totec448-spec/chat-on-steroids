//! The Desktop surface tools (`src/main/mcp/tools-desktop-windows.ts`): the 13 Window2
//! methods and the two clipboard tools, their caller contexts and their result shapes.

use std::sync::{Arc, Mutex};

use cos_tools::{
    CallContext, CallNotes, Capability, Content, DynTool, Listing, Requirement, Tool, ToolError,
    ToolOutput, ToolResult, ToolSpec,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{Click, StateArgs, WindowArg, WindowsApi};
use crate::chords;
use crate::computer::{Action, Computer, ComputerError, StateRequest, Target};
use crate::native::policy::Policy;
use crate::thread::DesktopThread;

/// The whole MCP result, text and images together, must stay under this many bytes.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024 - 64 * 1024;
const MAX_CONTEXTS: usize = 32;
const MAX_CLIPBOARD_UNITS: usize = 64_000;
/// These inputs consume the observation retained for the exact caller.
const STATE_INPUT_METHODS: [&str; 5] = [
    "click",
    "scroll",
    "set_value",
    "drag",
    "perform_secondary_action",
];

/// The Windows desktop: one native thread and the observations of each caller.
pub struct Desktop {
    computer: Computer,
    /// Callers' observation contexts, oldest first.
    contexts: Mutex<Vec<(String, Arc<WindowsApi>)>>,
}

impl Desktop {
    /// The product desktop. This process's own windows are invisible to it, and it sends real
    /// input when a tool asks.
    pub fn new() -> Arc<Self> {
        Self::with_policy(Policy {
            hidden_pid: Some(std::process::id()),
            native_effects: true,
        })
    }

    /// A desktop for tests that sees this process's own windows and has no native effects: it
    /// never sends synthetic input, changes the foreground, launches an app or touches the
    /// clipboard. Observation and UI Automation patterns still work.
    #[doc(hidden)]
    pub fn observing_own_windows() -> Arc<Self> {
        Self::with_policy(Policy {
            hidden_pid: None,
            native_effects: false,
        })
    }

    fn with_policy(policy: Policy) -> Arc<Self> {
        Arc::new(Self {
            computer: Computer::new(DesktopThread::new(policy)),
            contexts: Mutex::new(Vec::new()),
        })
    }

    /// `apiForCaller`: the observation context this exact caller may use.
    fn api_for(&self, cx: &CallContext, method: &str) -> Result<Arc<WindowsApi>, ComputerError> {
        let allow = cx.grants.allow_unattributed;
        let mut principals = Vec::new();
        if let Some((_, session)) = &cx.caller.chat {
            principals.push(format!("session:{}", session.as_str()));
        }
        if allow && let Some(request) = &cx.caller.request_id {
            principals.push(format!("request:{}", request.as_str()));
        }
        if allow && principals.is_empty() {
            principals.push("unattributed".to_owned());
        }
        let mut contexts = self
            .contexts
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if principals.is_empty() {
            contexts.retain(|(principal, _)| principal != "unattributed");
            if STATE_INPUT_METHODS.contains(&method) {
                return Err(ComputerError::new(
                    "CALLER_IDENTITY_REQUIRED: indexed and coordinate input requires exact companion identity or Allow unattributed calls enabled in app settings; no input ran.",
                ));
            }
            // Unattributed reads stay useful, but never publish an observation another
            // anonymous call could consume.
            return Ok(Arc::new(WindowsApi::new()));
        }
        let api = principals
            .iter()
            .find_map(|principal| {
                contexts
                    .iter()
                    .find(|(known, _)| known == principal)
                    .map(|(_, api)| api.clone())
            })
            .unwrap_or_else(|| Arc::new(WindowsApi::new()));
        for principal in principals {
            contexts.retain(|(known, _)| *known != principal);
            contexts.push((principal, api.clone()));
        }
        let excess = contexts.len().saturating_sub(MAX_CONTEXTS);
        contexts.drain(..excess);
        Ok(api)
    }

    /// The registrar's guarded handler: policy checks, then the method, then the result shape.
    async fn run(
        &self,
        cx: &CallContext,
        method: &'static str,
        call: Call,
    ) -> Result<ToolOutput, ToolError> {
        if let Call::TypeText(window, text) = &call
            && text.contains(['\r', '\n'])
            && !cx.grants.capabilities.contains(Capability::ClipboardWrite)
        {
            let _ = window;
            return Err(refused(
                "TOOL_DISABLED: multiline text needs the existing Replace clipboard text permission. No input ran.",
            ));
        }
        let call = match call {
            Call::PressKey(window, key) => match self.browser_chord(&window, &key).await {
                Ok(Some(refusal)) => return Err(refused(refusal)),
                Ok(None) => Call::PressKey(window, key),
                Err(error) => return Err(failure(error)),
            },
            call => call,
        };
        let api = self
            .api_for(cx, method)
            .map_err(|error| refused(error.message))?;
        let computer = &self.computer;
        let answer = match call {
            Call::ListWindows => api.list_windows(computer).await.map(Answer::List),
            Call::GetWindow { id, app } => api
                .get_window(computer, id, app.as_deref())
                .await
                .map(Answer::Value),
            Call::ListApps => api.list_apps(computer).await.map(Answer::List),
            Call::LaunchApp(app) => api
                .launch_app(computer, app)
                .await
                .map(|()| Answer::Accepted),
            Call::GetWindowState(window, args) => api
                .get_window_state(computer, &window, args)
                .await
                .map(|observed| Answer::State(observed.value, observed.images)),
            Call::Click(window, click) => api
                .click(computer, &window, click)
                .await
                .map(|()| Answer::Accepted),
            Call::PressKey(window, key) => match chords::parse_key_chord(&key) {
                Ok(keys) => api
                    .press_key(computer, &window, keys)
                    .await
                    .map(|()| Answer::Accepted),
                Err(error) => Err(error),
            },
            Call::TypeText(window, text) => api
                .type_text(computer, &window, text)
                .await
                .map(|()| Answer::Accepted),
            Call::Scroll {
                window,
                screenshot,
                point,
                delta,
            } => api
                .scroll(computer, &window, screenshot.as_deref(), point, delta)
                .await
                .map(|()| Answer::Accepted),
            Call::SetValue(window, index, value) => api
                .set_value(computer, &window, index, value)
                .await
                .map(|()| Answer::Accepted),
            Call::Drag {
                window,
                screenshot,
                from,
                to,
            } => api
                .drag(computer, &window, screenshot.as_deref(), from, to)
                .await
                .map(|()| Answer::Accepted),
            Call::Secondary(window, index, action) => api
                .perform_secondary_action(computer, &window, index, &action)
                .await
                .map(|()| Answer::Accepted),
            Call::Activate(window) => api
                .activate_window(computer, &window)
                .await
                .map(|()| Answer::Accepted),
        };
        match answer {
            Ok(answer) => desktop_result(method, answer),
            Err(error) => Err(failure(error)),
        }
    }

    /// `refuseBrowserChord`: a chord that manages browser tabs never reaches a browser.
    async fn browser_chord(
        &self,
        window: &WindowArg,
        key: &str,
    ) -> Result<Option<String>, ComputerError> {
        let Some(chord) = chords::browser_tab_chord(&chords::parse_key_chord(key)?) else {
            return Ok(None);
        };
        // Popup HWNDs may be absent from the ordinary top-level window list.
        let target = self
            .computer
            .window_state(StateRequest::window_only(window.id))
            .await?
            .window;
        if !chords::is_browser_process(&target.process) {
            return Ok(None);
        }
        let title = serde_json::to_string(&target.title.unwrap_or_default()).unwrap_or_default();
        Ok(Some(format!(
            "BROWSER_TAB_CHORD: {chord} manages browser tabs/windows or history in {title} ({}). No keys were sent. Use browser_tabs list to choose an exact tab; browser_snapshot reads it directly. Use browser_tabs new for a requested test page, or attach then browser_navigate for an existing eligible tab. These operations run in the background without changing the user's selected tab.",
            target.process
        )))
    }

    async fn read_clipboard(&self) -> Result<ToolOutput, ToolError> {
        let read = self
            .computer
            .act(Action::ReadClipboard, Target::default())
            .await
            .map_err(|error| refused(error.message))?;
        let text = read.clipboard.into_iter().next().unwrap_or_default();
        if text.encode_utf16().count() > MAX_CLIPBOARD_UNITS {
            return Err(refused(
                "CLIPBOARD_TOO_LARGE: clipboard text exceeds the response limit.",
            ));
        }
        desktop_result("read_clipboard", Answer::Value(json!(text)))
    }

    async fn write_clipboard(&self, text: String) -> Result<ToolOutput, ToolError> {
        self.computer
            .act(Action::WriteClipboard { text }, Target::default())
            .await
            .map_err(|error| refused(error.message))?;
        Ok(ToolResult {
            content: vec![Content::Text {
                text: "Clipboard text replaced.".to_owned(),
            }],
            structured_content: Some(json!({"value": null})),
            is_error: false,
        }
        .into())
    }
}

fn refused(text: impl Into<String>) -> ToolError {
    ToolError::Refused(text.into())
}

/// A parsed Window2 call.
enum Call {
    ListWindows,
    GetWindow {
        id: i64,
        app: Option<String>,
    },
    ListApps,
    LaunchApp(String),
    GetWindowState(WindowArg, StateArgs),
    Click(WindowArg, Click),
    PressKey(WindowArg, String),
    TypeText(WindowArg, String),
    Scroll {
        window: WindowArg,
        screenshot: Option<String>,
        point: (f64, f64),
        delta: (f64, f64),
    },
    SetValue(WindowArg, usize, String),
    Drag {
        window: WindowArg,
        screenshot: Option<String>,
        from: (f64, f64),
        to: (f64, f64),
    },
    Secondary(WindowArg, usize, String),
    Activate(WindowArg),
}

enum Answer {
    /// An input was submitted; the method returns nothing.
    Accepted,
    Value(Value),
    List(Vec<Value>),
    /// `get_window_state`: the metadata and its PNGs.
    State(Value, Vec<String>),
}

/// `desktopResult`: the value as JSON text, then any native image blocks.
fn desktop_result(method: &str, answer: Answer) -> Result<ToolOutput, ToolError> {
    let mut notes = CallNotes::default();
    let (value, images) = match answer {
        Answer::Accepted => (None, Vec::new()),
        Answer::Value(value) => (Some(value), Vec::new()),
        Answer::List(rows) => {
            notes.count = Some(rows.len() as u64);
            (Some(Value::Array(rows)), Vec::new())
        }
        Answer::State(value, images) => (Some(value), images),
    };
    let text = match &value {
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
        None => format!("{method}: input accepted; observe to verify the result."),
    };
    let mut content = vec![Content::Text { text }];
    content.extend(images.into_iter().map(|data| Content::Image {
        data,
        mime_type: "image/png".to_owned(),
    }));
    let result = ToolResult {
        content,
        structured_content: Some(json!({"value": value.unwrap_or(Value::Null)})),
        is_error: false,
    };
    let size = serde_json::to_vec(&result).map_or(usize::MAX, |bytes| bytes.len());
    if size > MAX_RESPONSE_BYTES {
        return Err(refused(
            "DESKTOP_RESULT_TOO_LARGE: this observation exceeds the combined image/metadata limit. Reobserve without text or screenshot.",
        ));
    }
    Ok(ToolOutput { result, notes })
}

/// The leading code of a native error, under a `PARTIAL_BATCH` wrapper when there is one.
fn native_code(message: &str) -> Option<&str> {
    fn code_at(text: &str) -> Option<&str> {
        let end = text
            .char_indices()
            .find(|(index, c)| {
                !(c.is_ascii_uppercase() || (*index > 0 && (c.is_ascii_digit() || *c == '_')))
            })
            .map_or(text.len(), |(index, _)| index);
        (end > 0 && text[end..].starts_with(':')).then(|| &text[..end])
    }
    if let Some(rest) = message.strip_prefix("PARTIAL_BATCH:") {
        let line = rest.split(['\r', '\n']).next().unwrap_or_default();
        let mut from = 0;
        while let Some(at) = line[from..].find(". ") {
            let after = from + at + 2;
            if let Some(code) = code_at(&rest[after..]) {
                return Some(code);
            }
            from = from + at + 1;
        }
    }
    code_at(message)
}

/// `nativeFailure`: a known native failure gets its recovery step and its exact completion
/// evidence; any other error is the plain refusal the registrar's guard made of it.
fn failure(error: ComputerError) -> ToolError {
    let recovery = match native_code(&error.message) {
        Some("CAPTURE_FAILED") => {
            "Use get_window_state({window,include_screenshot:false,include_text:true}) for accessible controls. Inspect list_windows for the current state. A minimized target can be restored with activate_window when needed for the task, then observed again. Repeating the same capture cannot restore it."
        }
        Some(
            "WINDOW_NOT_FOUND" | "STALE_WINDOW" | "WINDOW_APP_MISMATCH" | "RELATED_WINDOW_GONE",
        ) => {
            "Call list_windows and select the current returned app/window identity. A closed window or dialog needs a new target; do not reuse its old id."
        }
        Some("FOCUS_FAILED") => {
            "Call list_windows to inspect the foreground and get_window_state on the target and its owned dialogs. Resolve the relevant dialog or window state before another action."
        }
        Some(
            "STALE_FRAME" | "STALE_SCREENSHOT" | "STALE_WINDOW_STATE" | "STALE_REF"
            | "STALE_UI_REF" | "STALE_UI_SNAPSHOT" | "UNKNOWN_UI_REF",
        ) => {
            "Call get_window_state on the current target and inspect the result. Choose fresh screenshot coordinates or indexes from include_text:true; the previous observation no longer authorizes input."
        }
        Some("ELEMENT_NOT_FOUND") => {
            "Use get_window_state with include_text:true and query (control name or automation id) or role to locate the control beyond a truncated tree. Use an index from that new result."
        }
        Some("UIA_FAILED") => {
            "Use get_window_state({window,include_text:false}) to inspect the target pixels. An unavailable accessibility provider does not imply screenshots or other tools are disabled."
        }
        _ => return refused(error.message),
    };
    let code = native_code(&error.message).unwrap_or_default();
    let detail = json!({
        "code": code,
        "message": error.message,
        "recovery": recovery,
        "completed_count": error.completed_count,
        "failed_index": error.failed_index,
        "completed_routes": error
            .completed_routes
            .map(|routes| routes.iter().map(|route| route.as_str()).collect::<Vec<_>>()),
    });
    ToolError::RefusedWithDetail {
        text: format!(
            "{}\nNext step: {recovery}\nDo not repeat completed input. Inspect the current result before deciding which action is still needed.",
            error.message
        ),
        detail,
    }
}

#[derive(Deserialize)]
pub struct NoArgs {}

#[derive(Deserialize)]
pub struct GetWindowArgs {
    id: i64,
    app: Option<String>,
}

#[derive(Deserialize)]
pub struct LaunchAppArgs {
    app: String,
}

#[derive(Deserialize)]
pub struct GetWindowStateArgs {
    window: WindowArg,
    #[serde(flatten)]
    options: StateArgs,
}

#[derive(Deserialize)]
pub struct ClickArgs {
    window: WindowArg,
    click_count: Option<u32>,
    element_index: Option<usize>,
    mouse_button: Option<String>,
    #[serde(rename = "screenshotId")]
    screenshot_id: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
}

#[derive(Deserialize)]
pub struct PressKeyArgs {
    window: WindowArg,
    key: String,
}

#[derive(Deserialize)]
pub struct TypeTextArgs {
    window: WindowArg,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollArgs {
    window: WindowArg,
    screenshot_id: Option<String>,
    x: f64,
    y: f64,
    scroll_x: f64,
    scroll_y: f64,
}

#[derive(Deserialize)]
pub struct SetValueArgs {
    window: WindowArg,
    element_index: usize,
    value: String,
}

#[derive(Deserialize)]
pub struct DragArgs {
    window: WindowArg,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    #[serde(rename = "screenshotId")]
    screenshot_id: Option<String>,
}

#[derive(Deserialize)]
pub struct SecondaryArgs {
    window: WindowArg,
    element_index: usize,
    action: String,
}

#[derive(Deserialize)]
pub struct ActivateArgs {
    window: WindowArg,
}

#[derive(Deserialize)]
pub struct WriteClipboardArgs {
    text: String,
}

const fn spec(name: &'static str, capability: Capability) -> ToolSpec {
    ToolSpec {
        name,
        listing: Listing::Capability(capability),
        requires: Requirement::Capability(capability),
    }
}

/// One Window2 method: its name, the permission that lists and guards it, its arguments and
/// how they become a [`Call`].
macro_rules! window_tool {
    ($tool:ident, $name:literal, $capability:ident, $args:ty, |$a:ident| $call:expr) => {
        struct $tool(Arc<Desktop>);

        impl Tool for $tool {
            type Args = $args;
            const SPEC: &'static ToolSpec = &spec($name, Capability::$capability);

            async fn call(&self, cx: &CallContext, $a: $args) -> Result<ToolOutput, ToolError> {
                self.0.run(cx, $name, $call).await
            }
        }
    };
}

window_tool!(ListWindows, "list_windows", Screen, NoArgs, |_args| {
    Call::ListWindows
});
window_tool!(GetWindow, "get_window", Screen, GetWindowArgs, |args| {
    Call::GetWindow {
        id: args.id,
        app: args.app,
    }
});
window_tool!(ListApps, "list_apps", Screen, NoArgs, |_args| {
    Call::ListApps
});
window_tool!(
    GetWindowState,
    "get_window_state",
    Screen,
    GetWindowStateArgs,
    |args| Call::GetWindowState(args.window, args.options)
);
window_tool!(LaunchApp, "launch_app", Control, LaunchAppArgs, |args| {
    Call::LaunchApp(args.app)
});
window_tool!(ClickTool, "click", Control, ClickArgs, |args| Call::Click(
    args.window,
    Click {
        click_count: args.click_count,
        element_index: args.element_index,
        mouse_button: args.mouse_button,
        screenshot_id: args.screenshot_id,
        x: args.x,
        y: args.y,
    }
));
window_tool!(PressKey, "press_key", Control, PressKeyArgs, |args| {
    Call::PressKey(args.window, args.key)
});
window_tool!(TypeText, "type_text", Control, TypeTextArgs, |args| {
    Call::TypeText(args.window, args.text)
});
window_tool!(Scroll, "scroll", Control, ScrollArgs, |args| Call::Scroll {
    window: args.window,
    screenshot: args.screenshot_id,
    point: (args.x, args.y),
    delta: (args.scroll_x, args.scroll_y),
});
window_tool!(SetValue, "set_value", Control, SetValueArgs, |args| {
    Call::SetValue(args.window, args.element_index, args.value)
});
window_tool!(Drag, "drag", Control, DragArgs, |args| Call::Drag {
    window: args.window,
    screenshot: args.screenshot_id,
    from: (args.from_x, args.from_y),
    to: (args.to_x, args.to_y),
});
window_tool!(
    Secondary,
    "perform_secondary_action",
    Control,
    SecondaryArgs,
    |args| Call::Secondary(args.window, args.element_index, args.action)
);
window_tool!(Activate, "activate_window", Control, ActivateArgs, |args| {
    Call::Activate(args.window)
});

struct ReadClipboard(Arc<Desktop>);

impl Tool for ReadClipboard {
    type Args = NoArgs;
    const SPEC: &'static ToolSpec = &spec("read_clipboard", Capability::ClipboardRead);

    async fn call(&self, _cx: &CallContext, _args: NoArgs) -> Result<ToolOutput, ToolError> {
        self.0.read_clipboard().await
    }
}

struct WriteClipboard(Arc<Desktop>);

impl Tool for WriteClipboard {
    type Args = WriteClipboardArgs;
    const SPEC: &'static ToolSpec = &spec("write_clipboard", Capability::ClipboardWrite);

    async fn call(
        &self,
        _cx: &CallContext,
        args: WriteClipboardArgs,
    ) -> Result<ToolOutput, ToolError> {
        self.0.write_clipboard(args.text).await
    }
}

/// The Windows Desktop tools, in the TypeScript registration order.
pub fn tools(desktop: &Arc<Desktop>) -> Vec<Arc<dyn DynTool>> {
    let d = || desktop.clone();
    vec![
        Arc::new(ListWindows(d())),
        Arc::new(GetWindow(d())),
        Arc::new(ListApps(d())),
        Arc::new(GetWindowState(d())),
        Arc::new(LaunchApp(d())),
        Arc::new(ClickTool(d())),
        Arc::new(PressKey(d())),
        Arc::new(TypeText(d())),
        Arc::new(Scroll(d())),
        Arc::new(SetValue(d())),
        Arc::new(Drag(d())),
        Arc::new(Secondary(d())),
        Arc::new(Activate(d())),
        Arc::new(ReadClipboard(d())),
        Arc::new(WriteClipboard(d())),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_native_code_is_found_under_a_partial_batch_wrapper() {
        assert_eq!(
            native_code("WINDOW_NOT_FOUND: gone"),
            Some("WINDOW_NOT_FOUND")
        );
        assert_eq!(
            native_code(
                "PARTIAL_BATCH: completed_count=0 failed_index=0 routes=none. FOCUS_FAILED: requested 5"
            ),
            Some("FOCUS_FAILED")
        );
        assert_eq!(
            native_code(
                "PARTIAL_BATCH: completed_count=0 failed_index=0. The desktop helper did not answer in time."
            ),
            Some("PARTIAL_BATCH")
        );
        assert_eq!(
            native_code("At least one of include_screenshot or include_text must be true."),
            None
        );
        assert_eq!(
            native_code("Choose element_index or screenshot coordinates."),
            None
        );
    }

    #[test]
    fn a_known_failure_carries_its_recovery_and_completion_evidence() {
        let ToolError::RefusedWithDetail { text, detail } =
            failure(ComputerError::new("STALE_FRAME: target moved"))
        else {
            panic!("a known failure carries its detail");
        };
        assert!(
            text.starts_with("STALE_FRAME: target moved\nNext step: "),
            "{text}"
        );
        assert_eq!(detail["code"], "STALE_FRAME");
        assert_eq!(detail["completed_count"], Value::Null);
        let unknown = failure(ComputerError::new("INVALID_KEY: bad"));
        assert_eq!(unknown, ToolError::Refused("INVALID_KEY: bad".to_owned()));
    }
}
