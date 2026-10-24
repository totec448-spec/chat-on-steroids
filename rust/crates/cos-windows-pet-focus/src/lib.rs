//! The native foreground owner for the Windows pet overlay.
//! Only a WinEvent observation can capture a return target; renderer commands can revoke or
//! consume it, but cannot claim a previous foreground window from an asynchronous cache.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Identity {
    pub process: u32,
    pub thread: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Target {
    handle: u64,
    identity: Identity,
}

pub trait NativeFocus {
    fn foreground(&self) -> u64;
    /// The Win32 tick counter used by the event hook's dwmsEventTime field.
    fn event_clock(&self) -> u32;
    /// Process/thread identity even while the overlay has not yet been shown.
    fn identity(&self, handle: u64) -> Option<Identity>;
    /// The identity of an existing visible, enabled, non-minimized window, or None.
    fn eligible_identity(&self, handle: u64) -> Option<Identity>;
    fn activate_once(&self, handle: u64);
}

pub struct FocusState<N: NativeFocus> {
    native: N,
    own_handle: u64,
    own_identity: Identity,
    last: u64,
    previous: Option<Target>,
    capture_armed: bool,
    last_event_at: Option<u32>,
    last_revoke_at: Option<u32>,
    disposed: bool,
}

impl<N: NativeFocus> FocusState<N> {
    pub fn start(native: N, own_handle: u64) -> Option<Self> {
        if own_handle == 0 {
            return None;
        }
        // Electron constructs this HWND while hidden and only shows it after preload loads.
        let own_identity = native.identity(own_handle)?;
        let last = native.foreground();
        Some(Self {
            native,
            own_handle,
            own_identity,
            last,
            previous: None,
            capture_armed: true,
            last_event_at: None,
            last_revoke_at: None,
            disposed: false,
        })
    }

    fn own_is_current(&self) -> bool {
        self.native.identity(self.own_handle) == Some(self.own_identity)
            && self.native.eligible_identity(self.own_handle) == Some(self.own_identity)
    }

    /// Take the last external foreground sample after WinEventHook is installed, while the
    /// Electron overlay is still hidden. This closes the snapshot-to-install event gap.
    pub fn hook_installed(&mut self) {
        self.previous = None;
        self.last = self.native.foreground();
        self.capture_armed = self.last != self.own_handle;
        self.last_event_at = Some(self.native.event_clock());
    }

    /// Called only on the WinEvent-hook thread, in native callback order.
    pub fn on_foreground(&mut self, handle: u64, event_time: u32) {
        // WinEvent may deliver a callback after blur/hide/dispose even though the event
        // happened before that revocation. Half-range comparison tolerates u32 tick wrap.
        if self.last_revoke_at.is_some_and(|cutoff| {
            let elapsed = event_time.wrapping_sub(cutoff);
            elapsed == 0 || elapsed >= 0x8000_0000
        }) {
            return;
        }
        // Across WinEvent producer threads, a delayed callback must not overtake the newest
        // foreground event already handled by this actor. Same-tick callbacks retain FIFO.
        if self
            .last_event_at
            .is_some_and(|latest| event_time.wrapping_sub(latest) >= 0x8000_0000)
        {
            return;
        }
        self.last_event_at = Some(event_time);
        if self.disposed || handle == self.last {
            return;
        }
        let identity = if handle == self.own_handle
            && self.capture_armed
            && self.last != 0
            && self.own_is_current()
            && self.native.foreground() == self.own_handle
        {
            self.native.eligible_identity(self.last)
        } else {
            None
        };
        self.previous = identity.map(|identity| Target {
            handle: self.last,
            identity,
        });
        if handle == self.own_handle {
            self.capture_armed = false;
        } else if self.native.foreground() == handle {
            self.capture_armed = true;
        }
        self.last = handle;
    }

    /// An Electron blur/hide invalidates the interaction even if the WinEvent is in flight.
    pub fn revoke(&mut self) {
        self.previous = None;
        self.last_revoke_at = Some(self.native.event_clock());
        // A blur may arrive after the new external WinEvent. Preserve that *observed* fresh
        // owner while rejecting older callbacks by the WinEvent timestamp above.
        self.capture_armed = self.last != self.own_handle && self.native.foreground() == self.last;
    }

