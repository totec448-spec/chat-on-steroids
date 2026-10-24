//! `cos-headless`: the Core without a window, for the golden recorder, benchmarks and
//! headless use. The launch contract is the one `rust/golden/README.md` names:
//!
//! - `--user-data-dir=<dir>` picks the profile; Chromium flags the recorder passes are ignored.
//! - With `COS_MCP_URLS_FILE` set, the Core writes the surface URLs to that file as
//!   `{ "core": url, "desktop": url, "plugins": url }` (a surface without a URL is `null`)
//!   each time they change.
//! - A second launch on the same profile hands its command line to this process and exits 0.
//!   A second launch with `--quit` asks this process to shut down gracefully.
//! - Ctrl-C (or Ctrl-Break and console close on Windows) also shuts down gracefully.
//!
//! Exit codes: 0 after a graceful shutdown or a forwarded launch, 1 when the profile or the
//! Core could not be opened.

use std::process::ExitCode;

use cos_core::{Core, Launch};
use cos_store::{Acquired, AppPaths, Instance, LaunchArgs};
use tokio::sync::mpsc;

const QUIT: &str = "--quit";

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    let args = LaunchArgs::parse(&argv);
    let paths = match AppPaths::resolve(&args) {
        Ok(paths) => paths,
        Err(error) => return fail(&format!("no user-data folder: {error}")),
    };
    let instance = match Instance::acquire(paths.user_data(), &argv) {
        Ok(Acquired::Primary(instance)) => instance,
        Ok(Acquired::Forwarded) => return ExitCode::SUCCESS,
        Err(error) => {
            return fail(&format!(
                "could not lock {}: {error}",
                paths.user_data().display()
            ));
        }
    };
    if argv.iter().any(|arg| arg == QUIT) {
        // Nothing was running on this profile, so there is nothing to quit.
        return ExitCode::SUCCESS;
    }
    let mut core = match Core::start(Launch { args, paths }, instance) {
        Ok(core) => core,
        Err(error) => return fail(&error.to_string()),
    };
    let launches = core.take_launches();
    core.block_on(wait_for_stop(launches));
    let report = core.shutdown();
    eprintln!(
        "cos-headless stopped: {:?}",
        report
            .phases
            .iter()
            .map(|phase| phase.outcome)
            .collect::<Vec<_>>()
    );
    ExitCode::SUCCESS
}

fn fail(message: &str) -> ExitCode {
    eprintln!("cos-headless: {message}");
    ExitCode::FAILURE
}

/// Returns on the first stop request: a forwarded `--quit` or a console signal.
async fn wait_for_stop(launches: Option<mpsc::UnboundedReceiver<Vec<String>>>) {
    let quit = async {
        let Some(mut launches) = launches else {
            return std::future::pending().await;
        };
        while let Some(argv) = launches.recv().await {
            if argv.iter().any(|arg| arg == QUIT) {
                return;
            }
        }
        std::future::pending().await
    };
    tokio::select! {
        () = quit => {}
        () = console_signal() => {}
    }
}

#[cfg(windows)]
async fn console_signal() {
    use tokio::signal::windows;
    let (Ok(mut c), Ok(mut brk), Ok(mut close)) = (
        windows::ctrl_c(),
        windows::ctrl_break(),
        windows::ctrl_close(),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = c.recv() => {}
        _ = brk.recv() => {}
        _ = close.recv() => {}
    }
}

#[cfg(not(windows))]
async fn console_signal() {
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}
