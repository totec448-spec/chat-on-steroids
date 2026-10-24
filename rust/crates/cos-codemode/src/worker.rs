//! The QuickJS thread. Model source runs only here, inside a bounded QuickJS heap. The bridge
//! copies JSON strings both ways, and no host object enters the script (port of
//! `code-mode-worker.ts`).

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use rquickjs::Coerced;
use rquickjs::promise::PromiseState;
use rquickjs::{Context, Ctx, Exception, Function, Module, Persistent, Promise, Runtime};
use tokio::sync::{mpsc as tokio_mpsc, oneshot};

use crate::cpu::thread_cpu;
use crate::runtime::{Limits, Stop};

const PRELUDE: &str = include_str!("prelude.js");
const MODULE_NAME: &str = "code-mode.mjs";
/// `runtime.setMaxStackSize(512 * 1024)` in the TypeScript worker.
const MAX_STACK_BYTES: usize = 512 * 1024;
/// The thread's own stack, which must hold the 512 KiB the interpreter may use and the native
/// frames around it. The TypeScript worker runs with `stackSizeMb: 4`.
const THREAD_STACK_BYTES: usize = 4 * 1024 * 1024;
/// `runtime.executePendingJobs(64)`: jobs run per turn before new results are taken in.
const JOBS_PER_TURN: usize = 64;
/// The methods `sky` exposes on Windows Desktop (`WINDOWS_COMPUTER_METHODS`).
const WINDOWS_COMPUTER_METHODS: &str = r#"["list_windows","get_window","list_apps","get_window_state","launch_app","click","press_key","type_text","scroll","set_value","drag","perform_secondary_action","activate_window"]"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Emission {
    Text,
    Image,
}

/// What the script asked the host for, in the order it asked.
#[derive(Debug)]
pub(crate) enum Event {
    Call {
        id: u32,
        json: String,
    },
    Emit {
        kind: Emission,
        json: String,
    },
    /// The script ended: `None` when it finished or called `exit()`.
    Done(Option<Stop>),
}

/// A finished child call's result, serialized, for the script's waiting promise.
pub(crate) struct Delivery {
    pub id: u32,
    pub json: String,
}

pub(crate) struct Job {
    pub code: String,
    /// `ALL_TOOLS` as JSON: `[{name, description}]`.
    pub entries: String,
    pub limits: Limits,
    pub windows_desktop: bool,
}

/// The host's side of one running script.
pub(crate) struct Worker {
    pub events: tokio_mpsc::UnboundedReceiver<Event>,
    deliveries: Option<mpsc::Sender<Delivery>>,
    cancel: Arc<AtomicBool>,
    exited: Option<oneshot::Receiver<()>>,
}

impl Worker {
    pub fn spawn(job: Job) -> std::io::Result<Self> {
        let (events_tx, events) = tokio_mpsc::unbounded_channel();
        let (deliveries_tx, deliveries) = mpsc::channel();
        let (exited_tx, exited) = oneshot::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = cancel.clone();
        std::thread::Builder::new()
            .name("cos-code-mode".to_owned())
            .stack_size(THREAD_STACK_BYTES)
            .spawn(move || {
                run(job, &events_tx, &deliveries, &stop);
                let _ = exited_tx.send(());
            })?;
        Ok(Self {
            events,
            deliveries: Some(deliveries_tx),
            cancel,
            exited: Some(exited),
        })
    }

    /// Hands a child's result to the script. Ignored once the worker stopped.
    pub fn deliver(&self, delivery: Delivery) {
        if let Some(deliveries) = &self.deliveries {
            let _ = deliveries.send(delivery);
        }
    }

    /// Interrupts JavaScript at its next check and wakes a worker waiting for a result.
    pub fn terminate(&mut self) {
        self.cancel.store(true, Ordering::Release);
        self.deliveries = None;
        self.events.close();
    }

