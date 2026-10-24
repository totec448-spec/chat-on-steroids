//! OpenAI's Secure MCP Tunnel: runs `tunnel-client` and keeps it running.
//!
//! Readiness is re-checked for as long as the connection is meant to be up, and a client that
//! exits or stays unready is replaced with backoff. A client that cannot reach OpenAI is not
//! broken: it retries on its own, so it is reported and waited out, never restarted. Only the
//! client's poll metric tells the two apart, because `/readyz` stays green while offline.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use cos_tools::EpochMs;
use cos_types::app_state::{ConnectionState, TunnelHealth};
use cos_types::json::JsNumber;
use serde_json::Value;
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::health::{self, RouteObservation, UnreachableRun};
use super::process::{self, Host};
use super::{Launch, TunnelReport, os, tag};

/// How often `/readyz` is re-checked once the tunnel is up.
const WATCH_INTERVAL: Duration = Duration::from_secs(15);
/// How long a fresh client gets to become ready.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// How often to look again while the control plane is unreachable.
const OFFLINE_RECHECK: Duration = Duration::from_secs(5);
/// A failed readiness check must survive into a second watch pass before the client, and
/// every tool call travelling through it, is killed.
const UNREADY_CONFIRM: Duration = Duration::from_secs(15);
/// How long OpenAI keeps routing an existing chat to the previous client (#1220).
pub(crate) const ROUTE_SETTLE_MS: u64 = 12_000;

const AUTH_FAILED: &str = "OpenAI refused access to this tunnel. Check its account, organization, API key and tunnel ID in Connection settings.";
const NOT_STOPPED: &str = "The previous tunnel client could not be stopped safely. Disconnect and reconnect to try again.";

