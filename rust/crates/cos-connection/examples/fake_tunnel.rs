//! A stand-in for `tunnel-client` and `cloudflared` in this crate's tests. It never contacts
//! any network beyond its own loopback health server.
//!
//! The tests copy it under the real executable names onto a fake `PATH`. It appends its argv
//! and environment as a `call-<time>-<pid>.json` file beside itself, then acts out
//! `FAKE_TUNNEL_MODE`: `ready` (the default) serves a healthy client, `auth` logs a rejected
//! control-plane poll, `exit` logs an error and exits (cloudflared after a burst of output).
//! Otherwise it runs until it is killed.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn main() {
    let exe = std::env::current_exe().expect("own path");
    let args: Vec<String> = std::env::args().skip(1).collect();
    record(&exe, &args);
    let mode = std::env::var("FAKE_TUNNEL_MODE").unwrap_or_else(|_| "ready".to_owned());
    let name = exe.file_stem().and_then(|stem| stem.to_str()).unwrap_or("");
    match (name, mode.as_str()) {
        ("cloudflared", "exit") => {
            // More than a pipe buffer of output, so the error line is still unread in the
            // pipe when the process has already exited.
            let mut stderr = std::io::stderr().lock();
            for _ in 0..2000 {
                let _ = writeln!(
                    stderr,
                    "2026-10-20T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..."
                );
            }
            let _ = writeln!(
                stderr,
                "2026-10-20T00:00:00Z ERR failed to reach the edge: connection refused"
            );
            drop(stderr);
            std::process::exit(1);
        }
        ("cloudflared", _) => {
            eprintln!("2026-10-20T00:00:00Z INF |  https://fake-quick.trycloudflare.com  |");
        }
        (_, "auth") => {
            println!(
                r#"{{"level":"ERROR","msg":"poll failed","error":"controlplane client: unexpected status 401","status_code":401}}"#
            );
        }
        (_, "exit") => {
            println!(r#"{{"level":"ERROR","msg":"mcp probe failed","error":"boom"}}"#);
            std::process::exit(3);
        }
        _ => serve_health(&args),
    }
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

fn record(exe: &Path, args: &[String]) {
    let env: serde_json::Map<String, serde_json::Value> = std::env::vars()
        .map(|(key, value)| (key, serde_json::Value::String(value)))
        .collect();
    let line = serde_json::json!({ "program": exe.file_stem().map(|s| s.to_string_lossy()), "args": args, "env": env });
    // One file per launch: launches running at once never interleave their records.
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let file = exe.with_file_name(format!("call-{at:024}-{}.json", std::process::id()));
    std::fs::write(file, line.to_string()).expect("records");
}

fn serve_health(args: &[String]) {
    let url_file = args
        .iter()
        .position(|arg| arg == "--health.url-file")
        .and_then(|at| args.get(at + 1))
        .map(PathBuf::from)
        .expect("--health.url-file");
    let listener = TcpListener::bind("127.0.0.1:0").expect("binds");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    std::fs::write(&url_file, format!("{base}/\n")).expect("health url");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request = [0u8; 2048];
            let read = stream.read(&mut request).unwrap_or(0);
            let request = String::from_utf8_lossy(&request[..read]);
            let path = request.split_whitespace().nth(1).unwrap_or("/");
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            let body = match path {
                "/readyz" => "ok".to_owned(),
                "/metrics" => format!(
                    "# HELP x\ncommands_poll_last_successful_timestamp_seconds {now}\ncommands_poll_cycles_total 4\ncommands_poll_errors_total{{error_kind=\"timeout\"}} 1\ncommands_poll_errors_total{{error_kind=\"dns\"}} 1\n"
                ),
                "/api/status" => r#"{"version":"0.9.0-fake","uptime_seconds":12,"channels":[{"name":"main","probe_status":"ok"}],"control_plane_route":{"target":"api.openai.com:443","route_mode":"direct","proxy_source":"none"}}"#.to_owned(),
                _ => String::new(),
            };
            let status = if body.is_empty() {
                "404 Not Found"
            } else {
                "200 OK"
            };
            let _ = write!(
                stream,
                "HTTP/1.0 {status}\r\nContent-Type: text/plain\r\n\r\n{body}"
            );
        }
    });
}
