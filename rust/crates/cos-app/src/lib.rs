//! Chat On Steroids as a native GPUI app.
//!
//! The binary owns the process boundary (argv, the profile lock, the Core). [`app::run`] owns
//! the UI thread: the main window, the tray and the live snapshots the views draw from. The
//! pure parts (tokens, placement, texts, status wording, the tray image) carry no GPUI state and
//! are tested against the TypeScript app's own output.

pub mod app;
pub mod appearance;
pub mod binding;
pub mod i18n;
pub mod placement;
pub mod platform;
mod shell;
pub mod status;
pub mod timeline;
pub mod trace;
mod tray;
pub mod tray_image;

pub use shell::{LISTED_SESSIONS, Tab};
