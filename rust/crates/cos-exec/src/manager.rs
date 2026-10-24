//! `UnifiedExecProcessManager` and the custody registry (`unified-exec.ts`, `ownership.ts`).
//!
//! The manager is the only owner of exec processes: it allocates session ids, keeps live
//! sessions and a bounded history of completed ones, and decides which caller may continue a
//! session. Every other crate asks it; nothing else starts or ends these processes.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use cos_tools::Caller;

use crate::batch::{BatchDisplay, BatchMarker};
use crate::launch::{Exit, LaunchRequest, Launcher};
use crate::output::{Status, ToolOutput, chunk_id};
use crate::session::{Collected, Session, SessionSpec};
use crate::truncate::{approx_token_count, approx_tokens_from_byte_count};

const MIN_YIELD: Duration = Duration::from_millis(250);
/// The least an empty `write_stdin` poll waits.
const MIN_EMPTY_YIELD: Duration = Duration::from_millis(5_000);
const MAX_YIELD: Duration = Duration::from_millis(30_000);
/// The longest an empty poll may be asked to wait (`DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS`).
const MAX_EMPTY_YIELD: Duration = Duration::from_millis(300_000);
pub(crate) const DEFAULT_EXEC_YIELD: Duration = Duration::from_millis(10_000);
pub(crate) const DEFAULT_WRITE_STDIN_YIELD: Duration = Duration::from_millis(250);
const MAX_PROCESSES: usize = 64;
const MAX_COMPLETED: usize = 64;
/// One caller may leave at most this many finished background results unread.
pub(crate) const MAX_UNREAD_RESULTS: usize = 4;
/// How long shutdown waits for terminated sessions to report their exit.
const TERMINATE_WAIT: Duration = Duration::from_secs(2);
/// The Ctrl-C character, the one input a pipe session still accepts.
const INTERRUPT: &str = "\u{3}";

/// Who may continue a session. A numeric session id is never authority by itself.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Principal {
    /// A call with no request id and no proven chat (legacy single-chat custody).
    Anonymous,
    /// A request not yet correlated to a chat. It upgrades when the browser plane proves it.
    Request(String),
    /// A proven local session.
    Session(String),
}

impl Principal {
    pub(crate) fn of(caller: &Caller) -> Self {
        match (&caller.chat, &caller.request_id) {
            (Some((_, session)), _) => Self::Session(session.as_str().to_owned()),
            (None, Some(request)) => Self::Request(request.as_str().to_owned()),
            (None, None) => Self::Anonymous,
        }
    }
}

/// Why a caller may not touch a session (`execOwnershipFailure`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CustodyRefusal {
    Unavailable,
    Anonymous,
    Unidentified,
    DifferentOwner,
}

fn custody(owner: Option<&Principal>, asker: &Principal) -> Option<CustodyRefusal> {
    let Some(owner) = owner else {
        return Some(CustodyRefusal::Unavailable);
    };
    match (owner, asker) {
        _ if owner == asker => None,
        (Principal::Anonymous, _) => Some(CustodyRefusal::Anonymous),
        (_, Principal::Anonymous) => Some(CustodyRefusal::Unidentified),
        (Principal::Session(_), Principal::Session(_)) => Some(CustodyRefusal::DifferentOwner),
        _ => Some(CustodyRefusal::Unidentified),
    }
}

/// `UnifiedExecError`, with the two renderings the model sees: `Display` (`write_stdin failed:
/// {err}`) and the derived `Debug` form (`exec_command failed for ...: {err:?}`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ExecError {
    CreateProcess { message: String },
    ProcessFailed { message: String },
    UnknownProcessId { process_id: u32 },
    WriteToStdin,
    StdinClosed,
}

impl ExecError {
    fn create(message: impl Into<String>) -> Self {
        Self::CreateProcess {
            message: message.into(),
        }
    }

    fn already_completed() -> Self {
        Self::ProcessFailed {
            message: "Process already completed; no input was sent. Use empty chars to read its retained output.".into(),
        }
    }

