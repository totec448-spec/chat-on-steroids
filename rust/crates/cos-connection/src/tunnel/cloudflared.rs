//! A cloudflared quick tunnel. It creates a public URL, so the secret path token in that URL
//! is what keeps the connector private.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

use cos_types::app_state::ConnectionState;
use regex::Regex;
use tokio::sync::oneshot;

use super::process;
use super::{Launch, TunnelReport, os};

const STARTUP_LIMIT: Duration = Duration::from_secs(45);

static QUICK_TUNNEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)https://[a-z0-9-]+\.trycloudflare\.com")
        .unwrap_or_else(|error| panic!("quick tunnel pattern: {error}"))
});
static ERROR_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\berr\b|\berror\b|\bfatal\b")
        .unwrap_or_else(|error| panic!("error pattern: {error}"))
});

/// The local URL split into its origin, its host and its path.
struct Local<'a> {
    origin: &'a str,
    host: &'a str,
    path: &'a str,
}

fn split(url: &str) -> Option<Local<'_>> {
    let scheme_end = url.find("://")? + 3;
    let path_start = url[scheme_end..]
        .find('/')
        .map_or(url.len(), |at| scheme_end + at);
    let path = &url[path_start..];
    let path = path.find(['?', '#']).map_or(path, |at| &path[..at]);
    Some(Local {
        origin: &url[..path_start],
        host: &url[scheme_end..path_start],
        path,
    })
}

/// The argv cloudflared runs with. Without `--http-host-header` the origin would see the
/// public hostname and the loopback Host check would refuse every request.
pub(crate) fn args(local_url: &str) -> Option<Vec<OsString>> {
    let local = split(local_url)?;
    Some(vec![
        os("tunnel"),
        os("--no-autoupdate"),
        os("--url"),
        os(local.origin),
        os("--http-host-header"),
        os(local.host),
    ])
}

pub(crate) async fn supervise(binary: PathBuf, launch: Launch, mut stopped: oneshot::Receiver<()>) {
    let report = |state, detail: String| {
        launch.reporter.send(TunnelReport::new(state, detail));
    };
    let (Some(args), Some(local)) = (args(&launch.local_url), split(&launch.local_url)) else {
        return report(
            ConnectionState::TunnelUnavailable,
            "Could not start cloudflared: the local URL is not valid".to_owned(),
        );
    };
    report(
        ConnectionState::ConnectingTunnel,
        "Starting cloudflared\u{2026}".to_owned(),
    );
    // A tunnel provider needs the ordinary OS environment, never credentials inherited from
    // the terminal that launched the app.
    let spawned = match process::spawn(&binary, &args, launch.host.child_env(&[])) {
        Ok(spawned) => spawned,
        Err(error) => {
            report(
                ConnectionState::TunnelUnavailable,
                format!("Could not start cloudflared: {error}"),
            );
            let _ = stopped.await;
            return;
        }
    };
    let mut child = spawned.child;
    let mut lines = spawned.lines;
    let mut lines_open = true;
    let mut output = Output {
        launch: &launch,
        path: local.path,
        settled: false,
        last_error: String::new(),
    };
    let startup = tokio::time::sleep(STARTUP_LIMIT);
    tokio::pin!(startup);
    let mut exited = false;
    let mut startup_passed = false;
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            line = lines.recv(), if lines_open => match line {
                Some(line) => output.line(&line),
                None => lines_open = false,
            },
            status = child.wait(), if !exited => {
                exited = true;
                output.settled = true;
                for line in process::last_lines(&mut lines).await {
                    output.line(&line);
                }
                let detail = if output.last_error.is_empty() {
                    format!("cloudflared stopped (exit {}).", process::exit_code(status))
                } else {
                    output.last_error.clone()
                };
                report(ConnectionState::TunnelUnavailable, detail);
            },
            () = &mut startup, if !output.settled && !startup_passed => {
                startup_passed = true;
                let detail = if output.last_error.is_empty() {
                    "cloudflared did not report a public URL within 45 seconds.".to_owned()
                } else {
                    output.last_error.clone()
                };
                report(ConnectionState::TunnelUnavailable, detail);
            },
        }
    }
    process::stop_tree(&mut child).await;
}

/// What cloudflared's output has said so far.
struct Output<'a> {
    launch: &'a Launch,
    /// The local URL's path, appended to the quick tunnel's origin.
    path: &'a str,
    /// A public URL was reported or the process exited, so a later URL is ignored.
    settled: bool,
    last_error: String,
}

impl Output<'_> {
    fn line(&mut self, line: &str) {
        if let Some(found) = QUICK_TUNNEL.find(line).filter(|_| !self.settled) {
            self.settled = true;
            self.launch.logger.info("quick tunnel connected");
            let mut connected = TunnelReport::new(
                ConnectionState::Connected,
                "Connected. Paste the URL below into ChatGPT as a custom connector.",
            );
            connected.public_url = Some(Some(format!("{}{}", found.as_str(), self.path)));
            self.launch.reporter.send(connected);
        } else if ERROR_WORD.is_match(line) {
            self.last_error = line.chars().take(400).collect();
            self.launch
                .logger
                .warn(&format!("cloudflared: {}", self.last_error));
        }
    }
}
