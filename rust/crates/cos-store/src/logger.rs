//! The Activity log: a bounded in-memory ring mirrored to `app.log`. Port of `src/main/logger.ts`.
//!
//! Anything shaped like a credential is masked before it is stored. File writes happen on a
//! writer thread in ordered batches; a full backlog drops lines and says how many. The file
//! rotates once to `app.log.1` when it would pass 4 MiB.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub use cos_types::app_state::{LogEntry, LogLevel};
use regex::Regex;
use serde_json::json;

use crate::js;

const MAX_ENTRIES: usize = 500;
const MAX_LOG_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
const MAX_PENDING_BYTES: usize = 256 * 1024;
const MAX_BATCH_BYTES: usize = 64 * 1024;

type Listener = Arc<dyn Fn(&LogEntry) + Send + Sync>;
type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

/// A shared handle; clones log to the same ring and file.
#[derive(Clone)]
pub struct Logger {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<State>,
    idle: Condvar,
    listeners: Mutex<Vec<Listener>>,
    clock: Clock,
    echo: bool,
}

#[derive(Default)]
struct State {
    entries: VecDeque<LogEntry>,
    mirror: Option<Mirror>,
}

struct Mirror {
    file: PathBuf,
    bytes: u64,
    pending: VecDeque<String>,
    pending_bytes: usize,
    dropped: u64,
    writing: bool,
    error: Option<String>,
}

impl Default for Logger {
    fn default() -> Self {
        Self::new()
    }
}

