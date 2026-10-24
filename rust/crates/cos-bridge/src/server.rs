//! The bridge's request pipeline, in the order of `handle()` in `bridge.ts`, so every refusal
//! has the same status and body.

use std::sync::Arc;

use bytes::Bytes;
use cos_http::{Body, BoxFuture, Service, full};
use cos_tools::{EpochMs, Phase};
use cos_types::bridge::{BRIDGE_PROTOCOL, BridgeHello, PairResponse, WakeHost};
use http::{HeaderValue, Method, Request, Response, StatusCode, Uri, header};
use hyper::body::Incoming;
use serde_json::{Value, json};

use crate::Shared;
use crate::gate::{Origin, Peer};
use crate::limits::{self, BodyRefusal, MAX_BODY_BYTES};
use crate::pairing::{Authorization, PairIntent, Paired, Stored};
use crate::presence::Line;
use crate::router::{Exchange, Reply, Routes};
use crate::wake;

const ALLOW_HEADERS: &str = "authorization, content-type, x-extension-version, x-extension-protocol, x-extension-build, x-extension-browser, x-extension-host";
const ALLOW_METHODS: &str = "GET, POST, OPTIONS";

pub(crate) struct Server {
    shared: Arc<Shared>,
    routes: Arc<Routes>,
}

impl Service for Server {
    fn serve(self: Arc<Self>, request: Request<Incoming>) -> BoxFuture<Response<Body>> {
        Box::pin(async move { self.handle(request).await })
    }
}

impl Server {
    pub(crate) fn new(shared: Arc<Shared>, routes: Arc<Routes>) -> Self {
        Self { shared, routes }
    }

    async fn handle(&self, request: Request<Incoming>) -> Response<Body> {
        let origin = Origin::of(request.headers());
        let (path, query) = target(request.uri());
        if is_upgrade(request.headers()) {
            return self.upgrade(request, &origin, &path, &query);
        }
        if request.method() == Method::OPTIONS {
            // A preflight always carries an Origin, so a missing one is not the extension.
            return match origin.echo() {
                Some(origin) => preflight(origin),
                None => respond(&Reply::error(403, "forbidden_origin"), None),
            };
        }
        if origin == Origin::Forbidden {
            return respond(&Reply::error(403, "forbidden_origin"), None);
        }
        let echo = origin.echo();
        let reply = self.answer(request, path, query).await;
        respond(&reply, echo)
    }

    async fn answer(
        &self,
        request: Request<Incoming>,
        path: String,
        query: Vec<(String, String)>,
    ) -> Reply {
        let shared = &self.shared;
        let received_at = EpochMs::now();
        let peer = Peer::of(request.headers());
        let shipped = shared.extension.shipped_build();
        for line in
            shared
                .presence
                .note_version(&peer, received_at, shipped.as_deref(), shared.app_version)
        {
            match line {
                Line::Info(text) => shared.logger.info(&text),
                Line::Warn(text) => shared.logger.warn(&text),
            }
        }
        shared.changed.notify_one();

        // Identification only: nothing about roots, permissions or state.
        if path == "/hello" {
            let stored = shared.pairing.stored().await;
            return Reply::ok(&BridgeHello {
                app: "chat-on-steroids".into(),
                version: shared.app_version.into(),
                bridge: BRIDGE_PROTOCOL,
                // Unknown, not incompatible, for a caller that states no protocol.
                compatible: peer.protocol.map(|_| peer.compatible()),
                paired: matches!(stored, Stored::Token(_)),
                disconnected: stored == Stored::Disconnected,
            });
        }
        if path == "/pair" && request.method() == Method::POST {
            return self.pair(request.into_body(), &peer, received_at).await;
        }

        // A deliberate revocation is named, so the extension latches instead of re-pairing.
        let bearer = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok());
        match shared.pairing.authorize(bearer).await {
            Authorization::Granted => {}
            Authorization::Disconnected => return Reply::error(401, "browser_disconnected"),
            Authorization::Refused => return Reply::error(401, "unauthorised"),
        }
        if !peer.compatible() {
            return self.incompatible();
        }
        // Only an authenticated extension is charged, so a stray local process cannot use up
        // the browser's budget.
        if shared.rate_exceeded() {
            return Reply::error(429, "rate_limited");
        }
        shared.presence.note_seen(&peer, received_at);
        shared.changed.notify_one();

