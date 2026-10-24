//! The Window2 vocabulary for one caller (`src/main/computer/windows-api.ts`).
//!
//! A caller's latest observation of each window is what authorizes its indexed and
//! coordinate input. It holds no pixels and no UI text, only element references and frame
//! geometry, and any submitted input consumes all of it.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::computer::{
    Action, Computer, ComputerError, ElementRef, Frame, Observation, StateRequest, Target,
    WindowInfo, WindowState, js_round, number,
};

const MAX_OBSERVED_WINDOWS: usize = 32;

/// `{app, id, title?}` as the model returns a window it was given.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct WindowArg {
    pub app: String,
    pub id: i64,
}

/// A window as the model sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PublicWindow {
    pub app: String,
    pub id: i64,
    pub title: Option<String>,
    pub state: Option<WindowState>,
}

impl PublicWindow {
    pub(crate) fn of(window: &WindowInfo) -> Result<Self, ComputerError> {
        let app = window.identity().ok_or_else(|| {
            ComputerError::new(
                "WINDOW_IDENTITY_UNAVAILABLE: observe a window with an exact native app identity.",
            )
        })?;
        Ok(Self {
            app: app.to_owned(),
            id: window.id,
            title: window.title.clone(),
            state: window.state,
        })
    }

    pub(crate) fn json(&self) -> Value {
        let mut object = Map::new();
        object.insert("app".to_owned(), json!(self.app));
        object.insert("id".to_owned(), json!(self.id));
        if let Some(title) = &self.title {
            object.insert("title".to_owned(), json!(title));
        }
        if let Some(state) = self.state {
            object.insert("state".to_owned(), json!(state.as_str()));
        }
        Value::Object(object)
    }
}

fn targetable(windows: &[WindowInfo]) -> Vec<Value> {
    windows
        .iter()
        .filter_map(|window| PublicWindow::of(window).ok())
        .map(|window| window.json())
        .collect()
}

const LABELS: [(&str, &str); 11] = [
    ("invoke", "Invoke"),
    ("toggle", "Toggle"),
    ("select", "Select"),
    ("expand", "Expand"),
    ("collapse", "Collapse"),
    ("focus", "Raise"),
    ("scroll_up", "Scroll Up"),
    ("scroll_down", "Scroll Down"),
    ("scroll_left", "Scroll Left"),
    ("scroll_right", "Scroll Right"),
    ("scroll_into_view", "Scroll Into View"),
];

fn label(action: &str) -> &str {
    LABELS
        .iter()
        .find(|(name, _)| *name == action)
        .map_or(action, |(_, label)| label)
}

struct ObservedFrame {
    frame: Frame,
    app: String,
}

struct State {
    app: String,
    frames: Vec<(String, ObservedFrame)>,
    primary: Option<String>,
    refs: Vec<(ElementRef, Vec<String>)>,
}

/// One window's slot. A new observation replaces the token, which fences the late result of
/// the observation it superseded.
struct Slot {
    window: i64,
    token: u64,
    state: Option<State>,
}

/// `get_window_state`'s answer: the metadata, then the PNGs in screenshot order.
pub(crate) struct Observed {
    pub value: Value,
    pub images: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct StateArgs {
    pub include_screenshot: Option<bool>,
    pub include_text: Option<bool>,
    pub query: Option<String>,
    pub role: Option<String>,
    pub max_elements: Option<u32>,
}

pub(crate) struct WindowsApi {
    slots: Mutex<Vec<Slot>>,
    next_token: AtomicU64,
}

impl WindowsApi {
    pub(crate) fn new() -> Self {
        Self {
            slots: Mutex::new(Vec::new()),
            next_token: AtomicU64::new(1),
        }
    }

    fn with_slots<T>(&self, f: impl FnOnce(&mut Vec<Slot>) -> T) -> T {
        f(&mut self
            .slots
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()))
    }

    fn token_of(&self, window: i64) -> Option<u64> {
        self.with_slots(|slots| {
            slots
                .iter()
                .find(|slot| slot.window == window)
                .map(|slot| slot.token)
        })
    }

