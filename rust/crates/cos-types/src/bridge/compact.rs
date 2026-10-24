//! `POST /compact` (Compact & Resume) and `POST /goal/draft` (`bridge.ts`).

use serde::{Deserialize, Serialize};

use super::{BrowserPlacement, GoalDraftView, ResumeJob};
use crate::json::{JsNumber, True, nullable};
use crate::state::{ContinuationDestinationCheckpoint, ContinuationSendCheckpoint};

/// `POST /compact` body as the page sends it. One route carries every step of the
/// transaction; [`CompactRequest::step`] reads which one, in the order `bridge.ts` does.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactRequest {
    /// Absent only on the destination steps, which name the command instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// The continuation token every step after the first quotes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    /// The page's per-document id that leased the resume command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_attempt: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_dispatch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_lost: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_lost: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_dispatch: Option<bool>,
    /// The newest user message before the prompt went in.
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub before: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_undelivered: Option<bool>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub newest_user_message: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_since: Option<JsNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_attempt: Option<bool>,
    /// The native ChatGPT Project the source page is in; `null` for none.
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub project: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_progress: Option<JsNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automatic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket: Option<bool>,
    /// The handoff brief: the final answer of the compaction turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// The step a `/compact` body asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactStep {
    DestinationAttempt,
    DestinationDispatch,
    DestinationLost,
    SourceLost,
    SourceDispatch,
    SourceUndelivered,
    SourceAttempt,
    SourceMessage,
    DestinationMessage,
    Cancel,
    /// Durably open the transaction without handing out the prompt yet.
    Ticket,
    /// Hand over the brief.
    Capture,
    /// Start, or report the running transaction and its prompt.
    Open,
}

impl CompactRequest {
    /// The first flag set, in `bridge.ts` order. The destination steps come before the
    /// `conversationId` check; every other step needs a valid one.
    pub fn step(&self) -> CompactStep {
        let set = |flag: Option<bool>| flag == Some(true);
        if set(self.destination_attempt) {
            CompactStep::DestinationAttempt
        } else if set(self.destination_dispatch) {
            CompactStep::DestinationDispatch
        } else if set(self.destination_lost) {
            CompactStep::DestinationLost
        } else if set(self.source_lost) {
            CompactStep::SourceLost
        } else if set(self.source_dispatch) {
            CompactStep::SourceDispatch
        } else if set(self.source_undelivered) {
            CompactStep::SourceUndelivered
        } else if set(self.source_attempt) {
            CompactStep::SourceAttempt
        } else if self.source_message_id.is_some() {
            CompactStep::SourceMessage
        } else if self.destination_message_id.is_some() {
            CompactStep::DestinationMessage
        } else if set(self.cancel) {
            CompactStep::Cancel
        } else if set(self.ticket) {
            CompactStep::Ticket
        } else if self.summary.is_some() {
            CompactStep::Capture
        } else {
            CompactStep::Open
        }
    }
}

/// `POST /compact` reply on success (200 or 202).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CompactReply {
    /// The brief is stored and the replacement chat is on its way. The source-message step
    /// adds `bound: true` when that bind captured it.
    #[serde(rename_all = "camelCase")]
    Stored {
        stored: True,
        session_id: String,
        handoff_id: String,
        command_id: Option<String>,
        /// Chat B, for A's own browser to open in A's own window.
        placement: Option<BrowserPlacement>,
        job: Option<ResumeJob>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bound: Option<True>,
    },
    /// `open` and `ticket`: the transaction and, while it waits for the brief, its prompt.
    #[serde(rename_all = "camelCase")]
    Opened {
        started: bool,
        /// Present for a ticket.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filed: Option<True>,
        session_id: String,
        token: String,
        source_send: ContinuationSendCheckpoint,
        prompt: Option<String>,
        job: Option<ResumeJob>,
    },
    #[serde(rename_all = "camelCase")]
    Committed {
        committed: True,
        conversation_id: String,
        command_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Cancelled {
        cancelled: bool,
        session_id: String,
        job: Option<ResumeJob>,
    },
    #[serde(rename_all = "camelCase")]
    Aborted {
        aborted: True,
        session_id: String,
        job: Option<ResumeJob>,
    },
    #[serde(rename_all = "camelCase")]
    SourceReleased {
        released: True,
        source_send: ContinuationSendCheckpoint,
        job: Option<ResumeJob>,
    },
    /// `sourceAttempt`: whether the page may send the prompt now.
    #[serde(rename_all = "camelCase")]
    SourceAttempt {
        allowed: bool,
        source_send: ContinuationSendCheckpoint,
    },
    #[serde(rename_all = "camelCase")]
    DestinationAttempt {
        allowed: bool,
        destination_send: ContinuationDestinationCheckpoint,
    },
    /// The source message is bound; the brief is not captured yet.
    Bound { bound: True, job: Option<ResumeJob> },
    /// `sourceDispatch` or `destinationDispatch`.
    Armed { armed: True },
    /// `destinationLost`.
    Released { released: True },
}

// ------------------------------------------------------------------ /goal/draft

/// `POST /goal/draft` body: ChatGPT finished `turnId` and the page wants its one draft.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalDraftRequest {
    pub conversation_id: String,
    /// The page's own generation id, the draft's identity. Cut to 200 characters.
    pub turn_id: String,
    /// Only a turn the app already owes a reply may be drafted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_required: Option<bool>,
    /// The page's per-document id; cut to 100 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// ChatGPT is still busy with its own turn: ask whether to stop it instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_busy: Option<bool>,
}

/// `POST /goal/draft` reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum GoalDraftReply {
    #[serde(rename_all = "camelCase")]
    Draft {
        goal: Box<GoalDraftView>,
        session_id: String,
    },
    /// A `nativeBusy` request: whether the page may stop ChatGPT's turn.
    Recovery { recovery: GoalRecovery },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalRecovery {
    pub stop: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_until: Option<u64>,
}
