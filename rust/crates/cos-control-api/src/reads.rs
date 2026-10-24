//! The read routes (`control-reads.ts` and the health and status halves of `control-api.ts`).
//!
//! Each one asks the owner that already holds the fact and projects the answer through an
//! allowlist: a field is published only by being named here or in the owner's own projection.

use std::sync::{Arc, LazyLock};

use cos_sessions::{Cursor, EventPosition, EventQuery, EventsError, ListQuery};
use cos_store::logger::redact;
use cos_tools::{Admission, EpochMs, Kernel};
use cos_types::app_state::{BridgeStatus, ConnectionStatus, LogEntry, SurfaceId};
use cos_types::control_api::{
    CONTROL_API_ACTION_ROUTES, CONTROL_API_PROTOCOL, CONTROL_API_ROUTES, ControlApiActions,
    ControlApiAgent, ControlApiAgents, ControlApiBridge, ControlApiConnection, ControlApiEvents,
    ControlApiHealth, ControlApiInputs, ControlApiLog, ControlApiLogEntry, ControlApiSessionDetail,
    ControlApiSurface, ControlApiText, ControlApiToolCalls, ControlApiTunnel,
};
use cos_types::ids::SessionId;
use cos_types::json::{JsNumber, True};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::query::{Query, Rule, Shape, Target, parse_query};
use crate::reply::{Refusal, Reply};
use crate::server::Server;
use crate::sessions::Sessions;
use crate::text::{clipped_line, line};

const TEXT_CAP: usize = 4_000;
const TITLE_CAP: usize = 200;
const TASK_CAP: usize = 1_000;
const MAX_EVENTS: u64 = 100;
pub(crate) const STREAM_PAGE: u32 = 100;

pub(crate) const EVENT_KINDS: &[&str] = &[
    "session_start",
    "user_message",
    "assistant_message",
    "native_image",
    "progress",
    "page_tool",
    "turn_start",
    "turn_end",
    "chat_error",
    "tool_call",
    "note",
    "agent_message",
    "handoff",
];
/// `decision` rows are the planner's internal work and are never listed.
const INPUT_STATES: &[&str] = &["queued", "browser", "tool", "sent", "cancelled", "failed"];
const LOG_LEVELS: &[&str] = &["info", "warn", "error"];
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) const SESSIONS: Shape = &[
    ("limit", Rule::Integer { min: 1, max: 50 }),
    ("cursor", Rule::Text { min: 1, max: 100 }),
];
pub(crate) const SESSION: Shape = &[("live", Rule::Literal("1"))];
pub(crate) const EVENTS: Shape = &[
    (
        "from",
        Rule::Integer {
            min: 0,
            max: 10_000_000,
        },
    ),
    (
        "before",
        Rule::Integer {
            min: 1,
            max: 10_000_000,
        },
    ),
    (
        "after",
        Rule::Integer {
            min: 0,
            max: 10_000_000,
        },
    ),
    (
        "limit",
        Rule::Integer {
            min: 1,
            max: MAX_EVENTS,
        },
    ),
    ("kinds", Rule::Words(EVENT_KINDS)),
];
pub(crate) const STREAM: Shape = &[
    (
        "from",
        Rule::Integer {
            min: 0,
            max: 10_000_000,
        },
    ),
    ("kinds", Rule::Words(EVENT_KINDS)),
];
pub(crate) const INPUTS: Shape = &[
    ("state", Rule::Words(INPUT_STATES)),
    ("limit", Rule::Integer { min: 1, max: 500 }),
];
pub(crate) const LOG: Shape = &[
    ("limit", Rule::Integer { min: 1, max: 500 }),
    (
        "since",
        Rule::Integer {
            min: 0,
            max: MAX_SAFE_INTEGER,
        },
    ),
    ("level", Rule::Words(LOG_LEVELS)),
];

/// Ids are generated lowercase, and a case-insensitive match would let a differently cased
/// spelling reach the store on filesystems that ignore case, so only the exact spelling routes.
static SESSION_ROUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/v1/sessions/([0-9a-z-]{8,64})(/events)?$")
        .unwrap_or_else(|error| panic!("{error}"))
});

