//! [`PrestartedPowerShell`]: still one new process per command, but started before the command
//! arrives. Starting Windows PowerShell 5.1 is most of an `exec_command` (about 450 to 600 ms
//! on the baseline machine); a spare that has already loaded its engine and formatting system
//! answers in about 70 ms.
//!
//! The pool is adaptive. [`Launcher::prestart`] starts one spare, so the first call is fast
//! while an unused app holds one PowerShell. The first call raises the pool to its busy size,
//! and each spare taken is replaced in the background straight away, so calls in quick
//! succession do not each wait for the replacement of the one before. After a quiet period with
//! no calls the pool ends its surplus spares and keeps one. [`Launcher::release`] ends them all.
//!
//! The spare waits on a named pipe for its working folder and script, sets both, and runs the
//! script dot-sourced so it behaves as `-Command` would: `$?` of the last statement decides the
//! exit code, `exit N` ends the process with `N`, and parse errors print as the console host
//! prints them. Stdin stays the null device, as for a fresh child, so a program reading stdin
//! (or `rg` deciding whether to search it) sees no input. Every command still gets its own
//! process, environment, working folder and job: nothing leaks from one command to the next.
//!
//! One measured difference remains: a `Write-Error` issued at the top level of a script (not in a
//! function) is labelled with the script text plus the line that captures `$?`, and carries a
//! position line. Its message and the exit code are unchanged.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use cos_tools::BoxFuture;

use crate::launch::{FreshProcess, LaunchError, LaunchRequest, Launched, Launcher};
use crate::shell::{Shell, ShellKind};

/// How long a call waits for a spare that has not reached its pipe yet before it gives up on it
/// and starts a fresh process.
#[cfg_attr(not(windows), allow(dead_code))]
const CONNECT_LIMIT: Duration = Duration::from_secs(15);

/// How many spares wait while commands are being run. The README has the measurement behind
/// the number and what each waiting spare costs.
pub const DEFAULT_SPARES: usize = 3;

/// How many spares wait before the first call and after a quiet period.
const IDLE_SPARES: usize = 1;

/// How long the pool stays at its busy size after the last call. The README has the
/// measurement behind it.
pub const DEFAULT_QUIET: Duration = Duration::from_secs(120);

/// A pool of pre-started PowerShells, each used for exactly one command. Every spare runs in
/// its own Job Object, so it dies with the process that owns the launcher, even a killed one.
pub struct PrestartedPowerShell {
    shared: Arc<Shared>,
}

struct Shared {
    busy: usize,
    quiet: Duration,
    pool: Mutex<Pool>,
}

/// What a command must share with a spare to use it: the shell and the exact environment.
#[derive(Clone, PartialEq, Eq)]
struct Shape {
    shell: Shell,
    env: Vec<(OsString, OsString)>,
}

impl Shape {
    fn of(request: &LaunchRequest) -> Self {
        Self {
            shell: request.shell.clone(),
            env: request.env.clone(),
        }
    }
}

#[derive(Default)]
struct Pool {
    /// What every spare in `waiting`, and every start of this `generation`, was made for.
    shape: Option<Shape>,
    /// How many spares should wait: none until `prestart`, [`IDLE_SPARES`] while quiet, the
    /// busy size after a call.
    target: usize,
    /// Oldest first: the front is the one closest to ready.
    waiting: VecDeque<Spare>,
    /// Spares whose process is still being created.
    starting: usize,
    /// Bumped when the shape changes and at shutdown, so a start begun before is ended on
    /// arrival instead of joining the pool.
    generation: u64,
    last_call: Option<Instant>,
    /// A task is waiting for the quiet period to end.
    shrinking: bool,
    /// Shut down: no spare is started or handed out again.
    closed: bool,
}

struct Spare {
    pipe: String,
    launched: Launched,
}