    /// Rust's derived `Debug`, as codex prints it.
    pub(crate) fn debug_text(&self) -> String {
        let quoted = |text: &str| serde_json::to_string(text).unwrap_or_default();
        match self {
            Self::CreateProcess { message } => {
                format!("CreateProcess {{ message: {} }}", quoted(message))
            }
            Self::ProcessFailed { message } => {
                format!("ProcessFailed {{ message: {} }}", quoted(message))
            }
            Self::UnknownProcessId { process_id } => {
                format!("UnknownProcessId {{ process_id: {process_id} }}")
            }
            Self::WriteToStdin => "WriteToStdin".into(),
            Self::StdinClosed => "StdinClosed".into(),
        }
    }
}

impl fmt::Display for ExecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CreateProcess { message } => {
                write!(f, "Failed to create unified exec process: {message}")
            }
            Self::ProcessFailed { message } => write!(f, "Unified exec process failed: {message}"),
            Self::UnknownProcessId { process_id } => write!(f, "Unknown process id {process_id}"),
            Self::WriteToStdin => f.write_str("failed to write to stdin"),
            Self::StdinClosed => f.write_str(
                "stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
            ),
        }
    }
}

/// Decides whether a finished command's non-zero exit is a reported result (ripgrep's "no
/// match") rather than a failure.
pub(crate) type ExitClassifier = Arc<dyn Fn(Exit, &str) -> bool + Send + Sync>;

/// A finished session kept for an explicit reread.
struct Completed {
    id: u32,
    incarnation: u64,
    raw: Vec<u8>,
    display: Option<Vec<u8>>,
    exit: Exit,
    expected_exit: bool,
}

#[derive(Default)]
struct Registry {
    live: HashMap<u32, Arc<Session>>,
    /// Oldest first, at most [`MAX_COMPLETED`].
    completed: VecDeque<Completed>,
    reserved: HashSet<u32>,
    owners: HashMap<u32, Principal>,
    next_incarnation: u64,
}

impl Registry {
    fn completed(&self, id: u32) -> Option<&Completed> {
        self.completed.iter().find(|done| done.id == id)
    }

    fn release(&mut self, id: u32) {
        self.reserved.remove(&id);
        self.live.remove(&id);
        self.completed.retain(|done| done.id != id);
        self.owners.remove(&id);
    }

    fn retain_completed(&mut self, session: &Session) {
        let raw = session.retained_output();
        let exit = session.exit().unwrap_or(None);
        let display = session
            .batch
            .as_ref()
            .map(|marker| BatchDisplay::new(marker).push(&raw, true));
        let expected_exit = session.expected_exit();
        self.live.remove(&session.id);
        self.reserved.remove(&session.id);
        self.completed.push_back(Completed {
            id: session.id,
            incarnation: session.incarnation,
            raw,
            display,
            exit,
            expected_exit,
        });
        while self.completed.len() > MAX_COMPLETED {
            if let Some(oldest) = self.completed.front().map(|done| done.id) {
                self.release(oldest);
            }
        }
    }
}

enum Refreshed {
    Alive,
    Exited(Exit),
    Unknown,
}

pub(crate) struct ExecRequest {
    pub launch: LaunchRequest,
    pub command: String,
    pub cwd: String,
    pub yield_time: Duration,
    pub max_output_tokens: Option<usize>,
    pub batch: Option<BatchMarker>,
    pub classify: Option<ExitClassifier>,
}

pub(crate) struct Runtime {
    launcher: Arc<dyn Launcher>,
    registry: Mutex<Registry>,
}

impl Runtime {
    pub(crate) fn new(launcher: Arc<dyn Launcher>) -> Self {
        Self {
            launcher,
            registry: Mutex::new(Registry::default()),
        }
    }

    pub(crate) fn launcher(&self) -> Arc<dyn Launcher> {
        self.launcher.clone()
    }

    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `rand::rng().random_range(1_000..100_000)`, retried against reservations and history.
    /// Any stale owner of a recycled id is dropped here, before the new call publishes its own.
    pub(crate) fn allocate_id(&self) -> u32 {
        let mut registry = self.registry();
        loop {
            let id = 1_000 + (crate::random::next() % 99_000) as u32;
            if registry.reserved.contains(&id) || registry.completed(id).is_some() {
                continue;
            }
            registry.reserved.insert(id);
            registry.owners.remove(&id);
            return id;
        }
    }

