//! Every answer the API writes: a JSON body with its status, or a refusal from the recorded set.

use bytes::Bytes;
use cos_types::control_api::{ControlApiError, ControlApiInput};
use hyper::Response;
use hyper::header::{
    ALLOW, CACHE_CONTROL, CONNECTION, CONTENT_TYPE, HeaderName, HeaderValue, RETRY_AFTER,
};
use serde_json::Value;

/// Every refusal the API answers with. Each one has exactly one status, code and detail, so the
/// wire words live in [`Refusal::parts`] and nowhere else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    OriginForbidden,
    HostForbidden,
    Unauthorized,
    InvalidTarget,
    /// The same answer for every action route while actions are off; nothing was read.
    ActionsDisabled,
    RateLimited,
    ActionRateLimited,
    MethodNotAllowed(&'static str),
    BodyNotAllowed,
    NotFound,
    InvalidQuery(String),
    SessionNotFound,
    InputNotFound,
    SessionNotControllable,
    NoChat,
    /// More work is waiting on the app than the API lets queue behind it.
    Busy(&'static str),
    Timeout(&'static str),
    ShuttingDown,
    InvalidFraming,
    BodyTooLarge,
    UnsupportedMediaType,
    BodyTimeout,
    InvalidJson,
    InvalidBody(String),
    /// What the outbox or the cancel rules refuse: a word, sometimes a detail.
    Conflict(&'static str, Option<&'static str>),
    /// The outbox holds as much as it may.
    QueueFull,
    /// An action needs an owner this build does not have yet (local projects).
    Unavailable(&'static str),
    /// The owner behind a route failed. The answer names nothing about why.
    Internal,
}

impl Refusal {
    fn parts(&self) -> (u16, &'static str, Option<&str>) {
        match self {
            Self::OriginForbidden => (403, "origin_forbidden", None),
            Self::HostForbidden => (403, "host_forbidden", None),
            Self::Unauthorized => (401, "unauthorized", None),
            Self::InvalidTarget => (400, "invalid_target", None),
            Self::ActionsDisabled => (403, "actions_disabled", None),
            Self::RateLimited | Self::ActionRateLimited => (429, "rate_limited", None),
            Self::MethodNotAllowed(_) => (405, "method_not_allowed", None),
            Self::BodyNotAllowed => (413, "body_not_allowed", None),
            Self::NotFound => (404, "not_found", None),
            Self::InvalidQuery(detail) => (400, "invalid_query", Some(detail)),
            Self::SessionNotFound => (404, "session_not_found", None),
            Self::InputNotFound => (404, "input_not_found", None),
            Self::SessionNotControllable => (409, "session_not_controllable", None),
            Self::NoChat => (
                409,
                "no_chat",
                Some("this session has no ChatGPT chat to send to"),
            ),
            Self::Busy(detail) => (503, "busy", Some(detail)),
            Self::Timeout(detail) => (504, "timeout", Some(detail)),
            Self::ShuttingDown => (503, "shutting_down", None),
            Self::InvalidFraming => (400, "invalid_framing", None),
            Self::BodyTooLarge => (413, "body_too_large", None),
            Self::UnsupportedMediaType => (415, "unsupported_media_type", None),
            Self::BodyTimeout => (408, "body_timeout", None),
            Self::InvalidJson => (400, "invalid_json", None),
            Self::InvalidBody(detail) => (400, "invalid_body", Some(detail)),
            Self::Conflict(code, detail) => (409, code, *detail),
            Self::QueueFull => (503, "queue_full", None),
            Self::Unavailable(detail) => (503, "unavailable", Some(detail)),
            Self::Internal => (500, "internal_error", None),
        }
    }

    /// Refusals decided before the body was read end the connection, so an unread body cannot
    /// be taken for the next request.
    fn closes(&self) -> bool {
        matches!(
            self,
            Self::ActionsDisabled
                | Self::InvalidFraming
                | Self::BodyTooLarge
                | Self::UnsupportedMediaType
                | Self::BodyTimeout
        )
    }
}

/// One finished answer, before it becomes an HTTP response.
#[derive(Debug)]
pub(crate) struct Reply {
    status: u16,
    body: Bytes,
    headers: Vec<(HeaderName, &'static str)>,
    close: bool,
}

impl Reply {
    pub(crate) fn json(status: u16, body: &Value) -> Self {
        Self {
            status,
            body: Bytes::from(body.to_string()),
            headers: Vec::new(),
            close: false,
        }
    }

    pub(crate) fn ok(body: &Value) -> Self {
        Self::json(200, body)
    }

    pub(crate) fn refusal(refusal: &Refusal) -> Self {
        Self::refusal_with_input(refusal, None)
    }

    /// A refused cancel also carries the row it refused.
    pub(crate) fn refusal_with_input(refusal: &Refusal, input: Option<ControlApiInput>) -> Self {
        let (status, code, detail) = refusal.parts();
        let body = ControlApiError {
            error: code.to_owned(),
            detail: detail.map(str::to_owned),
            input,
        };
        let body = serde_json::to_value(&body).unwrap_or(Value::Null);
        let mut reply = Self::json(status, &body);
        match refusal {
            Refusal::MethodNotAllowed(allow) => reply.headers.push((ALLOW, allow)),
            Refusal::ActionRateLimited => reply.headers.push((RETRY_AFTER, "60")),
            _ => {}
        }
        reply.close = refusal.closes();
        reply
    }

    pub(crate) fn closing(mut self) -> Self {
        self.close = true;
        self
    }

    pub(crate) fn closes(&self) -> bool {
        self.close
    }

    pub(crate) fn into_response(self) -> Response<cos_http::Body> {
        let mut response = Response::new(cos_http::full(self.body));
        *response.status_mut() =
            hyper::StatusCode::from_u16(self.status).unwrap_or(hyper::StatusCode::OK);
        let headers = response.headers_mut();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        for (name, value) in self.headers {
            headers.insert(name, HeaderValue::from_static(value));
        }
        let connection = if self.close { "close" } else { "keep-alive" };
        headers.insert(CONNECTION, HeaderValue::from_static(connection));
        response
    }
}

impl Refusal {
    pub(crate) fn reply(&self) -> Reply {
        Reply::refusal(self)
    }
}
