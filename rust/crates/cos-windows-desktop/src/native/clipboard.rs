//! Clipboard text, as Electron's `clipboard.readText` and `writeText` handled it: Unicode text
//! only. It runs on the desktop thread, in the caller's order with the input it precedes.

use super::policy;
use super::win::{Result, fail};
use std::thread;
use std::time::Duration;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows::Win32::System::Ole::CF_UNICODETEXT;

/// Another program may hold the clipboard for a moment; Chromium retries the same way.
const OPEN_ATTEMPTS: u32 = 10;

struct Open;

impl Open {
    fn clipboard() -> Result<Self> {
        for _ in 0..OPEN_ATTEMPTS {
            // SAFETY: no owner window; the guard closes the clipboard on every path.
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Ok(Self);
            }
            thread::sleep(Duration::from_millis(10));
        }
        Err(fail(
            "CLIPBOARD_BUSY",
            "another program is holding the clipboard",
        ))
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        // SAFETY: this guard opened the clipboard on this thread.
        let _ = unsafe { CloseClipboard() };
    }
}

pub(crate) fn read_text() -> Result<String> {
    policy::require_native_effects()?;
    let _open = Open::clipboard()?;
    // SAFETY: the clipboard is open; the handle stays valid until it closes, and the locked
    // block is read only within GlobalSize bytes.
    unsafe {
        let Ok(handle) = GetClipboardData(u32::from(CF_UNICODETEXT.0)) else {
            return Ok(String::new());
        };
        let memory = HGLOBAL(handle.0);
        let units = GlobalSize(memory) / 2;
        let pointer = GlobalLock(memory).cast::<u16>();
        if pointer.is_null() {
            return Ok(String::new());
        }
        let slice = std::slice::from_raw_parts(pointer, units);
        let end = slice.iter().position(|unit| *unit == 0).unwrap_or(units);
        let text = String::from_utf16_lossy(&slice[..end]);
        let _ = GlobalUnlock(memory);
        Ok(text)
    }
}

pub(crate) fn write_text(text: &str) -> Result<()> {
    policy::require_native_effects()?;
    let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let _open = Open::clipboard()?;
    // SAFETY: the block is allocated with exactly `units` code units, filled while locked, and
    // owned by the clipboard once SetClipboardData succeeds. On failure it is freed here.
    unsafe {
        EmptyClipboard().map_err(|_| fail("CLIPBOARD_FAILED", "could not clear the clipboard"))?;
        let memory = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2)
            .map_err(|_| fail("CLIPBOARD_FAILED", "could not allocate clipboard text"))?;
        let pointer = GlobalLock(memory).cast::<u16>();
        if pointer.is_null() {
            let _ = GlobalFree(Some(memory));
            return Err(fail("CLIPBOARD_FAILED", "could not write clipboard text"));
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), pointer, units.len());
        let _ = GlobalUnlock(memory);
        if SetClipboardData(u32::from(CF_UNICODETEXT.0), Some(HANDLE(memory.0))).is_err() {
            let _ = GlobalFree(Some(memory));
            return Err(fail(
                "CLIPBOARD_FAILED",
                "Windows refused the clipboard text",
            ));
        }
    }
    Ok(())
}
