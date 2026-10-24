//! Drives a running cos-app from outside through UI Automation, the way the Desktop surface
//! sees any window: `cos-windows-uia` reads the tree and performs Invoke, Toggle, Select,
//! Expand, Collapse, Focus and Value actions, and `cos-windows-capture` takes WGC screenshots.
//! Every command first proves that the window it touches belongs to `--pid`. A physical click is
//! never sent. A key goes out only while the foreground window belongs to `--pid` at that
//! instant (standing order 16). Each command prints one JSON object and exits 0, or prints
//! `{"ok":false,"error":...}` and exits 1. See `tools/README.md`.

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    driver::main()
}

#[cfg(not(windows))]
fn main() -> std::process::ExitCode {
    eprintln!("ui-driver drives Windows UI Automation only");
    std::process::ExitCode::from(2)
}

#[cfg(windows)]
mod driver {
    use std::process::ExitCode;
    use std::time::{Duration, Instant};

    use cos_sidecar_runtime::DesktopError;
    use cos_windows_uia::{UiaAvailability, UiaInputHost};
    use serde_json::{Value, json};
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
    use windows::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
        VIRTUAL_KEY, VK_ESCAPE, VK_F11, VK_RETURN, VK_TAB,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible,
    };
    use windows::core::BOOL;

    const USAGE: &str = "usage: ui-driver --pid <pid> <command>
  windows                         the pid's top-level windows and whether one is in front
  tree [--query <q>] [--role <r>] UIA elements of the pid's visible windows (at most 100 each)
  act <action> <id>               invoke|toggle|select|expand|collapse|focus|scroll_into_view
                                  on the element whose AutomationId (else Name) is <id>
  set-value <id> <text>           ValuePattern.SetValue on that element
  wait <id> [--name <text>] [--timeout <ms>]
                                  until that element exists (and its Name contains <text>)
  shot <file.png> [--window <hwnd>]
                                  WGC capture of the pid's main window (or <hwnd>)
  key f11|tab|enter|escape        one key press, only while the pid's window is in front";

    pub fn main() -> ExitCode {
        // SAFETY: process-wide setting with a constant argument; failure leaves the default.
        let _ =
            unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        let args: Vec<String> = std::env::args().skip(1).collect();
        match run(&args) {
            Ok(value) => {
                println!("{value}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                println!(
                    "{}",
                    json!({"ok": false, "error": {"code": error.code, "message": error.message}})
                );
                ExitCode::FAILURE
            }
        }
    }

    fn refuse(code: &'static str, message: impl Into<String>) -> DesktopError {
        DesktopError::new(code, message)
    }

    fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|at| args.get(at + 1))
            .map(String::as_str)
    }

    fn positional(args: &[String]) -> Vec<&str> {
        let mut out = Vec::new();
        let mut skip = false;
        for arg in args {
            if skip {
                skip = false;
            } else if arg.starts_with("--") {
                skip = true;
            } else {
                out.push(arg.as_str());
            }
        }
        out
    }

    fn run(args: &[String]) -> Result<Value, DesktopError> {
        let pid: u32 = flag(args, "--pid")
            .and_then(|pid| pid.parse().ok())
            .filter(|pid| *pid > 0)
            .ok_or_else(|| refuse("BAD_REQUEST", USAGE))?;
        let words = positional(args);
        let Some((command, rest)) = words.split_first() else {
            return Err(refuse("BAD_REQUEST", USAGE));
        };
        match (*command, rest) {
            ("windows", []) => Ok(windows_of(pid)),
            ("tree", []) => tree(pid, flag(args, "--query"), flag(args, "--role")),
            ("act", [action, id]) => act(pid, action, id, None),
            ("set-value", [id, text]) => act(pid, "set_value", id, Some(text)),
            ("wait", [id]) => {
                let timeout = flag(args, "--timeout")
                    .and_then(|ms| ms.parse().ok())
                    .unwrap_or(5_000);
                wait(
                    pid,
                    id,
                    flag(args, "--name"),
                    Duration::from_millis(timeout),
                )
            }
            ("shot", [file]) => shot(pid, file, flag(args, "--window")),
            ("key", [name]) => key(pid, name),
            _ => Err(refuse("BAD_REQUEST", USAGE)),
        }
    }

    #[derive(Clone)]
    struct Window {
        hwnd: i64,
        class: String,
        title: String,
        visible: bool,
        rect: [i32; 4],
    }

    fn hwnd(value: i64) -> HWND {
        HWND(value as isize as *mut std::ffi::c_void)
    }

    fn owner(window: i64) -> u32 {
        let mut pid = 0u32;
        // SAFETY: reads the owner of a window handle; a stale handle yields 0.
        unsafe { GetWindowThreadProcessId(hwnd(window), Some(&mut pid)) };
        pid
    }

    fn text(read: impl FnOnce(&mut [u16]) -> i32) -> String {
        let mut buffer = [0u16; 256];
        let length = read(&mut buffer).clamp(0, 256) as usize;
        String::from_utf16_lossy(&buffer[..length])
    }

    /// Every top-level window owned by `pid`. No other window's title or class is read.
    fn windows(pid: u32) -> Vec<Window> {
        unsafe extern "system" fn collect(window: HWND, found: LPARAM) -> BOOL {
            // SAFETY: `found` is the `&mut Vec<i64>` that `windows` passes for this call only.
            let found = unsafe { &mut *(found.0 as *mut Vec<i64>) };
            found.push(window.0 as isize as i64);
            BOOL(1)
        }
        let mut all: Vec<i64> = Vec::new();
        // SAFETY: the callback only pushes into `all`, which outlives the enumeration.
        let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<i64> as isize)) };
        all.into_iter()
            .filter(|window| owner(*window) == pid)
            .map(|window| {
                let mut rect = RECT::default();
                // SAFETY: plain reads of a window this pid owns, into local buffers.
                let (class, title, visible) = unsafe {
                    let _ = GetWindowRect(hwnd(window), &mut rect);
                    (
                        text(|buffer| GetClassNameW(hwnd(window), buffer)),
                        text(|buffer| GetWindowTextW(hwnd(window), buffer)),
                        IsWindowVisible(hwnd(window)).as_bool(),
                    )
                };
                Window {
                    hwnd: window,
                    class,
                    title,
                    visible,
                    rect: [rect.left, rect.top, rect.right, rect.bottom],
                }
            })
            .collect()
    }

    fn foreground_is(pid: u32) -> bool {
        // SAFETY: reads the foreground window handle.
        let front = unsafe { GetForegroundWindow() };
        !front.is_invalid() && owner(front.0 as isize as i64) == pid
    }

    fn windows_of(pid: u32) -> Value {
        let list: Vec<Value> = windows(pid)
            .iter()
            .map(|window| {
                json!({"hwnd": window.hwnd, "class": window.class, "title": window.title,
                       "visible": window.visible, "rect": window.rect})
            })
            .collect();
        json!({"ok": true, "pid": pid, "windows": list, "foregroundIsOurs": foreground_is(pid)})
    }

    fn visible(pid: u32) -> Vec<Window> {
        windows(pid)
            .into_iter()
            .filter(|window| window.visible)
            .collect()
    }

    fn uia() -> Result<UiaAvailability, DesktopError> {
        let uia = UiaAvailability::new();
        uia.ensure_available()?;
        Ok(uia)
    }

    fn find(
        pid: u32,
        uia: &mut UiaAvailability,
        window: &Window,
        query: Option<&str>,
        role: Option<&str>,
    ) -> Result<Value, DesktopError> {
        let mut request = json!({"window": window.hwnd, "maxResults": 100, "maxVisited": 10_000});
        if let Some(query) = query {
            request["query"] = json!(query);
        }
        if let Some(role) = role {
            request["role"] = json!(role);
        }
        let found = uia.find(&request)?;
        if owner(window.hwnd) != pid {
            return Err(refuse(
                "NOT_OURS",
                "the window changed owner while it was read",
            ));
        }
        Ok(found)
    }

    fn tree(pid: u32, query: Option<&str>, role: Option<&str>) -> Result<Value, DesktopError> {
        let mut uia = uia()?;
        let mut out = Vec::new();
        for window in visible(pid) {
            let found = find(pid, &mut uia, &window, query, role)?;
            out.push(
                json!({"hwnd": window.hwnd, "class": window.class, "title": window.title,
                            "elements": found["elements"], "truncated": found["truncated"]}),
            );
        }
        Ok(json!({"ok": true, "pid": pid, "windows": out}))
    }

    /// The element whose AutomationId is `id`, else the one whose Name is `id`, in any visible
    /// window of `pid`, with the snapshot that names it.
    fn locate(
        uia: &mut UiaAvailability,
        pid: u32,
        id: &str,
    ) -> Result<Option<(Window, u64, Value)>, DesktopError> {
        for window in visible(pid) {
            let found = find(pid, uia, &window, Some(id), None)?;
            let elements = found["elements"].as_array().cloned().unwrap_or_default();
            let exact = |field: &str| {
                elements
                    .iter()
                    .find(|element| element[field] == id)
                    .cloned()
            };
            if let Some(element) = exact("automationId").or_else(|| exact("name")) {
                let snapshot = found["snapshotId"].as_u64().unwrap_or(0);
                return Ok(Some((window, snapshot, element)));
            }
        }
        Ok(None)
    }

    /// Lets `cos-windows-uia` act only on a window `pid` still owns, and never sends a click.
    struct OurWindows {
        pid: u32,
    }

    impl UiaInputHost for OurWindows {
        fn assert_input_owner(&mut self, request: &Value) -> Result<(), DesktopError> {
            let window = request["window"].as_i64().unwrap_or(0);
            if window > 0 && owner(window) == self.pid {
                Ok(())
            } else {
                Err(refuse(
                    "NOT_OURS",
                    format!("window {window} is not owned by pid {}", self.pid),
                ))
            }
        }

        fn assert_focused(&mut self, _window: i64) -> Result<(), DesktopError> {
            if foreground_is(self.pid) {
                Ok(())
            } else {
                Err(refuse(
                    "NOT_FOREGROUND",
                    "the foreground window is not ours",
                ))
            }
        }

        fn click(&mut self, _x: i32, _y: i32, _: &str, _: u32) -> Result<(), DesktopError> {
            Err(refuse(
                "PHYSICAL_INPUT_REFUSED",
                "the element has no Invoke, Toggle or SelectionItem pattern; the driver sends no clicks",
            ))
        }
    }

    fn act(pid: u32, action: &str, id: &str, value: Option<&str>) -> Result<Value, DesktopError> {
        let mut uia = uia()?;
        let (window, snapshot, element) = locate(&mut uia, pid, id)?
            .ok_or_else(|| refuse("NOT_FOUND", format!("no element '{id}' in pid {pid}")))?;
        let mut request = json!({"window": window.hwnd, "snapshotId": snapshot,
                                 "runtimeKey": element["runtimeKey"], "action": action});
        if let Some(value) = value {
            request["value"] = json!(value);
        }
        let done = uia.act(&request, &mut OurWindows { pid })?;
        Ok(json!({"ok": true, "action": action, "element": element, "result": done}))
    }

    fn wait(
        pid: u32,
        id: &str,
        name: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, DesktopError> {
        let mut uia = uia()?;
        let started = Instant::now();
        loop {
            if let Some((window, _, element)) = locate(&mut uia, pid, id)?
                && name.is_none_or(|name| element["name"].as_str().unwrap_or("").contains(name))
            {
                let waited = started.elapsed().as_millis() as u64;
                return Ok(
                    json!({"ok": true, "hwnd": window.hwnd, "element": element, "waitedMs": waited}),
                );
            }
            if started.elapsed() >= timeout {
                return Err(refuse(
                    "TIMEOUT",
                    format!(
                        "no element '{id}'{} after {} ms",
                        name.map(|n| format!(" named like '{n}'"))
                            .unwrap_or_default(),
                        timeout.as_millis()
                    ),
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn shot(pid: u32, file: &str, window: Option<&str>) -> Result<Value, DesktopError> {
        // The capture balances its own RoInitialize when it returns, which drops the last WinRT
        // apartment of this thread while the frame pool still releases objects on its own
        // threads; about one capture in four then crashed the driver. This apartment lives until
        // the process exits.
        // SAFETY: initializes WinRT on this thread once and is never balanced on purpose.
        let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
        let target = match window {
            Some(hwnd) => hwnd
                .parse::<i64>()
                .ok()
                .filter(|hwnd| owner(*hwnd) == pid)
                .ok_or_else(|| {
                    refuse(
                        "NOT_OURS",
                        format!("window {hwnd} is not owned by pid {pid}"),
                    )
                })?,
            None => visible(pid)
                .into_iter()
                .find(|window| window.class == "Zed::Window")
                .map(|window| window.hwnd)
                .ok_or_else(|| refuse("NOT_FOUND", format!("pid {pid} shows no main window")))?,
        };
        let captured = cos_windows_capture::capture(&json!({"id": target}), None)?;
        if owner(target) != pid {
            return Err(refuse(
                "NOT_OURS",
                "the window changed owner during the capture",
            ));
        }
        std::fs::write(file, &captured.png)
            .map_err(|error| refuse("WRITE_FAILED", format!("{file}: {error}")))?;
        Ok(
            json!({"ok": true, "file": file, "hwnd": target, "bytes": captured.png.len(), "capture": captured.fields}),
        )
    }

    fn key(pid: u32, name: &str) -> Result<Value, DesktopError> {
        let key: VIRTUAL_KEY = match name {
            "f11" => VK_F11,
            "tab" => VK_TAB,
            "enter" => VK_RETURN,
            "escape" => VK_ESCAPE,
            _ => return Err(refuse("BAD_REQUEST", format!("unknown key {name}"))),
        };
        let press = |flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        let inputs = [press(KEYBD_EVENT_FLAGS(0)), press(KEYEVENTF_KEYUP)];
        if !foreground_is(pid) {
            return Err(refuse(
                "NOT_FOREGROUND",
                format!("the foreground window is not owned by pid {pid}; no key was sent"),
            ));
        }
        // SAFETY: two keyboard events from a local array, sent only after the foreground window
        // was proven to belong to `pid` on the line above.
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        Ok(json!({"ok": true, "key": name, "sent": sent}))
    }
}
