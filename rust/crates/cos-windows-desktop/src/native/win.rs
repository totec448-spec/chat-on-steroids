//! The single native window identity and input-target authority of the desktop thread.
//! Win32 calls are isolated here so tests can exercise the decisions independently of input.
use super::policy;
use cos_sidecar_runtime::DesktopError;
use serde_json::{Value, json};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId as sdk_app_id;
use windows::Win32::System::Threading::{
    AttachThreadInput as sdk_attach, GetCurrentThreadId as sdk_self_thread,
    OpenProcess as sdk_open_process, PROCESS_ACCESS_RIGHTS, PROCESS_NAME_FORMAT,
    QueryFullProcessImageNameW as sdk_query_process,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT, GetDpiForWindow as sdk_window_dpi,
    SetThreadDpiAwarenessContext as sdk_set_dpi,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardLayout as sdk_get_layout, HKL, VkKeyScanExW as sdk_vk_scan,
};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
use windows::Win32::UI::WindowsAndMessaging as native;
use windows::core::{BOOL, BSTR, PWSTR};

pub(crate) type Handle = isize;
pub(crate) type Result<T> = std::result::Result<T, DesktopError>;

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(self) -> i32 {
        self.right.saturating_sub(self.left)
    }
    pub fn height(self) -> i32 {
        self.bottom.saturating_sub(self.top)
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(crate) struct Point {
    pub x: i32,
    pub y: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(crate) struct GuiThreadInfo {
    pub size: u32,
    pub flags: u32,
    pub active: Handle,
    pub focus: Handle,
    pub capture: Handle,
    pub menu_owner: Handle,
    pub move_size: Handle,
    pub caret: Handle,
    pub caret_rect: Rect,
}

// Narrow wrappers normalize the generated windows=0.62.2 Win32 SDK signatures.
// Keeping these adapters local preserves reviewable native error handling without
// hand-maintaining C declarations or duplicating platform layouts.
#[allow(non_snake_case)]
unsafe fn IsWindow(window: Handle) -> i32 {
    unsafe { native::IsWindow(Some(HWND(window as *mut _))).0 }
}
#[allow(non_snake_case)]
unsafe fn IsWindowVisible(window: Handle) -> i32 {
    unsafe { native::IsWindowVisible(HWND(window as *mut _)).0 }
}
#[allow(non_snake_case)]
unsafe fn IsIconic(window: Handle) -> i32 {
    unsafe { native::IsIconic(HWND(window as *mut _)).0 }
}
#[allow(non_snake_case)]
unsafe fn GetWindowTextLengthW(window: Handle) -> i32 {
    unsafe { native::GetWindowTextLengthW(HWND(window as *mut _)) }
}
#[allow(non_snake_case)]
unsafe fn GetWindowTextW(window: Handle, text: *mut u16, len: i32) -> i32 {
    if len <= 0 {
        return 0;
    }
    unsafe {
        native::GetWindowTextW(
            HWND(window as *mut _),
            std::slice::from_raw_parts_mut(text, len as usize),
        )
    }
}
#[allow(non_snake_case)]
unsafe fn GetWindowRect(window: Handle, out: *mut Rect) -> i32 {
    let mut sdk = RECT::default();
    if unsafe { native::GetWindowRect(HWND(window as *mut _), &mut sdk) }.is_err() {
        return 0;
    }
    // SAFETY: caller supplies a live initialized Rect stack slot.
    unsafe {
        *out = Rect {
            left: sdk.left,
            top: sdk.top,
            right: sdk.right,
            bottom: sdk.bottom,
        };
    }
    1
}
#[allow(non_snake_case)]
unsafe fn GetWindowThreadProcessId(window: Handle, pid: *mut u32) -> u32 {
    unsafe { native::GetWindowThreadProcessId(HWND(window as *mut _), Some(pid)) }
}
#[allow(non_snake_case)]
unsafe fn GetWindowLongW(window: Handle, index: i32) -> i32 {
    unsafe { native::GetWindowLongW(HWND(window as *mut _), native::WINDOW_LONG_PTR_INDEX(index)) }
}
#[allow(non_snake_case)]
unsafe fn GetForegroundWindow() -> Handle {
    unsafe { native::GetForegroundWindow().0 as Handle }
}
#[allow(non_snake_case)]
unsafe fn GetWindow(window: Handle, command: u32) -> Handle {
    unsafe { native::GetWindow(HWND(window as *mut _), native::GET_WINDOW_CMD(command)) }
        .map_or(0, |hwnd| hwnd.0 as Handle)
}
#[allow(non_snake_case)]
unsafe fn GetAncestor(window: Handle, flags: u32) -> Handle {
    unsafe { native::GetAncestor(HWND(window as *mut _), native::GET_ANCESTOR_FLAGS(flags)) }.0
        as Handle
}
#[allow(non_snake_case)]
unsafe fn GetClassNameW(window: Handle, name: *mut u16, len: i32) -> i32 {
    if len <= 0 {
        return 0;
    }
    unsafe {
        native::GetClassNameW(
            HWND(window as *mut _),
            std::slice::from_raw_parts_mut(name, len as usize),
        )
    }
}
#[allow(non_snake_case)]
unsafe fn GetGUIThreadInfo(thread: u32, out: *mut GuiThreadInfo) -> i32 {
    let mut sdk = native::GUITHREADINFO {
        cbSize: std::mem::size_of::<native::GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { native::GetGUIThreadInfo(thread, &mut sdk) }.is_err() {
        return 0;
    }
    unsafe {
        *out = GuiThreadInfo {
            size: sdk.cbSize,
            flags: sdk.flags.0,
            active: sdk.hwndActive.0 as Handle,
            focus: sdk.hwndFocus.0 as Handle,
            capture: sdk.hwndCapture.0 as Handle,
            menu_owner: sdk.hwndMenuOwner.0 as Handle,
            move_size: sdk.hwndMoveSize.0 as Handle,
            caret: sdk.hwndCaret.0 as Handle,
            caret_rect: Rect {
                left: sdk.rcCaret.left,
                top: sdk.rcCaret.top,
                right: sdk.rcCaret.right,
                bottom: sdk.rcCaret.bottom,
            },
        }
    }
    1
}
#[allow(non_snake_case)]
unsafe fn SetForegroundWindow(window: Handle) -> i32 {
    unsafe { native::SetForegroundWindow(HWND(window as *mut _)).0 }
}
#[allow(non_snake_case)]
unsafe fn ShowWindow(window: Handle, command: i32) -> i32 {
    unsafe { native::ShowWindow(HWND(window as *mut _), native::SHOW_WINDOW_CMD(command)).0 }
}
#[allow(non_snake_case)]
unsafe fn AttachThreadInput(from: u32, to: u32, attach: i32) -> i32 {
    unsafe { sdk_attach(from, to, attach != 0).0 }
}
#[allow(non_snake_case)]
unsafe fn GetDpiForWindow(window: Handle) -> u32 {
    unsafe { sdk_window_dpi(HWND(window as *mut _)) }
}
#[allow(non_snake_case)]
unsafe fn GetSystemMetrics(index: i32) -> i32 {
    unsafe { native::GetSystemMetrics(native::SYSTEM_METRICS_INDEX(index)) }
}
#[allow(non_snake_case)]
unsafe fn GetCursorPos(out: *mut Point) -> i32 {
    let mut sdk = POINT::default();
    if unsafe { native::GetCursorPos(&mut sdk) }.is_err() {
        return 0;
    }
    unsafe { *out = Point { x: sdk.x, y: sdk.y } };
    1
}
#[allow(non_snake_case)]
unsafe fn SetThreadDpiAwarenessContext(context: Handle) -> Handle {
    unsafe { sdk_set_dpi(DPI_AWARENESS_CONTEXT(context as *mut _)).0 as Handle }
}
#[allow(non_snake_case)]
unsafe fn GetKeyboardLayout(thread: u32) -> Handle {
    unsafe { sdk_get_layout(thread).0 as Handle }
}
#[allow(non_snake_case)]
unsafe fn VkKeyScanExW(ch: u16, layout: Handle) -> i16 {
    unsafe { sdk_vk_scan(ch, HKL(layout as *mut _)) }
}
#[allow(non_snake_case)]
unsafe fn GetCurrentThreadId() -> u32 {
    unsafe { sdk_self_thread() }
}
#[allow(non_snake_case)]
unsafe fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle {
    unsafe { sdk_open_process(PROCESS_ACCESS_RIGHTS(access), inherit != 0, pid) }
        .map_or(0, |process| process.0 as Handle)
}
#[allow(non_snake_case)]
unsafe fn CloseHandle(handle: Handle) -> i32 {
    i32::from(unsafe { windows::Win32::Foundation::CloseHandle(HANDLE(handle as *mut _)) }.is_ok())
}
#[allow(non_snake_case)]
unsafe fn QueryFullProcessImageNameW(
    handle: Handle,
    flags: u32,
    buf: *mut u16,
    len: *mut u32,
) -> i32 {
    i32::from(
        unsafe {
            sdk_query_process(
                HANDLE(handle as *mut _),
                PROCESS_NAME_FORMAT(flags),
                PWSTR(buf),
                len,
            )
        }
        .is_ok(),
    )
}
#[allow(non_snake_case)]
unsafe fn GetApplicationUserModelId(handle: Handle, len: *mut u32, buf: *mut u16) -> i32 {
    unsafe { sdk_app_id(HANDLE(handle as *mut _), len, Some(PWSTR(buf))).0 as i32 }
}
struct EnumCall {
    callback: unsafe extern "system" fn(Handle, isize) -> i32,
    payload: isize,
}
unsafe extern "system" fn sdk_enum_callback(hwnd: HWND, payload: LPARAM) -> BOOL {
    let context = unsafe { &*(payload.0 as *const EnumCall) };
    BOOL(unsafe { (context.callback)(hwnd.0 as Handle, context.payload) })
}
#[allow(non_snake_case)]
unsafe fn EnumWindows(
    callback: unsafe extern "system" fn(Handle, isize) -> i32,
    payload: isize,
) -> i32 {
    let state = EnumCall { callback, payload };
    i32::from(
        unsafe {
            native::EnumWindows(Some(sdk_enum_callback), LPARAM((&raw const state) as isize))
        }
        .is_ok(),
    )
}

pub(crate) fn fail(code: &'static str, message: impl Into<String>) -> DesktopError {
    DesktopError::new(code, message.into())
}

pub(crate) fn setup_dpi() -> Result<()> {
    // SAFETY: -4 is DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, a documented pseudo handle.
    if unsafe { SetThreadDpiAwarenessContext(-4) } == 0 {
        return Err(fail(
            "DPI_AWARENESS_FAILED",
            "cannot establish per-monitor physical coordinates",
        ));
    }
    Ok(())
}

pub(crate) fn screen() -> Value {
    // SAFETY: GetSystemMetrics accepts fixed documented indexes and has no pointer arguments.
    unsafe {
        json!({
          "virtual":{"x": GetSystemMetrics(76), "y": GetSystemMetrics(77),
            "width": GetSystemMetrics(78), "height": GetSystemMetrics(79)},
          "primary":{"x":0,"y":0,"width":GetSystemMetrics(0),"height":GetSystemMetrics(1)}
        })
    }
}

/// Physical rectangles of the currently active displays, sampled from Windows
/// rather than inferred from the virtual desktop's outer bounding rectangle.
/// No display inventory is cached: a screen frame must carry its own snapshot.
pub(crate) fn display_topology() -> Result<Value> {
    struct Monitors {
        rectangles: Vec<(i32, i32, i32, i32)>,
        invalid: bool,
    }
    unsafe extern "system" fn collect(
        monitor: HMONITOR,
        _hdc: HDC,
        _area: *mut RECT,
        data: LPARAM,
    ) -> windows::core::BOOL {
        // SAFETY: EnumDisplayMonitors invokes this callback synchronously. The
        // payload points to this call's stack-local Monitors until enumeration ends.
        let collected = unsafe { &mut *(data.0 as *mut Monitors) };
        if collected.rectangles.len() >= 32 {
            collected.invalid = true;
            return windows::core::BOOL(0);
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: a live enumeration-supplied monitor handle and an initialized
        // native MONITORINFO output structure with the documented cbSize.
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            collected.invalid = true;
            return windows::core::BOOL(0);
        }
        let rect = info.rcMonitor;
        let (width, height) = (
            i64::from(rect.right) - i64::from(rect.left),
            i64::from(rect.bottom) - i64::from(rect.top),
        );
        if !(1..=i64::from(i32::MAX)).contains(&width)
            || !(1..=i64::from(i32::MAX)).contains(&height)
        {
            collected.invalid = true;
            return windows::core::BOOL(0);
        }
        collected
            .rectangles
            .push((rect.left, rect.top, width as i32, height as i32));
        windows::core::BOOL(1)
    }
    let mut monitors = Monitors {
        rectangles: Vec::new(),
        invalid: false,
    };
    // SAFETY: callback does not retain the stack pointer and the Win32 API
    // finishes the synchronous enumeration before this method returns.
    let success = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect),
            LPARAM((&raw mut monitors) as isize),
        )
    };
    if !success.as_bool() || monitors.invalid || monitors.rectangles.is_empty() {
        return Err(fail(
            "STALE_FRAME",
            "could not observe the active display topology",
        ));
    }
    // Enumeration order is not a screen identity; compare the sorted rectangles.
    monitors.rectangles.sort_unstable();
    Ok(Value::Array(
        monitors
            .rectangles
            .into_iter()
            .map(|(x, y, width, height)| json!({"x":x,"y":y,"width":width,"height":height}))
            .collect(),
    ))
}

