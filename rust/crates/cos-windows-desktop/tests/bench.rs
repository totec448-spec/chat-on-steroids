//! Latency of `list_windows` and a window screenshot: the in-process tools against the
//! sidecar process they replace. Prints one line per measurement.
//!
//! Build the sidecar from the commit before its removal, then run this binary directly so no
//! cargo process competes with it:
//! `COS_OLD_SIDECAR=<path to cos-windows-desktop.exe> <bench test exe> --ignored --nocapture`.

mod support;

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine as _;
use cos_windows_desktop::Desktop;
use serde_json::{Value, json};
use support::Served;
use support::window::OwnedWindow;

const RUNS: usize = 30;

fn report(label: &str, mut samples: Vec<Duration>) {
    samples.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    println!(
        "{label}: n={} median={:.2} ms min={:.2} ms max={:.2} ms",
        samples.len(),
        ms(samples[samples.len() / 2]),
        ms(samples[0]),
        ms(samples[samples.len() - 1])
    );
}

async fn timed(served: &Served, tool: &str, arguments: &Value) -> Duration {
    let started = Instant::now();
    let result = served.call(tool, arguments.clone()).await.expect("listed");
    let elapsed = started.elapsed();
    assert_ne!(result["isError"], true, "{result}");
    elapsed
}

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Sidecar {
    fn spawn(path: &str) -> Self {
        let mut child = Command::new(path)
            .env_remove("COS_APP_PID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("sidecar starts");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdin,
            stdout,
        }
    }

    fn request(&mut self, request: &Value) -> Value {
        let mut line = serde_json::to_vec(request).expect("serializes");
        line.push(b'\n');
        self.stdin.write_all(&line).expect("request sent");
        self.stdin.flush().expect("flushed");
        let mut reply = String::new();
        self.stdout.read_line(&mut reply).expect("reply read");
        let reply: Value = serde_json::from_str(&reply).expect("reply json");
        assert_eq!(reply["ok"], true, "{reply}");
        reply
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// What the TypeScript caller did after a capture reply: read the PNG and base64 it.
fn sidecar_capture(sidecar: &mut Sidecar, hwnd: i64, file: &std::path::Path) {
    sidecar.request(&json!({"op": "capture", "id": hwnd, "file": file, "maxWidth": 1280}));
    let png = std::fs::read(file).expect("png written");
    assert!(
        !base64::engine::general_purpose::STANDARD
            .encode(png)
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens a window this test owns and times desktop calls"]
async fn in_process_against_sidecar_latency() {
    let owned = OwnedWindow::open();
    let state = json!({"window": {"app": std::env::current_exe().expect("exe").to_string_lossy().to_lowercase(), "id": owned.hwnd},
        "include_screenshot": true, "include_text": false});
    let list = json!({});

    // Cold: a new desktop whose thread, COM apartment and UIA start inside the first call.
    let (mut cold_list, mut cold_shot) = (Vec::new(), Vec::new());
    for _ in 0..20 {
        let served = Served::new("bench-cold", &Desktop::observing_own_windows(), |_| {});
        cold_list.push(timed(&served, "list_windows", &list).await);
        let served = Served::new("bench-cold", &Desktop::observing_own_windows(), |_| {});
        cold_shot.push(timed(&served, "get_window_state", &state).await);
    }
    report("in-process cold list_windows", cold_list);
    report("in-process cold get_window_state screenshot", cold_shot);

    let served = Served::new("bench-warm", &Desktop::observing_own_windows(), |_| {});
    timed(&served, "list_windows", &list).await;
    let (mut warm_list, mut warm_shot) = (Vec::new(), Vec::new());
    for _ in 0..RUNS {
        warm_list.push(timed(&served, "list_windows", &list).await);
        warm_shot.push(timed(&served, "get_window_state", &state).await);
    }
    report("in-process warm list_windows", warm_list);
    report("in-process warm get_window_state screenshot", warm_shot);

    let Ok(path) = std::env::var("COS_OLD_SIDECAR") else {
        println!("COS_OLD_SIDECAR is not set; sidecar not measured");
        return;
    };
    let file = std::env::temp_dir().join(format!("cos-d3-bench-{}.png", std::process::id()));
    let (mut spawn_list, mut spawn_shot) = (Vec::new(), Vec::new());
    for _ in 0..20 {
        let started = Instant::now();
        let mut sidecar = Sidecar::spawn(&path);
        sidecar.request(&json!({"op": "windows"}));
        spawn_list.push(started.elapsed());
        drop(sidecar);
        let started = Instant::now();
        let mut sidecar = Sidecar::spawn(&path);
        sidecar_capture(&mut sidecar, owned.hwnd, &file);
        spawn_shot.push(started.elapsed());
    }
    report("sidecar spawn+first windows", spawn_list);
    report("sidecar spawn+first capture+read+base64", spawn_shot);

    let mut sidecar = Sidecar::spawn(&path);
    sidecar.request(&json!({"op": "warm"}));
    let (mut warm_list, mut warm_shot) = (Vec::new(), Vec::new());
    for _ in 0..RUNS {
        let started = Instant::now();
        sidecar.request(&json!({"op": "windows"}));
        warm_list.push(started.elapsed());
        let started = Instant::now();
        sidecar_capture(&mut sidecar, owned.hwnd, &file);
        warm_shot.push(started.elapsed());
    }
    report("sidecar warm windows", warm_list);
    report("sidecar warm capture+read+base64", warm_shot);
    let _ = std::fs::remove_file(file);
}
