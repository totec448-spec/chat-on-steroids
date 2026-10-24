//! The 2026-07-28 protocol era, answered as `createMcpHandler` (`@modelcontextprotocol/server`
//! 2.1.0) answers it. A request claims the era with the per-request `_meta` envelope; there is
//! no `initialize`. [`route`] is the SDK's body-primary era classifier (`classifyInboundRequest`)
//! for one message; [`plan`] runs the entry's modern ladder on a request it routed here; and
//! [`answer`] is the dispatch of the three methods the app's server instance serves on this era:
//! `server/discover`, `tools/list` and `tools/call`. Every other method is `-32601` on HTTP 404,
//! because the SDK answers a missing handler inside the dispatch window, where the ladder's
//! status table applies. Results are one JSON body, never an event stream, because the app's
//! handlers emit no message before their result.

use std::sync::Arc;

use base64::Engine;
use base64::alphabet::STANDARD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use cos_tools::{Inbound, ServerInfo, SurfaceId};
use http::StatusCode;
use serde_json::{Map, Value, json};

use crate::port::Dispatch;
use crate::rpc::{self, Call, Client, Expected, Plan, Planned, Protocol, RpcHeaders, received};

/// `SUPPORTED_MODERN_PROTOCOL_VERSIONS`.
pub(crate) const REVISION: &str = "2026-07-28";
const VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY: &str = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY: &str = "io.modelcontextprotocol/clientInfo";
const LOG_LEVEL_KEY: &str = "io.modelcontextprotocol/logLevel";
const SERVER_INFO_KEY: &str = "io.modelcontextprotocol/serverInfo";
const SUBSCRIPTION_ID_KEY: &str = "io.modelcontextprotocol/subscriptionId";
const HEADER_MISMATCH: i64 = -32020;
const UNSUPPORTED_VERSION: i64 = -32022;
const LOG_LEVELS: [&str; 8] = [
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency",
];
/// `MCP_NAME_HEADER_SOURCE`: the body field the `Mcp-Name` header mirrors, by method.
const NAME_SOURCES: [(&str, &str); 6] = [
    ("tools/call", "name"),
    ("prompts/get", "name"),
    ("resources/read", "uri"),
    ("tasks/get", "taskId"),
    ("tasks/update", "taskId"),
    ("tasks/cancel", "taskId"),
];
/// The results `fillCacheFields` gives `ttlMs: 0, cacheScope: "private"`, among those served.
const CACHEABLE: [&str; 2] = ["tools/list", "server/discover"];
/// `atob` ignores the unused bits of the last symbol; the canonical-shape check is separate.
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
);

/// Where the classifier sends one non-batch message.
#[derive(Debug, PartialEq)]
pub(crate) enum Era {
    /// The 2025-era stateless path in [`rpc::plan`].
    Legacy,
    /// The modern path, for the revision the message names. A revision this endpoint does
    /// not serve is refused by [`plan`], after the classifier's own cells.
    Modern { revision: String, request: bool },
}

