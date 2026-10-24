//! The Windows Desktop surface, in-process (unit D3.1).
//!
//! [`tools`] returns the Window2 methods (`list_windows` to `activate_window`) and the two
//! clipboard tools for the Desktop surface. They answer with the same text, images and
//! `structuredContent` as the TypeScript `tools-desktop-windows.ts`, and refuse with the same
//! codes and recovery steps.
//!
//! All Win32 and UI Automation work runs on one dedicated thread per [`Desktop`], which
//! owns the COM apartment and the UIA snapshots. Tool calls queue requests to it and await
//! the answer, so a blocking native call never holds an async worker, and native effects stay
//! in the order they were asked for.

#[cfg(windows)]
mod api;
#[cfg(windows)]
mod chords;
#[cfg(windows)]
mod computer;
#[cfg(windows)]
mod native;
#[cfg(windows)]
mod thread;
#[cfg(windows)]
mod tools;

#[cfg(windows)]
pub use tools::{Desktop, tools};
