//! JSON-RPC over Streamable HTTP, answered as `@modelcontextprotocol/server` 2.1.0 answers it
//! in the TypeScript app: `createMcpHandler` with its default stateless 2025-era ("legacy")
//! fallback, one `McpServer` per request.
//!
//! [`plan`] is the HTTP half: it decides from the method, the headers and the parsed body
//! whether the request is refused with a whole JSON error, accepted with 202, answered as an
//! event stream, or handed to the 2026-07-28 era in [`crate::modern`]. [`answer`] is the
//! JSON-RPC half for one request of a 2025-era stream.

use std::fmt;
use std::sync::Arc;

use cos_tools::{Inbound, SurfaceId, UnknownTool};
use http::{Method, StatusCode};
use serde_json::{Map, Value, json};

use crate::modern::{self, Era};
use crate::port::Dispatch;

/// `SUPPORTED_PROTOCOL_VERSIONS`, in the SDK's preference order.
pub(crate) const SUPPORTED_VERSIONS: [&str; 5] = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
const MAX_BATCH: usize = 100;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const ENVELOPE_VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";

/// The request headers JSON-RPC handling reads.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RpcHeaders<'a> {
    pub(crate) accept: Option<&'a str>,
    pub(crate) content_type: Option<&'a str>,
    pub(crate) protocol_version: Option<&'a str>,
    /// `Mcp-Method` and `Mcp-Name` (SEP-2243), read only on the 2026-07-28 era.
    pub(crate) method: Option<&'a str>,
    pub(crate) name: Option<&'a str>,
}

/// One JSON-RPC request inside a POST.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Call {
    /// A string or a safe integer, as JavaScript prints it.
    pub(crate) id: Value,
    pub(crate) method: String,
    pub(crate) params: Option<Map<String, Value>>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Plan {
    /// A whole JSON body.
    Reply { status: StatusCode, body: Value },
    /// Only notifications or responses: 202 with no body.
    Accepted,
    /// One SSE `message` frame per distinct request id.
    Stream(Vec<Call>),
    /// A 2026-07-28 request [`modern::answer`] dispatches: one JSON body on HTTP 200.
    Modern(Call),
    /// A 2026-07-28 `subscriptions/listen`: an event stream that stays open. `filter` is the
    /// honored subset, or `None` when the requested filter is invalid.
    Listen { id: Value, filter: Option<Value> },
}

/// A [`Plan`] and the client it identifies, when the request names its protocol version.
#[derive(Debug, PartialEq)]
pub(crate) struct Planned {
    pub(crate) plan: Plan,
    pub(crate) client: Option<Client>,
}

impl From<Plan> for Planned {
    fn from(plan: Plan) -> Self {
        Self { plan, client: None }
    }
}

/// Who a client says it is and which protocol it speaks, for the app log.
#[derive(Debug, PartialEq, Eq, Hash)]
pub(crate) struct Client {
    pub(crate) protocol: Protocol,
    pub(crate) name: Option<String>,
    pub(crate) version: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Hash)]
pub(crate) enum Protocol {
    /// The 2025-era `initialize` handshake.
    Negotiated {
        answered: &'static str,
        requested: String,
    },
    /// The 2026-07-28 per-request envelope, served.
    Enveloped(String),
    /// A modern request naming a revision this endpoint does not serve.
    Refused(String),
}

/// Client-supplied text is bounded and escaped before it reaches the log.
const LOGGED_CHARS: usize = 64;

impl fmt::Display for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.protocol {
            Protocol::Negotiated {
                answered,
                requested,
            } => {
                write!(f, "protocol {answered} (2025 era, initialize")?;
                if requested != answered {
                    write!(f, ", requested {:?}", bounded(requested))?;
                }
                write!(f, ")")?;
            }
            Protocol::Enveloped(revision) => {
                write!(f, "protocol {revision} (2026 era, per-request envelope)")?;
            }
            Protocol::Refused(revision) => {
                write!(
                    f,
                    "protocol {:?} refused (2026 era, unsupported revision)",
                    bounded(revision)
                )?;
            }
        }
        let name = self.name.as_deref().map(bounded);
        let version = self.version.as_deref().map(bounded);
        match (name, version) {
            (Some(name), Some(version)) => write!(f, ", client {name:?} {version:?}"),
            (Some(name), None) => write!(f, ", client {name:?}"),
            _ => write!(f, ", client did not name itself"),
        }
    }
}