/// `classifyInboundRequest` for a body [`rpc::plan`] already proved is one JSON-RPC message:
/// `Err` is a ladder rejection.
pub(crate) fn route(headers: &RpcHeaders<'_>, body: &Value) -> Result<Era, Rejection> {
    let header_version = headers.protocol_version.map(strip_ows);
    let method_header = headers.method.map(strip_ows);
    let header_modern = header_version.is_some_and(is_modern);
    let params = body.get("params");
    let Some(method) = body.get("method").and_then(Value::as_str) else {
        return Ok(Era::Legacy);
    };
    if rpc::is_request(body) {
        if method == "initialize" && !carries_valid_modern_claim(params) {
            if let Some(header) = header_version.filter(|_| header_modern) {
                return Err(mismatch(
                    header,
                    "an initialize request (legacy handshake) was sent with a modern MCP-Protocol-Version header",
                    body,
                ));
            }
            return Ok(Era::Legacy);
        }
        let Some(meta) = claimed_meta(params) else {
            let Some(header) = header_version.filter(|_| header_modern) else {
                return Ok(Era::Legacy);
            };
            let missing: Vec<&str> = match meta_of(params) {
                None => vec!["_meta"],
                Some(meta) => missing_keys(meta),
            };
            let message = format!(
                "Invalid params: the MCP-Protocol-Version header names protocol revision {header}, but the request is missing the required per-request envelope key(s): {}",
                missing.join(", ")
            );
            return Err(ladder(
                -32602,
                &message,
                Some(json!({ "envelope": { "missing": missing } })),
                body,
            ));
        };
        if let Some((key, problem)) = envelope_issue(meta) {
            return Err(invalid_envelope(key, problem, body));
        }
        let claimed = meta
            .get(VERSION_KEY)
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(header) = header_version.filter(|header| *header != claimed) {
            return Err(mismatch(
                header,
                &format!(
                    "the body envelope names protocol version {claimed} but the MCP-Protocol-Version header names {header}"
                ),
                body,
            ));
        }
        if let Some(header) = method_header.filter(|header| *header != method) {
            return Err(mismatch(
                header,
                &format!("the body names method {method} but the Mcp-Method header names {header}"),
                body,
            ));
        }
        return Ok(Era::Modern {
            revision: claimed.to_owned(),
            request: true,
        });
    }
    let notification_method_mismatch = |header: &str| {
        mismatch(
            header,
            &format!(
                "the notification body names method {method} but the Mcp-Method header names {header}"
            ),
            body,
        )
    };
    if let Some(meta) = claimed_meta(params) {
        let Some(claimed) = meta.get(VERSION_KEY).and_then(Value::as_str) else {
            let problem = expected_message("string", meta.get(VERSION_KEY));
            return Err(invalid_envelope(VERSION_KEY.to_owned(), problem, body));
        };
        if let Some(header) = header_version.filter(|header| *header != claimed) {
            return Err(mismatch(
                header,
                &format!(
                    "the notification envelope names protocol version {claimed} but the MCP-Protocol-Version header names {header}"
                ),
                body,
            ));
        }
        if is_modern(claimed)
            && let Some(header) = method_header.filter(|header| *header != method)
        {
            return Err(notification_method_mismatch(header));
        }
        return Ok(Era::Modern {
            revision: claimed.to_owned(),
            request: false,
        });
    }
    let Some(header) = header_version.filter(|_| header_modern) else {
        return Ok(Era::Legacy);
    };
    if let Some(method_header) = method_header.filter(|header| *header != method) {
        return Err(notification_method_mismatch(method_header));
    }
    Ok(Era::Modern {
        revision: header.to_owned(),
        request: false,
    })
}

/// `serveModern` up to dispatch, for a message [`route`] sent to the modern path.
pub(crate) fn plan(
    headers: &RpcHeaders<'_>,
    body: Value,
    revision: String,
    request: bool,
) -> Planned {
    let client = |protocol: Protocol| {
        let info = meta_of(body.get("params")).and_then(|meta| meta.get(CLIENT_INFO_KEY));
        let field = |name: &str| {
            info.and_then(|info| info.get(name))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        Some(Client {
            protocol,
            name: field("name"),
            version: field("version"),
        })
    };
    if revision != REVISION {
        let message = format!("Unsupported protocol version: {revision}");
        let data = json!({ "supported": [REVISION], "requested": revision });
        let plan = ladder(UNSUPPORTED_VERSION, &message, Some(data), &body).into();
        let client = if request {
            client(Protocol::Refused(revision))
        } else {
            None
        };
        return Planned { plan, client };
    }
    if !request {
        return Plan::Accepted.into();
    }
    if let Some(rejection) = standard_header_rejection(headers, &body, &revision) {
        return Plan::from(rejection).into();
    }
    let client = client(Protocol::Enveloped(revision));
    let Some(call) = rpc::into_call(body) else {
        return Plan::Accepted.into();
    };
    let plan = match call.method.as_str() {
        "subscriptions/listen" => Plan::Listen {
            filter: listen_filter(call.params.as_ref()),
            id: call.id,
        },
        "tools/list" | "tools/call" | "server/discover" => Plan::Modern(call),
        _ => Plan::Reply {
            status: StatusCode::NOT_FOUND,
            body: rpc::error(&call.id, -32601, "Method not found"),
        },
    };
    Planned { plan, client }
}

/// Answers one modern request with its whole JSON-RPC response message.
pub(crate) async fn answer<K: Dispatch>(
    kernel: Arc<K>,
    surface: SurfaceId,
    inbound: Inbound,
    call: Call,
) -> Value {
    let info = kernel.server_info(surface);
    let Call { id, method, params } = call;
    let result = match method.as_str() {
        "server/discover" => {
            let mut result = json!({
                "supportedVersions": [REVISION],
                "capabilities": rpc::capabilities(),
            });
            if !info.instructions.is_empty()
                && let Some(object) = result.as_object_mut()
            {
                object.insert(
                    "instructions".to_owned(),
                    Value::String(info.instructions.clone()),
                );
            }
            result
        }
        "tools/list" => match rpc::list_issues(params.as_ref()).render() {
            Some(issues) => return rpc::error(&id, -32603, &issues),
            None => {
                json!({ "tools": kernel.list(surface).into_iter().map(without_execution).collect::<Vec<_>>() })
            }
        },
        "tools/call" => {
            match rpc::call_tool(&kernel, surface, inbound, params.as_ref(), false).await {
                Ok(result) => with_text_fallback(result),
                Err((code, message)) => return rpc::error(&id, code, &message),
            }
        }
        _ => return rpc::error(&id, -32601, "Method not found"),
    };
    rpc::result(&id, stamp(&method, result, &info))
}

/// The first SSE frame of a `subscriptions/listen` stream: the honored filter.
pub(crate) fn acknowledgement(id: &Value, honored: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/subscriptions/acknowledged",
        "params": { "notifications": honored, "_meta": { SUBSCRIPTION_ID_KEY: id } },
    })
}

