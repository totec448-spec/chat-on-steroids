//! One OpenRouter or custom OpenAI-compatible decision over HTTP (`requestGoalDecision`'s API
//! half, `httpFailure`, `readGoalCompletion`, `readStream`). There is deliberately no retry:
//! whether asking again is worth anything is the page's call.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde_json::{Map, Value, json};

use cos_types::config::{GoalMode, GoalProviderKind, GoalReasoning, GoalSettings};

use crate::context::ChatMessage;
use crate::decision::{self, Decision, MAX_MESSAGE_CHARS};
use crate::js;
use crate::prompts;

/// Where OpenRouter lives. One host, both routes.
pub const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";

/// A single SSE record should be tiny; this still leaves room around the 12k reply cap.
const MAX_SSE_RECORD_CHARS: usize = 64_000;
/// Error prose is diagnostic only.
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
/// A Goal decision is tiny; the successful envelope is bounded like failure prose.
const MAX_GOAL_BODY_BYTES: usize = 64 * 1024;

/// Which endpoint the helper model runs on, captured with the draft.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub kind: GoalProviderKind,
    /// The configured text for custom; the OpenRouter base otherwise.
    pub base_url: String,
}

/// `goalEndpoint()`.
pub fn endpoint(goal: &GoalSettings, openrouter: &str) -> Endpoint {
    match goal.provider.kind {
        GoalProviderKind::Custom => Endpoint {
            kind: GoalProviderKind::Custom,
            base_url: goal.provider.base_url.clone(),
        },
        GoalProviderKind::Openrouter => Endpoint {
            kind: GoalProviderKind::Openrouter,
            base_url: openrouter.to_owned(),
        },
    }
}

/// `resolveGoalBaseUrl`: checked at use time, so a typo fails as settled `invalid_provider`
/// instead of pointing a key at a host nobody chose.
pub fn resolve_base_url(endpoint: &Endpoint) -> Result<String, String> {
    if endpoint.kind == GoalProviderKind::Openrouter {
        return Ok(endpoint.base_url.clone());
    }
    let raw = js::trim(&endpoint.base_url).trim_end_matches('/');
    let url = url::Url::parse(raw)
        .map_err(|_| "invalid_provider: custom provider URL is invalid".to_owned())?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !scheme_ok
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "invalid_provider: custom provider URL must be https, or http on localhost".to_owned(),
        );
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// One request to a provider.
pub struct ApiRequest<'a> {
    pub endpoint: &'a Endpoint,
    pub key: &'a str,
    pub model: &'a str,
    pub mode: GoalMode,
    pub reasoning: GoalReasoning,
    pub planner: bool,
    pub system: &'a [String],
    pub messages: &'a [ChatMessage],
    pub trailer: &'a str,
}

/// What a provider answered: a decision to validate, or a refusal before any content.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    Decision(Decision),
    Refused {
        error: String,
        retry_after_ms: Option<u64>,
    },
}

/// The request body, in the order the TypeScript app writes it.
pub fn body(request: &ApiRequest<'_>, stream: bool) -> Value {
    let custom = request.endpoint.kind == GoalProviderKind::Custom;
    let contract = if request.planner {
        prompts::PLANNER_CONTRACT
    } else {
        prompts::REFERENCE_CONTRACT
    };
    let mut messages: Vec<Value> = request
        .system
        .iter()
        .map(|content| json!({ "role": "system", "content": content }))
        .collect();
    messages.push(json!({ "role": "system", "content": prompts::output_protocol(request.mode) }));
    messages.push(json!({
        "role": "user",
        "content": format!("{contract}\n\n{}", crate::context::stringify(request.messages)),
    }));
    messages.push(json!({ "role": "system", "content": request.trailer }));
    let mut body = Map::new();
    body.insert("model".into(), json!(request.model));
    body.insert("stream".into(), json!(stream));
    body.insert("messages".into(), Value::Array(messages));
    body.insert(
        "response_format".into(),
        prompts::response_format(request.mode),
    );
    if !stream && !custom {
        body.insert("plugins".into(), json!([{ "id": "response-healing" }]));
    }
    if !custom {
        body.insert("provider".into(), json!({ "require_parameters": true }));
        let mut reasoning = Map::new();
        if request.reasoning != GoalReasoning::Default {
            reasoning.insert("effort".into(), json!(request.reasoning.as_str()));
        }
        reasoning.insert("exclude".into(), json!(true));
        body.insert("reasoning".into(), Value::Object(reasoning));
    } else if request.reasoning != GoalReasoning::Default {
        body.insert("reasoning_effort".into(), json!(request.reasoning.as_str()));
    }
    Value::Object(body)
}

type HttpsClient = Client<hyper_rustls::HttpsConnector<HttpConnector>, Full<Bytes>>;

/// The HTTPS client every Goal request shares. Native roots are loaded once.
#[derive(Clone, Default)]
pub struct Http {
    client: Arc<OnceLock<Result<HttpsClient, String>>>,
}

