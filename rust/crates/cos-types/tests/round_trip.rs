//! Every fixture the TypeScript app wrote deserializes, re-serializes, and means the same JSON.
//!
//! Fixtures come from `fixture-gen/regenerate.mjs`. Each path names its format; the table in
//! `type_for` maps it to the Rust type that owns it. A fixture with no mapping fails the test,
//! so a newly harvested format cannot go untyped by accident.

use std::fs;
use std::path::{Path, PathBuf};

use cos_types::app_state::AppState;
use cos_types::bridge::{
    ActivityDetailReply, ActivityDetailRequest, ActivityReply, BridgeAccepted, BridgeError,
    BridgeHello, BridgeOk, BridgeSettings, BrowserPreferencesAck, BrowserPresence, ClosedRequest,
    CommandAckReply, CommandAckRequest, CommandStepRequest, CompactReply, CompactRequest,
    CompanionDiagnostics, ConversationDeletedReply, ConversationDeletedRequest, CorePluginReport,
    CorrelationsReply, CorrelationsReport, EventsReport, EventsStored, ExtensionUpdatePrepared,
    ExtensionWakeFrame, GoalAckReply, GoalAckRequest, GoalDraftReply, GoalDraftRequest,
    GoalObjectiveReply, GoalObjectiveRequest, GoalOpenReply, GoalOpenRequest, ImageExportReport,
    InputAttachmentReply, InputAttachmentRequest, InputBindRequest, InputClaimReply, InputRequest,
    ModelsReport, PairRequest, PairResponse, PluginRefreshAction, PluginRefreshReply,
    ProjectCreateReply, ProjectCreateRequest, RedeemRequest, RedeemResponse, RepairClaimReply,
    RepairClaimRequest, RevivalsPendingReply, RevivalsPendingRequest, SettingsUpdate,
    SettingsUpdated, SignInImported, SignInOfferReply, SignInTransferRequest, StatusReply,
    StatusReport, UsageReport, WakeSignal,
};
use cos_types::config::Config;
use cos_types::control_api::{
    ControlApiAgents, ControlApiCancelResult, ControlApiEndpoint, ControlApiError,
    ControlApiEvents, ControlApiHealth, ControlApiInputs, ControlApiLog, ControlApiSendRequest,
    ControlApiSendResult, ControlApiSessionDetail, ControlApiSessionList, ControlApiStatus,
    EventStreamFrame,
};
use cos_types::json::Record;
use cos_types::mcp::{BrowserControlReply, BrowserControlRequest};
use cos_types::session::{AgentPlan, Handoff, SessionEvent, SessionMeta, TurnTrace};
use cos_types::state;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// How a fixture's text is laid out by the TypeScript writer.
#[derive(Clone, Copy)]
enum Layout {
    Compact,
    Pretty,
}

/// Formats whose TypeScript writer fixes the key order (a zod schema or one object literal), so
/// the Rust types declare the same order and must reproduce the file byte for byte.
const BYTE_CANONICAL: &[&str] = &[
    "config.",
    "session/plan.",
    "session/trace.",
    "state/blocked-chats.",
    "state/bridge-commands.",
    "state/chat-models.",
    "state/connector-identity.",
    "state/goal-objectives.",
    "state/goal-switches.",
    "state/main-texts.",
    "state/pet-library.",
    "state/request-plans.",
    "state/retired-workers.",
    "state/trusted-chats.",
    "state/usage-cache.",
    "state/window-bounds.",
];

type Check = fn(&str, Layout) -> Result<bool, String>;

/// Parses `text` as `T`, writes it back, and compares the two as JSON values.
/// Returns whether the bytes matched too.
fn round_trip<T: DeserializeOwned + Serialize>(text: &str, layout: Layout) -> Result<bool, String> {
    let original: Value =
        serde_json::from_str(text).map_err(|error| format!("not JSON: {error}"))?;
    let typed: T =
        serde_json::from_str(text).map_err(|error| format!("does not deserialize: {error}"))?;
    let written = match layout {
        Layout::Compact => serde_json::to_string(&typed),
        Layout::Pretty => serde_json::to_string_pretty(&typed),
    }
    .map_err(|error| format!("does not serialize: {error}"))?;
    let reread: Value =
        serde_json::from_str(&written).map_err(|error| format!("wrote invalid JSON: {error}"))?;
    if reread != original {
        return Err(format!(
            "changed on the way back:\n  before {original}\n  after  {reread}"
        ));
    }
    Ok(written == text)
}

