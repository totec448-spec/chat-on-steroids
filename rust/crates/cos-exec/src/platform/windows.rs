//! Windows process launch: pipes through `tokio::process`, pseudo-terminals through ConPTY, and
//! a Job Object per session so terminating a session ends its whole process tree.
//!
//! The Job Object handling follows codex-rs `utils/pty/src/win/job.rs` (openai/codex at
//! 1a4096e273e80da30947e57fdfa45be92858ca91, Apache-2.0), and the ConPTY launch follows
//! codex-rs `utils/pty/src/win/psuedocon.rs`, itself copied from wezterm (MIT, Copyright (c)
//! 2018-Present Wez Furlong). Both are rewritten here on `windows-rs`; see ../../NOTICE.

use std::ffi::{OsStr, c_void};
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot};
use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, SetConsoleCtrlHandler,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcess,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, PROCESS_TERMINATE, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

use crate::launch::{Control, Exit, LaunchError, LaunchRequest, Launched};

/// `portable_pty`'s `TerminalSize::default()`.
const PTY_COLS: i16 = 80;
const PTY_ROWS: i16 = 24;

#[link(name = "ntdll")]
unsafe extern "system" {
    /// Resumes every thread of a process created suspended. Undocumented but stable since NT;
    /// codex-rs uses it for the same reason: `std` keeps the main thread handle private.
    fn NtResumeProcess(process: *mut c_void) -> i32;
}

/// A Job Object that owns one session's process tree.
struct Job {
    handle: OwnedHandle,
    /// Whether the tree still dies when the job handle closes. Cleared when the leader exits on
    /// its own, so programs it started in the background outlive it, as they do in the
    /// TypeScript app; a live session still dies with the app.
    kill_on_close: Mutex<bool>,
}

impl Job {
    fn new() -> io::Result<Self> {
        // SAFETY: no name and no security attributes; the returned handle is owned below.
        let raw = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(io::Error::other)?;
        // SAFETY: `raw` is a fresh handle this function owns.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw.0) };
        let job = Self {
            handle,
            kill_on_close: Mutex::new(false),
        };
        job.set_kill_on_close(true)?;
        Ok(job)
    }

    fn raw(&self) -> HANDLE {
        HANDLE(self.handle.as_raw_handle())
    }

    fn set_kill_on_close(&self, on: bool) -> io::Result<()> {
        let mut state = self
            .kill_on_close
            .lock()
            .map_err(|_| io::Error::other("job state poisoned"))?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        if on {
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        }
        // SAFETY: `info` is a valid, fully initialised structure of the size passed.
        unsafe {
            SetInformationJobObject(
                self.raw(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(io::Error::other)?;
        *state = on;
        Ok(())
    }

    fn assign(&self, process: HANDLE) -> io::Result<()> {
        // SAFETY: both handles are valid for the duration of the call.
        unsafe { AssignProcessToJobObject(self.raw(), process) }.map_err(io::Error::other)
    }

    fn terminate(&self) {
        // SAFETY: the job handle is valid; terminating an empty job is a no-op.
        let _ = unsafe { TerminateJobObject(self.raw(), 1) };
    }

    /// The leader exited by itself: let its background descendants live on.
    fn release_descendants(&self) {
        let _ = self.set_kill_on_close(false);
    }
}

/// Clears this process's "ignore Ctrl-C" flag, which every child it creates inherits.
pub(crate) fn restore_ctrl_c() {
    // SAFETY: a null handler with `false` only clears the flag; no callback is registered.
    // It fails only when the process has no console, and then there is no flag to clear.
    let _ = unsafe { SetConsoleCtrlHandler(None, false) };
}

/// Ends a process by pid, for the rare session whose job could not be assigned.
fn terminate_pid(pid: u32) {
    // SAFETY: OpenProcess returns an owned handle or an error; it is closed by OwnedHandle.
    if let Ok(handle) = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) } {
        // SAFETY: `handle` is a fresh handle owned here.
        let owned = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        // SAFETY: the handle has PROCESS_TERMINATE access.
        let _ = unsafe { TerminateProcess(HANDLE(owned.as_raw_handle()), 1) };
    }
}

struct PipeControl {
    pid: u32,
    job: Option<Arc<Job>>,
}

impl Control for PipeControl {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn write(&self, _data: &[u8]) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "a pipe session has no stdin",
        ))
    }

    fn terminate(&self) {
        match &self.job {
            Some(job) => job.terminate(),
            None => terminate_pid(self.pid),
        }
    }
}