impl Logger {
    /// A logger on the system clock. Console echo follows `CLF_DEBUG=1`, as in the app.
    pub fn new() -> Self {
        let now = || {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as u64)
        };
        Self::with_clock(
            now,
            std::env::var("CLF_DEBUG").is_ok_and(|value| value == "1"),
        )
    }

    /// A logger whose timestamps come from `clock` (milliseconds since the Unix epoch).
    pub fn with_clock(clock: impl Fn() -> u64 + Send + Sync + 'static, echo: bool) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                idle: Condvar::new(),
                listeners: Mutex::new(Vec::new()),
                clock: Box::new(clock),
                echo,
            }),
        }
    }

    /// `initLogFile`: mirrors every later line to `file`.
    pub fn mirror_to(&self, file: impl Into<PathBuf>) {
        let file = file.into();
        let bytes = fs::metadata(&file).map_or(0, |meta| meta.len());
        self.inner.lock().mirror = Some(Mirror {
            file,
            bytes,
            pending: VecDeque::new(),
            pending_bytes: 0,
            dropped: 0,
            writing: false,
            error: None,
        });
    }

    /// The mirrored file; its previous rotation is `<file>.1`.
    pub fn file(&self) -> Option<PathBuf> {
        self.inner
            .lock()
            .mirror
            .as_ref()
            .map(|mirror| mirror.file.clone())
    }

    pub fn info(&self, message: &str) {
        self.log(LogLevel::Info, message, None);
    }

    pub fn warn(&self, message: &str) {
        self.log(LogLevel::Warn, message, None);
    }

    pub fn error(&self, message: &str) {
        self.log(LogLevel::Error, message, None);
    }

    /// One line. `agent` attributes it to the tool call's agent; lines outside a call have none.
    pub fn log(&self, level: LogLevel, message: &str, agent: Option<&str>) {
        let entry = LogEntry {
            time: (self.inner.clock)(),
            level,
            message: bounded_text(&redact(message)),
            agent: agent
                .filter(|agent| !agent.is_empty())
                .map(|agent| js::prefix(&bounded_text(&redact(agent)), 200).to_owned()),
        };
        if self.inner.echo {
            eprintln!("[{}] {}", level.as_str(), entry.message);
        }
        let start_writer = {
            let mut state = self.inner.lock();
            state.entries.push_back(entry.clone());
            if state.entries.len() > MAX_ENTRIES {
                state.entries.pop_front();
            }
            match state
                .mirror
                .as_mut()
                .filter(|mirror| mirror.error.is_none())
            {
                Some(mirror) => {
                    let line = format_line(&entry);
                    if mirror.pending_bytes + line.len() > MAX_PENDING_BYTES {
                        mirror.dropped += 1;
                    } else {
                        mirror.pending_bytes += line.len();
                        mirror.pending.push_back(line);
                    }
                    !std::mem::replace(&mut mirror.writing, true)
                }
                None => false,
            }
        };
        if start_writer {
            let inner = self.inner.clone();
            if thread::Builder::new()
                .name("app-log".into())
                .spawn(move || inner.drain())
                .is_err()
                && let Some(mirror) = self.inner.lock().mirror.as_mut()
            {
                mirror.writing = false;
            }
        }
        // A listener reaching a closed window must not break the code that is logging.
        let listeners = self
            .inner
            .listeners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        for listener in &listeners {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(&entry)));
        }
    }

    pub fn entries(&self) -> Vec<LogEntry> {
        self.inner.lock().entries.iter().cloned().collect()
    }

    pub fn on_log(&self, listener: impl Fn(&LogEntry) + Send + Sync + 'static) {
        self.inner
            .listeners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .push(Arc::new(listener));
    }

    /// `flushLogFile`: waits for every accepted line to reach the file.
    pub fn flush(&self) -> io::Result<()> {
        self.flush_until(None)
    }

    /// `flushLogBeforeExit`: the final barrier. A missed deadline or a failure leaves a crash
    /// snapshot instead.
    pub fn flush_before_exit(&self, timeout: Duration) {
        if let Err(error) = self.flush_until(Some(Instant::now() + timeout)) {
            self.snapshot_on_crash(&format!("final log flush failed: {error}"));
        }
    }

    fn flush_until(&self, deadline: Option<Instant>) -> io::Result<()> {
        let mut state = self.inner.lock();
        loop {
            let Some(mirror) = state.mirror.as_ref() else {
                return Ok(());
            };
            if let Some(error) = &mirror.error {
                return Err(io::Error::other(error.clone()));
            }
            if !mirror.writing && mirror.pending.is_empty() && mirror.dropped == 0 {
                return Ok(());
            }
            state = match deadline {
                None => self
                    .inner
                    .idle
                    .wait(state)
                    .unwrap_or_else(|poison| poison.into_inner()),
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "log flush deadline exceeded",
                        ));
                    }
                    self.inner
                        .idle
                        .wait_timeout(state, left)
                        .unwrap_or_else(|poison| poison.into_inner())
                        .0
                }
            };
        }
    }

    /// `snapshotLogOnCrash`: writes `<file>.crash` with the reason and the newest lines.
    pub fn snapshot_on_crash(&self, reason: &str) {
        let state = self.inner.lock();
        if let Some(mirror) = &state.mirror {
            write_crash_snapshot(&mirror.file, &state.entries, reason, (self.inner.clock)());
        }
    }

    /// `formatLogForClipboard`.
    pub fn clipboard_text(&self) -> String {
        let state = self.inner.lock();
        let lines: Vec<String> = state
            .entries
            .iter()
            .map(|e| {
                format!(
                    "{}  {:<5}  {}",
                    js::iso_time(e.time),
                    e.level.as_str(),
                    e.message
                )
            })
            .collect();
        lines.join("\n")
    }

    /// `formatLogAsJson`: messages are already masked.
    pub fn json_text(&self) -> String {
        let state = self.inner.lock();
        let rows: Vec<_> = state
            .entries
            .iter()
            .map(|e| json!({ "time": js::iso_time(e.time), "level": e.level.as_str(), "message": e.message }))
            .collect();
        serde_json::to_string_pretty(&rows).unwrap_or_default()
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// The writer thread: appends batches until nothing is left, then marks the mirror idle.
    fn drain(&self) {
        loop {
            let (file, batch, rotate) = {
                let mut state = self.lock();
                let Some(mirror) = state.mirror.as_mut() else {
                    return;
                };
                let mut batch = String::new();
                while let Some(line) = mirror.pending.front() {
                    if !batch.is_empty() && batch.len() + line.len() > MAX_BATCH_BYTES {
                        break;
                    }
                    let line = mirror.pending.pop_front().unwrap_or_default();
                    mirror.pending_bytes -= line.len();
                    batch.push_str(&line);
                }
                if batch.is_empty() && mirror.dropped > 0 {
                    batch = format!(
                        "{}  warn   {} log line(s) omitted: file writer backlog exceeded its byte limit.\n",
                        js::iso_time((self.clock)()),
                        mirror.dropped
                    );
                    mirror.dropped = 0;
                }
                if batch.is_empty() {
                    mirror.writing = false;
                    self.idle.notify_all();
                    return;
                }
                let rotate =
                    mirror.bytes > 0 && mirror.bytes + batch.len() as u64 > MAX_LOG_FILE_BYTES;
                (mirror.file.clone(), batch, rotate)
            };
            let written = append(&file, &batch, rotate);
            let mut state = self.lock();
            let Some(mirror) = state.mirror.as_mut() else {
                return;
            };
            match written {
                Ok(()) => mirror.bytes = if rotate { 0 } else { mirror.bytes } + batch.len() as u64,
                Err(error) => {
                    mirror.error = Some(error.to_string());
                    mirror.pending.clear();
                    mirror.pending_bytes = 0;
                    mirror.dropped = 0;
                    mirror.writing = false;
                    let file = mirror.file.clone();
                    write_crash_snapshot(
                        &file,
                        &state.entries,
                        &format!("log file writer failed: {error}"),
                        (self.clock)(),
                    );
                    self.idle.notify_all();
                    return;
                }
            }
        }
    }
}