impl Http {
    fn client(&self) -> Result<&HttpsClient, String> {
        self.client
            .get_or_init(|| {
                let connector = hyper_rustls::HttpsConnectorBuilder::new()
                    .with_provider_and_native_roots(rustls::crypto::ring::default_provider())
                    .map_err(|error| format!("no TLS roots: {error}"))?
                    .https_or_http()
                    .enable_http1()
                    .build();
                Ok(Client::builder(TokioExecutor::new()).build(connector))
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    async fn post(
        &self,
        url: &str,
        headers: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<http::Response<Incoming>, String> {
        let mut request = http::Request::post(url);
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        let request = request
            .body(Full::new(Bytes::from(body)))
            .map_err(|_| "fetch failed".to_owned())?;
        self.client()?
            .request(request)
            .await
            .map_err(|_| "fetch failed".to_owned())
    }
}

fn header<'a>(response: &'a http::Response<Incoming>, name: &str) -> Option<&'a str> {
    response.headers().get(name).and_then(|v| v.to_str().ok())
}

/// Reads a body under a byte ceiling, refusing a declared length past it before reading.
async fn bounded(response: http::Response<Incoming>, max: usize) -> Result<Vec<u8>, String> {
    let declared = header(&response, "content-length").and_then(|v| v.trim().parse::<u64>().ok());
    if declared.is_some_and(|length| length > max as u64) {
        return Err("response_body_too_large".to_owned());
    }
    let mut body = response.into_body();
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| "terminated".to_owned())?;
        if let Ok(data) = frame.into_data() {
            bytes.extend_from_slice(&data);
            if bytes.len() > max {
                return Err("response_body_too_large".to_owned());
            }
        }
    }
    Ok(bytes)
}

/// `Retry-After` in seconds. An HTTP date is not read.
fn retry_after(response: &http::Response<Incoming>) -> Option<u64> {
    let value = header(response, "retry-after")?.trim();
    let mut parts = value.splitn(2, '.');
    let whole = parts.next()?;
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || parts.next().is_some_and(|fraction| !digits(fraction)) {
        return None;
    }
    let seconds: f64 = value.parse().ok()?;
    Some((seconds * 1000.0).round() as u64)
}

/// `httpFailure`: the failure in words the page can show, without quoting the key back.
async fn failure(response: http::Response<Incoming>) -> String {
    let status = response.status().as_u16();
    let detail = match bounded(response, MAX_ERROR_BODY_BYTES).await {
        Ok(bytes) => {
            let raw = String::from_utf8_lossy(&bytes).into_owned();
            if raw.is_empty() {
                String::new()
            } else {
                match serde_json::from_str::<Value>(&raw) {
                    Ok(parsed) => {
                        let message = parsed
                            .as_object()
                            .filter(|object| object.contains_key("error"))
                            .and_then(|object| object.get("error"))
                            .and_then(|error| error.get("message"))
                            .and_then(Value::as_str);
                        js::prefix(message.unwrap_or(&raw), 200)
                    }
                    Err(_) => String::new(),
                }
            }
        }
        Err(error) if error == "response_body_too_large" => "response body too large".to_owned(),
        Err(_) => String::new(),
    };
    let or = |fallback: &str| {
        if detail.is_empty() {
            fallback.to_owned()
        } else {
            detail.clone()
        }
    };
    match status {
        401 | 403 => format!("auth_rejected: {}", or("the OpenRouter key was refused")),
        402 => format!(
            "out_of_credit: {}",
            or("the OpenRouter account is out of credit")
        ),
        404 => format!(
            "unknown_model: {}",
            or("OpenRouter does not know that model id")
        ),
        429 => format!(
            "rate_limited: {}",
            or("OpenRouter is rate-limiting this key")
        ),
        _ if detail.is_empty() => format!("http_{status}"),
        _ => format!("http_{status}: {detail}"),
    }
}

/// `readGoalCompletion` for a JSON envelope.
fn completion(raw: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(raw);
    let parsed: Value = if text.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).map_err(|_| "malformed_completion_response".to_owned())?
    };
    if parsed
        .as_object()
        .and_then(|object| object.get("error"))
        .is_some_and(truthy)
    {
        return Err("provider_completion_error".to_owned());
    }
    let content = parsed
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| "malformed_completion_response".to_owned())?;
    if js::len(content) > MAX_MESSAGE_CHARS + 2_048 {
        return Err("reply_too_long".to_owned());
    }
    Ok(content.to_owned())
}

