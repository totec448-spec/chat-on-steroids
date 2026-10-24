//! One explicit provider request with its bounded pre-delivery retries (`main/task-request.ts`),
//! and the presentation-only reader of a streaming Goal plan (`shared/task-progress.ts`).

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{Notify, watch};

/// `TaskRequestError`: a failure, and whether it happened before anything was delivered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskError {
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
}

impl TaskError {
    pub fn terminal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            retry_after_ms: None,
        }
    }

    pub fn retryable(message: impl Into<String>, retry_after_ms: Option<u64>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
            retry_after_ms,
        }
    }

    fn cancelled() -> Self {
        Self::terminal("task_cancelled")
    }
}

/// `TaskProgress['phase']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskPhase {
    Preparing,
    Generating,
    Ready,
    Retrying,
    Failed,
    Cancelled,
}

/// `TaskProgressUpdate`: ephemeral presentation, never delivery authority.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskProgress {
    pub phase: TaskPhase,
    pub text: String,
    pub error: Option<String>,
    pub attempt: Option<u32>,
    pub retry_at: Option<u64>,
}

/// An `AbortSignal` the caller owns. Clones share one.
#[derive(Clone, Default)]
pub struct Cancel {
    inner: Arc<(AtomicBool, Notify)>,
}

impl Cancel {
    pub fn cancel(&self) {
        self.inner.0.store(true, Ordering::SeqCst);
        self.inner.1.notify_waiters();
    }

    pub fn cancelled(&self) -> bool {
        self.inner.0.load(Ordering::SeqCst)
    }

    /// Resolves once [`Self::cancel`] runs.
    pub async fn wait(&self) {
        loop {
            let notified = self.inner.1.notified();
            if self.cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// How many attempts and how long a request may spend retrying.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub attempts: u32,
    pub duration_ms: u64,
}

impl Limits {
    pub const UNBOUNDED: Self = Self {
        attempts: u32::MAX,
        duration_ms: u64::MAX,
    };
    /// `runTaskRequest`: three attempts within three minutes.
    pub const REQUEST: Self = Self {
        attempts: 3,
        duration_ms: 180_000,
    };
}

/// `retryTaskRequest`: retries only classified pre-delivery failures, after their Retry-After
/// (at least a second, fifteen by default). The caller owns cancellation and publication.
pub async fn retry_task_request<T, Fut>(
    mut work: impl FnMut(Cancel) -> Fut,
    cancel: &Cancel,
    mut publish: impl FnMut(TaskProgress),
    limits: Limits,
    now: impl Fn() -> u64,
) -> Result<T, TaskError>
where
    Fut: Future<Output = Result<T, TaskError>>,
{
    let started = now();
    let mut attempt: u32 = 1;
    loop {
        if cancel.cancelled() {
            return Err(TaskError::cancelled());
        }
        let outcome = tokio::select! {
            outcome = work(cancel.clone()) => outcome,
            () = cancel.wait() => return Err(TaskError::cancelled()),
        };
        if cancel.cancelled() {
            return Err(TaskError::cancelled());
        }
        let error = match outcome {
            Ok(result) => return Ok(result),
            Err(error) => error,
        };
        let delay = error.retry_after_ms.unwrap_or(15_000).max(1000);
        if !error.retryable
            || attempt >= limits.attempts
            || now().saturating_add(delay).saturating_sub(started) > limits.duration_ms
        {
            return Err(error);
        }
        publish(TaskProgress {
            phase: TaskPhase::Retrying,
            text: String::new(),
            error: Some(error.message.clone()),
            attempt: Some(attempt + 1),
            retry_at: Some(now() + delay),
        });
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(delay)) => {}
            () = cancel.wait() => return Err(TaskError::cancelled()),
        }
        attempt += 1;
    }
}

type Shared<T> = watch::Receiver<Option<Result<T, TaskError>>>;

struct Request<T> {
    fingerprint: String,
    cancel: Cancel,
    answer: Shared<T>,
}

impl<T> Request<T> {
    fn settled(&self) -> bool {
        self.answer.borrow().is_some()
    }
}

/// `runTaskRequest`: one invocation per id. The same id and fingerprint join the running or
/// settled request; another fingerprint is a conflict. At most 64 are kept.
pub struct TaskRequests<T> {
    requests: Mutex<HashMap<String, Request<T>>>,
}

