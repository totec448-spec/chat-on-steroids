//! `exec_command` and `write_stdin`, and the process custody behind them. Unit C1.6 owns this
//! crate (port of codex-rs `unified_exec` by way of `src/main/codex/*`, plus `exec.ts`,
//! `exec-hints.ts`, `env.ts`, `toolchain.ts` and `src/shared/command-allowlist.ts`).
//!
//! [`ExecManager`] owns every process a model started: their output buffers, yield deadlines,
//! session ids and owners. Nothing else spawns or kills them. How a command becomes a process is
//! behind [`Launcher`]: [`FreshProcess`] starts one when the call arrives, as the TypeScript app
//! does, and [`PrestartedPowerShell`] keeps a few PowerShells started ahead of the next calls,
//! which removes most of each call's latency on Windows without sharing a process between
//! commands.

mod allowlist;
mod batch;
mod benign;
mod buffer;
mod env;
mod hints;
mod launch;
mod manager;
mod output;
mod platform;
mod random;
mod session;
mod shell;
mod spare;
mod tools;
mod truncate;

use std::sync::Arc;

use cos_tools::{
    ArgIssue, CallContext, Capability, DynTool, Listing, Requirement, Tool, ToolError, ToolOutput,
    ToolSpec,
};
use serde::Deserialize;

pub use allowlist::{CommandPolicy, PolicyMode};
pub use launch::{Control, Exit, FreshProcess, LaunchError, LaunchRequest, Launched, Launcher};
pub use shell::{Shell, ShellKind};
pub use spare::{DEFAULT_QUIET, DEFAULT_SPARES, PrestartedPowerShell};

/// Lets the terminal sessions this process starts receive Ctrl-C. Windows children inherit an
/// "ignore Ctrl-C" flag from their creator, and Git Bash starts programs with it set, so a
/// Core started from Git Bash would otherwise start terminals that ignore `\u0003`. Call once
/// at startup, before the first session.
pub fn restore_ctrl_c() {
    platform::restore_ctrl_c();
}

pub struct ExecDeps {
    pub launcher: Arc<dyn Launcher>,
}

/// Where the live command policy comes from. The settings own it; exec reads it per call.
pub type PolicySource = Box<dyn Fn() -> CommandPolicy + Send + Sync>;

pub struct ExecManager {
    runtime: manager::Runtime,
    policy: PolicySource,
}

impl ExecManager {
    /// A manager that enforces no command policy. Prefer [`ExecManager::with_policy`].
    pub fn new(deps: ExecDeps) -> Arc<Self> {
        Self::with_policy(deps, Box::new(CommandPolicy::disabled))
    }

    /// A manager that checks every launch against the policy `policy` returns at that moment.
    pub fn with_policy(deps: ExecDeps, policy: PolicySource) -> Arc<Self> {
        Arc::new(Self {
            runtime: manager::Runtime::new(deps.launcher),
            policy,
        })
    }

    /// `exec_command` and `write_stdin`, sharing this manager's sessions.
    pub fn tools(self: &Arc<Self>) -> Vec<Arc<dyn DynTool>> {
        vec![
            Arc::new(ExecCommand {
                manager: self.clone(),
            }),
            Arc::new(WriteStdin {
                manager: self.clone(),
            }),
        ]
    }

    /// Lets the launcher prepare for commands in the default shell (one pre-started shell),
    /// so the first `exec_command` is as fast as the later ones. Call it at start and when
    /// commands are switched on. Returns at once: the child environment is read and the shell
    /// starts on blocking threads. Call it on a Tokio runtime.
    pub fn prestart(&self) {
        let launcher = self.runtime.launcher();
        tokio::task::spawn_blocking(move || launcher.prestart(&tools::default_launch()));
    }

    /// Ends the pre-started shells, for when commands are switched off. Live sessions are not
    /// touched, and later calls still run.
    pub fn release_prestarted(&self) {
        self.runtime.launcher().release();
    }

    /// Shutdown phase 2: ends every process this manager owns, and the pre-started shells.
    /// Bounded: termination is immediate and the wait for exits is capped at 2 s.
    pub async fn terminate_all(&self) {
        self.runtime.terminate_all().await;
    }

    /// Live sessions as `(session id, OS pid)`, oldest id first.
    pub fn live_sessions(&self) -> Vec<(u32, u32)> {
        self.runtime.live()
    }
}

pub struct ExecCommand {
    manager: Arc<ExecManager>,
}

/// The arguments after schema validation: unknown keys are already refused and integers are
/// integers.
#[derive(Debug, Deserialize)]
pub struct ExecCommandArgs {
    pub cmd: Option<String>,
    pub cmds: Option<Vec<String>>,
    pub workdir: Option<String>,
    pub tty: Option<bool>,
    pub yield_time_ms: Option<u64>,
    /// Accepted and ignored, as in the TypeScript app: the default budget always applies.
    pub max_output_tokens: Option<u64>,
    pub shell: Option<String>,
    pub login: Option<bool>,
}

impl Tool for ExecCommand {
    type Args = ExecCommandArgs;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "exec_command",
        listing: Listing::Capability(Capability::Command),
        requires: Requirement::Capability(Capability::Command),
    };

    fn refine(args: &ExecCommandArgs) -> Result<(), Vec<ArgIssue>> {
        if args.cmd.is_some() == args.cmds.is_some() {
            return Err(vec![ArgIssue::new(
                "",
                "exec_command requires exactly one of cmd or cmds",
            )]);
        }
        Ok(())
    }

    async fn call(&self, cx: &CallContext, args: ExecCommandArgs) -> Result<ToolOutput, ToolError> {
        self.manager.exec_command(cx, args).await
    }
}

pub struct WriteStdin {
    manager: Arc<ExecManager>,
}

#[derive(Debug, Deserialize)]
pub struct WriteStdinArgs {
    pub session_id: i64,
    pub chars: Option<String>,
    pub yield_time_ms: Option<u64>,
    /// Accepted and ignored, as in the TypeScript app.
    pub max_output_tokens: Option<u64>,
}

impl Tool for WriteStdin {
    type Args = WriteStdinArgs;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "write_stdin",
        listing: Listing::Capability(Capability::Command),
        requires: Requirement::Capability(Capability::Command),
    };

    async fn call(&self, cx: &CallContext, args: WriteStdinArgs) -> Result<ToolOutput, ToolError> {
        self.manager.write_stdin(cx, args).await
    }
}
