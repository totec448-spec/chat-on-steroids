//! The listener's request handling (`server.ts` `http.createServer` callback): route by
//! secret path, guard Host and Origin, cap the body, then hand JSON-RPC to [`crate::rpc`].
//! Every body it writes is JSON or an event stream.

use std::collections::HashSet;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use cos_http::{Body, BoxFuture, Service};
use cos_store::Logger;
use cos_tools::{Inbound, RequestId, SurfaceId};
use cos_types::config::Config;
use http::header::{CACHE_CONTROL, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, HOST, ORIGIN};
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, Version};
use http_body_util::BodyExt;
use hyper::body::{Frame, Incoming};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::guards::{self, Refused};
use crate::modern;
use crate::port::Dispatch;
use crate::rpc::{self, Call, Client, Plan, Planned, RpcHeaders};
use crate::{MAX_BODY_BYTES, ProbeHeaders, Refusal};

/// RFC 9728 section 3.1: the metadata for a resource at `/x` lives at `/.well-known/.../x`.
pub(crate) const PRM_PREFIX: &str = "/.well-known/oauth-protected-resource";
/// `server.requestTimeout`: the whole request, body included, must arrive within this.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const CONNECTOR_BRAND: &str = "Chat On Steroids";
/// `DEFAULT_MAX_SUBSCRIPTIONS`: open `subscriptions/listen` streams per surface.
const MAX_SUBSCRIPTIONS: usize = 1024;
/// `DEFAULT_SSE_KEEP_ALIVE_MS`.
const KEEP_ALIVE: Duration = Duration::from_secs(15);
/// How long a stopping endpoint waits to hand a subscriber its close frame.
const CLOSE_FRAME_WAIT: Duration = Duration::from_secs(1);
/// Distinct clients logged per generation; past this, new ones are not logged.
const MAX_LOGGED_CLIENTS: usize = 256;

/// State the endpoint shares with its [`crate::McpEndpoint`] handle.
pub(crate) struct Shared {
    pub(crate) stopping: watch::Sender<bool>,
    /// Requests handed to JSON-RPC whose answer is not finished.
    pub(crate) accepted: AtomicUsize,
    pub(crate) logger: Logger,
    /// Open `subscriptions/listen` streams, by position in `SurfaceId::ALL`.
    listening: [AtomicUsize; 3],
    /// Clients already logged this generation.
    clients: Mutex<HashSet<(SurfaceId, Client)>>,
}

impl Shared {
    pub(crate) fn new(logger: Logger) -> Self {
        Self {
            stopping: watch::Sender::new(false),
            accepted: AtomicUsize::new(0),
            logger,
            listening: Default::default(),
            clients: Mutex::default(),
        }
    }

    fn stopping(&self) -> bool {
        *self.stopping.borrow()
    }
}

/// One surface's secret path and its metadata path.
pub(crate) struct Route {
    pub(crate) surface: SurfaceId,
    pub(crate) path: String,
    pub(crate) prm_path: String,
}

pub(crate) struct Endpoint<K: Dispatch> {
    pub(crate) kernel: Arc<K>,
    pub(crate) routes: Vec<Route>,
    /// Set once the OS has chosen the port; a request can name a token only after that.
    pub(crate) port: OnceLock<u16>,
    pub(crate) probe: ProbeHeaders,
    pub(crate) config: watch::Receiver<Arc<Config>>,
    pub(crate) setup_profile_id: Option<String>,
    pub(crate) shared: Arc<Shared>,
}

