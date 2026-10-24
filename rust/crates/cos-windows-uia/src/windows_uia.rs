use std::collections::{HashMap, VecDeque};
use std::marker::PhantomData;
use std::rc::Rc;

use cos_sidecar_runtime::DesktopError;
use serde_json::{Value, json};
use uiautomation::core::{UIAutomation, UIElement, UITreeWalker};
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UIScrollItemPattern, UIScrollPattern,
    UISelectionItemPattern, UITextPattern, UITogglePattern, UIValuePattern,
};
use uiautomation::types::{ExpandCollapseState, Handle, ScrollAmount, TreeScope, UIProperty};
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow};

use crate::UiaInputHost;
use crate::managed;

const MAX_SNAPSHOTS: usize = 96;
const MAX_DEPTH: usize = 64;
const MAX_BROWSER_SIBLINGS: usize = 128;
const TEXT_BUDGET: usize = 8_000;
const MAX_UIA_DIAGNOSTIC_CHARS: usize = 500;

fn error(code: &'static str, message: impl Into<String>) -> DesktopError {
    DesktopError::new(code, message)
}

fn failed(message: impl Into<String>) -> DesktopError {
    error("UIA_FAILED", message)
}

fn bounded_failure(error: DesktopError) -> DesktopError {
    failed(
        error
            .message
            .chars()
            .take(MAX_UIA_DIAGNOSTIC_CHARS)
            .collect::<String>(),
    )
}

fn bound_uia_failure(error: DesktopError) -> DesktopError {
    if error.code == "UIA_FAILED" {
        bounded_failure(error)
    } else {
        error
    }
}

/// Keeps the COM initialization paired with the same thread's teardown. UIAutomation::new()
/// initializes COM without an accompanying uninitialize; use new_direct under this guard.
/// The desktop executable must process UIA requests on this one thread.
struct ComApartment(PhantomData<Rc<()>>);

impl ComApartment {
    fn new() -> Result<Self, DesktopError> {
        // SAFETY: initializes COM on the calling helper thread. The guard is !Send and
        // CoUninitialize runs exactly once on the same thread, after dropping UIA objects.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|err| failed(format!("cannot initialize UI Automation COM: {err}")))?;
        Ok(Self(PhantomData))
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        // SAFETY: this thread successfully called CoInitializeEx for this guard.
        unsafe { CoUninitialize() };
    }
}

#[derive(Clone)]
struct Snapshot<E> {
    id: u64,
    window: i64,
    root_key: String,
    root: E,
    elements: HashMap<String, E>,
}

struct Snapshots<E> {
    next: u64,
    recent: VecDeque<Snapshot<E>>,
}

impl<E> Default for Snapshots<E> {
    fn default() -> Self {
        Self {
            next: 1,
            recent: VecDeque::new(),
        }
    }
}

impl<E> Snapshots<E> {
    fn insert(
        &mut self,
        window: i64,
        root_key: String,
        root: E,
        elements: HashMap<String, E>,
    ) -> Result<u64, DesktopError> {
        let id = self.next;
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| failed("UIA snapshot identity counter exhausted"))?;
        self.recent.push_back(Snapshot {
            id,
            window,
            root_key,
            root,
            elements,
        });
        if self.recent.len() > MAX_SNAPSHOTS {
            self.recent.pop_front();
        }
        Ok(id)
    }

    fn resolve(
        &self,
        window: i64,
        snapshot_id: u64,
        key: &str,
    ) -> Result<(&Snapshot<E>, &E), DesktopError> {
        let snapshot = self
            .recent
            .iter()
            .find(|item| item.id == snapshot_id && item.window == window)
            .ok_or_else(|| error("STALE_UI_SNAPSHOT", format!(
                "UI snapshot {snapshot_id} is no longer active for window {window}. Observe again."
            )))?;
        let element = snapshot.elements.get(key).ok_or_else(|| {
            error(
                "UI_ELEMENT_GONE",
                format!("UI element is not part of snapshot {snapshot_id}. Observe again."),
            )
        })?;
        Ok((snapshot, element))
    }
}

fn runtime_key(element: &UIElement) -> String {
    element
        .get_runtime_id()
        .map(|ids| ids.iter().map(i32::to_string).collect::<Vec<_>>().join("."))
        .unwrap_or_default()
}

fn current_window(request: &Value) -> Result<i64, DesktopError> {
    let id = request
        .get("id")
        .or_else(|| request.get("window"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if id > 0 {
        return Ok(id);
    }
    // SAFETY: read-only Win32 query; HWND is checked before retrieving the UIA root.
    let hwnd = unsafe { GetForegroundWindow() };
    let value = hwnd.0 as isize as i64;
    if value <= 0 {
        Err(failed("no foreground UI window is available"))
    } else {
        Ok(value)
    }
}

fn action_window(request: &Value) -> Result<i64, DesktopError> {
    request
        .get("id")
        .or_else(|| request.get("window"))
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            error(
                "STALE_UI_SNAPSHOT",
                "native UI action has no valid window identity",
            )
        })
}

fn hwnd(window: i64) -> Result<HWND, DesktopError> {
    let value = isize::try_from(window).map_err(|_| failed("invalid HWND"))?;
    if value <= 0 {
        return Err(failed("invalid HWND"));
    }
    Ok(HWND(value as *mut std::ffi::c_void))
}

fn process_basename(pid: u32) -> Result<String, DesktopError> {
    // SAFETY: OpenProcess returns an owned handle, used only for a bounded executable-path
    // query and always closed. A denied query fails browser-root observation explicitly.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map_err(|e| failed(format!("cannot inspect UIA window process: {e}")))?;
    let result = (|| {
        let mut buffer = [0u16; 32768];
        let mut length =
            u32::try_from(buffer.len()).map_err(|_| failed("invalid process buffer"))?;
        // SAFETY: buffer and length are writable, and the process handle remains open.
        unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
        }
        .map_err(|e| failed(format!("cannot identify UIA window process: {e}")))?;
        let name = String::from_utf16_lossy(&buffer[..length as usize]);
        Ok(name
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_lowercase()
            .trim_end_matches(".exe")
            .to_string())
    })();
    // SAFETY: OpenProcess succeeded and returned this handle.
    let _ = unsafe { CloseHandle(process) };
    result
}