pub(crate) fn health(server: &Server) -> Value {
    let shared = &server.shared;
    let now = EpochMs::now();
    let uptime = now.0.saturating_sub(shared.started_at.0);
    let body = ControlApiHealth {
        ok: True,
        protocol: CONTROL_API_PROTOCOL,
        routes: CONTROL_API_ROUTES
            .iter()
            .map(|route| (*route).to_owned())
            .collect(),
        actions: ControlApiActions {
            enabled: server.actions_allowed(),
            routes: CONTROL_API_ACTION_ROUTES
                .iter()
                .map(|route| (*route).to_owned())
                .collect(),
        },
        pid: std::process::id(),
        app_version: shared.app_version.to_owned(),
        started_at: crate::iso::iso_time(shared.started_at),
        uptime_seconds: JsNumber((uptime as f64 / 1000.0).round()),
    };
    to_value(&body)
}

pub(crate) fn to_value(value: &impl Serialize) -> Value {
    // Every projection is plain data with string keys; serializing it cannot fail.
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Every read that asks an owner something, each under the read deadline.
pub(crate) async fn serve(server: &Arc<Server>, target: &Target) -> Reply {
    let route = target.path.as_str();
    let params = target.params.clone();
    let shared = server.shared.clone();
    let answer = match route {
        "/v1/status" => server.reads.run(async move { Ok(status(&shared)) }).await,
        "/v1/sessions" => server
            .reads
            .run(async move { session_list(&shared.admission, &*shared.sessions, &params).await })
            .await,
        "/v1/inputs" => {
            server
                .reads
                .run(async move { inputs(&shared, &params).await })
                .await
        }
        "/v1/agents" => {
            server
                .reads
                .run(async move {
                    parse_query(&params, &[])?;
                    Ok(agents(&shared))
                })
                .await
        }
        "/v1/log" => server.reads.run(async move { log(&shared, &params) }).await,
        _ => {
            let Some(captures) = SESSION_ROUTE.captures(route) else {
                return Refusal::NotFound.reply();
            };
            let Ok(id) = SessionId::parse(&captures[1]) else {
                return Refusal::NotFound.reply();
            };
            let events = captures.get(2).is_some();
            let heavy = server.heavy.clone();
            server
                .reads
                .run(async move {
                    if events {
                        session_events(&shared.admission, &*shared.sessions, &heavy, id, &params)
                            .await
                    } else {
                        session_detail(&shared.admission, &*shared.sessions, &heavy, id, &params)
                            .await
                    }
                })
                .await
        }
    };
    match answer {
        Ok(body) => Reply::ok(&body),
        Err(refusal) => refusal.reply(),
    }
}

/// Session reads wait behind the startup fence, so they never see a half-restored store.
pub(crate) async fn admitted(admission: &Admission) -> Result<(), Refusal> {
    admission.admit().await.map_err(|_| Refusal::ShuttingDown)
}

/// An allowlist projection of what the Core owns today. `plugins` and `update` have no owner in
/// this build yet, so they are left out rather than invented.
fn status(shared: &crate::Shared) -> Value {
    let connection = shared.connection.borrow().clone();
    let counts = shared.kernel.counts();
    let mut body = Map::new();
    body.insert("appVersion".into(), json!(shared.app_version));
    body.insert(
        "connection".into(),
        to_value(&project_connection(&connection, &shared.kernel)),
    );
    let bridge = shared.bridge.borrow().clone();
    body.insert("bridge".into(), to_value(&project_bridge(&bridge)));
    body.insert(
        "toolCalls".into(),
        to_value(&ControlApiToolCalls {
            running: counts.running,
            settling: counts.settling,
            in_flight: counts.in_flight,
            in_flight_mcp_requests: counts.in_flight_mcp_requests,
        }),
    );
    Value::Object(body)
}

pub(crate) fn project_bridge(bridge: &BridgeStatus) -> ControlApiBridge {
    ControlApiBridge {
        running: bridge.running,
        port: bridge.port,
        port_overridden: bridge.port_overridden == Some(true),
        paired: bridge.paired,
        present: bridge.present,
        last_seen_at: bridge.last_seen_at,
        extension_version: bridge.extension_version.clone(),
        error: bridge
            .error
            .clone()
            .flatten()
            .filter(|error| !error.is_empty())
            .map(|error| redact(&error)),
    }
}

/// The clocks come from the kernel, not from `connection`: requests never pass the connection
/// actor, so its snapshot holds them only as of its last publication. `getStatus` reads them
/// live for the same reason.
pub(crate) fn project_connection(
    connection: &ConnectionStatus,
    kernel: &Kernel,
) -> ControlApiConnection {
    let request_at = |surface| kernel.last_request_at(surface).map(|at| at.0);
    let tool_call_at = |surface| kernel.last_tool_call_at(surface).map(|at| at.0);
    let latest = |clock: &dyn Fn(SurfaceId) -> Option<u64>| {
        SurfaceId::ALL
            .iter()
            .filter_map(|&surface| clock(surface))
            .max()
    };
    ControlApiConnection {
        state: connection.state.as_str().to_owned(),
        detail: redact(&connection.detail),
        handshake_at: connection.handshake_at,
        last_request_at: latest(&request_at),
        last_tool_call_at: latest(&tool_call_at),
        tunnel: connection.health.as_ref().map(|health| ControlApiTunnel {
            poll_errors: health.poll_errors,
            uptime_seconds: health.uptime_seconds,
            route: health.route.clone(),
            probe: health.probe.clone(),
            client_version: health.client_version.clone(),
        }),
        surfaces: connection
            .surfaces
            .iter()
            .map(|surface| ControlApiSurface {
                id: surface.id.as_str().to_owned(),
                state: surface.state.as_str().to_owned(),
                available: surface.available,
                optional: surface.optional,
                detail: redact(&surface.detail),
                tools: u64::try_from(surface.tools.len()).unwrap_or(u64::MAX),
                last_request_at: request_at(surface.id),
                last_tool_call_at: tool_call_at(surface.id),
            })
            .collect(),
    }
}

async fn session_list(
    admission: &Admission,
    sessions: &dyn Sessions,
    params: &[(String, String)],
) -> Result<Value, Refusal> {
    let query = parse_query(params, SESSIONS)?;
    let cursor = query
        .text("cursor")
        .map(|text| {
            Cursor::parse(text).map_err(|_| Refusal::InvalidQuery("cursor is not valid".into()))
        })
        .transpose()?;
    admitted(admission).await?;
    let page = sessions
        .list(ListQuery {
            limit: u32::try_from(query.integer("limit").unwrap_or(20)).unwrap_or(20),
            cursor,
            live: false,
        })
        .await;
    Ok(to_value(&page))
}

async fn session_detail(
    admission: &Admission,
    sessions: &dyn Sessions,
    heavy: &crate::limits::Places,
    id: SessionId,
    params: &[(String, String)],
) -> Result<Value, Refusal> {
    let live = parse_query(params, SESSION)?.text("live").is_some();
    let _place = heavy.take()?;
    admitted(admission).await?;
    let detail = sessions.detail(&id).await.ok_or(Refusal::SessionNotFound)?;
    // Live state belongs to the browser plane, which this build does not have: `live=1` gets the
    // null the app answers for a chat whose state it cannot read.
    let detail = ControlApiSessionDetail {
        session: detail.session,
        live: live.then_some(detail.live.flatten()),
    };
    Ok(to_value(&detail))
}

/// `from` follows live revisions; `before` and `after` page through history. They are two
/// cursors over different orders, and mixing them would silently ignore one.
pub(crate) fn events_query(params: &[(String, String)]) -> Result<Query, Refusal> {
    let query = parse_query(params, EVENTS)?;
    if query.integer("from").is_some()
        && (query.integer("before").is_some() || query.integer("after").is_some())
    {
        return Err(Refusal::InvalidQuery(
            "from cannot be combined with before or after".into(),
        ));
    }
    Ok(query)
}

pub(crate) fn kinds(query: &Query) -> Option<Vec<String>> {
    query
        .words("kinds")
        .map(|words| words.iter().map(|word| (*word).to_owned()).collect())
}

async fn session_events(
    admission: &Admission,
    sessions: &dyn Sessions,
    heavy: &crate::limits::Places,
    id: SessionId,
    params: &[(String, String)],
) -> Result<Value, Refusal> {
    let query = events_query(params)?;
    let (before, after) = (query.integer("before"), query.integer("after"));
    let position = match (query.integer("from"), before, after) {
        (Some(from), _, _) => EventPosition::From(from),
        (None, Some(before), _) => EventPosition::Before(before),
        (None, None, Some(after)) => EventPosition::After(after),
        (None, None, None) => EventPosition::Latest,
    };
    let limit = u32::try_from(query.integer("limit").unwrap_or(50)).unwrap_or(50);
    let _place = heavy.take()?;
    admitted(admission).await?;
    let mut page = events_page(sessions, &id, position, limit, kinds(&query)).await?;
    // `EventPosition` has no window yet: the newest rows before `before`, cut to those after
    // `after`, are the newest rows between the two.
    if let (Some(_), Some(after)) = (before, after) {
        page.events.retain(|event| event.position > after);
    }
    Ok(to_value(&page))
}

pub(crate) async fn events_page(
    sessions: &dyn Sessions,
    id: &SessionId,
    position: EventPosition,
    limit: u32,
    kinds: Option<Vec<String>>,
) -> Result<ControlApiEvents, Refusal> {
    sessions
        .events(
            id,
            EventQuery {
                position,
                limit,
                kinds,
            },
        )
        .await
        .map_err(|error| match error {
            EventsError::NotFound => Refusal::SessionNotFound,
            EventsError::UnknownKind(_) => Refusal::InvalidQuery("kinds is not valid".into()),
        })
}

/// The outbox's rows, in some states, oldest first, the newest `limit` (100 by default).
async fn inputs(shared: &crate::Shared, params: &[(String, String)]) -> Result<Value, Refusal> {
    let query = parse_query(params, INPUTS)?;
    let rows = shared.inputs.list().await.map_err(|error| {
        shared.logger.warn(&format!(
            "control API request failed: {}",
            crate::text::redact_secret_text(&error)
        ));
        Refusal::Internal
    })?;
    let limit = usize::try_from(query.integer("limit").unwrap_or(100)).unwrap_or(100);
    let (inputs, total) = crate::inputs::select(&rows, query.words("state"), limit);
    Ok(to_value(&ControlApiInputs { inputs, total }))
}

/// `projectAgents`: the broker's active families, with their text capped and redacted.
fn agents(shared: &crate::Shared) -> Value {
    let swarm = shared.agents.borrow().clone();
    to_value(&ControlApiAgents {
        enabled: shared.config.borrow().multi_agent.enabled,
        running: swarm.running,
        retained_history: swarm.retained_history == Some(true),
        agents: swarm
            .agents
            .iter()
            .map(|agent| ControlApiAgent {
                run_id: agent.run_id.clone(),
                id: agent.id.clone(),
                role: agent.role.as_str().to_owned(),
                label: line(&agent.label, TITLE_CAP),
                task: plain(&agent.task, TASK_CAP),
                state: agent.state.as_str().to_owned(),
                model: agent.model.clone(),
                reasoning_effort: agent
                    .reasoning_effort
                    .map(|effort| effort.as_str().to_owned()),
                conversation_id: agent.conversation_id.clone(),
                created_at: agent.created_at,
                activated_at: agent.activated_at,
                finished_at: agent.finished_at,
                detached_at: agent.detached_at,
                slept_at: agent.slept_at,
                last_seen_at: agent.last_seen_at,
                revivable: agent.revivable,
                pending: agent.pending,
                awaiting_ack: agent.awaiting_ack,
                delivered: agent.delivered,
                context_tokens: agent.context_tokens,
                result: agent
                    .result
                    .as_deref()
                    .map(|result| plain(result, TEXT_CAP)),
            })
            .collect(),
    })
}

/// `plain`: redacted and capped, counting the original's UTF-16 length.
fn plain(value: &str, cap: usize) -> ControlApiText {
    let (text, truncated) = clipped_line(value, cap);
    ControlApiText {
        text,
        chars: value.encode_utf16().count() as u64,
        truncated,
    }
}

pub(crate) fn project_log(entries: &[LogEntry]) -> Vec<ControlApiLogEntry> {
    entries
        .iter()
        .map(|entry| {
            let (message, truncated) = clipped_line(&entry.message, TEXT_CAP);
            ControlApiLogEntry {
                time: entry.time,
                level: entry.level.as_str().to_owned(),
                message,
                agent: entry
                    .agent
                    .as_deref()
                    .filter(|agent| !agent.is_empty())
                    .map(|agent| line(agent, TITLE_CAP)),
                truncated: truncated.then_some(True),
            }
        })
        .collect()
}

fn log(shared: &crate::Shared, params: &[(String, String)]) -> Result<Value, Refusal> {
    let query = parse_query(params, LOG)?;
    let levels = query.words("level");
    let since = query.integer("since");
    let ring = shared.logger.entries();
    // Inclusive: lines share a millisecond, so a caller that passes the newest time it has seen
    // gets that line again, rather than losing one written just after.
    let matching: Vec<LogEntry> = ring
        .iter()
        .filter(|entry| since.is_none_or(|since| entry.time >= since))
        .filter(|entry| levels.is_none_or(|levels| levels.contains(&entry.level.as_str())))
        .cloned()
        .collect();
    let limit = usize::try_from(query.integer("limit").unwrap_or(200)).unwrap_or(200);
    let newest = &matching[matching.len().saturating_sub(limit)..];
    Ok(to_value(&ControlApiLog {
        entries: project_log(newest),
        ring_size: u64::try_from(ring.len()).unwrap_or(u64::MAX),
    }))
}