    /// A native callback queue overflow invalidates any claim derived from missing events.
    pub fn lose_observations(&mut self) {
        self.previous = None;
        self.last = self.native.foreground();
        self.capture_armed = false;
        self.last_event_at = Some(self.native.event_clock());
        self.last_revoke_at = Some(self.native.event_clock());
    }

    pub fn release(&mut self) {
        let target = self.previous.take();
        let Some(target) = target else {
            return;
        };
        if self.disposed || !self.own_is_current() || self.native.foreground() != self.own_handle {
            return;
        }
        if self.native.eligible_identity(target.handle) == Some(target.identity) {
            // Windows retains absolute authority; one attempt, no injected input or retries.
            self.native.activate_once(target.handle);
        }
    }

    pub fn dispose(&mut self) {
        self.disposed = true;
        self.previous = None;
        self.capture_armed = false;
        self.last_revoke_at = Some(self.native.event_clock());
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(try_from = "WireCommand")]
pub enum Command {
    Start { hwnd: String },
    Revoke,
    Release,
    Dispose,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireCommand {
    op: String,
    hwnd: Option<String>,
}

impl TryFrom<WireCommand> for Command {
    type Error = String;

    fn try_from(value: WireCommand) -> Result<Self, Self::Error> {
        match (value.op.as_str(), value.hwnd) {
            ("start", Some(hwnd)) => Ok(Self::Start { hwnd }),
            ("revoke", None) => Ok(Self::Revoke),
            ("release", None) => Ok(Self::Release),
            ("dispose", None) => Ok(Self::Dispose),
            _ => Err("invalid pet focus command".into()),
        }
    }
}

/// HWND is transmitted as a decimal string to avoid precision loss in JS numbers.
pub fn parse_handle(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|handle| *handle != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        collections::{HashMap, HashSet},
        rc::Rc,
    };

    #[derive(Default)]
    struct Mock {
        foreground: u64,
        identities: HashMap<u64, Identity>,
        ineligible: HashSet<u64>,
        attempts: Vec<u64>,
        clock: u32,
    }

    #[derive(Clone)]
    struct Native(Rc<RefCell<Mock>>);

    impl NativeFocus for Native {
        fn foreground(&self) -> u64 {
            self.0.borrow().foreground
        }
        fn event_clock(&self) -> u32 {
            self.0.borrow().clock
        }
        fn identity(&self, hwnd: u64) -> Option<Identity> {
            self.0.borrow().identities.get(&hwnd).copied()
        }
        fn eligible_identity(&self, hwnd: u64) -> Option<Identity> {
            let mock = self.0.borrow();
            if mock.ineligible.contains(&hwnd) {
                None
            } else {
                mock.identities.get(&hwnd).copied()
            }
        }
        fn activate_once(&self, hwnd: u64) {
            let mut mock = self.0.borrow_mut();
            mock.attempts.push(hwnd);
            mock.foreground = hwnd;
        }
    }

    struct Fixture {
        state: FocusState<Native>,
        native: Rc<RefCell<Mock>>,
    }
    impl Fixture {
        fn new() -> Self {
            let mut mock = Mock {
                foreground: 11,
                ..Mock::default()
            };
            mock.identities.insert(
                11,
                Identity {
                    process: 101,
                    thread: 201,
                },
            );
            mock.identities.insert(
                22,
                Identity {
                    process: 102,
                    thread: 202,
                },
            );
            mock.identities.insert(
                99,
                Identity {
                    process: 103,
                    thread: 203,
                },
            );
            let native = Rc::new(RefCell::new(mock));
            let state =
                FocusState::start(Native(native.clone()), 99).unwrap_or_else(|| unreachable!());
            Self { state, native }
        }
        fn foreground(&self, hwnd: u64) {
            self.native.borrow_mut().foreground = hwnd;
        }
        fn event(&mut self, hwnd: u64) {
            self.native.borrow_mut().clock += 2;
            self.state.on_foreground(hwnd, self.native.borrow().clock);
        }
        fn press(&mut self) {
            self.foreground(99);
            self.event(99);
        }
        fn attempts(&self) -> Vec<u64> {
            self.native.borrow().attempts.clone()
        }
    }