impl<T> Default for TaskRequests<T> {
    fn default() -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
        }
    }
}

impl<T: Clone + Send + Sync + 'static> TaskRequests<T> {
    fn requests(&self) -> std::sync::MutexGuard<'_, HashMap<String, Request<T>>> {
        self.requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// `cancelTaskRequest`: `true` when a request was still running.
    pub fn cancel(&self, id: &str) -> bool {
        match self.requests().get(id) {
            Some(request) if !request.settled() => {
                request.cancel.cancel();
                true
            }
            _ => false,
        }
    }

    pub async fn run<Fut>(
        &self,
        id: &str,
        fingerprint: &str,
        work: impl FnMut(Cancel) -> Fut + Send + 'static,
        publish: impl FnMut(TaskProgress) + Send + 'static,
        now: impl Fn() -> u64 + Send + 'static,
    ) -> Result<T, TaskError>
    where
        Fut: Future<Output = Result<T, TaskError>> + Send + 'static,
    {
        let joined = {
            let mut requests = self.requests();
            if let Some(previous) = requests.get(id) {
                if previous.fingerprint != fingerprint {
                    return Err(TaskError::terminal("task_request_conflict"));
                }
                Some(previous.answer.clone())
            } else {
                if requests.len() >= 64 {
                    requests.retain(|_, request| !request.settled());
                }
                if requests.len() >= 64 {
                    return Err(TaskError::terminal("too_many_task_requests"));
                }
                None
            }
        };
        let mut answer = match joined {
            Some(answer) => answer,
            None => self.start(id, fingerprint, work, publish, now),
        };
        loop {
            if let Some(result) = answer.borrow().clone() {
                return result;
            }
            if answer.changed().await.is_err() {
                return answer
                    .borrow()
                    .clone()
                    .unwrap_or_else(|| Err(TaskError::cancelled()));
            }
        }
    }

    fn start<Fut>(
        &self,
        id: &str,
        fingerprint: &str,
        work: impl FnMut(Cancel) -> Fut + Send + 'static,
        mut publish: impl FnMut(TaskProgress) + Send + 'static,
        now: impl Fn() -> u64 + Send + 'static,
    ) -> Shared<T>
    where
        Fut: Future<Output = Result<T, TaskError>> + Send + 'static,
    {
        let cancel = Cancel::default();
        let (sender, answer) = watch::channel(None);
        self.requests().insert(
            id.to_owned(),
            Request {
                fingerprint: fingerprint.to_owned(),
                cancel: cancel.clone(),
                answer: answer.clone(),
            },
        );
        tokio::spawn(async move {
            let result =
                retry_task_request(work, &cancel, &mut publish, Limits::REQUEST, now).await;
            let result = match result {
                Ok(value) => Ok(value),
                Err(error) => {
                    let cancelled = cancel.cancelled();
                    publish(TaskProgress {
                        phase: if cancelled {
                            TaskPhase::Cancelled
                        } else {
                            TaskPhase::Failed
                        },
                        text: String::new(),
                        error: Some(error.message.clone()),
                        attempt: None,
                        retry_at: None,
                    });
                    Err(if cancelled {
                        TaskError::cancelled()
                    } else {
                        error
                    })
                }
            };
            let _ = sender.send(Some(result));
        });
        answer
    }
}

/// `stringPrefix`: a JSON string's decoded prefix, never guessing an unfinished escape.
fn string_prefix(source: &[u16], start: usize) -> Option<(Vec<u16>, usize, bool)> {
    if source.get(start) != Some(&u16::from(b'"')) {
        return None;
    }
    let mut text = Vec::new();
    let mut at = start + 1;
    while at < source.len() {
        let unit = source[at];
        if unit == u16::from(b'"') {
            return Some((text, at + 1, true));
        }
        if unit < 32 {
            return None;
        }
        if unit != u16::from(b'\\') {
            text.push(unit);
            at += 1;
            continue;
        }
        at += 1;
        if at == source.len() {
            break;
        }
        let escape = source[at];
        if escape == u16::from(b'u') {
            let digits: Vec<u16> = source[at + 1..source.len().min(at + 5)].to_vec();
            let hex = String::from_utf16_lossy(&digits);
            if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            if digits.len() < 4 {
                break;
            }
            text.push(u16::from_str_radix(&hex, 16).ok()?);
            at += 4;
        } else {
            let decoded = match u8::try_from(escape).ok()? {
                b'"' => b'"',
                b'\\' => b'\\',
                b'/' => b'/',
                b'b' => 8,
                b'f' => 12,
                b'n' => b'\n',
                b'r' => b'\r',
                b't' => b'\t',
                _ => return None,
            };
            text.push(u16::from(decoded));
        }
        at += 1;
    }
    Some((text, source.len(), false))
}

