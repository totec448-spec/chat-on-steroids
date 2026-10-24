//! What tunnel-client knows about its own connection (`tunnel/health.ts`) and how its log
//! lines are classified (`tunnel/index.ts`).
//!
//! `/readyz` is a local liveness gate that stays green through an internet outage. The poll
//! timestamp in `/metrics` is the proof of a recent round trip to OpenAI, and `/api/status`
//! names the route and the probe. Every read is loopback-only and never fails loudly: a
//! missing or unparsable field is `None`, so the caller says "unknown" instead of guessing.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Polls time out after 30 s, so successes arrive at most that far apart; allow three.
pub(crate) const POLL_FRESH_MS: u64 = 95_000;
/// How long unreachable complaints must go unanswered before they are an outage.
pub(crate) const UNREACHABLE_CONFIRM_MS: u64 = 35_000;
const READ_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_BODY: usize = 1 << 20;

/// The status code and body of a loopback GET, or `None` when nothing answered in time.
pub(crate) async fn get(base: &str, path: &str) -> Option<(u16, String)> {
    tokio::time::timeout(READ_TIMEOUT, fetch(base, path))
        .await
        .ok()
        .flatten()
}

async fn fetch(base: &str, path: &str) -> Option<(u16, String)> {
    let authority = base.strip_prefix("http://")?.trim_end_matches('/');
    let mut stream = TcpStream::connect(authority).await.ok()?;
    // HTTP/1.0 keeps the answer unchunked and ends it by closing the connection.
    let request = format!(
        "GET {path} HTTP/1.0\r\nHost: {authority}\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut bytes = Vec::new();
    stream
        .take(MAX_BODY as u64)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    Some((status, body.to_owned()))
}

/// `/readyz` answers 503 with the reason in its body, which says far more than a generic
/// message.
pub(crate) async fn ready(base: &str) -> (bool, String) {
    match get(base, "/readyz").await {
        Some((status, body)) => (
            (200..300).contains(&status),
            body.trim().chars().take(200).collect(),
        ),
        None => (false, String::new()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PollHealth {
    /// Epoch ms of the last successful control-plane poll; `None` if none succeeded yet.
    pub last_success_ms: Option<u64>,
    pub errors: Option<f64>,
}

/// Sums every sample of a Prometheus metric, ignoring labels: poll errors are split by
/// `error_kind`, and the first bucket alone is not the total.
pub(crate) fn read_metric(text: &str, name: &str) -> Option<f64> {
    let mut total = None;
    for line in text.split('\n') {
        if line.starts_with('#') {
            continue;
        }
        let Some(rest) = line.trim().strip_prefix(name) else {
            continue;
        };
        if !(rest.is_empty() || rest.starts_with(' ') || rest.starts_with('{')) {
            continue;
        }
        let rest = match rest.strip_prefix('{') {
            Some(labels) => labels.split_once('}').map_or("", |(_, after)| after),
            None => rest,
        };
        let Some(Ok(value)) = rest.split_whitespace().next().map(str::parse::<f64>) else {
            continue;
        };
        if value.is_finite() {
            total = Some(total.unwrap_or(0.0) + value);
        }
    }
    total
}

pub(crate) fn parse_poll_health(metrics: &str) -> PollHealth {
    let seconds = read_metric(metrics, "commands_poll_last_successful_timestamp_seconds");
    PollHealth {
        last_success_ms: seconds
            .filter(|seconds| *seconds > 0.0)
            .map(|seconds| (seconds * 1000.0).round() as u64),
        errors: read_metric(metrics, "commands_poll_errors_total"),
    }
}

/// A readable page without the poll timestamp is still unknown, not the explicit zero that
/// means a healthy client is awaiting its first poll.
pub(crate) async fn read_poll_health(base: &str) -> Option<PollHealth> {
    let (status, text) = get(base, "/metrics").await?;
    if !(200..300).contains(&status)
        || read_metric(&text, "commands_poll_last_successful_timestamp_seconds").is_none()
    {
        return None;
    }
    Some(parse_poll_health(&text))
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClientStatus {
    pub version: Option<String>,
    pub probe: Option<String>,
    pub uptime_seconds: Option<f64>,
    pub route: Option<String>,
}

pub(crate) fn parse_client_status(raw: &Value) -> ClientStatus {
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let main = raw["channels"]
        .as_array()
        .and_then(|channels| channels.iter().find(|channel| channel["name"] == "main"));
    let route = &raw["control_plane_route"];
    let target = text(route.get("target"));
    let mode = text(route.get("route_mode"));
    let proxy = text(route.get("proxy_source"));
    let route = target.map(|target| {
        let via = match proxy {
            Some(proxy) if proxy != "none" => format!("via {proxy}"),
            _ => mode.unwrap_or_else(|| "direct".to_owned()),
        };
        format!("{target} \u{b7} {via}")
    });
    ClientStatus {
        version: text(raw.get("version")),
        probe: text(main.and_then(|main| main.get("probe_status"))),
        uptime_seconds: raw["uptime_seconds"].as_f64(),
        route,
    }
}

pub(crate) async fn read_client_status(base: &str) -> Option<ClientStatus> {
    let (status, text) = get(base, "/api/status").await?;
    if !(200..300).contains(&status) {
        return None;
    }
    serde_json::from_str::<Value>(&text)
        .ok()
        .map(|raw| parse_client_status(&raw))
}

/// "just now", "12s ago", "4m ago".
pub(crate) fn ago(at_ms: Option<u64>, now_ms: u64) -> String {
    let Some(at_ms) = at_ms else {
        return "never".to_owned();
    };
    let seconds = (now_ms.saturating_sub(at_ms) as f64 / 1000.0).round() as u64;
    if seconds < 3 {
        return "just now".to_owned();
    }
    if seconds < 90 {
        return format!("{seconds}s ago");
    }
    let minutes = (seconds as f64 / 60.0).round() as u64;
    if minutes < 90 {
        return format!("{minutes}m ago");
    }
    format!("{}h ago", (minutes as f64 / 60.0).round() as u64)
}

/// A run of "cannot reach OpenAI" complaints not yet contradicted by a completed poll.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct UnreachableRun {
    /// When the run began; `None` when no run is open.
    pub since: Option<u64>,
    /// The last completed poll known when it began.
    pub handshake_before: Option<u64>,
}

impl UnreachableRun {
    pub fn confirmed(&self, now_ms: u64) -> bool {
        self.since
            .is_some_and(|since| now_ms.saturating_sub(since) >= UNREACHABLE_CONFIRM_MS)
    }

    /// A poll completed since the run began. A client that never polled before the run
    /// recovers on its first success of any age.
    pub fn recovered(&self, last_handshake: Option<u64>) -> bool {
        match (self.since, last_handshake) {
            (Some(_), Some(last)) => self.handshake_before.is_none_or(|before| last > before),
            _ => false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RouteObservation {
    Connected,
    Offline,
    Unknown,
}

/// Missing metrics prove neither recovery nor failure; a readable zero is a ready first poll.
pub(crate) fn route_observation(
    read: Option<u64>,
    last_handshake: Option<u64>,
    run: &UnreachableRun,
    now_ms: u64,
) -> RouteObservation {
    if read.is_none() {
        return RouteObservation::Unknown;
    }
    if run.confirmed(now_ms) {
        return RouteObservation::Offline;
    }
    match last_handshake {
        Some(last) if now_ms.saturating_sub(last) > POLL_FRESH_MS => RouteObservation::Offline,
        _ => RouteObservation::Connected,
    }
}

fn regex(pattern: &str) -> Regex {
    // The patterns are literals in this file; a test compiles every one of them.
    Regex::new(pattern).unwrap_or_else(|error| panic!("bad pattern {pattern}: {error}"))
}

static CONTROL_PLANE_POLL: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)\bpoll (?:failed|timed out(?:;\s*backing off)?)\b"));
static UNREACHABLE_NETWORK: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"(?i)no such host|dial tcp|i/o timeout|timed out|context deadline exceeded|connection (was )?(aborted|refused|reset)|network is (unreachable|down)|no route to host|tls handshake timeout|temporary failure in name resolution|forcibly closed",
    )
});
static CONTROL_PLANE_MESSAGE: LazyLock<Regex> = LazyLock::new(|| {
    regex(r"(?i)^(?:poll failed(?:;\s*backing off)?|tunnel metadata fetch failed)$")
});
static CONTROL_PLANE_ERROR: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)\bcontrolplane (?:client|responder):"));
static AUTH_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"(?i)\b(?:(?:unexpected status(?: code)?|HTTP)\s*:?\s*(?:401|403)|401\s+Unauthorized|403\s+Forbidden|unauthorized|forbidden|invalid[_ ]api[_ ]key|tunnel_use_forbidden)\b",
    )
});
static HARPOON_NAMED: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r#"(?i)^(?:failed to process polled command:\s*unsupported channel|dispatcher received unsupported channel)\s*["']([^"']+)["']$"#,
    )
});
static HARPOON_BARE: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)^dispatcher received unsupported channel$"));
pub(crate) static LEVEL_WORD: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)\b(error|fatal|warn)\b"));