/// The last SSE frame of a `subscriptions/listen` stream the server ends (`closeAll`).
pub(crate) fn listen_closed(id: &Value, info: &ServerInfo) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "resultType": "complete",
            "_meta": {
                SUBSCRIPTION_ID_KEY: id,
                SERVER_INFO_KEY: { "name": info.name, "version": info.version },
            },
        },
    })
}

/// A `subscriptions/listen` refusal, answered whole on HTTP 200.
pub(crate) fn listen_error(id: &Value, code: i64, message: &str) -> Value {
    rpc::http_error(code, message, id.clone())
}

pub(crate) const INVALID_FILTER: &str =
    "Invalid params: 'notifications' is required and must be a valid SubscriptionFilter";

/// `parseListenFilter` and `honoredSubset`: the subset of a valid filter this server can
/// deliver. Its only list-changed capability is `tools.listChanged`, and it has no resources.
fn listen_filter(params: Option<&Map<String, Value>>) -> Option<Value> {
    let filter = params?.get("notifications")?.as_object()?;
    let flags_ok = [
        "toolsListChanged",
        "promptsListChanged",
        "resourcesListChanged",
    ]
    .iter()
    .all(|flag| filter.get(*flag).is_none_or(Value::is_boolean));
    let subscriptions_ok = filter.get("resourceSubscriptions").is_none_or(|uris| {
        uris.as_array()
            .is_some_and(|uris| uris.iter().all(Value::is_string))
    });
    if !(flags_ok && subscriptions_ok) {
        return None;
    }
    let mut honored = Map::new();
    if filter.get("toolsListChanged") == Some(&Value::Bool(true)) {
        honored.insert("toolsListChanged".to_owned(), Value::Bool(true));
    }
    Some(Value::Object(honored))
}

/// `encodeResult`: the `resultType` stamp, the cache fields, then the `serverInfo` `_meta`.
fn stamp(method: &str, result: Value, info: &ServerInfo) -> Value {
    let Value::Object(mut result) = result else {
        return result;
    };
    result
        .entry("resultType")
        .or_insert_with(|| Value::String("complete".to_owned()));
    if CACHEABLE.contains(&method) {
        result.insert("ttlMs".to_owned(), Value::from(0));
        result.insert("cacheScope".to_owned(), Value::String("private".to_owned()));
    }
    let identity = json!({ "name": info.name, "version": info.version });
    match result.get_mut("_meta") {
        None => {
            result.insert("_meta".to_owned(), json!({ SERVER_INFO_KEY: identity }));
        }
        Some(Value::Object(meta)) => {
            if meta.get(SERVER_INFO_KEY).is_none_or(Value::is_null) {
                meta.insert(SERVER_INFO_KEY.to_owned(), identity);
            }
        }
        Some(_) => {}
    }
    Value::Object(result)
}

/// The 2026 `Tool` has no `execution` member: `enforceDeletedFields`.
fn without_execution(mut tool: Value) -> Value {
    if let Some(tool) = tool.as_object_mut() {
        tool.shift_remove("execution");
    }
    tool
}