    /// Resolves once the thread has dropped its interpreter, as `await worker.terminate()`.
    pub async fn exited(&mut self) {
        if let Some(exited) = self.exited.take() {
            let _ = exited.await;
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// CPU charged to the script: closed slices plus the open one, if any.
#[derive(Default)]
struct Clock {
    used: Cell<Duration>,
    slice_start: Cell<Duration>,
}

impl Clock {
    /// Runs one entry into the interpreter and charges its CPU time (`enter` in the worker).
    fn enter<R>(&self, f: impl FnOnce() -> R) -> R {
        self.slice_start.set(thread_cpu());
        let result = f();
        let spent = thread_cpu().saturating_sub(self.slice_start.get());
        self.used.set(self.used.get() + spent);
        result
    }
}

/// The worker's half of the bridge state. Only the QuickJS thread touches it.
struct Bridge {
    limits: Limits,
    events: tokio_mpsc::UnboundedSender<Event>,
    closed: Cell<bool>,
    fatal: Cell<Option<Stop>>,
    next_id: Cell<u32>,
    waiting: Cell<usize>,
    emitted: Cell<usize>,
    output_bytes: Cell<usize>,
}

impl Bridge {
    fn finish(&self, stop: Option<Stop>) {
        if self.closed.replace(true) {
            return;
        }
        let _ = self.events.send(Event::Done(stop));
    }

    /// `Some(id)` for an admitted call, `None` (undefined) for the other operations.
    fn operation(&self, ctx: &Ctx<'_>, kind: &str, json: String) -> rquickjs::Result<Option<u32>> {
        if self.fatal.get().is_some() {
            return Err(Exception::throw_message(ctx, "Script limit reached"));
        }
        if kind == "exit" {
            self.finish(None);
            return Ok(None);
        }
        if self.closed.get() {
            return Err(Exception::throw_message(ctx, "Script closed"));
        }
        let limits = &self.limits;
        match kind {
            "call" => {
                let id = self.next_id.get().saturating_add(1);
                self.next_id.set(id);
                if id as usize > limits.calls
                    || self.waiting.get() >= limits.concurrent_calls
                    || json.len() > limits.argument_bytes
                {
                    self.fatal.set(Some(Stop::CallLimit));
                    return Err(Exception::throw_message(ctx, "Call limit"));
                }
                self.waiting.set(self.waiting.get() + 1);
                let _ = self.events.send(Event::Call { id, json });
                Ok(Some(id))
            }
            "text" | "image" => {
                let size = json.len();
                self.output_bytes.set(self.output_bytes.get() + size);
                self.emitted.set(self.emitted.get() + 1);
                if self.emitted.get() > limits.output_items
                    || size > limits.result_bytes
                    || self.output_bytes.get() > limits.output_bytes
                {
                    self.fatal.set(Some(Stop::OutputLimit));
                    return Err(Exception::throw_message(ctx, "Output limit"));
                }
                let kind = if kind == "text" {
                    Emission::Text
                } else {
                    Emission::Image
                };
                let _ = self.events.send(Event::Emit { kind, json });
                Ok(None)
            }
            _ => {
                self.fatal.set(Some(Stop::BridgeError));
                Err(Exception::throw_message(ctx, "Invalid bridge operation"))
            }
        }
    }
}

/// The JavaScript values the loop holds between entries. Dropped before the context.
struct Held {
    deliver: Persistent<Function<'static>>,
    execution: Persistent<Promise<'static>>,
}

fn run(
    job: Job,
    events: &tokio_mpsc::UnboundedSender<Event>,
    deliveries: &mpsc::Receiver<Delivery>,
    cancel: &Arc<AtomicBool>,
) {
    let limits = job.limits;
    let bridge = Rc::new(Bridge {
        limits,
        events: events.clone(),
        closed: Cell::new(false),
        fatal: Cell::new(None),
        next_id: Cell::new(0),
        waiting: Cell::new(0),
        emitted: Cell::new(0),
        output_bytes: Cell::new(0),
    });
    let Ok(runtime) = Runtime::new() else {
        bridge.finish(Some(Stop::RuntimeError));
        return;
    };
    runtime.set_memory_limit(limits.memory_bytes);
    runtime.set_max_stack_size(MAX_STACK_BYTES);
    let clock = Rc::new(Clock::default());
    let budget = limits.cpu;
    let interrupt_clock = clock.clone();
    let interrupt_cancel = cancel.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        let open = thread_cpu().saturating_sub(interrupt_clock.slice_start.get());
        interrupt_cancel.load(Ordering::Acquire) || interrupt_clock.used.get() + open > budget
    })));
    let Ok(context) = Context::full(&runtime) else {
        bridge.finish(Some(Stop::RuntimeError));
        return;
    };
    let over_budget = || clock.used.get() > budget;

    let Some(deliver) = clock.enter(|| install(&context, &bridge, &job)) else {
        bridge.finish(Some(Stop::RuntimeError));
        return;
    };
    let Some(execution) = clock.enter(|| evaluate(&context, &job.code)) else {
        let stop = bridge.fatal.get().unwrap_or(if over_budget() {
            Stop::CpuLimit
        } else {
            Stop::ParseError
        });
        bridge.finish(Some(stop));
        return;
    };
    let held = Held { deliver, execution };

    // `check` in the TypeScript worker, run after evaluation and after every delivered result.
    loop {
        if bridge.closed.get() {
            break;
        }
        if let Some(fatal) = bridge.fatal.get() {
            bridge.finish(Some(fatal));
            break;
        }
        if over_budget() {
            bridge.finish(Some(Stop::CpuLimit));
            break;
        }
        let jobs = clock.enter(|| run_jobs(&runtime));
        if jobs.is_err() {
            bridge.finish(Some(if over_budget() {
                Stop::CpuLimit
            } else {
                Stop::ScriptError
            }));
            break;
        }
        let state = clock.enter(|| {
            context.with(|ctx| {
                held.execution
                    .clone()
                    .restore(&ctx)
                    .map(|promise| promise.state())
            })
        });
        match state {
            Ok(PromiseState::Rejected) => {
                let stop = bridge.fatal.get().unwrap_or(if over_budget() {
                    Stop::CpuLimit
                } else {
                    Stop::ScriptError
                });
                bridge.finish(Some(stop));
                break;
            }
            Ok(PromiseState::Resolved) => {
                bridge.finish(bridge.fatal.get());
                break;
            }
            Ok(PromiseState::Pending) => {}
            Err(_) => {
                bridge.finish(Some(Stop::RuntimeError));
                break;
            }
        }
        // More jobs: take in whatever results already arrived, then run the next turn.
        // None: wait for a result. A closed channel means the host stopped this script.
        let delivery = if runtime.is_job_pending() {
            match deliveries.try_recv() {
                Ok(delivery) => delivery,
                Err(mpsc::TryRecvError::Empty) => continue,
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        } else {
            match deliveries.recv() {
                Ok(delivery) => delivery,
                Err(_) => break,
            }
        };
        if bridge.closed.get() {
            break;
        }
        bridge.waiting.set(bridge.waiting.get().saturating_sub(1));
        let delivered = clock.enter(|| {
            context.with(|ctx| {
                let deliver = held.deliver.clone().restore(&ctx)?;
                deliver.call::<_, ()>((delivery.id, delivery.json))
            })
        });
        if delivered.is_err() {
            bridge.finish(Some(Stop::RuntimeError));
            break;
        }
    }
    drop(held);
}