    fn state_for<T>(
        &self,
        window: &WindowArg,
        read: impl FnOnce(&State) -> Result<T, ComputerError>,
    ) -> Result<T, ComputerError> {
        self.with_slots(|slots| {
            let state = slots
                .iter()
                .find(|slot| slot.window == window.id)
                .and_then(|slot| slot.state.as_ref())
                .filter(|state| state.app == window.app)
                .ok_or_else(|| {
                    ComputerError::new(
                        "STALE_WINDOW_STATE: call get_window_state before using indexes or coordinates.",
                    )
                })?;
            read(state)
        })
    }

    fn element(
        &self,
        window: &WindowArg,
        index: usize,
    ) -> Result<(ElementRef, Vec<String>), ComputerError> {
        self.state_for(window, |state| {
            state.refs.get(index).cloned().ok_or_else(|| {
                ComputerError::new(
                    "ELEMENT_NOT_FOUND: index is absent from the latest window state.",
                )
            })
        })
    }

    /// Image pixels of a returned screenshot, and the exact target their frame authorizes.
    fn coordinate(
        &self,
        window: &WindowArg,
        screenshot: Option<&str>,
        x: f64,
        y: f64,
    ) -> Result<(f64, f64, Target), ComputerError> {
        self.state_for(window, |state| {
            let id = screenshot.or(state.primary.as_deref()).unwrap_or_default();
            let observed = state
                .frames
                .iter()
                .find(|(frame_id, _)| frame_id == id)
                .map(|(_, observed)| observed)
                .filter(|observed| observed.frame.window_id.is_some())
                .ok_or_else(|| {
                    ComputerError::new(
                        "STALE_SCREENSHOT: screenshotId is absent from the latest window state.",
                    )
                })?;
            let (x, y) = (js_round(x), js_round(y));
            let frame = &observed.frame;
            if x < 0.0 || y < 0.0 || x >= frame.width || y >= frame.height {
                return Err(ComputerError::new(
                    "COORDINATE_OUT_OF_BOUNDS: use coordinates inside the selected screenshot region.",
                ));
            }
            let popup = frame.window_id != Some(window.id);
            Ok((
                x,
                y,
                Target {
                    window: frame.window_id,
                    app: Some(observed.app.clone()),
                    owner_window: popup.then_some(window.id),
                    owner_app: popup.then(|| window.app.clone()),
                    frame: Some(frame.clone()),
                },
            ))
        })
    }

    async fn current(&self, computer: &Computer, window: &WindowArg) -> Result<(), ComputerError> {
        let found = computer
            .window_state(StateRequest::window_only(window.id))
            .await?;
        if PublicWindow::of(&found.window)?.app != window.app {
            return Err(ComputerError::new(
                "STALE_WINDOW: app identity changed; get the window again.",
            ));
        }
        Ok(())
    }

    async fn mutate(
        &self,
        computer: &Computer,
        window: Option<&WindowArg>,
        action: Action,
        target: Option<Target>,
    ) -> Result<(), ComputerError> {
        if let Some(window) = window {
            let expected = self.token_of(window.id);
            self.current(computer, window).await?;
            if self.token_of(window.id) != expected {
                return Err(ComputerError::new(
                    "STALE_WINDOW_STATE: observation changed before input.",
                ));
            }
        }
        // A submitted input consumes observation authority even if the native operation fails.
        self.with_slots(Vec::clear);
        let target = target.unwrap_or_else(|| Target {
            window: window.map(|window| window.id),
            app: window.map(|window| window.app.clone()),
            ..Target::default()
        });
        computer.act(action, target).await.map(drop)
    }

    pub(crate) async fn list_windows(
        &self,
        computer: &Computer,
    ) -> Result<Vec<Value>, ComputerError> {
        Ok(targetable(&computer.list_windows().await?))
    }

