//! Replays the recorded `desktop` calls of the Window2 and clipboard tools through the real
//! kernel and the real tools, and compares the whole result, key order included, with the
//! corpus.
//!
//! Calls that refuse before reaching a window run by default. The calls that observe the
//! recorder's own target window run with `--ignored`: they open that same WinForms window
//! (`openTargetWindow` in `scripts/golden/app.mjs`), which never takes focus and receives no
//! input, and close it afterwards.

mod support;

use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use cos_windows_desktop::Desktop;
use serde_json::Value;
use support::{Served, desktop_cases, first_difference, normalize_hwnd, with_hwnd};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
};
use windows::core::BOOL;

fn needs_window(case: &Value) -> bool {
    let response = serde_json::to_string(&case["response"]).expect("serializes");
    response.contains("<HWND>") || response.contains("<IMAGE_DATA>")
}

/// The cases whose result differs from the recording, each with where it first differs.
async fn replay(served: &Served, cases: &[(String, Value)], hwnd: i64) -> Vec<(String, String)> {
    let mut failures = Vec::new();
    for (name, case) in cases {
        let tool = case["request"]["tool"].as_str().expect("tool");
        let arguments = with_hwnd(&case["request"]["arguments"], hwnd);
        let expected =
            serde_json::to_string(&case["response"]["messages"][0]["result"]).expect("serializes");
        let actual = match served.call(tool, arguments).await {
            Ok(result) => {
                serde_json::to_string(&normalize_hwnd(&result, hwnd)).expect("serializes")
            }
            Err(unknown) => unknown,
        };
        if expected != actual {
            failures.push((name.clone(), first_difference(&expected, &actual)));
        }
    }
    failures
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recorded_refusals_and_missing_windows_match_the_corpus() {
    let desktop = Desktop::observing_own_windows();
    let served = Served::new("golden-refusals", &desktop, |_| {});
    let cases: Vec<_> = desktop_cases()
        .into_iter()
        .filter(|(_, case)| !needs_window(case))
        .collect();
    let names: Vec<&str> = cases.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(cases.len(), 15, "{names:?}");
    // Window 1 does not exist, so a handle in a refused call's arguments reaches no window.
    let failures = replay(&served, &cases, 1).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The recorder's target: a WinForms form that shows without activation.
struct RecorderTarget {
    child: Child,
    hwnd: i64,
}

const TARGET_WINDOW: &str = "Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition 'public class GoldenTarget : System.Windows.Forms.Form { protected override bool ShowWithoutActivation { get { return true; } } }'
$f = New-Object GoldenTarget; $f.Text = 'cos-golden-target'; $f.StartPosition = 'Manual'; $f.SetBounds(40, 40, 480, 320)
$b = New-Object System.Windows.Forms.Button; $b.Text = 'golden-button'; $b.SetBounds(20, 20, 160, 40); $f.Controls.Add($b)
$t = New-Object System.Windows.Forms.TextBox; $t.Name = 'golden-field'; $t.Text = 'golden-text'; $t.SetBounds(20, 80, 200, 24); $f.Controls.Add($t)
[System.Windows.Forms.Application]::Run($f)";

/// The first visible top-level window of `pid`. Reads only each window's owner pid.
fn visible_window_of(pid: u32) -> Option<i64> {
    struct Search {
        pid: u32,
        found: Option<i64>,
    }
    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
        // SAFETY: `data` points at this call's `Search` for the synchronous enumeration.
        let search = unsafe { &mut *(data.0 as *mut Search) };
        let mut owner = 0;
        // SAFETY: query calls on a handle the enumeration supplied.
        if unsafe { IsWindowVisible(hwnd) }.as_bool()
            && unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner)) } != 0
            && owner == search.pid
        {
            search.found = Some(hwnd.0 as i64);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut search = Search { pid, found: None };
    // SAFETY: the callback only touches `search`, which outlives the enumeration.
    let _ = unsafe { EnumWindows(Some(visit), LPARAM(&raw mut search as isize)) };
    search.found
}

impl RecorderTarget {
    fn open() -> Self {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", TARGET_WINDOW])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("powershell starts");
        // Owned before the wait, so a timeout's panic still kills and reaps it.
        let mut target = Self { child, hwnd: 0 };
        let since = Instant::now();
        while since.elapsed() < Duration::from_secs(20) {
            if let Some(hwnd) = visible_window_of(target.child.id()) {
                // Let the form finish its first layout before it is observed.
                std::thread::sleep(Duration::from_millis(500));
                target.hwnd = hwnd;
                return target;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("the recorder target window never appeared");
    }
}

impl Drop for RecorderTarget {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens the recorder's own target window on the desktop"]
async fn recorded_observations_of_the_recorder_target_match_the_corpus() {
    let target = RecorderTarget::open();
    let desktop = Desktop::observing_own_windows();
    let served = Served::new("golden-target", &desktop, |_| {});
    let cases: Vec<_> = desktop_cases()
        .into_iter()
        .filter(|(_, case)| needs_window(case))
        .collect();
    let names: Vec<&str> = cases.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(cases.len(), 4, "{names:?}");
    // Case 04 holds the managed System.Windows.Automation client's names and edit text, which
    // cos-windows-uia emulates on top of native UIA (`managed.rs`).
    let failures = replay(&served, &cases, target.hwnd).await;
    assert!(failures.is_empty(), "{failures:#?}");
}
