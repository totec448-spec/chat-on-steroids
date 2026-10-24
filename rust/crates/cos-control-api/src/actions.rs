//! The action routes (`control-actions.ts` and `handleAction` in `control-api.ts`): send a
//! message to a chat or start a new one, and cancel one that has not been handed over.
//!
//! There is no send path of its own: a message goes through the outbox, the same owner the
//! composer uses, which stays the only owner of what was admitted, delivered or unknown. The
//! caller's UUID is the outbox id, so repeating it answers the row that already exists.

use std::sync::{Arc, LazyLock};

use cos_tools::EpochMs;
use cos_types::control_api::{ControlApiCancelResult, ControlApiDelivery, ControlApiSendResult};
use cos_types::ids::SessionId;
use cos_types::state::{InputEntry, InputPurpose, InputState};
use hyper::header::{CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, TRANSFER_ENCODING};
use hyper::http::request::Parts;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::Shared;
use crate::inputs::{delivery, project_input};
use crate::query::Target;
use crate::reads::{admitted, to_value};
use crate::reply::{Refusal, Reply};
use crate::server::{RequestBody, Server, declared_length};
use crate::sessions::Sessions;
use crate::text::{js_length, js_trim};

/// A message is at most 64,000 characters, which is 384,000 bytes when every one is escaped as
/// `\u00XX`.
const MAX_BODY_BYTES: u64 = 512 * 1024;
const MAX_TEXT: usize = 64_000;

const BUSY: &str = "another message for this chat is still awaiting delivery";
const ID_TAKEN: &str = "this id belongs to a different message";
const ANSWERING: &str = "the chat is answering; pass interrupt:true to send into that answer";
const BEGAN_ANSWERING: &str =
    "the chat began answering while the message was being admitted; it was withdrawn";
const NO_PROJECTS: &str = "this build cannot look up local projects yet; nothing was sent";

fn pattern(text: &str) -> Regex {
    Regex::new(text).unwrap_or_else(|error| panic!("{text}: {error}"))
}

static ANY_CANCEL: LazyLock<Regex> = LazyLock::new(|| pattern(r"^/v1/inputs/[^/]+/cancel$"));
static CANCEL: LazyLock<Regex> = LazyLock::new(|| pattern(r"^/v1/inputs/([0-9a-f-]{36})/cancel$"));
/// zod 4's `z.string().uuid()`.
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\
         |00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    )
});
static SESSION_ID: LazyLock<Regex> = LazyLock::new(|| pattern("^[0-9a-z-]{8,64}$"));
static JSON_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(r"(?i)^application/json(?:[\t\n\x0B\x0C\r ]*;[\t\n\x0B\x0C\r ]*charset=utf-8)?$")
});

/// Every path an action can arrive on, whatever the id, so one gate refuses them all alike.
pub(crate) fn is_action_path(route: &str) -> bool {
    route == "/v1/inputs" || ANY_CANCEL.is_match(route)
}

/// `handleAction`: the action budget, then the query, then the body, then one action at a time.
pub(crate) async fn handle(
    server: &Arc<Server>,
    parts: &Parts,
    body: &mut RequestBody,
    target: &Target,
) -> Reply {
    if !server.action_window.spend() {
        return Refusal::ActionRateLimited.reply();
    }
    if !target.search.is_empty() {
        return Refusal::InvalidQuery("actions take no query string".into()).reply();
    }
    let raw = match read_body(server, parts, body).await {
        Ok(raw) => raw,
        Err(reply) => return reply,
    };
    let parsed = if raw.is_empty() {
        None
    } else {
        // `TextDecoder` drops a leading byte order mark before `JSON.parse` sees the text.
        let text = raw.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&raw);
        match serde_json::from_slice::<Value>(text) {
            Ok(value) => Some(value),
            Err(_) => return Refusal::InvalidJson.reply(),
        }
    };
    let route = target.path.clone();
    let action_server = server.clone();
    let answer = server
        .actions
        .run(async move {
            // The switch can flip while a body is arriving or an earlier action runs.
            if !action_server.actions_allowed() {
                return Err(Refusal::ActionsDisabled);
            }
            if route == "/v1/inputs" {
                return send(&action_server, parsed.as_ref()).await;
            }
            match CANCEL.captures(&route) {
                Some(id) => cancel(&action_server.shared, &id[1], parsed.as_ref()).await,
                None => Err(Refusal::NotFound),
            }
        })
        .await;
    match answer {
        Ok(reply) => reply,
        Err(refusal) => refusal.reply(),
    }
}