fn js_space(unit: Option<&u16>) -> bool {
    unit.and_then(|unit| char::from_u32(u32::from(*unit)))
        .is_some_and(|ch| {
            matches!(
                ch,
                '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
                    ..='\u{200A}'
                        | '\u{2028}'
                        | '\u{2029}'
                        | '\u{202F}'
                        | '\u{205F}'
                        | '\u{3000}'
                        | '\u{FEFF}'
            )
        })
}

fn skip_space(text: &[u16], mut at: usize) -> usize {
    while at < text.len() && js_space(text.get(at)) {
        at += 1;
    }
    at
}

fn trim_start(text: &[u16]) -> &[u16] {
    let at = skip_space(text, 0);
    &text[at..]
}

/// `planProgressText`: the readable stages of a Goal reply still streaming, numbered. It never
/// validates, queues or authorizes a plan.
pub fn plan_progress_text(raw: &str) -> String {
    let units: Vec<u16> = raw.encode_utf16().collect();
    if units.len() > 64_000 {
        return String::new();
    }
    let source = trim_start(&units);
    let brace = u16::from(b'{');
    if source.first() != Some(&brace) {
        return String::new();
    }
    let mut at = 1;
    let mut reply: Option<Vec<u16>> = None;
    let mut keys: Vec<Vec<u16>> = Vec::new();
    let action: Vec<u16> = "action".encode_utf16().collect();
    let reply_key: Vec<u16> = "reply".encode_utf16().collect();
    let continue_word: Vec<u16> = "continue".encode_utf16().collect();
    while at < source.len() {
        let Some((key, end, complete)) = string_prefix(source, skip_space(source, at)) else {
            return String::new();
        };
        if !complete || (key != action && key != reply_key) || keys.contains(&key) {
            return String::new();
        }
        keys.push(key.clone());
        at = skip_space(source, end);
        if source.get(at) != Some(&u16::from(b':')) {
            return String::new();
        }
        at += 1;
        let Some((value, end, complete)) = string_prefix(source, skip_space(source, at)) else {
            return String::new();
        };
        if key == reply_key {
            reply = Some(value);
            break;
        }
        if !complete || value != continue_word {
            return String::new();
        }
        at = skip_space(source, end);
        if source.get(at) != Some(&u16::from(b',')) {
            return String::new();
        }
        at += 1;
    }
    let Some(reply) = reply else {
        return String::new();
    };
    let plan = trim_start(&reply);
    if plan.first() != Some(&brace) {
        return String::new();
    }
    let stages_key: Vec<u16> = "stages".encode_utf16().collect();
    let Some((key, end, complete)) = string_prefix(plan, skip_space(plan, 1)) else {
        return String::new();
    };
    if !complete || key != stages_key {
        return String::new();
    }
    let mut at = skip_space(plan, end);
    if plan.get(at) != Some(&u16::from(b':')) {
        return String::new();
    }
    at = skip_space(plan, at + 1);
    if plan.get(at) != Some(&u16::from(b'[')) {
        return String::new();
    }
    at += 1;
    let close = u16::from(b']');
    let mut stages: Vec<String> = Vec::new();
    while stages.len() < 12 {
        at = skip_space(plan, at);
        if at == plan.len() || plan[at] == close {
            break;
        }
        let Some((stage, end, complete)) = string_prefix(plan, at) else {
            return String::new();
        };
        let text = String::from_utf16_lossy(&stage);
        if !text.trim().is_empty() {
            stages.push(text);
        }
        if !complete {
            break;
        }
        at = skip_space(plan, end);
        if at == plan.len() || plan[at] == close {
            break;
        }
        if plan[at] != u16::from(b',') {
            return String::new();
        }
        at += 1;
    }
    let joined = stages
        .iter()
        .enumerate()
        .map(|(index, stage)| format!("{}. {stage}", index + 1))
        .collect::<Vec<_>>()
        .join("\n\n");
    crate::js::slice(&joined, 0, 8000)
}