impl Pool {
    /// Makes `shape` the pool's shape and returns the spares made for another one.
    fn reshape(&mut self, shape: Shape) -> Vec<Spare> {
        if self.closed || self.shape.as_ref() == Some(&shape) {
            return Vec::new();
        }
        self.shape = Some(shape);
        self.generation += 1;
        self.waiting.drain(..).collect()
    }

    /// Lowers the target to `target` and returns the oldest spares above it.
    fn shrink_to(&mut self, target: usize) -> Vec<Spare> {
        self.target = self.target.min(target);
        let surplus = self.waiting.len().saturating_sub(self.target);
        self.waiting.drain(..surplus).collect()
    }
}

fn end(spares: Vec<Spare>) {
    for spare in spares {
        spare.launched.control.terminate();
    }
}

impl Default for PrestartedPowerShell {
    fn default() -> Self {
        Self::with_pool(DEFAULT_SPARES, DEFAULT_QUIET)
    }
}

impl PrestartedPowerShell {
    pub fn new() -> Self {
        Self::default()
    }

    /// A pool that keeps `busy` PowerShells waiting (at least one) from a call until `quiet`
    /// has passed without one.
    pub fn with_pool(busy: usize, quiet: Duration) -> Self {
        Self {
            shared: Arc::new(Shared {
                busy: busy.max(IDLE_SPARES),
                quiet,
                pool: Mutex::default(),
            }),
        }
    }

    fn eligible(request: &LaunchRequest) -> bool {
        cfg!(windows)
            && request.shell.kind == ShellKind::PowerShell
            && !request.tty
            && !request.login
    }
}

impl Shared {
    fn pool(&self) -> MutexGuard<'_, Pool> {
        self.pool
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Starts as many spares as the pool is short of its target, each on a blocking thread so
    /// no call waits for process creation. Safe to repeat: it counts what waits and what is
    /// starting.
    fn top_up(self: &Arc<Self>, pool: &mut Pool) {
        if pool.closed {
            return;
        }
        let Some(shape) = &pool.shape else {
            return;
        };
        let missing = pool
            .target
            .saturating_sub(pool.waiting.len() + pool.starting);
        for _ in 0..missing {
            let shared = self.clone();
            let shape = shape.clone();
            let generation = pool.generation;
            tokio::task::spawn_blocking(move || shared.start(shape, generation));
        }
        pool.starting += missing;
    }

    fn start(self: &Arc<Self>, shape: Shape, generation: u64) {
        let pipe = format!("cos-exec-{}-{}", std::process::id(), crate::random::hex(8));
        let template = LaunchRequest {
            shell: shape.shell,
            script: bootstrap(&pipe),
            login: false,
            working_folder: std::env::temp_dir(),
            env: shape.env,
            tty: false,
        };
        let launched = crate::launch::spawn(&template);
        let mut pool = self.pool();
        pool.starting -= 1;
        // A failed start is not retried here, so a missing shell cannot spin; the next call
        // tries again.
        let Ok(launched) = launched else {
            return;
        };
        let unwanted =
            pool.closed || pool.generation != generation || pool.waiting.len() >= pool.target;
        if unwanted {
            self.top_up(&mut pool);
            drop(pool);
            launched.control.terminate();
            return;
        }
        pool.waiting.push_back(Spare { pipe, launched });
    }

    /// Records a call: the pool grows to its busy size and starts timing the quiet period.
    fn note_call(self: &Arc<Self>, pool: &mut Pool) {
        pool.target = self.busy;
        pool.last_call = Some(Instant::now());
        if !pool.shrinking {
            pool.shrinking = true;
            tokio::spawn(shrink_when_quiet(Arc::downgrade(self)));
        }
    }

    fn close(&self) {
        let ended = {
            let mut pool = self.pool();
            pool.closed = true;
            pool.generation += 1;
            pool.shrink_to(0)
        };
        end(ended);
    }
}