fn is_browser_process(name: &str) -> bool {
    const NAMES: &[&str] = &[
        "chrome", "chromium", "msedge", "edge", "firefox", "brave", "opera", "vivaldi", "arc",
        "safari",
    ];
    name.to_lowercase()
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .any(|part| NAMES.contains(&part))
}

// A narrow native tree boundary lets provider ownership and ancestry be checked
// with deterministic synthetic trees as well as real UI Automation providers.
trait ControlTree {
    type Node: Clone;
    fn classname(&self, node: &Self::Node) -> String;
    fn first_child(&self, node: &Self::Node) -> Option<Self::Node>;
    fn next_sibling(&self, node: &Self::Node) -> Option<Self::Node>;
    fn parent(&self, node: &Self::Node) -> Option<Self::Node>;
    fn same(&self, a: &Self::Node, b: &Self::Node) -> bool;
}

struct NativeTree<'a> {
    automation: &'a UIAutomation,
    walker: &'a UITreeWalker,
}

impl ControlTree for NativeTree<'_> {
    type Node = UIElement;

    fn classname(&self, node: &UIElement) -> String {
        node.get_classname().unwrap_or_default()
    }
    fn first_child(&self, node: &UIElement) -> Option<UIElement> {
        self.walker.get_first_child(node).ok()
    }
    fn next_sibling(&self, node: &UIElement) -> Option<UIElement> {
        self.walker.get_next_sibling(node).ok()
    }
    fn parent(&self, node: &UIElement) -> Option<UIElement> {
        self.walker.get_parent(node).ok()
    }
    fn same(&self, a: &UIElement, b: &UIElement) -> bool {
        self.automation.compare_elements(a, b).unwrap_or(false)
    }
}

fn select_browser_root<T: ControlTree>(root: T::Node, tree: &T) -> Result<T::Node, DesktopError> {
    let mut current = tree.first_child(&root);
    let mut selected = None;
    let mut visited = 0;
    while let Some(element) = current {
        if visited == MAX_BROWSER_SIBLINGS {
            return Err(failed(
                "current browser UI root is unavailable; use the screenshot instead",
            ));
        }
        visited += 1;
        if tree.classname(&element) == "BrowserRootView" {
            if selected.is_some() {
                return Err(failed(
                    "multiple browser UI roots; use the screenshot instead",
                ));
            }
            selected = Some(element.clone());
        }
        current = tree.next_sibling(&element);
    }
    selected
        .ok_or_else(|| failed("current browser UI root is unavailable; use the screenshot instead"))
}

fn belongs_to_current_root<T: ControlTree>(element: &T::Node, root: &T::Node, tree: &T) -> bool {
    let mut current = element.clone();
    for _ in 0..=MAX_DEPTH {
        if tree.same(&current, root) {
            return true;
        }
        let Some(parent) = tree.parent(&current) else {
            return false;
        };
        current = parent;
    }
    false
}

#[derive(Debug, PartialEq, Eq)]
enum ClickRoute {
    Invoke,
    Toggle,
    Select,
    Physical,
}

fn click_route(button: &str, count: u64, supports: [bool; 3]) -> ClickRoute {
    if button == "left" && count == 1 {
        if supports[0] {
            return ClickRoute::Invoke;
        }
        if supports[1] {
            return ClickRoute::Toggle;
        }
        if supports[2] {
            return ClickRoute::Select;
        }
    }
    ClickRoute::Physical
}

fn observed_center(
    left: i32,
    top: i32,
    width: i32,
    height: i32,
) -> Result<(i32, i32), DesktopError> {
    if width <= 0 || height <= 0 {
        return Err(error(
            "UI_ELEMENT_OFFSCREEN",
            "referenced element has no clickable bounds",
        ));
    }
    // Math.Round in the existing helper uses ties-to-even, including negative origins.
    let x = (f64::from(left) + f64::from(width) / 2.0).round_ties_even();
    let y = (f64::from(top) + f64::from(height) / 2.0).round_ties_even();
    if !(f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&x)
        || !(f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&y)
    {
        return Err(error("UI_ELEMENT_OFFSCREEN", "invalid click center"));
    }
    Ok((x as i32, y as i32))
}

fn action_names(element: &UIElement) -> Vec<&'static str> {
    let mut names = Vec::with_capacity(12);
    if element.get_pattern::<UIInvokePattern>().is_ok() {
        names.push("invoke");
    }
    if element.get_pattern::<UITogglePattern>().is_ok() {
        names.push("toggle");
    }
    if element.get_pattern::<UISelectionItemPattern>().is_ok() {
        names.push("select");
    }
    if let Ok(expand) = element.get_pattern::<UIExpandCollapsePattern>()
        && expand
            .get_state()
            .is_ok_and(|state| state != ExpandCollapseState::LeafNode)
    {
        names.extend(["expand", "collapse"]);
    }
    if let Ok(scroll) = element.get_pattern::<UIScrollPattern>() {
        if scroll.is_vertically_scrollable().unwrap_or(false) {
            names.extend(["scroll_up", "scroll_down"]);
        }
        if scroll.is_horizontally_scrollable().unwrap_or(false) {
            names.extend(["scroll_left", "scroll_right"]);
        }
    }
    if element.get_pattern::<UIScrollItemPattern>().is_ok() {
        names.push("scroll_into_view");
    }
    if element.is_keyboard_focusable().unwrap_or(false) {
        names.push("focus");
    }
    names
}