/// Starts `argv` with piped stdout and stderr and no stdin, inside a new job.
pub(crate) fn spawn_pipes(
    argv: &[String],
    verbatim: bool,
    request: &LaunchRequest,
) -> Result<Launched, LaunchError> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| LaunchError("missing command line for unified exec request".into()))?;
    let mut command = tokio::process::Command::new(program);
    if verbatim {
        for arg in args {
            command.as_std_mut().raw_arg(arg);
        }
    } else {
        command.args(args);
    }
    command
        .current_dir(&request.working_folder)
        .env_clear()
        .envs(request.env.iter().map(|(key, value)| (key, value)))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
    let mut child = command.spawn()?;
    let pid = child.id().unwrap_or_default();
    let job = child.raw_handle().and_then(|process| {
        let job = Job::new().ok()?;
        job.assign(HANDLE(process)).ok()?;
        Some(Arc::new(job))
    });
    if let Some(process) = child.raw_handle() {
        // SAFETY: the child was created suspended and its handle is valid while `child` lives.
        unsafe { NtResumeProcess(process) };
    }

    let (output_tx, output) = mpsc::unbounded_channel();
    for mut stream in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
    ]
    .into_iter()
    .flatten()
    {
        let output_tx = output_tx.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            while let Ok(read) = stream.read(&mut buf).await {
                if read == 0
                    || output_tx
                        .send(Bytes::copy_from_slice(&buf[..read]))
                        .is_err()
                {
                    break;
                }
            }
        });
    }
    drop(output_tx);

    let (exit_tx, exit) = oneshot::channel();
    let exit_job = job.clone();
    tokio::spawn(async move {
        let code: Exit = child
            .wait()
            .await
            .ok()
            .and_then(|status| status.code())
            .map(|code| i64::from(code as u32));
        if let Some(job) = exit_job {
            job.release_descendants();
        }
        let _ = exit_tx.send(code);
    });

    Ok(Launched {
        output,
        exit,
        control: Box::new(PipeControl { pid, job }),
    })
}

/// MSVCRT quoting for one argument (`quoteWindowsArgument`).
fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_owned();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

