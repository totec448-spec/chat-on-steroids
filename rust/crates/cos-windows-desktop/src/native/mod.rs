//! The native desktop operations. One [`Helper`] lives on the desktop thread and owns the
//! Win32 and UIA state; it answers the helper vocabulary (`op` requests, `{"ok": ...}`
//! replies) the TypeScript app spoke to its native helper.
mod apps;
mod clipboard;
mod input;
pub(crate) mod policy;
mod win;

pub(crate) use platform::Helper;

/// Keeps the process's multithreaded apartment alive once a desktop thread has joined it.
///
/// The `windows` crate caches WinRT activation factories (Windows.Graphics.Capture) for the
/// process. If the last MTA thread uninitializes COM, the MTA is torn down and those cached
/// factories dangle, so the next desktop thread's capture would use freed objects.
pub(crate) fn keep_multithreaded_apartment() {
    static KEEP: std::sync::Once = std::sync::Once::new();
    KEEP.call_once(|| {
        // SAFETY: takes one process-lifetime MTA usage reference that is never released.
        let _ = unsafe { windows::Win32::System::Com::CoIncrementMTAUsage() };
    });
}

mod platform {
    use super::{apps, clipboard, input, win};
    use base64::Engine as _;
    use cos_sidecar_runtime::DesktopError;
    use serde_json::{Value, json};
    use win::{Result, fail};

