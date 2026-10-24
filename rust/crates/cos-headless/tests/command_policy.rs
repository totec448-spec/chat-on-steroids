//! The user's command policy, end to end through the Core MCP endpoint: a seeded allowlist is
//! enforced by the `cos-headless` binary, and a Settings save changes what the running Core
//! admits on the next call, without a restart.

mod support;

use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{Scratch, allow_only, exec, first_text, no_policy};

const REFUSED: &str = "COMMAND_NOT_ALLOWED: the command did not match any allow rule. No allowlist rule matched the executable and complete argument list. No command was run. Change the command policy in Settings if this launch should be permitted.";

/// Kills the process tree if a failed assertion leaves it running.
struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(None) = self.0.try_wait() {
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &self.0.id().to_string()])
                .status();
        }
    }
}

fn wait_for_core_url(file: &Path, child: &mut Child) -> String {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Ok(bytes) = std::fs::read(file)
            && let Ok(urls) = serde_json::from_slice::<Value>(&bytes)
            && let Some(core) = urls["core"].as_str()
        {
            return core.to_owned();
        }
        if let Ok(Some(status)) = child.try_wait() {
            panic!("cos-headless exited early: {status}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("cos-headless never published a Core URL");
}

#[test]
fn the_headless_core_enforces_the_saved_allowlist() {
    let scratch = Scratch::new("policy", allow_only("echo allowed"));
    let urls = scratch.0.join("mcp-urls.json");
    let profile = format!("--user-data-dir={}", scratch.profile().display());
    let mut child = Running(
        Command::new(env!("CARGO_BIN_EXE_cos-headless"))
            .arg(&profile)
            .env("COS_MCP_URLS_FILE", &urls)
            .env("CLF_BRIDGE_PORTS", "0")
            .env("HTTP_PROXY", "http://127.0.0.1:9")
            .env("HTTPS_PROXY", "http://127.0.0.1:9")
            .spawn()
            .expect("starts cos-headless"),
    );
    let core = wait_for_core_url(&urls, &mut child.0);

    let refused = exec(
        &core,
        1,
        json!({ "cmd": "echo refused", "workdir": "/project" }),
    );
    let allowed = exec(
        &core,
        2,
        json!({ "cmd": "echo allowed", "workdir": "/project" }),
    );

    let quit = Command::new(env!("CARGO_BIN_EXE_cos-headless"))
        .args([profile.as_str(), "--quit"])
        .status()
        .expect("runs --quit");
    assert!(quit.success());
    let stopped = child.0.wait().expect("cos-headless exits");
    assert!(stopped.success(), "{stopped}");

    assert_eq!(refused["isError"], true, "{refused}");
    assert_eq!(first_text(&refused), REFUSED);
    assert_eq!(allowed.get("isError"), None, "{allowed}");
    assert_eq!(allowed["structuredContent"]["exit_code"], 0, "{allowed}");
    assert_eq!(allowed["structuredContent"]["output"], "allowed\r\n");
}

#[test]
fn a_settings_save_changes_the_policy_of_the_next_call() {
    let scratch = Scratch::new("live-policy", no_policy());
    let (core, url) = scratch.start();
    let app = core.app();
    let before = exec(
        &url,
        1,
        json!({ "cmd": "echo refused", "workdir": "/project" }),
    );

    let mut form = serde_json::to_value(&**app.watches().config.borrow()).expect("serializes");
    let base = form.clone();
    form["commandAllowlist"] = allow_only("echo allowed");
    let saved = core
        .block_on(app.spawn(move |domains| async move {
            domains
                .settings
                .save(json!({ "base": base, "patch": form }))
                .await
        }))
        .expect("the save ran");
    assert!(saved.is_ok(), "{saved:?}");

    let after = exec(
        &url,
        2,
        json!({ "cmd": "echo refused", "workdir": "/project" }),
    );
    let allowed = exec(
        &url,
        3,
        json!({ "cmd": "echo allowed", "workdir": "/project" }),
    );
    core.shutdown();

    assert_eq!(before["structuredContent"]["exit_code"], 0, "{before}");
    assert_eq!(after["isError"], true, "{after}");
    assert_eq!(first_text(&after), REFUSED);
    assert_eq!(allowed["structuredContent"]["exit_code"], 0, "{allowed}");
}
