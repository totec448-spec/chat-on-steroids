//! Tests drive the endpoint over real loopback TCP with a raw HTTP/1.1 client, so status,
//! headers and body bytes are seen exactly as a client sees them. The kernel is a fake behind
//! [`Dispatch`] that answers from the golden corpus or a script.

mod corpus;
mod endpoint;
mod modern;
mod oracle;

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use cos_store::Logger;
use cos_tools::{BoxFuture, Content, Inbound, ServerInfo, SurfaceId, ToolResult, UnknownTool};
use cos_types::config::Config;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Notify, watch};

use crate::McpEndpoint;
use crate::port::Dispatch;

/// The headers the golden recorder keeps, in its order.
pub(crate) const KEPT_HEADERS: [&str; 8] = [
    "content-type",
    "cache-control",
    "allow",
    "retry-after",
    "connection",
    "mcp-session-id",
    "www-authenticate",
    "x-accel-buffering",
];

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A kernel stand-in: server info and tool lists per surface, scripted call outcomes.
#[derive(Default)]
pub(crate) struct Fake {
    pub(crate) info: Mutex<HashMap<SurfaceId, ServerInfo>>,
    pub(crate) tools: Mutex<HashMap<SurfaceId, Vec<Value>>>,
    pub(crate) script: Mutex<VecDeque<Result<ToolResult, UnknownTool>>>,
    pub(crate) calls: Mutex<Vec<(SurfaceId, String, Value, Inbound)>>,
    /// While set, calls wait for it before answering.
    pub(crate) hold: Mutex<Option<Arc<Notify>>>,
    /// Notified when a call reaches the fake.
    pub(crate) arrived: Notify,
    pub(crate) generations: AtomicUsize,
    pub(crate) requests: AtomicUsize,
    pub(crate) open_requests: Arc<AtomicUsize>,
    pub(crate) finished_calls: AtomicUsize,
}

pub(crate) struct OpenRequest(Arc<AtomicUsize>);

impl Drop for OpenRequest {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Dispatch for Fake {
    type Request = OpenRequest;

    fn begin_generation(&self) {
        self.generations.fetch_add(1, Ordering::SeqCst);
    }

    fn begin_request(self: &Arc<Self>, _surface: SurfaceId) -> OpenRequest {
        self.requests.fetch_add(1, Ordering::SeqCst);
        self.open_requests.fetch_add(1, Ordering::SeqCst);
        OpenRequest(self.open_requests.clone())
    }

    fn server_info(&self, surface: SurfaceId) -> ServerInfo {
        lock(&self.info)
            .get(&surface)
            .cloned()
            .unwrap_or(ServerInfo {
                name: "fake",
                version: "0",
                instructions: String::new(),
            })
    }

    fn list(&self, surface: SurfaceId) -> Vec<Value> {
        lock(&self.tools).get(&surface).cloned().unwrap_or_default()
    }

    fn call(
        self: &Arc<Self>,
        surface: SurfaceId,
        tool: String,
        arguments: Value,
        inbound: Inbound,
    ) -> BoxFuture<'static, Result<ToolResult, UnknownTool>> {
        let fake = self.clone();
        Box::pin(async move {
            lock(&fake.calls).push((surface, tool.clone(), arguments, inbound));
            fake.arrived.notify_one();
            assert_ne!(tool, "panic", "the fake kernel panics on request");
            let hold = lock(&fake.hold).clone();
            if let Some(hold) = hold {
                hold.notified().await;
            }
            let outcome = lock(&fake.script)
                .pop_front()
                .unwrap_or(Err(UnknownTool(tool)));
            fake.finished_calls.fetch_add(1, Ordering::SeqCst);
            outcome
        })
    }
}

