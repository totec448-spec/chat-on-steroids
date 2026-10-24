//! The host side of one code-mode run: limits, child-call admission, emissions and the result
//! (port of `runCodeMode` in `code-mode-runtime.ts`).

use std::collections::HashSet;
use std::fmt;
use std::future::{Future, poll_fn};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use cos_tools::{BoxFuture, Content, NestedTool, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use crate::image::emitted_image;
use crate::text::{decode_json_string, is_blank, utf16_len};
use crate::worker::{Delivery, Emission, Event, Job, Worker};

/// `CODE_MODE_LIMITS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// UTF-16 code units, as `code.length` counts them.
    pub code_chars: usize,
    /// CPU time the QuickJS thread may spend running the script.
    pub cpu: Duration,
    /// Time from start to forced stop, waiting included.
    pub wall: Duration,
    pub memory_bytes: usize,
    pub calls: usize,
    pub concurrent_calls: usize,
    pub argument_bytes: usize,
    pub result_bytes: usize,
    pub total_result_bytes: usize,
    pub output_bytes: usize,
    pub output_items: usize,
    pub text_bytes: usize,
    pub images: usize,
    /// Scripts, and their unsettled children, running at once in this process.
    pub active_runs: usize,
}

pub const LIMITS: Limits = Limits {
    code_chars: 64_000,
    cpu: Duration::from_millis(2_000),
    wall: Duration::from_millis(60_000),
    memory_bytes: 32 * 1024 * 1024,
    calls: 32,
    concurrent_calls: 8,
    argument_bytes: 1024 * 1024,
    result_bytes: 12 * 1024 * 1024,
    total_result_bytes: 32 * 1024 * 1024,
    output_bytes: 12 * 1024 * 1024,
    output_items: 32,
    text_bytes: 40_000,
    images: 4,
    active_runs: 4,
};

/// Starts one child call for a script. The kernel's nested-call path in production. The call
/// runs on its own task, so it may finish after the script's result was returned.
pub trait Invoke: Sync {
    fn invoke(&self, tool: String, arguments: Value) -> BoxFuture<'static, ToolResult>;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Options {
    /// Windows Desktop: also expose `sky` and `nodeRepl`.
    pub windows_desktop: bool,
}

/// Why a script stopped before it finished on its own. The model sees `CODE_MODE_<NAME>`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stop {
    /// The source did not parse, or a script without top-level `await` threw while it ran.
    ParseError,
    /// A script with top-level `await` rejected.
    ScriptError,
    CpuLimit,
    TimeLimit,
    OutputLimit,
    OutputInvalid,
    CallLimit,
    UnknownTool,
    BridgeError,
    ResultLimit,
    RuntimeError,
}

impl fmt::Display for Stop {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ParseError => "PARSE_ERROR",
            Self::ScriptError => "SCRIPT_ERROR",
            Self::CpuLimit => "CPU_LIMIT",
            Self::TimeLimit => "TIME_LIMIT",
            Self::OutputLimit => "OUTPUT_LIMIT",
            Self::OutputInvalid => "OUTPUT_INVALID",
            Self::CallLimit => "CALL_LIMIT",
            Self::UnknownTool => "UNKNOWN_TOOL",
            Self::BridgeError => "BRIDGE_ERROR",
            Self::ResultLimit => "RESULT_LIMIT",
            Self::RuntimeError => "RUNTIME_ERROR",
        })
    }
}

fn error_result(reason: &str) -> ToolResult {
    ToolResult {
        content: vec![error_text(reason)],
        structured_content: None,
        is_error: true,
    }
}

fn error_text(reason: &str) -> Content {
    Content::Text {
        text: format!("CODE_MODE_{reason}"),
    }
}

/// Scripts in this process that still run or still have unsettled children (`activeRuns`).
static ACTIVE_RUNS: AtomicUsize = AtomicUsize::new(0);

struct ActiveRun;