fn utf16_slice(text: &str, max: usize) -> String {
    let mut result = String::new();
    let mut units = 0;
    for ch in text.chars() {
        let next = units + ch.len_utf16();
        if next > max {
            break;
        }
        result.push(ch);
        units = next;
    }
    result
}

/// The one element whose text a snapshot reports.
enum TextSource {
    Pattern(UITextPattern),
    /// An HWND edit with no native `TextPattern`, read as the managed client's edit proxy
    /// reads it (`managed::edit_text`).
    Edit(isize),
}

impl TextSource {
    /// The selected text and the document text, within the shared budget.
    fn read(&self) -> Option<(String, String)> {
        match self {
            Self::Pattern(pattern) => text_context(pattern),
            Self::Edit(hwnd) => {
                let (selected, document) = managed::edit_text(*hwnd)?;
                let selected = utf16_slice(&selected, 2_000);
                let remaining = TEXT_BUDGET - selected.encode_utf16().count();
                Some((selected, utf16_slice(&document, remaining)))
            }
        }
    }
}

fn text_context(pattern: &UITextPattern) -> Option<(String, String)> {
    // An inaccessible provider is an absent text channel, never a fabricated empty page.
    let ranges = pattern.get_selection().ok()?;
    let mut selected = String::new();
    for range in ranges.into_iter().take(4) {
        let remaining = 2_000usize.saturating_sub(selected.encode_utf16().count());
        if remaining == 0 {
            break;
        }
        let part = range.get_text(i32::try_from(remaining).ok()?).ok()?;
        selected.push_str(&utf16_slice(&part, remaining));
    }
    let remaining = TEXT_BUDGET.saturating_sub(selected.encode_utf16().count());
    let document = pattern
        .get_document_range()
        .ok()?
        .get_text(i32::try_from(remaining).ok()?)
        .ok()?;
    Some((
        utf16_slice(&selected, TEXT_BUDGET),
        utf16_slice(&document, remaining),
    ))
}

fn required_str<'a>(request: &'a Value, name: &str) -> Result<&'a str, DesktopError> {
    request
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| error("BAD_ACTION", format!("missing {name}")))
}

fn required_u64(request: &Value, name: &str) -> Result<u64, DesktopError> {
    request
        .get(name)
        .and_then(Value::as_u64)
        .filter(|num| *num > 0)
        .ok_or_else(|| error("STALE_UI_SNAPSHOT", format!("missing or invalid {name}")))
}

pub struct UiaState {
    automation: UIAutomation,
    walker: UITreeWalker,
    snapshots: Snapshots<UIElement>,
    // Declared last so cached COM references and automation drop before CoUninitialize.
    _apartment: ComApartment,
}

/// Owns the one COM apartment for the entire helper lifetime, including when UIA
/// activation fails. Neither the apartment nor UIA references can move to another thread.
pub struct UiaAvailability {
    state: Option<UiaState>,
    unavailable: Option<DesktopError>,
    // An activated UiaState owns the apartment itself; a failed activation leaves
    // it here until the helper exits. No COM guard is stored if initialization fails.
    _apartment: Option<ComApartment>,
}

impl Default for UiaAvailability {
    fn default() -> Self {
        Self::new()
    }
}

impl UiaAvailability {
    pub fn new() -> Self {
        Self::new_with_activation_check(|| Ok(()))
    }

    /// Injection point for testing failed activation after COM setup, without
    /// constructing a second UIAutomation instance or requiring a live UI window.
    #[doc(hidden)]
    pub fn new_with_activation_check(
        activation_check: impl FnOnce() -> Result<(), DesktopError>,
    ) -> Self {
        let apartment = match ComApartment::new() {
            Ok(apartment) => apartment,
            Err(error) => {
                return Self {
                    state: None,
                    unavailable: Some(bounded_failure(error)),
                    _apartment: None,
                };
            }
        };
        match activation_check().and_then(|()| UiaState::activate()) {
            Ok((automation, walker)) => Self {
                state: Some(UiaState {
                    automation,
                    walker,
                    snapshots: Snapshots::default(),
                    _apartment: apartment,
                }),
                unavailable: None,
                _apartment: None,
            },
            Err(error) => Self {
                state: None,
                unavailable: Some(bounded_failure(error)),
                _apartment: Some(apartment),
            },
        }
    }

    pub fn unavailable(&self) -> Option<&str> {
        self.unavailable
            .as_ref()
            .map(|error| error.message.as_str())
    }

    pub fn ensure_available(&self) -> Result<(), DesktopError> {
        match &self.unavailable {
            Some(error) => Err(failed(error.message.clone())),
            None => Ok(()),
        }
    }

    pub fn warm(&mut self) -> Result<(), DesktopError> {
        self.ensure_available()?;
        self.state
            .as_mut()
            .ok_or_else(|| failed("UIA is unavailable"))?
            .warm()
            .map_err(bound_uia_failure)
    }

    pub fn find(&mut self, request: &Value) -> Result<Value, DesktopError> {
        self.ensure_available()?;
        self.state
            .as_mut()
            .ok_or_else(|| failed("UIA is unavailable"))?
            .find(request)
            .map_err(bound_uia_failure)
    }

    pub fn act(
        &mut self,
        request: &Value,
        host: &mut impl UiaInputHost,
    ) -> Result<Value, DesktopError> {
        self.ensure_available()?;
        self.state
            .as_mut()
            .ok_or_else(|| failed("UIA is unavailable"))?
            .act(request, host)
            .map_err(bound_uia_failure)
    }
}

impl UiaState {
    pub fn new() -> Result<Self, DesktopError> {
        let apartment = ComApartment::new()?;
        let (automation, walker) = Self::activate()?;
        Ok(Self {
            automation,
            walker,
            snapshots: Snapshots::default(),
            _apartment: apartment,
        })
    }