/// Only a rejected control-plane request can invalidate the tunnel credentials.
pub(crate) fn auth_rejected(message: &str, error: &str, status_code: Option<&Value>) -> bool {
    if !(CONTROL_PLANE_MESSAGE.is_match(message) || CONTROL_PLANE_ERROR.is_match(error)) {
        return false;
    }
    if let Some(code) = status_code.and_then(Value::as_f64) {
        return code == 401.0 || code == 403.0;
    }
    AUTH_TEXT.is_match(error)
}

/// "This PC cannot reach OpenAI right now", which the client retries on its own, as opposed
/// to a broken tunnel. Only the control-plane poll context counts.
pub(crate) fn is_unreachable(raw: &str) -> bool {
    CONTROL_PLANE_POLL.is_match(raw) && UNREACHABLE_NETWORK.is_match(raw)
}

/// A Go network error in words a person can act on.
pub(crate) fn describe_network_error(raw: &str) -> &'static str {
    let has = |pattern: &str| regex(pattern).is_match(raw);
    if has(r"(?i)no such host|name resolution") {
        "no internet connection"
    } else if has(r"(?i)connection (was )?(aborted|reset)|forcibly closed") {
        "the connection dropped"
    } else if has(r"(?i)refused") {
        "the connection was refused"
    } else if has(r"(?i)timeout|timed out|context deadline exceeded") {
        "the connection timed out"
    } else if has(r"(?i)network is (unreachable|down)|no route to host") {
        "the network is unreachable"
    } else {
        "a network error"
    }
}

