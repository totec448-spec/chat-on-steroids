//! One listener's request handling (`handle` in `control-api.ts`): who may call, which route a
//! target names, and what a refused request leaves on the connection.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use cos_http::{BoxFuture, Service};
use hyper::body::{Body as _, Incoming};
use hyper::header::{AUTHORIZATION, CONTENT_LENGTH, EXPECT, HOST, ORIGIN, TRANSFER_ENCODING};
use hyper::http::request::Parts;
use hyper::{Method, Request, Response};
use tokio::sync::watch;

use crate::Shared;
use crate::files::Token;
use crate::limits::{Actions, Places, RateWindow, Reads};
use crate::query::{Target, parse_target};
use crate::reply::{Refusal, Reply};
use crate::{actions, reads, stream};

/// Requests per rolling minute. A watcher polls every few seconds at most.
const RATE_LIMIT: usize = 600;
/// Actions per rolling minute: a person or an agent sends a handful, never a stream.
const ACTION_RATE_LIMIT: usize = 30;
/// Reads that have started and not finished, answered or not.
const MAX_UNFINISHED_READS: usize = 8;
/// Event pages and session details can read a whole journal, however small the page.
const MAX_HEAVY_READS: usize = 2;
/// Held connections cost a socket and a task each; an agent needs one per chat it follows.
const MAX_EVENT_STREAMS: usize = 4;
/// Actions waiting for their turn, counting the one running.
const MAX_PENDING_ACTIONS: usize = 4;
/// What the API reads of a body it will not use, so the connection can serve the next request.
const MAX_DRAINED_BYTES: usize = 1024 * 1024;

/// The waits the TypeScript app hard-codes. Tests shorten them.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Timing {
    pub(crate) read_deadline: Duration,
    pub(crate) body_timeout: Duration,
    pub(crate) action_deadline: Duration,
    pub(crate) heartbeat: Duration,
    pub(crate) poll: Duration,
    pub(crate) max_life: Duration,
    pub(crate) drain: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            read_deadline: Duration::from_secs(15),
            body_timeout: Duration::from_secs(5),
            action_deadline: Duration::from_secs(20),
            heartbeat: Duration::from_secs(15),
            poll: Duration::from_secs(5),
            max_life: Duration::from_secs(30 * 60),
            drain: Duration::from_secs(2),
        }
    }
}

/// What a handler leaves of the request body.
pub(crate) struct RequestBody {
    body: Option<Incoming>,
    /// The handler asked for the body, so the client was sent `100 Continue` if it waited.
    invited: bool,
}

impl RequestBody {
    /// Takes the body to read it whole.
    pub(crate) fn take(&mut self) -> Option<Incoming> {
        self.invited = true;
        self.body.take()
    }
}

pub(crate) enum Answer {
    Reply(Reply),
    Stream(Response<cos_http::Body>),
}

impl From<Reply> for Answer {
    fn from(reply: Reply) -> Self {
        Self::Reply(reply)
    }
}

impl From<Refusal> for Answer {
    fn from(refusal: Refusal) -> Self {
        Self::Reply(refusal.reply())
    }
}

pub(crate) struct Server {
    pub(crate) shared: Arc<Shared>,
    pub(crate) timing: Timing,
    token: Token,
    /// Known once the listener is bound; until then no Host can match.
    port: OnceLock<u16>,
    requests: RateWindow,
    pub(crate) action_window: RateWindow,
    pub(crate) reads: Reads,
    pub(crate) heavy: Places,
    pub(crate) streams: Places,
    pub(crate) actions: Actions,
    /// Turns true once when the listener stops, so every open stream ends with `stopped`.
    pub(crate) stopping: watch::Receiver<bool>,
}

impl Server {
    pub(crate) fn new(
        shared: Arc<Shared>,
        timing: Timing,
        token: Token,
        stopping: watch::Receiver<bool>,
    ) -> Self {
        Self {
            shared,
            timing,
            token,
            port: OnceLock::new(),
            requests: RateWindow::new(RATE_LIMIT),
            action_window: RateWindow::new(ACTION_RATE_LIMIT),
            reads: Reads::new(MAX_UNFINISHED_READS, timing.read_deadline),
            heavy: Places::new(
                MAX_HEAVY_READS,
                "too many journal reads in flight; retry shortly",
            ),
            streams: Places::new(
                MAX_EVENT_STREAMS,
                "too many event streams are open; close one or retry shortly",
            ),
            actions: Actions::new(MAX_PENDING_ACTIONS, timing.action_deadline),
            stopping,
        }
    }

    pub(crate) fn bound(&self, port: u16) {
        let _ = self.port.set(port);
    }

    /// Actions need both switches. The listener runs only with the first, but a save can race
    /// a request.
    pub(crate) fn actions_allowed(&self) -> bool {
        let config = self.shared.config.borrow();
        config.control_api.enabled && config.control_api.allow_actions
    }