impl<K: Dispatch> Service for Endpoint<K> {
    fn serve(self: Arc<Self>, request: Request<Incoming>) -> BoxFuture<Response<Body>> {
        Box::pin(async move { self.handle(request).await })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Target {
    Mcp(SurfaceId),
    Metadata(SurfaceId),
    Unknown,
}

/// The app's own traffic, which must not count as ChatGPT reaching the connector.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Caller {
    Client,
    SelfTest,
    TunnelProbe,
}

/// The activity-log line written when a response finishes.
struct Finish {
    logger: Logger,
    method: Method,
    target: Target,
    shape: String,
    caller: Caller,
    started: Instant,
}

impl Finish {
    fn log(&self, status: StatusCode) {
        let who = match self.caller {
            Caller::Client => "",
            Caller::SelfTest => " (self-test)",
            Caller::TunnelProbe => " (tunnel probe)",
        };
        let line = format!(
            "{} {} → {} in {}ms{who}",
            self.method,
            self.shape,
            status.as_u16(),
            self.started.elapsed().as_millis()
        );
        let on_mcp = matches!(self.target, Target::Mcp(_));
        // ChatGPT probes for the optional server stream and session deletion on every
        // connect; 405 is the prescribed answer, not a failure.
        if status == StatusCode::METHOD_NOT_ALLOWED
            && on_mcp
            && (self.method == Method::GET || self.method == Method::DELETE)
        {
            self.logger.info(&format!(
                "request {line} (stream/session not offered — normal)"
            ));
        } else if self.caller == Caller::TunnelProbe
            && status == StatusCode::UNSUPPORTED_MEDIA_TYPE
            && on_mcp
            && self.method == Method::POST
        {
            self.logger.info(&format!(
                "request {line} (probe compatibility check — normal)"
            ));
        } else if status.as_u16() >= 400 {
            self.logger.warn(&format!("request {line}"));
        } else {
            self.logger.info(&format!("request {line}"));
        }
    }
}

/// Counts one open `subscriptions/listen` stream, until it drops.
struct Subscription(Arc<Shared>, usize);

impl Subscription {
    fn open(shared: &Arc<Shared>, slot: usize) -> Self {
        shared.listening[slot].fetch_add(1, Ordering::Relaxed);
        Self(shared.clone(), slot)
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.0.listening[self.1].fetch_sub(1, Ordering::Relaxed);
    }
}

/// Counts one answer that drain must wait for, until it drops.
struct Accepted(Arc<Shared>);

impl Accepted {
    fn new(shared: &Arc<Shared>) -> Self {
        shared.accepted.fetch_add(1, Ordering::Relaxed);
        Self(shared.clone())
    }
}

impl Drop for Accepted {
    fn drop(&mut self) {
        self.0.accepted.fetch_sub(1, Ordering::Relaxed);
    }
}

enum BodyRead {
    Complete(Vec<u8>),
    /// Over the cap. The rest of the body is still unread.
    TooLarge(Incoming),
    Broken,
}

impl<K: Dispatch> Endpoint<K> {
    async fn handle(self: Arc<Self>, request: Request<Incoming>) -> Response<Body> {
        let started = Instant::now();
        if self.shared.stopping() {
            return refusal(Refusal::ServerStopping, false);
        }
        let (parts, body) = request.into_parts();
        let keep_alive = wants_keep_alive(parts.version, &parts.headers);
        let path = parts.uri.path();
        let target = self.target(path);
        let finish = Finish {
            logger: self.shared.logger.clone(),
            method: parts.method.clone(),
            target,
            shape: match target {
                Target::Mcp(surface) => format!("mcp/{}", surface.as_str()),
                Target::Metadata(surface) => format!("oauth-metadata/{}", surface.as_str()),
                Target::Unknown => path.chars().take(40).collect(),
            },
            caller: self.caller(&parts.headers),
            started,
        };
        let response = match target {
            Target::Unknown => refusal(Refusal::NotFound, keep_alive),
            Target::Metadata(surface) => match guard(&parts.headers) {
                Err(refused) => forbidden(refused, keep_alive),
                Ok(_) => self.metadata(surface, keep_alive),
            },
            Target::Mcp(surface) => {
                return self
                    .mcp(surface, parts, body, keep_alive, started, finish)
                    .await;
            }
        };
        self.discard(body, started + REQUEST_TIMEOUT);
        finish.log(response.status());
        response
    }