/// The declared body, refused from its headers when the API will not read it.
async fn read_body(
    server: &Server,
    parts: &Parts,
    body: &mut RequestBody,
) -> Result<bytes::Bytes, Reply> {
    let headers = &parts.headers;
    if headers.contains_key(TRANSFER_ENCODING) || headers.contains_key(CONTENT_ENCODING) {
        return Err(Refusal::InvalidFraming.reply());
    }
    if let Some(declared) = headers.get(CONTENT_LENGTH) {
        let digits = declared.as_bytes();
        if !(1..=9).contains(&digits.len()) || !digits.iter().all(u8::is_ascii_digit) {
            return Err(Refusal::InvalidFraming.reply());
        }
    }
    let length = declared_length(parts);
    // Refused from the declared length, before a byte is read.
    if length > MAX_BODY_BYTES {
        return Err(Refusal::BodyTooLarge.reply());
    }
    let json = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| JSON_TYPE.is_match(value));
    if length > 0 && !json {
        return Err(Refusal::UnsupportedMediaType.reply());
    }
    if length == 0 {
        return Ok(bytes::Bytes::new());
    }
    // Taking the body is what invites it: hyper answers `100 Continue` on the first read.
    let Some(incoming) = body.take() else {
        return Ok(bytes::Bytes::new());
    };
    let limit = usize::try_from(MAX_BODY_BYTES).unwrap_or(usize::MAX);
    match tokio::time::timeout(
        server.timing.body_timeout,
        cos_http::read_body(incoming, limit),
    )
    .await
    {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(_)) => Err(Refusal::InvalidFraming.reply()),
        Err(_) => Err(Refusal::BodyTimeout.reply()),
    }
}

fn invalid(detail: &str) -> Refusal {
    Refusal::InvalidBody(detail.to_owned())
}

fn lower_uuid(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| UUID.is_match(text) && text == text.to_lowercase())
}

/// One field of a body schema: its name, and whether a value or its absence is valid.
type Field<'a> = (&'a str, &'a dyn Fn(Option<&Value>) -> bool);

/// `z.object(shape).strict()` over a parsed body: the fields in declaration order, then any
/// unknown field. `None` and `null` are read as `{}`, as `body ?? {}` does.
fn object<'a>(
    body: Option<&'a Value>,
    fields: &[Field<'_>],
) -> Result<&'a Map<String, Value>, Refusal> {
    static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);
    let object = match body {
        None | Some(Value::Null) => &*EMPTY,
        Some(Value::Object(object)) => object,
        Some(_) => return Err(invalid("body is not valid")),
    };
    for (name, valid) in fields {
        if !valid(object.get(*name)) {
            return Err(invalid(&format!("{name} is not valid")));
        }
    }
    if object
        .keys()
        .any(|key| !fields.iter().any(|(name, _)| name == key))
    {
        return Err(invalid("unknown field"));
    }
    Ok(object)
}

pub(crate) struct SendBody {
    id: String,
    session: Option<SessionId>,
    project: Option<String>,
    text: String,
    interrupt: bool,
}

/// `sendBody`.
pub(crate) fn send_body(body: Option<&Value>) -> Result<SendBody, Refusal> {
    let optional = |check: fn(&Value) -> bool| move |value: Option<&Value>| value.is_none_or(check);
    let session_id = optional(|value| value.as_str().is_some_and(|text| SESSION_ID.is_match(text)));
    let project_id = optional(lower_uuid);
    let interrupt = optional(Value::is_boolean);
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .is_some_and(|text| js_length(text) <= MAX_TEXT && !js_trim(text).is_empty())
    };
    let object = object(
        body,
        &[
            ("id", &|value: Option<&Value>| value.is_some_and(lower_uuid)),
            ("sessionId", &session_id),
            ("projectId", &project_id),
            ("text", &text),
            ("interrupt", &interrupt),
        ],
    )?;
    let session = object.get("sessionId").and_then(Value::as_str);
    let project = object.get("projectId").and_then(Value::as_str);
    if session.is_some() && project.is_some() {
        return Err(invalid("projectId is not valid"));
    }
    let text = |name: &str| object.get(name).and_then(Value::as_str).unwrap_or_default();
    Ok(SendBody {
        id: text("id").to_owned(),
        session: session.and_then(|id| SessionId::parse(id).ok()),
        project: project.map(str::to_owned),
        text: js_trim(text("text")).to_owned(),
        interrupt: object.get("interrupt") == Some(&Value::Bool(true)),
    })
}