/// `appendTextFallbackForNonObject`: a non-object `structuredContent` with no text block
/// gains one carrying its JSON.
fn with_text_fallback(mut result: Value) -> Value {
    let Some(structured) = result.get("structuredContent").cloned() else {
        return result;
    };
    if structured.is_object() {
        return result;
    }
    let content = result
        .as_object_mut()
        .map(|object| object.entry("content").or_insert_with(|| json!([])));
    if let Some(Value::Array(blocks)) = content
        && !blocks.iter().any(|block| block["type"] == "text")
    {
        blocks.push(json!({ "type": "text", "text": structured.to_string() }));
    }
    result
}

/// `validateStandardRequestHeaders`: SEP-2243 presence and the `Mcp-Name` cross-check.
fn standard_header_rejection(
    headers: &RpcHeaders<'_>,
    body: &Value,
    revision: &str,
) -> Option<Rejection> {
    if headers.protocol_version.is_none() {
        return Some(mismatch(
            "(missing)",
            &format!(
                "the body envelope names protocol version {revision} but the required MCP-Protocol-Version header is absent"
            ),
            body,
        ));
    }
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if headers.method.is_none() {
        return Some(mismatch(
            "(missing)",
            &format!("the body names method {method} but the required Mcp-Method header is absent"),
            body,
        ));
    }
    let (_, field) = NAME_SOURCES.iter().find(|(source, _)| *source == method)?;
    let value = body
        .get("params")
        .and_then(|params| params.get(*field))
        .and_then(Value::as_str);
    let Some(header) = headers.name.map(strip_ows) else {
        let value = value?;
        return Some(mismatch(
            "(missing)",
            &format!(
                "the body carries params.{field}=\"{value}\" but the required Mcp-Name header is absent"
            ),
            body,
        ));
    };
    let Some(decoded) = decode_param_value(header) else {
        return Some(mismatch(
            header,
            "the Mcp-Name header carries an invalid Base64 sentinel value",
            body,
        ));
    };
    let value = value?;
    (decoded != value).then(|| {
        mismatch(
            header,
            &format!(
                "the body carries params.{field}=\"{value}\" but the Mcp-Name header names \"{decoded}\""
            ),
            body,
        )
    })
}

/// `decodeMcpParamValue`: a `=?base64?...?=` sentinel is canonical Base64 of UTF-8.
fn decode_param_value(value: &str) -> Option<String> {
    const PREFIX: &str = "=?base64?";
    const SUFFIX: &str = "?=";
    if !(value.starts_with(PREFIX) && value.ends_with(SUFFIX)) {
        return Some(value.to_owned());
    }
    // `=?base64?=` is both prefix and suffix; JavaScript's `slice` reads it as empty.
    let encoded = value
        .get(PREFIX.len()..value.len() - SUFFIX.len())
        .unwrap_or_default();
    if !is_canonical_base64(encoded) {
        return None;
    }
    String::from_utf8(BASE64.decode(encoded).ok()?).ok()
}

/// `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`
fn is_canonical_base64(text: &str) -> bool {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return false;
    }
    let symbol = |byte: &u8| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/';
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    padding <= 2 && bytes[..bytes.len() - padding].iter().all(symbol)
}

/// RFC 9110 optional whitespace around a field value.
fn strip_ows(value: &str) -> &str {
    value.trim_matches([' ', '\t'])
}

fn is_modern(version: &str) -> bool {
    version >= REVISION
}

fn meta_of(params: Option<&Value>) -> Option<&Map<String, Value>> {
    params?.as_object()?.get("_meta")?.as_object()
}

/// The `_meta` of a message that claims the envelope mechanism: it names the protocol version
/// key, whatever its value.
fn claimed_meta(params: Option<&Value>) -> Option<&Map<String, Value>> {
    meta_of(params).filter(|meta| meta.contains_key(VERSION_KEY))
}

fn carries_valid_modern_claim(params: Option<&Value>) -> bool {
    claimed_meta(params).is_some_and(|meta| {
        meta.get(VERSION_KEY)
            .and_then(Value::as_str)
            .is_some_and(is_modern)
            && envelope_issue(meta).is_none()
    })
}

/// The envelope keys every modern request must carry, in reporting order.
fn missing_keys(meta: &Map<String, Value>) -> Vec<&'static str> {
    [VERSION_KEY, CAPABILITIES_KEY]
        .into_iter()
        .filter(|key| !meta.contains_key(*key))
        .collect()
}

