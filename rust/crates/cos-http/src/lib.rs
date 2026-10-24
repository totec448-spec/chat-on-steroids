//! The loopback HTTP listener every Core server runs on: the MCP endpoint (C1.1), the local
//! control API (C1.9) and later the browser bridge (E2.1).
//!
//! It owns only mechanism: bind `127.0.0.1:0`, serve HTTP/1.1 with a header deadline, and stop
//! in one of two ways. [`Drain::Graceful`] lets every accepted request finish, which ordinary
//! disconnects need so a mutation that already committed is never cut off. [`Drain::ForceAfter`]
//! bounds that wait for final shutdown. A connection closes by lingering ([`Lingering`]).
//! Routing, guards and bodies belong to each server. A server that answers `101 Switching
//! Protocols` takes the socket over through `hyper::upgrade::on`. From then on the drain no
//! longer waits for that socket, and that server closes it.

use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, ready};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Sleep;

/// How long a closing connection keeps reading what the client still sends.
const LINGER_TIME: Duration = Duration::from_secs(2);
/// How much a closing connection reads before it closes anyway.
const LINGER_BYTES: usize = 1024 * 1024;

/// Every response body: whole (JSON) or streamed (server-sent events).
pub type Body = BoxBody<Bytes, Infallible>;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// A whole response body.
pub fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).boxed()
}

/// One server's request handling. Every request gets a response; there is no error path,
/// because each server owns the exact status and body of its own refusals.
pub trait Service: Send + Sync + 'static {
    fn serve(self: Arc<Self>, request: Request<Incoming>) -> BoxFuture<Response<Body>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListenerOptions {
    /// How long a client may take to send its request headers (`headersTimeout`).
    pub header_read_timeout: Duration,
}

impl Default for ListenerOptions {
    fn default() -> Self {
        Self {
            header_read_timeout: Duration::from_secs(30),
        }
    }
}

/// How [`Listener::shutdown`] treats requests that were accepted before it was called.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drain {
    /// Wait for every accepted request to be answered.
    Graceful,
    /// Wait at most this long, then drop the connections still open.
    ForceAfter(Duration),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drained {
    Clean,
    /// The deadline passed with this many connections still serving.
    Forced {
        abandoned: usize,
    },
}

/// A bound, serving listener. New connections stop as soon as shutdown begins.
pub struct Listener {
    local_addr: SocketAddr,
    stop: oneshot::Sender<Drain>,
    task: JoinHandle<Drained>,
}

impl Listener {
    /// Binds an ephemeral loopback port and starts serving on the current Tokio runtime.
    pub async fn bind_loopback(
        service: Arc<dyn Service>,
        options: ListenerOptions,
    ) -> io::Result<Self> {
        Self::bind_loopback_on(0, service, options).await
    }

