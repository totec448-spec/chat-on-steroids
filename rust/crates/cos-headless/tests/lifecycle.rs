//! Drives the real binary the way the golden recorder does: an isolated profile, the
//! recorder's extra Chromium flags, then a second launch and a graceful `--quit`.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use cos_store::{Acquired, Instance};

const BINARY: &str = env!("CARGO_BIN_EXE_cos-headless");

fn profile(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn launch(profile: &Path, extra: &[&str]) -> Child {
    Command::new(BINARY)
        .arg(format!("--user-data-dir={}", profile.display()))
        .args(["--lang=en-US", "--remote-debugging-port=0"])
        .args(extra)
        .env("CLF_BRIDGE_PORTS", "0")
        .env("COS_MCP_URLS_FILE", profile.join("mcp-urls.json"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("cos-headless starts")
}

fn wait(child: &mut Child, limit: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("polls") {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    None
}

fn wait_for(file: &Path, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if file.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

#[test]
fn starts_holds_the_profile_forwards_later_launches_and_quits_cleanly() {
    let profile = profile("lifecycle");
    let mut primary = launch(&profile, &[]);
    assert!(
        wait_for(&profile.join("instance.json"), Duration::from_secs(20)),
        "the primary never published its instance endpoint"
    );

    let mut second = launch(&profile, &[]);
    let forwarded = wait(&mut second, Duration::from_secs(20)).expect("second launch exits");
    assert!(forwarded.success(), "a forwarded launch exits 0");
    assert_eq!(
        primary.try_wait().expect("polls"),
        None,
        "the primary stopped"
    );

    let mut quit = launch(&profile, &["--quit"]);
    assert!(
        wait(&mut quit, Duration::from_secs(20))
            .expect("--quit exits")
            .success()
    );
    let stopped = wait(&mut primary, Duration::from_secs(60));
    if stopped.is_none() {
        let _ = primary.kill();
    }
    assert!(stopped.expect("the primary stops after --quit").success());

    let log = std::fs::read_to_string(profile.join("app.log")).expect("app.log was written");
    assert!(log.contains("core started in"), "{log}");
    assert!(
        log.contains("shutdown UpdateHandoff"),
        "the sequence did not finish: {log}"
    );

    match Instance::acquire(&profile, &[]).expect("acquires") {
        Acquired::Primary(_) => {}
        Acquired::Forwarded => panic!("the profile lock outlived the process"),
    }
}

#[test]
fn quit_with_nothing_running_starts_nothing() {
    let profile = profile("quit-alone");
    let mut quit = launch(&profile, &["--quit"]);
    assert!(
        wait(&mut quit, Duration::from_secs(20))
            .expect("exits")
            .success()
    );
    assert!(!profile.join("app.log").exists(), "a Core started");
}