    async fn mcp(
        self: Arc<Self>,
        surface: SurfaceId,
        parts: http::request::Parts,
        body: Incoming,
        keep_alive: bool,
        started: Instant,
        finish: Finish,
    ) -> Response<Body> {
        let done = |response: Response<Body>| {
            finish.log(response.status());
            response
        };
        let deadline = started + REQUEST_TIMEOUT;
        let host = match guard(&parts.headers) {
            Err(refused) => {
                self.discard(body, deadline);
                return done(forbidden(refused, keep_alive));
            }
            Ok(host) => host,
        };
        // Only a validated request from outside the app is evidence that ChatGPT reached
        // this connector.
        let request = (finish.caller == Caller::Client).then(|| self.kernel.begin_request(surface));
        let declared = parts
            .headers
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(0);
        if declared > MAX_BODY_BYTES as u64 {
            self.discard(body, deadline);
            return done(refusal(Refusal::PayloadTooLarge, keep_alive));
        }
        let parsed = if parts.method == Method::GET || parts.method == Method::HEAD {
            self.discard(body, deadline);
            None
        } else {
            let mut stopping = self.shared.stopping.subscribe();
            let read = tokio::select! {
                read = read_bounded(body) => read,
                _ = stopping.wait_for(|stopping| *stopping) => {
                    return done(refusal(Refusal::ServerStopping, false));
                }
                () = tokio::time::sleep_until(deadline) => return done(timed_out()),
            };
            match read {
                BodyRead::TooLarge(rest) => {
                    self.discard(rest, deadline);
                    return done(refusal(Refusal::PayloadTooLarge, keep_alive));
                }
                BodyRead::Broken => return done(refusal(Refusal::InvalidJson, keep_alive)),
                BodyRead::Complete(bytes) => match parse_json(&bytes) {
                    Some(value) => Some(value),
                    None => return done(refusal(Refusal::InvalidJson, keep_alive)),
                },
            }
        };
        if self.shared.stopping() {
            return done(refusal(Refusal::ServerStopping, false));
        }
        if host.credentials {
            // The SDK's Node adapter cannot build a request URL that carries credentials.
            self.handler_error(
                surface,
                "Request cannot be constructed from a URL that includes credentials",
            );
            let id = parsed.as_ref().map_or(Value::Null, rpc::echoable_id);
            let body = rpc::http_error(-32603, "Internal server error", id);
            return done(json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &body,
                keep_alive,
            ));
        }
        let headers = &parts.headers;
        let accept = first(headers, "accept");
        let content_type = first(headers, CONTENT_TYPE.as_str());
        let protocol_version = joined(headers, "mcp-protocol-version");
        let mcp_method = joined(headers, "mcp-method");
        let mcp_name = joined(headers, "mcp-name");
        let rpc_headers = RpcHeaders {
            accept: accept.as_deref(),
            content_type: content_type.as_deref(),
            protocol_version: protocol_version.as_deref(),
            method: mcp_method.as_deref(),
            name: mcp_name.as_deref(),
        };
        let Planned { plan, client } = rpc::plan(&parts.method, rpc_headers, parsed);
        if let Some(client) = client
            && finish.caller == Caller::Client
        {
            self.note_client(surface, client);
        }
        let inbound = || Inbound {
            request_id: request_id(headers),
            setup_profile_id: self.setup_profile_id.clone(),
        };
        match plan {
            Plan::Reply { status, body } => done(json_response(status, &body, keep_alive)),
            Plan::Accepted => done(
                with_connection(Response::builder(), keep_alive)
                    .status(StatusCode::ACCEPTED)
                    .body(cos_http::full(Bytes::new()))
                    .unwrap_or_else(|_| fallback()),
            ),
            Plan::Stream(calls) => {
                self.stream(surface, calls, inbound(), keep_alive, request, finish)
            }
            Plan::Modern(call) => {
                self.modern(surface, call, inbound(), keep_alive, request, finish)
                    .await
            }
            Plan::Listen { id, filter } => {
                drop(request);
                self.listen(surface, id, filter, keep_alive, finish)
            }
        }
    }

    /// Answers one 2026-07-28 request with a whole JSON body. The work runs in its own task,
    /// so a client that disconnects never cancels a tool call that already started.
    async fn modern(
        &self,
        surface: SurfaceId,
        call: Call,
        inbound: Inbound,
        keep_alive: bool,
        request: Option<K::Request>,
        finish: Finish,
    ) -> Response<Body> {
        let id = call.id.clone();
        let accepted = Accepted::new(&self.shared);
        let kernel = self.kernel.clone();
        let work = tokio::spawn(async move {
            let _held = (request, accepted);
            modern::answer(kernel, surface, inbound, call).await
        });
        let message = work.await.unwrap_or_else(|failure| {
            self.handler_error(surface, &format!("request {id} failed: {failure}"));
            rpc::internal_error(&id)
        });
        let response = json_response(StatusCode::OK, &message, keep_alive);
        finish.log(StatusCode::OK);
        response
    }

