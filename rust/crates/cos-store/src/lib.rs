//! The Chat On Steroids user-data folder, shared with the TypeScript app.
//!
//! - [`AppPaths`] and [`LaunchArgs`]: where the folder is, and `--user-data-dir`/`--background`.
//! - [`ConfigStore`]: `config.json`, validated and repaired exactly as `src/main/config.ts` does,
//!   including the Settings form's `{ base, patch }` merge.
//! - [`BridgePortOverride`]: `CLF_BRIDGE_PORTS`, which locks the bridge port in a Settings save.
//! - [`DurableStore`] and [`Durable`]: the small JSON ledgers under `state/`.
//! - [`Logger`]: the Activity log and `app.log`.
//! - [`Instance`]: one running app per folder; later launches forward their command line.
//!
//! The tests under `tests/` compare every one of these with the TypeScript app's own output,
//! recorded by `oracle/regenerate.mjs`.

pub mod bridge_ports;
mod check;
pub mod config;
pub mod durable;
pub mod instance;
mod js;
pub mod logger;
pub mod paths;

pub use bridge_ports::BridgePortOverride;
pub use config::{Config, ConfigError, ConfigStore, Platform};
pub use durable::{Durable, DurableError, DurableStore};
pub use instance::{Acquired, Instance};
pub use logger::Logger;
pub use paths::{AppPaths, LaunchArgs};
