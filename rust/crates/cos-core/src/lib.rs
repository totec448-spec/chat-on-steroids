//! The Chat On Steroids Core in one process: startup, shutdown, state ownership, and the
//! [`AppCore`] handle a UI links in-process.
//!
//! This crate is the composition root. It builds every owner once, hands each one the
//! read-only snapshots it needs, and runs the bounded shutdown sequence. It holds no domain
//! logic. GPUI never appears here (standing order 15): a UI crate depends on this one.
//!
//! ```no_run
//! use cos_core::{Core, Launch};
//! use cos_store::{Acquired, AppPaths, Instance, LaunchArgs};
//!
//! let argv: Vec<String> = std::env::args().collect();
//! let args = LaunchArgs::parse(&argv);
//! let paths = AppPaths::resolve(&args).expect("a user-data folder");
//! let Acquired::Primary(instance) = Instance::acquire(paths.user_data(), &argv).expect("lock")
//! else {
//!     return; // the running instance received this command line
//! };
//! let core = Core::start(Launch { args, paths }, instance).expect("starts");
//! let app = core.app();
//! let config = app.watches().config; // a watch::Receiver<Arc<Config>>, usable on any executor
//! let report = core.shutdown();
//! ```

mod agents;
mod app;
mod browser;
mod companion;
mod continuation;
mod core;
mod goal;
mod launches;
mod settings;
mod shutdown;
mod surfaces;
mod urls_file;

pub use app::{AppCore, CoreTask, Domains, TaskFailed, Watches};
pub use companion::CompanionDomains;
pub use core::{Core, Launch, StartupError};
pub use settings::Settings;
pub use shutdown::{PhaseOutcome, PhaseReport, ShutdownPhase, ShutdownReport};

/// The product version, from `package.json` at build time.
pub const APP_VERSION: &str = env!("COS_APP_VERSION");
