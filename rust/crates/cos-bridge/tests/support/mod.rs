//! A bridge on a scratch profile, an HTTP/1.1 client and a WebSocket client, all over real
//! loopback sockets.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cos_bridge::{Bridge, BridgeDeps, BridgeTask, ExtensionFolder, Routes};
use cos_secrets::SecretStore;
use cos_store::config::first_launch_config;
use cos_store::{BridgePortOverride, Logger, Platform};
use cos_tools::{Admission, AdmissionGate, Phase};
use cos_types::app_state::BridgeStatus;
use cos_types::bridge::BRIDGE_PROTOCOL;
use cos_types::config::{BrowserBridgePort, Config};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::watch;

pub const EXTENSION_ORIGIN: &str = "chrome-extension://fixture";

pub fn scratch(prefix: &str) -> PathBuf {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).expect("random bytes");
    let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("{prefix}-{name}"));
    std::fs::create_dir_all(&dir).expect("a scratch folder");
    dir
}

pub struct Options {
    pub ports_override: Option<BridgePortOverride>,
    pub port: BrowserBridgePort,
    pub serving: bool,
    pub routes: Option<Box<dyn FnOnce(Routes) -> Routes>>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            ports_override: BridgePortOverride::parse("0"),
            port: BrowserBridgePort::Auto,
            serving: true,
            routes: None,
        }
    }
}

pub struct Fixture {
    pub dir: PathBuf,
    pub bridge: Bridge,
    pub task: Option<BridgeTask>,
    pub gate: AdmissionGate,
    pub config: watch::Sender<Arc<Config>>,
    pub logger: Logger,
    pub secrets: Arc<Mutex<SecretStore>>,
}

pub fn config_with(port: BrowserBridgePort) -> Arc<Config> {
    let mut config = first_launch_config(Platform::current());
    config.ui.browser_bridge_port = Some(port);
    Arc::new(config)
}

impl Fixture {
    pub async fn start(options: Options) -> Self {
        let dir = scratch("cos-bridge");
        Self::start_in(dir, options).await
    }

    pub async fn start_in(dir: PathBuf, options: Options) -> Self {
        let logger = Logger::with_clock(|| cos_tools::EpochMs::now().0, false);
        let (config, config_seen) = watch::channel(config_with(options.port));
        let (gate, admission): (AdmissionGate, Admission) = Admission::channel();
        if options.serving {
            gate.advance(Phase::Serving);
        }
        let secrets = Arc::new(Mutex::new(SecretStore::new(&dir)));
        let extension = ExtensionFolder::checkout(dir.join("no-extension"), &dir);
        let bridge = Bridge::new(BridgeDeps {
            app_version: "2.1.35",
            config: config_seen,
            secrets: secrets.clone(),
            admission,
            logger: logger.clone(),
            extension: extension.clone(),
            ports_override: options.ports_override,
        });
        let mut routes = Routes::new(extension, logger.clone());
        if let Some(register) = options.routes {
            routes = register(routes);
        }
        let task = bridge.spawn(routes);
        let fixture = Self {
            dir,
            bridge,
            task: Some(task),
            gate,
            config,
            logger,
            secrets,
        };
        fixture
            .wait(|status| status.running || status.error.clone().flatten().is_some())
            .await;
        fixture
    }

    pub fn status(&self) -> Arc<BridgeStatus> {
        self.bridge.status().borrow().clone()
    }

    /// Waits up to 5 s for status to satisfy `ready`.
    pub async fn wait(&self, ready: impl Fn(&BridgeStatus) -> bool) -> Arc<BridgeStatus> {
        let mut status = self.bridge.status();
        tokio::time::timeout(
            Duration::from_secs(5),
            status.wait_for(|status| ready(status)),
        )
        .await
        .expect("status within 5 s")
        .expect("the bridge publishes")
        .clone()
    }

    pub fn port(&self) -> u16 {
        self.status().port.expect("the bridge listens")
    }

    pub async fn pair(&self) -> String {
        let reply = self
            .request(Request::post("/pair").json(&serde_json::json!({})))
            .await;
        assert_eq!(reply.status, 200, "{reply:?}");
        reply.body["token"].as_str().expect("a token").to_owned()
    }

    pub async fn request(&self, request: Request) -> Reply {
        send(self.port(), request).await
    }

    pub fn log_lines(&self) -> Vec<String> {
        self.logger
            .entries()
            .into_iter()
            .map(|entry| entry.message)
            .collect()
    }