pub(crate) fn foreground() -> i64 {
    // SAFETY: GetForegroundWindow takes no arguments.
    unsafe { GetForegroundWindow() as i64 }
}

pub(crate) fn is_window(id: i64) -> bool {
    // SAFETY: IsWindow safely validates arbitrary HWND values.
    unsafe { IsWindow(id as Handle) != 0 }
}

pub(crate) fn visible(id: i64) -> bool {
    // SAFETY: IsWindowVisible/IsIconic are query APIs accepting arbitrary HWND values.
    unsafe { IsWindowVisible(id as Handle) != 0 && IsIconic(id as Handle) == 0 }
}

pub(crate) fn rect(id: i64) -> Option<Rect> {
    let mut r = Rect::default();
    // SAFETY: GetWindowRect writes exactly one native RECT into an initialized stack slot.
    if unsafe { GetWindowRect(id as Handle, &mut r) } != 0 && r.width() > 0 && r.height() > 0 {
        Some(r)
    } else {
        None
    }
}

pub(crate) fn cursor() -> Result<Value> {
    let mut p = Point::default();
    // SAFETY: GetCursorPos writes exactly one POINT.
    if unsafe { GetCursorPos(&mut p) } == 0 {
        return Err(fail("INPUT_FAILED", "could not read cursor position"));
    }
    Ok(json!({"x":p.x,"y":p.y}))
}

