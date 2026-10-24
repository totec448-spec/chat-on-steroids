//! Serde types for every Chat On Steroids on-disk format and wire contract.
//!
//! Field names and JSON shapes match the TypeScript app exactly; the fixtures under
//! `tests/fixtures` are JSON the TypeScript code wrote, and every one round-trips through
//! these types without a semantic change. See `README.md` for the coverage table.
//!
//! Conventions, applied the same way in every module:
//!
//! - A TypeScript `field?: T` is `Option<T>` that is skipped when `None`.
//! - A TypeScript `field: T | null` is `Option<T>` that always serializes, `null` included.
//! - A TypeScript `field?: T | null` is `Option<Option<T>>` read with [`json::nullable`], so
//!   absent, `null` and a value stay three different states.
//! - Persisted records end in a flattened [`json::Extra`] so keys this build does not know
//!   survive a read and write. Wire replies the app produces are closed and have none.
//! - Numbers are integers where the producer writes integers (`Date.now()`, counters, sequence
//!   numbers) and [`json::JsNumber`] where it may write a fraction.

pub mod app_state;
pub mod bridge;
pub mod config;
pub mod connectors;
pub mod control_api;
pub mod ids;
pub mod json;
pub mod mcp;
pub mod session;
pub mod state;
