//! A raw HTTP/1.1 client, so a test controls every byte the server sees and reads every byte
//! it answers, including whether it closed the connection.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug)]
pub(crate) struct Got {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
    /// The server sent `100 Continue` before its answer.
    pub(crate) continued: bool,
}

impl Got {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub(crate) fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&self.body)))
    }

    pub(crate) fn error(&self) -> String {
        self.json()["error"].as_str().unwrap_or_default().to_owned()
    }
}

/// One request as a test sends it. `host` and `content-length` are added unless given.
#[derive(Clone, Debug, Default)]
pub(crate) struct Sent {
    pub(crate) method: String,
    pub(crate) target: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Option<Vec<u8>>,
}

impl Sent {
    pub(crate) fn get(target: &str) -> Self {
        Self {
            method: "GET".into(),
            target: target.into(),
            ..Self::default()
        }
    }

    pub(crate) fn post(target: &str) -> Self {
        Self {
            method: "POST".into(),
            target: target.into(),
            ..Self::default()
        }
    }

    pub(crate) fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub(crate) fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = Some(body.into());
        self
    }

    fn has(&self, name: &str) -> bool {
        self.headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case(name))
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn head(&self, port: u16) -> String {
        let mut head = format!("{} {} HTTP/1.1\r\n", self.method, self.target);
        if !self.has("host") {
            head.push_str(&format!("host: 127.0.0.1:{port}\r\n"));
        }
        for (name, value) in &self.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        let chunked = self
            .value("transfer-encoding")
            .is_some_and(|value| value.eq_ignore_ascii_case("chunked"));
        // Node sends `content-length: 0` for a POST without a body, and the length of any body.
        let length = match &self.body {
            Some(body) => Some(body.len()),
            None if self.method == "POST" => Some(0),
            None => None,
        };
        if let Some(length) = length.filter(|_| !chunked && !self.has("content-length")) {
            head.push_str(&format!("content-length: {length}\r\n"));
        }
        head.push_str("\r\n");
        head
    }

    fn encoded_body(&self) -> Vec<u8> {
        let body = self.body.clone().unwrap_or_default();
        let chunked = self
            .value("transfer-encoding")
            .is_some_and(|value| value.eq_ignore_ascii_case("chunked"));
        if !chunked {
            return body;
        }
        let mut out = format!("{:x}\r\n", body.len()).into_bytes();
        out.extend_from_slice(&body);
        out.extend_from_slice(b"\r\n0\r\n\r\n");
        out
    }
}

/// An open connection, for tests that send more than one request on it.
pub(crate) struct Connection {
    stream: TcpStream,
    port: u16,
    buffer: Vec<u8>,
    /// The streamed answer being read is chunked rather than ended by closing.
    pub(crate) chunked: bool,
}

impl Connection {
    pub(crate) async fn open(port: u16) -> Self {
        let stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connects");
        Self {
            stream,
            port,
            buffer: Vec::new(),
            chunked: false,
        }
    }

    /// Sends `sent` and reads one answer. With `expect: 100-continue` the body goes only after
    /// the server asks for it, as Node's client does.
    pub(crate) async fn send(&mut self, sent: &Sent) -> Got {
        let waits = sent
            .value("expect")
            .is_some_and(|value| value.to_ascii_lowercase().contains("100-continue"));
        self.stream
            .write_all(sent.head(self.port).as_bytes())
            .await
            .expect("writes the head");
        if !waits {
            self.stream
                .write_all(&sent.encoded_body())
                .await
                .expect("writes the body");
        }
        let mut continued = false;
        loop {
            let (status, headers) = self.read_head().await;
            if status == 100 {
                continued = true;
                // A server that refuses later may close mid-body; its answer is still read.
                let _ = self.stream.write_all(&sent.encoded_body()).await;
                continue;
            }
            let body = self.read_body(&headers).await;
            return Got {
                status,
                headers,
                body,
                continued,
            };
        }
    }

    /// Sends only `sent`'s head and reads the answer, as a client whose body trails its head
    /// does before it sends the body.
    pub(crate) async fn send_head(&mut self, sent: &Sent) -> Got {
        self.stream
            .write_all(sent.head(self.port).as_bytes())
            .await
            .expect("writes the head");
        let (status, headers) = self.read_head().await;
        let body = self.read_body(&headers).await;
        Got {
            status,
            headers,
            body,
            continued: false,
        }
    }

    /// Sends the body [`Self::send_head`] held back.
    pub(crate) async fn send_body(&mut self, sent: &Sent) -> std::io::Result<()> {
        self.stream.write_all(&sent.encoded_body()).await
    }