pub(crate) fn system_metric(index: i32) -> i32 {
    // SAFETY: fixed Windows system metric indexes are safe to query.
    unsafe { GetSystemMetrics(index) }
}

fn window_text(window: Handle) -> String {
    // SAFETY: each user32 call uses a live HWND query; allocation is bounded and writable.
    let len = unsafe { GetWindowTextLengthW(window) }.clamp(0, 2048);
    let mut buf = vec![0u16; (len + 1) as usize];
    let count = unsafe { GetWindowTextW(window, buf.as_mut_ptr(), len + 1) };
    String::from_utf16_lossy(&buf[..count.max(0) as usize]).replace('\u{001f}', " ")
}

fn window_class(window: Handle) -> String {
    let mut buf = vec![0u16; 256];
    // SAFETY: fixed writable 256-code-unit buffer.
    let count = unsafe { GetClassNameW(window, buf.as_mut_ptr(), 256) };
    String::from_utf16_lossy(&buf[..count.max(0) as usize])
}

fn thread_pid(window: Handle) -> (u32, u32) {
    let mut pid = 0;
    // SAFETY: out pointer lives for the duration of the call.
    let thread = unsafe { GetWindowThreadProcessId(window, &mut pid) };
    (thread, pid)
}

fn window_model_id(window: Handle) -> Option<String> {
    // The window property overrides the host process AUMID (taskbar grouping,
    // multi-app hosts and ApplicationFrameHost.exe). A process-only lookup
    // misattributes a UWP window even if its process path is correct.
    let store: IPropertyStore =
        unsafe { SHGetPropertyStoreForWindow(HWND(window as *mut _)) }.ok()?;
    let value = unsafe { store.GetValue(&PKEY_AppUserModel_ID) }.ok()?;
    let id: BSTR = BSTR::try_from(&value).ok()?;
    let id = id.to_string();
    if id.is_empty() || id.chars().count() > 2048 || id.contains(['\0', '\u{001f}']) {
        return None;
    }
    Some(id)
}

