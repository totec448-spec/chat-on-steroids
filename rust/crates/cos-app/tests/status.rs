//! How each connection state reads in the sidebar capsule and the tray (`paintState` and
//! `refreshTray`).

use cos_app::status::{Tone, ago, browser_text, capsule, tray_status};
use cos_types::app_state::{BridgeStatus, ConnectionState, ConnectionStatus};

fn status(state: ConnectionState, handshake_at: Option<u64>) -> ConnectionStatus {
    ConnectionStatus {
        state,
        detail: String::new(),
        public_url: None,
        local_url: None,
        handshake_at,
        last_request_at: None,
        last_tool_call_at: None,
        health: None,
        route_settling_until: None,
        surfaces: Vec::new(),
    }
}

#[test]
fn the_capsule_says_what_to_do_or_what_is_happening() {
    use ConnectionState as S;
    let cases = [
        (
            S::Disconnected,
            Tone::Idle,
            Some("Connect"),
            false,
            "Not connected",
        ),
        (
            S::StartingServer,
            Tone::Busy,
            Some("Connecting…"),
            false,
            "Starting",
        ),
        (
            S::ConnectingTunnel,
            Tone::Busy,
            Some("Connecting…"),
            false,
            "Connecting",
        ),
        (S::Connected, Tone::Connected, None, true, "Connected"),
        (
            S::Offline,
            Tone::Offline,
            Some("No internet"),
            true,
            "No internet",
        ),
        (
            S::Disconnecting,
            Tone::Closing,
            Some("Disconnecting…"),
            false,
            "Disconnecting",
        ),
        (
            S::AuthFailed,
            Tone::Error,
            Some("Failed"),
            true,
            "Sign-in failed",
        ),
        (
            S::TunnelUnavailable,
            Tone::Error,
            Some("Failed"),
            true,
            "Tunnel unavailable",
        ),
    ];
    for (state, tone, words, dot, text) in cases {
        let shown = capsule(&status(state, None));
        assert_eq!(
            (shown.tone, shown.words, shown.dot, shown.status),
            (tone, words, dot, text),
            "{state:?}"
        );
    }
}

#[test]
fn a_verified_handshake_is_named_only_while_running() {
    assert_eq!(
        capsule(&status(ConnectionState::Connected, Some(5))).verified_at,
        Some(5)
    );
    assert_eq!(
        capsule(&status(ConnectionState::Disconnected, Some(5))).verified_at,
        None
    );
}

#[test]
fn the_tray_keeps_the_running_icon_while_offline() {
    use ConnectionState as S;
    for (state, running, label) in [
        (S::Connected, true, "Connected"),
        (S::Offline, true, "No internet"),
        (S::ConnectingTunnel, false, "Not connected"),
        (S::Disconnected, false, "Not connected"),
        (S::AuthFailed, false, "Not connected"),
    ] {
        let tray = tray_status(state);
        assert_eq!((tray.running, tray.label), (running, label), "{state:?}");
    }
}

#[test]
fn ages_read_like_ago() {
    let now = 10_000_000;
    assert_eq!(ago(now - 2_000, now), ("just now", None));
    assert_eq!(ago(now - 45_000, now), ("{0}s ago", Some(45)));
    assert_eq!(ago(now - 89_400, now), ("{0}s ago", Some(89)));
    assert_eq!(ago(now - 600_000, now), ("{0}m ago", Some(10)));
    assert_eq!(ago(now - 7_200_000, now), ("{0}h ago", Some(2)));
    assert_eq!(ago(now + 5_000, now), ("just now", None));
}

#[test]
fn the_browser_row_says_whether_the_extension_is_there() {
    let bridge = |paired: bool, present: bool| BridgeStatus {
        port_overridden: None,
        error: None,
        running: true,
        port: Some(4545),
        paired,
        present,
        last_seen_at: None,
        extension_version: None,
        external_extension: None,
        cos_extension: None,
    };
    assert_eq!(browser_text(&bridge(true, true)), "Connected");
    assert_eq!(browser_text(&bridge(false, true)), "Connected");
    assert_eq!(browser_text(&bridge(true, false)), "Paired · not active");
    assert_eq!(browser_text(&bridge(false, false)), "Not connected");
}