        if shared.admission.phase() != Phase::Serving {
            return recovering();
        }
        let (parts, body) = request.into_parts();
        let Some(family) = self.routes.find(&parts.method, &path) else {
            // The extension drops an observation batch on a 404 and keeps it on a 5xx.
            if path == "/events" && parts.method == Method::POST {
                return recovering();
            }
            return Reply::error(404, "not_found");
        };
        let exchange = Exchange {
            method: parts.method,
            path,
            query,
            peer,
            received_at,
            body: Some(body),
        };
        match tokio::spawn(family.serve(exchange)).await {
            Ok(reply) => reply,
            Err(error) => {
                shared
                    .logger
                    .warn(&format!("bridge request failed: {error}"));
                Reply::internal()
            }
        }
    }

    async fn pair(&self, body: Incoming, peer: &Peer, received_at: EpochMs) -> Reply {
        let shared = &self.shared;
        if !peer.compatible() {
            return self.incompatible();
        }
        if shared.rate_exceeded() {
            return Reply::error(429, "rate_limited");
        }
        let body = match limits::read_json(body, MAX_BODY_BYTES).await {
            Ok(body) => body,
            Err(BodyRefusal::TooLarge) => return Reply::error(413, "body_too_large"),
            Err(_) => return Reply::error(400, "bad_request"),
        };
        let flag = |name: &str| {
            body.as_object().and_then(|fields| fields.get(name)) == Some(&Value::Bool(true))
        };
        let intent = PairIntent {
            reconnect: flag("reconnect"),
            reuse: flag("reuse"),
        };
        match shared.pairing.pair(intent).await {
            Paired::Token { token, reused } => {
                shared.presence.note_seen(peer, received_at);
                if !reused {
                    shared
                        .logger
                        .info("bridge: browser extension connected and provisioned");
                }
                shared.changed.notify_one();
                Reply::ok(&PairResponse { token })
            }
            Paired::Disconnected => Reply::error(409, "browser_disconnected"),
            Paired::StorageUnavailable(message) => Reply::json(
                503,
                &json!({ "error": "secure_storage_unavailable", "message": message }),
            ),
            Paired::Failed(error) => {
                shared
                    .logger
                    .warn(&format!("bridge request failed: {error}"));
                Reply::internal()
            }
        }
    }

    fn incompatible(&self) -> Reply {
        Reply::json(
            426,
            &json!({
                "error": "incompatible_extension",
                "bridge": BRIDGE_PROTOCOL,
                "version": self.shared.app_version,
            }),
        )
    }

    /// `/wake?host=cos|browser`. The `ws` server destroys a refused socket without an answer;
    /// this answers a status and closes, which a WebSocket client sees as the same failure.
    fn upgrade(
        &self,
        mut request: Request<Incoming>,
        origin: &Origin,
        path: &str,
        query: &[(String, String)],
    ) -> Response<Body> {
        let shared = &self.shared;
        let refuse = |status: u16| {
            let mut response = Response::new(full(Bytes::new()));
            *response.status_mut() =
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
            response
                .headers_mut()
                .insert(header::CONNECTION, HeaderValue::from_static("close"));
            response
        };
        if path != cos_types::bridge::WAKE_PATH {
            return refuse(404);
        }
        if *origin == Origin::Forbidden {
            return refuse(403);
        }
        if shared.admission.phase() == Phase::Draining {
            return refuse(503);
        }
        let headers = request.headers();
        let websocket = headers
            .get(header::UPGRADE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
        let version = headers
            .get(header::SEC_WEBSOCKET_VERSION)
            .map(HeaderValue::as_bytes)
            == Some(b"13");
        let key = headers
            .get(header::SEC_WEBSOCKET_KEY)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|key| key.len() == 24);
        let (true, true, true, Some(key)) =
            (request.method() == Method::GET, websocket, version, key)
        else {
            return refuse(400);
        };
        let accept = wake::accept_key(key);
        let host = query
            .iter()
            .find(|(name, _)| name == "host")
            .and_then(|(_, value)| match value.as_str() {
                "cos" => Some(WakeHost::Cos),
                "browser" => Some(WakeHost::Browser),
                _ => None,
            });
        let Some(admitted) = shared.hub.admit(host) else {
            return refuse(503);
        };
        let upgrading = hyper::upgrade::on(&mut request);
        let (hub, pairing) = (shared.hub.clone(), shared.pairing.clone());
        tokio::spawn(async move {
            match upgrading.await {
                Ok(upgraded) => wake::serve(hub, pairing, upgraded, admitted).await,
                Err(_) => hub.leave(admitted.id),
            }
        });
        let mut response = Response::new(full(Bytes::new()));
        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let headers = response.headers_mut();
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        if let Ok(accept) = HeaderValue::from_str(&accept) {
            headers.insert(header::SEC_WEBSOCKET_ACCEPT, accept);
        }
        response
    }
}