/// Waits until `quiet` has passed since the last call, then shrinks the pool to its idle size.
/// Ends with the pool, or once it has shrunk; the next call starts another.
async fn shrink_when_quiet(shared: Weak<Shared>) {
    loop {
        let wake = {
            let Some(shared) = shared.upgrade() else {
                return;
            };
            let pool = shared.pool();
            match pool.last_call {
                Some(last) if !pool.closed => last + shared.quiet,
                _ => return,
            }
        };
        tokio::time::sleep_until(tokio::time::Instant::from_std(wake)).await;
        let Some(shared) = shared.upgrade() else {
            return;
        };
        let surplus = {
            let mut pool = shared.pool();
            let quiet = pool
                .last_call
                .is_none_or(|last| last.elapsed() >= shared.quiet);
            if !quiet {
                continue;
            }
            pool.shrinking = false;
            pool.shrink_to(IDLE_SPARES)
        };
        end(surplus);
        return;
    }
}

impl Launcher for PrestartedPowerShell {
    fn prestart(&self, request: &LaunchRequest) {
        if !Self::eligible(request) {
            return;
        }
        let stale = {
            let mut pool = self.shared.pool();
            let stale = pool.reshape(Shape::of(request));
            pool.target = pool.target.max(IDLE_SPARES);
            self.shared.top_up(&mut pool);
            stale
        };
        end(stale);
    }

    fn launch(&self, request: LaunchRequest) -> BoxFuture<'_, Result<Launched, LaunchError>> {
        Box::pin(async move {
            if !Self::eligible(&request) {
                return FreshProcess.launch(request).await;
            }
            let (chosen, stale) = {
                let mut pool = self.shared.pool();
                let stale = pool.reshape(Shape::of(&request));
                let chosen = choose(&mut pool.waiting);
                if !pool.closed {
                    self.shared.note_call(&mut pool);
                }
                self.shared.top_up(&mut pool);
                (chosen, stale)
            };
            end(stale);
            match chosen {
                Some((spare, connected)) => match hand_over(spare, connected, &request).await {
                    Ok(launched) => Ok(launched),
                    Err(()) => crate::launch::spawn(&request),
                },
                None => crate::launch::spawn(&request),
            }
        })
    }

    fn release(&self) {
        let ended = self.shared.pool().shrink_to(0);
        end(ended);
    }

    fn shutdown(&self) {
        self.shared.close();
    }
}

impl Drop for PrestartedPowerShell {
    fn drop(&mut self) {
        self.shared.close();
    }
}

/// The bootstrap a spare runs while it waits. `$?` is captured by a line appended after the
/// script, because the console host reads it after the last statement and the dot-sourcing
/// statement would otherwise reset it; `SetShouldExit` lets the host flush formatted output
/// before it exits, which `exit` would cut off.
fn bootstrap(pipe: &str) -> String {
    [
        "$null = [pscustomobject]@{a=1} | Out-String".to_owned(),
        format!(
            "$__cos_p = [System.IO.Pipes.NamedPipeServerStream]::new('{pipe}', [System.IO.Pipes.PipeDirection]::In)"
        ),
        "$__cos_p.WaitForConnection()".to_owned(),
        "$__cos_r = [System.IO.StreamReader]::new($__cos_p, [System.Text.UTF8Encoding]::new($false))".to_owned(),
        "$__cos_d = $__cos_r.ReadLine(); $__cos_t = $__cos_r.ReadToEnd(); $__cos_r.Dispose()".to_owned(),
        "Set-Location -LiteralPath $__cos_d; [Environment]::CurrentDirectory = $__cos_d".to_owned(),
        "[AppDomain]::CurrentDomain.SetData('cos.exec', $__cos_t)".to_owned(),
        "Remove-Variable __cos_p, __cos_r, __cos_d, __cos_t".to_owned(),
        "try { $null = [ScriptBlock]::Create([AppDomain]::CurrentDomain.GetData('cos.exec')) } catch { $__cos_x = $_.Exception.InnerException.Errors[0]; [System.Management.Automation.ErrorRecord]::new([System.Management.Automation.ParentContainsErrorRecordException]::new($__cos_x.Message), $__cos_x.ErrorId, [System.Management.Automation.ErrorCategory]::ParserError, $null) | Out-Default; exit 1 }".to_owned(),
        ". ([ScriptBlock]::Create([AppDomain]::CurrentDomain.GetData('cos.exec') + \"`n`$global:__cos_q = `$?; [AppDomain]::CurrentDomain.SetData('cos.exec', `$null)\"))".to_owned(),
        "if ($global:__cos_q -eq $false) { $host.SetShouldExit(1) }".to_owned(),
    ]
    .join("\n")
}