pub(crate) fn valid_tunnel_id(id: &str) -> bool {
    id.strip_prefix("tunnel_").is_some_and(|hex| {
        hex.len() == 32
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// The argv `tunnel-client` runs with. The API key and the secret local URL go in the
/// environment, never on the command line, so no process listing shows them.
pub(crate) fn args(tunnel_id: &str, health_file: &Path) -> Vec<OsString> {
    vec![
        os("run"),
        os("--control-plane.tunnel-id"),
        os(tunnel_id),
        os("--health.listen-addr"),
        os("127.0.0.1:0"),
        os("--health.url-file"),
        health_file.as_os_str().to_owned(),
        os("--log.format"),
        os("json"),
        os("--log.level"),
        os("info"),
    ]
}

/// The proxy tunnel-client needs (#1255). It is a Go program that reads only `HTTPS_PROXY`
/// and `NO_PROXY`, so a usable `ALL_PROXY` is passed on as `HTTPS_PROXY`. A person's own
/// `HTTPS_PROXY` always wins. The system proxy setting is not read in this build.
pub(crate) fn proxy_env(host: &Host) -> Vec<(&'static str, OsString)> {
    let value = |name: &str| {
        host.var(name)
            .map(|value| value.to_string_lossy().trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    if value("HTTPS_PROXY").is_some() {
        return Vec::new();
    }
    let Some(all) = value("ALL_PROXY") else {
        return Vec::new();
    };
    let lower = all.to_ascii_lowercase();
    let usable = ["http://", "https://", "socks5://", "socks5h://"]
        .iter()
        .any(|scheme| lower.starts_with(scheme) && all.len() > scheme.len())
        && !all.chars().any(char::is_whitespace);
    if !usable {
        return Vec::new();
    }
    let mut env = vec![("HTTPS_PROXY", OsString::from(all))];
    if value("NO_PROXY").is_none() {
        env.push(("NO_PROXY", os("localhost,127.0.0.1,::1")));
    }
    env
}

/// A proxy address for the log, without the name and password it may carry.
fn proxy_for_log(url: &str) -> String {
    match (url.find("//"), url.find('@')) {
        (Some(slashes), Some(at)) if at > slashes && !url[slashes + 2..at].contains('/') => {
            format!("{}{}", &url[..slashes + 2], &url[at + 1..])
        }
        _ => url.to_owned(),
    }
}

/// How one client process ended.
enum End {
    /// The lifecycle stopped the tunnel.
    Stopped,
    /// OpenAI refused the credentials; retrying cannot help.
    AuthRejected,
    /// Replace the client after backoff. `terminate` when the process may still run.
    Restart { detail: String, terminate: bool },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Shown {
    Connected,
    Offline,
    Unknown,
}

/// One client process and what it has shown so far.
struct Run<'a> {
    launch: &'a Launch,
    tag: String,
    last_error: String,
    unreachable_reason: String,
    outage: UnreachableRun,
    last_handshake: Option<u64>,
    unready_since: Option<Instant>,
    poll_errors: f64,
    health_base: Option<String>,
    health: Option<TunnelHealth>,
    shown: Option<Shown>,
    /// This process has connected once, so OpenAI has begun moving existing chats to it.
    routed: bool,
}

pub(crate) async fn supervise(
    binary: PathBuf,
    tunnel_id: String,
    api_key: String,
    work_dir: PathBuf,
    launch: Launch,
    mut stopped: oneshot::Receiver<()>,
) {
    let tag = tag(launch.surface);
    let health_file = work_dir.join("health.url");
    let args = args(&tunnel_id, &health_file);
    let mut attempts: u32 = 0;
    loop {
        // A stale URL from the previous run would otherwise be read as this run's.
        let _ = std::fs::remove_file(&health_file);
        let proxy = proxy_env(&launch.host);
        if let Some((_, url)) = proxy.iter().find(|(name, _)| *name == "HTTPS_PROXY") {
            launch.logger.info(&format!(
                "{tag}: tunnel-client connects through the proxy {}",
                proxy_for_log(&url.to_string_lossy())
            ));
        }
        launch.reporter.send(TunnelReport::new(
            ConnectionState::ConnectingTunnel,
            if attempts == 0 {
                "Starting tunnel client\u{2026}"
            } else {
                "Reconnecting\u{2026}"
            },
        ));
        let mut overrides = vec![
            ("CONTROL_PLANE_API_KEY", OsString::from(&api_key)),
            (
                "MCP_SERVER_URL",
                OsString::from(format!("url={},channel=main", launch.local_url)),
            ),
        ];
        let (name, value) = &launch.discovery_header;
        overrides.push((
            "MCP_DISCOVERY_EXTRA_HEADERS",
            OsString::from(format!("{name}: {value}")),
        ));
        overrides.extend(proxy);
        let env = launch.host.child_env(&overrides);

        let (end, mut child) = match process::spawn(&binary, &args, env) {
            Ok(spawned) => {
                let mut child = spawned.child;
                let mut run = Run::new(&launch, &tag);
                let end = run
                    .watch(
                        &mut child,
                        spawned.lines,
                        &health_file,
                        &mut attempts,
                        &mut stopped,
                    )
                    .await;
                (end, Some(child))
            }
            Err(error) => {
                launch
                    .logger
                    .error(&format!("{tag} client failed to start: {error}"));
                let detail = format!("Could not start tunnel-client: {error}");
                (
                    End::Restart {
                        detail,
                        terminate: false,
                    },
                    None,
                )
            }
        };
        match end {
            End::Stopped => {
                if let Some(child) = &mut child {
                    process::stop_tree(child).await;
                }
                break;
            }
            End::AuthRejected => {
                if let Some(child) = &mut child {
                    process::stop_tree(child).await;
                }
                launch
                    .reporter
                    .send(TunnelReport::new(ConnectionState::AuthFailed, AUTH_FAILED));
                break;
            }
            End::Restart { detail, terminate } => {
                attempts += 1;
                let wait = backoff(attempts);
                launch.reporter.send(TunnelReport::new(
                    ConnectionState::ConnectingTunnel,
                    format!("{detail} Reconnecting in {}s\u{2026}", wait.as_secs()),
                ));
                let retired = match (&mut child, terminate) {
                    (Some(child), true) => process::stop_tree(child).await,
                    _ => true,
                };
                if !retired {
                    // Starting a second client without proof the first stopped would leave
                    // two owned trees. An explicit reconnect starts a fresh supervisor.
                    launch.reporter.send(TunnelReport::new(
                        ConnectionState::TunnelUnavailable,
                        NOT_STOPPED,
                    ));
                    let _ = (&mut stopped).await;
                    break;
                }
                tokio::select! {
                    () = tokio::time::sleep(wait) => {}
                    _ = &mut stopped => break,
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&work_dir);
}

fn backoff(attempts: u32) -> Duration {
    let doubled = 2u64
        .saturating_pow(attempts.saturating_sub(1))
        .saturating_mul(2);
    Duration::from_secs(doubled).min(MAX_BACKOFF)
}

fn now_ms() -> u64 {
    EpochMs::now().0
}

fn read_health_url(file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let text = text.trim();
    text.starts_with("http")
        .then(|| text.trim_end_matches('/').to_owned())
}

impl<'a> Run<'a> {
    fn new(launch: &'a Launch, tag: &str) -> Self {
        Self {
            launch,
            tag: tag.to_owned(),
            last_error: String::new(),
            unreachable_reason: String::new(),
            outage: UnreachableRun::default(),
            last_handshake: None,
            unready_since: None,
            poll_errors: 0.0,
            health_base: None,
            health: None,
            shown: None,
            routed: false,
        }
    }

    /// Runs until the process ends, is replaced, or the tunnel is stopped. Before the client
    /// is ready this polls its health file once a second for up to a minute; after that it
    /// watches `/readyz` and the poll metrics.
    async fn watch(
        &mut self,
        child: &mut Child,
        mut lines: mpsc::UnboundedReceiver<String>,
        health_file: &Path,
        attempts: &mut u32,
        stopped: &mut oneshot::Receiver<()>,
    ) -> End {
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut next = Instant::now();
        let mut lines_open = true;
        loop {
            tokio::select! {
                _ = &mut *stopped => return End::Stopped,
                line = lines.recv(), if lines_open => match line {
                    Some(line) => {
                        if self.handle_line(&line) {
                            return End::AuthRejected;
                        }
                    }
                    None => lines_open = false,
                },
                status = child.wait() => {
                    for line in process::last_lines(&mut lines).await {
                        if self.handle_line(&line) {
                            return End::AuthRejected;
                        }
                    }
                    let code = process::exit_code(status);
                    self.launch.logger.warn(&format!("{} client exited with code {code}", self.tag));
                    let detail = if self.last_error.is_empty() {
                        format!("Tunnel client stopped (exit {code}).")
                    } else {
                        self.last_error.clone()
                    };
                    return End::Restart { detail, terminate: false };
                }
                () = tokio::time::sleep_until(next) => {
                    if self.health_base.is_none() {
                        if Instant::now() >= deadline {
                            let detail = if self.last_error.is_empty() {
                                "The tunnel did not become ready within 60 seconds.".to_owned()
                            } else {
                                self.last_error.clone()
                            };
                            return End::Restart { detail, terminate: true };
                        }
                        next = Instant::now() + READY_POLL;
                        let Some(base) = read_health_url(health_file) else { continue };
                        let (ok, detail) = health::ready(&base).await;
                        if !ok {
                            if !detail.is_empty() {
                                self.last_error = detail;
                            }
                            continue;
                        }
                        *attempts = 0;
                        self.health_base = Some(base);
                        self.observe().await;
                    } else if let Some(end) = self.recheck().await {
                        return end;
                    }
                    next = Instant::now()
                        + if self.shown == Some(Shown::Offline) { OFFLINE_RECHECK } else { WATCH_INTERVAL };
                }
            }
        }
    }

    /// One watch pass on a ready client.
    async fn recheck(&mut self) -> Option<End> {
        let base = self.health_base.clone()?;
        let (ok, detail) = health::ready(&base).await;
        if !ok {
            let now = Instant::now();
            match self.unready_since {
                None => {
                    self.unready_since = Some(now);
                    let shown = if detail.is_empty() {
                        "no detail"
                    } else {
                        &detail
                    };
                    self.launch.logger.warn(&format!(
                        "{} did not answer its readiness check: {shown} \u{2014} rechecking before replacing it",
                        self.tag
                    ));
                }
                Some(since) if now.duration_since(since) < UNREADY_CONFIRM => {}
                Some(_) => {
                    self.launch
                        .logger
                        .warn(&format!("{} went unready: {detail}", self.tag));
                    let detail = if detail.is_empty() {
                        "The tunnel stopped responding.".to_owned()
                    } else {
                        detail
                    };
                    return Some(End::Restart {
                        detail,
                        terminate: true,
                    });
                }
            }
            return None;
        }
        if self.unready_since.take().is_some() {
            self.launch.logger.info(&format!(
                "{} answered its readiness check again; not replacing it",
                self.tag
            ));
        }
        self.observe().await;
        None
    }

    /// Refreshes the health snapshot and reports what it shows, on the same tick, so the
    /// numbers on screen are never older than the state next to them.
    async fn observe(&mut self) {
        let Some(base) = self.health_base.clone() else {
            return;
        };
        let (poll, client) = tokio::join!(
            health::read_poll_health(&base),
            health::read_client_status(&base)
        );
        if let Some(at) = poll.and_then(|poll| poll.last_success_ms) {
            self.last_handshake = Some(at);
        }
        if self.outage.recovered(self.last_handshake) {
            self.outage = UnreachableRun::default();
            self.unreachable_reason.clear();
        }
        self.health = Some(TunnelHealth {
            poll_errors: poll
                .and_then(|poll| poll.errors)
                .map(|errors| errors.max(0.0) as u64),
            uptime_seconds: client
                .as_ref()
                .and_then(|client| client.uptime_seconds)
                .map(JsNumber),
            route: client.as_ref().and_then(|client| client.route.clone()),
            probe: client.as_ref().and_then(|client| client.probe.clone()),
            client_version: client.as_ref().and_then(|client| client.version.clone()),
        });
        if let Some(errors) = poll.and_then(|poll| poll.errors)
            && errors > self.poll_errors
        {
            // Info, not warn: the client retries these itself.
            self.launch.logger.info(&format!(
                "{}: {} more poll error(s) from the control plane ({errors} total)",
                self.tag,
                errors - self.poll_errors
            ));
            self.poll_errors = errors;
        }
        let read = poll.map(|poll| poll.last_success_ms.unwrap_or(0));
        let now = now_ms();
        match health::route_observation(read, self.last_handshake, &self.outage, now) {
            RouteObservation::Offline => {
                if self.unreachable_reason.is_empty() {
                    "it stopped answering".clone_into(&mut self.unreachable_reason);
                }
                self.show_offline(now);
            }
            RouteObservation::Connected => self.show_connected(now),
            RouteObservation::Unknown => self.show_unknown(),
        }
    }

    fn report(&self, state: ConnectionState, detail: String) -> TunnelReport {
        let mut report = TunnelReport::new(state, detail);
        report.handshake_at = Some(self.last_handshake);
        report.health = Some(self.health.clone());
        report
    }

    fn show_connected(&mut self, now: u64) {
        if self.shown != Some(Shown::Connected) {
            self.launch.logger.info(&format!("{} connected", self.tag));
        }
        self.shown = Some(Shown::Connected);
        let detail = match self.last_handshake {
            Some(at) => format!(
                "Connected. Last verified handshake with OpenAI {}. Pick the tunnel in ChatGPT.",
                health::ago(Some(at), now)
            ),
            None => "Connected. Pick the tunnel in ChatGPT.".to_owned(),
        };
        let mut report = self.report(ConnectionState::Connected, detail);
        // A reconnect after an outage is the same process, whose route never moved.
        report.new_client = !self.routed;
        self.routed = true;
        self.launch.reporter.send(report);
    }

    fn show_offline(&mut self, now: u64) {
        let handshake = health::ago(self.last_handshake, now);
        if self.shown != Some(Shown::Offline) {
            self.launch.logger.warn(&format!(
                "{} offline: {} (last verified handshake {handshake})",
                self.tag, self.unreachable_reason
            ));
        }
        self.shown = Some(Shown::Offline);
        let detail = format!(
            "This PC cannot reach OpenAI \u{2014} {}. Last verified handshake {handshake}. ChatGPT cannot use the connector until it is back; the tunnel keeps retrying on its own.",
            self.unreachable_reason
        );
        self.launch
            .reporter
            .send(self.report(ConnectionState::Offline, detail));
    }

    fn show_unknown(&mut self) {
        self.shown = Some(Shown::Unknown);
        self.launch.reporter.send(self.report(
            ConnectionState::ConnectingTunnel,
            "Tunnel client is locally ready, but its OpenAI poll metrics are temporarily unavailable."
                .to_owned(),
        ));
    }

    /// Classifies one output line. True when OpenAI rejected the credentials.
    fn handle_line(&mut self, line: &str) -> bool {
        // tunnel-client logs JSON. An `error` field alone does not make a record an error:
        // some healthy startup warnings carry diagnostics there.
        if let Ok(event) = serde_json::from_str::<Value>(line) {
            let level = health::event_text(&event["level"]).to_uppercase();
            let mut message = health::event_text(&event["msg"]);
            if message.is_empty() {
                "tunnel-client event".clone_into(&mut message);
            }
            if level == "WARN"
                && message == "harpoon host auto-registration failed"
                && event["inclusion_reason"] == "loopback"
            {
                return false;
            }
            if health::is_benign_harpoon(&level, &message, &event) {
                return false;
            }
            if matches!(level.as_str(), "ERROR" | "FATAL" | "WARN") {
                let error = health::event_text(&event["error"]);
                if health::auth_rejected(&message, &error, event.get("status_code")) {
                    return true;
                }
                let mut last = format!("{level} {message}");
                if !error.is_empty() {
                    last = format!("{last}: {error}");
                }
                self.last_error = last.chars().take(400).collect();
                if health::is_unreachable(&format!("{message}: {error}")) {
                    let raw = if error.is_empty() { &message } else { &error };
                    self.note_unreachable(&raw.clone());
                } else {
                    self.launch
                        .logger
                        .warn(&format!("{}: {}", self.tag, self.last_error));
                }
            }
            return false;
        }
        // Older clients and crash paths still print plain text.
        if health::LEVEL_WORD.is_match(line) {
            if health::auth_rejected("", line, None) {
                return true;
            }
            self.last_error = line.chars().take(400).collect();
            if health::is_unreachable(line) {
                self.note_unreachable(line);
            } else {
                self.launch
                    .logger
                    .warn(&format!("{}: {}", self.tag, self.last_error));
            }
        }
        false
    }

    /// Records a "cannot reach OpenAI" complaint without changing what the user sees; the
    /// watch pass decides once the run has outlived a poll cycle. One line per run.
    fn note_unreachable(&mut self, raw: &str) {
        health::describe_network_error(raw).clone_into(&mut self.unreachable_reason);
        if self.outage.since.is_none() {
            self.outage = UnreachableRun {
                since: Some(now_ms()),
                handshake_before: self.last_handshake,
            };
            self.launch.logger.info(&format!(
                "{}: {}; the client is retrying",
                self.tag, self.unreachable_reason
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(env: &[(&str, &str)]) -> Host {
        Host {
            env: env
                .iter()
                .map(|(name, value)| ((*name).into(), (*value).into()))
                .collect(),
            temp_dir: std::env::temp_dir(),
            bundled_dir: None,
        }
    }

    #[test]
    fn tunnel_ids_are_tunnel_and_32_lowercase_hex() {
        assert!(valid_tunnel_id("tunnel_0123456789abcdef0123456789abcdef"));
        assert!(!valid_tunnel_id("tunnel_0123456789ABCDEF0123456789abcdef"));
        assert!(!valid_tunnel_id("tunnel_0123"));
        assert!(!valid_tunnel_id("0123456789abcdef0123456789abcdef"));
    }

    #[test]
    fn all_proxy_becomes_https_proxy_and_a_set_https_proxy_wins() {
        let derived = proxy_env(&host(&[("ALL_PROXY", "socks5://10.0.0.1:1080")]));
        assert_eq!(
            derived,
            [
                ("HTTPS_PROXY", OsString::from("socks5://10.0.0.1:1080")),
                ("NO_PROXY", OsString::from("localhost,127.0.0.1,::1"))
            ]
        );
        let set = host(&[("HTTPS_PROXY", "http://p:1"), ("ALL_PROXY", "http://q:2")]);
        assert!(proxy_env(&set).is_empty());
        assert!(proxy_env(&host(&[("ALL_PROXY", "ftp://q:2")])).is_empty());
        let kept = host(&[("ALL_PROXY", "http://q:2"), ("NO_PROXY", "corp")]);
        assert_eq!(proxy_env(&kept).len(), 1);
        assert!(proxy_env(&host(&[])).is_empty());
    }

    #[test]
    fn a_proxy_is_logged_without_its_credentials() {
        assert_eq!(
            proxy_for_log("http://user:pass@proxy:8080"),
            "http://proxy:8080"
        );
        assert_eq!(proxy_for_log("http://proxy:8080"), "http://proxy:8080");
    }

    #[test]
    fn backoff_doubles_from_two_seconds_up_to_a_minute() {
        let waits: Vec<u64> = (1..=7).map(|attempt| backoff(attempt).as_secs()).collect();
        assert_eq!(waits, [2, 4, 8, 16, 32, 60, 60]);
    }
}