impl Drop for ActiveRun {
    fn drop(&mut self) {
        ACTIVE_RUNS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// `// @exec:` at the start of any line (`/^\s*\/\/ @exec:/m`).
fn has_pragma(code: &str) -> bool {
    code.split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .any(|line| crate::text::trim_start(line).starts_with("// @exec:"))
}

/// Runs `code` in a fresh interpreter with `tools` callable through `invoke`, and returns what
/// the model sees: diagnostics first, then the script's explicit `text`/`image` emissions.
///
/// A child call the script started and did not await keeps running after this returns, and
/// its result is discarded. It still counts against [`Limits::active_runs`] until it settles.
/// Nothing a child did is rolled back. Must be called inside a Tokio runtime.
pub async fn run(
    code: &str,
    tools: &[NestedTool],
    invoke: &dyn Invoke,
    limits: &Limits,
    options: Options,
) -> ToolResult {
    if is_blank(code) || utf16_len(code) > limits.code_chars {
        return error_result("CODE_LIMIT");
    }
    let reserved = ACTIVE_RUNS.try_update(Ordering::AcqRel, Ordering::Acquire, |running| {
        (running < limits.active_runs).then_some(running + 1)
    });
    if reserved.is_err() {
        return error_result("BUSY: too many code executions or unsettled nested calls.");
    }
    let active = ActiveRun;
    if has_pragma(code) {
        return error_result(
            "UNSUPPORTED_PRAGMA: use plain JavaScript; execution is bounded to one call.",
        );
    }

    let job = Job {
        code: code.to_owned(),
        entries: serde_json::to_string(tools).unwrap_or_else(|_| "[]".to_owned()),
        limits: *limits,
        windows_desktop: options.windows_desktop,
    };
    let mut host = Host::new(tools, invoke, limits);
    let (stop, unawaited) = match Worker::spawn(job) {
        Ok(mut worker) => {
            let stop = host.drive(&mut worker).await;
            worker.terminate();
            let unawaited = !host.in_flight.is_empty() || host.result_refused;
            worker.exited().await;
            (stop, unawaited)
        }
        Err(_) => (Some(Stop::RuntimeError), false),
    };
    settle_children(std::mem::take(&mut host.in_flight), active);
    let emitted = emitted_content(std::mem::take(&mut host.emissions)).await;
    host.result(stop, unawaited, emitted)
}

/// The emissions as content, in order. `Err` holds the content before the first emission that
/// failed validation. Images are decoded to prove them, so that runs on a blocking thread.
async fn emitted_content(emissions: Vec<(Emission, String)>) -> Result<Vec<Content>, Vec<Content>> {
    if !emissions.iter().any(|(kind, _)| *kind == Emission::Image) {
        return validate_emissions(emissions);
    }
    tokio::task::spawn_blocking(move || validate_emissions(emissions))
        .await
        .unwrap_or_else(|_| Err(Vec::new()))
}

fn validate_emissions(emissions: Vec<(Emission, String)>) -> Result<Vec<Content>, Vec<Content>> {
    let mut content = Vec::with_capacity(emissions.len());
    for (kind, json) in emissions {
        let emitted = match kind {
            Emission::Text => decode_json_string(&json).map(|text| Content::Text { text }),
            Emission::Image => serde_json::from_str::<Value>(&json)
                .ok()
                .and_then(|value| emitted_image(&value)),
        };
        match emitted {
            Some(emitted) => content.push(emitted),
            None => return Err(content),
        }
    }
    Ok(content)
}

/// Moves every child still running onto its own task, so it finishes after the script's result
/// is returned, and keeps the run's place among the active runs until the last one settles, so
/// fire-and-forget scripts cannot evade the bound. Dropping a child would cancel it.
fn settle_children(children: Vec<Child>, active: ActiveRun) {
    if children.is_empty() {
        return;
    }
    tokio::spawn(async move {
        for (_, child) in children {
            child.await;
        }
        drop(active);
    });
}

/// A child call in flight, tagged with the script's call id.
type Child = (u32, Caught);

/// A child call polled where the script runs, as TypeScript runs it in a microtask: a child that
/// is ready at once answers before the script's next request is handled. A panic is `None`,
/// the rejected promise TypeScript turns into `TOOL_ERROR`.
struct Caught(BoxFuture<'static, ToolResult>);

impl Future for Caught {
    type Output = Option<ToolResult>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match catch_unwind(AssertUnwindSafe(|| self.0.as_mut().poll(cx))) {
            Ok(Poll::Ready(result)) => Poll::Ready(Some(result)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(_) => Poll::Ready(None),
        }
    }
}

/// The host's bookkeeping for one run (the closure state of `runCodeMode`).
struct Host<'a> {
    limits: &'a Limits,
    invoke: &'a dyn Invoke,
    allowed: HashSet<&'a str>,
    in_flight: Vec<Child>,
    emissions: Vec<(Emission, String)>,
    calls: usize,
    result_bytes: usize,
    emitted_bytes: usize,
    text_bytes: usize,
    images: usize,
    text_truncated: bool,
    /// A child whose result broke a limit. It still counts as unsettled when the run stops,
    /// because TypeScript forgets a child only after handing its result over.
    result_refused: bool,
}

#[derive(Deserialize)]
struct CallRequest {
    name: String,
    #[serde(default)]
    args: Value,
}

impl<'a> Host<'a> {
    fn new(tools: &'a [NestedTool], invoke: &'a dyn Invoke, limits: &'a Limits) -> Self {
        Self {
            limits,
            invoke,
            allowed: tools.iter().map(|tool| tool.name.as_str()).collect(),
            in_flight: Vec::new(),
            emissions: Vec::new(),
            calls: 0,
            result_bytes: 0,
            emitted_bytes: 0,
            text_bytes: 0,
            images: 0,
            text_truncated: false,
            result_refused: false,
        }
    }

    /// Serves the worker until the script ends or a limit stops it. `None` is a clean finish.
    async fn drive(&mut self, worker: &mut Worker) -> Option<Stop> {
        let mut deadline = pin!(tokio::time::sleep(self.limits.wall));
        poll_fn(|cx| {
            loop {
                if deadline.as_mut().poll(cx).is_ready() {
                    return Poll::Ready(Some(Stop::TimeLimit));
                }
                let mut progressed = false;
                let mut index = 0;
                while index < self.in_flight.len() {
                    let Poll::Ready(settled) = Pin::new(&mut self.in_flight[index].1).poll(cx)
                    else {
                        index += 1;
                        continue;
                    };
                    progressed = true;
                    let (id, _) = self.in_flight.swap_remove(index);
                    let Some(result) = settled else {
                        let json =
                            serde_json::to_string(&error_result("TOOL_ERROR")).unwrap_or_default();
                        worker.deliver(Delivery { id, json });
                        continue;
                    };
                    match self.on_result(result) {
                        Ok(json) => worker.deliver(Delivery { id, json }),
                        Err(stop) => {
                            self.result_refused = true;
                            return Poll::Ready(Some(stop));
                        }
                    }
                }
                match worker.events.poll_recv(cx) {
                    Poll::Ready(Some(event)) => {
                        progressed = true;
                        if let Some(end) = self.on_event(event) {
                            return Poll::Ready(end);
                        }
                    }
                    // The thread ended without saying why: it panicked.
                    Poll::Ready(None) => return Poll::Ready(Some(Stop::RuntimeError)),
                    Poll::Pending => {}
                }
                if !progressed {
                    return Poll::Pending;
                }
            }
        })
        .await
    }

    /// `Some(end)` when this event ends the run, with `end` its stop reason (`None`: clean).
    fn on_event(&mut self, event: Event) -> Option<Option<Stop>> {
        match event {
            Event::Done(stop) => Some(stop),
            Event::Emit { kind, json } => self.on_emit(kind, json).err().map(Some),
            Event::Call { id, json } => self.on_call(id, &json).err().map(Some),
        }
    }

    fn on_emit(&mut self, kind: Emission, json: String) -> Result<(), Stop> {
        let limits = self.limits;
        let bytes = json.len();
        self.emitted_bytes += bytes;
        if self.emissions.len() >= limits.output_items
            || bytes > limits.result_bytes
            || self.emitted_bytes > limits.output_bytes
        {
            return Err(Stop::OutputLimit);
        }
        match kind {
            Emission::Text => {
                let value = decode_json_string(&json).ok_or(Stop::OutputInvalid)?;
                let room = limits.text_bytes.saturating_sub(self.text_bytes);
                if value.len() > room {
                    // This value was explicitly emitted. Keep the prefix that fits instead of
                    // replacing a whole useful read with an opaque error.
                    let mut end = room;
                    while end > 0 && !value.is_char_boundary(end) {
                        end -= 1;
                    }
                    if end > 0 {
                        let prefix = Value::String(value[..end].to_owned()).to_string();
                        self.emissions.push((Emission::Text, prefix));
                    }
                    self.text_truncated = true;
                    return Err(Stop::OutputLimit);
                }
                self.text_bytes += value.len();
            }
            Emission::Image => {
                self.images += 1;
                if self.images > limits.images {
                    return Err(Stop::OutputLimit);
                }
            }
        }
        self.emissions.push((kind, json));
        Ok(())
    }

    fn on_call(&mut self, id: u32, json: &str) -> Result<(), Stop> {
        let limits = self.limits;
        if self.calls >= limits.calls
            || self.in_flight.len() >= limits.concurrent_calls
            || json.len() > limits.argument_bytes
        {
            return Err(Stop::CallLimit);
        }
        let request: CallRequest = serde_json::from_str(json).map_err(|_| Stop::BridgeError)?;
        if !self.allowed.contains(request.name.as_str()) {
            return Err(Stop::UnknownTool);
        }
        self.calls += 1;
        let child = Caught(self.invoke.invoke(request.name, request.args));
        self.in_flight.push((id, child));
        Ok(())
    }

    /// The child's result as the script will parse it, or the limit it broke.
    fn on_result(&mut self, result: ToolResult) -> Result<String, Stop> {
        let json = serde_json::to_string(&result).map_err(|_| Stop::RuntimeError)?;
        self.result_bytes += json.len();
        if json.len() > self.limits.result_bytes
            || self.result_bytes > self.limits.total_result_bytes
        {
            return Err(Stop::ResultLimit);
        }
        Ok(json)
    }

    fn result(
        self,
        stop: Option<Stop>,
        unawaited: bool,
        emitted: Result<Vec<Content>, Vec<Content>>,
    ) -> ToolResult {
        let content = match emitted {
            Ok(content) => content,
            Err(valid) => {
                let mut invalid = vec![error_text(
                    "OUTPUT_INVALID: image or text could not be validated.",
                )];
                invalid.extend(valid);
                return ToolResult {
                    content: invalid,
                    structured_content: None,
                    is_error: true,
                };
            }
        };
        // Status must survive head-only logs and bounded history previews, even after a full
        // emission.
        let mut diagnostics = Vec::new();
        if let Some(stop) = stop {
            diagnostics.push(error_text(&self.diagnostic(stop)));
        }
        if unawaited {
            diagnostics.push(error_text(
                "UNAWAITED_CALLS: dispatched tool calls are still running and remain recorded. Side effects were not cancelled.",
            ));
        }
        let is_error = !diagnostics.is_empty();
        diagnostics.extend(content);
        ToolResult {
            content: diagnostics,
            structured_content: None,
            is_error,
        }
    }

    fn diagnostic(&self, stop: Stop) -> String {
        let limits = self.limits;
        let effects = if self.calls > 0 {
            format!(
                "{} tool calls already dispatched; side effects were not rolled back. Inspect current state before retrying.",
                self.calls
            )
        } else {
            "No tool calls were dispatched.".to_owned()
        };
        let hint = match stop {
            Stop::ParseError => " Source could not be parsed or initialized; check quoting, closing brackets, and unsupported imports.".to_owned(),
            Stop::OutputLimit => format!(
                " {}Limits: {} UTF-8 text bytes, {} images, {} output items. Filter results or read smaller ranges; use direct tools for large reads.",
                if self.text_truncated { "Explicit text was truncated. " } else { "" },
                limits.text_bytes,
                limits.images,
                limits.output_items
            ),
            Stop::ScriptError => " Check the JavaScript and available tool names; catch an expected error and explicitly text(...) only the details you need.".to_owned(),
            _ => String::new(),
        };
        format!("{stop}: execution stopped. {effects}{hint} Unemitted values remain private.")
    }
}