    fn integer(object: &Value, key: &str) -> Result<i64> {
        object
            .get(key)
            .and_then(Value::as_i64)
            .ok_or_else(|| fail("BAD_REQUEST", format!("{key} must be an integer")))
    }
    fn optional_integer(object: &Value, key: &str) -> Result<Option<i64>> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_i64()
                .map(Some)
                .ok_or_else(|| fail("BAD_REQUEST", format!("{key} must be an integer"))),
        }
    }
    fn as_i32(value: i64, key: &str) -> Result<i32> {
        i32::try_from(value)
            .map_err(|_| fail("BAD_ACTION", format!("{key} coordinate is out of range")))
    }
    fn request_i32(object: &Value, key: &str) -> Result<i32> {
        as_i32(integer(object, key)?, key)
    }
    fn optional_str<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    }
    fn merge(target: &mut Value, value: Value) {
        if let (Some(to), Value::Object(from)) = (target.as_object_mut(), value) {
            for (key, value) in from {
                to.insert(key, value);
            }
        }
    }
    // Standalone find_ui returns its HWND in "window". Snapshot already
    // published the complete WindowInfo there, so do not overwrite it.
    fn merge_snapshot_ui(target: &mut Value, mut fields: Value) {
        if let Some(object) = fields.as_object_mut() {
            object.remove("window");
        }
        merge(target, fields);
    }
    fn code_message(error: DesktopError) -> Value {
        error.into_reply()
    }

    // A cursor observation happens *after* every action. If that observation
    // fails, do not discard the proof of native effects that already completed.
    // There is no failed action index because no action failed.
    fn completed_action_reply(
        routes: Vec<String>,
        launches: Vec<Value>,
        foreground: i64,
        cursor: Result<Value>,
    ) -> Value {
        let mut reply = match cursor {
            Ok(cursor) => json!({"ok":true,"cursor":cursor}),
            Err(error) => json!({"ok":false,"error_code":error.code,"message":error.message}),
        };
        reply["completed_count"] = json!(routes.len());
        reply["routes"] = json!(routes);
        reply["launches"] = json!(launches);
        reply["foreground"] = json!(foreground);
        reply
    }

    // The screenshot and its later input must agree on the actual rectangles
    // of every active display, not just their shared virtual bounding box.
    // Sample immediately around capture; do not publish a frame for a changing
    // topology or store another long-lived topology authority.
    fn capture_with_topology(request: &Value, forced_window: Option<i64>) -> Result<Value> {
        capture_with_topology_using(
            request,
            forced_window,
            win::display_topology,
            |request, id| {
                let captured = cos_windows_capture::capture(request, id)?;
                let mut fields = captured.fields;
                fields["data"] =
                    json!(base64::engine::general_purpose::STANDARD.encode(captured.png));
                Ok(fields)
            },
        )
    }

    fn capture_with_topology_using(
        request: &Value,
        forced_window: Option<i64>,
        mut displays: impl FnMut() -> Result<Value>,
        capture: impl FnOnce(&Value, Option<i64>) -> Result<Value>,
    ) -> Result<Value> {
        let screen_capture = request
            .get("region")
            .is_some_and(|region| !region.is_null())
            || (forced_window.is_none() && request.get("id").is_none_or(Value::is_null));
        let before = screen_capture.then(&mut displays).transpose()?;
        let mut reply = capture(request, forced_window)?;
        if reply["captureMode"] == "screen" {
            let recorded = before
                .ok_or_else(|| fail("STALE_FRAME", "screen capture lost its display topology"))?;
            if recorded != displays()? {
                return Err(fail(
                    "STALE_FRAME",
                    "display topology changed during screen capture",
                ));
            }
            reply["displays"] = recorded;
        }
        Ok(reply)
    }

    /// Owns the COM apartment and UIA snapshots. Not `Send`: it lives and dies on the
    /// desktop thread.
    pub(crate) struct Helper {
        uia: cos_windows_uia::UiaAvailability,
    }

    impl Helper {
        pub(crate) fn new() -> Self {
            Self::new_using(cos_windows_uia::UiaAvailability::new)
        }

        fn new_using(activate: impl FnOnce() -> cos_windows_uia::UiaAvailability) -> Self {
            Self { uia: activate() }
        }

        /// One helper request. Every answer, refusals included, is a `{"ok": ...}` reply.
        pub(crate) fn handle(&mut self, request: &Value) -> Value {
            self.handle_using(request, win::cursor, win::window_row, capture_with_topology)
                .unwrap_or_else(code_message)
        }

        fn handle_using(
            &mut self,
            request: &Value,
            cursor: impl FnOnce() -> Result<Value>,
            window_row: impl Fn(i64) -> Option<Value>,
            capture: impl Fn(&Value, Option<i64>) -> Result<Value>,
        ) -> Result<Value> {
            win::setup_dpi()?;
            let op = request.get("op").and_then(Value::as_str).unwrap_or("");
            let mut out = json!({"ok":true});
            match op {
                "warm" => {
                    let _ = win::foreground();
                    if let Err(error) = self.uia.warm() {
                        out["uiUnavailable"] = json!({"code":"UIA_FAILED","message":error.message});
                    }
                    out["ready"] = json!(true);
                }
                "cursor" => {
                    out["cursor"] = cursor()?;
                    out["foreground"] = json!(win::foreground());
                }
                "windows" => {
                    out["windows"] = json!(win::windows());
                    out["screen"] = win::screen()["virtual"].clone();
                }
                "active" => {
                    out["window"] = win::window_row(win::foreground()).unwrap_or(Value::Null);
                    out["screen"] = win::screen()["virtual"].clone();
                }
                "apps" => merge(&mut out, apps::list(request)?),
                "focus" => {
                    let id = integer(request, "id")?;
                    out["focused"] = json!(win::try_focus(id));
                    out["foreground"] = json!(win::foreground());
                }
                "find_ui" => merge(&mut out, self.uia.find(request)?),
                "act_ui" => {
                    let mut host = InputHost::from_request(request);
                    merge(&mut out, self.uia.act(request, &mut host)?);
                }
                "capture" => {
                    merge(&mut out, capture(request, None)?);
                }
                "read_clipboard" => out["text"] = json!(clipboard::read_text()?),
                "write_clipboard" => {
                    let text = request["text"]
                        .as_str()
                        .ok_or_else(|| fail("BAD_REQUEST", "text must be a string"))?;
                    clipboard::write_text(text)?;
                }
                "snapshot" => self.snapshot_using(request, &mut out, window_row, capture)?,
                "act" => return Ok(self.act(request)),
                _ => return Err(fail("BAD_REQUEST", format!("Unknown op: {op}"))),
            }
            Ok(out)
        }

        fn snapshot_using(
            &mut self,
            request: &Value,
            out: &mut Value,
            window_row: impl Fn(i64) -> Option<Value>,
            capture: impl Fn(&Value, Option<i64>) -> Result<Value>,
        ) -> Result<()> {
            let id = optional_integer(request, "id")?.unwrap_or_else(win::foreground);
            let window = window_row(id).ok_or_else(|| {
                fail(
                    "WINDOW_NOT_FOUND",
                    "no matching visible window is available",
                )
            })?;
            out["window"] = window;
            if request["includeRelated"].as_bool() == Some(true) {
                out["relatedWindows"] = json!(win::related_windows(id));
            }
            let mut capture_failed = false;
            let mut ui_failed = false;
            if request["includeScreenshot"].as_bool() == Some(true) {
                match capture(request, Some(id)) {
                    Ok(fields) => merge(out, fields),
                    Err(error) => {
                        if error.code != "CAPTURE_FAILED"
                            || request["includeUi"].as_bool() != Some(true)
                        {
                            return Err(error);
                        }
                        capture_failed = true;
                        let message = format!("{}: {}", error.code, error.message);
                        out["screenshotUnavailable"] = json!({"code":"CAPTURE_FAILED",
                        "message":message.chars().take(500).collect::<String>()});
                    }
                }
            }
            if request["includeUi"].as_bool() == Some(true) {
                let mut ui_request = request.clone();
                ui_request["id"] = json!(id);
                match self.uia.find(&ui_request) {
                    Ok(fields) => merge_snapshot_ui(out, fields),
                    Err(error) => {
                        ui_failed = true;
                        out["uiUnavailable"] = json!({"code":"UIA_FAILED","message":error.message.chars().take(500).collect::<String>()});
                        out["elements"] = json!([]);
                    }
                }
            }
            if capture_failed && ui_failed {
                return Err(fail(
                    "CAPTURE_FAILED",
                    format!(
                        "{}; UIA_FAILED: {}",
                        out["screenshotUnavailable"]["message"]
                            .as_str()
                            .unwrap_or("capture failed"),
                        out["uiUnavailable"]["message"]
                            .as_str()
                            .unwrap_or("accessibility failed")
                    ),
                ));
            }
            Ok(())
        }

        fn act(&mut self, request: &Value) -> Value {
            let actions = match request["actions"].as_array() {
                Some(actions) if actions.len() <= 20 => actions,
                _ => {
                    return code_message(fail(
                        "BAD_REQUEST",
                        "actions must be an array of up to 20 entries",
                    ));
                }
            };
            let prepared = match self.preflight(request, actions) {
                Ok(value) => value,
                Err(error) => return code_message(error),
            };
            let mut routes = Vec::<String>::new();
            let mut launches = Vec::<Value>::new();
            for (index, (action, resolved)) in actions.iter().zip(prepared).enumerate() {
                let result = self.one_action(request, action, resolved.as_deref());
                match result {
                    Ok((route, launch)) => {
                        routes.push(route.to_owned());
                        if let Some(launch) = launch {
                            launches.push(launch);
                        }
                    }
                    Err(error) => {
                        return json!({"ok":false,"error_code":error.code,
                        "message":error.message,"completed_count":routes.len(),
                        "failed_index":index,"routes":routes,"launches":launches});
                    }
                }
            }
            completed_action_reply(routes, launches, win::foreground(), win::cursor())
        }

        fn preflight(&self, request: &Value, actions: &[Value]) -> Result<Vec<Option<Vec<i32>>>> {
            let mut key_target =
                optional_integer(request, "targetWindow")?.unwrap_or_else(win::foreground);
            let mut prepared = Vec::with_capacity(actions.len());
            for action in actions {
                let kind = optional_str(action, "type")
                    .ok_or_else(|| fail("BAD_ACTION", "action type is missing"))?;
                if kind == "focus" {
                    key_target = integer(action, "window")?;
                }
                let resolved = if kind == "keypress" {
                    let keys = action["keys"]
                        .as_array()
                        .ok_or_else(|| fail("BAD_KEY", "keypress keys must be an array"))?;
                    Some(input::resolve_keys(keys, key_target)?)
                } else {
                    None
                };
                if kind == "type"
                    && optional_str(action, "text")
                        .unwrap_or("")
                        .contains(['\r', '\n'])
                {
                    return Err(fail(
                        "MULTILINE_REQUIRES_PASTE",
                        "literal multiline text requires the clipboard paste action",
                    ));
                }
                if kind == "ui_action"
                    && !matches!(
                        optional_str(action, "action"),
                        Some(
                            "invoke"
                                | "toggle"
                                | "select"
                                | "expand"
                                | "collapse"
                                | "focus"
                                | "scroll_up"
                                | "scroll_down"
                                | "scroll_left"
                                | "scroll_right"
                                | "scroll_into_view"
                        )
                    )
                {
                    return Err(fail("BAD_ACTION", "unsupported UI element action"));
                }
                if matches!(kind, "click" | "click_ui") {
                    let _ = click_count(action)?;
                }
                if kind == "drag" {
                    let duration = optional_integer(action, "durationMs")?.unwrap_or(350);
                    if !(50..=2000).contains(&duration) {
                        return Err(fail(
                            "BAD_ACTION",
                            "drag duration must be an integer between 50 and 2000 milliseconds",
                        ));
                    }
                }
                prepared.push(resolved);
            }
            Ok(prepared)
        }

        fn one_action(
            &mut self,
            request: &Value,
            action: &Value,
            resolved: Option<&[i32]>,
        ) -> Result<(&'static str, Option<Value>)> {
            let kind = optional_str(action, "type")
                .ok_or_else(|| fail("BAD_ACTION", "action type is missing"))?;
            if matches!(kind, "click_ui" | "set_value_ui" | "ui_action") {
                self.uia.ensure_available()?;
            }
            let target = if matches!(kind, "click_ui" | "set_value_ui" | "ui_action" | "focus") {
                integer(action, "window")?
            } else {
                optional_integer(request, "targetWindow")?
                    .or(optional_integer(&request["frame"], "window")?)
                    .unwrap_or(0)
            };
            let owner = optional_integer(request, "ownerWindow")?;
            let target_app = optional_str(request, "targetApp");
            let owner_app = optional_str(request, "ownerApp");
            win::assert_owner(target, owner, target_app, owner_app)?;
            if matches!(
                kind,
                "move" | "click" | "double_click" | "scroll" | "drag" | "type" | "keypress"
            ) {
                if let Some(explicit) = optional_integer(request, "targetWindow")? {
                    win::assert_focused(explicit)?;
                    win::assert_owner(target, owner, target_app, owner_app)?;
                }
                if matches!(kind, "move" | "click" | "double_click" | "scroll" | "drag")
                    && request.get("frame").is_some()
                {
                    assert_frame(&request["frame"])?;
                }
            }
            win::assert_owner(target, owner, target_app, owner_app)?;
            match kind {
                "click_ui" | "set_value_ui" | "ui_action" => {
                    let id = integer(action, "window")?;
                    let mode = match kind {
                        "click_ui" => "click",
                        "set_value_ui" => "set_value",
                        _ => optional_str(action, "action").unwrap_or(""),
                    };
                    let mut ui_request = json!({"id":id,
                    "snapshotId":action["snapshotId"],"runtimeKey":action["runtimeKey"],
                    "action":mode,"ownerWindow":request["ownerWindow"],
                    "targetApp":request["targetApp"],"ownerApp":request["ownerApp"]});
                    if mode == "set_value" {
                        ui_request["value"] = action["value"].clone();
                    }
                    if mode == "click" {
                        ui_request["button"] = action["button"].clone();
                        ui_request["count"] = action["count"].clone();
                    }
                    let mut host = InputHost::from_request(&ui_request);
                    let detail = self.uia.act(&ui_request, &mut host)?;
                    let route = detail["route"].as_str().ok_or_else(|| {
                        fail("UIA_FAILED", "native UI action reported no input route")
                    })?;
                    match route {
                        "uia" => Ok(("uia", None)),
                        "sendinput" => Ok(("sendinput", None)),
                        _ => Err(fail(
                            "UIA_FAILED",
                            "native UI action reported an invalid input route",
                        )),
                    }
                }
                "launch_app" => Ok((
                    "shell",
                    Some(apps::launch(optional_str(action, "app").unwrap_or(""))?),
                )),
                "move" => {
                    input::move_to(request_i32(action, "x")?, request_i32(action, "y")?)?;
                    Ok(("sendinput", None))
                }
                "click" | "double_click" => {
                    let count = if kind == "double_click" {
                        2
                    } else {
                        click_count(action)?
                    };
                    input::click(
                        request_i32(action, "x")?,
                        request_i32(action, "y")?,
                        optional_str(action, "button").unwrap_or("left"),
                        count,
                    )?;
                    Ok(("sendinput", None))
                }
                "scroll" => {
                    input::scroll(
                        request_i32(action, "x")?,
                        request_i32(action, "y")?,
                        optional_integer(action, "scroll_x")?
                            .map_or(Ok(0), |v| as_i32(v, "scroll_x"))?,
                        optional_integer(action, "scroll_y")?
                            .map_or(Ok(0), |v| as_i32(v, "scroll_y"))?,
                        action["rawWheel"].as_bool() == Some(true),
                    )?;
                    Ok(("sendinput", None))
                }
                "drag" => {
                    let xs = coordinate_array(action, "xs")?;
                    let ys = coordinate_array(action, "ys")?;
                    input::drag(
                        &xs,
                        &ys,
                        optional_str(action, "button").unwrap_or("left"),
                        optional_integer(action, "durationMs")?.unwrap_or(350) as u32,
                    )?;
                    Ok(("sendinput", None))
                }
                "type" => {
                    let text = action["text"]
                        .as_str()
                        .ok_or_else(|| fail("BAD_ACTION", "type text must be a string"))?;
                    input::type_text(text)?;
                    Ok(("sendinput", None))
                }
                "keypress" => {
                    input::keypress(
                        resolved.ok_or_else(|| fail("BAD_KEY", "missing prevalidated keys"))?,
                    )?;
                    Ok(("sendinput", None))
                }
                "focus" => {
                    win::assert_focused(target)?;
                    win::assert_owner(target, owner, target_app, owner_app)?;
                    Ok(("focus", None))
                }
                _ => Err(fail("BAD_ACTION", format!("Unknown action: {kind}"))),
            }
        }
    }

    fn click_count(action: &Value) -> Result<u32> {
        let count = optional_integer(action, "count")?.unwrap_or(1);
        if !(1..=3).contains(&count) {
            return Err(fail(
                "BAD_ACTION",
                "click count must be an integer between 1 and 3",
            ));
        }
        Ok(count as u32)
    }
    fn coordinate_array(action: &Value, key: &str) -> Result<Vec<i32>> {
        action[key]
            .as_array()
            .ok_or_else(|| fail("BAD_ACTION", format!("{key} must be an array")))?
            .iter()
            .map(|v| {
                v.as_i64()
                    .ok_or_else(|| fail("BAD_ACTION", "drag point must be integer"))
                    .and_then(|v| as_i32(v, key))
            })
            .collect()
    }
    fn assert_screen_frame(frame: &Value, desktop: &Value, current_displays: &Value) -> Result<()> {
        let recorded = frame
            .get("displays")
            .filter(|value| value.as_array().is_some_and(|rows| !rows.is_empty()))
            .ok_or_else(|| {
                fail(
                    "STALE_FRAME",
                    "screen frame lacks its observed display topology",
                )
            })?;
        if recorded != current_displays {
            return Err(fail(
                "STALE_FRAME",
                "display topology changed since the screen capture",
            ));
        }
        let region = &frame["region"];
        let x = integer(region, "x")?;
        let y = integer(region, "y")?;
        let width = integer(region, "width")?;
        let height = integer(region, "height")?;
        if width <= 0 || height <= 0 {
            return Err(fail("STALE_FRAME", "frame has invalid geometry"));
        }
        let sx = integer(desktop, "x")?;
        let sy = integer(desktop, "y")?;
        let sw = integer(desktop, "width")?;
        let sh = integer(desktop, "height")?;
        if x < sx
            || y < sy
            || x.checked_add(width).is_none_or(|v| v > sx + sw)
            || y.checked_add(height).is_none_or(|v| v > sy + sh)
        {
            return Err(fail(
                "STALE_FRAME",
                "desktop geometry changed after the frame",
            ));
        }
        Ok(())
    }

    fn assert_frame(frame: &Value) -> Result<()> {
        let region = &frame["region"];
        let width = integer(region, "width")?;
        let height = integer(region, "height")?;
        if width <= 0 || height <= 0 {
            return Err(fail("STALE_FRAME", "frame has invalid geometry"));
        }
        if let Some(id) = optional_integer(frame, "window")? {
            let owner = optional_integer(frame, "ownerWindow")?;
            win::assert_owner(
                id,
                owner,
                optional_str(frame, "targetApp"),
                optional_str(frame, "ownerApp"),
            )?;
            let row = win::window_row(id).ok_or_else(|| {
                fail(
                    "STALE_FRAME",
                    format!("target window {id} is no longer drawable"),
                )
            })?;
            if row["state"] == "minimized" {
                return Err(fail("STALE_FRAME", "target is minimized"));
            }
            let expected = frame
                .get("windowGeometry")
                .filter(|v| !v.is_null())
                .unwrap_or(region);
            for key in ["x", "y", "width", "height"] {
                if row[key] != expected[key] {
                    return Err(fail(
                        "STALE_FRAME",
                        format!("target window {id} moved or resized after frame"),
                    ));
                }
            }
            win::assert_focused(id)?;
            win::assert_owner(
                id,
                owner,
                optional_str(frame, "targetApp"),
                optional_str(frame, "ownerApp"),
            )?;
            let after = win::window_row(id)
                .ok_or_else(|| fail("STALE_FRAME", "window disappeared during activation"))?;
            for key in ["x", "y", "width", "height"] {
                if after[key] != expected[key] {
                    return Err(fail(
                        "STALE_FRAME",
                        "target changed geometry while it was activated",
                    ));
                }
            }
        } else {
            // Must pass before the caller enters input::click/move/drag/scroll.
            assert_screen_frame(frame, &win::screen()["virtual"], &win::display_topology()?)?;
        }
        Ok(())
    }

    struct InputHost {
        owner: Option<i64>,
        target_app: Option<String>,
        owner_app: Option<String>,
    }
    impl InputHost {
        fn from_request(request: &Value) -> Self {
            Self {
                owner: request["ownerWindow"].as_i64(),
                target_app: optional_str(request, "targetApp").map(str::to_owned),
                owner_app: optional_str(request, "ownerApp").map(str::to_owned),
            }
        }
    }
    impl cos_windows_uia::UiaInputHost for InputHost {
        fn assert_input_owner(&mut self, request: &Value) -> std::result::Result<(), DesktopError> {
            let id = request["id"]
                .as_i64()
                .or_else(|| request["window"].as_i64())
                .unwrap_or(0);
            win::assert_owner(
                id,
                self.owner,
                self.target_app.as_deref(),
                self.owner_app.as_deref(),
            )
        }
        fn assert_focused(&mut self, window: i64) -> std::result::Result<(), DesktopError> {
            win::assert_focused(window)
        }
        fn click(
            &mut self,
            x: i32,
            y: i32,
            button: &str,
            count: u32,
        ) -> std::result::Result<(), DesktopError> {
            input::click(x, y, button, count)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn uia_activation_failure_preserves_capture() {
            let mut desktop = Helper::new_using(|| {
                cos_windows_uia::UiaAvailability::new_with_activation_check(|| {
                    Err(fail(
                        "UIA_FAILED",
                        format!("activation failed: {}", "界😀".repeat(300)),
                    ))
                })
            });
            let mut request = |data: Value| {
                desktop
                    .handle_using(
                        &data,
                        || Ok(json!({"x":25,"y":30})),
                        |id| (id == 73).then(|| json!({"id":73,"title":"Owned window"})),
                        |request, forced| {
                            capture_with_topology_using(
                                request,
                                forced,
                                || panic!("HWND capture must not enumerate displays"),
                                |_, id| {
                                    assert_eq!(id, (request["op"] == "snapshot").then_some(73));
                                    Ok(json!({"captureMode":"window","image":"pixel-payload"}))
                                },
                            )
                        },
                    )
                    .unwrap_or_else(code_message)
            };
            let cursor = request(json!({"op":"cursor"}));
            assert_eq!(cursor["ok"], true);
            assert_eq!(cursor["cursor"], json!({"x":25,"y":30}));

            let pixels = request(json!({"op":"snapshot","id":73,
                "includeScreenshot":true,"includeUi":false}));
            assert_eq!(pixels["ok"], true);
            assert_eq!(pixels["image"], "pixel-payload");
            assert!(pixels.get("uiUnavailable").is_none());
            let capture = request(json!({"op":"capture","id":73}));
            assert_eq!(capture["ok"], true);
            assert_eq!(capture["image"], "pixel-payload");

            let combined = request(json!({"op":"snapshot","id":73,
                "includeScreenshot":true,"includeUi":true}));
            assert_eq!(combined["ok"], true);
            assert_eq!(combined["image"], "pixel-payload");
            assert_eq!(combined["window"]["title"], "Owned window");
            assert_eq!(combined["elements"], json!([]));
            assert_eq!(combined["uiUnavailable"]["code"], "UIA_FAILED");
            assert!(
                combined["uiUnavailable"]["message"]
                    .as_str()
                    .unwrap()
                    .chars()
                    .count()
                    <= 500
            );

            let ready = request(json!({"op":"warm"}));
            assert_eq!(ready["ok"], true);
            assert_eq!(ready["ready"], true);
            assert_eq!(ready["uiUnavailable"]["code"], "UIA_FAILED");
            let find = request(json!({"op":"find_ui","id":73}));
            assert_eq!(find["error_code"], "UIA_FAILED");
            let act = request(
                json!({"op":"act_ui","id":73,"snapshotId":1,"runtimeKey":"1.2","action":"invoke"}),
            );
            assert_eq!(act["error_code"], "UIA_FAILED");
            let batch = request(
                json!({"op":"act","actions":[{"type":"click_ui", "window":73,
                "snapshotId":1,"runtimeKey":"1.2"}]}),
            );
            assert_eq!(batch["error_code"], "UIA_FAILED");
            assert_eq!(batch["failed_index"], 0);
            assert_eq!(batch["completed_count"], 0);
            assert_eq!(batch["routes"], json!([]));
            for kind in ["set_value_ui", "ui_action"] {
                let refused = request(json!({"op":"act","actions":[{"type":kind,"window":73,
                    "snapshotId":1,"runtimeKey":"1.2","action":"invoke","value":"test"}]}));
                assert_eq!(refused["error_code"], "UIA_FAILED", "{kind}");
                assert_eq!(refused["failed_index"], 0, "{kind}");
                assert_eq!(refused["completed_count"], 0, "{kind}");
            }
        }

        #[test]
        fn cursor_failure_after_actions_preserves_exact_execution_evidence() {
            // Inject a cursor-read failure after two previously successful actions.
            // The first one was a native input route and the second launched an app.
            let launch = json!({"app":"owned.exe","status":"launch_requested"});
            let reply = completed_action_reply(
                vec!["sendinput".into(), "shell".into()],
                vec![launch.clone()],
                41,
                Err(fail("INPUT_FAILED", "cursor unavailable")),
            );
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["error_code"], "INPUT_FAILED");
            assert_eq!(reply["completed_count"], 2);
            assert_eq!(reply["routes"], json!(["sendinput", "shell"]));
            assert_eq!(reply["launches"], json!([launch]));
            assert_eq!(reply["foreground"], 41);
            assert!(reply.get("failed_index").is_none());
            assert!(reply.get("cursor").is_none());

            let successful = completed_action_reply(
                vec!["sendinput".into()],
                Vec::new(),
                41,
                Ok(json!({"x":10,"y":20})),
            );
            assert_eq!(successful["ok"], true);
            assert_eq!(successful["completed_count"], 1);
            assert_eq!(successful["cursor"], json!({"x":10,"y":20}));
        }
        #[test]
        fn display_change_during_capture_never_publishes_old_pixels_as_a_new_frame() {
            let original = json!([
                {"x":0,"y":0,"width":960,"height":1080},
                {"x":960,"y":0,"width":960,"height":1080}
            ]);
            let rearranged = json!([
                {"x":0,"y":0,"width":1920,"height":540},
                {"x":0,"y":540,"width":1920,"height":540}
            ]);
            // Both layouts have identical outer virtual geometry. A bounding-box
            // equality check cannot distinguish which monitor contains each pixel.
            let mut readings = vec![original.clone(), rearranged].into_iter();
            let request = json!({"region":{"x":10,"y":10,"width":100,"height":80}});
            let captured = || Ok(json!({"captureMode":"screen","region":request["region"]}));
            assert_eq!(
                capture_with_topology_using(
                    &request,
                    None,
                    || Ok(readings.next().unwrap_or(Value::Null)),
                    |_, _| captured(),
                )
                .unwrap_err()
                .code,
                "STALE_FRAME"
            );
            let mut reads = 0;
            let stable = capture_with_topology_using(
                &request,
                None,
                || {
                    reads += 1;
                    Ok(original.clone())
                },
                |_, _| captured(),
            )
            .unwrap();
            assert_eq!(reads, 2);
            assert_eq!(stable["displays"], original);

            // A named HWND capture remains window-scoped, not screen-bound.
            let window = capture_with_topology_using(
                &json!({"id":51}),
                Some(51),
                || panic!("window capture must not ask for screen topology"),
                |_, _| Ok(json!({"captureMode":"window","region":request["region"]})),
            )
            .unwrap();
            assert!(window.get("displays").is_none());
        }

        #[test]
        fn stale_screen_display_layout_refuses_before_a_pointer_effect() {
            let virtual_screen = json!({"x":0,"y":0,"width":1920,"height":1080});
            let original = json!([
                {"x":0,"y":0,"width":960,"height":1080},
                {"x":960,"y":0,"width":960,"height":1080}
            ]);
            let rearranged = json!([
                {"x":0,"y":0,"width":1920,"height":540},
                {"x":0,"y":540,"width":1920,"height":540}
            ]);
            let frame = json!({
                "window":null,
                "region":{"x":100,"y":200,"width":100,"height":80},
                "displays":original
            });
            let mut injected = 0usize;
            let result = (|| -> Result<()> {
                assert_screen_frame(&frame, &virtual_screen, &rearranged)?;
                injected += 1; // models the subsequent pointer effect in one_action
                Ok(())
            })();
            assert_eq!(result.unwrap_err().code, "STALE_FRAME");
            assert_eq!(injected, 0);

            let unchanged = frame["displays"].clone();
            assert!(assert_screen_frame(&frame, &virtual_screen, &unchanged).is_ok());
            assert_eq!(
                assert_screen_frame(
                    &json!({"region":frame["region"],"displays":null}),
                    &virtual_screen,
                    &unchanged,
                )
                .unwrap_err()
                .code,
                "STALE_FRAME"
            );
            let outside = json!({
                "region":{"x":1900,"y":0,"width":100,"height":80},
                "displays":unchanged
            });
            assert_eq!(
                assert_screen_frame(&outside, &virtual_screen, &unchanged)
                    .unwrap_err()
                    .code,
                "STALE_FRAME"
            );
        }
        #[test]
        fn invalid_action_counts_refuse_before_side_effect() {
            assert!(click_count(&json!({"count":0})).is_err());
            assert!(click_count(&json!({"count":4})).is_err());
            assert_eq!(click_count(&json!({})).ok(), Some(1));
        }
        #[test]
        fn malformed_regions_fail_closed() {
            assert!(integer(&json!({"x":"1"}), "x").is_err());
            assert!(coordinate_array(&json!({"xs":[1,"x"]}), "xs").is_err());
        }
        #[test]
        fn snapshot_keeps_complete_window_metadata_after_ui_observation() {
            let mut snapshot = json!({
                "ok":true,
                "window":{"id":73,"title":"Selected window","app":"example.exe"}
            });
            merge_snapshot_ui(
                &mut snapshot,
                json!({
                    "window":73,"snapshotId":5,
                    "elements":[{"runtimeKey":"button"}],
                    "visited":1,"truncated":false
                }),
            );
            assert_eq!(snapshot["window"]["id"], 73);
            assert_eq!(snapshot["window"]["title"], "Selected window");
            assert_eq!(snapshot["snapshotId"], 5);
            assert_eq!(snapshot["elements"][0]["runtimeKey"], "button");
        }
    }
}