fn bounded(text: &str) -> String {
    text.chars().take(LOGGED_CHARS).collect()
}

/// Decides how a request to an MCP path is answered. `body` is `None` for GET and HEAD, and
/// `Some(Value::Null)` for an empty body.
pub(crate) fn plan(method: &Method, headers: RpcHeaders<'_>, body: Option<Value>) -> Planned {
    if *method == Method::POST && !is_json_content_type(headers.content_type) {
        return reply(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
            Value::Null,
        )
        .into();
    }
    if *method != Method::POST {
        return reply(
            StatusCode::METHOD_NOT_ALLOWED,
            -32000,
            "Method not allowed.",
            Value::Null,
        )
        .into();
    }
    let body = body.unwrap_or(Value::Null);
    if let Err(message) = classify(&body) {
        return reply(StatusCode::BAD_REQUEST, -32600, message, echoable_id(&body)).into();
    }
    if !body.is_array() {
        match modern::route(&headers, &body) {
            Err(rejection) => return Plan::from(rejection).into(),
            Ok(Era::Modern { revision, request }) => {
                return modern::plan(&headers, body, revision, request);
            }
            Ok(Era::Legacy) => {}
        }
    }
    legacy(headers, body)
}

/// The stateless 2025-era transport (`WebStandardStreamableHTTPServerTransport`).
fn legacy(headers: RpcHeaders<'_>, body: Value) -> Planned {
    let accept = headers.accept.unwrap_or_default();
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return reply(
            StatusCode::NOT_ACCEPTABLE,
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
            Value::Null,
        )
        .into();
    }
    let messages = match body {
        Value::Array(items) if items.len() > MAX_BATCH => {
            return reply(
                StatusCode::BAD_REQUEST,
                -32600,
                "Invalid Request: Batch must not exceed 100 messages",
                Value::Null,
            )
            .into();
        }
        Value::Array(items) => items,
        single => vec![single],
    };
    let initialize = messages
        .iter()
        .find(|message| is_initialize_request(message));
    if initialize.is_some() && messages.len() > 1 {
        return reply(
            StatusCode::BAD_REQUEST,
            -32600,
            "Invalid Request: Only one initialization request is allowed",
            Value::Null,
        )
        .into();
    }
    if let Some(version) = headers.protocol_version
        && initialize.is_none()
        && !SUPPORTED_VERSIONS.contains(&version)
    {
        let message = format!(
            "Bad Request: Unsupported protocol version: {version} (supported versions: {})",
            SUPPORTED_VERSIONS.join(", ")
        );
        return reply(StatusCode::BAD_REQUEST, -32000, &message, Value::Null).into();
    }
    let client = initialize.map(|message| {
        let params = &message["params"];
        let text = |value: &Value| value.as_str().map(str::to_owned);
        let requested = text(&params["protocolVersion"]).unwrap_or_default();
        Client {
            protocol: Protocol::Negotiated {
                answered: negotiate(&requested),
                requested,
            },
            name: text(&params["clientInfo"]["name"]),
            version: text(&params["clientInfo"]["version"]),
        }
    });
    let calls: Vec<Call> = messages.into_iter().filter_map(into_call).collect();
    let plan = if calls.is_empty() {
        Plan::Accepted
    } else {
        Plan::Stream(calls)
    };
    Planned { plan, client }
}