/// The outbox refuses in words; these are the ones a caller can act on (`refusal`).
fn outbox_refusal(message: &str) -> Option<Refusal> {
    Some(match message {
        "The app is shutting down" => Refusal::ShuttingDown,
        "Input cancelled" => Refusal::Conflict("cancelled", None),
        "Message id already belongs to different input" => Refusal::Conflict("id_conflict", None),
        "Unblock this conversation before sending" => Refusal::Conflict("chat_blocked", None),
        "This recording has no ChatGPT conversation" => Refusal::Conflict("no_chat", None),
        "The message queue is full" => Refusal::QueueFull,
        _ if message.starts_with("One message is already awaiting delivery") => {
            Refusal::Conflict("busy", Some(BUSY))
        }
        _ => return None,
    })
}

/// An owner failed in a way no caller can act on: logged, and answered `internal_error`.
fn failed(shared: &Shared, message: &str) -> Refusal {
    shared.logger.warn(&format!(
        "control API request failed: {}",
        crate::text::redact_secret_text(message)
    ));
    Refusal::Internal
}

async fn find(shared: &Shared, id: &str) -> Result<Option<InputEntry>, Refusal> {
    let rows = shared
        .inputs
        .list()
        .await
        .map_err(|error| failed(shared, &error))?;
    Ok(rows.into_iter().find(|row| row.id == id))
}

/// A worker or helper chat belongs to the run that opened it.
async fn controllable(sessions: &dyn Sessions, session: Option<&str>) -> Result<(), Refusal> {
    let Some(id) = session.and_then(|id| SessionId::parse(id).ok()) else {
        return Ok(());
    };
    let origin = sessions
        .detail(&id)
        .await
        .and_then(|detail| detail.session.origin);
    if origin.is_some_and(|origin| origin.kind == "worker" || origin.kind == "helper") {
        return Err(Refusal::SessionNotControllable);
    }
    Ok(())
}

/// `send`: every check the app makes before the outbox, in its order, then the outbox.
async fn send(server: &Server, body: Option<&Value>) -> Result<Reply, Refusal> {
    let shared = &*server.shared;
    let body = send_body(body)?;
    admitted(&shared.admission).await?;
    // A repeated id names the row that already exists. It is answered here because the outbox
    // compares the whole request, `dueAt` included, and a retry a moment later would not match.
    if let Some(existing) = find(shared, &body.id).await? {
        // A new chat's first message is filed under its own id.
        let owner = body
            .session
            .as_ref()
            .map_or(body.id.as_str(), SessionId::as_str);
        if existing.purpose == Some(InputPurpose::Decision)
            || existing.session_id.as_deref() != Some(owner)
            || existing.text != body.text
        {
            return Err(Refusal::Conflict("id_conflict", Some(ID_TAKEN)));
        }
        let replay = ControlApiSendResult {
            input: project_input(&existing),
            replayed: true,
        };
        return Ok(Reply::ok(&to_value(&replay)));
    }
    match &body.session {
        // Looking a project up needs the projects owner, which this build does not have.
        None if body.project.is_some() => return Err(Refusal::Unavailable(NO_PROJECTS)),
        None => {}
        Some(session) => {
            let detail = shared
                .sessions
                .detail(session)
                .await
                .ok_or(Refusal::SessionNotFound)?;
            controllable(&*shared.sessions, Some(session.as_str())).await?;
            if detail.session.conversation_id.is_none() {
                return Err(Refusal::NoChat);
            }
            // A send into an answer being written ends that part of the turn. That is the
            // caller's decision, not a default.
            if shared.inputs.answering(session.as_str()).await && !body.interrupt {
                return Err(Refusal::Conflict("would_interrupt", Some(ANSWERING)));
            }
        }
    }
    let mut input = Map::new();
    input.insert("id".into(), json!(body.id));
    input.insert(
        "sessionId".into(),
        json!(body.session.as_ref().map(SessionId::as_str)),
    );
    if let Some(project) = &body.project {
        input.insert("projectId".into(), json!(project));
    }
    input.insert("text".into(), json!(body.text));
    input.insert("mode".into(), json!("auto"));
    input.insert("dueAt".into(), json!(EpochMs::now().0));
    input.insert("model".into(), Value::Null);
    input.insert("reasoningEffort".into(), Value::Null);
    input.insert("authoredSource".into(), json!("text"));
    // The switch can flip while the lookups above run; this is the last point before the outbox.
    if !server.actions_allowed() {
        return Err(Refusal::ActionsDisabled);
    }
    let row = shared
        .inputs
        .enqueue(Value::Object(input))
        .await
        .map_err(|error| outbox_refusal(&error).unwrap_or_else(|| failed(shared, &error)))?;
    // The outbox decides for itself whether this send stops an answer. A turn that began after
    // the check above is not one the caller agreed to stop: the row is withdrawn.
    if row.direct_turn.is_some() && !body.interrupt {
        shared
            .inputs
            .cancel(&row.id)
            .await
            .map_err(|error| failed(shared, &error))?;
        return Err(Refusal::Conflict("would_interrupt", Some(BEGAN_ANSWERING)));
    }
    shared.logger.info(&match &body.session {
        None => format!("control API: message {} admitted as a new chat", row.id),
        Some(session) => format!(
            "control API: message {} admitted for session {session}",
            row.id
        ),
    });
    // Admitted, not delivered: delivery is read from GET /v1/inputs.
    let admitted = ControlApiSendResult {
        input: project_input(&row),
        replayed: false,
    };
    Ok(Reply::json(202, &to_value(&admitted)))
}

