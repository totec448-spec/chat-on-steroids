//! One running exec session (`UnifiedExecProcess`): its output buffers, its exit, and the
//! `collect_output_until_deadline` loop that a call waits in.
//!
//! The unread buffer is drained by whoever polls it, so a chunk reaches exactly one call. A
//! separate bounded history keeps everything for an explicit reread after completion.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::batch::{BatchDisplay, BatchMarker};
use crate::buffer::{COMPLETED_OUTPUT_BYTES, HeadTailBuffer};
use crate::launch::{Control, Exit, Launched};
use crate::manager::ExitClassifier;

/// How long a new process may take to finish before it is stored as live
/// (`EARLY_EXIT_GRACE_PERIOD`).
const EARLY_EXIT_GRACE: Duration = Duration::from_millis(150);
/// After exit, how long the output streams get to close (`POST_EXIT_CLOSE_WAIT_CAP`).
const POST_EXIT_CLOSE_WAIT: Duration = Duration::from_millis(50);

#[derive(Default)]
struct State {
    unread: HeadTailBuffer,
    /// The batch display stream (delimiters removed), when this is a batch.
    unread_display: Option<HeadTailBuffer>,
    display: Option<BatchDisplay>,
    history: HeadTailBuffer<COMPLETED_OUTPUT_BYTES>,
    /// `Some` once the process has exited.
    exit: Option<Exit>,
    output_closed: bool,
}

/// What one drain of the unread buffers took.
pub(crate) struct Drained {
    pub raw: HeadTailBuffer,
    pub display: Option<HeadTailBuffer>,
}

/// What a call collected before its deadline.
pub(crate) struct Collected {
    pub raw: HeadTailBuffer,
    pub display: Option<HeadTailBuffer>,
}

impl Collected {
    /// What the model reads: the display stream of a batch, otherwise the raw output.
    pub(crate) fn visible(&self) -> &HeadTailBuffer {
        self.display.as_ref().unwrap_or(&self.raw)
    }
}

pub(crate) struct Session {
    pub id: u32,
    pub incarnation: u64,
    /// The command as the model wrote it, for duplicate detection and status.
    pub command: String,
    /// The virtual working folder.
    pub cwd: String,
    pub tty: bool,
    pub batch: Option<BatchMarker>,
    /// Whether a non-zero exit is a reported result rather than a failure.
    pub classify: Option<ExitClassifier>,
    pub started: Instant,
    control: Box<dyn Control>,
    state: Mutex<State>,
    changed: watch::Sender<()>,
    /// Reads and writes against one session must not overlap: they share a draining buffer.
    pub interaction: tokio::sync::Mutex<()>,
    /// The `exec_command` that started this session still owns its first answer.
    pub initial_exec_active: AtomicBool,
}

pub(crate) struct SessionSpec {
    pub id: u32,
    pub incarnation: u64,
    pub command: String,
    pub cwd: String,
    pub tty: bool,
    pub batch: Option<BatchMarker>,
    pub classify: Option<ExitClassifier>,
}