    fn release(&self, id: u32) {
        self.registry().release(id);
    }

    /// `noteExecOwner`.
    pub(crate) fn set_owner(&self, id: u32, owner: Principal) {
        self.registry().owners.insert(id, owner);
    }

    pub(crate) fn custody(&self, id: u32, asker: &Principal) -> Option<CustodyRefusal> {
        custody(self.registry().owners.get(&id), asker)
    }

    /// Sessions this owner started that finished in the background and were never read.
    pub(crate) fn exited_unread(&self, owner: &Principal) -> Vec<u32> {
        if *owner == Principal::Anonymous {
            return Vec::new();
        }
        let registry = self.registry();
        let mut ids: Vec<u32> = registry
            .live
            .values()
            .filter(|session| {
                !session.initial_exec_active()
                    && registry.owners.get(&session.id) == Some(owner)
                    && session.has_exited()
            })
            .map(|session| session.id)
            .collect();
        ids.sort_unstable();
        ids
    }

    /// Live sessions this owner started with exactly this command in exactly this folder.
    pub(crate) fn running_identical(
        &self,
        owner: &Principal,
        command: &str,
        cwd: &str,
    ) -> Vec<(u32, Instant)> {
        if *owner == Principal::Anonymous {
            return Vec::new();
        }
        let registry = self.registry();
        let mut rows: Vec<(u32, Instant)> = registry
            .live
            .values()
            .filter(|session| {
                !session.has_exited()
                    && registry.owners.get(&session.id) == Some(owner)
                    && session.command == command
                    && session.cwd == cwd
            })
            .map(|session| (session.id, session.started))
            .collect();
        rows.sort_unstable_by_key(|(id, _)| *id);
        rows
    }

    fn refresh(&self, id: u32) -> Refreshed {
        let mut registry = self.registry();
        let Some(session) = registry.live.get(&id).cloned() else {
            return Refreshed::Unknown;
        };
        match session.exit() {
            Some(exit) => {
                registry.retain_completed(&session);
                Refreshed::Exited(exit)
            }
            None => Refreshed::Alive,
        }
    }

    /// `execCommand`: launches, waits for the yield deadline or exit, and answers.
    pub(crate) async fn exec(
        &self,
        id: u32,
        request: ExecRequest,
    ) -> Result<ToolOutput, ExecError> {
        {
            let registry = self.registry();
            if registry.reserved.len() > MAX_PROCESSES {
                drop(registry);
                self.release(id);
                return Err(ExecError::create(format!(
                    "too many retained terminal sessions (limit {MAX_PROCESSES}); drain a returned session with write_stdin before starting another"
                )));
            }
            if !registry.reserved.contains(&id) {
                return Err(ExecError::create(
                    "terminal session reservation was lost before launch",
                ));
            }
        }
        let tty = request.launch.tty;
        let launched = match self.launcher.launch(request.launch).await {
            Ok(launched) => launched,
            Err(error) => {
                self.release(id);
                return Err(ExecError::create(error.0));
            }
        };
        let incarnation = {
            let mut registry = self.registry();
            registry.next_incarnation += 1;
            registry.next_incarnation
        };
        let session = Session::start(
            SessionSpec {
                id,
                incarnation,
                command: request.command,
                cwd: request.cwd,
                tty,
                batch: request.batch,
                classify: request.classify,
            },
            launched,
        );
        // The wall time covers the command from the moment it runs, the early-exit grace
        // included, so a command that ends inside the grace reports its real time, not zero.
        // The yield deadline still starts after the grace, as in the TypeScript app.
        let running = Instant::now();
        session.wait_for_early_exit().await;

        let start = Instant::now();
        // Stored before the yield wait, so a cancelled call cannot drop the session.
        let started_alive = !session.has_exited();
        if started_alive {
            self.registry().live.insert(id, session.clone());
        }
        let deadline = start + request.yield_time.clamp(MIN_YIELD, MAX_YIELD);
        let collected = session.collect_until(deadline, false).await;
        let wall_time_ms = running.elapsed().as_secs_f64() * 1000.0;

        let status = if started_alive {
            match self.refresh(id) {
                Refreshed::Alive => Status::Running(id),
                Refreshed::Exited(exit) => Status::Completed { session: id, exit },
                Refreshed::Unknown => return Err(ExecError::UnknownProcessId { process_id: id }),
            }
        } else {
            self.registry().retain_completed(&session);
            Status::Completed {
                session: id,
                exit: session.exit().unwrap_or(None),
            }
        };
        if matches!(status, Status::Running(_)) {
            session.mark_answered();
        }
        Ok(answer(
            &collected,
            status,
            wall_time_ms,
            request.max_output_tokens,
            session.expected_exit(),
        ))
    }