/// `503 bridge_recovering`: what the bridge answers while it restores or after its listener
/// was replaced. The extension retries it.
fn recovering() -> Reply {
    Reply::json(
        503,
        &json!({ "error": "bridge_recovering", "retryable": true }),
    )
}

fn preflight(origin: &str) -> Response<Body> {
    let mut response = Response::new(full(Bytes::new()));
    *response.status_mut() = StatusCode::NO_CONTENT;
    let headers = response.headers_mut();
    if let Ok(origin) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(ALLOW_HEADERS),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(ALLOW_METHODS),
    );
    // Chrome asks for this before it lets an extension reach a loopback address.
    headers.insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    response
}

/// `json(res, status, body, origin)`.
fn respond(reply: &Reply, origin: Option<&str>) -> Response<Body> {
    let mut response = Response::new(full(reply.body().clone()));
    *response.status_mut() =
        StatusCode::from_u16(reply.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from(reply.body().len()),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(origin) = origin.and_then(|origin| HeaderValue::from_str(origin).ok()) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(ALLOW_HEADERS),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(ALLOW_METHODS),
        );
    }
    response
}

/// `Connection: upgrade` with an `Upgrade` header: Node hands such a request to its `upgrade`
/// listener, never to the request handler.
fn is_upgrade(headers: &http::HeaderMap) -> bool {
    headers.contains_key(header::UPGRADE)
        && headers
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
}

/// `new URL(req.url, 'http://127.0.0.1')`: the path with dot segments resolved, and the
/// decoded query pairs.
fn target(uri: &Uri) -> (String, Vec<(String, String)>) {
    let raw = uri.path().replace('\\', "/");
    let mut segments: Vec<&str> = Vec::new();
    let mut trailing = false;
    for segment in raw.split('/').skip(1) {
        trailing = false;
        match segment.to_ascii_lowercase().as_str() {
            "." | "%2e" => trailing = true,
            ".." | ".%2e" | "%2e." | "%2e%2e" => {
                segments.pop();
                trailing = true;
            }
            _ => segments.push(segment),
        }
    }
    let mut path = format!("/{}", segments.join("/"));
    if trailing && !path.ends_with('/') {
        path.push('/');
    }
    let query = uri.query().map(form_pairs).unwrap_or_default();
    (path, query)
}

/// `application/x-www-form-urlencoded` pairs as `URLSearchParams` reads them.
fn form_pairs(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode(name), form_decode(value))
        })
        .collect()
}

fn form_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len()
                && hex_pair(bytes[index + 1], bytes[index + 2]).is_some() =>
            {
                out.extend(hex_pair(bytes[index + 1], bytes[index + 2]));
                index += 2;
            }
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_pair(high: u8, low: u8) -> Option<u8> {
    let digit = |byte: u8| char::from(byte).to_digit(16);
    Some(u8::try_from(digit(high)? * 16 + digit(low)?).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(uri: &str) -> String {
        target(&uri.parse().expect("a uri")).0
    }

    #[test]
    fn the_path_is_normalized_as_the_url_parser_does() {
        assert_eq!(path("/hello"), "/hello");
        assert_eq!(path("/x/../hello"), "/hello");
        assert_eq!(path("/../config.json"), "/config.json");
        assert_eq!(path("/hello/"), "/hello/");
        assert_eq!(path("/a/%2e%2E/hello"), "/hello");
        assert_eq!(path("http://127.0.0.1:8765/hello?x=1"), "/hello");
    }

    #[test]
    fn query_pairs_decode_like_url_search_params() {
        let (_, query) = target(
            &"/activity?conversationId=a%2Db&since=5&why=two+words&empty"
                .parse()
                .expect("a uri"),
        );
        assert_eq!(
            query,
            [
                ("conversationId".to_owned(), "a-b".to_owned()),
                ("since".to_owned(), "5".to_owned()),
                ("why".to_owned(), "two words".to_owned()),
                ("empty".to_owned(), String::new()),
            ]
        );
    }
}