pub(crate) fn process_identity(window: Handle, pid: u32) -> (String, String) {
    let explicit_id = window_model_id(window);
    // SAFETY: limited-query process handle is closed on every successful open.
    let handle = unsafe { OpenProcess(0x1000, 0, pid) };
    if handle == 0 {
        return (String::new(), String::new());
    }
    let mut path = String::new();
    let mut app_id = explicit_id.unwrap_or_default();
    let mut buf = vec![0u16; 32_768];
    let mut len = buf.len() as u32;
    // SAFETY: native functions only write within the passed buffer capacity.
    if unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) } != 0
        && len <= buf.len() as u32
    {
        path = String::from_utf16_lossy(&buf[..len as usize]);
    }
    let mut aid = vec![0u16; 2048];
    len = aid.len() as u32;
    // SAFETY: GetApplicationUserModelId receives a correctly sized writable UTF-16 buffer.
    if app_id.is_empty()
        && unsafe { GetApplicationUserModelId(handle, &mut len, aid.as_mut_ptr()) } == 0
        && len <= aid.len() as u32
    {
        let end = aid[..len as usize]
            .iter()
            .position(|x| *x == 0)
            .unwrap_or(len as usize);
        app_id = String::from_utf16_lossy(&aid[..end]);
    }
    // SAFETY: valid owned handle.
    unsafe {
        CloseHandle(handle);
    }
    if path.chars().count() > 2048 || path.contains('\u{001f}') {
        path.clear();
    }
    if app_id.chars().count() > 2048 || app_id.contains('\u{001f}') {
        app_id.clear();
    }
    (path, app_id)
}