/// A Unicode environment block, sorted by name without case as `CreateProcess` expects.
fn environment_block(env: &[(std::ffi::OsString, std::ffi::OsString)]) -> Vec<u16> {
    let mut pairs: Vec<_> = env.iter().collect();
    pairs.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in pairs {
        block.extend(key.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

/// `HPCON` as a value that can move to the thread that closes it.
struct PseudoConsole(HPCON);

// SAFETY: a pseudo-console handle is a kernel object reference, valid from any thread.
unsafe impl Send for PseudoConsole {}

struct PtyControl {
    pid: u32,
    job: Arc<Job>,
    input: Mutex<std::io::PipeWriter>,
}

impl Control for PtyControl {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn write(&self, data: &[u8]) -> io::Result<()> {
        let mut input = self
            .input
            .lock()
            .map_err(|_| io::Error::other("terminal input poisoned"))?;
        input.write_all(data)?;
        input.flush()
    }

    fn terminate(&self) {
        self.job.terminate();
    }
}

/// Starts `argv` attached to a new 80x24 pseudo-console, inside a new job.
pub(crate) fn spawn_pty(
    argv: &[String],
    verbatim: bool,
    request: &LaunchRequest,
) -> Result<Launched, LaunchError> {
    if argv.is_empty() {
        return Err(LaunchError(
            "missing command line for unified exec request".into(),
        ));
    }
    let (pty_input, input) = std::io::pipe()?;
    let (mut output_pipe, pty_output) = std::io::pipe()?;
    let size = COORD {
        X: PTY_COLS,
        Y: PTY_ROWS,
    };
    // SAFETY: both pipe handles are valid; the console duplicates what it keeps.
    let console = unsafe {
        CreatePseudoConsole(
            size,
            HANDLE(pty_input.as_raw_handle()),
            HANDLE(pty_output.as_raw_handle()),
            0,
        )
    }
    .map_err(|error| LaunchError(error.message()))?;
    drop(pty_input);
    drop(pty_output);
    let console = PseudoConsole(console);

    let launched = start_in_console(argv, verbatim, request, &console);
    let (process, pid, job) = match launched {
        Ok(started) => started,
        Err(error) => {
            // SAFETY: the console was created above and is closed exactly once.
            unsafe { ClosePseudoConsole(console.0) };
            return Err(error);
        }
    };

    let (output_tx, output) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        while let Ok(read) = output_pipe.read(&mut buf) {
            if read == 0
                || output_tx
                    .send(Bytes::copy_from_slice(&buf[..read]))
                    .is_err()
            {
                break;
            }
        }
    });

    let (exit_tx, exit) = oneshot::channel();
    let exit_job = job.clone();
    std::thread::spawn(move || {
        let handle = HANDLE(process.as_raw_handle());
        // SAFETY: `process` stays owned by this thread until the wait returns.
        let waited = unsafe { WaitForSingleObject(handle, INFINITE) };
        let mut code = 0u32;
        // SAFETY: the handle is valid and has query access.
        let known =
            waited == WAIT_OBJECT_0 && unsafe { GetExitCodeProcess(handle, &mut code) }.is_ok();
        exit_job.release_descendants();
        let _ = exit_tx.send(known.then_some(i64::from(code)));
        // Closing the console flushes its last output and ends the output pipe.
        // SAFETY: the console is closed exactly once, after the process ended.
        unsafe { ClosePseudoConsole(console.0) };
        drop(process);
    });

    Ok(Launched {
        output,
        exit,
        control: Box::new(PtyControl {
            pid,
            job,
            input: Mutex::new(input),
        }),
    })
}

fn start_in_console(
    argv: &[String],
    verbatim: bool,
    request: &LaunchRequest,
    console: &PseudoConsole,
) -> Result<(OwnedHandle, u32, Arc<Job>), LaunchError> {
    // cmd.exe reads its own command line, so its arguments go through as written.
    let line = argv
        .iter()
        .enumerate()
        .map(|(index, arg)| {
            if verbatim && index > 0 {
                arg.clone()
            } else {
                quote(arg)
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut command_line = wide(OsStr::new(&line));
    let cwd = wide(request.working_folder.as_os_str());
    let env = environment_block(&request.env);

    let mut size = 0usize;
    // SAFETY: the first call only reports the size the attribute list needs.
    let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut size) };
    let mut list = vec![0u8; size];
    let attributes = LPPROC_THREAD_ATTRIBUTE_LIST(list.as_mut_ptr().cast());
    // SAFETY: `list` has the size the system asked for and outlives every use below.
    unsafe { InitializeProcThreadAttributeList(Some(attributes), 1, None, &mut size) }
        .map_err(|error| LaunchError(error.message()))?;
    // SAFETY: the pseudo-console value lives until after CreateProcessW returns.
    let updated = unsafe {
        UpdateProcThreadAttribute(
            attributes,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            Some(console.0.0 as *const c_void),
            size_of::<HPCON>(),
            None,
            None,
        )
    };
    if let Err(error) = updated {
        // SAFETY: the list was initialised above.
        unsafe { DeleteProcThreadAttributeList(attributes) };
        return Err(LaunchError(error.message()));
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    // Without this the child inherits this process's console handles and writes past the
    // pseudo-console; with it and no handles, its standard handles come from the console.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.lpAttributeList = attributes;
    let mut info = PROCESS_INFORMATION::default();
    // SAFETY: every buffer is NUL-terminated and alive for the call; handles are not inherited.
    let created = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            Some(env.as_ptr().cast()),
            PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo,
            &mut info,
        )
    };
    // SAFETY: the list was initialised above and CreateProcessW is done with it.
    unsafe { DeleteProcThreadAttributeList(attributes) };
    created.map_err(|error| LaunchError(error.message()))?;

    // SAFETY: CreateProcessW returned fresh handles this function now owns.
    let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess.0) };
    // SAFETY: as above, for the main thread.
    let thread = unsafe { OwnedHandle::from_raw_handle(info.hThread.0) };
    let job = Job::new().map_err(LaunchError::from)?;
    let job = Arc::new(job);
    let assigned = job.assign(HANDLE(process.as_raw_handle()));
    // SAFETY: the thread was created suspended and its handle is valid.
    unsafe { ResumeThread(HANDLE(thread.as_raw_handle())) };
    if let Err(error) = assigned {
        // SAFETY: the process handle is valid; a process outside any job cannot be owned.
        let _ = unsafe { TerminateProcess(HANDLE(process.as_raw_handle()), 1) };
        return Err(LaunchError(error.to_string()));
    }
    Ok((process, info.dwProcessId, job))
}

#[cfg(test)]
mod tests {
    use super::quote;

    #[test]
    fn quoting_follows_msvcrt_rules() {
        assert_eq!(quote("plain"), "plain");
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote(r"C:\dir with space\"), r#""C:\dir with space\\""#);
    }
}