fn delta_of(parsed: &Value) -> &str {
    let Some(choice) = parsed
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return "";
    };
    let content = choice
        .get("delta")
        .and_then(|delta| delta.get("content"))
        .filter(|content| !content.is_null())
        .or_else(|| {
            choice
                .get("message")
                .and_then(|message| message.get("content"))
        });
    content.and_then(Value::as_str).unwrap_or("")
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// One SSE line. `Ok(true)` is the terminal `[DONE]` record.
fn consume(
    line: &str,
    text: &mut String,
    publish: &mut (dyn FnMut(&str) + Send),
) -> Result<bool, String> {
    if js::len(line) > MAX_SSE_RECORD_CHARS {
        return Err("stream_record_too_long".to_owned());
    }
    let line = js::trim(line);
    let Some(payload) = line.strip_prefix("data:") else {
        return Ok(false);
    };
    let payload = js::trim(payload);
    if payload.is_empty() {
        return Ok(false);
    }
    if payload == "[DONE]" {
        return Ok(true);
    }
    let parsed: Value =
        serde_json::from_str(payload).map_err(|_| "malformed_stream_record".to_owned())?;
    if let Some(error) = parsed.as_object().and_then(|object| object.get("error"))
        && truthy(error)
    {
        let message = match error {
            Value::String(text) => Some(text.as_str()),
            other => other.get("message").and_then(Value::as_str),
        };
        let detail = message.map(|text| js::prefix(js::trim(&collapse_breaks(text)), 200));
        return Err(match detail.filter(|d| !d.is_empty()) {
            Some(detail) => format!("provider_stream_error: {detail}"),
            None => "provider_stream_error".to_owned(),
        });
    }
    let delta = delta_of(&parsed);
    if delta.is_empty() {
        return Ok(false);
    }
    if js::len(text) + js::len(delta) > MAX_MESSAGE_CHARS {
        return Err("reply_too_long".to_owned());
    }
    text.push_str(delta);
    publish(text);
    Ok(false)
}

/// `replace(/[\r\n\t]+/g, ' ')`: a run of breaks becomes one space.
fn collapse_breaks(original: &str) -> String {
    let mut out = String::with_capacity(original.len());
    let mut in_run = false;
    for c in original.chars() {
        if matches!(c, '\r' | '\n' | '\t') {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `readStream`: deltas published as they arrive; `[DONE]` ends it.
async fn stream(
    response: http::Response<Incoming>,
    publish: &mut (dyn FnMut(&str) + Send),
) -> Result<String, String> {
    let mut body = response.into_body();
    let mut buffered: Vec<u8> = Vec::new();
    let mut text = String::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| "terminated".to_owned())?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        buffered.extend_from_slice(&data);
        while let Some(cut) = buffered.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buffered.drain(..=cut).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
            if consume(&line, &mut text, publish)? {
                return Ok(text);
            }
        }
        if buffered.len() > MAX_SSE_RECORD_CHARS
            && js::len(&String::from_utf8_lossy(&buffered)) > MAX_SSE_RECORD_CHARS
        {
            return Err("stream_record_too_long".to_owned());
        }
    }
    if !buffered.is_empty() {
        let rest = String::from_utf8_lossy(&buffered).into_owned();
        if js::len(&rest) > MAX_SSE_RECORD_CHARS {
            return Err("stream_record_too_long".to_owned());
        }
        consume(&rest, &mut text, publish)?;
    }
    Ok(text)
}

/// The API half of `requestGoalDecision`. `Err` is what TypeScript throws.
pub async fn request(
    http: &Http,
    request: &ApiRequest<'_>,
    publish: Option<&mut (dyn FnMut(&str) + Send)>,
    unreadable: &mut (dyn FnMut(String) + Send),
) -> Result<Answer, String> {
    let base = match resolve_base_url(request.endpoint) {
        Ok(base) => base,
        Err(error) => {
            return Ok(Answer::Refused {
                error,
                retry_after_ms: None,
            });
        }
    };
    let custom = request.endpoint.kind == GoalProviderKind::Custom;
    let body =
        serde_json::to_vec(&body(request, publish.is_some())).map_err(|error| error.to_string())?;
    let mut headers: Vec<(&str, String)> = Vec::new();
    if !request.key.is_empty() {
        headers.push(("authorization", format!("Bearer {}", request.key)));
    }
    headers.push(("content-type", "application/json".to_owned()));
    if !custom {
        headers.push((
            "HTTP-Referer",
            "https://github.com/chat-on-steroids".to_owned(),
        ));
        headers.push(("X-Title", "Chat On Steroids".to_owned()));
    }
    let response = http
        .post(&format!("{base}/chat/completions"), &headers, body)
        .await?;
    // `redirect: 'error'`: a redirect must not hand content or credentials to another host.
    if response.status().is_redirection() {
        return Err("fetch failed".to_owned());
    }
    if !response.status().is_success() {
        let retry_after_ms = retry_after(&response);
        return Ok(Answer::Refused {
            error: failure(response).await,
            retry_after_ms,
        });
    }
    let event_stream = header(&response, "content-type")
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
    let (text, legacy) = if event_stream {
        let mut ignore = |_: &str| {};
        let sink: &mut (dyn FnMut(&str) + Send) = match publish {
            Some(publish) => publish,
            None => &mut ignore,
        };
        (stream(response, sink).await?, true)
    } else {
        (
            completion(&bounded(response, MAX_GOAL_BODY_BYTES).await?)?,
            false,
        )
    };
    Ok(Answer::Decision(decision::normalize(
        &text, legacy, unreadable,
    )))
}

/// The whole-request deadline (`REQUEST_TIMEOUT_MS`).
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(180_000);