    /// Serves one `subscriptions/listen`: the acknowledgement, then a keepalive comment every
    /// 15 seconds until the client leaves or the endpoint stops. Nothing in the app publishes
    /// list changes, so no notification is ever sent on it. A stop ends the stream with the
    /// SDK's graceful close result, so a drain never waits on a subscription.
    fn listen(
        &self,
        surface: SurfaceId,
        id: Value,
        filter: Option<Value>,
        keep_alive: bool,
        finish: Finish,
    ) -> Response<Body> {
        let slot = SurfaceId::ALL
            .iter()
            .position(|known| *known == surface)
            .unwrap_or_default();
        if self.shared.listening[slot].load(Ordering::Relaxed) >= MAX_SUBSCRIPTIONS {
            let body = modern::listen_error(&id, -32603, "Subscription limit reached");
            finish.log(StatusCode::OK);
            return json_response(StatusCode::OK, &body, keep_alive);
        }
        let Some(honored) = filter else {
            let body = modern::listen_error(&id, -32602, modern::INVALID_FILTER);
            finish.log(StatusCode::OK);
            return json_response(StatusCode::OK, &body, keep_alive);
        };
        let subscription = Subscription::open(&self.shared, slot);
        let info = self.kernel.server_info(surface);
        let (frames, body) = event_stream();
        let mut stopping = self.shared.stopping.subscribe();
        tokio::spawn(async move {
            let _open = subscription;
            let frame =
                |message: Value| Bytes::from(format!("event: message\ndata: {message}\n\n"));
            let mut beat = tokio::time::interval_at(Instant::now() + KEEP_ALIVE, KEEP_ALIVE);
            let mut next = frame(modern::acknowledgement(&id, &honored));
            loop {
                let stopped = tokio::select! {
                    sent = frames.send(next) => {
                        if sent.is_err() {
                            break;
                        }
                        false
                    }
                    _ = stopping.wait_for(|stopping| *stopping) => true,
                };
                let stopped = stopped
                    || tokio::select! {
                        _ = beat.tick() => false,
                        _ = stopping.wait_for(|stopping| *stopping) => true,
                    };
                if stopped {
                    let closed = frames.send(frame(modern::listen_closed(&id, &info)));
                    let _ = tokio::time::timeout(CLOSE_FRAME_WAIT, closed).await;
                    break;
                }
                next = Bytes::from_static(b": keepalive\n\n");
            }
            drop(frames);
            finish.log(StatusCode::OK);
        });
        with_connection(Response::builder(), keep_alive)
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/event-stream")
            .header(CACHE_CONTROL, "no-cache, no-transform")
            .header("x-accel-buffering", "no")
            .body(body)
            .unwrap_or_else(|_| fallback())
    }

    /// Logs, once per generation, which protocol a new client speaks and what it calls
    /// itself, so the first real connection shows which era ChatGPT negotiates.
    fn note_client(&self, surface: SurfaceId, client: Client) {
        let line = format!("MCP client ({}): {client}", surface.as_str());
        let mut seen = self
            .shared
            .clients
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if seen.len() < MAX_LOGGED_CLIENTS && seen.insert((surface, client)) {
            drop(seen);
            self.shared.logger.info(&line);
        }
    }

