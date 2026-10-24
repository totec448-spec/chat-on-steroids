//! The message outbox and the durable browser commands (unit E2.3).
//!
//! [`Outbox`] ports `session/input.ts`: every message a person sends to a chat, the one browser
//! document that claims it, and the receipt that proves it was sent, in
//! `state/session-input.json`. [`Commands`] ports the command half of `bridge.ts`: what a page is
//! asked to do in a chat, in `state/bridge-commands.json`. The bridge family in `cos-bridge` is a
//! thin wire layer over [`Outbox::answer`] and [`Commands::answer`].

mod args;
mod attachments;
mod commands;
mod entry;
mod outbox;
mod policy;
mod routes;
mod text;

use std::sync::Arc;

use serde_json::{Value, json};

pub use args::{InputArgs, MAX_CHATGPT_MESSAGE_CHARS};
pub use attachments::ATTACHMENT_CHUNK_BYTES;
pub use commands::{Commands, STOP_COMMAND_TIMEOUT_MS};
pub use entry::{
    DeliveryProof, delivery_proof, is_astra_model, is_pro_model, manual_input, queued_followup,
};
pub use outbox::{CONVERSATION_DELETED, Offer, Outbox, OutboxDeps, OutboxError};
pub use routes::{IMAGE_EXPORT_BODY_BYTES, image_export_answer};

/// Called after a durable change the extension should act on (`wakeBrowserWork`).
pub type Notify = Arc<dyn Fn() + Send + Sync>;
/// Milliseconds since the epoch. Tests drive it by hand.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The system clock.
pub fn system_clock() -> Clock {
    Arc::new(|| cos_tools::EpochMs::now().0)
}

/// A route's answer: the status and the JSON body `bridge.ts` sends.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
}

impl Answer {
    pub fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }

    /// `{ "error": word }`.
    pub fn error(status: u16, word: &str) -> Self {
        Self {
            status,
            body: json!({ "error": word }),
        }
    }

    /// What `handle()` answers when a route throws.
    pub fn internal() -> Self {
        Self::error(500, "internal")
    }
}
