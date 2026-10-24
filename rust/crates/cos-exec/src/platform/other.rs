//! Pipe sessions on platforms other than Windows. Windows reaches parity first (standing order
//! 13); POSIX process groups and PTYs follow with the macOS and Linux work.

use bytes::Bytes;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot};

use crate::launch::{Control, Exit, LaunchError, LaunchRequest, Launched};

/// POSIX has no inherited "ignore Ctrl-C" flag to clear.
pub(crate) fn restore_ctrl_c() {}

struct PipeControl {
    pid: u32,
}

impl Control for PipeControl {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn write(&self, _data: &[u8]) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "a pipe session has no stdin",
        ))
    }

    fn terminate(&self) {
        let _ = std::process::Command::new("kill")
            .arg("-KILL")
            .arg(self.pid.to_string())
            .status();
    }
}

pub(crate) fn spawn_pipes(
    argv: &[String],
    _verbatim: bool,
    request: &LaunchRequest,
) -> Result<Launched, LaunchError> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| LaunchError("missing command line for unified exec request".into()))?;
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .current_dir(&request.working_folder)
        .env_clear()
        .envs(request.env.iter().map(|(key, value)| (key, value)))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    let pid = child.id().unwrap_or_default();
    let (output_tx, output) = mpsc::unbounded_channel();
    let streams: Vec<Box<dyn tokio::io::AsyncRead + Send + Unpin>> = [
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
    .collect();
    for mut stream in streams {
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
    tokio::spawn(async move {
        let code: Exit = child
            .wait()
            .await
            .ok()
            .and_then(|s| s.code())
            .map(i64::from);
        let _ = exit_tx.send(code);
    });
    Ok(Launched {
        output,
        exit,
        control: Box::new(PipeControl { pid }),
    })
}

pub(crate) fn spawn_pty(
    _argv: &[String],
    _verbatim: bool,
    _request: &LaunchRequest,
) -> Result<Launched, LaunchError> {
    Err(LaunchError(
        "a pseudo-console is not available on this machine".into(),
    ))
}