pub(crate) fn window_row(id: i64) -> Option<Value> {
    if !is_window(id) {
        return None;
    }
    // SAFETY: Window API functions safely reject stale handles.
    if unsafe { IsWindowVisible(id as Handle) } == 0 {
        return None;
    }
    let bounds = rect(id)?;
    let (_, pid) = thread_pid(id as Handle);
    if policy::current().hidden_pid == Some(pid) {
        return None;
    }
    let (process_path, app_id) = process_identity(id as Handle, pid);
    let app = if app_id.is_empty() {
        process_path.to_lowercase()
    } else {
        app_id.clone()
    };
    if app.is_empty() {
        return None;
    }
    let dpi = unsafe { GetDpiForWindow(id as Handle) };
    if dpi == 0 {
        return None;
    }
    let process = Path::new(&process_path)
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let state = if unsafe { IsIconic(id as Handle) } != 0 {
        "minimized"
    } else if foreground() == id {
        "foreground"
    } else {
        "open"
    };
    Some(json!({
        "id":id,"title":window_text(id as Handle),"process":process,
        "processId":pid,"processPath":process_path,"appUserModelId":app_id,
        "app":app,"dpi":dpi,"x":bounds.left,"y":bounds.top,
        "width":bounds.width(),"height":bounds.height(),"state":state
    }))
}

unsafe extern "system" fn collect_windows(id: Handle, userdata: isize) -> i32 {
    // SAFETY: called synchronously by EnumWindows; userdata is the Vec pointer passed by us.
    let rows = unsafe { &mut *(userdata as *mut Vec<i64>) };
    let visible = unsafe { IsWindowVisible(id) } != 0;
    let title = unsafe { GetWindowTextLengthW(id) } > 0;
    let tool = unsafe { GetWindowLongW(id, -20) } & 0x80 != 0;
    if visible && title && !tool {
        rows.push(id as i64);
    }
    1
}

