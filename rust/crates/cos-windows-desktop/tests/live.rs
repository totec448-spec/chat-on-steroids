//! The Desktop tools on a window this test creates and owns, in this process: screenshot,
//! UI Automation tree, and UIA Invoke and Value through the tools the model calls.
//!
//! The desktop under test is `Desktop::observing_own_windows()`, which has no native effects:
//! it never sends synthetic input, never changes the foreground and never touches the
//! clipboard. A coordinate click is asked for once, to prove it is refused before any input.
//! The window shows without activation and the test checks the foreground never changed.
//!
//! Run with `cargo test -p cos-windows-desktop --test live -- --ignored`.

mod support;

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use base64::Engine as _;
use cos_windows_desktop::Desktop;
use serde_json::{Value, json};
use support::window::{BACKGROUND, BUTTON_CLICKS, OwnedWindow, describe, foreground};
use support::{Served, first_text};

fn tree_index(tree: &str, needle: &str) -> usize {
    let line = tree
        .lines()
        .find(|line| line.contains(needle))
        .unwrap_or_else(|| panic!("{needle} is not in the tree:\n{tree}"));
    line.trim_start_matches('\t')
        .split(':')
        .next()
        .and_then(|index| index.parse().ok())
        .expect("indexed line")
}

async fn until(condition: impl Fn() -> bool) -> bool {
    let since = Instant::now();
    while since.elapsed() < Duration::from_secs(3) {
        if condition() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    condition()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens a window this test owns on the desktop"]
async fn screenshot_tree_invoke_and_value_on_an_owned_window() {
    let before = foreground();
    let owned = OwnedWindow::open();
    assert_eq!(
        foreground(),
        before,
        "showing the owned window activated it"
    );
    let desktop = Desktop::observing_own_windows();
    let served = Served::new("live", &desktop, |config| {
        config["multiAgent"]["allowUnattributedCalls"] = json!(true);
    });

    let window = served
        .call("get_window", json!({"id": owned.hwnd}))
        .await
        .expect("listed");
    assert_ne!(window["isError"], true, "{window}");
    let window = window["structuredContent"]["value"].clone();
    assert_eq!(window["title"], "cos-d3-target");
    assert_eq!(window["state"], "open");
    let exe = std::env::current_exe()
        .expect("test exe")
        .to_string_lossy()
        .to_lowercase();
    assert_eq!(window["app"], exe.as_str());
    let target = json!({"app": window["app"], "id": owned.hwnd});

    // Screenshot and accessibility tree in one observation.
    let state = served
        .call(
            "get_window_state",
            json!({"window": target, "include_text": true}),
        )
        .await
        .expect("listed");
    assert_ne!(state["isError"], true, "{}", first_text(&state));
    let value = &state["structuredContent"]["value"];
    let shot = &value["screenshots"][0];
    assert_eq!(shot["id"], "frame-1", "{value}");
    let png = base64::engine::general_purpose::STANDARD
        .decode(state["content"][1]["data"].as_str().expect("image block"))
        .expect("base64");
    let image = image::load_from_memory(&png).expect("png").into_rgb8();
    assert_eq!(
        i64::from(image.width()),
        shot["width"].as_i64().expect("width")
    );
    assert_eq!(
        i64::from(image.height()),
        shot["height"].as_i64().expect("height")
    );
    let (sx, sy) = owned.client_to_screen(300, 200);
    let (px, py) = (
        sx - shot["originX"].as_i64().expect("x"),
        sy - shot["originY"].as_i64().expect("y"),
    );
    let pixel = image.get_pixel(px as u32, py as u32).0;
    assert!(
        pixel
            .iter()
            .zip(BACKGROUND)
            .all(|(got, want)| got.abs_diff(want) <= 2),
        "client background at ({px},{py}) is {pixel:?}"
    );
    let tree = value["accessibility"]["tree"].as_str().expect("tree");
    let button = tree_index(tree, "Button \"cos-d3-button\" [Invoke");
    assert!(tree.contains("Edit "), "{tree}");
    let edit = tree_index(tree, "Edit ");

    // A Win32 button handles BM_CLICK by taking focus, which would activate this window and
    // take the foreground from the user. Capture needs an activatable window, so the window
    // becomes non-activating only now.
    owned.set_activatable(false);

    // UIA Invoke presses the button through its pattern.
    let invoked = served
        .call(
            "perform_secondary_action",
            json!({"window": target, "element_index": button, "action": "invoke"}),
        )
        .await
        .expect("listed");
    assert_eq!(
        first_text(&invoked),
        "perform_secondary_action: input accepted; observe to verify the result.",
        "{invoked}"
    );
    assert!(
        until(|| BUTTON_CLICKS.load(Ordering::SeqCst) == 1).await,
        "the button saw no click"
    );
    assert_eq!(
        foreground(),
        before,
        "Invoke changed the foreground to {} (owned window {})",
        describe(foreground()),
        owned.hwnd
    );

    // Input consumed the observation, so its indexes no longer authorize anything.
    let stale = served
        .call(
            "set_value",
            json!({"window": target, "element_index": edit, "value": "x"}),
        )
        .await
        .expect("listed");
    assert_eq!(
        stale["structuredContent"]["error"]["code"], "STALE_WINDOW_STATE",
        "{stale}"
    );

    // UIA Value replaces the edit text.
    let text_only = served
        .call(
            "get_window_state",
            json!({"window": target, "include_screenshot": false, "include_text": true}),
        )
        .await
        .expect("listed");
    let tree = text_only["structuredContent"]["value"]["accessibility"]["tree"]
        .as_str()
        .expect("tree")
        .to_owned();
    let edit = tree_index(&tree, "Edit ");
    let typed = "set by UIA, ünïcode ✓";
    let set = served
        .call(
            "set_value",
            json!({"window": target, "element_index": edit, "value": typed}),
        )
        .await
        .expect("listed");
    assert_eq!(
        first_text(&set),
        "set_value: input accepted; observe to verify the result.",
        "{set}"
    );
    assert!(
        until(|| owned.edit_text() == typed).await,
        "edit holds {:?}",
        owned.edit_text()
    );
    assert_eq!(
        foreground(),
        before,
        "SetValue changed the foreground (owned window {})",
        owned.hwnd
    );

    // A coordinate click is refused before any input reaches a window.
    owned.set_activatable(true);
    let observed = served
        .call(
            "get_window_state",
            json!({"window": target, "include_text": false}),
        )
        .await
        .expect("listed");
    assert_ne!(observed["isError"], true, "{}", first_text(&observed));
    let clicked = served
        .call("click", json!({"window": target, "x": 300, "y": 200}))
        .await
        .expect("listed");
    assert_eq!(clicked["isError"], true, "{clicked}");
    let refusal: &Value = &clicked["content"][0]["text"];
    let refusal = refusal.as_str().unwrap_or_default();
    assert!(
        refusal.contains("FOCUS_FAILED") || refusal.contains("INPUT_REFUSED"),
        "{refusal}"
    );
    assert_eq!(BUTTON_CLICKS.load(Ordering::SeqCst), 1);

    assert_eq!(foreground(), before, "the foreground window changed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens a window this test owns on the desktop"]
async fn a_capture_after_an_earlier_desktop_thread_exited_still_works() {
    let owned = OwnedWindow::open();
    let exe = std::env::current_exe()
        .expect("test exe")
        .to_string_lossy()
        .to_lowercase();
    let state = json!({"window": {"app": exe, "id": owned.hwnd}, "include_text": false});
    for round in 0..3 {
        // Each round's desktop thread leaves COM when its desktop drops.
        let served = Served::new("live-rounds", &Desktop::observing_own_windows(), |_| {});
        let observed = served
            .call("get_window_state", state.clone())
            .await
            .expect("listed");
        assert_ne!(
            observed["isError"],
            true,
            "round {round}: {}",
            first_text(&observed)
        );
        assert_eq!(observed["content"][1]["type"], "image", "round {round}");
    }
}