    pub(crate) async fn get_window(
        &self,
        computer: &Computer,
        id: i64,
        app: Option<&str>,
    ) -> Result<Value, ComputerError> {
        let found = PublicWindow::of(
            &computer
                .window_state(StateRequest::window_only(id))
                .await?
                .window,
        )?;
        if app.is_some_and(|app| app != found.app) {
            return Err(ComputerError::new(
                "WINDOW_NOT_FOUND: app does not own this window.",
            ));
        }
        Ok(found.json())
    }

    pub(crate) async fn list_apps(&self, computer: &Computer) -> Result<Vec<Value>, ComputerError> {
        let (apps, truncated) = computer.list_apps(4096).await?;
        if truncated {
            return Err(ComputerError::new(
                "APP_LIST_TRUNCATED: native app catalog exceeded its bounded result.",
            ));
        }
        Ok(apps
            .iter()
            .map(|app| {
                json!({
                    "id": app.id,
                    "displayName": app.display_name,
                    "isRunning": app.is_running.unwrap_or(!app.windows.is_empty()),
                    "windows": targetable(&app.windows),
                })
            })
            .collect())
    }

    pub(crate) async fn launch_app(
        &self,
        computer: &Computer,
        app: String,
    ) -> Result<(), ComputerError> {
        self.mutate(computer, None, Action::LaunchApp { app }, None)
            .await
    }

    pub(crate) async fn get_window_state(
        &self,
        computer: &Computer,
        window: &WindowArg,
        args: StateArgs,
    ) -> Result<Observed, ComputerError> {
        let include_screenshot = args.include_screenshot != Some(false);
        let text_options =
            args.query.is_some() || args.role.is_some() || args.max_elements.is_some();
        let include_ui = args.include_text.unwrap_or(text_options);
        if text_options && !include_ui {
            return Err(ComputerError::new(
                "INVALID_ARGUMENT: query, role and max_elements need include_text:true, or omit include_text.",
            ));
        }
        if !include_screenshot && !include_ui {
            return Err(ComputerError::new(
                "At least one of include_screenshot or include_text must be true.",
            ));
        }
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        self.with_slots(|slots| {
            slots.retain(|slot| slot.window != window.id);
            slots.push(Slot {
                window: window.id,
                token,
                state: None,
            });
            let excess = slots.len().saturating_sub(MAX_OBSERVED_WINDOWS);
            slots.drain(..excess);
        });
        let observation = computer
            .window_state(StateRequest {
                window: window.id,
                include_screenshot,
                include_ui,
                include_related: include_screenshot,
                max_elements: args.max_elements.unwrap_or(100),
                query: args.query,
                role: args.role,
            })
            .await?;
        if self.token_of(window.id) != Some(token) {
            return Err(ComputerError::new(
                "STALE_WINDOW_STATE: observation was superseded.",
            ));
        }
        let public = PublicWindow::of(&observation.window)?;
        if public.app != window.app {
            return Err(ComputerError::new("STALE_WINDOW: app identity changed."));
        }
        let (state, observed) = describe(&observation, public, include_ui)?;
        self.with_slots(|slots| {
            if let Some(slot) = slots.iter_mut().find(|slot| slot.token == token) {
                slot.state = Some(state);
            }
        });
        Ok(observed)
    }

    pub(crate) async fn click(
        &self,
        computer: &Computer,
        window: &WindowArg,
        click: Click,
    ) -> Result<(), ComputerError> {
        let button = match click.mouse_button.as_deref().unwrap_or("left") {
            "l" => "left",
            "r" => "right",
            "m" => "middle",
            other => other,
        }
        .to_owned();
        let count = click.click_count.unwrap_or(1);
        if let Some(index) = click.element_index {
            if click.x.is_some() || click.y.is_some() || click.screenshot_id.is_some() {
                return Err(ComputerError::new(
                    "Choose element_index or screenshot coordinates.",
                ));
            }
            let (target, _) = self.element(window, index)?;
            let action = Action::ClickRef {
                target,
                button,
                count,
            };
            return self.mutate(computer, Some(window), action, None).await;
        }
        let (Some(x), Some(y)) = (click.x, click.y) else {
            return Err(ComputerError::new("Coordinate click requires x and y."));
        };
        let (x, y, target) = self.coordinate(window, click.screenshot_id.as_deref(), x, y)?;
        let action = Action::Click {
            x,
            y,
            button,
            count,
        };
        self.mutate(computer, Some(window), action, Some(target))
            .await
    }