impl Session {
    /// Wraps a launched process and starts pumping its output and exit into the session.
    pub(crate) fn start(spec: SessionSpec, launched: Launched) -> Arc<Self> {
        let Launched {
            mut output,
            exit,
            control,
        } = launched;
        let state = State {
            unread_display: spec.batch.as_ref().map(|_| HeadTailBuffer::default()),
            display: spec.batch.as_ref().map(BatchDisplay::new),
            ..State::default()
        };
        let session = Arc::new(Self {
            id: spec.id,
            incarnation: spec.incarnation,
            command: spec.command,
            cwd: spec.cwd,
            tty: spec.tty,
            batch: spec.batch,
            classify: spec.classify,
            started: Instant::now(),
            control,
            state: Mutex::new(state),
            changed: watch::Sender::new(()),
            interaction: tokio::sync::Mutex::new(()),
            initial_exec_active: AtomicBool::new(true),
        });
        let pump = session.clone();
        tokio::spawn(async move {
            while let Some(chunk) = output.recv().await {
                pump.push(&chunk);
            }
            pump.close_output();
        });
        let waiter = session.clone();
        tokio::spawn(async move {
            let code = exit.await.unwrap_or(None);
            waiter.signal_exit(code);
        });
        session
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // A panic while holding this lock leaves only buffers behind; keep serving them.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn push(&self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        {
            let mut state = self.state();
            let state = &mut *state;
            state.history.push_chunk(chunk);
            state.unread.push_chunk(chunk);
            if let (Some(display), Some(unread)) =
                (state.display.as_mut(), state.unread_display.as_mut())
            {
                unread.push_chunk(&display.push(chunk, false));
            }
        }
        self.changed.send_replace(());
    }

    fn close_output(&self) {
        {
            let mut state = self.state();
            let state = &mut *state;
            if state.output_closed {
                return;
            }
            if let (Some(display), Some(unread)) =
                (state.display.as_mut(), state.unread_display.as_mut())
            {
                unread.push_chunk(&display.push(&[], true));
            }
            state.output_closed = true;
        }
        self.changed.send_replace(());
    }

    fn signal_exit(&self, code: Exit) {
        {
            let mut state = self.state();
            if state.exit.is_some() {
                return;
            }
            state.exit = Some(code);
        }
        self.changed.send_replace(());
    }

    /// `Some(code)` once the process has exited.
    pub(crate) fn exit(&self) -> Option<Exit> {
        self.state().exit
    }

    pub(crate) fn has_exited(&self) -> bool {
        self.exit().is_some()
    }

    pub(crate) fn pid(&self) -> u32 {
        self.control.pid()
    }

    fn drain(&self) -> (Drained, bool, bool) {
        let mut state = self.state();
        let drained = Drained {
            raw: state.unread.take(),
            display: state.unread_display.as_mut().map(HeadTailBuffer::take),
        };
        (drained, state.exit.is_some(), state.output_closed)
    }

    /// `benignExit`: only a finished session whose output closed and was kept whole can prove
    /// a non-zero exit benign.
    pub(crate) fn expected_exit(&self) -> bool {
        let Some(classify) = &self.classify else {
            return false;
        };
        let (exit, text) = {
            let state = self.state();
            match state.exit {
                Some(exit) if state.output_closed && state.history.omitted_bytes() == 0 => (
                    exit,
                    String::from_utf8_lossy(&state.history.to_bytes()).into_owned(),
                ),
                _ => return false,
            }
        };
        classify(exit, &text)
    }

    /// Everything this session printed, bounded, for a completed-session reread.
    pub(crate) fn retained_output(&self) -> Vec<u8> {
        self.state().history.to_bytes_with_omission_marker()
    }

    pub(crate) fn write(&self, data: &[u8]) -> std::io::Result<()> {
        self.control.write(data)
    }

    pub(crate) fn terminate(&self) {
        self.control.terminate();
    }

    /// Waits up to [`EARLY_EXIT_GRACE`] for the process to finish, so a command that is
    /// already over is never stored as live.
    pub(crate) async fn wait_for_early_exit(&self) {
        let mut changed = self.changed.subscribe();
        let _ = tokio::time::timeout(EARLY_EXIT_GRACE, async {
            loop {
                changed.borrow_and_update();
                if self.has_exited() {
                    return;
                }
                if changed.changed().await.is_err() {
                    return;
                }
            }
        })
        .await;
    }

    /// Waits until the process has exited, at most `limit`.
    pub(crate) async fn wait_for_exit(&self, limit: Duration) {
        let mut changed = self.changed.subscribe();
        let _ = tokio::time::timeout(limit, async {
            loop {
                changed.borrow_and_update();
                if self.has_exited() {
                    return;
                }
                if changed.changed().await.is_err() {
                    return;
                }
            }
        })
        .await;
    }

    /// `collect_output_until_deadline`. After exit the loop stops waiting for the deadline and
    /// gives the streams at most 50 ms to close, so a 20 ms command never waits out its yield.
    /// With `first_output`, it returns as soon as anything arrives (an empty `write_stdin` poll).
    pub(crate) async fn collect_until(&self, deadline: Instant, first_output: bool) -> Collected {
        let mut changed = self.changed.subscribe();
        let mut collected = HeadTailBuffer::default();
        let mut display: Option<HeadTailBuffer> = None;
        let mut exit_seen = self.has_exited();
        let mut post_exit_deadline: Option<Instant> = None;
        loop {
            // Mark the current version seen before draining, so a chunk that lands after the
            // drain wakes the wait below.
            changed.borrow_and_update();
            let (drained, exited, closed) = self.drain();
            if let Some(part) = drained.display {
                display
                    .get_or_insert_with(HeadTailBuffer::default)
                    .push_buffer(part);
            }
            exit_seen |= exited;
            if !drained.raw.is_empty() {
                collected.push_buffer(drained.raw);
                if first_output || Instant::now() >= deadline {
                    break;
                }
                continue;
            }
            if exit_seen && closed {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let wait_until = if exit_seen {
                let close_by = *post_exit_deadline
                    .get_or_insert(now + (deadline - now).min(POST_EXIT_CLOSE_WAIT));
                if now >= close_by {
                    break;
                }
                close_by
            } else {
                deadline
            };
            let woke = tokio::time::timeout_at(wait_until.into(), changed.changed()).await;
            if !matches!(woke, Ok(Ok(()))) {
                break;
            }
        }
        Collected {
            raw: collected,
            display,
        }
    }

    pub(crate) fn mark_answered(&self) {
        self.initial_exec_active.store(false, Ordering::SeqCst);
    }

    pub(crate) fn initial_exec_active(&self) -> bool {
        self.initial_exec_active.load(Ordering::SeqCst)
    }
}