/// Installs `tools`, `ALL_TOOLS`, `text`, `image`, `exit` and, on Windows Desktop, `sky` and
/// `nodeRepl`. Returns the function that resolves a waiting call.
fn install(
    context: &Context,
    bridge: &Rc<Bridge>,
    job: &Job,
) -> Option<Persistent<Function<'static>>> {
    context.with(|ctx| {
        let installed = (|| {
            let factory: Function = ctx.eval(PRELUDE)?;
            let bridge = bridge.clone();
            let operation = Function::new(
                ctx.clone(),
                move |ctx: Ctx<'_>, kind: Coerced<String>, json: Coerced<String>| {
                    bridge.operation(&ctx, &kind.0, json.0)
                },
            )?;
            let deliver: Function = factory.call((
                operation,
                job.entries.as_str(),
                job.windows_desktop,
                WINDOWS_COMPUTER_METHODS,
            ))?;
            rquickjs::Result::Ok(Persistent::save(&ctx, deliver))
        })();
        if installed.is_err() {
            ctx.catch();
        }
        installed.ok()
    })
}

/// Declares and evaluates the script as a module. `None` is what the TypeScript worker calls an
/// evaluation error: a parse failure, or a script with no top-level `await` that threw.
fn evaluate(context: &Context, code: &str) -> Option<Persistent<Promise<'static>>> {
    context.with(|ctx| {
        let evaluated = Module::declare(ctx.clone(), MODULE_NAME, code).and_then(Module::eval);
        match evaluated {
            // QuickJS-ng settles a module without top-level `await` during evaluation, and
            // quickjs-emscripten reports that rejection as the evaluation's own error.
            Ok((_, promise)) if promise.state() != PromiseState::Rejected => {
                Some(Persistent::save(&ctx, promise))
            }
            Ok(_) => None,
            Err(_) => {
                ctx.catch();
                None
            }
        }
    })
}

/// Runs up to [`JOBS_PER_TURN`] jobs. `Err` when a job threw past its own promise.
fn run_jobs(runtime: &Runtime) -> Result<(), ()> {
    for _ in 0..JOBS_PER_TURN {
        match runtime.execute_pending_job() {
            Ok(true) => {}
            Ok(false) => break,
            Err(_) => return Err(()),
        }
    }
    Ok(())
}