    #[test]
    fn captures_once_only_after_observed_foreground_transfer() {
        let mut f = Fixture::new();
        f.press();
        f.state.release();
        f.state.release();
        assert_eq!(f.attempts(), vec![11]);
        let mut f = Fixture::new();
        f.foreground(99);
        f.state.release();
        assert!(f.attempts().is_empty());
    }

    #[test]
    fn blur_hide_closed_renderer_loss_and_dispose_revoke() {
        for reason in ["blur", "hide", "closed", "renderer", "dispose"] {
            let mut f = Fixture::new();
            f.press();
            if reason == "dispose" || reason == "closed" || reason == "renderer" {
                f.state.dispose();
            } else {
                f.state.revoke();
            }
            f.state.release();
            assert!(f.attempts().is_empty(), "{reason}");
            f.event(11);
            f.press();
            f.state.release();
            if reason == "dispose" || reason == "closed" || reason == "renderer" {
                assert!(f.attempts().is_empty(), "late after {reason}");
            }
        }
    }

    #[test]
    fn intervening_foreground_before_blur_forfeits_return() {
        let mut f = Fixture::new();
        f.press();
        f.foreground(22);
        f.state.release();
        f.foreground(99);
        f.state.release();
        assert!(f.attempts().is_empty());
    }

    #[test]
    fn missing_changed_target_and_reused_overlay_refuse() {
        for changed in ["missing", "process", "thread", "overlay"] {
            let mut f = Fixture::new();
            f.press();
            match changed {
                "missing" => {
                    f.native.borrow_mut().identities.remove(&11);
                }
                "process" => {
                    f.native
                        .borrow_mut()
                        .identities
                        .get_mut(&11)
                        .unwrap()
                        .process = 999;
                }
                "thread" => {
                    f.native
                        .borrow_mut()
                        .identities
                        .get_mut(&11)
                        .unwrap()
                        .thread = 999;
                }
                _ => {
                    f.native.borrow_mut().identities.remove(&99);
                }
            }
            f.state.release();
            assert!(f.attempts().is_empty(), "{changed}");
        }
    }

    #[test]
    fn after_revocation_new_interaction_can_capture_fresh_foreground() {
        let mut f = Fixture::new();
        f.press();
        f.state.revoke();
        f.foreground(22);
        f.event(22);
        f.press();
        f.state.release();
        assert_eq!(f.attempts(), vec![22]);
    }

    #[test]
    fn delayed_foreground_event_cannot_invent_ownership() {
        let mut f = Fixture::new();
        f.foreground(22);
        f.event(99);
        f.foreground(99);
        f.state.release();
        assert!(f.attempts().is_empty());
    }

    #[test]
    fn hidden_disabled_minimized_targets_are_refused_by_native_identity_boundary() {
        for reason in ["hidden", "disabled", "minimized"] {
            let mut f = Fixture::new();
            f.press();
            f.native.borrow_mut().ineligible.insert(11);
            f.state.release();
            assert!(f.attempts().is_empty(), "{reason}");
        }
    }

    #[test]
    fn hidden_overlay_at_start_becomes_eligible_when_shown() {
        let f = Fixture::new();
        f.native.borrow_mut().ineligible.insert(99);
        let mut state =
            FocusState::start(Native(f.native.clone()), 99).unwrap_or_else(|| unreachable!());
        f.native.borrow_mut().ineligible.remove(&99);
        f.foreground(99);
        state.on_foreground(99, 2);
        state.release();
        assert_eq!(f.attempts(), vec![11]);
    }

    #[test]
    fn hook_installation_resamples_current_external_window_before_ready() {
        let mut f = Fixture::new();
        f.foreground(22); // May have changed between constructor and hook registration.
        f.state.hook_installed();
        f.press();
        f.state.release();
        assert_eq!(f.attempts(), vec![22]);
    }

