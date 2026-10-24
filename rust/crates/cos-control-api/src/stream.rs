//! `GET /v1/sessions/{id}/events/stream`: a chat's events as Server-Sent Events
//! (`control-stream.ts`).
//!
//! It is the paged read, repeated. Every frame is a row `GET …/events?from=` would return, read
//! through the same owner under the same limits. The store's append notice says when to read
//! again; a slow tick covers a notice that was missed. A frame's `id` is the event's `seq`, so
//! `Last-Event-ID` resumes after the last one seen. A stream ends after a fixed life with an
//! `end` frame that says why, and a client that does not read is closed rather than buffered for.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::task::{Context, Poll};

use bytes::Bytes;
use cos_sessions::EventPosition;
use cos_types::control_api::{ControlApiEvents, EventStreamFrame};
use cos_types::ids::SessionId;
use hyper::Response;
use hyper::body::Frame;
use hyper::header::{CACHE_CONTROL, CONNECTION, CONTENT_TYPE, HeaderValue};
use hyper::http::request::Parts;
use regex::Regex;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{OwnedSemaphorePermit, mpsc};

use crate::limits::Places;
use crate::query::parse_query;
use crate::reads::{STREAM, STREAM_PAGE, admitted, events_page, kinds};
use crate::reply::Refusal;
use crate::server::{Answer, Server};
use crate::sessions::Sessions;

/// What may wait unread for a client that reads slowly.
const MAX_BUFFERED_BYTES: usize = 1024 * 1024;

static STREAM_ROUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/v1/sessions/([0-9a-z-]{8,64})/events/stream$")
        .unwrap_or_else(|error| panic!("{error}"))
});

/// The session a stream route names, or `None` for any other route.
pub(crate) fn stream_session(route: &str) -> Option<SessionId> {
    let captures = STREAM_ROUTE.captures(route)?;
    SessionId::parse(&captures[1]).ok()
}

/// Where a stream starts. `Last-Event-ID` is the `seq` of the last event a client saw, so a
/// reconnect continues after it; it wins over `from`, which is still in the address the client
/// first opened.
pub(crate) fn start(
    params: &[(String, String)],
    last_event_ids: &[&[u8]],
) -> Result<(u64, Option<Vec<String>>), Refusal> {
    let query = parse_query(params, STREAM)?;
    let kinds = kinds(&query);
    // Node joins a repeated header with ", ", which is never a valid id.
    let last: &[u8] = match last_event_ids {
        [] => return Ok((query.integer("from").unwrap_or(0), kinds)),
        [one] => one,
        _ => b",",
    };
    let valid = (1..=8).contains(&last.len()) && last.iter().all(u8::is_ascii_digit);
    let seen: u64 = valid
        .then(|| std::str::from_utf8(last).ok()?.parse().ok())
        .flatten()
        .ok_or_else(|| Refusal::InvalidQuery("Last-Event-ID is not valid".into()))?;
    Ok((seen + 1, kinds))
}

/// The response body: frames handed over by the stream task, counted until hyper takes them.
struct EventBody {
    frames: mpsc::UnboundedReceiver<Bytes>,
    buffered: Arc<AtomicUsize>,
}

