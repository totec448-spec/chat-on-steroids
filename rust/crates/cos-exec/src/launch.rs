//! How a command becomes a running process. [`ExecManager`](crate::ExecManager) only sees
//! [`Launched`]: an output stream, an exit code and a handle to write to or end the process, so a
//! fresh child and a pre-started one look the same to the session logic.

use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;

use bytes::Bytes;
use cos_tools::BoxFuture;
use tokio::sync::{mpsc, oneshot};

use crate::shell::{Shell, ShellKind};

/// One command to start, after allowlist checks, quoting repair and batching.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchRequest {
    pub shell: Shell,
    /// The script the shell runs. A PowerShell script already carries its UTF-8 prefix.
    pub script: String,
    /// Run the shell's login profile (`-l`, or PowerShell without `-NoProfile`).
    pub login: bool,
    pub working_folder: PathBuf,
    /// The child's whole environment.
    pub env: Vec<(OsString, OsString)>,
    /// A pseudo-terminal (ConPTY) instead of pipes. Pipe mode starts with stdin closed.
    pub tty: bool,
}

/// The process could not be started (`UnifiedExecError::CreateProcess`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchError(pub String);

impl fmt::Display for LaunchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LaunchError {}

impl From<std::io::Error> for LaunchError {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

/// How the process ended: its exit code, or `None` when the OS could not report one.
pub type Exit = Option<i64>;

/// What a running process lets its owner do.
pub trait Control: Send + Sync {
    /// The OS process id of the session leader.
    fn pid(&self) -> u32;
    /// Writes to the terminal (PTY sessions). Pipe sessions have no stdin and refuse.
    fn write(&self, data: &[u8]) -> std::io::Result<()>;
    /// Ends the process and every descendant still in its job. Safe to call more than once.
    fn terminate(&self);
}

pub struct Launched {
    /// Output in arrival order; stdout and stderr interleave as they arrived. The channel
    /// closes once every output stream has closed.
    pub output: mpsc::UnboundedReceiver<Bytes>,
    pub exit: oneshot::Receiver<Exit>,
    pub control: Box<dyn Control>,
}

/// How commands become processes.
pub trait Launcher: Send + Sync + 'static {
    fn launch(&self, request: LaunchRequest) -> BoxFuture<'_, Result<Launched, LaunchError>>;

    /// Gets ready for calls shaped like `request` (its script and folder do not matter), so the
    /// first of them is as fast as the later ones. Returns at once; call it on a Tokio runtime.
    fn prestart(&self, _request: &LaunchRequest) {}

    /// Ends what the launcher keeps for later calls, as `prestart` would have it; it stays
    /// usable, and `prestart` or the next call prepares again.
    fn release(&self) {}

    /// Ends anything the launcher keeps for later calls (shutdown).
    fn shutdown(&self) {}
}

/// One new OS process per command, started when the call arrives: what the TypeScript app does,
/// and the parity baseline every other launcher is measured against.
pub struct FreshProcess;

impl Launcher for FreshProcess {
    fn launch(&self, request: LaunchRequest) -> BoxFuture<'_, Result<Launched, LaunchError>> {
        Box::pin(async move { spawn(&request) })
    }
}

/// The argv `request` runs as (`derive_exec_args`).
pub(crate) fn argv(request: &LaunchRequest) -> Vec<String> {
    crate::shell::derive_exec_args(&request.shell, &request.script, request.login)
}

pub(crate) fn spawn(request: &LaunchRequest) -> Result<Launched, LaunchError> {
    let argv = argv(request);
    // cmd.exe parses its own command line and never understood MSVCRT's `\"`, so it gets the
    // text exactly as written.
    let verbatim = request.shell.kind == ShellKind::Cmd;
    if request.tty {
        crate::platform::spawn_pty(&argv, verbatim, request)
    } else {
        crate::platform::spawn_pipes(&argv, verbatim, request)
    }
}