/// `validateEnvelopeMeta`'s first issue: a missing required key, else the first zod issue of
/// `RequestMetaEnvelopeSchema` in schema order. `progressToken` is not checked here because a
/// bad one already failed the JSON-RPC shape.
fn envelope_issue(meta: &Map<String, Value>) -> Option<(String, String)> {
    if let Some(key) = missing_keys(meta).first() {
        return Some(((*key).to_owned(), "missing".to_owned()));
    }
    let mut issue = None;
    let mut first = |path: Path, problem: String| {
        if issue.is_none() {
            issue = Some((path.0.join("."), problem));
        }
    };
    if let Some(version) = meta.get(VERSION_KEY).filter(|version| !version.is_string()) {
        first(
            Path::root(VERSION_KEY),
            expected_message("string", Some(version)),
        );
    }
    if let Some(info) = meta.get(CLIENT_INFO_KEY) {
        implementation_issue(Path::root(CLIENT_INFO_KEY), info, &mut first);
    }
    if let Some(capabilities) = meta.get(CAPABILITIES_KEY) {
        capabilities_issue(Path::root(CAPABILITIES_KEY), capabilities, &mut first);
    }
    if let Some(level) = meta.get(LOG_LEVEL_KEY)
        && !level
            .as_str()
            .is_some_and(|level| LOG_LEVELS.contains(&level))
    {
        first(Path::root(LOG_LEVEL_KEY), option_message(&LOG_LEVELS));
    }
    issue
}

/// A zod issue path.
#[derive(Clone)]
struct Path(Vec<String>);

impl Path {
    fn root(key: &str) -> Self {
        Self(vec![key.to_owned()])
    }

    fn at(&self, key: impl ToString) -> Self {
        let mut path = self.0.clone();
        path.push(key.to_string());
        Self(path)
    }
}

type Report<'a> = dyn FnMut(Path, String) + 'a;

/// Reports `expected` when `value` has the wrong type; `true` when it has the right one.
fn typed(path: &Path, expected: Expected, value: Option<&Value>, report: &mut Report<'_>) -> bool {
    if value.is_some_and(|value| expected.accepts(value)) {
        return true;
    }
    report(path.clone(), expected_message(expected.name(), value));
    false
}

fn optional(
    path: &Path,
    expected: Expected,
    value: Option<&Value>,
    report: &mut Report<'_>,
) -> bool {
    value.is_some() && typed(path, expected, value, report)
}

/// `ImplementationSchema`: name, title, icons, version, websiteUrl, description.
fn implementation_issue(path: Path, info: &Value, report: &mut Report<'_>) {
    if !typed(&path, Expected::Object, Some(info), report) {
        return;
    }
    let field = |name: &str| info.get(name);
    typed(&path.at("name"), Expected::String, field("name"), report);
    optional(&path.at("title"), Expected::String, field("title"), report);
    let icons_path = path.at("icons");
    if optional(&icons_path, Expected::Array, field("icons"), report) {
        for (index, icon) in field("icons")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            icon_issue(icons_path.at(index), icon, report);
        }
    }
    typed(
        &path.at("version"),
        Expected::String,
        field("version"),
        report,
    );
    optional(
        &path.at("websiteUrl"),
        Expected::String,
        field("websiteUrl"),
        report,
    );
    optional(
        &path.at("description"),
        Expected::String,
        field("description"),
        report,
    );
}

/// `IconSchema`: src, mimeType, sizes, theme.
fn icon_issue(path: Path, icon: &Value, report: &mut Report<'_>) {
    if !typed(&path, Expected::Object, Some(icon), report) {
        return;
    }
    typed(&path.at("src"), Expected::String, icon.get("src"), report);
    optional(
        &path.at("mimeType"),
        Expected::String,
        icon.get("mimeType"),
        report,
    );
    let sizes_path = path.at("sizes");
    if optional(&sizes_path, Expected::Array, icon.get("sizes"), report) {
        for (index, size) in icon["sizes"].as_array().into_iter().flatten().enumerate() {
            typed(&sizes_path.at(index), Expected::String, Some(size), report);
        }
    }
    if let Some(theme) = icon.get("theme")
        && !matches!(theme.as_str(), Some("light" | "dark"))
    {
        report(path.at("theme"), option_message(&["light", "dark"]));
    }
}