    pub(crate) async fn press_key(
        &self,
        computer: &Computer,
        window: &WindowArg,
        keys: Vec<String>,
    ) -> Result<(), ComputerError> {
        self.mutate(computer, Some(window), Action::Keypress { keys }, None)
            .await
    }

    pub(crate) async fn type_text(
        &self,
        computer: &Computer,
        window: &WindowArg,
        text: String,
    ) -> Result<(), ComputerError> {
        let action = if text.contains(['\r', '\n']) {
            Action::Paste { text }
        } else {
            Action::Type { text }
        };
        self.mutate(computer, Some(window), action, None).await
    }

    pub(crate) async fn scroll(
        &self,
        computer: &Computer,
        window: &WindowArg,
        screenshot: Option<&str>,
        point: (f64, f64),
        delta: (f64, f64),
    ) -> Result<(), ComputerError> {
        let (x, y, target) = self.coordinate(window, screenshot, point.0, point.1)?;
        let action = Action::Scroll {
            x,
            y,
            scroll_x: js_round(delta.0),
            scroll_y: js_round(delta.1),
        };
        self.mutate(computer, Some(window), action, Some(target))
            .await
    }

    pub(crate) async fn set_value(
        &self,
        computer: &Computer,
        window: &WindowArg,
        index: usize,
        text: String,
    ) -> Result<(), ComputerError> {
        let (target, _) = self.element(window, index)?;
        self.mutate(
            computer,
            Some(window),
            Action::SetValue { target, text },
            None,
        )
        .await
    }

    pub(crate) async fn drag(
        &self,
        computer: &Computer,
        window: &WindowArg,
        screenshot: Option<&str>,
        from: (f64, f64),
        to: (f64, f64),
    ) -> Result<(), ComputerError> {
        let (x1, y1, target) = self.coordinate(window, screenshot, from.0, from.1)?;
        let (x2, y2, _) = self.coordinate(window, screenshot, to.0, to.1)?;
        let action = Action::Drag {
            from: (x1, y1),
            to: (x2, y2),
        };
        self.mutate(computer, Some(window), action, Some(target))
            .await
    }

    pub(crate) async fn perform_secondary_action(
        &self,
        computer: &Computer,
        window: &WindowArg,
        index: usize,
        requested: &str,
    ) -> Result<(), ComputerError> {
        let (target, actions) = self.element(window, index)?;
        let wanted = requested.trim().to_lowercase();
        let action = actions
            .into_iter()
            .find(|action| label(action).to_lowercase() == wanted)
            .ok_or_else(|| {
                ComputerError::new(
                    "ACTION_UNAVAILABLE: choose an action label from the latest element.",
                )
            })?;
        self.mutate(
            computer,
            Some(window),
            Action::Semantic { target, action },
            None,
        )
        .await
    }

    pub(crate) async fn activate_window(
        &self,
        computer: &Computer,
        window: &WindowArg,
    ) -> Result<(), ComputerError> {
        self.mutate(
            computer,
            Some(window),
            Action::Focus { window: window.id },
            None,
        )
        .await
    }
}