/// The value a recorded `CallToolResult` deserializes to.
pub(crate) fn tool_result(value: &Value) -> ToolResult {
    let content = value["content"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| match item["type"].as_str() {
                    Some("text") => Content::Text {
                        text: item["text"].as_str().unwrap_or_default().to_owned(),
                    },
                    Some("image") => Content::Image {
                        data: item["data"].as_str().unwrap_or_default().to_owned(),
                        mime_type: item["mimeType"].as_str().unwrap_or_default().to_owned(),
                    },
                    other => panic!("content type {other:?} has no ToolResult form"),
                })
                .collect()
        })
        .unwrap_or_default();
    ToolResult {
        content,
        structured_content: value.get("structuredContent").cloned(),
        is_error: value
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// `&'static str` for a server name or version read from a fixture.
pub(crate) fn leak(text: &str) -> &'static str {
    Box::leak(text.to_owned().into_boxed_str())
}

pub(crate) struct Started {
    pub(crate) endpoint: McpEndpoint,
    pub(crate) logger: Logger,
    pub(crate) config: watch::Sender<Arc<Config>>,
}

pub(crate) async fn start(fake: &Arc<Fake>) -> Started {
    let logger = Logger::with_clock(|| 0, false);
    let config = cos_store::config::recovery_config();
    let (sender, receiver) = watch::channel(Arc::new(config));
    let endpoint = McpEndpoint::start_with(
        fake.clone(),
        receiver,
        logger.clone(),
        Some("setup-profile-1".to_owned()),
    )
    .await
    .expect("the endpoint binds");
    Started {
        endpoint,
        logger,
        config: sender,
    }
}

pub(crate) fn path_of(url: &str) -> String {
    let rest = url.strip_prefix("http://").unwrap_or(url);
    rest.find('/')
        .map_or(String::new(), |at| rest[at..].to_owned())
}

pub(crate) enum Payload {
    None,
    /// Sent with a `content-length` unless the request names one.
    Bytes(Vec<u8>),
    /// Sent as one chunk with `transfer-encoding: chunked`.
    Chunked(Vec<u8>),
}

pub(crate) struct Req {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) payload: Payload,
}

impl Req {
    pub(crate) fn new(method: &str, path: &str) -> Self {
        Self {
            method: method.to_owned(),
            path: path.to_owned(),
            headers: Vec::new(),
            payload: Payload::None,
        }
    }

    pub(crate) fn header(mut self, name: &str, value: &str) -> Self {
        self.headers
            .push((name.to_ascii_lowercase(), value.to_owned()));
        self
    }

    pub(crate) fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.payload = Payload::Bytes(body.into());
        self
    }

    pub(crate) fn mcp(path: &str, port: u16, body: &Value) -> Self {
        Self::new("POST", path)
            .header("host", &format!("127.0.0.1:{port}"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(body.to_string())
    }

    fn has(&self, name: &str) -> bool {
        self.headers.iter().any(|(header, _)| header == name)
    }
}

#[derive(Debug)]
pub(crate) struct Reply {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

impl Reply {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.as_str())
    }

    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub(crate) fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::String(self.text()))
    }

    /// The recorder's `keptHeaders`, as an ordered JSON object.
    pub(crate) fn kept_headers(&self) -> Value {
        let mut kept = serde_json::Map::new();
        for name in KEPT_HEADERS {
            if let Some(value) = self.header(name) {
                kept.insert(name.to_owned(), Value::String(value.to_owned()));
            }
        }
        Value::Object(kept)
    }

    /// The recorder's `sseFrames`: each frame's fields, with `data` parsed as JSON.
    pub(crate) fn frames(&self) -> Vec<Value> {
        let text = self.text();
        text.split("\n\n")
            .filter(|block| !block.is_empty())
            .map(|block| {
                let mut frame = serde_json::Map::new();
                for line in block.split('\n') {
                    let (field, value) = line.split_once(':').unwrap_or((line, ""));
                    let value = value.strip_prefix(' ').unwrap_or(value);
                    let value = if field == "data" {
                        serde_json::from_str(value).unwrap_or(Value::String(value.to_owned()))
                    } else {
                        Value::String(value.to_owned())
                    };
                    frame.insert(field.to_owned(), value);
                }
                Value::Object(frame)
            })
            .collect()
    }

    /// The JSON-RPC messages of an event stream, in order.
    pub(crate) fn messages(&self) -> Vec<Value> {
        self.frames()
            .into_iter()
            .filter_map(|frame| frame.get("data").cloned())
            .collect()
    }
}