    fn host_allowed(&self, parts: &Parts) -> bool {
        let Some(port) = self.port.get() else {
            return false;
        };
        let Some(host) = parts.headers.get(HOST).map(|value| value.as_bytes()) else {
            return false;
        };
        host == format!("127.0.0.1:{port}").as_bytes()
            || host == format!("localhost:{port}").as_bytes()
    }

    async fn handle(self: &Arc<Self>, parts: &Parts, body: &mut RequestBody) -> Answer {
        // Never answer a browser, not even with an error body it could learn from.
        if parts.headers.contains_key(ORIGIN) {
            return Refusal::OriginForbidden.into();
        }
        if !self.host_allowed(parts) {
            return Refusal::HostForbidden.into();
        }
        let authorization = parts
            .headers
            .get(AUTHORIZATION)
            .map_or(&b""[..], |value| value.as_bytes());
        if !self.token.accepts(authorization) {
            return Refusal::Unauthorized.into();
        }
        let target = match request_target(parts) {
            Ok(target) => target,
            Err(refusal) => return refusal.into(),
        };
        // An action is told apart by method and path alone, before any body is read or any id
        // looked up, so that with the switch off every one of them gets the same answer.
        if parts.method == Method::POST && actions::is_action_path(&target.path) {
            if !self.actions_allowed() {
                return Refusal::ActionsDisabled.into();
            }
            return actions::handle(self, parts, body, &target).await.into();
        }
        // Charged only after authentication, so another local process cannot spend the budget.
        if !self.requests.spend() {
            return Refusal::RateLimited.into();
        }
        if parts.method != Method::GET {
            let allow = if target.path == "/v1/inputs" {
                "GET, POST"
            } else if actions::is_action_path(&target.path) {
                "POST"
            } else {
                "GET"
            };
            return Refusal::MethodNotAllowed(allow).into();
        }
        if declared_length(parts) > 0 || parts.headers.contains_key(TRANSFER_ENCODING) {
            return Refusal::BodyNotAllowed.into();
        }
        // A cancel path answers to POST only; a GET there is a wrong method, not a missing page.
        if actions::is_action_path(&target.path) && target.path != "/v1/inputs" {
            return Refusal::MethodNotAllowed("POST").into();
        }
        if let Some(session) = stream::stream_session(&target.path) {
            return stream::open(self, parts, session, &target).await;
        }
        if target.path == "/v1/health" {
            return Reply::ok(&reads::health(self)).into();
        }
        reads::serve(self, &target).await.into()
    }

    /// Finishes the connection's side of a reply: a body the client is still holding back for
    /// `100 Continue` was refused unread, so the connection closes; a body that was sent and not
    /// used is read off the connection first, so the next request starts where it should.
    async fn finish(&self, parts: &Parts, mut body: RequestBody, reply: Reply) -> Reply {
        if expects_continue(parts) && !body.invited {
            return reply.closing();
        }
        let Some(unread) = body.body.take() else {
            return reply;
        };
        if reply.closes() || unread.is_end_stream() {
            return reply;
        }
        let drained = tokio::time::timeout(
            self.timing.body_timeout,
            cos_http::read_body(unread, MAX_DRAINED_BYTES),
        )
        .await;
        match drained {
            Ok(Ok(_)) => reply,
            _ => reply.closing(),
        }
    }
}

impl Service for Server {
    fn serve(self: Arc<Self>, request: Request<Incoming>) -> BoxFuture<Response<cos_http::Body>> {
        Box::pin(async move {
            let (parts, body) = request.into_parts();
            let mut body = RequestBody {
                body: Some(body),
                invited: false,
            };
            match self.handle(&parts, &mut body).await {
                Answer::Stream(response) => response,
                Answer::Reply(reply) => self.finish(&parts, body, reply).await.into_response(),
            }
        })
    }
}

/// `req.url` as Node hands it over: only origin-form reaches the target check.
fn request_target(parts: &Parts) -> Result<Target, Refusal> {
    let uri = &parts.uri;
    if uri.scheme().is_some() || uri.authority().is_some() {
        return Err(Refusal::InvalidTarget);
    }
    let raw = uri.path_and_query().map_or("", |target| target.as_str());
    parse_target(raw)
}

/// `Number(content-length ?? 0)`; hyper has already refused a length that is not a number.
pub(crate) fn declared_length(parts: &Parts) -> u64 {
    parts
        .headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}

/// Node's test for a request that waits for `100 Continue`.
pub(crate) fn expects_continue(parts: &Parts) -> bool {
    parts.headers.get_all(EXPECT).iter().any(|value| {
        let value = value.as_bytes().to_ascii_lowercase();
        value.windows(12).enumerate().any(|(at, window)| {
            let bounded = |byte: Option<&u8>| {
                byte.is_none_or(|byte| !(byte.is_ascii_alphanumeric() || *byte == b'_'))
            };
            window == b"100-continue"
                && bounded(at.checked_sub(1).and_then(|before| value.get(before)))
                && bounded(value.get(at + 12))
        })
    })
}