    fn replay(
        &self,
        id: u32,
        input: &str,
        incarnation: Option<u64>,
        max_output_tokens: Option<usize>,
    ) -> Option<Result<ToolOutput, ExecError>> {
        let registry = self.registry();
        let saved = registry.completed(id)?;
        if incarnation.is_some_and(|incarnation| incarnation != saved.incarnation) {
            return Some(Err(ExecError::UnknownProcessId { process_id: id }));
        }
        if !input.is_empty() {
            return Some(Err(ExecError::already_completed()));
        }
        let output = saved.display.clone().unwrap_or_else(|| saved.raw.clone());
        Some(Ok(ToolOutput {
            chunk_id: chunk_id(),
            wall_time_ms: 0.0,
            status: Status::Completed {
                session: id,
                exit: saved.exit,
            },
            replayed: true,
            expected_exit: saved.expected_exit,
            original_token_count: Some(approx_token_count(&String::from_utf8_lossy(&output))),
            output,
            raw: saved.raw.clone(),
            max_output_tokens,
            omitted_bytes: None,
        }))
    }

    /// `writeStdin`: sends input (or nothing, for a poll) and collects what follows.
    pub(crate) async fn write_stdin(
        &self,
        id: u32,
        input: &str,
        yield_time: Duration,
        max_output_tokens: Option<usize>,
    ) -> Result<ToolOutput, ExecError> {
        if let Some(saved) = self.replay(id, input, None, max_output_tokens) {
            return saved;
        }
        let session = self
            .registry()
            .live
            .get(&id)
            .cloned()
            .ok_or(ExecError::UnknownProcessId { process_id: id })?;
        let _interaction = session.interaction.lock().await;
        if let Some(saved) = self.replay(id, input, Some(session.incarnation), max_output_tokens) {
            return saved;
        }
        let current = self.registry().live.get(&id).cloned();
        if !current.is_some_and(|current| Arc::ptr_eq(&current, &session)) {
            return Err(ExecError::UnknownProcessId { process_id: id });
        }

        let mut status_after_write = None;
        if !input.is_empty() {
            if session.has_exited() {
                return Err(ExecError::already_completed());
            }
            if !session.tty {
                if input != INTERRUPT {
                    return Err(ExecError::StdinClosed);
                }
                // A Windows pipe child has no console for Ctrl-C: end its tree instead.
                session.terminate();
            } else if session.write(input.as_bytes()).is_ok() {
                // A brief window so the child's reaction lands in the poll below.
                tokio::time::sleep(Duration::from_millis(100)).await;
            } else {
                match self.refresh(id) {
                    Refreshed::Exited(exit) => status_after_write = Some(exit),
                    Refreshed::Alive | Refreshed::Unknown => return Err(ExecError::WriteToStdin),
                }
            }
        }

        let base = yield_time.max(MIN_YIELD);
        let yield_time = if input.is_empty() {
            base.clamp(MIN_EMPTY_YIELD, MAX_EMPTY_YIELD)
        } else {
            base.min(MAX_YIELD)
        };
        let start = Instant::now();
        // An empty poll returns as soon as anything arrives; a write gathers one response.
        let collected = session
            .collect_until(start + yield_time, input.is_empty())
            .await;
        let wall_time_ms = start.elapsed().as_secs_f64() * 1000.0;

        let status = match status_after_write {
            Some(exit) => Status::Completed { session: id, exit },
            None => match self.refresh(id) {
                Refreshed::Alive => Status::Running(id),
                Refreshed::Exited(exit) => Status::Completed { session: id, exit },
                Refreshed::Unknown => match session.exit() {
                    Some(exit) => Status::Completed { session: id, exit },
                    None => return Err(ExecError::UnknownProcessId { process_id: id }),
                },
            },
        };
        Ok(answer(
            &collected,
            status,
            wall_time_ms,
            max_output_tokens,
            session.expected_exit(),
        ))
    }