/// One client connection; requests on it reuse the socket while the server keeps it alive.
pub(crate) struct Conn {
    stream: TcpStream,
    buffer: Vec<u8>,
}

impl Conn {
    pub(crate) async fn open(addr: SocketAddr) -> Self {
        Self {
            stream: TcpStream::connect(addr).await.expect("connects"),
            buffer: Vec::new(),
        }
    }

    /// `None` when the server closed the connection without answering.
    pub(crate) async fn send(&mut self, request: &Req) -> Option<Reply> {
        self.write(request).await;
        self.read_reply(request.method == "HEAD").await
    }

    pub(crate) async fn write(&mut self, request: &Req) {
        let (mut bytes, body) = encode(request);
        bytes.extend_from_slice(&body);
        // A server that answers before reading the whole body may close under the write; its
        // answer is still the result.
        let _ = self.stream.write_all(&bytes).await;
    }

    /// Sends the head, reads the answer, and only then sends the body: a client whose body is
    /// still in flight when the server answers.
    pub(crate) async fn send_body_after_answer(&mut self, request: &Req) -> Option<Reply> {
        let (head, body) = encode(request);
        self.stream.write_all(&head).await.expect("writes");
        let reply = self.read_reply(request.method == "HEAD").await;
        let _ = self.stream.write_all(&body).await;
        reply
    }

    pub(crate) async fn write_raw(&mut self, bytes: &[u8]) {
        self.stream.write_all(bytes).await.expect("writes");
    }

    /// The head of a chunked event stream that stays open, and its first SSE frame, which
    /// the server writes as one chunk.
    pub(crate) async fn first_frame(&mut self, request: &Req) -> Option<Reply> {
        self.write(request).await;
        let (status, headers) = self.read_head().await?;
        let size_end = loop {
            if let Some(at) = find(&self.buffer, b"\r\n") {
                break at;
            }
            if !self.fill().await {
                return None;
            }
        };
        let size_line = String::from_utf8_lossy(&self.buffer[..size_end]).into_owned();
        let size = usize::from_str_radix(size_line.trim(), 16).ok()?;
        self.buffer.drain(..size_end + 2);
        let body = self.read_exact(size).await?;
        self.read_exact(2).await?;
        Some(Reply {
            status,
            headers,
            body,
        })
    }

    async fn read_head(&mut self) -> Option<(u16, Vec<(String, String)>)> {
        let head_end = loop {
            if let Some(at) = find(&self.buffer, b"\r\n\r\n") {
                break at;
            }
            if !self.fill().await {
                return None;
            }
        };
        let head = String::from_utf8_lossy(&self.buffer[..head_end]).into_owned();
        self.buffer.drain(..head_end + 4);
        let mut lines = head.split("\r\n");
        let status = lines.next()?.split(' ').nth(1)?.parse::<u16>().ok()?;
        let headers: Vec<(String, String)> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        Some((status, headers))
    }

    pub(crate) async fn read_reply(&mut self, head_only: bool) -> Option<Reply> {
        let (status, headers) = self.read_head().await?;
        let header = |name: &str| {
            headers
                .iter()
                .find(|(header, _)| header == name)
                .map(|(_, value)| value.clone())
        };
        let body = if head_only || status == 204 || status == 304 {
            Vec::new()
        } else if header("transfer-encoding").is_some_and(|value| value.contains("chunked")) {
            self.read_chunked().await?
        } else if let Some(length) = header("content-length").and_then(|v| v.parse::<usize>().ok())
        {
            self.read_exact(length).await?
        } else {
            while self.fill().await {}
            std::mem::take(&mut self.buffer)
        };
        Some(Reply {
            status,
            headers,
            body,
        })
    }