    pub async fn shutdown(mut self) {
        if let Some(task) = self.task.take() {
            task.shutdown().await;
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[derive(Clone, Debug)]
pub struct Request {
    pub method: &'static str,
    pub path: String,
    pub origin: Option<String>,
    pub bearer: Option<String>,
    pub protocol: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

impl Request {
    pub fn new(method: &'static str, path: &str) -> Self {
        Self {
            method,
            path: path.into(),
            origin: Some(EXTENSION_ORIGIN.into()),
            bearer: None,
            protocol: Some(BRIDGE_PROTOCOL.to_string()),
            headers: vec![("x-extension-version".into(), "2.1.35".into())],
            body: None,
        }
    }

    pub fn get(path: &str) -> Self {
        Self::new("GET", path)
    }

    pub fn post(path: &str) -> Self {
        Self::new("POST", path)
    }

    pub fn origin(mut self, origin: Option<&str>) -> Self {
        self.origin = origin.map(str::to_owned);
        self
    }

    pub fn bearer(mut self, token: &str) -> Self {
        self.bearer = Some(token.into());
        self
    }

    pub fn protocol(mut self, protocol: Option<&str>) -> Self {
        self.protocol = protocol.map(str::to_owned);
        self
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.retain(|(kept, _)| kept != name);
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn json(mut self, body: &Value) -> Self {
        self.body = Some(serde_json::to_vec(body).expect("json"));
        self
    }

    pub fn raw(mut self, body: Vec<u8>) -> Self {
        self.body = Some(body);
        self
    }

    fn head(&self) -> String {
        let mut head = format!(
            "{} {} HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n",
            self.method, self.path
        );
        if let Some(origin) = &self.origin {
            head.push_str(&format!("origin: {origin}\r\n"));
        }
        if let Some(token) = &self.bearer {
            head.push_str(&format!("authorization: Bearer {token}\r\n"));
        }
        if let Some(protocol) = &self.protocol {
            head.push_str(&format!("x-extension-protocol: {protocol}\r\n"));
        }
        for (name, value) in &self.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        if let Some(body) = &self.body {
            head.push_str(&format!(
                "content-type: application/json\r\ncontent-length: {}\r\n",
                body.len()
            ));
        }
        head.push_str("\r\n");
        head
    }
}

#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl Reply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(kept, _)| kept == name)
            .map(|(_, value)| value.as_str())
    }
}

pub async fn send(port: u16, request: Request) -> Reply {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connects");
    let mut bytes = request.head().into_bytes();
    if let Some(body) = &request.body {
        bytes.extend_from_slice(body);
    }
    stream.write_all(&bytes).await.expect("writes");
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).await.expect("reads");
    parse_reply(&reply)
}

pub fn parse_reply(bytes: &[u8]) -> Reply {
    let text = String::from_utf8_lossy(bytes);
    let (head, body) = text.split_once("\r\n\r\n").expect("a whole answer");
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse().ok())
        .expect("a status line");
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(body).expect("a json body")
    };
    Reply {
        status,
        headers,
        body,
    }
}

/// A WebSocket client: the opening handshake by hand, then masked frames.
pub struct Socket {
    stream: TcpStream,
    buffer: Vec<u8>,
}

pub enum Opened {
    Open(Socket),
    Refused(u16),
}

impl Socket {
    pub async fn open(port: u16, path: &str, origin: Option<&str>) -> Opened {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connects");
        let mut head = format!(
            "GET {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\
             sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n"
        );
        if let Some(origin) = origin {
            head.push_str(&format!("origin: {origin}\r\n"));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).await.expect("writes");
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        let end = loop {
            if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break end + 4;
            }
            let read = stream.read(&mut chunk).await.expect("reads");
            assert!(read > 0, "closed during the handshake");
            buffer.extend_from_slice(&chunk[..read]);
        };
        let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
        let status: u16 = head
            .split(' ')
            .nth(1)
            .and_then(|code| code.parse().ok())
            .expect("a status");
        if status != 101 {
            return Opened::Refused(status);
        }
        assert!(
            head.to_ascii_lowercase()
                .contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo="),
            "{head}"
        );
        Opened::Open(Self {
            stream,
            buffer: buffer[end..].to_vec(),
        })
    }

    pub async fn open_ok(port: u16, path: &str) -> Self {
        match Self::open(port, path, Some(EXTENSION_ORIGIN)).await {
            Opened::Open(socket) => socket,
            Opened::Refused(status) => panic!("refused with {status}"),
        }
    }

    pub async fn send_frame(&mut self, opcode: u8, payload: &[u8]) {
        let mask = [0x0A, 0x0B, 0x0C, 0x0D];
        let mut frame = vec![0x80 | opcode];
        if payload.len() < 126 {
            frame.push(0x80 | u8::try_from(payload.len()).expect("short"));
        } else {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&u16::try_from(payload.len()).expect("fits").to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        // A server that already closed may reset; the next read reports it.
        let _ = self.stream.write_all(&frame).await;
    }

    pub async fn send_text(&mut self, text: &str) {
        self.send_frame(0x1, text.as_bytes()).await;
    }

    /// The next text frame, or `None` once the server closes (a close frame or end of stream).
    pub async fn next_text(&mut self, within: Duration) -> Option<String> {
        tokio::time::timeout(within, async {
            loop {
                if self.buffer.len() >= 2 {
                    let length = usize::from(self.buffer[1] & 0x7F);
                    if self.buffer.len() >= 2 + length {
                        let opcode = self.buffer[0] & 0x0F;
                        let payload: Vec<u8> = self.buffer.drain(..2 + length).skip(2).collect();
                        match opcode {
                            0x1 => return Some(String::from_utf8(payload).expect("utf-8")),
                            0x8 => return None,
                            _ => continue,
                        }
                    }
                }
                let mut chunk = [0u8; 256];
                match self.stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => return None,
                    Ok(read) => self.buffer.extend_from_slice(&chunk[..read]),
                }
            }
        })
        .await
        .expect("a frame or a close within the deadline")
    }

    /// True when the server ends the connection within `within`.
    pub async fn closed_within(&mut self, within: Duration) -> bool {
        tokio::time::timeout(within, async {
            loop {
                let mut chunk = [0u8; 256];
                match self.stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        })
        .await
        .is_ok()
    }
}