/// Answers one 2025-era request with its whole JSON-RPC response message.
pub(crate) async fn answer<K: Dispatch>(
    kernel: Arc<K>,
    surface: SurfaceId,
    inbound: Inbound,
    call: Call,
) -> Value {
    let Call { id, method, params } = call;
    let params = params.as_ref();
    match method.as_str() {
        "initialize" => match initialize_issues(params).render() {
            Some(issues) => error(&id, -32603, &issues),
            None => {
                let requested = params
                    .and_then(|params| params.get("protocolVersion"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                result(&id, initialize_result(kernel.as_ref(), surface, requested))
            }
        },
        "ping" => result(&id, json!({})),
        "tools/list" => match list_issues(params).render() {
            Some(issues) => error(&id, -32603, &issues),
            None => result(&id, json!({ "tools": kernel.list(surface) })),
        },
        "tools/call" => match call_tool(&kernel, surface, inbound, params, true).await {
            Ok(value) => result(&id, value),
            Err((code, message)) => error(&id, code, &message),
        },
        _ => error(&id, -32601, "Method not found"),
    }
}

/// `tools/call` on either era: the tool's result, or the JSON-RPC error code and message. The
/// 2025 era also validates the `task` member, which the 2026-07-28 era deleted.
pub(crate) async fn call_tool<K: Dispatch>(
    kernel: &Arc<K>,
    surface: SurfaceId,
    inbound: Inbound,
    params: Option<&Map<String, Value>>,
    legacy: bool,
) -> Result<Value, (i64, String)> {
    if let Some(issues) = call_issues(params, legacy).render() {
        return Err((-32602, format!("Invalid tools/call request: {issues}")));
    }
    let name = params
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let arguments = params
        .and_then(|params| params.get("arguments"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    match kernel.call(surface, name, arguments, inbound).await {
        Ok(tool_result) => {
            serde_json::to_value(tool_result).map_err(|_| (-32603, "Internal error".to_owned()))
        }
        Err(UnknownTool(name)) => Err((-32602, format!("Tool {name} not found"))),
    }
}

/// The answer to a request whose handler panicked.
pub(crate) fn internal_error(id: &Value) -> Value {
    error(id, -32603, "Internal error")
}

/// The negotiated version: the requested one when supported, else the latest.
pub(crate) fn negotiate(requested: &str) -> &'static str {
    SUPPORTED_VERSIONS
        .into_iter()
        .find(|supported| *supported == requested)
        .unwrap_or(SUPPORTED_VERSIONS[0])
}

fn initialize_result<K: Dispatch>(kernel: &K, surface: SurfaceId, requested: &str) -> Value {
    let info = kernel.server_info(surface);
    let mut result = json!({
        "protocolVersion": negotiate(requested),
        "capabilities": capabilities(),
        "serverInfo": { "name": info.name, "version": info.version },
    });
    if !info.instructions.is_empty()
        && let Some(object) = result.as_object_mut()
    {
        object.insert("instructions".to_owned(), Value::String(info.instructions));
    }
    result
}

/// What the app's `McpServer` advertises on both eras: tools, with list-changed notifications.
pub(crate) fn capabilities() -> Value {
    json!({ "tools": { "listChanged": true } })
}

/// `{"result", "jsonrpc", "id"}`: the SDK's key order for a result.
pub(crate) fn result(id: &Value, result: Value) -> Value {
    json!({ "result": result, "jsonrpc": "2.0", "id": id })
}

/// `{"jsonrpc", "id", "error"}`: the SDK's key order for an error inside a stream.
pub(crate) fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// `{"jsonrpc", "error", "id"}`: the order of an error the HTTP layer answers whole.
pub(crate) fn http_error(code: i64, message: &str, id: Value) -> Value {
    json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": id })
}

fn reply(status: StatusCode, code: i64, message: &str, id: Value) -> Plan {
    Plan::Reply {
        status,
        body: http_error(code, message, id),
    }
}

/// `isJsonContentType`: the media type before any parameters is `application/json`.
fn is_json_content_type(header: Option<&str>) -> bool {
    let Some(header) = header else { return false };
    if header == "application/json" {
        return true;
    }
    let (essence, parameters) = header.split_once(';').unwrap_or((header, ""));
    let essence = essence.trim().to_ascii_lowercase();
    // A comma outside quotes is a malformed parameter list, which the SDK's fallback parser
    // refuses rather than guess at.
    essence == "application/json" && !has_unquoted_comma(parameters)
}

fn has_unquoted_comma(text: &str) -> bool {
    let mut quoted = false;
    let mut escaped = false;
    for c in text.chars() {
        match (quoted, escaped, c) {
            (true, false, '\\') => escaped = true,
            (true, true, _) => escaped = false,
            (_, _, '"') => quoted = !quoted,
            (false, _, ',') => return true,
            _ => {}
        }
    }
    false
}

/// `classifyInboundRequest` for the 2025 era: `Err(message)` is a 400 rejection.
fn classify(body: &Value) -> Result<(), &'static str> {
    if let Value::Array(items) = body {
        if items.is_empty() {
            return Err("Bad Request: empty JSON-RPC batch");
        }
        for item in items {
            if has_envelope_claim(item.get("params")) {
                return Err(
                    "Bad Request: JSON-RPC batches may not contain requests for protocol revision 2026-07-28 or later",
                );
            }
            if !is_message(item) {
                return Err("Bad Request: JSON-RPC batch contains an invalid message");
            }
        }
        return Ok(());
    }
    if is_message(body) {
        Ok(())
    } else {
        Err("Bad Request: the request body is not a valid JSON-RPC message")
    }
}

fn is_message(value: &Value) -> bool {
    is_request(value) || is_notification(value) || is_result(value) || is_error_response(value)
}

/// The fields of a strict zod object: only `allowed` keys, and `jsonrpc` is `"2.0"`.
fn envelope<'a>(value: &'a Value, allowed: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    let keys_ok = object.keys().all(|key| allowed.contains(&key.as_str()));
    (keys_ok && object.get("jsonrpc").and_then(Value::as_str) == Some("2.0")).then_some(object)
}

pub(crate) fn is_request(value: &Value) -> bool {
    envelope(value, &["jsonrpc", "id", "method", "params"]).is_some_and(|object| {
        object.get("id").is_some_and(is_request_id)
            && object.get("method").is_some_and(Value::is_string)
            && object.get("params").is_none_or(valid_params)
    })
}

fn is_notification(value: &Value) -> bool {
    envelope(value, &["jsonrpc", "method", "params"]).is_some_and(|object| {
        object.get("method").is_some_and(Value::is_string)
            && object.get("params").is_none_or(valid_params)
    })
}

fn is_result(value: &Value) -> bool {
    envelope(value, &["jsonrpc", "id", "result"]).is_some_and(|object| {
        object.get("id").is_some_and(is_request_id)
            && object
                .get("result")
                .and_then(Value::as_object)
                .is_some_and(|result| result.get("_meta").is_none_or(Value::is_object))
    })
}

fn is_error_response(value: &Value) -> bool {
    envelope(value, &["jsonrpc", "id", "error"]).is_some_and(|object| {
        object.get("id").is_none_or(is_request_id)
            && object
                .get("error")
                .and_then(Value::as_object)
                .is_some_and(|error| {
                    error.get("code").is_some_and(is_safe_integer)
                        && error.get("message").is_some_and(Value::is_string)
                })
    })
}

/// `params` of a request or notification: an object whose `_meta`, if present, is valid.
fn valid_params(params: &Value) -> bool {
    let Some(params) = params.as_object() else {
        return false;
    };
    let Some(meta) = params.get("_meta") else {
        return true;
    };
    let Some(meta) = meta.as_object() else {
        return false;
    };
    let token_ok = meta
        .get("progressToken")
        .is_none_or(|token| token.is_string() || is_safe_integer(token));
    let task_ok = meta
        .get("io.modelcontextprotocol/related-task")
        .is_none_or(|task| task.get("taskId").is_some_and(Value::is_string));
    token_ok && task_ok
}

fn has_envelope_claim(params: Option<&Value>) -> bool {
    params
        .and_then(|params| params.get("_meta"))
        .and_then(Value::as_object)
        .is_some_and(|meta| meta.contains_key(ENVELOPE_VERSION_KEY))
}

fn is_request_id(id: &Value) -> bool {
    id.is_string() || is_safe_integer(id)
}

fn is_safe_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER)
}