    /// Reads until the server ends the connection: `Ok` when it closed it, the error when it
    /// reset it.
    pub(crate) async fn ended(&mut self) -> std::io::Result<()> {
        assert!(self.buffer.is_empty(), "sent more after its answer");
        let mut chunk = [0u8; 64];
        match tokio::time::timeout(Duration::from_secs(10), self.stream.read(&mut chunk)).await {
            Ok(Ok(0)) => Ok(()),
            Ok(Ok(read)) => panic!("sent more after its answer: {:?}", &chunk[..read]),
            Ok(Err(error)) => Err(error),
            Err(_) => panic!("still open after 10 s"),
        }
    }

    async fn fill(&mut self) -> bool {
        let mut chunk = [0u8; 16 * 1024];
        match tokio::time::timeout(Duration::from_secs(10), self.stream.read(&mut chunk)).await {
            Ok(Ok(0)) | Ok(Err(_)) => false,
            Ok(Ok(read)) => {
                self.buffer.extend_from_slice(&chunk[..read]);
                true
            }
            Err(_) => panic!("no answer within 10 s"),
        }
    }

    async fn read_head(&mut self) -> (u16, Vec<(String, String)>) {
        loop {
            if let Some(end) = self
                .buffer
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
            {
                let head = String::from_utf8_lossy(&self.buffer[..end]).into_owned();
                self.buffer.drain(..end + 4);
                let mut lines = head.split("\r\n");
                let status_line = lines.next().unwrap_or_default();
                let status = status_line
                    .split(' ')
                    .nth(1)
                    .and_then(|code| code.parse().ok())
                    .unwrap_or_else(|| panic!("not a status line: {status_line}"));
                let headers = lines
                    .filter_map(|line| line.split_once(':'))
                    .map(|(name, value)| {
                        (name.trim().to_ascii_lowercase(), value.trim().to_owned())
                    })
                    .collect();
                return (status, headers);
            }
            assert!(
                self.fill().await,
                "closed before an answer: {:?}",
                String::from_utf8_lossy(&self.buffer)
            );
        }
    }

    async fn read_body(&mut self, headers: &[(String, String)]) -> Vec<u8> {
        if chunked(headers) {
            loop {
                let (body, complete) = dechunk(&self.buffer);
                if complete {
                    self.buffer.clear();
                    return body;
                }
                assert!(self.fill().await, "closed inside a chunked body");
            }
        }
        let length = headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .and_then(|(_, value)| value.parse::<usize>().ok());
        match length {
            Some(length) => {
                while self.buffer.len() < length {
                    assert!(self.fill().await, "closed inside a body");
                }
                self.buffer.drain(..length).collect()
            }
            None => {
                while self.fill().await {}
                std::mem::take(&mut self.buffer)
            }
        }
    }

    /// Whether the server has closed its side: the next read ends instead of waiting.
    pub(crate) async fn closed_by_server(&mut self) -> bool {
        let mut chunk = [0u8; 64];
        matches!(
            tokio::time::timeout(Duration::from_millis(500), self.stream.read(&mut chunk)).await,
            Ok(Ok(0)) | Ok(Err(_))
        )
    }

    /// Reads a streamed body until `done` holds for the text so far or the stream ends.
    pub(crate) async fn read_until(&mut self, done: impl Fn(&str) -> bool) -> String {
        loop {
            let data = if self.chunked {
                dechunk(&self.buffer).0
            } else {
                self.buffer.clone()
            };
            let text = String::from_utf8_lossy(&data).into_owned();
            if done(&text) || !self.fill().await {
                return text;
            }
        }
    }

    /// Reads a streamed answer's head, leaving its body to [`Self::read_until`].
    pub(crate) async fn open_stream(&mut self, sent: &Sent) -> (u16, Vec<(String, String)>) {
        self.stream
            .write_all(sent.head(self.port).as_bytes())
            .await
            .expect("writes the head");
        let (status, headers) = self.read_head().await;
        self.chunked = chunked(&headers);
        (status, headers)
    }
}

pub(crate) async fn send(port: u16, sent: &Sent) -> Got {
    Connection::open(port).await.send(sent).await
}

fn chunked(headers: &[(String, String)]) -> bool {
    headers
        .iter()
        .any(|(name, value)| name == "transfer-encoding" && value.eq_ignore_ascii_case("chunked"))
}

/// The data of a chunked body received so far, and whether its last chunk has arrived.
fn dechunk(raw: &[u8]) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(line) = raw[at..].windows(2).position(|window| window == b"\r\n") {
        let size = std::str::from_utf8(&raw[at..at + line])
            .ok()
            .and_then(|text| usize::from_str_radix(text.trim(), 16).ok())
            .unwrap_or_else(|| panic!("not a chunk size: {:?}", &raw[at..at + line]));
        let start = at + line + 2;
        if size == 0 {
            return (out, true);
        }
        if raw.len() < start + size + 2 {
            out.extend_from_slice(&raw[start..raw.len().min(start + size)]);
            return (out, false);
        }
        out.extend_from_slice(&raw[start..start + size]);
        at = start + size + 2;
    }
    (out, false)
}
