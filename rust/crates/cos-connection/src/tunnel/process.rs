//! Tunnel child processes: their environment, their output lines and stopping their tree.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// Credentials a terminal may have exported. A tunnel child gets them only when the app
/// passes them on purpose (`SECRET_ENV_KEYS` in `exec.ts`).
const SECRET_ENV_KEYS: [&str; 5] = [
    "CONTROL_PLANE_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "CLOUDFLARED_TOKEN",
    "CLOUDFLARED_TUNNEL_TOKEN",
];
/// A line longer than this without a newline is dropped, as `lineReader` drops its carry.
const MAX_LINE: usize = 16_384;
const STOP_WAIT: Duration = Duration::from_secs(3);
/// How long an exited child's last output may take to arrive.
const LAST_LINES: Duration = Duration::from_millis(500);

/// The process environment adapters start children in. Tests give a fake one, so a fake
/// `tunnel-client` on its `PATH` is found the way a real one would be.
#[derive(Clone, Debug)]
pub(crate) struct Host {
    pub env: Vec<(OsString, OsString)>,
    pub temp_dir: PathBuf,
    /// The folder the installer puts the tested tunnel executables in, when there is one.
    pub bundled_dir: Option<PathBuf>,
}

impl Host {
    pub fn current() -> Self {
        Self {
            env: std::env::vars_os().collect(),
            temp_dir: std::env::temp_dir(),
            bundled_dir: None,
        }
    }

    /// An inherited variable, matched the way Windows matches names.
    pub fn var(&self, name: &str) -> Option<&OsStr> {
        self.env
            .iter()
            .find(|(key, _)| same_name(key, name))
            .map(|(_, value)| value.as_os_str())
    }

    /// `childEnv(overrides)`: the inherited environment without stray credentials, then the
    /// values the adapter passes on purpose.
    pub fn child_env(&self, overrides: &[(&str, OsString)]) -> Vec<(OsString, OsString)> {
        let mut env: Vec<(OsString, OsString)> = self
            .env
            .iter()
            .filter(|(key, _)| {
                !SECRET_ENV_KEYS.iter().any(|secret| same_name(key, secret))
                    && !overrides.iter().any(|(name, _)| same_name(key, name))
            })
            .cloned()
            .collect();
        env.extend(
            overrides
                .iter()
                .map(|(name, value)| (OsString::from(name), value.clone())),
        );
        env
    }
}

fn same_name(key: &OsStr, name: &str) -> bool {
    if cfg!(windows) {
        key.to_string_lossy().eq_ignore_ascii_case(name)
    } else {
        key == name
    }
}

/// A started child and a channel of its stdout and stderr lines, trimmed and non-empty.
pub(crate) struct Spawned {
    pub child: Child,
    pub lines: mpsc::UnboundedReceiver<String>,
}

pub(crate) fn spawn(
    binary: &Path,
    args: &[OsString],
    env: Vec<(OsString, OsString)>,
) -> io::Result<Spawned> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: a console child must not open a window (`windowsHide`).
        command.creation_flags(0x0800_0000);
    }
    #[cfg(unix)]
    {
        // Its own process group, so stopping it reaches helpers it starts.
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let (sender, lines) = mpsc::unbounded_channel();
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(forward_lines(stdout, sender.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(forward_lines(stderr, sender));
    }
    Ok(Spawned { child, lines })
}

async fn forward_lines(stream: impl AsyncRead + Unpin, sender: mpsc::UnboundedSender<String>) {
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if buffer.len() > MAX_LINE {
            continue;
        }
        let line = String::from_utf8_lossy(&buffer);
        let line = line.trim_end();
        if !line.is_empty() && sender.send(line.to_owned()).is_err() {
            return;
        }
    }
}

/// The lines an exited child printed that are not read yet. A child's exit can be seen
/// before its pipes are drained, and those last lines usually say why it stopped. Waits
/// until both pipes close, or at most [`LAST_LINES`] when a helper still holds one open.
pub(crate) async fn last_lines(lines: &mut mpsc::UnboundedReceiver<String>) -> Vec<String> {
    let mut rest = Vec::new();
    let _ = tokio::time::timeout(LAST_LINES, async {
        while let Some(line) = lines.recv().await {
            rest.push(line);
        }
    })
    .await;
    rest
}

/// Terminates the child's whole tree and waits for it to exit. False when it is still
/// running after the wait, so a caller never starts a second client beside the first.
pub(crate) async fn stop_tree(child: &mut Child) -> bool {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return true;
    }
    if !terminate_tree(child).await {
        // Already gone, or the tree kill failed: the direct kill is the fallback.
        let _ = child.start_kill();
    }
    tokio::time::timeout(STOP_WAIT, child.wait())
        .await
        .is_ok_and(|status| status.is_ok())
}

#[cfg(windows)]
async fn terminate_tree(child: &Child) -> bool {
    let Some(pid) = child.id() else { return false };
    let mut taskkill = Command::new("taskkill");
    taskkill
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000);
    matches!(taskkill.status().await, Ok(status) if status.success())
}

#[cfg(unix)]
async fn terminate_tree(child: &Child) -> bool {
    let Some(pid) = child.id() else { return false };
    let group = format!("-{pid}");
    matches!(
        Command::new("kill").args(["-TERM", "--", &group]).status().await,
        Ok(status) if status.success()
    )
}

/// The exit code as Node's `exit` event spells it: a number, or `null` after a signal.
pub(crate) fn exit_code(status: io::Result<std::process::ExitStatus>) -> String {
    status
        .ok()
        .and_then(|status| status.code())
        .map_or_else(|| "null".to_owned(), |code| code.to_string())
}