#[cfg(windows)]
type Connection = tokio::net::windows::named_pipe::NamedPipeClient;
#[cfg(not(windows))]
type Connection = std::convert::Infallible;

/// Connects to the spare's pipe if it is already waiting there. Never waits.
#[cfg(windows)]
fn connect(spare: &Spare) -> Option<Connection> {
    tokio::net::windows::named_pipe::ClientOptions::new()
        .read(false)
        .write(true)
        .open(format!(r"\\.\pipe\{}", spare.pipe))
        .ok()
}

#[cfg(not(windows))]
fn connect(_spare: &Spare) -> Option<Connection> {
    None
}

/// The spare a command uses: the youngest one already waiting on its pipe, connected, because a
/// spare that has waited longer runs its command measurably slower (see the README). With none
/// ready, the oldest, which is closest to ready.
fn choose(waiting: &mut VecDeque<Spare>) -> Option<(Spare, Option<Connection>)> {
    for index in (0..waiting.len()).rev() {
        if let Some(connection) = waiting.get(index).and_then(connect) {
            return waiting.remove(index).map(|spare| (spare, Some(connection)));
        }
    }
    waiting.pop_front().map(|spare| (spare, None))
}

/// Sends the folder and script to a spare, over `connected` or a connection it waits for.
/// `Err` means the spare is unusable and was ended.
#[cfg(windows)]
async fn hand_over(
    mut spare: Spare,
    connected: Option<Connection>,
    request: &LaunchRequest,
) -> Result<Launched, ()> {
    use std::os::windows::io::AsRawHandle;
    use tokio::io::AsyncWriteExt;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;

    let deadline = tokio::time::Instant::now() + CONNECT_LIMIT;
    let mut client = match connected {
        Some(client) => client,
        None => loop {
            if spare.launched.exit.try_recv().is_ok() || tokio::time::Instant::now() >= deadline {
                spare.launched.control.terminate();
                return Err(());
            }
            match connect(&spare) {
                Some(client) => break client,
                None => tokio::time::sleep(Duration::from_millis(2)).await,
            }
        },
    };
    // Only the spare this launcher started may receive the script.
    let mut server = 0u32;
    // SAFETY: the client handle is valid for the call and `server` is a valid out pointer.
    let verified =
        unsafe { GetNamedPipeServerProcessId(HANDLE(client.as_raw_handle()), &mut server) }.is_ok()
            && server == spare.launched.control.pid();
    if !verified {
        spare.launched.control.terminate();
        return Err(());
    }
    let mut message = request.working_folder.to_string_lossy().into_owned();
    message.push('\n');
    message.push_str(&request.script);
    if client.write_all(message.as_bytes()).await.is_err() || client.shutdown().await.is_err() {
        spare.launched.control.terminate();
        return Err(());
    }
    drop(client);
    Ok(spare.launched)
}

#[cfg(not(windows))]
async fn hand_over(
    spare: Spare,
    _connected: Option<Connection>,
    _request: &LaunchRequest,
) -> Result<Launched, ()> {
    spare.launched.control.terminate();
    Err(())
}

#[cfg(test)]
mod tests {
    use super::bootstrap;

    #[test]
    fn the_bootstrap_names_its_pipe_once() {
        let text = bootstrap("cos-exec-1-abc");
        assert_eq!(text.matches("cos-exec-1-abc").count(), 1);
        assert!(text.ends_with("$host.SetShouldExit(1) }"));
    }
}