/// The optional Harpoon channel's exact diagnostic, never an unrelated substring.
pub(crate) fn is_benign_harpoon(level: &str, message: &str, event: &Value) -> bool {
    if !matches!(level.to_ascii_uppercase().as_str(), "WARN" | "ERROR") {
        return false;
    }
    let explicit = event["channel"].as_str().map(str::to_lowercase);
    if let Some(named) = HARPOON_NAMED.captures(message) {
        return named[1].eq_ignore_ascii_case("harpoon")
            && explicit
                .as_deref()
                .is_none_or(|channel| channel == "harpoon");
    }
    HARPOON_BARE.is_match(message) && explicit.as_deref() == Some("harpoon")
}

/// A log field as text: an object is spelled out, never "[object Object]".
pub(crate) fn event_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Object(_) | Value::Array(_) => value.to_string(),
        other => other.to_string(),
    }
}

/// The connectors configured on one Secure Tunnel ID. OpenAI dispatches round-robin across
/// every client on one ID, so each shared ID sends some calls to the wrong connector.
pub(crate) fn shared_tunnel_ids(
    named: [(cos_types::app_state::SurfaceId, &str); 3],
) -> Vec<Vec<cos_types::app_state::SurfaceId>> {
    let mut groups: Vec<(&str, Vec<cos_types::app_state::SurfaceId>)> = Vec::new();
    for (surface, id) in named {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        match groups.iter_mut().find(|(seen, _)| *seen == id) {
            Some((_, surfaces)) => surfaces.push(surface),
            None => groups.push((id, vec![surface])),
        }
    }
    groups
        .into_iter()
        .map(|(_, surfaces)| surfaces)
        .filter(|surfaces| surfaces.len() > 1)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cos_types::app_state::SurfaceId;
    use serde_json::json;

    #[test]
    fn metrics_add_every_label_set_and_never_match_a_longer_name() {
        let text = "# HELP commands_poll_errors_total x\ncommands_poll_errors_total{kind=\"a\"} 2\ncommands_poll_errors_total{kind=\"b\"} 3\ncommands_poll_cycles 1\ncommands_poll_cycles_total 9\n";
        assert_eq!(read_metric(text, "commands_poll_errors_total"), Some(5.0));
        assert_eq!(read_metric(text, "commands_poll_cycles"), Some(1.0));
        assert_eq!(read_metric("nothing here", "commands_poll_cycles"), None);
    }

    #[test]
    fn the_last_poll_is_milliseconds_and_never_1970() {
        let health =
            parse_poll_health("commands_poll_last_successful_timestamp_seconds 1760000000.5\n");
        assert_eq!(health.last_success_ms, Some(1_760_000_000_500));
        let never = parse_poll_health("commands_poll_last_successful_timestamp_seconds 0\n");
        assert_eq!(never.last_success_ms, None);
    }

    #[test]
    fn client_status_names_the_main_probe_and_the_route() {
        let status = parse_client_status(&json!({
            "version": "1.2.3", "uptime_seconds": 7,
            "channels": [{"name": "other", "probe_status": "bad"}, {"name": "main", "probe_status": "ok"}],
            "control_plane_route": {"target": "api.openai.com:443", "route_mode": "direct", "proxy_source": "env"}
        }));
        assert_eq!(status.probe.as_deref(), Some("ok"));
        assert_eq!(
            status.route.as_deref(),
            Some("api.openai.com:443 \u{b7} via env")
        );
        assert_eq!(status.uptime_seconds, Some(7.0));
        let unknown = parse_client_status(&json!({"channels": "nope"}));
        let empty = ClientStatus {
            version: None,
            probe: None,
            uptime_seconds: None,
            route: None,
        };
        assert_eq!(unknown, empty);
    }

    #[test]
    fn ages_read_the_way_a_person_says_them() {
        let now = 100_000_000;
        assert_eq!(ago(None, now), "never");
        assert_eq!(ago(Some(now - 1_000), now), "just now");
        assert_eq!(ago(Some(now - 12_000), now), "12s ago");
        assert_eq!(ago(Some(now - 4 * 60_000), now), "4m ago");
        assert_eq!(ago(Some(now - 3 * 3_600_000), now), "3h ago");
        assert_eq!(ago(Some(now + 50_000), now), "just now");
    }

    #[test]
    fn an_outage_needs_the_full_complaint_window_and_ends_on_a_fresh_poll() {
        let run = UnreachableRun {
            since: Some(1_000),
            handshake_before: Some(500),
        };
        assert!(!run.confirmed(1_000 + UNREACHABLE_CONFIRM_MS - 1));
        assert!(run.confirmed(1_000 + UNREACHABLE_CONFIRM_MS));
        assert!(!run.recovered(Some(500)));
        assert!(run.recovered(Some(600)));
        let first = UnreachableRun {
            since: Some(1_000),
            handshake_before: None,
        };
        assert!(first.recovered(Some(1)));
        assert!(!UnreachableRun::default().recovered(Some(1)));
    }

    #[test]
    fn route_observation_keeps_missing_metrics_unknown() {
        let none = UnreachableRun::default();
        let now = 1_000_000;
        let observe = |read, last, run: &UnreachableRun| route_observation(read, last, run, now);
        assert_eq!(observe(None, Some(now), &none), RouteObservation::Unknown);
        assert_eq!(observe(Some(0), None, &none), RouteObservation::Connected);
        let fresh = Some(now - POLL_FRESH_MS);
        assert_eq!(observe(Some(1), fresh, &none), RouteObservation::Connected);
        let stale = Some(now - POLL_FRESH_MS - 1);
        assert_eq!(observe(Some(1), stale, &none), RouteObservation::Offline);
        let open = UnreachableRun {
            since: Some(now - UNREACHABLE_CONFIRM_MS),
            handshake_before: None,
        };
        assert_eq!(
            observe(Some(1), Some(now), &open),
            RouteObservation::Offline
        );
    }

    #[test]
    fn only_control_plane_poll_failures_count_as_unreachable() {
        assert!(is_unreachable(
            "poll failed: dial tcp: lookup api.openai.com: no such host"
        ));
        assert!(is_unreachable(
            "poll timed out; backing off: context deadline exceeded"
        ));
        assert!(!is_unreachable("mcp probe failed: i/o timeout"));
        let cases = [
            ("dial tcp: lookup x: no such host", "no internet connection"),
            (
                "An existing connection was forcibly closed",
                "the connection dropped",
            ),
            ("connect: connection refused", "the connection was refused"),
            ("context deadline exceeded", "the connection timed out"),
            ("network is unreachable", "the network is unreachable"),
            ("something odd", "a network error"),
        ];
        for (raw, said) in cases {
            assert_eq!(describe_network_error(raw), said, "{raw}");
        }
    }

    #[test]
    fn only_a_rejected_control_plane_request_is_an_auth_failure() {
        assert!(auth_rejected("poll failed", "x", Some(&json!(401))));
        assert!(!auth_rejected(
            "poll failed",
            "unauthorized",
            Some(&json!(500))
        ));
        assert!(auth_rejected(
            "poll failed",
            "unexpected status code: 403",
            None
        ));
        assert!(auth_rejected(
            "",
            "controlplane client: invalid_api_key",
            None
        ));
        assert!(!auth_rejected("mcp probe failed", "401 Unauthorized", None));
        assert!(!auth_rejected("poll failed", "retry in 401ms", None));
    }

    #[test]
    fn the_harpoon_filter_takes_only_its_exact_diagnostic() {
        let none = Value::Null;
        let named = "dispatcher received unsupported channel \"harpoon\"";
        assert!(is_benign_harpoon("WARN", named, &none));
        let bare = "dispatcher received unsupported channel";
        assert!(is_benign_harpoon(
            "error",
            bare,
            &json!({"channel": "harpoon"})
        ));
        assert!(!is_benign_harpoon(
            "WARN",
            named,
            &json!({"channel": "main"})
        ));
        assert!(!is_benign_harpoon("INFO", named, &none));
        assert!(!is_benign_harpoon(
            "WARN",
            "unsupported channel harpoon and more",
            &none
        ));
    }

    #[test]
    fn log_fields_are_text_and_objects_are_spelled_out() {
        assert_eq!(event_text(&json!("x")), "x");
        assert_eq!(event_text(&json!({"a": 1})), "{\"a\":1}");
        assert_eq!(event_text(&Value::Null), "");
        assert_eq!(event_text(&json!(3)), "3");
    }

    #[test]
    fn shared_tunnel_ids_are_grouped_without_naming_the_id() {
        let shared = shared_tunnel_ids([
            (SurfaceId::Core, "t1"),
            (SurfaceId::Desktop, " t1 "),
            (SurfaceId::Plugins, "t2"),
        ]);
        assert_eq!(shared, [vec![SurfaceId::Core, SurfaceId::Desktop]]);
        let all = shared_tunnel_ids([
            (SurfaceId::Core, "t"),
            (SurfaceId::Desktop, "t"),
            (SurfaceId::Plugins, "t"),
        ]);
        assert_eq!(all[0].len(), 3);
        let alone = shared_tunnel_ids([
            (SurfaceId::Core, "t"),
            (SurfaceId::Desktop, ""),
            (SurfaceId::Plugins, ""),
        ]);
        assert!(alone.is_empty());
    }
}