unsafe extern "system" fn collect_visible_windows(id: Handle, userdata: isize) -> i32 {
    // Related windows may be untitled menus and tool windows. The exact owner
    // chain below supplies the proof; the general list's title/tool filter
    // must not hide these legitimate popup input surfaces.
    let rows = unsafe { &mut *(userdata as *mut Vec<i64>) };
    if unsafe { IsWindowVisible(id) } != 0 && unsafe { IsIconic(id) } == 0 {
        rows.push(id as i64);
    }
    1
}

pub(crate) fn windows() -> Vec<Value> {
    let mut handles = Vec::<i64>::new();
    // SAFETY: synchronous enumeration calls callback only while handles is live.
    unsafe {
        EnumWindows(collect_windows, (&mut handles as *mut Vec<i64>) as isize);
    }
    handles.into_iter().filter_map(window_row).collect()
}

fn owned_by(mut candidate: Handle, target: Handle) -> bool {
    // SAFETY: GetAncestor/GetWindow safely return null for missing handles.
    let root = unsafe { GetAncestor(candidate, 2) };
    if root != 0 {
        candidate = root;
    }
    for _ in 0..16 {
        if candidate == 0 {
            return false;
        }
        if candidate == target {
            return true;
        }
        candidate = unsafe { GetWindow(candidate, 4) };
    }
    false
}

fn gui_info(thread: u32) -> Option<GuiThreadInfo> {
    let mut info = GuiThreadInfo {
        size: std::mem::size_of::<GuiThreadInfo>() as u32,
        ..Default::default()
    };
    // SAFETY: exact native size and aligned output pointer.
    if unsafe { GetGUIThreadInfo(thread, &mut info) } == 0 {
        None
    } else {
        Some(info)
    }
}

pub(crate) fn related(candidate: i64, target: i64) -> bool {
    if candidate == target || !is_window(target) || !visible(candidate) {
        return false;
    }
    if owned_by(candidate as Handle, target as Handle) {
        return true;
    }
    if window_class(candidate as Handle) != "#32768" {
        return false;
    }
    let (ct, cp) = thread_pid(candidate as Handle);
    let (tt, tp) = thread_pid(target as Handle);
    ct != 0
        && ct == tt
        && cp == tp
        && gui_info(tt)
            .is_some_and(|info| info.menu_owner != 0 && owned_by(info.menu_owner, target as Handle))
}

pub(crate) fn related_windows(target: i64) -> Vec<Value> {
    if !is_window(target) {
        return Vec::new();
    }
    let mut handles = Vec::<i64>::new();
    // SAFETY: same bounded synchronous enumeration as windows().
    unsafe {
        EnumWindows(
            collect_visible_windows,
            (&mut handles as *mut Vec<i64>) as isize,
        );
    }
    handles
        .into_iter()
        .filter(|id| related(*id, target))
        .filter_map(window_row)
        .take(3)
        .collect()
}

fn input_root(id: i64) -> Handle {
    let window = id as Handle;
    if !is_window(id) {
        return 0;
    }
    let menu = window_class(window) == "#32768";
    let no_activate = unsafe { GetWindowLongW(window, -20) } & 0x0800_0000 != 0;
    if !no_activate && !menu {
        return window;
    }
    let mut owner = unsafe { GetWindow(window, 4) };
    if owner == 0 && menu {
        let (thread, _) = thread_pid(window);
        owner = gui_info(thread)
            .map(|info| unsafe { GetAncestor(info.menu_owner, 2) })
            .unwrap_or(0);
    }
    for _ in 0..16 {
        if owner == 0 {
            break;
        }
        let is_menu = window_class(owner) == "#32768";
        let no_activate = unsafe { GetWindowLongW(owner, -20) } & 0x0800_0000 != 0;
        if !no_activate && !is_menu {
            break;
        }
        owner = unsafe { GetWindow(owner, 4) };
    }
    if owner != 0 && related(id, owner as i64) {
        owner
    } else {
        0
    }
}

pub(crate) fn input_focused(id: i64) -> bool {
    visible(id) && input_root(id) != 0 && foreground() == input_root(id) as i64
}