    fn activate() -> Result<(UIAutomation, UITreeWalker), DesktopError> {
        let automation = UIAutomation::new_direct()
            .map_err(|err| failed(format!("cannot start UI Automation: {err}")))?;
        let walker = automation
            .get_control_view_walker()
            .map_err(|err| failed(format!("cannot obtain ControlView walker: {err}")))?;
        Ok((automation, walker))
    }

    pub fn warm(&mut self) -> Result<(), DesktopError> {
        self.automation
            .get_root_element()
            .map_err(|err| failed(format!("cannot warm UI Automation: {err}")))?;
        Ok(())
    }

    fn root(&self, window: i64) -> Result<UIElement, DesktopError> {
        let h = hwnd(window)?;
        // SAFETY: IsWindow reads HWND validity; the owner identity is separately checked
        // by the desktop host for any mutation.
        if !unsafe { IsWindow(Some(h)) }.as_bool() {
            return Err(failed(format!(
                "window {window} disappeared during observation"
            )));
        }
        let root = self
            .automation
            .element_from_handle(Handle::from(h))
            .map_err(|e| failed(format!("no accessible window with id {window}: {e}")))?;
        if root.get_classname().map_err(|e| failed(e.to_string()))? != "Chrome_WidgetWin_1" {
            return Ok(root);
        }
        let process_id = root
            .get_process_id()
            .map_err(|e| failed(format!("cannot identify window {window}: {e}")))?;
        if !is_browser_process(&process_basename(process_id)?) {
            return Ok(root);
        }
        select_browser_root(
            root,
            &NativeTree {
                automation: &self.automation,
                walker: &self.walker,
            },
        )
    }

    pub fn find(&mut self, request: &Value) -> Result<Value, DesktopError> {
        let window = current_window(request)?;
        let root = self.root(window)?;
        let is_browser = root.get_classname().unwrap_or_default() == "BrowserRootView";
        let query = request
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let role = request
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let limit = request
            .get("maxResults")
            .and_then(Value::as_i64)
            .filter(|v| *v != 0)
            .unwrap_or(30)
            .clamp(1, 100) as usize;
        let visit_limit = request
            .get("maxVisited")
            .and_then(Value::as_i64)
            .filter(|v| *v != 0)
            .unwrap_or(3_000)
            .clamp(limit as i64, 10_000) as usize;

        let cache = self
            .automation
            .create_cache_request()
            .map_err(|e| failed(e.to_string()))?;
        cache
            .set_tree_scope(TreeScope::Element)
            .map_err(|e| failed(e.to_string()))?;
        for property in [
            UIProperty::Name,
            UIProperty::AutomationId,
            UIProperty::ControlType,
            UIProperty::IsEnabled,
            UIProperty::IsOffscreen,
            UIProperty::BoundingRectangle,
            UIProperty::HasKeyboardFocus,
            UIProperty::IsKeyboardFocusable,
            UIProperty::IsPassword,
            UIProperty::NativeWindowHandle,
        ] {
            cache
                .add_property(property)
                .map_err(|e| failed(e.to_string()))?;
        }
        let window_title = root.get_name().unwrap_or_default();
        // The control type at each depth of the current path, for the parent's.
        let mut path_kinds: Vec<String> = Vec::new();
        let mut next = self
            .walker
            .get_first_child_build_cache(&root, &cache)
            .ok()
            .map(|e| (e, 1usize));
        let mut stack = Vec::new();
        let mut entries = Vec::new();
        let mut handles = HashMap::new();
        let mut visited = 0usize;
        let mut depth_limited = false;
        let mut focused = None::<String>;
        let mut text_source = None;
        let mut text_priority = 0;
        while let Some((element, depth)) = next.take() {
            if entries.len() == limit || visited == visit_limit {
                next = Some((element, depth));
                break;
            }
            visited += 1;
            let kind = element
                .get_cached_control_type()
                .ok()
                .map(|kind| format!("{kind:?}"));
            path_kinds.truncate(depth - 1);
            path_kinds.push(kind.clone().unwrap_or_default());
            let hwnd = element
                .get_cached_native_window_handle()
                .map_or(0, |handle| Into::<HWND>::into(handle).0 as isize);
            let observation = (|| {
                let kind = kind.clone()?;
                let place = managed::Place {
                    kind: &kind,
                    parent: depth
                        .checked_sub(2)
                        .and_then(|parent| path_kinds.get(parent))
                        .map(String::as_str),
                    depth,
                    window_title: &window_title,
                };
                let name = managed::name(&place, element.get_cached_name().ok()?, hwnd);
                let automation_id = element.get_cached_automation_id().ok()?;
                if (!query.is_empty()
                    && !name.to_lowercase().contains(&query)
                    && !automation_id.to_lowercase().contains(&query))
                    || (!role.is_empty() && !kind.to_lowercase().contains(&role))
                {
                    return None;
                }
                let rect = element.get_cached_bounding_rectangle().ok()?;
                let x = rect.get_left();
                let y = rect.get_top();
                let width = rect.get_right().checked_sub(x)?;
                let height = rect.get_bottom().checked_sub(y)?;
                let has_bounds = width > 0 && height > 0;
                let actions = managed::actions(&kind, action_names(&element));
                if !has_bounds && actions.is_empty() {
                    return None;
                }
                let runtime_key = runtime_key(&element);
                let focused_now = element.has_cached_keyboard_focus().unwrap_or(false);
                let password = element.is_cached_password().unwrap_or(false);
                let priority = if !has_bounds || password {
                    0
                } else if kind == "Document" {
                    3
                } else if is_browser {
                    0
                } else if focused_now {
                    2
                } else if kind == "Edit" {
                    1
                } else {
                    0
                };
                let selected = element
                    .get_pattern::<UISelectionItemPattern>()
                    .ok()
                    .and_then(|pattern| pattern.is_selected().ok());
                let mut entry = json!({
                    "runtimeKey":runtime_key,"name":name,"role":kind,
                    "automationId":automation_id,
                    "enabled":element.is_cached_enabled().unwrap_or(false),
                    "offscreen":element.is_cached_offscreen().unwrap_or(false),
                    "focused":focused_now,"depth":depth,"actions":actions,
                    "bounds":if has_bounds {
                        json!({"x":x,"y":y,"width":width,"height":height})
                    } else {
                        json!({"x":0,"y":0,"width":0,"height":0})
                    }
                });
                if let Some(selected) = selected {
                    entry["selected"] = json!(selected);
                }
                Some((entry, runtime_key, focused_now, priority))
            })();
            if let Some((entry, key, has_focus, priority)) = observation {
                if has_focus {
                    focused = Some(key.clone());
                }
                if priority > text_priority {
                    // Priority above 0 already excludes password fields.
                    let source = match element.get_pattern::<UITextPattern>() {
                        Ok(pattern) => Some(TextSource::Pattern(pattern)),
                        Err(_) if kind.as_deref() == Some("Edit") && hwnd != 0 => {
                            Some(TextSource::Edit(hwnd))
                        }
                        Err(_) => None,
                    };
                    if source.is_some() {
                        text_priority = priority;
                        text_source = source;
                    }
                }
                // Snapshot records the exact COM object, never a runtime-ID rescan.
                if !key.is_empty() {
                    handles.entry(key).or_insert_with(|| element.clone());
                }
                entries.push(entry);
            }
            if let Ok(sibling) = self.walker.get_next_sibling_build_cache(&element, &cache) {
                stack.push((sibling, depth));
            }
            if depth < MAX_DEPTH {
                next = self
                    .walker
                    .get_first_child_build_cache(&element, &cache)
                    .ok()
                    .map(|child| (child, depth + 1));
            } else {
                depth_limited = true;
            }
            if next.is_none() {
                next = stack.pop();
            }
        }
        let (selected, document) = text_source
            .as_ref()
            .and_then(TextSource::read)
            .map(|(selected, document)| (Some(selected), Some(document)))
            .unwrap_or((None, None));
        let root_key = runtime_key(&root);
        let snapshot_id = self.snapshots.insert(window, root_key, root, handles)?;
        Ok(json!({
            "window":window,
            "snapshotId":snapshot_id,
            "elements":entries,
            "visited":visited,
            "truncated":next.is_some() || !stack.is_empty() || depth_limited,
            "document_text":document,
            "selected_text":selected,
            "focused_element":focused,
        }))
    }