/// `ClientCapabilities2026Schema`: experimental, sampling, elicitation, roots, extensions. The
/// 2025 `tasks` member has no slot on this revision, so it is not checked.
fn capabilities_issue(path: Path, capabilities: &Value, report: &mut Report<'_>) {
    if !typed(&path, Expected::Object, Some(capabilities), report) {
        return;
    }
    let member = |name: &str| capabilities.get(name);
    let records = |name: &str, report: &mut Report<'_>| {
        let path = path.at(name);
        if optional(&path, Expected::Record, member(name), report) {
            for (key, value) in member(name)
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                typed(&path.at(key), Expected::Record, Some(value), report);
            }
        }
    };
    records("experimental", report);
    let sampling = path.at("sampling");
    if optional(&sampling, Expected::Object, member("sampling"), report) {
        for name in ["context", "tools"] {
            let value = member("sampling").and_then(|sampling| sampling.get(name));
            optional(&sampling.at(name), Expected::Record, value, report);
        }
    }
    let elicitation = path.at("elicitation");
    if optional(
        &elicitation,
        Expected::Object,
        member("elicitation"),
        report,
    ) {
        let form_path = elicitation.at("form");
        let form = member("elicitation").and_then(|elicitation| elicitation.get("form"));
        if optional(&form_path, Expected::Object, form, report) {
            let defaults = form.and_then(|form| form.get("applyDefaults"));
            optional(
                &form_path.at("applyDefaults"),
                Expected::Boolean,
                defaults,
                report,
            );
        }
        let url = member("elicitation").and_then(|elicitation| elicitation.get("url"));
        optional(&elicitation.at("url"), Expected::Record, url, report);
    }
    let roots = path.at("roots");
    if optional(&roots, Expected::Object, member("roots"), report) {
        let changed = member("roots").and_then(|roots| roots.get("listChanged"));
        optional(&roots.at("listChanged"), Expected::Boolean, changed, report);
    }
    records("extensions", report);
}

fn expected_message(expected: &str, value: Option<&Value>) -> String {
    format!(
        "Invalid input: expected {expected}, received {}",
        received(value)
    )
}

fn option_message(options: &[&str]) -> String {
    let quoted: Vec<String> = options
        .iter()
        .map(|option| format!("\"{option}\""))
        .collect();
    format!("Invalid option: expected one of {}", quoted.join("|"))
}

fn invalid_envelope(key: String, problem: String, body: &Value) -> Rejection {
    let message =
        format!("Invalid _meta envelope for protocol revision {REVISION}: {key}: {problem}");
    let data = json!({ "envelope": { "key": key, "problem": problem } });
    ladder(-32602, &message, Some(data), body)
}

/// `crossCheckMismatch`: `-32020` on HTTP 400.
fn mismatch(header: &str, detail: &str, body: &Value) -> Rejection {
    let message = format!("Bad Request: the request headers and body disagree: {detail}");
    let data = json!({ "mismatch": { "header": header, "body": detail } });
    ladder(HEADER_MISMATCH, &message, Some(data), body)
}

/// A ladder rejection the entry answers before dispatch: HTTP 400 with
/// `{"jsonrpc", "error": {code, message, data}, "id"}`.
#[derive(Debug)]
pub(crate) struct Rejection(Value);

impl From<Rejection> for Plan {
    fn from(Rejection(body): Rejection) -> Self {
        Plan::Reply {
            status: StatusCode::BAD_REQUEST,
            body,
        }
    }
}

fn ladder(code: i64, message: &str, data: Option<Value>, body: &Value) -> Rejection {
    let mut error = json!({ "code": code, "message": message });
    if let (Some(data), Some(error)) = (data, error.as_object_mut()) {
        error.insert("data".to_owned(), data);
    }
    Rejection(json!({ "jsonrpc": "2.0", "error": error, "id": rpc::echoable_id(body) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_sentinel_is_canonical_base64_of_utf8() {
        assert_eq!(decode_param_value("echo").as_deref(), Some("echo"));
        assert_eq!(
            decode_param_value("=?base64?ZWNobw==?=").as_deref(),
            Some("echo")
        );
        assert_eq!(decode_param_value("=?base64?ZW==?=").as_deref(), Some("e"));
        assert_eq!(decode_param_value("=?base64??=").as_deref(), Some(""));
        assert_eq!(decode_param_value("=?base64?=").as_deref(), Some(""));
        assert_eq!(decode_param_value("=?base64?ZWNobw?="), None);
        assert_eq!(decode_param_value("=?base64?ZW=o?="), None);
        assert_eq!(decode_param_value("=?base64?/w==?="), None);
    }

    #[test]
    fn modern_revisions_compare_as_dates() {
        assert!(is_modern("2026-07-28"));
        assert!(is_modern("2027-01-01"));
        assert!(!is_modern("2025-11-25"));
        assert!(!is_modern(""));
    }
}