struct InputAttachments(Vec<(u32, u32)>);
impl InputAttachments {
    fn attach(&mut self, from: u32, to: u32) {
        if from == 0
            || to == 0
            || from == to
            || self
                .0
                .iter()
                .any(|(a, b)| (*a == from && *b == to) || (*a == to && *b == from))
        {
            return;
        }
        // SAFETY: AttachThreadInput receives exact OS thread IDs; only successful attaches are owned.
        if unsafe { AttachThreadInput(from, to, 1) } != 0 {
            self.0.push((from, to));
        }
    }
}
impl Drop for InputAttachments {
    fn drop(&mut self) {
        for (from, to) in self.0.drain(..).rev() {
            // SAFETY: detach only prior successful native attachments, in reverse order.
            unsafe {
                AttachThreadInput(from, to, 0);
            }
        }
    }
}

fn focus_once(id: i64) {
    let root = input_root(id);
    if root == 0 || input_focused(id) || policy::require_native_effects().is_err() {
        return;
    }
    // SAFETY: ShowWindow/SetForegroundWindow safely reject invalid HWNDs.
    if unsafe { IsIconic(root) } != 0 {
        unsafe {
            ShowWindow(root, 9);
        }
    }
    let (fore, _) = thread_pid(unsafe { GetForegroundWindow() });
    let (target, _) = thread_pid(root);
    let me = unsafe { GetCurrentThreadId() };
    let mut joins = InputAttachments(Vec::new());
    joins.attach(me, fore);
    joins.attach(me, target);
    joins.attach(fore, target);
    unsafe {
        SetForegroundWindow(root);
    }
}

pub(crate) fn try_focus(id: i64) -> bool {
    if input_focused(id) {
        return true;
    }
    focus_once(id);
    let since = Instant::now();
    loop {
        if input_focused(id) {
            return true;
        }
        if since.elapsed() >= Duration::from_millis(250) {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

pub(crate) fn assert_focused(id: i64) -> Result<()> {
    if try_focus(id) {
        return Ok(());
    }
    Err(fail(
        "FOCUS_FAILED",
        format!(
            "requested {id} but foreground is {} after asking Windows to activate it. Inspect list_windows and the target's owned dialogs before retrying.",
            foreground()
        ),
    ))
}

pub(crate) fn assert_owner(
    target: i64,
    owner: Option<i64>,
    target_app: Option<&str>,
    owner_app: Option<&str>,
) -> Result<()> {
    if let Some(app) = target_app
        && window_row(target)
            .and_then(|w| w["app"].as_str().map(str::to_owned))
            .as_deref()
            != Some(app)
    {
        return Err(fail(
            "WINDOW_APP_MISMATCH",
            "input target no longer belongs to the observed application",
        ));
    }
    if let Some(app) = owner_app
        && owner
            .and_then(window_row)
            .and_then(|w| w["app"].as_str().map(str::to_owned))
            .as_deref()
            != Some(app)
    {
        return Err(fail(
            "WINDOW_APP_MISMATCH",
            "input owner no longer belongs to the observed application",
        ));
    }
    if let Some(owner) = owner
        && (target <= 0 || (target != owner && !related(target, owner)))
    {
        return Err(fail(
            "RELATED_WINDOW_GONE",
            "input target no longer belongs to the observed window",
        ));
    }
    Ok(())
}

pub(crate) fn layout(window: i64) -> Result<(Handle, u32)> {
    let target = if window == 0 { foreground() } else { window };
    let (thread, _) = thread_pid(target as Handle);
    if thread == 0 {
        return Err(fail("BAD_KEY", "target window has no keyboard layout"));
    }
    // SAFETY: GetKeyboardLayout uses the existing window owner thread ID.
    let layout = unsafe { GetKeyboardLayout(thread) };
    if layout == 0 {
        return Err(fail("BAD_KEY", "target keyboard layout is unavailable"));
    }
    Ok((layout, thread))
}

pub(crate) fn vk_scan(character: char, layout: Handle) -> Option<i16> {
    let code = u32::from(character);
    if code > u16::MAX as u32 {
        return None;
    }
    // SAFETY: VkKeyScanExW accepts the validated active target keyboard layout.
    Some(unsafe { VkKeyScanExW(code as u16, layout) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_window_owner_never_passes() {
        assert!(!related(0, 0));
        assert!(!is_window(0));
        assert!(assert_owner(0, Some(123), None, None).is_err());
    }
}
