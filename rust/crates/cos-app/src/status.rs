//! How the connection reads in the sidebar capsule and the tray (`paintState` in
//! `src/renderer/main.ts`, `refreshTray` in `src/main/index.ts`). Texts are English sources; the
//! caller translates them.

use cos_types::app_state::{BridgeStatus, ConnectionState, ConnectionStatus};

/// `STATUS_TEXT`.
pub fn status_text(state: ConnectionState) -> &'static str {
    match state {
        ConnectionState::Disconnected => "Not connected",
        ConnectionState::Disconnecting => "Disconnecting",
        ConnectionState::StartingServer => "Starting",
        ConnectionState::ConnectingTunnel => "Connecting",
        ConnectionState::Connected => "Connected",
        ConnectionState::Offline => "No internet",
        ConnectionState::AuthFailed => "Sign-in failed",
        ConnectionState::TunnelUnavailable => "Tunnel unavailable",
    }
}

/// The capsule's color, from the CSS classes `is-connected`, `is-offline`, `is-busy`,
/// `is-error` and `is-closing`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Idle,
    Connected,
    Offline,
    Busy,
    Closing,
    Error,
}

/// The sidebar connection capsule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capsule {
    pub tone: Tone,
    /// The words it shows. Connected, it is only a dot.
    pub words: Option<&'static str>,
    /// Whether the status dot shows: connected, offline or failed.
    pub dot: bool,
    /// Its accessible name and tooltip: the status, and when the handshake was verified.
    pub status: &'static str,
    pub verified_at: Option<u64>,
}

/// `isRunning`.
pub fn is_running(state: ConnectionState) -> bool {
    matches!(
        state,
        ConnectionState::Connected
            | ConnectionState::Offline
            | ConnectionState::StartingServer
            | ConnectionState::ConnectingTunnel
    )
}

pub fn capsule(status: &ConnectionStatus) -> Capsule {
    use ConnectionState as S;
    let state = status.state;
    let tone = match state {
        S::Connected => Tone::Connected,
        S::Offline => Tone::Offline,
        S::Disconnecting => Tone::Closing,
        S::StartingServer | S::ConnectingTunnel => Tone::Busy,
        S::AuthFailed | S::TunnelUnavailable => Tone::Error,
        S::Disconnected => Tone::Idle,
    };
    let words = match state {
        S::Connected => None,
        S::Disconnecting => Some("Disconnecting…"),
        S::StartingServer | S::ConnectingTunnel => Some("Connecting…"),
        S::Offline => Some(status_text(state)),
        S::AuthFailed | S::TunnelUnavailable => Some("Failed"),
        S::Disconnected => Some("Connect"),
    };
    Capsule {
        tone,
        words,
        dot: matches!(tone, Tone::Connected | Tone::Offline | Tone::Error),
        status: status_text(state),
        verified_at: status.handshake_at.filter(|_| is_running(state)),
    }
}

/// The tray's view of the connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrayStatus {
    /// Connected or offline: the bridge is up even when the internet is not.
    pub running: bool,
    pub label: &'static str,
}

pub fn tray_status(state: ConnectionState) -> TrayStatus {
    let running = matches!(state, ConnectionState::Connected | ConnectionState::Offline);
    let label = match state {
        ConnectionState::Connected => "Connected",
        ConnectionState::Offline => "No internet",
        _ => "Not connected",
    };
    TrayStatus { running, label }
}

/// `ago`: a coarse age as an English source text and its argument.
pub fn ago(at_ms: u64, now_ms: u64) -> (&'static str, Option<u64>) {
    let seconds = (now_ms.saturating_sub(at_ms) as f64 / 1000.).round() as u64;
    if seconds < 3 {
        return ("just now", None);
    }
    if seconds < 90 {
        return ("{0}s ago", Some(seconds));
    }
    let minutes = (seconds as f64 / 60.).round() as u64;
    if minutes < 90 {
        ("{0}m ago", Some(minutes))
    } else {
        ("{0}h ago", Some((minutes as f64 / 60.).round() as u64))
    }
}

/// The browser row of the connection popover (`connectionPopoverBrowser` in `paintState`).
pub fn browser_text(bridge: &BridgeStatus) -> &'static str {
    if bridge.present {
        "Connected"
    } else if bridge.paired {
        "Paired · not active"
    } else {
        "Not connected"
    }
}