fn ledger_check(name: &str) -> Option<Check> {
    Some(match name {
        "blocked-chats" => round_trip::<state::BlockedChats>,
        "bridge-commands" => round_trip::<state::BridgeCommands>,
        "chat-models" => round_trip::<state::ChatModels>,
        "connector-identity" => round_trip::<state::ConnectorIdentity>,
        "continuations" => round_trip::<state::Continuations>,
        "goal-objectives" => round_trip::<state::GoalObjectives>,
        "goal-replies" => round_trip::<state::GoalReplies>,
        "goal-switches" => round_trip::<state::GoalSwitches>,
        "main-texts" => round_trip::<state::MainTexts>,
        "pet-library" => round_trip::<state::PetLibrary>,
        "plugin-refresh" => round_trip::<state::PluginRefreshRows>,
        "plugins" => round_trip::<state::Plugins>,
        "projects" => round_trip::<state::Projects>,
        "request-correlations" => round_trip::<state::RequestCorrelations>,
        "request-plans" => round_trip::<state::RequestPlans>,
        "retired-workers" => round_trip::<state::RetiredWorkers>,
        "session-input" => round_trip::<state::SessionInput>,
        "swarm" => round_trip::<state::SwarmSnapshot>,
        "trusted-chats" => round_trip::<state::TrustedChats>,
        "usage-cache" => round_trip::<state::UsageCache>,
        "window-bounds" => round_trip::<state::WindowPlacement>,
        _ => return None,
    })
}

/// The type of a successful reply, by plane, method and route with ids folded to `{id}`.
fn reply_check(plane: &str, route: &str) -> Option<Check> {
    Some(match (plane, route) {
        ("control-api", "GET /v1/health") => round_trip::<ControlApiHealth>,
        ("control-api", "GET /v1/status") => round_trip::<ControlApiStatus>,
        ("control-api", "GET /v1/sessions") => round_trip::<ControlApiSessionList>,
        ("control-api", "GET /v1/sessions/{id}") => round_trip::<ControlApiSessionDetail>,
        ("control-api", "GET /v1/sessions/{id}/events") => round_trip::<ControlApiEvents>,
        ("control-api", "GET /v1/inputs") => round_trip::<ControlApiInputs>,
        ("control-api", "GET /v1/agents") => round_trip::<ControlApiAgents>,
        ("control-api", "GET /v1/log") => round_trip::<ControlApiLog>,
        ("control-api", "POST /v1/inputs") => round_trip::<ControlApiSendResult>,
        ("control-api", "POST /v1/inputs/{id}/cancel") => round_trip::<ControlApiCancelResult>,
        ("bridge", "GET /hello") => round_trip::<BridgeHello>,
        ("bridge", "POST /pair") => round_trip::<PairResponse>,
        ("bridge", "POST /browser/presence") => round_trip::<BridgeOk>,
        ("bridge", "GET /settings") => round_trip::<BridgeSettings>,
        ("bridge", "POST /commands/redeem") => round_trip::<RedeemResponse>,
        ("bridge", "POST /browser-control") => round_trip::<BrowserControlReply>,
        ("bridge", "POST /closed" | "POST /core-plugin") => round_trip::<BridgeOk>,
        ("bridge", "POST /activity/detail") => round_trip::<ActivityDetailReply>,
        ("bridge", "POST /commands/ack") => round_trip::<CommandAckReply>,
        ("bridge", "POST /commands/step" | "POST /input/ack" | "POST /input/bind") => {
            round_trip::<BridgeAccepted>
        }
        ("bridge", "POST /commands/revivals/pending") => round_trip::<RevivalsPendingReply>,
        ("bridge", "POST /conversation-deleted") => round_trip::<ConversationDeletedReply>,
        ("bridge", "POST /input/claim") => round_trip::<InputClaimReply>,
        ("bridge", "POST /repairs/claim") => round_trip::<RepairClaimReply>,
        ("bridge", "POST /project-create") => round_trip::<ProjectCreateReply>,
        ("bridge", "GET /cos-browser/sign-in") => round_trip::<SignInOfferReply>,
        ("bridge", "POST /cos-browser/sign-in") => round_trip::<SignInImported>,
        ("bridge", "POST /goal/ack") => round_trip::<GoalAckReply>,
        ("bridge", "POST /goal/objective") => round_trip::<GoalObjectiveReply>,
        ("bridge", "POST /goal/open") => round_trip::<GoalOpenReply>,
        ("bridge", "POST /settings") => round_trip::<SettingsUpdated>,
        ("bridge", "GET /activity") => round_trip::<ActivityReply>,
        ("bridge", "GET /status" | "POST /status") => round_trip::<StatusReply>,
        ("bridge", "POST /compact") => round_trip::<CompactReply>,
        ("bridge", "POST /correlations") => round_trip::<CorrelationsReply>,
        ("bridge", "POST /diagnostics" | "POST /usage") => round_trip::<BridgeOk>,
        ("bridge", "POST /events") => round_trip::<EventsStored>,
        ("bridge", "POST /goal/draft") => round_trip::<GoalDraftReply>,
        (
            "bridge",
            "POST /models"
            | "POST /browser/preferences"
            | "POST /image-export"
            | "POST /input/answer"
            | "POST /input/fail"
            | "POST /input/progress",
        ) => round_trip::<BridgeAccepted>,
        ("bridge", "POST /plugin-refresh") => round_trip::<PluginRefreshReply>,
        ("bridge", "POST /extension/update") => round_trip::<ExtensionUpdatePrepared>,
        ("bridge", "POST /input/attachment") => round_trip::<InputAttachmentReply>,
        _ => return None,
    })
}