    fn resolve(&self, request: &Value) -> Result<(i64, UIElement), DesktopError> {
        let window = action_window(request)?;
        let snapshot_id = required_u64(request, "snapshotId")?;
        let key = required_str(request, "runtimeKey")?;
        let (snapshot, element) = self.snapshots.resolve(window, snapshot_id, key)?;
        let current_root = self
            .root(window)
            .map_err(|e| failed(format!("cannot inspect window {window}. {}", e.message)))?;
        if runtime_key(&current_root) != snapshot.root_key
            || !self
                .automation
                .compare_elements(&snapshot.root, &current_root)
                .unwrap_or(false)
        {
            return Err(error(
                "STALE_UI_SNAPSHOT",
                format!(
                    "window {window} no longer has the UIA root from snapshot {snapshot_id}. Observe again."
                ),
            ));
        }
        element.is_enabled().map_err(|_| {
            error(
                "UI_ELEMENT_GONE",
                "the referenced UI element is no longer present",
            )
        })?;
        if runtime_key(element) != key {
            return Err(error("STALE_UI_REF", "the cached element identity changed"));
        }
        if belongs_to_current_root(
            element,
            &current_root,
            &NativeTree {
                automation: &self.automation,
                walker: &self.walker,
            },
        ) {
            return Ok((window, element.clone()));
        }
        Err(error(
            "STALE_UI_REF",
            "element is no longer in the observed window UI; observe again",
        ))
    }