/// An integral number as JavaScript prints it: `1.0` in the body is echoed as `1`.
fn normalize_id(id: &Value) -> Value {
    match id.as_f64() {
        Some(number) if !id.is_i64() && !id.is_u64() && is_safe_integer(id) => {
            Value::from(number as i64)
        }
        _ => id.clone(),
    }
}

/// `echoableRequestId`: the id of an object body that names a string method.
pub(crate) fn echoable_id(body: &Value) -> Value {
    let Some(object) = body.as_object() else {
        return Value::Null;
    };
    match (object.get("method"), object.get("id")) {
        (Some(Value::String(_)), Some(id @ (Value::String(_) | Value::Number(_)))) => {
            normalize_id(id)
        }
        _ => Value::Null,
    }
}

pub(crate) fn into_call(message: Value) -> Option<Call> {
    if !is_request(&message) {
        return None;
    }
    let Value::Object(mut object) = message else {
        return None;
    };
    let id = normalize_id(object.get("id")?);
    let Some(Value::String(method)) = object.remove("method") else {
        return None;
    };
    let params = match object.remove("params") {
        Some(Value::Object(params)) => Some(params),
        _ => None,
    };
    Some(Call { id, method, params })
}

fn is_initialize_request(message: &Value) -> bool {
    is_request(message)
        && message.get("method").and_then(Value::as_str) == Some("initialize")
        && initialize_issues(message.get("params").and_then(Value::as_object))
            .render()
            .is_none()
}