    /// Binds `127.0.0.1:port` (`0` lets the OS choose) and starts serving on the current Tokio
    /// runtime. The error is the bind's own, so a caller can tell a taken port from the rest.
    pub async fn bind_loopback_on(
        port: u16,
        service: Arc<dyn Service>,
        options: ListenerOptions,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
        let local_addr = listener.local_addr()?;
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(serve(listener, service, options, stopped));
        Ok(Self {
            local_addr,
            stop,
            task,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn shutdown(self, drain: Drain) -> Drained {
        // An accept loop that already ended has nothing left to drain.
        let _ = self.stop.send(drain);
        self.task.await.unwrap_or(Drained::Clean)
    }
}

async fn serve(
    listener: TcpListener,
    service: Arc<dyn Service>,
    options: ListenerOptions,
    mut stopped: oneshot::Receiver<Drain>,
) -> Drained {
    // hyper-util's `GracefulShutdown` cannot watch an upgradeable HTTP/1.1 connection, so each
    // connection watches this flag itself and finishes its current request once it is set.
    let (closing, _) = watch::channel(false);
    let mut connections = JoinSet::new();
    let drain = loop {
        tokio::select! {
            drain = &mut stopped => break drain.unwrap_or(Drain::ForceAfter(Duration::ZERO)),
            accepted = listener.accept() => {
                // A failed accept (for example a reset during the handshake) affects only
                // that client.
                let Ok((stream, _)) = accepted else { continue };
                let service = service.clone();
                let handler = service_fn(move |request| {
                    let service = service.clone();
                    async move { Ok::<_, Infallible>(service.serve(request).await) }
                });
                let connection = http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(options.header_read_timeout)
                    .serve_connection(TokioIo::new(Lingering::new(stream)), handler)
                    .with_upgrades();
                let mut closing = closing.subscribe();
                connections.spawn(async move {
                    let mut connection = std::pin::pin!(connection);
                    // A client that disconnects mid-request ends only its own connection.
                    tokio::select! {
                        _ = connection.as_mut() => return,
                        _ = closing.wait_for(|closing| *closing) => {}
                    }
                    connection.as_mut().graceful_shutdown();
                    let _ = connection.await;
                });
                while connections.try_join_next().is_some() {}
            }
        }
    };
    drop(listener);
    closing.send_replace(true);
    let settled = async { while connections.join_next().await.is_some() {} };
    match drain {
        Drain::Graceful => {
            settled.await;
            Drained::Clean
        }
        Drain::ForceAfter(limit) => {
            if tokio::time::timeout(limit, settled).await.is_ok() {
                return Drained::Clean;
            }
            while connections.try_join_next().is_some() {}
            let abandoned = connections.len();
            connections.abort_all();
            Drained::Forced { abandoned }
        }
    }
}

/// A connection that closes the way a client can rely on. An answer often closes the
/// connection before its request body was read (a refusal decided from the headers), and the
/// client may send that body a moment later. A socket that closes with unread bytes, or that
/// receives bytes after it closed, resets the connection, and on Windows the reset discards
/// the answer the client has not read yet. So closing first ends the write side, which tells
/// the client the answer is complete, then reads and drops what the client still sends until
/// it closes too, for at most [`LINGER_TIME`] and [`LINGER_BYTES`].
struct Lingering {
    stream: TcpStream,
    linger: Option<Linger>,
}

struct Linger {
    deadline: Pin<Box<Sleep>>,
    left: usize,
}

impl Lingering {
    fn new(stream: TcpStream) -> Self {
        Self {
            stream,
            linger: None,
        }
    }
}

impl AsyncRead for Lingering {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for Lingering {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.linger.is_none() {
            ready!(Pin::new(&mut this.stream).poll_shutdown(cx))?;
        }
        let linger = this.linger.get_or_insert_with(|| Linger {
            deadline: Box::pin(tokio::time::sleep(LINGER_TIME)),
            left: LINGER_BYTES,
        });
        let mut scratch = [0u8; 8 * 1024];
        loop {
            let mut buf = ReadBuf::new(&mut scratch);
            match Pin::new(&mut this.stream).poll_read(cx, &mut buf) {
                Poll::Ready(Ok(())) if (1..linger.left).contains(&buf.filled().len()) => {
                    linger.left -= buf.filled().len();
                }
                // The client closed, the connection broke, or the client sent too much.
                Poll::Ready(_) => return Poll::Ready(Ok(())),
                Poll::Pending => return linger.deadline.as_mut().poll(cx).map(Ok),
            }
        }
    }
}

#[derive(Debug)]
pub enum BodyError {
    /// The body is longer than the limit the caller set.
    TooLarge,
    /// The client stopped sending before the body ended.
    Incomplete,
}

/// Reads a whole request body, refusing it once it passes `limit` bytes.
pub async fn read_body(body: Incoming, limit: usize) -> Result<Bytes, BodyError> {
    match Limited::new(body, limit).collect().await {
        Ok(collected) => Ok(collected.to_bytes()),
        Err(error) if error.is::<http_body_util::LengthLimitError>() => Err(BodyError::TooLarge),
        Err(_) => Err(BodyError::Incomplete),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::sync::Notify;

    /// Answers after `release` is notified, so a test controls when a request finishes.
    struct Held {
        release: Arc<Notify>,
        arrived: Arc<Notify>,
    }

    impl Service for Held {
        fn serve(self: Arc<Self>, request: Request<Incoming>) -> BoxFuture<Response<Body>> {
            Box::pin(async move {
                let body = read_body(request.into_body(), 64).await;
                self.arrived.notify_one();
                self.release.notified().await;
                let text = if body.is_ok() { "done" } else { "too large" };
                Response::new(full(text))
            })
        }
    }

    async fn start() -> (Listener, Arc<Notify>, Arc<Notify>) {
        let release = Arc::new(Notify::new());
        let arrived = Arc::new(Notify::new());
        let service = Arc::new(Held {
            release: release.clone(),
            arrived: arrived.clone(),
        });
        let listener = Listener::bind_loopback(service, ListenerOptions::default())
            .await
            .expect("binds");
        (listener, release, arrived)
    }

    async fn send(addr: SocketAddr, body: &str) -> TcpStream {
        let mut stream = TcpStream::connect(addr).await.expect("connects");
        let request = format!(
            "POST / HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.expect("writes");
        stream
    }

    async fn read_all(mut stream: TcpStream) -> String {
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply).await.expect("reads");
        String::from_utf8(reply).expect("utf-8")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn graceful_shutdown_answers_the_request_already_accepted() {
        let (listener, release, arrived) = start().await;
        assert!(listener.local_addr().ip().is_loopback());
        let client = send(listener.local_addr(), "hello").await;
        arrived.notified().await;

        let shutdown = tokio::spawn(listener.shutdown(Drain::Graceful));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !shutdown.is_finished(),
            "shut down under an accepted request"
        );

        release.notify_one();
        let reply = read_all(client).await;
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.ends_with("done"), "{reply}");
        assert_eq!(shutdown.await.expect("joins"), Drained::Clean);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn forced_shutdown_abandons_a_request_that_never_finishes() {
        let (listener, _release, arrived) = start().await;
        let addr = listener.local_addr();
        let client = send(addr, "hello").await;
        arrived.notified().await;

        let drained = listener
            .shutdown(Drain::ForceAfter(Duration::from_millis(50)))
            .await;
        assert_eq!(drained, Drained::Forced { abandoned: 1 });
        assert_eq!(
            read_all(client).await,
            "",
            "an abandoned request got an answer"
        );
        assert!(
            TcpStream::connect(addr).await.is_err(),
            "still accepting after shutdown"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_body_over_the_limit_is_refused() {
        let (listener, release, arrived) = start().await;
        let client = send(listener.local_addr(), &"x".repeat(65)).await;
        arrived.notified().await;
        release.notify_one();
        assert!(read_all_until_body(client).await.ends_with("too large"));
        listener.shutdown(Drain::Graceful).await;
    }

    /// Refuses every request from its headers and closes, leaving the body unread.
    struct Refuses;

    impl Service for Refuses {
        fn serve(self: Arc<Self>, _request: Request<Incoming>) -> BoxFuture<Response<Body>> {
            Box::pin(async {
                let mut response = Response::new(full("refused"));
                response
                    .headers_mut()
                    .insert(http::header::CONNECTION, "close".parse().expect("a value"));
                response
            })
        }
    }

    /// Sends a head that announces `length` body bytes and reads the answer up to its end.
    async fn refused(length: usize) -> (Listener, TcpStream) {
        let listener = Listener::bind_loopback(Arc::new(Refuses), ListenerOptions::default())
            .await
            .expect("binds");
        let mut stream = TcpStream::connect(listener.local_addr())
            .await
            .expect("connects");
        let head =
            format!("POST / HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: {length}\r\n\r\n");
        stream.write_all(head.as_bytes()).await.expect("writes");
        let mut reply = Vec::new();
        while !reply.ends_with(b"refused") {
            let mut chunk = [0u8; 1024];
            let read = stream.read(&mut chunk).await.expect("reads");
            assert!(read > 0, "closed before its answer");
            reply.extend_from_slice(&chunk[..read]);
        }
        (listener, stream)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_body_sent_after_a_closing_answer_does_not_reset_the_connection() {
        let (listener, mut stream) = refused(5).await;
        stream.write_all(b"hello").await.expect("writes");
        let mut rest = [0u8; 16];
        assert_eq!(stream.read(&mut rest).await.expect("closed, not reset"), 0);
        drop(stream);
        assert_eq!(listener.shutdown(Drain::Graceful).await, Drained::Clean);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lingering_stops_after_a_bounded_time() {
        let (listener, stream) = refused(5).await;
        let started = std::time::Instant::now();
        assert_eq!(listener.shutdown(Drain::Graceful).await, Drained::Clean);
        let waited = started.elapsed();
        assert!(
            waited >= LINGER_TIME - Duration::from_millis(100) && waited < LINGER_TIME * 3,
            "{waited:?}"
        );
        drop(stream);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lingering_stops_after_a_bounded_read() {
        let (listener, mut stream) = refused(usize::MAX >> 1).await;
        let chunk = vec![b'x'; 64 * 1024];
        let mut sent = 0;
        while stream.write_all(&chunk).await.is_ok() {
            sent += chunk.len();
            assert!(
                sent < 256 * LINGER_BYTES,
                "read {sent} bytes and still reading"
            );
        }
        assert!(sent >= LINGER_BYTES, "stopped reading after {sent} bytes");
        listener.shutdown(Drain::Graceful).await;
    }

    /// Reads one response on a kept-alive connection: headers plus `content-length` bytes.
    async fn read_all_until_body(mut stream: TcpStream) -> String {
        let mut reply = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let read = stream.read(&mut chunk).await.expect("reads");
            reply.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&reply).into_owned();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                if body.len() >= length {
                    return text;
                }
            }
            if read == 0 {
                return text;
            }
        }
    }
}