    pub fn act(
        &mut self,
        request: &Value,
        host: &mut impl UiaInputHost,
    ) -> Result<Value, DesktopError> {
        let action = required_str(request, "action")?;
        if !matches!(
            action,
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
                | "click"
                | "set_value"
        ) {
            return Err(error(
                "BAD_ACTION",
                format!("unsupported UI element action {action}"),
            ));
        }
        // Assert owner before accessing a native ref, and once more immediately before effects.
        host.assert_input_owner(request)?;
        let (window, element) = self.resolve(request)?;
        if !element
            .is_enabled()
            .map_err(|_| error("UI_ELEMENT_GONE", "UI element disappeared"))?
        {
            return Err(error(
                "UI_ELEMENT_DISABLED",
                "the referenced element is disabled",
            ));
        }
        // Snapshot membership and root ancestry have just been revalidated.
        // Capture native identity once, before an Invoke can destroy its own control.
        let observed_runtime_key = runtime_key(&element);
        let observed_name = element.get_name().map_err(|_| {
            error(
                "UI_ELEMENT_GONE",
                "the referenced UI element is no longer present",
            )
        })?;
        let observed_name = if element
            .get_control_type()
            .is_ok_and(|kind| format!("{kind:?}") == "Edit")
        {
            let hwnd = element
                .get_native_window_handle()
                .map_or(0, |handle| Into::<HWND>::into(handle).0 as isize);
            managed::edit_name(observed_name, hwnd)
        } else {
            observed_name
        };
        let reply = |route: &str| {
            json!({
                "runtimeKey": observed_runtime_key,
                "name": observed_name,
                "route": route,
            })
        };
        if action == "click" {
            let button = request
                .get("button")
                .and_then(Value::as_str)
                .unwrap_or("left");
            let count = request
                .get("count")
                .map(Value::as_u64)
                .unwrap_or(Some(1))
                .filter(|count| (1..=3).contains(count))
                .ok_or_else(|| {
                    error(
                        "BAD_ACTION",
                        "click count must be an integer between 1 and 3",
                    )
                })?;
            if !matches!(button, "left" | "right" | "middle") {
                return Err(error("BAD_ACTION", "unsupported click button"));
            }
            let supported = if button == "left" && count == 1 {
                [
                    element.get_pattern::<UIInvokePattern>().is_ok(),
                    element.get_pattern::<UITogglePattern>().is_ok(),
                    element.get_pattern::<UISelectionItemPattern>().is_ok(),
                ]
            } else {
                [false; 3]
            };
            match click_route(button, count, supported) {
                ClickRoute::Invoke => {
                    let pattern = element.get_pattern::<UIInvokePattern>().map_err(|_| {
                        error(
                            "UI_ACTION_UNSUPPORTED",
                            "element no longer exposes InvokePattern",
                        )
                    })?;
                    host.assert_input_owner(request)?;
                    pattern
                        .invoke()
                        .map_err(|e| failed(format!("UIA invoke failed: {e}")))?;
                    return Ok(reply("uia"));
                }
                ClickRoute::Toggle => {
                    let pattern = element.get_pattern::<UITogglePattern>().map_err(|_| {
                        error(
                            "UI_ACTION_UNSUPPORTED",
                            "element no longer exposes TogglePattern",
                        )
                    })?;
                    host.assert_input_owner(request)?;
                    pattern
                        .toggle()
                        .map_err(|e| failed(format!("UIA toggle failed: {e}")))?;
                    return Ok(reply("uia"));
                }
                ClickRoute::Select => {
                    let pattern =
                        element
                            .get_pattern::<UISelectionItemPattern>()
                            .map_err(|_| {
                                error(
                                    "UI_ACTION_UNSUPPORTED",
                                    "element no longer exposes SelectionItemPattern",
                                )
                            })?;
                    host.assert_input_owner(request)?;
                    pattern
                        .select()
                        .map_err(|e| failed(format!("UIA select failed: {e}")))?;
                    return Ok(reply("uia"));
                }
                ClickRoute::Physical => {}
            }
            host.assert_input_owner(request)?;
            host.assert_focused(window)?;
            let rect = element
                .get_bounding_rectangle()
                .map_err(|_| error("UI_ELEMENT_GONE", "element bounds are unavailable"))?;
            let width = rect.get_right().checked_sub(rect.get_left()).unwrap_or(0);
            let height = rect.get_bottom().checked_sub(rect.get_top()).unwrap_or(0);
            let (x, y) = observed_center(rect.get_left(), rect.get_top(), width, height)?;
            host.assert_input_owner(request)?;
            host.click(x, y, button, count as u32)?;
            return Ok(reply("sendinput"));
        }
        if action == "set_value" {
            // Missing/null/non-string payloads must never silently clear a live
            // control. An explicitly supplied empty string is still valid.
            let text = required_str(request, "value")?;
            let value = element.get_pattern::<UIValuePattern>().map_err(|_| {
                error(
                    "UI_VALUE_UNSUPPORTED",
                    "referenced element does not expose ValuePattern",
                )
            })?;
            if value.is_readonly().map_err(|e| failed(e.to_string()))? {
                return Err(error(
                    "UI_VALUE_READONLY",
                    "referenced element is read-only",
                ));
            }
            host.assert_input_owner(request)?;
            value
                .set_value(text)
                .map_err(|e| failed(format!("set value failed: {e}")))?;
            return Ok(reply("uia"));
        }
        let mut operation = || -> Result<(), DesktopError> {
            macro_rules! pattern {
                ($ty:ty) => {{
                    let pattern = element.get_pattern::<$ty>().map_err(|_| {
                        error(
                            "UI_ACTION_UNSUPPORTED",
                            format!("element does not currently support {action}"),
                        )
                    })?;
                    host.assert_input_owner(request)?;
                    pattern
                }};
            }
            match action {
                "focus" => {
                    if !element.is_keyboard_focusable().unwrap_or(false) {
                        return Err(error(
                            "UI_ACTION_UNSUPPORTED",
                            "element is not keyboard focusable",
                        ));
                    }
                    host.assert_input_owner(request)?;
                    element.set_focus().map_err(|e| failed(e.to_string()))
                }
                "invoke" => pattern!(UIInvokePattern)
                    .invoke()
                    .map_err(|e| failed(e.to_string())),
                "toggle" => pattern!(UITogglePattern)
                    .toggle()
                    .map_err(|e| failed(e.to_string())),
                "select" => pattern!(UISelectionItemPattern)
                    .select()
                    .map_err(|e| failed(e.to_string())),
                "expand" => pattern!(UIExpandCollapsePattern)
                    .expand()
                    .map_err(|e| failed(e.to_string())),
                "collapse" => pattern!(UIExpandCollapsePattern)
                    .collapse()
                    .map_err(|e| failed(e.to_string())),
                "scroll_into_view" => pattern!(UIScrollItemPattern)
                    .scroll_into_view()
                    .map_err(|e| failed(e.to_string())),
                "scroll_up" | "scroll_down" | "scroll_left" | "scroll_right" => {
                    let pattern = pattern!(UIScrollPattern);
                    let vertical = matches!(action, "scroll_up" | "scroll_down");
                    let available = if vertical {
                        pattern.is_vertically_scrollable()
                    } else {
                        pattern.is_horizontally_scrollable()
                    }
                    .map_err(|e| failed(e.to_string()))?;
                    if !available {
                        return Err(error(
                            "UI_ACTION_UNSUPPORTED",
                            format!("element cannot {action}"),
                        ));
                    }
                    let amount = if matches!(action, "scroll_up" | "scroll_left") {
                        ScrollAmount::LargeDecrement
                    } else {
                        ScrollAmount::LargeIncrement
                    };
                    let (h, v) = if vertical {
                        (ScrollAmount::NoAmount, amount)
                    } else {
                        (amount, ScrollAmount::NoAmount)
                    };
                    host.assert_input_owner(request)?;
                    pattern.scroll(h, v).map_err(|e| failed(e.to_string()))
                }
                _ => Err(error("BAD_ACTION", "unknown semantic action")),
            }
        };
        // Resolve current pattern and validate preconditions, then ask host immediately
        // before each provider mutation, including focus and scroll.
        operation()?;
        Ok(reply("uia"))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ClickRoute, ControlTree, MAX_BROWSER_SIBLINGS, MAX_DEPTH, Snapshots, UiaAvailability,
        belongs_to_current_root, click_route, is_browser_process, observed_center, required_str,
        select_browser_root, utf16_slice,
    };
    use cos_sidecar_runtime::DesktopError;
    use serde_json::json;
    use std::cell::Cell;
    use std::collections::HashMap;
    use windows::Win32::System::Com::{APTTYPE, APTTYPE_MTA, APTTYPEQUALIFIER, CoGetApartmentType};

