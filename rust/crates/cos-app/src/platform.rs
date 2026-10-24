//! The few window operations GPUI does not offer on Windows: hiding to the tray, showing again,
//! and taking the foreground without synthetic input.
//!
//! GPUI's own `Window::activate_window` presses Alt with `SendInput` to win the foreground, and
//! that keystroke lands in whatever window is in front (standing order 16). These calls use only
//! `ShowWindowAsync` and `SetForegroundWindow` on our own window, which Windows allows because a
//! second launch hands its foreground right over with `AllowSetForegroundWindow` first.

use raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// A top-level window of this process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeWindow(isize);

impl NativeWindow {
    pub fn of(window: &gpui::Window) -> Option<Self> {
        match HasWindowHandle::window_handle(window).ok()?.as_raw() {
            RawWindowHandle::Win32(handle) => Some(Self(handle.hwnd.get())),
            _ => None,
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::NativeWindow;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        ASFW_ANY, AllowSetForegroundWindow, IsIconic, IsWindowVisible, SW_HIDE, SW_RESTORE,
        SW_SHOW, SetForegroundWindow, ShowWindowAsync,
    };

    fn hwnd(window: NativeWindow) -> HWND {
        HWND(window.0 as *mut _)
    }

    /// Lets the running instance take the foreground when this launch forwards to it.
    pub fn hand_over_foreground() {
        // SAFETY: plain Win32 call with a constant argument; failure only means no hand-over.
        let _ = unsafe { AllowSetForegroundWindow(ASFW_ANY) };
    }

    pub fn hide(window: NativeWindow) {
        // SAFETY: the handle is one of this process's live top-level windows. The async form
        // returns at once, so no window message re-enters GPUI while it is being updated.
        let _ = unsafe { ShowWindowAsync(hwnd(window), SW_HIDE) };
    }

    /// Shows, restores and brings the window to the front.
    pub fn reveal(window: NativeWindow) {
        let hwnd = hwnd(window);
        // SAFETY: as in `hide`. Callers run this outside any GPUI update, because
        // `SetForegroundWindow` sends activation messages to the window synchronously.
        unsafe {
            let show = if IsIconic(hwnd).as_bool() {
                SW_RESTORE
            } else {
                SW_SHOW
            };
            let _ = ShowWindowAsync(hwnd, show);
            let _ = SetForegroundWindow(hwnd);
        }
    }

    pub fn is_visible(window: NativeWindow) -> bool {
        // SAFETY: a read-only query on our own window handle.
        unsafe { IsWindowVisible(hwnd(window)).as_bool() }
    }

    pub fn is_minimized(window: NativeWindow) -> bool {
        // SAFETY: a read-only query on our own window handle.
        unsafe { IsIconic(hwnd(window)).as_bool() }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::NativeWindow;

    pub fn hand_over_foreground() {}
    pub fn hide(_: NativeWindow) {}
    pub fn reveal(_: NativeWindow) {}
    pub fn is_visible(_: NativeWindow) -> bool {
        true
    }
    pub fn is_minimized(_: NativeWindow) -> bool {
        false
    }
}

pub use imp::{hand_over_foreground, hide, is_minimized, is_visible, reveal};
