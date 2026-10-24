//! The single-instance lock across real processes. Each child is this test binary re-run in
//! child mode: no window, no Electron.

mod common;

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use common::Scratch;
use cos_store::{Acquired, Instance};

const CHILD_ENV: &str = "COS_STORE_INSTANCE_DIR";
const ARGV_ENV: &str = "COS_STORE_INSTANCE_ARGV";
const WAIT: Duration = Duration::from_secs(20);

/// Child mode: takes the folder or forwards, and reports what happened on stdout.
#[test]
fn instance_child() {
    let Ok(dir) = std::env::var(CHILD_ENV) else {
        return;
    };
    let argv: Vec<String> =
        serde_json::from_str(&std::env::var(ARGV_ENV).expect("argv")).expect("argv json");
    match Instance::acquire(Path::new(&dir), &argv).expect("acquires or forwards") {
        Acquired::Forwarded => println!("child: forwarded"),
        Acquired::Primary(instance) => {
            println!("child: primary");
            match instance.second_launches().recv_timeout(WAIT) {
                Ok(argv) => println!(
                    "child: received {}",
                    serde_json::to_string(&argv).expect("json")
                ),
                Err(_) => println!("child: none"),
            }
        }
    }
}

struct Running {
    child: Child,
    lines: mpsc::Receiver<String>,
}

impl Running {
    fn start(dir: &Path, argv: &[&str]) -> Self {
        let mut command = Command::new(std::env::current_exe().expect("test binary"));
        command
            .args([
                "instance_child",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_ENV, dir)
            .env(ARGV_ENV, serde_json::to_string(argv).expect("json"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        let mut child = command.spawn().expect("spawns");
        let stdout: ChildStdout = child.stdout.take().expect("stdout");
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                // libtest prints the test name on the same line as the first report.
                if let Some((_, report)) = line.split_once("child: ") {
                    let _ = sender.send(report.to_owned());
                }
            }
        });
        Self { child, lines }
    }

    fn next(&self) -> String {
        self.lines.recv_timeout(WAIT).expect("the child reports")
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn a_second_launch_on_the_same_folder_forwards_its_command_line_and_exits() {
    let scratch = Scratch::new("instance-same");
    let first = Running::start(scratch.path(), &["cos.exe"]);
    assert_eq!(first.next(), "primary");
    let mut second = Running::start(scratch.path(), &["cos.exe", "--background", "chat://open"]);
    assert_eq!(second.next(), "forwarded");
    assert!(second.child.wait().expect("exits").success());
    assert_eq!(
        first.next(),
        r#"received ["cos.exe","--background","chat://open"]"#
    );
}

#[test]
fn launches_on_different_folders_both_run() {
    let (a, b) = (Scratch::new("instance-a"), Scratch::new("instance-b"));
    let first = Running::start(a.path(), &["cos.exe"]);
    let second = Running::start(b.path(), &["cos.exe"]);
    assert_eq!(first.next(), "primary");
    assert_eq!(second.next(), "primary");
}

#[test]
fn a_killed_owner_leaves_nothing_the_next_launch_must_clean_up() {
    let scratch = Scratch::new("instance-crash");
    let mut first = Running::start(scratch.path(), &["cos.exe"]);
    assert_eq!(first.next(), "primary");
    first.child.kill().expect("kills");
    first.child.wait().expect("exits");
    let second = Running::start(scratch.path(), &["cos.exe"]);
    assert_eq!(second.next(), "primary");
    let third = Running::start(scratch.path(), &["cos.exe", "again"]);
    assert_eq!(third.next(), "forwarded");
    assert_eq!(second.next(), r#"received ["cos.exe","again"]"#);
}

#[test]
fn a_launch_with_a_wrong_token_is_ignored() {
    use std::io::Write;
    let scratch = Scratch::new("instance-token");
    let first = Running::start(scratch.path(), &["cos.exe"]);
    assert_eq!(first.next(), "primary");
    let endpoint: serde_json::Value = serde_json::from_slice(
        &std::fs::read(scratch.path().join("instance.json")).expect("endpoint"),
    )
    .expect("json");
    let port = endpoint["port"].as_u64().expect("port") as u16;
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connects");
    stream
        .write_all(b"{\"token\":\"guess\",\"argv\":[\"evil\"]}\n")
        .expect("writes");
    drop(stream);
    let real = Running::start(scratch.path(), &["cos.exe", "real"]);
    assert_eq!(real.next(), "forwarded");
    assert_eq!(first.next(), r#"received ["cos.exe","real"]"#);
}

/// A launch on a folder whose owner is alive must not become a second owner, whatever was
/// deleted under it.
fn assert_not_primary(dir: &Path) {
    match Instance::acquire(dir, &["cos.exe".to_owned()]) {
        Ok(Acquired::Primary(_)) => panic!("a second launch took a folder whose owner still runs"),
        Ok(Acquired::Forwarded) | Err(_) => {}
    }
}

#[cfg(windows)]
#[test]
fn a_held_folder_and_its_lock_cannot_be_deleted_or_moved() {
    let scratch = Scratch::new("instance-delete");
    let first = Running::start(scratch.path(), &["cos.exe"]);
    assert_eq!(first.next(), "primary");
    let lock = scratch.path().join("instance.lock");
    assert!(
        std::fs::remove_file(&lock).is_err(),
        "the lock file was deleted"
    );
    assert!(
        std::fs::rename(scratch.path(), scratch.path().with_extension("moved")).is_err(),
        "the folder was moved"
    );
    assert!(
        std::fs::remove_dir_all(scratch.path()).is_err(),
        "the folder was deleted"
    );
    assert!(lock.exists(), "the lock file is still there");
    assert_not_primary(scratch.path());
}

#[test]
fn a_launch_that_cannot_reach_a_live_owner_fails_instead_of_taking_the_folder() {
    let scratch = Scratch::new("instance-endpoint-gone");
    let mut first = Running::start(scratch.path(), &["cos.exe"]);
    assert_eq!(first.next(), "primary");
    std::fs::remove_file(scratch.path().join("instance.json")).expect("deletes the endpoint");
    let error = match Instance::acquire(scratch.path(), &["cos.exe".to_owned()]) {
        Err(error) => error,
        Ok(Acquired::Primary(_)) => panic!("a second launch took a folder whose owner still runs"),
        Ok(Acquired::Forwarded) => panic!("forwarded with no endpoint to forward to"),
    };
    assert!(
        error
            .to_string()
            .contains("another process holds this folder"),
        "{error}"
    );
    first.child.kill().expect("kills");
    first.child.wait().expect("exits");
    let next = Running::start(scratch.path(), &["cos.exe"]);
    assert_eq!(
        next.next(),
        "primary",
        "the folder is free once its owner exits"
    );
}
