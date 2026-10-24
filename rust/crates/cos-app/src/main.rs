#![cfg_attr(windows, windows_subsystem = "windows")]
//! `cos-app`: the native Chat On Steroids window over the in-process Core.
//!
//! Launch contract, shared with `cos-headless`: `--user-data-dir=<dir>` picks the profile, a
//! second launch on the same profile hands its command line to the running app (which shows
//! its window unless the launch says `--background`) and exits 0, and `--background` starts
//! with the tray only. Exit codes: 0 after a quit or a forwarded launch, 1 when the profile or
//! the Core could not be opened.

use std::process::ExitCode;
use std::time::Instant;

use cos_app::app::{self, Startup};
use cos_app::placement;
use cos_app::trace::Trace;
use cos_core::{Core, Launch};
use cos_store::{Acquired, AppPaths, DurableStore, Instance, LaunchArgs};

fn main() -> ExitCode {
    let started = Instant::now();
    let argv: Vec<String> = std::env::args().collect();
    // A launch that forwards to a running app lets that app come to the front.
    cos_app::platform::hand_over_foreground();
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
    let state = paths.state();
    let background = args.background;
    let core_starting = Instant::now();
    let mut core = match Core::start(Launch { args, paths }, instance) {
        Ok(core) => core,
        Err(error) => return fail(&error.to_string()),
    };
    let core_started = Instant::now();
    let logger = core.app().logger();
    let trace = Trace::new(started, &logger);
    trace.mark_at("core starting", core_starting);
    trace.mark_at("core started", core_started);
    let bounds = match DurableStore::new(state, logger).ledger(placement::LEDGER) {
        Ok(ledger) => ledger,
        Err(error) => return fail(&error.to_string()),
    };
    app::run(Startup {
        core: core.app(),
        background,
        launches: core.take_launches(),
        bounds: bounds.clone(),
        trace,
    });
    let _ = bounds.flush();
    core.shutdown();
    ExitCode::SUCCESS
}

fn fail(message: &str) -> ExitCode {
    eprintln!("cos-app: {message}");
    ExitCode::FAILURE
}
