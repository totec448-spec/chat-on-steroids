//! The native observation and input owner (`src/main/computer/index.ts`, Windows half).
//!
//! It turns helper replies into typed observations, maps screenshot pixels back to screen
//! pixels, and runs one input action with the exact partial-completion evidence the model
//! sees when something fails. Multi-step operations hold one lock, so another caller's
//! capture or input never lands between their steps.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::thread::DesktopThread;

/// Screenshot width the model sees unless it asks otherwise (`DEFAULT_SCREENSHOT_WIDTH`).
const DEFAULT_SCREENSHOT_WIDTH: u32 = 1280;
/// Document and selection text share this budget, in UTF-16 code units.
const TEXT_BUDGET: usize = 8000;

/// How a native action was delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Route {
    Uia,
    SendInput,
    Focus,
    Shell,
}

impl Route {
    pub(crate) fn parse(text: &str) -> Option<Self> {
        match text {
            "uia" => Some(Self::Uia),
            "sendinput" => Some(Self::SendInput),
            "focus" => Some(Self::Focus),
            "shell" => Some(Self::Shell),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Uia => "uia",
            Self::SendInput => "sendinput",
            Self::Focus => "focus",
            Self::Shell => "shell",
        }
    }
}

/// A native refusal or failure. The message starts with its code (`STALE_FRAME: ...`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ComputerError {
    pub message: String,
    pub completed_count: Option<u64>,
    pub failed_index: Option<u64>,
    pub completed_routes: Option<Vec<Route>>,
}

impl ComputerError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            completed_count: None,
            failed_index: None,
            completed_routes: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn json(self) -> Value {
        json!({"x": number(self.x), "y": number(self.y), "width": number(self.width), "height": number(self.height)})
    }
}

/// An integral coordinate as JSON writes it (`48`, not `48.0`).
pub(crate) fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WindowState {
    Foreground,
    Minimized,
    Open,
}

impl WindowState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Foreground => "foreground",
            Self::Minimized => "minimized",
            Self::Open => "open",
        }
    }
}

/// A window as the helper reports it (`WindowInfo`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowInfo {
    pub id: i64,
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub app_user_model_id: String,
    #[serde(default)]
    pub process_path: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub process: String,
    #[serde(default)]
    pub state: Option<WindowState>,
}

