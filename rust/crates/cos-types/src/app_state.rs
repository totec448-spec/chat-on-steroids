//! `AppState` (`src/shared/types.ts`): everything the window renders, built by `ipc.ts` `buildState`.

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::json::{JsNumber, Record, nullable, string_enum};

string_enum! {
    pub enum PlatformFamily { Windows = "windows", Macos = "macos", Linux = "linux", Other = "other" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub family: PlatformFamily,
    pub name: String,
    pub desktop_automation: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SecureStorageInfo {
    pub available: bool,
    pub detail: Option<String>,
}

string_enum! {
    pub enum ConnectionState {
        Disconnected = "disconnected", Disconnecting = "disconnecting", StartingServer = "starting-server",
        ConnectingTunnel = "connecting-tunnel", Connected = "connected", Offline = "offline",
        AuthFailed = "auth-failed", TunnelUnavailable = "tunnel-unavailable",
    }
}

/// What the tunnel program reports about itself; every field is null when unreadable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelHealth {
    pub poll_errors: Option<u64>,
    pub uptime_seconds: Option<JsNumber>,
    pub route: Option<String>,
    pub probe: Option<String>,
    pub client_version: Option<String>,
}

string_enum! {
    pub enum SurfaceId { Core = "core", Desktop = "desktop", Plugins = "plugins" }
}

string_enum! {
    pub enum SurfaceConnectionState { Off = "off", Starting = "starting", Live = "live", Error = "error" }
}

/// Evidence from earlier runs, through the tunnel this connector uses now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceProof {
    pub request_at: Option<u64>,
    pub tool_call_at: Option<u64>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub installed_at: Option<Option<u64>>,
}

/// One model-facing connector (`SurfaceStatus`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceStatus {
    pub id: SurfaceId,
    pub connector_name: String,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub chatgpt_name: Option<Option<String>>,
    pub description: String,
    pub card_summary: String,
    pub optional: bool,
    pub available: bool,
    pub local_url: Option<String>,
    pub public_url: Option<String>,
    pub tools: Vec<String>,
    pub state: SurfaceConnectionState,
    pub detail: String,
    pub last_request_at: Option<u64>,
    pub last_tool_call_at: Option<u64>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub proof: Option<Option<SurfaceProof>>,
}

/// `ConnectionStatus`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub state: ConnectionState,
    pub detail: String,
    pub public_url: Option<String>,
    pub local_url: Option<String>,
    pub handshake_at: Option<u64>,
    pub last_request_at: Option<u64>,
    pub last_tool_call_at: Option<u64>,
    pub health: Option<TunnelHealth>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub route_settling_until: Option<Option<u64>>,
    pub surfaces: Vec<SurfaceStatus>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionProof {
    pub version: String,
    pub signed_in: Option<bool>,
}

/// The extension in the person's own browser, apart from the CoS browser's copy.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalExtension {
    pub present: bool,
    pub version: Option<String>,
    pub last_seen_at: Option<u64>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub signed_in: Option<Option<bool>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub proof: Option<Option<ExtensionProof>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CosExtension {
    pub present: bool,
}

/// What the renderer knows about the extension bridge, without secrets (`BridgeStatus`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_overridden: Option<bool>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub error: Option<Option<String>>,
    pub running: bool,
    pub port: Option<u16>,
    pub paired: bool,
    pub present: bool,
    pub last_seen_at: Option<u64>,
    pub extension_version: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub external_extension: Option<Option<ExternalExtension>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cos_extension: Option<CosExtension>,
}

string_enum! {
    pub enum UpdateStage { Idle = "idle", Checking = "checking", Downloading = "downloading", Ready = "ready", Failed = "failed" }
}

/// Whether a newer release exists and what this installation does about it (`UpdateStatus`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub latest: Option<String>,
    pub stage: UpdateStage,
    pub error: Option<String>,
    pub checked_at: Option<u64>,
}

string_enum! {
    pub enum MacOsPermissionState { Granted = "granted", Missing = "missing", Unknown = "unknown" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacOsDesktopAccessStatus {
    pub screen: MacOsPermissionState,
    pub accessibility: MacOsPermissionState,
    pub checked_at: u64,
    pub error: Option<String>,
}

/// Everything the window renders (`AppState`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub config: Config,
    pub status: ConnectionStatus,
    /// Declaration fingerprint per published surface (`Partial<Record<SurfaceId, string>>`).
    pub connector_schemas: Record<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_connector_schemas: Option<Record<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_refresh_unreadable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_storage_full: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials_unreadable: Option<bool>,
    pub platform: PlatformInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_startup_available: Option<bool>,
    pub secure_storage: SecureStorageInfo,
    pub has_api_key: bool,
    pub has_goal_key: bool,
    pub has_custom_provider_key: bool,
    pub resolved_binary: Option<String>,
    pub bundled_tunnel_version: Option<String>,
    pub bridge: BridgeStatus,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub cos_browser_signed_in: Option<Option<bool>>,
    pub update: UpdateStatus,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub desktop_access: Option<Option<MacOsDesktopAccessStatus>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_recovered: Option<bool>,
}

string_enum! {
    pub enum LogLevel { Info = "info", Warn = "warn", Error = "error" }
}

/// One in-memory diagnostics line (`LogEntry`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LogEntry {
    pub time: u64,
    pub level: LogLevel,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

string_enum! {
    pub enum CheckStatus { Pass = "pass", Fail = "fail", Skipped = "skipped", NotRun = "not-run" }
}

/// One link in the chain from ChatGPT to this PC, as the self-test reports it (`Check`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
    pub ok: Option<bool>,
    pub detail: String,
}

/// The self-test result (`Diagnosis`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Diagnosis {
    pub checks: Vec<Check>,
    pub summary: String,
}
