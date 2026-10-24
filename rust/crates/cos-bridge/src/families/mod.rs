//! One module per Track 2 unit. Each unit writes its routes in its own file and implements
//! [`crate::Family`] there; `cos-core` registers the family with one line. Nothing here is
//! shared between units, so two units never edit the same file.

pub mod agents;
pub mod browser_control;
pub(crate) mod extension;
pub mod finish;
pub mod goal;
pub mod input;
pub mod models;
pub mod recorder;
