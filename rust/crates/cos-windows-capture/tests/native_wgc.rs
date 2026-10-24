//! Opt-in Windows compositor proof. Run on an exclusive desktop test lane:
//! cargo test -p cos-windows-capture --test native_wgc -- --ignored --nocapture

use cos_windows_capture::capture;
use image::GenericImageView;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

struct OwnedWindow {
    child: Child,
    output: Receiver<String>,
}

impl OwnedWindow {
    fn start() -> Self {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/wgc_fixture.ps1");
        let mut child = Command::new("powershell.exe")
            .args(["-Sta", "-NoProfile", "-NonInteractive", "-File"])
            .arg(fixture)
            .arg("-ProbeProcessId")
            .arg(std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // PowerShell compilation/startup errors must remain visible in the probe log.
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, output) = mpsc::channel();
        thread::spawn(move || {
            let mut output = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match output.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    _ => {
                        if sender.send(line.trim().to_string()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Self { child, output }
    }

    fn command(&mut self, command: &str) {
        writeln!(self.child.stdin.as_mut().unwrap(), "{command}").unwrap();
        self.child.stdin.as_mut().unwrap().flush().unwrap();
    }

    fn reply(&self) -> String {
        let line = self
            .output
            .recv_timeout(Duration::from_secs(15))
            .expect("owned fixture did not produce a reply within 15 seconds");
        assert!(!line.starts_with("ERROR"), "{line}");
        line
    }

    fn exit(&mut self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return true;
            }
            thread::sleep(Duration::from_millis(25));
        }
        false
    }
}

impl Drop for OwnedWindow {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            if let Some(stdin) = self.child.stdin.as_mut() {
                let _ = writeln!(stdin, "quit");
                let _ = stdin.flush();
            }
            if !self.exit() {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }
}

/// Exact background compositor pixels must differ from the overlaid screen
/// at the same physical coordinate and must leave foreground unchanged.
#[test]
#[ignore = "requires an exclusive unlocked Windows desktop lane"]
fn wgc_window_is_background_and_rejects_minimized_and_closed_hwnds() {
    let mut fixture = OwnedWindow::start();
    let ready = fixture.reply();
    let mut fields = ready.split_whitespace();
    assert_eq!(fields.next(), Some("READY"), "{ready}");
    let target: i64 = fields.next().unwrap().parse().unwrap();
    let cover: i64 = fields.next().unwrap().parse().unwrap();
    let x: i32 = fields.next().unwrap().parse().unwrap();
    let y: i32 = fields.next().unwrap().parse().unwrap();
    assert!(fields.next().is_none());
    let window = capture(&json!({"id":target,"maxWidth":0}), None).unwrap();
    let result = &window.fields;
    assert_eq!(result["captureMode"], "window");
    assert_eq!(result["focused"], false);
    let region = &result["region"];
    let lx = (x - region["x"].as_i64().unwrap() as i32) as u32;
    let ly = (y - region["y"].as_i64().unwrap() as i32) as u32;
    let window_image = image::load_from_memory(&window.png).unwrap();
    assert!(lx < window_image.width() && ly < window_image.height());
    let original = window_image.get_pixel(lx, ly);
    assert_eq!(
        original.0[0..3],
        [128, 0, 128],
        "covered WGC HWND lost own purple content"
    );
    let observed = capture(&json!({"region":{"x":x,"y":y,"width":1,"height":1}}), None).unwrap();
    assert_eq!(observed.fields["captureMode"], "screen");
    let pixel = image::load_from_memory(&observed.png)
        .unwrap()
        .get_pixel(0, 0);
    assert_eq!(
        pixel.0[0..3],
        [0, 255, 255],
        "screen must show owned cyan occluder"
    );
    fixture.command("report");
    assert_eq!(
        fixture.reply(),
        format!("FOREGROUND {cover}"),
        "WGC changed foreground"
    );

    // Ownership must be proven by actual Win32 owner chain, not same-process title or PID.
    let unrelated = capture(&json!({"id":target,"ownerWindow":cover}), None).unwrap_err();
    assert_eq!(unrelated.code, "RELATED_WINDOW_GONE");
    fixture.command("minimize");
    assert_eq!(fixture.reply(), "MINIMIZED");
    let minimized = capture(&json!({"id":target}), None).unwrap_err();
    assert_eq!(minimized.code, "CAPTURE_FAILED");
    fixture.command("close");
    assert_eq!(fixture.reply(), "CLOSED");
    // A closed HWND is invalid; wait for Win32 to actually retire the owned
    // fixture before testing, with observed process exit as the boundary.
    assert!(
        fixture.exit(),
        "owned fixture did not terminate after close"
    );
    let closed = capture(&json!({"id":target}), None).unwrap_err();
    assert_eq!(closed.code, "WINDOW_NOT_FOUND");
}