/// `/diagnostics` takes any JSON and keeps only the fields it can read, so its check is that
/// the body sanitises and the sanitised value round-trips.
fn diagnostics_check(text: &str, layout: Layout) -> Result<bool, String> {
    let body: Value = serde_json::from_str(text).map_err(|error| format!("not JSON: {error}"))?;
    let kept = CompanionDiagnostics::sanitise(&body).ok_or("the diagnostics did not sanitise")?;
    let written =
        serde_json::to_string(&kept).map_err(|error| format!("does not serialize: {error}"))?;
    round_trip::<CompanionDiagnostics>(&written, layout).map(|_| false)
}

fn request_check(plane: &str, route: &str) -> Option<Check> {
    Some(match (plane, route) {
        ("control-api", "POST /v1/inputs") => round_trip::<ControlApiSendRequest>,
        ("bridge", "POST /pair") => round_trip::<PairRequest>,
        ("bridge", "POST /browser/presence") => round_trip::<BrowserPresence>,
        ("bridge", "POST /commands/redeem") => round_trip::<RedeemRequest>,
        ("bridge", "POST /browser-control") => round_trip::<BrowserControlRequest>,
        ("bridge", "POST /closed") => round_trip::<ClosedRequest>,
        ("bridge", "POST /activity/detail") => round_trip::<ActivityDetailRequest>,
        ("bridge", "POST /commands/ack") => round_trip::<CommandAckRequest>,
        ("bridge", "POST /commands/step") => round_trip::<CommandStepRequest>,
        ("bridge", "POST /commands/revivals/pending") => round_trip::<RevivalsPendingRequest>,
        ("bridge", "POST /conversation-deleted") => round_trip::<ConversationDeletedRequest>,
        ("bridge", "POST /core-plugin") => round_trip::<CorePluginReport>,
        ("bridge", "POST /input/bind") => round_trip::<InputBindRequest>,
        (
            "bridge",
            "POST /input/claim"
            | "POST /input/ack"
            | "POST /input/answer"
            | "POST /input/fail"
            | "POST /input/progress",
        ) => round_trip::<InputRequest>,
        ("bridge", "POST /repairs/claim") => round_trip::<RepairClaimRequest>,
        ("bridge", "POST /project-create") => round_trip::<ProjectCreateRequest>,
        ("bridge", "POST /cos-browser/sign-in") => round_trip::<SignInTransferRequest>,
        ("bridge", "POST /goal/ack") => round_trip::<GoalAckRequest>,
        ("bridge", "POST /goal/objective") => round_trip::<GoalObjectiveRequest>,
        ("bridge", "POST /goal/open") => round_trip::<GoalOpenRequest>,
        ("bridge", "POST /settings") => round_trip::<SettingsUpdate>,
        ("bridge", "POST /status") => round_trip::<StatusReport>,
        ("bridge", "POST /compact") => round_trip::<CompactRequest>,
        ("bridge", "POST /correlations") => round_trip::<CorrelationsReport>,
        ("bridge", "POST /diagnostics") => diagnostics_check,
        ("bridge", "POST /events") => round_trip::<EventsReport>,
        ("bridge", "POST /goal/draft") => round_trip::<GoalDraftRequest>,
        ("bridge", "POST /models") => round_trip::<ModelsReport>,
        ("bridge", "POST /plugin-refresh") => round_trip::<PluginRefreshAction>,
        ("bridge", "POST /browser/preferences") => round_trip::<BrowserPreferencesAck>,
        ("bridge", "POST /image-export") => round_trip::<ImageExportReport>,
        ("bridge", "POST /usage") => round_trip::<UsageReport>,
        ("bridge", "POST /input/attachment") => round_trip::<InputAttachmentRequest>,
        _ => return None,
    })
}