/// The coordinate or indexed click a caller asked for.
pub(crate) struct Click {
    pub click_count: Option<u32>,
    pub element_index: Option<usize>,
    pub mouse_button: Option<String>,
    pub screenshot_id: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

/// The caller's new authority and the model-facing state of one observation.
fn describe(
    observation: &Observation,
    window: PublicWindow,
    include_ui: bool,
) -> Result<(State, Observed), ComputerError> {
    let mut state = State {
        app: window.app.clone(),
        frames: Vec::new(),
        primary: None,
        refs: observation
            .elements
            .iter()
            .map(|element| (element.target.clone(), element.actions.clone()))
            .collect(),
    };
    let mut screenshots = Vec::new();
    let mut images = Vec::new();
    // EnumWindows lists related windows from highest to lowest z-order.
    let shots = observation
        .screenshot
        .iter()
        .map(|shot| (shot, &observation.window, true))
        .chain(observation.related.iter().rev().filter_map(|related| {
            related
                .screenshot
                .as_ref()
                .map(|shot| (shot, &related.window, false))
        }));
    for (shot, owner, primary) in shots {
        let id = format!("frame-{}", shot.frame.id);
        let app = PublicWindow::of(owner)?.app;
        state.frames.push((
            id.clone(),
            ObservedFrame {
                frame: shot.frame.clone(),
                app,
            },
        ));
        if primary {
            state.primary = Some(id.clone());
        }
        screenshots.push(json!({
            "id": id,
            "width": number(shot.frame.width),
            "height": number(shot.frame.height),
            "originX": number(shot.frame.region.x),
            "originY": number(shot.frame.region.y),
            "zIndex": screenshots.len(),
        }));
        images.push(shot.data.clone());
    }
    let lines: Vec<String> = observation
        .elements
        .iter()
        .enumerate()
        .map(|(index, element)| {
            let mut line = "\t".repeat(element.depth.unwrap_or(0).clamp(0, 30) as usize);
            line.push_str(&format!(
                "{index}: {} {}",
                element.role,
                serde_json::to_string(&element.name).unwrap_or_default()
            ));
            if !element.actions.is_empty() {
                let labels: Vec<&str> =
                    element.actions.iter().map(|action| label(action)).collect();
                line.push_str(&format!(" [{}]", labels.join(", ")));
            }
            if element.offscreen {
                line.push_str(" [offscreen]");
            }
            if !element.enabled {
                line.push_str(" [disabled]");
            }
            if element.bounds.width <= 0.0 || element.bounds.height <= 0.0 {
                line.push_str(" [no pixel bounds]");
            }
            line
        })
        .collect();
    let context = observation.accessibility.clone().unwrap_or_default();
    let focused = observation
        .elements
        .iter()
        .enumerate()
        .position(|(index, element)| {
            Some(index) == context.focused_element || element.focused == Some(true)
        });
    let selected: Vec<&String> = lines
        .iter()
        .zip(&observation.elements)
        .filter(|(_, element)| element.selected == Some(true))
        .map(|(line, _)| line)
        .collect();
    let accessibility = if !include_ui || observation.ui_unavailable.is_some() {
        Value::Null
    } else {
        let mut object = Map::new();
        object.insert("truncated".to_owned(), json!(observation.ui_truncated));
        object.insert("tree".to_owned(), json!(lines.join("\n")));
        if let Some(text) = &context.document_text {
            object.insert("document_text".to_owned(), json!(text));
        }
        if let Some(index) = focused {
            object.insert("focused_element".to_owned(), json!(lines[index]));
        }
        if !selected.is_empty() {
            object.insert("selected_elements".to_owned(), json!(selected));
        }
        if let Some(text) = &context.selected_text {
            object.insert("selected_text".to_owned(), json!(text));
        }
        Value::Object(object)
    };
    let focused_window = match &observation.screenshot {
        Some(shot) => json!(shot.focused),
        None => match observation.window.state {
            Some(state) => json!(state == WindowState::Foreground),
            None => Value::Null,
        },
    };
    let mut value = Map::new();
    value.insert("window".to_owned(), window.json());
    value.insert("focused".to_owned(), focused_window);
    value.insert("screenshots".to_owned(), Value::Array(screenshots));
    if let Some(failure) = &observation.screenshot_unavailable {
        value.insert("screenshot_error".to_owned(), failure.json());
    }
    if include_ui && let Some(failure) = &observation.ui_unavailable {
        value.insert("accessibility_error".to_owned(), failure.json());
    }
    value.insert("accessibility".to_owned(), accessibility);
    Ok((
        state,
        Observed {
            value: Value::Object(value),
            images,
        },
    ))
}