impl WindowInfo {
    /// The exact native app identity: AUMID or process image path.
    pub(crate) fn identity(&self) -> Option<&str> {
        [&self.app, &self.app_user_model_id, &self.process_path]
            .into_iter()
            .find(|value| !value.is_empty())
            .map(String::as_str)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopApp {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub is_running: Option<bool>,
    #[serde(default)]
    pub windows: Vec<WindowInfo>,
}

/// The pixels of one screenshot and the geometry later input is checked against.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Frame {
    pub id: u64,
    pub width: f64,
    pub height: f64,
    pub region: Rect,
    scale: f64,
    /// Set only for a background window capture; a screen capture authorizes no window.
    pub window_id: Option<i64>,
    window_geometry: Option<Value>,
    displays: Option<Value>,
    capture_mode: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Screenshot {
    /// Base64 PNG.
    pub data: String,
    pub frame: Frame,
    /// Whether the window was in front when its pixels were taken; `None` for the screen.
    pub focused: Option<bool>,
}

/// The exact native element behind an observed index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ElementRef {
    Native {
        window: i64,
        snapshot_id: u64,
        runtime_key: String,
    },
    /// The provider gave no runtime id, so no action can find this element again.
    Unavailable(String),
}

#[derive(Clone, Debug)]
pub(crate) struct UiElement {
    pub target: ElementRef,
    pub name: String,
    pub role: String,
    pub enabled: bool,
    pub offscreen: bool,
    pub bounds: Rect,
    pub actions: Vec<String>,
    pub depth: Option<i64>,
    pub focused: Option<bool>,
    pub selected: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Accessibility {
    pub document_text: Option<String>,
    pub selected_text: Option<String>,
    /// Index into the observation's elements.
    pub focused_element: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct Unavailable {
    pub code: String,
    pub message: String,
}

impl Unavailable {
    pub(crate) fn json(&self) -> Value {
        json!({"code": self.code, "message": self.message})
    }
}

pub(crate) struct Related {
    pub window: WindowInfo,
    pub screenshot: Option<Screenshot>,
}

/// One `getWindowState` transaction: target, pixels and accessibility from one moment.
pub(crate) struct Observation {
    pub window: WindowInfo,
    pub screenshot: Option<Screenshot>,
    pub elements: Vec<UiElement>,
    pub ui_unavailable: Option<Unavailable>,
    pub screenshot_unavailable: Option<Unavailable>,
    pub ui_truncated: Option<bool>,
    pub accessibility: Option<Accessibility>,
    pub related: Vec<Related>,
}

pub(crate) struct StateRequest {
    pub window: i64,
    pub include_screenshot: bool,
    pub include_ui: bool,
    pub include_related: bool,
    pub max_elements: u32,
    pub query: Option<String>,
    pub role: Option<String>,
}

impl StateRequest {
    /// The window's identity and state only, without pixels or controls.
    pub(crate) fn window_only(window: i64) -> Self {
        Self {
            window,
            include_screenshot: false,
            include_ui: false,
            include_related: false,
            max_elements: 60,
            query: None,
            role: None,
        }
    }
}

/// One input action, already in screenshot pixels or element references.
#[derive(Clone, Debug)]
pub(crate) enum Action {
    ClickRef {
        target: ElementRef,
        button: String,
        count: u32,
    },
    SetValue {
        target: ElementRef,
        text: String,
    },
    Semantic {
        target: ElementRef,
        action: String,
    },
    LaunchApp {
        app: String,
    },
    Paste {
        text: String,
    },
    Click {
        x: f64,
        y: f64,
        button: String,
        count: u32,
    },
    Scroll {
        x: f64,
        y: f64,
        scroll_x: f64,
        scroll_y: f64,
    },
    Drag {
        from: (f64, f64),
        to: (f64, f64),
    },
    Type {
        text: String,
    },
    Keypress {
        keys: Vec<String>,
    },
    Focus {
        window: i64,
    },
    ReadClipboard,
    WriteClipboard {
        text: String,
    },
}

/// The exact window an action targets, and for a popup the window that owns it.
#[derive(Clone, Debug, Default)]
pub(crate) struct Target {
    pub frame: Option<Frame>,
    pub window: Option<i64>,
    pub owner_window: Option<i64>,
    pub app: Option<String>,
    pub owner_app: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct ActResult {
    pub clipboard: Vec<String>,
}

pub(crate) struct Computer {
    thread: DesktopThread,
    /// Held across a multi-step acquisition (`exclusive`).
    exclusive: tokio::sync::Mutex<()>,
    next_frame_id: AtomicU64,
}

fn malformed(what: &str) -> ComputerError {
    ComputerError::new(format!("The desktop helper returned a malformed {what}."))
}

fn parse<T: for<'de> Deserialize<'de>>(value: &Value, what: &str) -> Result<T, ComputerError> {
    T::deserialize(value).map_err(|_| malformed(what))
}

/// The first `units` UTF-16 code units of `text`, as JavaScript's `slice` cuts them.
fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, character) in text.char_indices() {
        used += character.len_utf16();
        if used > units {
            return &text[..index];
        }
    }
    text
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript's `Math.round`: halves round up.
pub(crate) fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn partial_batch(error: ComputerError) -> ComputerError {
    let partial = error.completed_count.unwrap_or(0);
    let failed_in_batch = error.failed_index.unwrap_or(partial);
    let exact = error
        .completed_routes
        .filter(|routes| routes.len() as u64 == partial);
    // One action per batch: its index is 0, and an index past it is the completed count.
    let failed = if failed_in_batch == 0 || partial == 0 {
        0
    } else {
        partial
    };
    let evidence = match &exact {
        Some(routes) if routes.is_empty() => "none".to_owned(),
        Some(routes) => routes
            .iter()
            .map(|route| route.as_str())
            .collect::<Vec<_>>()
            .join("+"),
        None => "unavailable".to_owned(),
    };
    ComputerError {
        message: format!(
            "PARTIAL_BATCH: completed_count={partial} failed_index={failed} routes={evidence}. {}",
            error.message
        ),
        completed_count: Some(partial),
        failed_index: Some(failed),
        completed_routes: exact,
    }
}

fn local_failure(error: ComputerError) -> ComputerError {
    ComputerError {
        message: format!(
            "PARTIAL_BATCH: completed_count=0 failed_index=0. {}",
            error.message
        ),
        completed_count: Some(0),
        failed_index: Some(0),
        completed_routes: None,
    }
}

impl Computer {
    pub(crate) fn new(thread: DesktopThread) -> Self {
        Self {
            thread,
            exclusive: tokio::sync::Mutex::new(()),
            next_frame_id: AtomicU64::new(1),
        }
    }

    pub(crate) async fn list_windows(&self) -> Result<Vec<WindowInfo>, ComputerError> {
        let reply = self.thread.request(json!({"op": "windows"})).await?;
        match reply.get("windows") {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(windows) => parse(windows, "window list"),
        }
    }

    /// Installed and running apps, and whether the bounded catalog was cut.
    pub(crate) async fn list_apps(
        &self,
        limit: u32,
    ) -> Result<(Vec<DesktopApp>, bool), ComputerError> {
        let _exclusive = self.exclusive.lock().await;
        let reply = self
            .thread
            .request(json!({"op": "apps", "match": "", "limit": limit.clamp(1, 4096)}))
            .await?;
        let apps = match reply.get("apps") {
            Some(apps @ Value::Array(_)) => parse(apps, "app list")?,
            _ => Vec::new(),
        };
        Ok((apps, reply["truncated"] == true))
    }

    pub(crate) async fn window_state(
        &self,
        request: StateRequest,
    ) -> Result<Observation, ComputerError> {
        let _exclusive = self.exclusive.lock().await;
        let mut snapshot = json!({
            "op": "snapshot",
            "id": request.window,
            "includeScreenshot": request.include_screenshot,
            "includeUi": request.include_ui,
        });
        if let Some(query) = &request.query {
            snapshot["query"] = json!(query);
        }
        if let Some(role) = &request.role {
            snapshot["role"] = json!(role);
        }
        snapshot["includeRelated"] = json!(request.include_related);
        snapshot["maxWidth"] = json!(DEFAULT_SCREENSHOT_WIDTH);
        snapshot["maxResults"] = json!(request.max_elements.clamp(1, 100));
        let reply = self.thread.request(snapshot).await?;
        let window: WindowInfo = match reply.get("window") {
            Some(window @ Value::Object(_)) => parse(window, "window")?,
            _ => {
                return Err(ComputerError::new(
                    "WINDOW_NOT_FOUND: no matching visible window is available",
                ));
            }
        };
        let screenshot_unavailable = (request.include_screenshot && request.include_ui)
            .then(|| reply.get("screenshotUnavailable"))
            .flatten()
            .filter(|failure| failure["code"] == "CAPTURE_FAILED")
            .and_then(|failure| failure["message"].as_str())
            .map(|message| Unavailable {
                code: "CAPTURE_FAILED".to_owned(),
                message: utf16_prefix(message, 500).to_owned(),
            });
        let screenshot = if request.include_screenshot && screenshot_unavailable.is_none() {
            Some(self.screenshot_from(&reply, Some(window.id))?)
        } else {
            None
        };
        let ui_unavailable = reply
            .get("uiUnavailable")
            .filter(|value| value.is_object())
            .map(|value| Unavailable {
                code: value["code"]
                    .as_str()
                    .unwrap_or("UI_UNAVAILABLE")
                    .to_owned(),
                message: value["message"]
                    .as_str()
                    .unwrap_or("UI controls are unavailable")
                    .to_owned(),
            });
        let ui_read = request.include_ui && ui_unavailable.is_none();
        let (elements, accessibility) = if ui_read {
            let (elements, accessibility) = elements_from(&reply)?;
            (elements, Some(accessibility))
        } else {
            (Vec::new(), None)
        };
        let mut related = Vec::new();
        if request.include_related
            && screenshot_unavailable.is_none()
            && let Some(rows) = reply["relatedWindows"].as_array()
        {
            for row in rows.iter().take(3) {
                let Ok(popup) = WindowInfo::deserialize(row) else {
                    continue;
                };
                if popup.id <= 0 || popup.id == window.id {
                    continue;
                }
                // A disappearing popup must not discard the main observation; capture rechecks
                // native ownership and never substitutes screen pixels.
                let screenshot = if request.include_screenshot {
                    self.capture_window(popup.id, window.id).await.ok()
                } else {
                    None
                };
                related.push(Related {
                    window: popup,
                    screenshot,
                });
            }
        }
        Ok(Observation {
            ui_truncated: if ui_read {
                reply["truncated"].as_bool()
            } else {
                None
            },
            window,
            screenshot,
            elements,
            ui_unavailable,
            screenshot_unavailable,
            accessibility,
            related,
        })
    }

    async fn capture_window(&self, window: i64, owner: i64) -> Result<Screenshot, ComputerError> {
        let reply = self
            .thread
            .request(json!({"op": "capture", "maxWidth": DEFAULT_SCREENSHOT_WIDTH, "id": window, "ownerWindow": owner}))
            .await?;
        self.screenshot_from(&reply, Some(window))
    }

    /// `screenshotFromReply`: a frame for the pixels the helper actually captured.
    fn screenshot_from(
        &self,
        reply: &Value,
        requested: Option<i64>,
    ) -> Result<Screenshot, ComputerError> {
        let geometry =
            || ComputerError::new("The desktop helper returned invalid screenshot geometry.");
        let region: Rect = Rect::deserialize(&reply["region"]).map_err(|_| geometry())?;
        let width = reply["image"]["width"].as_f64().ok_or_else(geometry)?;
        let height = reply["image"]["height"].as_f64().ok_or_else(geometry)?;
        if region.width <= 0.0 || region.height <= 0.0 || width <= 0.0 || height <= 0.0 {
            return Err(geometry());
        }
        let data = reply["data"]
            .as_str()
            .filter(|data| !data.is_empty())
            .ok_or_else(|| ComputerError::new("The screen capture produced no image."))?
            .to_owned();
        let mode = match reply["captureMode"].as_str() {
            Some(mode @ ("window" | "screen_fallback")) => mode,
            Some(_) => "screen",
            None if requested.is_none() => "screen",
            None => "screen_fallback",
        };
        // Only a background window bitmap can authorize input against that window.
        let window_id = if mode == "window" { requested } else { None };
        let displays = reply["displays"]
            .as_array()
            .filter(|rows| !rows.is_empty())
            .map(|_| reply["displays"].clone());
        let frame = Frame {
            id: self.next_frame_id.fetch_add(1, Ordering::Relaxed),
            width,
            height,
            region,
            scale: width / region.width,
            window_id,
            window_geometry: window_id.map(|_| match reply.get("windowGeometry") {
                Some(geometry) if geometry.is_object() => geometry.clone(),
                _ => region.json(),
            }),
            displays: if window_id.is_none() { displays } else { None },
            capture_mode: mode.to_owned(),
        };
        Ok(Screenshot {
            data,
            frame,
            focused: requested.map(|_| reply["focused"] == true),
        })
    }

    /// Runs one action against its exact target (`actLocked` for a one-action batch).
    pub(crate) async fn act(
        &self,
        action: Action,
        target: Target,
    ) -> Result<ActResult, ComputerError> {
        let _exclusive = self.exclusive.lock().await;
        if let Some(window) = target.window
            && let Action::Focus { window: focus } = &action
            && *focus != window
        {
            return Err(ComputerError::new(
                "WINDOW_MISMATCH: focus must name the same window as the input target.",
            ));
        }
        if target.owner_window.is_some()
            && (target.window.is_none() || target.owner_window == target.window)
        {
            return Err(ComputerError::new(
                "INVALID_WINDOW: popup input requires distinct exact popup and owner windows.",
            ));
        }
        match action {
            Action::Paste { text } => {
                let Some(window) = target.window else {
                    return Err(ComputerError::new(
                        "WINDOW_REQUIRED: paste needs an explicit target window.",
                    ));
                };
                // Target activation is a precondition for publishing the user's clipboard.
                self.thread
                    .request(self.batch(json!({"type": "focus", "window": window}), &target, false))
                    .await
                    .map_err(local_failure)?;
                self.thread
                    .request(json!({"op": "write_clipboard", "text": text}))
                    .await
                    .map_err(local_failure)?;
                let keys = json!({"type": "keypress", "keys": ["ctrl", "v"]});
                if let Err(error) = self.thread.request(self.batch(keys, &target, false)).await {
                    let error = partial_batch(error);
                    return Err(ComputerError {
                        message: format!(
                            "{}. Clipboard text was replaced; paste delivery is not confirmed.",
                            error.message
                        ),
                        ..error
                    });
                }
                self.cursor(self.thread.request(json!({"op": "cursor"})).await?)?;
                Ok(ActResult::default())
            }
            Action::ReadClipboard => {
                let reply = self
                    .thread
                    .request(json!({"op": "read_clipboard"}))
                    .await
                    .map_err(local_failure)?;
                Ok(ActResult {
                    clipboard: vec![reply["text"].as_str().unwrap_or_default().to_owned()],
                })
            }
            Action::WriteClipboard { text } => {
                self.thread
                    .request(json!({"op": "write_clipboard", "text": text}))
                    .await
                    .map_err(local_failure)?;
                Ok(ActResult::default())
            }
            action => {
                let pointing = matches!(
                    action,
                    Action::Click { .. } | Action::Scroll { .. } | Action::Drag { .. }
                );
                let native = native_action(action, &target)?;
                let reply = self
                    .thread
                    .request(self.batch(native, &target, pointing))
                    .await
                    .map_err(partial_batch)?;
                self.cursor(reply)?;
                Ok(ActResult::default())
            }
        }
    }

    fn batch(&self, action: Value, target: &Target, pointing: bool) -> Value {
        let mut request = Map::new();
        request.insert("op".to_owned(), json!("act"));
        request.insert("actions".to_owned(), json!([action]));
        if let Some(window) = target.window {
            request.insert("targetWindow".to_owned(), json!(window));
        }
        if let Some(owner) = target.owner_window {
            request.insert("ownerWindow".to_owned(), json!(owner));
        }
        if let Some(app) = &target.app {
            request.insert("targetApp".to_owned(), json!(app));
        }
        if let Some(app) = &target.owner_app {
            request.insert("ownerApp".to_owned(), json!(app));
        }
        if pointing && let Some(frame) = &target.frame {
            let mut payload = Map::new();
            payload.insert("id".to_owned(), json!(frame.id));
            payload.insert("window".to_owned(), json!(frame.window_id));
            if let Some(owner) = target.owner_window {
                payload.insert("ownerWindow".to_owned(), json!(owner));
            }
            if let Some(app) = &target.app {
                payload.insert("targetApp".to_owned(), json!(app));
            }
            if let Some(app) = &target.owner_app {
                payload.insert("ownerApp".to_owned(), json!(app));
            }
            payload.insert("region".to_owned(), frame.region.json());
            payload.insert(
                "windowGeometry".to_owned(),
                frame.window_geometry.clone().unwrap_or(Value::Null),
            );
            payload.insert(
                "displays".to_owned(),
                frame.displays.clone().unwrap_or(Value::Null),
            );
            payload.insert("captureMode".to_owned(), json!(frame.capture_mode));
            request.insert("frame".to_owned(), Value::Object(payload));
        }
        Value::Object(request)
    }

    fn cursor(&self, reply: Value) -> Result<(), ComputerError> {
        let finite = |key: &str| reply["cursor"][key].as_f64().is_some_and(f64::is_finite);
        if finite("x") && finite("y") {
            Ok(())
        } else {
            Err(ComputerError::new(
                "The desktop helper returned an invalid pointer position.",
            ))
        }
    }
}

/// Screen pixels for image pixels of `frame`, kept inside the captured region.
fn to_screen(frame: &Frame, x: f64, y: f64) -> (Value, Value) {
    let clamp = |mapped: f64, origin: f64, extent: f64| {
        let lower = origin.ceil();
        let upper = lower.max((origin + extent).ceil() - 1.0);
        mapped.clamp(lower, upper)
    };
    let sx = clamp(
        js_round(frame.region.x + x / frame.scale),
        frame.region.x,
        frame.region.width,
    );
    let sy = clamp(
        js_round(frame.region.y + y / frame.scale),
        frame.region.y,
        frame.region.height,
    );
    (number(sx), number(sy))
}

fn native_target(target: &ElementRef, input: &Target) -> Result<(i64, u64, String), ComputerError> {
    match target {
        ElementRef::Unavailable(reference) => Err(ComputerError::new(format!(
            "UNKNOWN_UI_REF: {reference}. Call get_window_state or find_ui again and use a ref from that reply."
        ))),
        ElementRef::Native {
            window,
            snapshot_id,
            runtime_key,
        } => {
            if input.window.is_some_and(|expected| expected != *window) {
                return Err(ComputerError::new(
                    "WINDOW_MISMATCH: the accessibility ref belongs to a different input target window.",
                ));
            }
            Ok((*window, *snapshot_id, runtime_key.clone()))
        }
    }
}

/// `mapOne`: the helper's action vocabulary, in screen pixels.
fn native_action(action: Action, input: &Target) -> Result<Value, ComputerError> {
    let frame = || {
        input.frame.as_ref().ok_or_else(|| {
            ComputerError::new(
                "FRAME_REQUIRED: coordinate actions must include the frameId returned with the screenshot they came from.",
            )
        })
    };
    Ok(match action {
        Action::ClickRef {
            target,
            button,
            count,
        } => {
            let (window, snapshot_id, runtime_key) = native_target(&target, input)?;
            json!({"type": "click_ui", "window": window, "snapshotId": snapshot_id,
                "runtimeKey": runtime_key, "button": button, "count": count})
        }
        Action::SetValue { target, text } => {
            let (window, snapshot_id, runtime_key) = native_target(&target, input)?;
            json!({"type": "set_value_ui", "window": window, "snapshotId": snapshot_id,
                "runtimeKey": runtime_key, "value": text})
        }
        Action::Semantic { target, action } => {
            let (window, snapshot_id, runtime_key) = native_target(&target, input)?;
            json!({"type": "ui_action", "window": window, "snapshotId": snapshot_id,
                "runtimeKey": runtime_key, "action": action})
        }
        Action::LaunchApp { app } => json!({"type": "launch_app", "app": app}),
        Action::Click {
            x,
            y,
            button,
            count,
        } => {
            let (x, y) = to_screen(frame()?, x, y);
            json!({"type": "click", "x": x, "y": y, "button": button, "count": count})
        }
        Action::Scroll {
            x,
            y,
            scroll_x,
            scroll_y,
        } => {
            let (x, y) = to_screen(frame()?, x, y);
            json!({"type": "scroll", "x": x, "y": y, "scroll_x": number(scroll_x),
                "scroll_y": number(scroll_y), "rawWheel": true})
        }
        Action::Drag { from, to } => {
            let frame = frame()?;
            let (x1, y1) = to_screen(frame, from.0, from.1);
            let (x2, y2) = to_screen(frame, to.0, to.1);
            json!({"type": "drag", "xs": [x1, x2], "ys": [y1, y2], "button": "left"})
        }
        Action::Type { text } => json!({"type": "type", "text": text}),
        Action::Keypress { keys } => json!({"type": "keypress", "keys": keys}),
        Action::Focus { window } => json!({"type": "focus", "window": window}),
        Action::Paste { .. } | Action::ReadClipboard | Action::WriteClipboard { .. } => {
            return Err(ComputerError::new("Unsupported action"));
        }
    })
}

/// `findUiLocked` on a snapshot reply: elements with their native references, and the
/// document, selection and focus context.
fn elements_from(reply: &Value) -> Result<(Vec<UiElement>, Accessibility), ComputerError> {
    let snapshot_id = reply["snapshotId"]
        .as_u64()
        .filter(|id| *id >= 1)
        .ok_or_else(|| {
            ComputerError::new(
                "The desktop helper returned UI elements without a valid snapshot identity.",
            )
        })?;
    let window = reply["window"]
        .get("id")
        .unwrap_or(&reply["window"])
        .as_i64()
        .filter(|id| *id >= 1)
        .ok_or_else(|| {
            ComputerError::new(
                "The desktop helper returned UI elements without a valid window identity.",
            )
        })?;
    let raw = reply["elements"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut elements = Vec::with_capacity(raw.len());
    for (index, item) in raw.iter().enumerate() {
        let runtime_key = item["runtimeKey"].as_str().unwrap_or_default();
        let target = if runtime_key.is_empty() {
            ElementRef::Unavailable(format!("unavailable-{snapshot_id}-{}", index + 1))
        } else {
            ElementRef::Native {
                window,
                snapshot_id,
                runtime_key: runtime_key.to_owned(),
            }
        };
        elements.push(UiElement {
            target,
            name: item["name"].as_str().unwrap_or_default().to_owned(),
            role: item["role"].as_str().unwrap_or_default().to_owned(),
            enabled: item["enabled"] == true,
            offscreen: item["offscreen"] == true,
            bounds: Rect::deserialize(&item["bounds"]).map_err(|_| malformed("UI element"))?,
            actions: item["actions"]
                .as_array()
                .map(|actions| {
                    actions
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            depth: item["depth"].as_i64().map(|depth| depth.clamp(0, 50)),
            focused: item["focused"].as_bool(),
            selected: item["selected"].as_bool(),
        });
    }
    let mut context = Accessibility::default();
    let mut budget = TEXT_BUDGET;
    for (source, slot) in [
        ("document_text", &mut context.document_text),
        ("selected_text", &mut context.selected_text),
    ] {
        if let Some(text) = reply[source].as_str().filter(|text| !text.is_empty()) {
            let kept = utf16_prefix(text, budget);
            budget -= utf16_len(kept);
            *slot = Some(kept.to_owned());
        }
    }
    context.focused_element = raw
        .iter()
        .position(|item| item["runtimeKey"] == reply["focused_element"]);
    Ok((elements, context))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_one_action_batch_names_its_completed_routes() {
        let none = partial_batch(ComputerError {
            message: "FOCUS_FAILED: requested 5".to_owned(),
            completed_count: Some(0),
            failed_index: Some(0),
            completed_routes: Some(Vec::new()),
        });
        assert_eq!(
            none.message,
            "PARTIAL_BATCH: completed_count=0 failed_index=0 routes=none. FOCUS_FAILED: requested 5"
        );
        let after = partial_batch(ComputerError {
            message: "INPUT_FAILED: cursor unavailable".to_owned(),
            completed_count: Some(1),
            failed_index: None,
            completed_routes: Some(vec![Route::SendInput]),
        });
        assert_eq!(
            after.message,
            "PARTIAL_BATCH: completed_count=1 failed_index=1 routes=sendinput. INPUT_FAILED: cursor unavailable"
        );
        let unknown = partial_batch(ComputerError::new(
            "The desktop helper did not answer in time.",
        ));
        assert_eq!(
            unknown.message,
            "PARTIAL_BATCH: completed_count=0 failed_index=0 routes=unavailable. The desktop helper did not answer in time."
        );
        assert_eq!(unknown.completed_routes, None);
    }

    #[test]
    fn image_pixels_map_back_to_screen_pixels_inside_the_capture() {
        let frame = Frame {
            id: 1,
            width: 640.0,
            height: 360.0,
            region: Rect {
                x: 100.0,
                y: 50.0,
                width: 1280.0,
                height: 720.0,
            },
            scale: 0.5,
            window_id: Some(7),
            window_geometry: None,
            displays: None,
            capture_mode: "window".to_owned(),
        };
        assert_eq!(to_screen(&frame, 0.0, 0.0), (json!(100), json!(50)));
        assert_eq!(to_screen(&frame, 10.0, 20.0), (json!(120), json!(90)));
        // The last pixel stays inside the region instead of landing one past its edge.
        assert_eq!(to_screen(&frame, 639.9, 359.9), (json!(1379), json!(769)));
    }

    #[test]
    fn document_and_selection_text_share_one_utf16_budget() {
        let document = "😀".repeat(3999) + "abc";
        let reply = json!({"snapshotId": 3, "window": 9, "elements": [
            {"runtimeKey": "k1", "name": "a", "role": "Edit", "bounds": {"x":0,"y":0,"width":1,"height":1}},
            {"runtimeKey": "", "name": "b", "role": "Text", "bounds": {"x":0,"y":0,"width":0,"height":0}}
        ], "document_text": document, "selected_text": "xyz", "focused_element": "k1"});
        let (elements, context) = elements_from(&reply).expect("elements");
        assert_eq!(
            utf16_len(context.document_text.as_deref().unwrap_or_default()),
            8000
        );
        // An exhausted budget still reports the selection, as an empty slice.
        assert_eq!(context.selected_text.as_deref(), Some(""));
        assert_eq!(context.focused_element, Some(0));
        assert_eq!(
            elements[0].target,
            ElementRef::Native {
                window: 9,
                snapshot_id: 3,
                runtime_key: "k1".to_owned()
            }
        );
        assert_eq!(
            elements[1].target,
            ElementRef::Unavailable("unavailable-3-2".to_owned())
        );
    }
}