impl hyper::body::Body for EventBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        match self.frames.poll_recv(cx) {
            Poll::Ready(Some(bytes)) => {
                self.buffered.fetch_sub(bytes.len(), Ordering::Relaxed);
                Poll::Ready(Some(Ok(Frame::data(bytes))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Why a stream ended. Only the ones the app ends get an `end` frame.
enum End {
    Client,
    Reason(&'static str),
}

struct Stream {
    sessions: Arc<dyn Sessions>,
    session: SessionId,
    kinds: Option<Vec<String>>,
    from: u64,
    frames: mpsc::UnboundedSender<Bytes>,
    buffered: Arc<AtomicUsize>,
}

impl Stream {
    fn write(&self, text: String) -> Result<(), End> {
        let bytes = Bytes::from(text);
        let length = bytes.len();
        self.buffered.fetch_add(length, Ordering::Relaxed);
        self.frames.send(bytes).map_err(|_| End::Client)
    }

    fn send(&mut self, page: ControlApiEvents) -> Result<(), End> {
        for event in page.events {
            self.write(EventStreamFrame::Event(Box::new(event)).to_text())?;
        }
        self.from = self.from.max(page.next_from);
        if self.buffered.load(Ordering::Relaxed) > MAX_BUFFERED_BYTES {
            return Err(End::Reason("slow_consumer"));
        }
        Ok(())
    }

    /// A read in its own task, so a store that fails ends the stream with `error`.
    async fn read(&self, server: &Server) -> Result<ControlApiEvents, Refusal> {
        let read = page(
            server.heavy.clone(),
            self.sessions.clone(),
            self.session.clone(),
            self.from,
            self.kinds.clone(),
        );
        tokio::spawn(read).await.unwrap_or(Err(Refusal::Internal))
    }

    /// Reads until the stream has caught up. Too many reads at once is the app being busy: the
    /// next notice or tick reads again.
    async fn catch_up(&mut self, server: &Server) -> Result<(), End> {
        loop {
            let before = self.from;
            let page = match self.read(server).await {
                Ok(page) => page,
                Err(Refusal::Busy(_)) => return Ok(()),
                Err(Refusal::SessionNotFound) => return Err(End::Reason("session_gone")),
                Err(_) => return Err(End::Reason("error")),
            };
            let full = page.events.len() >= STREAM_PAGE as usize;
            self.send(page)?;
            if !full || self.from == before {
                return Ok(());
            }
        }
    }

    async fn follow(mut self, server: Arc<Server>, first_full: bool, place: OwnedSemaphorePermit) {
        let _place = place;
        let end = match self.run(&server, first_full).await {
            Ok(never) => match never {},
            Err(end) => end,
        };
        self.end(end);
    }

    /// Writes the `end` frame for a stream the app ended. A client that left gets nothing.
    fn end(&self, end: End) {
        if let End::Reason(reason) = end {
            let _ = self.write(EventStreamFrame::End(reason.to_owned()).to_text());
        }
    }

    async fn run(&mut self, server: &Arc<Server>, first_full: bool) -> Result<Infallible, End> {
        let timing = server.timing;
        let mut stopping = server.stopping.clone();
        let mut appended = self.sessions.appended();
        let life = tokio::time::sleep(timing.max_life);
        tokio::pin!(life);
        let mut heartbeat = tokio::time::interval_at(
            tokio::time::Instant::now() + timing.heartbeat,
            timing.heartbeat,
        );
        let mut poll =
            tokio::time::interval_at(tokio::time::Instant::now() + timing.poll, timing.poll);
        if first_full {
            self.catch_up(server).await?;
        }
        loop {
            if *stopping.borrow() {
                return Err(End::Reason("stopped"));
            }
            tokio::select! {
                _ = stopping.changed() => return Err(End::Reason("stopped")),
                () = self.frames.closed() => return Err(End::Client),
                () = &mut life => return Err(End::Reason("max_duration")),
                _ = heartbeat.tick() => self.write(EventStreamFrame::KeepAlive.to_text())?,
                _ = poll.tick() => self.catch_up(server).await?,
                notice = appended.recv() => match notice {
                    Ok(appended) if appended.session != self.session => {}
                    Ok(_) | Err(RecvError::Lagged(_)) => self.catch_up(server).await?,
                    // The store is gone; the slow tick still reads.
                    Err(RecvError::Closed) => appended = self.sessions.appended(),
                },
            }
        }
    }
}

/// One read for a stream: the same rows, projection and limits as `GET …/events?from=`.
async fn page(
    heavy: Places,
    sessions: Arc<dyn Sessions>,
    session: SessionId,
    from: u64,
    kinds: Option<Vec<String>>,
) -> Result<ControlApiEvents, Refusal> {
    let _place = heavy.take()?;
    let position = EventPosition::From(from);
    events_page(&*sessions, &session, position, STREAM_PAGE, kinds).await
}

/// Answers a stream request. Everything that can refuse it does so before the first byte, as
/// JSON like any other read; the first read runs under the read deadline.
pub(crate) async fn open(
    server: &Arc<Server>,
    parts: &Parts,
    session: SessionId,
    target: &crate::query::Target,
) -> Answer {
    let last_event_ids: Vec<&[u8]> = parts
        .headers
        .get_all("last-event-id")
        .iter()
        .map(|value| value.as_bytes())
        .collect();
    let (from, kinds) = match start(&target.params, &last_event_ids) {
        Ok(start) => start,
        Err(refusal) => return refusal.into(),
    };
    // The place is taken before the first read, so opens that arrive together cannot exceed it.
    let place = match server.streams.take() {
        Ok(place) => place,
        Err(refusal) => return refusal.into(),
    };
    let (frames, receiver) = mpsc::unbounded_channel();
    let buffered = Arc::new(AtomicUsize::new(0));
    let mut stream = Stream {
        sessions: server.shared.sessions.clone(),
        session,
        kinds,
        from,
        frames,
        buffered: buffered.clone(),
    };
    let admission = server.shared.admission.clone();
    let read = page(
        server.heavy.clone(),
        stream.sessions.clone(),
        stream.session.clone(),
        from,
        stream.kinds.clone(),
    );
    let first = server
        .reads
        .run(async move {
            admitted(&admission).await?;
            read.await
        })
        .await;
    let first = match first {
        Ok(page) => page,
        Err(refusal) => return refusal.into(),
    };
    let first_full = first.events.len() >= STREAM_PAGE as usize;
    // Sent at once: a quiet chat would otherwise look like a dead connection.
    let opened = stream
        .write(EventStreamFrame::Open.to_text())
        .and_then(|()| stream.send(first));
    let follower = server.clone();
    tokio::spawn(async move {
        match opened {
            Ok(()) => stream.follow(follower, first_full, place).await,
            Err(end) => stream.end(end),
        }
    });
    let body = EventBody {
        frames: receiver,
        buffered,
    };
    let mut response = Response::new(cos_http::Body::new(body));
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // Not reused after its `end` frame, so a stopping listener does not wait on it.
    headers.insert(CONNECTION, HeaderValue::from_static("close"));
    Answer::Stream(response)
}