fn append(file: &Path, batch: &str, rotate: bool) -> io::Result<()> {
    if rotate {
        let mut previous = file.as_os_str().to_owned();
        previous.push(".1");
        fs::rename(file, previous)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?
        .write_all(batch.as_bytes())
}

fn format_line(entry: &LogEntry) -> String {
    let agent = entry
        .agent
        .as_ref()
        .map(|agent| format!("[{agent}] "))
        .unwrap_or_default();
    format!(
        "{}  {:<5}  {agent}{}\n",
        js::iso_time(entry.time),
        entry.level.as_str(),
        entry.message
    )
}

fn write_crash_snapshot(file: &Path, entries: &VecDeque<LogEntry>, reason: &str, now: u64) {
    let head = format_line(&LogEntry {
        time: now,
        level: LogLevel::Error,
        message: bounded_text(&redact(reason)),
        agent: None,
    });
    let mut bytes = head.len();
    let mut tail = Vec::new();
    for entry in entries.iter().rev() {
        let line = format_line(entry);
        if bytes + line.len() > MAX_PENDING_BYTES {
            break;
        }
        bytes += line.len();
        tail.push(line);
    }
    tail.reverse();
    let mut crash = file.as_os_str().to_owned();
    crash.push(".crash");
    // The reporting channel cannot report its own storage failure.
    let _ = fs::write(crash, head + &tail.concat());
}

/// `boundedText`: at most 16 KiB of UTF-8 per line, marked when cut.
fn bounded_text(text: &str) -> String {
    let prefix = js::prefix(text, MAX_LINE_BYTES);
    if prefix.len() == text.len() && prefix.len() <= MAX_LINE_BYTES {
        return text.to_owned();
    }
    let bytes = &prefix.as_bytes()[..prefix.len().min(MAX_LINE_BYTES - 64)];
    format!("{} [log text truncated]", String::from_utf8_lossy(bytes))
}

static SECRET_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)sk-[A-Za-z0-9_-]{8,}").expect("pattern"));
static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")
        .expect("pattern")
});
static OPAQUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)[A-Za-z0-9_-]{40,}(?-u:\b)").expect("pattern"));

/// `redact`: masks anything shaped like an API key, a JWT or a long opaque token.
pub fn redact(message: &str) -> String {
    let message = SECRET_KEY.replace_all(message, "sk-***");
    let message = JWT.replace_all(&message, "***jwt***");
    OPAQUE.replace_all(&message, "***").into_owned()
}
