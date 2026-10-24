//! A Core started with "ignore Ctrl-C" set, as Git Bash starts programs, still lets Ctrl-C end a
//! terminal session. Its own test binary, because the flag is process-wide.

#![cfg(windows)]

mod support;

use serde_json::json;
use support::{Scratch, call, exec, no_policy};

#[test]
fn ctrl_c_reaches_a_terminal_session_of_a_core_started_ignoring_it() {
    // SAFETY: a null handler with `true` only sets this process's ignore flag.
    unsafe { windows::Win32::System::Console::SetConsoleCtrlHandler(None, true) }
        .expect("sets the inherited flag");
    let scratch = Scratch::new("ctrl-c", no_policy());
    let (core, url) = scratch.start();

    let started = exec(
        &url,
        1,
        json!({ "cmd": "ping -n 60 127.0.0.1", "workdir": "/project", "tty": true, "yield_time_ms": 2000 }),
    );
    let session = started["structuredContent"]["session_id"]
        .as_u64()
        .unwrap_or_else(|| panic!("still running: {started}"));
    // A Ctrl-C that arrives before ping runs proves nothing either way.
    let mut seen = started["structuredContent"]["output"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let mut id = 1;
    while !seen.contains("Reply from") {
        id += 1;
        let polled = call(
            &url,
            id,
            "write_stdin",
            json!({ "session_id": session, "chars": "" }),
        );
        let polled = &polled["structuredContent"];
        assert!(
            polled.get("session_id").is_some(),
            "ping ended early: {polled}"
        );
        seen.push_str(polled["output"].as_str().unwrap_or_default());
    }
    let ended = call(
        &url,
        id + 1,
        "write_stdin",
        json!({ "session_id": session, "chars": "\u{3}", "yield_time_ms": 5000 }),
    );
    core.shutdown();

    assert!(
        ended["structuredContent"]
            .get("completed_session_id")
            .is_some(),
        "{ended}"
    );
}
