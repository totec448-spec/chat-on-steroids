//! A top-level window this test process creates, owns and pumps on its own thread.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{ClientToScreen, CreateSolidBrush};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BN_CLICKED, BS_PUSHBUTTON, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    ES_AUTOHSCROLL, GetForegroundWindow, GetMessageW, GetWindowTextW, HMENU, MSG,
    PostThreadMessageW, RegisterClassW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    SWP_SHOWWINDOW, SetWindowPos, TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP,
    WM_COMMAND, WNDCLASSW, WS_BORDER, WS_CHILD, WS_EX_NOACTIVATE, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};
use windows::core::w;

const BUTTON_ID: usize = 101;
const CLOSE: u32 = WM_APP + 1;
/// The client background, as RGB.
pub const BACKGROUND: [u8; 3] = [0x20, 0x80, 0xC0];

pub static BUTTON_CLICKS: AtomicU32 = AtomicU32::new(0);

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_COMMAND
        && (wparam.0 >> 16) as u32 == BN_CLICKED
        && wparam.0 & 0xffff == BUTTON_ID
    {
        BUTTON_CLICKS.fetch_add(1, Ordering::SeqCst);
        return LRESULT(0);
    }
    // SAFETY: the default procedure for this class's own window.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

/// A top-level window with a push button and an edit box, pumped by its own thread.
pub struct OwnedWindow {
    pub hwnd: i64,
    edit: i64,
    thread: u32,
    pump: Option<std::thread::JoinHandle<()>>,
}

impl OwnedWindow {
    pub fn open() -> Self {
        let (ready, handles) = mpsc::channel();
        let pump = std::thread::spawn(move || {
            // SAFETY: plain Win32 window creation and a message loop on this thread; every
            // handle created here is destroyed here.
            unsafe {
                let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                let instance = GetModuleHandleW(None).expect("module handle");
                let class = WNDCLASSW {
                    lpfnWndProc: Some(window_proc),
                    hInstance: instance.into(),
                    lpszClassName: w!("cos-d3-owned-window"),
                    hbrBackground: CreateSolidBrush(COLORREF(
                        u32::from(BACKGROUND[0])
                            | u32::from(BACKGROUND[1]) << 8
                            | u32::from(BACKGROUND[2]) << 16,
                    )),
                    ..Default::default()
                };
                RegisterClassW(&class);
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("cos-d3-owned-window"),
                    w!("cos-d3-target"),
                    WS_OVERLAPPEDWINDOW,
                    60,
                    60,
                    420,
                    300,
                    None,
                    None,
                    Some(instance.into()),
                    None,
                )
                .expect("window");
                let child = WS_CHILD | WS_VISIBLE;
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("BUTTON"),
                    w!("cos-d3-button"),
                    child | WINDOW_STYLE(BS_PUSHBUTTON as u32),
                    20,
                    20,
                    160,
                    40,
                    Some(hwnd),
                    Some(HMENU(BUTTON_ID as *mut _)),
                    Some(instance.into()),
                    None,
                )
                .expect("button");
                let edit = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("EDIT"),
                    w!("cos-d3-edit"),
                    child | WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                    20,
                    80,
                    200,
                    24,
                    Some(hwnd),
                    None,
                    Some(instance.into()),
                    None,
                )
                .expect("edit");
                // Not ShowWindow: its first call in a process may take the launcher's show
                // command and activate the window.
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW,
                );
                ready
                    .send((hwnd.0 as i64, edit.0 as i64, GetCurrentThreadId()))
                    .expect("test waits");
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {
                    if message.hwnd.is_invalid() && message.message == CLOSE {
                        let _ = DestroyWindow(hwnd);
                        break;
                    }
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        });
        let (hwnd, edit, thread) = handles
            .recv_timeout(Duration::from_secs(10))
            .expect("window ready");
        // Let the window paint once before it is observed.
        std::thread::sleep(Duration::from_millis(300));
        Self {
            hwnd,
            edit,
            thread,
            pump: Some(pump),
        }
    }

    /// Whether a click or focus change may activate this window. Capture refuses a
    /// non-activating window.
    pub fn set_activatable(&self, activatable: bool) {
        use windows::Win32::UI::WindowsAndMessaging::{
            GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW,
        };
        // SAFETY: a style change on this test's own window.
        unsafe {
            let hwnd = HWND(self.hwnd as *mut _);
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let flag = WS_EX_NOACTIVATE.0 as isize;
            let style = if activatable {
                style & !flag
            } else {
                style | flag
            };
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
        }
    }

    pub fn edit_text(&self) -> String {
        let mut buffer = [0u16; 256];
        // SAFETY: a query of this test's own edit control into a stack buffer.
        let length = unsafe { GetWindowTextW(HWND(self.edit as *mut _), &mut buffer) };
        String::from_utf16_lossy(&buffer[..length.max(0) as usize])
    }

    /// Screen position of a point in the client area, in physical pixels.
    pub fn client_to_screen(&self, x: i32, y: i32) -> (i64, i64) {
        let mut point = POINT { x, y };
        // SAFETY: a geometry query on this test's own window.
        unsafe {
            let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let _ = ClientToScreen(HWND(self.hwnd as *mut _), &mut point);
        }
        (i64::from(point.x), i64::from(point.y))
    }
}

impl Drop for OwnedWindow {
    fn drop(&mut self) {
        // SAFETY: a private thread message to this test's own pump; not input.
        let _ = unsafe { PostThreadMessageW(self.thread, CLOSE, WPARAM(0), LPARAM(0)) };
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
    }
}

/// A window's handle, class and owner pid, for a failure message.
pub fn describe(hwnd: i64) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetWindowThreadProcessId};
    let mut class = [0u16; 128];
    let mut pid = 0;
    // SAFETY: queries of a window handle into a stack buffer and a local.
    let length = unsafe { GetClassNameW(HWND(hwnd as *mut _), &mut class) };
    // SAFETY: as above.
    unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid)) };
    format!(
        "{hwnd} class {} pid {pid} (test pid {})",
        String::from_utf16_lossy(&class[..length.max(0) as usize]),
        std::process::id()
    )
}

pub fn foreground() -> i64 {
    // SAFETY: a query with no arguments.
    unsafe { GetForegroundWindow() }.0 as i64
}