    /// Answers the requests of one POST as an event stream: one frame per distinct id, in
    /// request order. Each request runs in its own task, so a client that disconnects never
    /// cancels a tool call that already started.
    fn stream(
        &self,
        surface: SurfaceId,
        calls: Vec<Call>,
        inbound: Inbound,
        keep_alive: bool,
        request: Option<K::Request>,
        finish: Finish,
    ) -> Response<Body> {
        let mut answers: Vec<(Value, JoinHandle<Value>)> = Vec::new();
        for call in calls {
            let id = call.id.clone();
            let work = tokio::spawn(rpc::answer(
                self.kernel.clone(),
                surface,
                inbound.clone(),
                call,
            ));
            // The SDK answers a repeated id once; the repeat still runs.
            if answers.iter().all(|(known, _)| *known != id) {
                answers.push((id, work));
            }
        }
        let (frames, body) = event_stream();
        let accepted = Accepted::new(&self.shared);
        let logger = self.shared.logger.clone();
        tokio::spawn(async move {
            let _held = (request, accepted);
            for (id, work) in answers {
                let message = work.await.unwrap_or_else(|failure| {
                    logger.error(&format!(
                        "MCP handler error ({}): request {id} failed: {failure}",
                        surface.as_str()
                    ));
                    rpc::internal_error(&id)
                });
                let frame = format!("event: message\ndata: {message}\n\n");
                // A client that left loses only its own answer.
                let _ = frames.send(Bytes::from(frame)).await;
            }
            drop(frames);
            finish.log(StatusCode::OK);
        });
        with_connection(Response::builder(), keep_alive)
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/event-stream")
            .header(CACHE_CONTROL, "no-cache, no-transform")
            .header("x-accel-buffering", "no")
            .body(body)
            .unwrap_or_else(|_| fallback())
    }

    fn metadata(&self, surface: SurfaceId, keep_alive: bool) -> Response<Body> {
        let port = self.port.get().copied().unwrap_or_default();
        let path = self
            .routes
            .iter()
            .find(|route| route.surface == surface)
            .map_or("", |route| route.path.as_str());
        let body = json!({
            "resource": format!("http://127.0.0.1:{port}{path}"),
            "resource_name": connector_name(surface, self.config.borrow().connector_suffix.as_deref()),
            "authorization_servers": [],
            "scopes_supported": [],
        });
        with_connection(Response::builder(), keep_alive)
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "application/json")
            .header(CACHE_CONTROL, "no-store")
            .body(cos_http::full(body.to_string()))
            .unwrap_or_else(|_| fallback())
    }

    fn target(&self, path: &str) -> Target {
        let same = |known: &str| bool::from(path.as_bytes().ct_eq(known.as_bytes()));
        for route in &self.routes {
            if same(&route.prm_path) {
                return Target::Metadata(route.surface);
            }
        }
        for route in &self.routes {
            if same(&route.path) {
                return Target::Mcp(route.surface);
            }
        }
        Target::Unknown
    }

    fn caller(&self, headers: &HeaderMap) -> Caller {
        let carries = |(name, token): &(&'static str, String)| {
            joined(headers, name).is_some_and(|value| value == *token)
        };
        if carries(&self.probe.self_test) {
            Caller::SelfTest
        } else if carries(&self.probe.tunnel_probe) {
            Caller::TunnelProbe
        } else {
            Caller::Client
        }
    }

    fn handler_error(&self, surface: SurfaceId, message: &str) {
        self.shared.logger.error(&format!(
            "MCP handler error ({}): {message}",
            surface.as_str()
        ));
    }

    /// Reads and drops the rest of a body the answer does not need, so the connection stays
    /// usable. Hyper drains only the bytes already received when a body is dropped, then
    /// closes, and a body that lands after the close resets the connection, which on Windows
    /// destroys the answer the client has not read yet.
    fn discard(&self, mut body: Incoming, deadline: Instant) {
        let mut stopping = self.shared.stopping.subscribe();
        tokio::spawn(async move {
            tokio::select! {
                () = async { while let Some(Ok(_)) = body.frame().await {} } => {}
                _ = stopping.wait_for(|stopping| *stopping) => {}
                () = tokio::time::sleep_until(deadline) => {}
            }
        });
    }
}

fn guard(headers: &HeaderMap) -> Result<guards::AllowedHost, Refused> {
    let host = guards::check_host(first(headers, HOST.as_str()).as_deref())?;
    guards::check_origin(joined(headers, ORIGIN.as_str()).as_deref())?;
    Ok(host)
}

async fn read_bounded(mut body: Incoming) -> BodyRead {
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else {
            return BodyRead::Broken;
        };
        if let Ok(data) = frame.into_data() {
            if bytes.len() + data.len() > MAX_BODY_BYTES {
                return BodyRead::TooLarge(body);
            }
            bytes.extend_from_slice(&data);
        }
    }
    BodyRead::Complete(bytes)
}