fn fold_ids(route: &str) -> String {
    route
        .split('/')
        .map(|part| {
            let id_like = part.len() >= 8
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
            if id_like { "{id}" } else { part }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Checks one HTTP exchange fixture: the reply always, the request where it is typed.
fn check_exchange(plane: &str, text: &str) -> Result<(), String> {
    let exchange: Value =
        serde_json::from_str(text).map_err(|error| format!("not JSON: {error}"))?;
    let method = exchange["method"]
        .as_str()
        .ok_or("exchange has no method")?;
    let path = exchange["route"].as_str().ok_or("exchange has no route")?;
    let status = exchange["status"]
        .as_u64()
        .ok_or("exchange has no status")?;
    let route = format!("{method} {}", fold_ids(path));
    let response = exchange["response"].to_string();
    let request = &exchange["request"];

    if (200..300).contains(&status) {
        match reply_check(plane, &route) {
            Some(check) => check(&response, Layout::Compact).map(|_| ()),
            None if plane == "control-api" && route == "GET /v1/sessions/{id}/events/stream" => {
                Ok(())
            }
            None => Err(format!("no Rust type for the {plane} reply to {route}")),
        }?;
        if !request.is_null()
            && let Some(check) = request_check(plane, &route)
        {
            check(&request.to_string(), Layout::Compact)
                .map_err(|error| format!("request: {error}"))?;
        }
        Ok(())
    } else if plane == "control-api" {
        round_trip::<ControlApiError>(&response, Layout::Compact).map(|_| ())
    } else {
        // A refused browser-control claim answers 409 with its ordinary `{ command: null }` reply.
        round_trip::<BridgeError>(&response, Layout::Compact)
            .or_else(|error| match reply_check(plane, &route) {
                Some(check) => check(&response, Layout::Compact),
                None => Err(error),
            })
            .map(|_| ())
    }
}

/// An event stream fixture: every frame parses, and writing the frames back gives the same
/// stream, with each event's `data` the same JSON.
fn check_stream(text: &str) -> Result<bool, String> {
    let fixture: Value =
        serde_json::from_str(text).map_err(|error| format!("not JSON: {error}"))?;
    let stream = fixture["stream"]
        .as_str()
        .ok_or("stream fixture has no stream")?;
    let frames = EventStreamFrame::parse_stream(stream)?;
    let written: String = frames.iter().map(EventStreamFrame::to_text).collect();
    let lines = |text: &str| -> Vec<Value> {
        text.lines()
            .map(|line| match line.strip_prefix("data: ") {
                Some(data) => serde_json::from_str(data).unwrap_or_else(|_| Value::from(line)),
                None => Value::from(line),
            })
            .collect()
    };
    if lines(&written) != lines(stream) {
        return Err(format!(
            "changed on the way back:\n  before {stream:?}\n  after  {written:?}"
        ));
    }
    Ok(written == stream)
}

/// A wake socket frame: the app's signals and the extension's `pong` parse and write back.
fn check_wake(text: &str) -> Result<bool, String> {
    let frame: Value = serde_json::from_str(text).map_err(|error| format!("not JSON: {error}"))?;
    let message = frame["message"]
        .as_str()
        .ok_or("wake frame has no message")?;
    let written = match frame["from"].as_str() {
        Some("app") => WakeSignal::parse(message)
            .map(WakeSignal::as_str)
            .map(str::to_owned),
        Some("extension") => {
            ExtensionWakeFrame::parse(message, true).map(|frame| frame.as_str().to_owned())
        }
        other => return Err(format!("wake frame from {other:?}")),
    };
    match written {
        Some(written) if written == message => Ok(false),
        _ => Err(format!("{message:?} is not a wake frame")),
    }
}

/// The checker for one fixture, from its path below `tests/fixtures`.
fn checker(relative: &str) -> Result<Check, String> {
    let parts: Vec<&str> = relative.split('/').collect();
    let stem = parts
        .last()
        .and_then(|name| name.split('.').next())
        .unwrap_or_default();
    let check: Check = match parts.as_slice() {
        [_] if stem == "config" => |text, _| round_trip::<Config>(text, Layout::Pretty),
        [_] if stem == "app-state" => round_trip::<AppState>,
        ["control-api", _] => round_trip::<ControlApiEndpoint>,
        ["session", "events" | "message", _] => round_trip::<SessionEvent>,
        ["session", _] => match stem {
            "meta" => |text, _| round_trip::<SessionMeta>(text, Layout::Pretty),
            "handoff" => |text, _| round_trip::<Handoff>(text, Layout::Pretty),
            "plan" => round_trip::<AgentPlan>,
            "trace" => round_trip::<TurnTrace>,
            "legacy-messages" => round_trip::<Record<SessionEvent>>,
            _ => return Err(format!("unknown session file {relative}")),
        },
        ["state", _] => ledger_check(stem).ok_or_else(|| format!("unknown ledger {stem}"))?,
        ["http", "bridge", _] => |text, _| check_exchange("bridge", text).map(|()| false),
        ["http", "control-api", _] => |text, _| check_exchange("control-api", text).map(|()| false),
        ["sse", "control-api", _] => |text, _| check_stream(text),
        ["ws", _] if stem == "wake" => |text, _| check_wake(text),
        _ => return Err(format!("no mapping for fixture {relative}")),
    };
    Ok(check)
}

fn fixtures(dir: &Path, into: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            fixtures(&path, into)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            into.push(path);
        }
    }
    Ok(())
}

#[test]
fn every_typescript_fixture_round_trips() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures");
    let mut paths = Vec::new();
    if let Err(error) = fixtures(&root, &mut paths) {
        panic!("cannot list fixtures in {}: {error}", root.display());
    }
    paths.sort();
    assert!(
        paths.len() > 100,
        "expected the harvested fixture set, found {} files",
        paths.len()
    );

    let mut failures = Vec::new();
    let mut byte_equal = 0usize;
    for path in &paths {
        let relative = path
            .strip_prefix(&root)
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.display().to_string());
        let outcome = fs::read_to_string(path)
            .map_err(|error| format!("unreadable: {error}"))
            .and_then(|text| checker(&relative).and_then(|check| check(&text, Layout::Compact)));
        let canonical = BYTE_CANONICAL
            .iter()
            .any(|prefix| relative.starts_with(prefix));
        match outcome {
            Ok(true) => byte_equal += 1,
            Ok(false) if canonical => {
                failures.push(format!("{relative}: same JSON, but not the same bytes"))
            }
            Ok(false) => {}
            Err(error) => failures.push(format!("{relative}: {error}")),
        }
    }
    println!(
        "{} fixtures round-trip; {byte_equal} also byte-for-byte",
        paths.len()
    );
    assert!(
        failures.is_empty(),
        "{} of {} fixtures failed:\n{}",
        failures.len(),
        paths.len(),
        failures.join("\n")
    );
}
