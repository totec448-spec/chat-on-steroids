//! The operating-system half of [`crate::launch`].

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::{restore_ctrl_c, spawn_pipes, spawn_pty};

#[cfg(not(windows))]
mod other;
#[cfg(not(windows))]
pub(crate) use other::{restore_ctrl_c, spawn_pipes, spawn_pty};