/// `JSON.parse` of the body decoded as UTF-8 with replacement; an empty body is `null`.
fn parse_json(bytes: &[u8]) -> Option<Value> {
    if bytes.is_empty() {
        return Some(Value::Null);
    }
    serde_json::from_str(&String::from_utf8_lossy(bytes)).ok()
}

/// The request id when exactly one `x-request-id` header carries it. Two copies are
/// ambiguous evidence, so neither is trusted.
fn request_id(headers: &HeaderMap) -> Option<RequestId> {
    let mut values = headers.get_all("x-request-id").iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        return None;
    };
    RequestId::from_header(&latin1(value))
}

/// Header bytes as Node decodes them.
fn latin1(value: &HeaderValue) -> String {
    value
        .as_bytes()
        .iter()
        .map(|&byte| char::from(byte))
        .collect()
}

/// The first value, as Node keeps it for headers such as `Host` and `Content-Type`.
fn first(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).map(latin1)
}

/// Every value joined with `, `, as Node joins repeated headers.
fn joined(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers.get_all(name).iter().map(latin1).collect();
    (!values.is_empty()).then(|| values.join(", "))
}

fn wants_keep_alive(version: Version, headers: &HeaderMap) -> bool {
    let has = |token: &str| {
        headers.get_all(CONNECTION).iter().any(|value| {
            latin1(value)
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case(token))
        })
    };
    match version {
        Version::HTTP_10 => has("keep-alive"),
        _ => !has("close"),
    }
}

fn connector_name(surface: SurfaceId, suffix: Option<&str>) -> String {
    let word = match surface {
        SurfaceId::Core => "Core",
        SurfaceId::Desktop => "Desktop",
        SurfaceId::Plugins => "Plugins",
    };
    // The config parser already trimmed and validated the suffix; runs of spaces collapse.
    let tag = suffix
        .unwrap_or_default()
        .split(' ')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if tag.is_empty() {
        format!("{CONNECTOR_BRAND} {word}")
    } else {
        format!("{CONNECTOR_BRAND} {word} ({tag})")
    }
}

fn with_connection(builder: http::response::Builder, keep_alive: bool) -> http::response::Builder {
    builder.header(CONNECTION, if keep_alive { "keep-alive" } else { "close" })
}

fn json_response(status: StatusCode, body: &Value, keep_alive: bool) -> Response<Body> {
    with_connection(Response::builder(), keep_alive)
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(cos_http::full(body.to_string()))
        .unwrap_or_else(|_| fallback())
}

/// An event-stream body and the sender that feeds it. The body ends once the sender is
/// dropped and every frame sent before that has been read.
pub(crate) fn event_stream() -> (mpsc::Sender<Bytes>, Body) {
    let (frames, queue) = mpsc::channel(4);
    (frames, EventStream(queue).boxed())
}

/// `http_body_util::Channel` checks its frame queue and then whether the sender was dropped,
/// so a last frame sent between the two checks is lost. One queue ends only once it is empty.
struct EventStream(mpsc::Receiver<Bytes>);

impl hyper::body::Body for EventStream {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.0
            .poll_recv(cx)
            .map(|next| next.map(|bytes| Ok(Frame::data(bytes))))
    }
}

/// The listener's own refusal: `{"error": "<code>"}`.
fn refusal(refusal: Refusal, keep_alive: bool) -> Response<Body> {
    json_response(
        refusal.status(),
        &json!({ "error": refusal.code() }),
        keep_alive,
    )
}

/// The SDK's Host and Origin refusal: a JSON-RPC error with `id: null`.
fn forbidden(Refused(message): Refused, keep_alive: bool) -> Response<Body> {
    let body = rpc::http_error(-32000, &message, Value::Null);
    json_response(StatusCode::FORBIDDEN, &body, keep_alive)
}

/// `requestTimeout`: Node answers 408 without a body and closes.
fn timed_out() -> Response<Body> {
    with_connection(Response::builder(), false)
        .status(StatusCode::REQUEST_TIMEOUT)
        .body(cos_http::full(Bytes::new()))
        .unwrap_or_else(|_| fallback())
}

/// Every builder above uses static header names and values, so this is never reached.
fn fallback() -> Response<Body> {
    let mut response = Response::new(cos_http::full(Bytes::new()));
    *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    response
}