    /// Shutdown: ends every live session's process tree and forgets every id. Bounded: job
    /// termination is immediate, and the wait for exits is capped.
    pub(crate) async fn terminate_all(&self) {
        let sessions: Vec<Arc<Session>> = {
            let mut registry = self.registry();
            let sessions = registry.live.values().cloned().collect();
            *registry = Registry {
                next_incarnation: registry.next_incarnation,
                ..Registry::default()
            };
            sessions
        };
        self.launcher.shutdown();
        let running: Vec<Arc<Session>> = sessions
            .into_iter()
            .filter(|session| !session.has_exited())
            .collect();
        for session in &running {
            session.terminate();
        }
        let waits = running
            .iter()
            .map(|session| session.wait_for_exit(TERMINATE_WAIT));
        for wait in waits {
            wait.await;
        }
    }

    /// Live sessions, oldest id first: id and OS pid (`listProcesses`).
    pub(crate) fn live(&self) -> Vec<(u32, u32)> {
        let registry = self.registry();
        let mut rows: Vec<(u32, u32)> = registry
            .live
            .values()
            .filter(|session| !session.has_exited())
            .map(|session| (session.id, session.pid()))
            .collect();
        rows.sort_unstable();
        rows
    }
}

fn answer(
    collected: &Collected,
    status: Status,
    wall_time_ms: f64,
    max_output_tokens: Option<usize>,
    expected_exit: bool,
) -> ToolOutput {
    let visible = collected.visible();
    let omitted = visible.omitted_bytes();
    ToolOutput {
        chunk_id: chunk_id(),
        wall_time_ms,
        status,
        replayed: false,
        expected_exit,
        output: visible.to_bytes_with_omission_marker(),
        raw: collected.raw.to_bytes_with_omission_marker(),
        max_output_tokens,
        original_token_count: Some(approx_tokens_from_byte_count(visible.total_bytes())),
        omitted_bytes: (omitted > 0).then_some(omitted),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str) -> Principal {
        Principal::Request(id.into())
    }

    #[test]
    fn custody_admits_only_the_same_principal() {
        let session = Principal::Session("s1".into());
        assert_eq!(custody(None, &session), Some(CustodyRefusal::Unavailable));
        assert_eq!(custody(Some(&session), &session), None);
        assert_eq!(
            custody(Some(&Principal::Anonymous), &Principal::Anonymous),
            None
        );
        assert_eq!(
            custody(Some(&Principal::Anonymous), &session),
            Some(CustodyRefusal::Anonymous)
        );
        assert_eq!(
            custody(Some(&session), &Principal::Anonymous),
            Some(CustodyRefusal::Unidentified)
        );
        assert_eq!(
            custody(Some(&session), &Principal::Session("s2".into())),
            Some(CustodyRefusal::DifferentOwner)
        );
        assert_eq!(
            custody(Some(&request("a")), &request("b")),
            Some(CustodyRefusal::Unidentified)
        );
        assert_eq!(
            custody(Some(&request("a")), &session),
            Some(CustodyRefusal::Unidentified)
        );
    }

    #[test]
    fn errors_render_like_the_rust_enum() {
        let error = ExecError::create("too \"many\"");
        assert_eq!(
            error.debug_text(),
            r#"CreateProcess { message: "too \"many\"" }"#
        );
        assert_eq!(
            error.to_string(),
            "Failed to create unified exec process: too \"many\""
        );
        assert_eq!(
            ExecError::UnknownProcessId { process_id: 7 }.debug_text(),
            "UnknownProcessId { process_id: 7 }"
        );
    }
}