    #[test]
    fn older_external_win_event_cannot_override_latest_observed_target() {
        let mut f = Fixture::new();
        f.foreground(22);
        f.event(22);
        f.state.on_foreground(11, 1); // Delivered late from a different producer thread.
        f.press();
        f.state.release();
        assert_eq!(f.attempts(), vec![22]);
    }

    #[test]
    fn delayed_overlay_callback_after_hide_and_show_cannot_rearm() {
        let mut f = Fixture::new();
        f.press();
        f.state.revoke();
        f.foreground(22);
        f.foreground(99);
        f.event(99);
        f.state.release();
        assert!(f.attempts().is_empty());
        // The following current external observation permits the next genuine pet click.
        f.foreground(22);
        f.event(22);
        f.press();
        f.state.release();
        assert_eq!(f.attempts(), vec![22]);
    }

    #[test]
    fn blur_after_fresh_external_event_does_not_lose_new_foreground_owner() {
        let mut f = Fixture::new();
        f.press();
        f.foreground(22);
        f.event(22);
        f.state.revoke(); // Electron blur follows the WinEvent callback.
        f.press();
        f.state.release();
        assert_eq!(f.attempts(), vec![22]);
    }

    #[test]
    fn callback_generated_before_revocation_is_ignored_after_hide_and_show() {
        let mut f = Fixture::new();
        f.press();
        f.foreground(22);
        f.event(22);
        let delayed_time = f.native.borrow().clock;
        f.state.revoke();
        f.foreground(99);
        f.state.on_foreground(99, delayed_time);
        f.state.release();
        assert!(f.attempts().is_empty());
        f.foreground(22);
        f.event(22);
        f.press();
        f.state.release();
        assert_eq!(f.attempts(), vec![22]);
    }

    #[test]
    fn differential_legacy_js_traces_match_native_actor_decisions() {
        use serde::Deserialize;

        #[derive(Deserialize)]
        struct Trace {
            name: String,
            steps: Vec<Step>,
            attempts: Vec<u64>,
        }
        #[derive(Deserialize)]
        struct Step {
            op: String,
            handle: Option<u64>,
            process: Option<u32>,
            thread: Option<u32>,
        }

        let traces: Vec<Trace> =
            serde_json::from_str(include_str!("../tests/fixtures/pet-focus-traces.json"))
                .unwrap_or_else(|error| panic!("invalid checked-in focus traces: {error}"));
        for trace in traces {
            let mut f = Fixture::new();
            for step in trace.steps {
                match step.op.as_str() {
                    "press" => f.press(),
                    "foreground" => f.foreground(step.handle.unwrap_or_default()),
                    "notify" => f.event(step.handle.unwrap_or_default()),
                    "release" => f.state.release(),
                    "blur" => f.state.revoke(),
                    "hide" => {
                        f.native.borrow_mut().ineligible.insert(99);
                        f.state.revoke();
                    }
                    "destroy" => {
                        f.native.borrow_mut().identities.remove(&99);
                    }
                    "dispose" => f.state.dispose(),
                    "identity_missing" => {
                        f.native
                            .borrow_mut()
                            .identities
                            .remove(&step.handle.unwrap_or_default());
                    }
                    "identity_change" => {
                        f.native.borrow_mut().identities.insert(
                            step.handle.unwrap_or_default(),
                            Identity {
                                process: step.process.unwrap_or_default(),
                                thread: step.thread.unwrap_or_default(),
                            },
                        );
                    }
                    unknown => panic!("invalid checked-in trace operation: {unknown}"),
                }
            }
            assert_eq!(f.attempts(), trace.attempts, "{}", trace.name);
        }
    }

    #[test]
    fn bounded_json_command_validation() {
        assert_eq!(parse_handle("18446744073709551615"), Some(u64::MAX));
        for invalid in ["", "0", "-1", "1.1", "123x", "18446744073709551616"] {
            assert_eq!(parse_handle(invalid), None);
        }
        assert!(serde_json::from_str::<Command>(r#"{"op":"start","hwnd":"99"}"#).is_ok());
        assert!(serde_json::from_str::<Command>(r#"{"op":"start","hwnd":99}"#).is_err());
        assert!(serde_json::from_str::<Command>(r#"{"op":"release","extra":true}"#).is_err());
    }
}