/// `cancelBody`: nothing, `null` or `{}`.
pub(crate) fn cancel_body(body: Option<&Value>) -> Result<(), Refusal> {
    object(body, &[]).map(|_| ())
}

fn not_cancellable(row: &InputEntry, detail: Option<&'static str>) -> Reply {
    Reply::refusal_with_input(
        &Refusal::Conflict("not_cancellable", detail),
        Some(project_input(row)),
    )
}

/// `cancel`: narrower than the app's own rules. Nothing is reported as cancelled unless the row
/// provably was not sent afterwards.
async fn cancel(shared: &Shared, id: &str, body: Option<&Value>) -> Result<Reply, Refusal> {
    cancel_body(body)?;
    admitted(&shared.admission).await?;
    let row = find(shared, id)
        .await?
        .filter(|row| row.purpose != Some(InputPurpose::Decision))
        .ok_or(Refusal::InputNotFound)?;
    controllable(&*shared.sessions, row.session_id.as_deref()).await?;
    match row.state {
        InputState::Sent | InputState::Tool => {
            return Ok(not_cancellable(&row, Some("already handed to ChatGPT")));
        }
        InputState::Cancelled | InputState::Failed => {
            let already = ControlApiCancelResult {
                input: project_input(&row),
                cancelled: false,
            };
            return Ok(Reply::ok(&to_value(&already)));
        }
        _ => {}
    }
    if delivery(&row) != ControlApiDelivery::Pending {
        return Ok(not_cancellable(
            &row,
            Some("Send was authorized; it may already be in ChatGPT"),
        ));
    }
    // A new chat's first message owns a reserved local chat, and a pair of rows is cancelled
    // together. Both are decisions for the person at the app.
    if row.opening.is_some() {
        return Ok(not_cancellable(
            &row,
            Some("a new chat is opening; cancel it in the app"),
        ));
    }
    let rows = shared
        .inputs
        .list()
        .await
        .map_err(|error| failed(shared, &error))?;
    if row.companion_input_id.is_some()
        || rows
            .iter()
            .any(|other| other.companion_input_id.as_deref() == Some(id))
    {
        return Ok(not_cancellable(
            &row,
            Some("it is paired with another message; cancel it in the app"),
        ));
    }
    shared
        .inputs
        .cancel(id)
        .await
        .map_err(|error| failed(shared, &error))?;
    let Some(after) = find(shared, id).await? else {
        return Err(Refusal::Conflict(
            "not_cancellable",
            Some("the message left the outbox while it was being cancelled"),
        ));
    };
    if after.state != InputState::Cancelled {
        return Ok(not_cancellable(&after, None));
    }
    let proof = delivery(&after);
    shared.logger.info(&format!(
        "control API: message {id} cancelled, {}",
        to_value(&proof).as_str().unwrap_or_default()
    ));
    if proof != ControlApiDelivery::NotSent {
        // Send was authorized between the check and the cancel: withdrawn locally, but the
        // message may be in ChatGPT, so it is not reported as cancelled.
        return Ok(Reply::refusal_with_input(
            &Refusal::Conflict("delivery_unconfirmed", None),
            Some(project_input(&after)),
        ));
    }
    let done = ControlApiCancelResult {
        input: project_input(&after),
        cancelled: true,
    };
    Ok(Reply::ok(&to_value(&done)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_path_is_recognised_whatever_its_id() {
        assert!(is_action_path("/v1/inputs"));
        assert!(is_action_path("/v1/inputs/BAD/cancel"));
        assert!(is_action_path(
            "/v1/inputs/00000000-0000-4000-8000-000000000000/cancel"
        ));
        assert!(!is_action_path("/v1/inputs/a/b/cancel"));
        assert!(!is_action_path("/v1/inputs//cancel"));
        assert!(!is_action_path("/v1/inputs/x"));
    }
}