/// zod `invalid_type` issues, in schema key order.
#[derive(Default)]
pub(crate) struct Issues(Vec<Value>);

#[derive(Clone, Copy)]
pub(crate) enum Expected {
    String,
    Number,
    Object,
    /// `z.record`: an object, named differently in the message.
    Record,
    Array,
    Boolean,
}

impl Expected {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Number => "number",
            Self::Object => "object",
            Self::Record => "record",
            Self::Array => "array",
            Self::Boolean => "boolean",
        }
    }

    pub(crate) fn accepts(self, value: &Value) -> bool {
        match self {
            Self::String => value.is_string(),
            Self::Number => value.is_number(),
            Self::Object | Self::Record => value.is_object(),
            Self::Array => value.is_array(),
            Self::Boolean => value.is_boolean(),
        }
    }
}

pub(crate) fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

impl Issues {
    fn required(&mut self, path: &[&str], expected: Expected, value: Option<&Value>) {
        if !value.is_some_and(|value| expected.accepts(value)) {
            self.push(path, expected, value);
        }
    }

    fn optional(&mut self, path: &[&str], expected: Expected, value: Option<&Value>) {
        if value.is_some_and(|value| !expected.accepts(value)) {
            self.push(path, expected, value);
        }
    }

    fn push(&mut self, path: &[&str], expected: Expected, value: Option<&Value>) {
        let expected = expected.name();
        self.0.push(json!({
            "expected": expected,
            "code": "invalid_type",
            "path": path,
            "message": format!("Invalid input: expected {expected}, received {}", received(value)),
        }));
    }

    /// `String(zodError)`: the issues as two-space indented JSON.
    pub(crate) fn render(&self) -> Option<String> {
        if self.0.is_empty() {
            return None;
        }
        serde_json::to_string_pretty(&self.0).ok()
    }
}

fn initialize_issues(params: Option<&Map<String, Value>>) -> Issues {
    let mut issues = Issues::default();
    let Some(params) = params else {
        issues.push(&["params"], Expected::Object, None);
        return issues;
    };
    issues.required(
        &["params", "protocolVersion"],
        Expected::String,
        params.get("protocolVersion"),
    );
    issues.required(
        &["params", "capabilities"],
        Expected::Object,
        params.get("capabilities"),
    );
    match params.get("clientInfo") {
        Some(Value::Object(info)) => {
            let field = |name: &'static str| (["params", "clientInfo", name], info.get(name));
            let (path, value) = field("name");
            issues.required(&path, Expected::String, value);
            let (path, value) = field("title");
            issues.optional(&path, Expected::String, value);
            let (path, value) = field("icons");
            issues.optional(&path, Expected::Array, value);
            let (path, value) = field("version");
            issues.required(&path, Expected::String, value);
            let (path, value) = field("websiteUrl");
            issues.optional(&path, Expected::String, value);
            let (path, value) = field("description");
            issues.optional(&path, Expected::String, value);
        }
        other => issues.push(&["params", "clientInfo"], Expected::Object, other),
    }
    issues
}