    /// Whether the server closed this connection, waiting briefly for it to do so.
    pub(crate) async fn closed(&mut self) -> bool {
        let mut byte = [0u8; 1];
        matches!(
            tokio::time::timeout(
                std::time::Duration::from_millis(500),
                self.stream.read(&mut byte)
            )
            .await,
            Ok(Ok(0) | Err(_))
        )
    }

    /// Reads until the server ends the connection: `Ok` when it closed it, the error when it
    /// reset it.
    pub(crate) async fn ended(&mut self) -> std::io::Result<()> {
        assert!(self.buffer.is_empty(), "sent more after its answer");
        let mut chunk = [0u8; 64];
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.stream.read(&mut chunk),
        )
        .await
        .expect("ends within 10 s")?;
        assert_eq!(read, 0, "sent more after its answer");
        Ok(())
    }

    async fn fill(&mut self) -> bool {
        let mut chunk = [0u8; 16 * 1024];
        match self.stream.read(&mut chunk).await {
            Ok(0) | Err(_) => false,
            Ok(read) => {
                self.buffer.extend_from_slice(&chunk[..read]);
                true
            }
        }
    }

    async fn read_exact(&mut self, length: usize) -> Option<Vec<u8>> {
        while self.buffer.len() < length {
            if !self.fill().await {
                return None;
            }
        }
        Some(self.buffer.drain(..length).collect())
    }

    async fn read_chunked(&mut self) -> Option<Vec<u8>> {
        let mut body = Vec::new();
        loop {
            let line_end = loop {
                if let Some(at) = find(&self.buffer, b"\r\n") {
                    break at;
                }
                if !self.fill().await {
                    return None;
                }
            };
            let size_line = String::from_utf8_lossy(&self.buffer[..line_end]).into_owned();
            self.buffer.drain(..line_end + 2);
            let size = usize::from_str_radix(size_line.split(';').next()?.trim(), 16).ok()?;
            if size == 0 {
                self.read_exact(2).await?;
                return Some(body);
            }
            body.extend(self.read_exact(size).await?);
            self.read_exact(2).await?;
        }
    }
}

/// A request's head and body bytes, as [`Conn`] writes them.
fn encode(request: &Req) -> (Vec<u8>, Vec<u8>) {
    let mut head = format!("{} {} HTTP/1.1\r\n", request.method, request.path);
    for (name, value) in &request.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    let body = match &request.payload {
        Payload::None => Vec::new(),
        Payload::Bytes(bytes) => {
            if !request.has("content-length") && !request.has("transfer-encoding") {
                head.push_str(&format!("content-length: {}\r\n", bytes.len()));
            }
            bytes.clone()
        }
        Payload::Chunked(bytes) => {
            if !request.has("transfer-encoding") {
                head.push_str("transfer-encoding: chunked\r\n");
            }
            let mut chunked = format!("{:x}\r\n", bytes.len()).into_bytes();
            chunked.extend_from_slice(bytes);
            chunked.extend_from_slice(b"\r\n0\r\n\r\n");
            chunked
        }
    };
    head.push_str("\r\n");
    (head.into_bytes(), body)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Sends one request on a new connection.
pub(crate) async fn send(addr: SocketAddr, request: &Req) -> Reply {
    Conn::open(addr)
        .await
        .send(request)
        .await
        .expect("the server answers")
}

/// JSON compared with key order, the way `diff.mjs --strict-order` and ChatGPT see it.
/// `Value` equality ignores the order of object keys, so the bytes are compared.
pub(crate) fn same(left: &Value, right: &Value) -> bool {
    serde_json::to_vec(left).ok() == serde_json::to_vec(right).ok()
}