    #[test]
    fn failed_activation_keeps_com_until_availability_owner_drops() {
        // A fresh OS thread starts without COM. Keep the unavailable state and
        // its apartment entirely on this thread, then observe real COM teardown.
        std::thread::spawn(|| {
            let apartment_type = || {
                let mut kind = APTTYPE(0);
                let mut qualifier = APTTYPEQUALIFIER(0);
                // SAFETY: this queries only the calling thread's COM apartment.
                unsafe { CoGetApartmentType(&mut kind, &mut qualifier) }.map(|()| kind)
            };
            assert!(
                apartment_type().is_err(),
                "test thread must start without COM"
            );
            let calls = Cell::new(0);
            let mut availability = UiaAvailability::new_with_activation_check(|| {
                calls.set(calls.get() + 1);
                Err(DesktopError::new("UIA_FAILED", "界😀".repeat(700)))
            });
            assert_eq!(apartment_type().unwrap(), APTTYPE_MTA);
            assert_eq!(calls.get(), 1);
            assert_eq!(availability.unavailable().unwrap().chars().count(), 500);
            for _ in 0..3 {
                assert_eq!(availability.warm().unwrap_err().code, "UIA_FAILED");
                assert_eq!(
                    availability.find(&json!({"id":1})).unwrap_err().code,
                    "UIA_FAILED"
                );
            }
            assert_eq!(
                calls.get(),
                1,
                "unavailability must be fixed for helper lifetime"
            );
            drop(availability);
            assert!(
                apartment_type().is_err(),
                "owner teardown must uninitialize COM"
            );
        })
        .join()
        .unwrap();
    }

    #[derive(Default)]
    struct FakeTree {
        nodes: Vec<FakeNode>,
    }

    struct FakeNode {
        class: &'static str,
        parent: Option<usize>,
        children: Vec<usize>,
    }

    impl FakeTree {
        fn node(&mut self, class: &'static str) -> usize {
            let index = self.nodes.len();
            self.nodes.push(FakeNode {
                class,
                parent: None,
                children: Vec::new(),
            });
            index
        }

        fn children(&mut self, parent: usize, children: &[usize]) {
            for former in std::mem::take(&mut self.nodes[parent].children) {
                if self.nodes[former].parent == Some(parent) {
                    self.nodes[former].parent = None;
                }
            }
            for &child in children {
                if let Some(previous) = self.nodes[child].parent {
                    self.nodes[previous].children.retain(|&id| id != child);
                }
                self.nodes[child].parent = Some(parent);
            }
            self.nodes[parent].children = children.to_vec();
        }
    }

    impl ControlTree for FakeTree {
        type Node = usize;
        fn classname(&self, node: &usize) -> String {
            self.nodes[*node].class.into()
        }
        fn first_child(&self, node: &usize) -> Option<usize> {
            self.nodes[*node].children.first().copied()
        }
        fn next_sibling(&self, node: &usize) -> Option<usize> {
            let parent = self.nodes[*node].parent?;
            let children = &self.nodes[parent].children;
            let index = children.iter().position(|candidate| candidate == node)?;
            children.get(index + 1).copied()
        }
        fn parent(&self, node: &usize) -> Option<usize> {
            self.nodes[*node].parent
        }
        fn same(&self, a: &usize, b: &usize) -> bool {
            a == b
        }
    }

    #[test]
    fn browser_tree_ignores_live_legacy_tab_and_rejects_old_tab_ancestry() {
        let mut tree = FakeTree::default();
        let root = tree.node("Chrome_WidgetWin_1");
        let stale_tab = tree.node("Document");
        let browser = tree.node("BrowserRootView");
        let current_document = tree.node("Document");
        let control = tree.node("Button");
        tree.children(root, &[stale_tab, browser]);
        tree.children(browser, &[current_document]);
        tree.children(current_document, &[control]);
        assert_eq!(select_browser_root(root, &tree).unwrap(), browser);
        assert!(belongs_to_current_root(&control, &browser, &tree));
        // The same cached control object is still accessible but has moved into a
        // previous tab provider. RuntimeId/liveness alone would accept it.
        tree.children(stale_tab, &[current_document]);
        assert!(!belongs_to_current_root(&control, &browser, &tree));
        let replacement = tree.node("BrowserRootView");
        tree.children(root, &[replacement]);
        assert_eq!(select_browser_root(root, &tree).unwrap(), replacement);
        assert!(!belongs_to_current_root(&control, &replacement, &tree));
    }