pub(crate) fn list_issues(params: Option<&Map<String, Value>>) -> Issues {
    let mut issues = Issues::default();
    if let Some(params) = params {
        issues.optional(
            &["params", "cursor"],
            Expected::String,
            params.get("cursor"),
        );
    }
    issues
}

fn call_issues(params: Option<&Map<String, Value>>, legacy: bool) -> Issues {
    let mut issues = Issues::default();
    let Some(params) = params else {
        issues.push(&["params"], Expected::Object, None);
        return issues;
    };
    match params.get("task") {
        _ if !legacy => {}
        Some(Value::Object(task)) => {
            issues.optional(
                &["params", "task", "ttl"],
                Expected::Number,
                task.get("ttl"),
            );
        }
        other => issues.optional(&["params", "task"], Expected::Object, other),
    }
    issues.required(&["params", "name"], Expected::String, params.get("name"));
    issues.optional(
        &["params", "arguments"],
        Expected::Record,
        params.get("arguments"),
    );
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(body: Value) -> Plan {
        let headers = RpcHeaders {
            accept: Some("application/json, text/event-stream"),
            content_type: Some("application/json"),
            ..RpcHeaders::default()
        };
        plan(&Method::POST, headers, Some(body)).plan
    }

    #[test]
    fn content_types_are_judged_by_media_type() {
        for header in [
            "application/json",
            "application/json; charset=utf-8",
            "APPLICATION/JSON",
            "application/json;",
            " application/json ",
            "application/json; a=\"b,c\"",
        ] {
            assert!(is_json_content_type(Some(header)), "{header}");
        }
        for header in [
            "text/plain",
            "application/vnd+json",
            "application/json; a=b, c",
            "application/json, text/plain",
        ] {
            assert!(!is_json_content_type(Some(header)), "{header}");
        }
        assert!(!is_json_content_type(None));
    }

    #[test]
    fn a_request_id_is_a_string_or_a_safe_integer() {
        let ping = |id: Value| json!({ "jsonrpc": "2.0", "id": id, "method": "ping" });
        assert!(matches!(post(ping(json!("abc"))), Plan::Stream(_)));
        assert!(matches!(post(ping(json!(-3))), Plan::Stream(_)));
        let Plan::Stream(calls) = post(
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":1.0,"method":"ping"}"#).expect("json"),
        ) else {
            panic!("an integral float is a valid id");
        };
        assert_eq!(calls[0].id.to_string(), "1");
        for id in [json!(1.5), json!(null), json!(1e20)] {
            let Plan::Reply { status, .. } = post(ping(id.clone())) else {
                panic!("{id} is not a request id");
            };
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn notifications_and_responses_alone_are_accepted_without_a_body() {
        assert_eq!(
            post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })),
            Plan::Accepted
        );
        assert_eq!(
            post(json!({ "jsonrpc": "2.0", "id": 1, "result": {} })),
            Plan::Accepted
        );
        assert_eq!(
            post(json!([{ "jsonrpc": "2.0", "method": "a" }, { "jsonrpc": "2.0", "method": "b" }])),
            Plan::Accepted
        );
    }

    #[test]
    fn a_batch_streams_its_requests_and_skips_the_rest() {
        let Plan::Stream(calls) = post(json!([
            { "jsonrpc": "2.0", "id": 1, "result": {} },
            { "jsonrpc": "2.0", "id": 2, "method": "ping" },
            { "jsonrpc": "2.0", "method": "notifications/initialized" },
        ])) else {
            panic!("a batch with a request streams");
        };
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, json!(2));
    }

    #[test]
    fn negotiation_echoes_supported_versions_and_falls_back_to_the_latest() {
        for version in SUPPORTED_VERSIONS {
            assert_eq!(negotiate(version), version);
        }
        assert_eq!(negotiate("2026-07-28"), "2025-11-25");
        assert_eq!(negotiate("1999-01-01"), "2025-11-25");
        assert_eq!(negotiate(""), "2025-11-25");
    }
}
