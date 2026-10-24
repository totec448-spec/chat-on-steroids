//! What the TypeScript helper read through the managed `System.Windows.Automation` client and
//! native UI Automation reads differently.
//!
//! The managed client answers Win32 controls through its own client-side proxies
//! (`UIAutomationClientSideProviders/MS/Internal/AutomationProxies` in dotnet/wpf), backed by
//! its default HWND provider (`UIAutomationClient/MS/Internal/Automation/
//! HwndProxyElementProvider.cs`), not through the proxies built into `UIAutomationCore`. Four
//! of their rules show in the recorded tree of a WinForms window:
//!
//! - An edit with no label has no name of its own: `ProxyHwnd.GetElementProperty(NameProperty)`
//!   finds no label and no `accName`, so the default HWND provider answers, and it names every
//!   window by its text (`WM_GETTEXT`, "assume window text is same as name. Not true for
//!   edits"), with `Misc.StripMnemonic`. Native UIA names the edit by its label: "".
//! - `WindowsEditBox` implements `ITextProvider` for every edit that is not a password, and its
//!   document range is the edit's text (`WM_GETTEXT`), its selection `EM_GETSEL`. The native
//!   edit proxy offers no `TextPattern`, so there is no `document_text` natively.
//! - `WindowsTitleBar.LocalizedName` is the window's text, and the title bar never sets
//!   `_fIsKeyboardFocusable` (`ProxySimple.IsKeyboardFocusable`). Native UIA names it "" and
//!   marks it focusable.
//! - `WindowsMenu` names the system menu bar (`MenuType.System`, automation id
//!   `SystemMenuBar`) with the resource `LocalizedNameWindowsSystemMenuBar`, "System Menu Bar"
//!   in English. Native UIA calls it "System", the `accName` of `OBJID_SYSMENU`.

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    SMTO_ABORTIFHUNG, SMTO_BLOCK, SendMessageTimeoutW, WM_GETTEXT, WM_GETTEXTLENGTH,
};

const SYSTEM_MENU_BAR: &str = "System Menu Bar";
const EM_GETSEL: u32 = 0x00B0;
/// A hung control answers no query: the managed client waits as long, then gives up.
const QUERY_TIMEOUT_MS: u32 = 200;
/// The longest window text read, in UTF-16 units. Names and the text budget are far shorter.
const MAX_TEXT_UNITS: usize = 65_536;

/// Where an element sits, as far as the managed rules need to know.
pub(crate) struct Place<'a> {
    pub kind: &'a str,
    /// The control type of the element's parent in the control view, if it has one.
    pub parent: Option<&'a str>,
    /// 1 for a child of the observed window.
    pub depth: usize,
    /// The observed window's own name, its title.
    pub window_title: &'a str,
}

/// The name the managed client gives an element whose native name is `native`. `hwnd` is the
/// element's own window, 0 when it has none.
pub(crate) fn name(place: &Place<'_>, native: String, hwnd: isize) -> String {
    match place.kind {
        "Edit" => edit_name(native, hwnd),
        "TitleBar" if native.is_empty() && place.depth == 1 => place.window_title.to_owned(),
        "MenuBar" if place.parent == Some("TitleBar") => SYSTEM_MENU_BAR.to_owned(),
        _ => native,
    }
}

/// An HWND edit with no name of its own is named by its text.
pub(crate) fn edit_name(native: String, hwnd: isize) -> String {
    if !native.is_empty() || hwnd == 0 {
        return native;
    }
    window_text(hwnd).map_or(native, |text| strip_mnemonic(&text))
}