    #[test]
    fn browser_root_is_required_unique_and_within_128_direct_children() {
        let mut tree = FakeTree::default();
        let root = tree.node("Chrome_WidgetWin_1");
        let document = tree.node("Document");
        tree.children(root, &[document]);
        assert_eq!(
            select_browser_root(root, &tree).err().unwrap().code,
            "UIA_FAILED"
        );
        let first = tree.node("BrowserRootView");
        let second = tree.node("BrowserRootView");
        tree.children(root, &[first, second]);
        assert!(
            select_browser_root(root, &tree)
                .err()
                .unwrap()
                .message
                .contains("multiple browser")
        );
        let mut siblings = vec![first];
        for _ in 0..MAX_BROWSER_SIBLINGS {
            siblings.push(tree.node("Document"));
        }
        tree.children(root, &siblings);
        assert!(select_browser_root(root, &tree).is_err());
        tree.children(root, &siblings[..MAX_BROWSER_SIBLINGS]);
        assert_eq!(select_browser_root(root, &tree).unwrap(), first);
    }

    #[test]
    fn ancestry_walk_has_the_same_64_parent_bound_as_legacy() {
        let mut tree = FakeTree::default();
        let root = tree.node("BrowserRootView");
        let mut parent = root;
        for _ in 0..MAX_DEPTH {
            let child = tree.node("Pane");
            tree.children(parent, &[child]);
            parent = child;
        }
        assert!(belongs_to_current_root(&parent, &root, &tree));
        let too_deep = tree.node("Button");
        tree.children(parent, &[too_deep]);
        assert!(!belongs_to_current_root(&too_deep, &root, &tree));
    }

    #[test]
    fn semantic_click_precedence_and_physical_fallback_match_helper() {
        assert_eq!(
            click_route("left", 1, [true, true, true]),
            ClickRoute::Invoke
        );
        assert_eq!(
            click_route("left", 1, [false, true, true]),
            ClickRoute::Toggle
        );
        assert_eq!(
            click_route("left", 1, [false, false, true]),
            ClickRoute::Select
        );
        assert_eq!(
            click_route("left", 1, [false, false, false]),
            ClickRoute::Physical
        );
        assert_eq!(
            click_route("right", 1, [true, true, true]),
            ClickRoute::Physical
        );
        assert_eq!(
            click_route("left", 2, [true, true, true]),
            ClickRoute::Physical
        );
    }

    #[test]
    fn click_center_matches_legacy_bankers_rounding() {
        assert_eq!(observed_center(0, 0, 1, 1).unwrap(), (0, 0));
        assert_eq!(observed_center(1, 1, 1, 1).unwrap(), (2, 2));
        assert_eq!(observed_center(-1, -1, 1, 1).unwrap(), (0, 0));
        assert_eq!(observed_center(-2, -2, 1, 1).unwrap(), (-2, -2));
        assert_eq!(
            observed_center(i32::MAX, 0, 4, 1).err().unwrap().code,
            "UI_ELEMENT_OFFSCREEN"
        );
        assert_eq!(
            observed_center(0, 0, 0, 2).err().unwrap().code,
            "UI_ELEMENT_OFFSCREEN"
        );
    }

    #[test]
    fn browser_process_classification_requires_exact_token() {
        for good in [
            "chrome",
            "msedge",
            "brave",
            "Google Chrome",
            "brave-browser",
        ] {
            assert!(is_browser_process(good), "{good}");
        }
        for other in [
            "chromedriver",
            "my-chrome-sandbox",
            "fixture",
            "electron",
            "chromebook",
        ] {
            // Hyphen-delimited browser names are intentionally accepted, matching
            // BROWSER_PROCESS_PATTERN in the existing TS oracle.
            if other == "my-chrome-sandbox" {
                assert!(is_browser_process(other));
            } else {
                assert!(!is_browser_process(other), "{other}");
            }
        }
    }

    #[test]
    fn snapshots_hold_exact_objects_and_evict_at_96() {
        let mut snapshots = Snapshots::default();
        let mut row = HashMap::new();
        row.insert("4.5".into(), 8);
        let first = snapshots.insert(99, "root".into(), 1, row.clone()).unwrap();
        assert_eq!(*snapshots.resolve(99, first, "4.5").unwrap().1, 8);
        assert_eq!(
            snapshots.resolve(100, first, "4.5").err().unwrap().code,
            "STALE_UI_SNAPSHOT"
        );
        assert_eq!(
            snapshots.resolve(99, first, "4.8").err().unwrap().code,
            "UI_ELEMENT_GONE"
        );
        for id in 0..96 {
            snapshots.insert(id, "root".into(), 1, row.clone()).unwrap();
        }
        assert_eq!(
            snapshots.resolve(99, first, "4.5").err().unwrap().code,
            "STALE_UI_SNAPSHOT"
        );
        assert_eq!(snapshots.recent.len(), 96);
    }

    #[test]
    fn text_budget_counts_utf16_units_and_never_splits_a_surrogate() {
        assert_eq!(utf16_slice("A😀B", 2), "A");
        assert_eq!(utf16_slice("A😀B", 3), "A😀");
    }

    #[test]
    fn set_value_requires_string_and_accepts_explicit_empty_value() {
        for request in [
            json!({}),
            json!({"value": null}),
            json!({"value": false}),
            json!({"value": 0}),
            json!({"value": ["unexpected"]}),
            json!({"value": {"text": "unexpected"}}),
        ] {
            let error = required_str(&request, "value")
                .expect_err("invalid set_value must be rejected before native mutation");
            assert_eq!(error.code, "BAD_ACTION", "{request}");
        }
        for text in ["", "literal", "مرحبا 😀"] {
            let request = json!({"value": text});
            assert_eq!(required_str(&request, "value").unwrap(), text);
        }
    }
}