/// The actions the managed client offers on an element of `kind`: a title bar is never
/// keyboard focusable, so it has no `focus`.
pub(crate) fn actions(kind: &str, mut actions: Vec<&'static str>) -> Vec<&'static str> {
    if kind == "TitleBar" {
        actions.retain(|action| *action != "focus");
    }
    actions
}

/// What an HWND edit's managed `TextPattern` gives: the selected part of its text, then the
/// whole text. `None` when the edit does not answer.
pub(crate) fn edit_text(hwnd: isize) -> Option<(String, String)> {
    let text = window_text(hwnd)?;
    let selected = selection(hwnd)
        .and_then(|(start, end)| {
            let units: Vec<u16> = text.encode_utf16().collect();
            units.get(start..end).map(String::from_utf16_lossy)
        })
        .unwrap_or_default();
    Some((selected, text))
}

/// One bounded query to a control: a read, never input.
fn query(hwnd: isize, message: u32, wparam: usize, lparam: isize) -> Option<usize> {
    let mut result = 0usize;
    // SAFETY: a window handle UIA reported; the system marshals these read messages across
    // processes, and the timeout bounds a hung target.
    let answered = unsafe {
        SendMessageTimeoutW(
            HWND(hwnd as *mut _),
            message,
            WPARAM(wparam),
            LPARAM(lparam),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            QUERY_TIMEOUT_MS,
            Some(&raw mut result),
        )
    };
    (answered.0 != 0).then_some(result)
}

/// `WM_GETTEXTLENGTH` then `WM_GETTEXT`, as the managed default HWND provider reads it.
fn window_text(hwnd: isize) -> Option<String> {
    let length = query(hwnd, WM_GETTEXTLENGTH, 0, 0)?.min(MAX_TEXT_UNITS);
    if length == 0 {
        return Some(String::new());
    }
    let mut buffer = vec![0u16; length + 1];
    let copied = query(hwnd, WM_GETTEXT, buffer.len(), buffer.as_mut_ptr() as isize)?;
    Some(String::from_utf16_lossy(&buffer[..copied.min(length)]))
}

/// `EM_GETSEL` as start and end in UTF-16 units; `None` for an empty selection.
fn selection(hwnd: isize) -> Option<(usize, usize)> {
    let packed = query(hwnd, EM_GETSEL, 0, 0)?;
    if packed as u32 == u32::MAX {
        return None;
    }
    let start = packed & 0xFFFF;
    let end = (packed >> 16) & 0xFFFF;
    (start < end).then_some((start, end))
}

/// `Misc.StripMnemonic`: drops leading spaces and the first `&`.
fn strip_mnemonic(text: &str) -> String {
    let mut amper = false;
    text.trim_start_matches(' ')
        .chars()
        .filter(|ch| {
            let drop = *ch == '&' && !amper;
            amper |= drop;
            !drop
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mnemonic_loses_its_first_ampersand_and_leading_spaces_only() {
        assert_eq!(strip_mnemonic("  &Save && Quit"), "Save && Quit");
        assert_eq!(strip_mnemonic("golden-text"), "golden-text");
        assert_eq!(strip_mnemonic("a b"), "a b");
    }

    #[test]
    fn only_the_recorded_managed_rules_change_a_name() {
        let place = |kind, parent, depth| Place {
            kind,
            parent,
            depth,
            window_title: "cos-golden-target",
        };
        assert_eq!(
            name(&place("TitleBar", None, 1), String::new(), 0),
            "cos-golden-target"
        );
        assert_eq!(
            name(&place("MenuBar", Some("TitleBar"), 2), "System".into(), 0),
            "System Menu Bar"
        );
        assert_eq!(
            name(&place("MenuBar", Some("Window"), 2), "File".into(), 0),
            "File"
        );
        assert_eq!(
            name(&place("Edit", None, 1), "Search".into(), 0),
            "Search",
            "a labelled edit keeps its name"
        );
        assert_eq!(name(&place("Edit", None, 1), String::new(), 0), "");
        assert_eq!(
            actions("TitleBar", vec!["invoke", "focus"]),
            ["invoke"],
            "a title bar is not focusable"
        );
        assert_eq!(actions("Button", vec!["focus"]), ["focus"]);
    }
}
