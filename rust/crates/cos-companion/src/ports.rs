//! What this unit asks of owners other units port later. Each port has a `No…` implementation
//! that answers as the TypeScript app does when that owner holds nothing, so the routes are
//! already right for an install with no work in those owners.

use std::sync::Arc;

use cos_types::bridge::{
    BrowserPlacement, ImageExportRequest, LiveConversation, RepairHandout, RevivalEntry,
    StatusInput, StatusQuery, StopCommand, TabPolicy,
};
use cos_types::config::Config;
use cos_types::json::Record;

use crate::BoxFuture;

/// `updateConfig(change)` on the Settings owner: the change sees the latest saved config, and
/// the result is validated, written and published before this returns it.
pub trait ConfigWriter: Send + Sync + 'static {
    fn update(
        &self,
        change: Box<dyn FnOnce(&Config) -> Config + Send>,
    ) -> BoxFuture<'static, Result<Arc<Config>, String>>;
}

/// One `/status` pass, as the owners of browser work see it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StatusCall {
    /// `POST`: the extension reported the tabs below.
    pub post: bool,
    pub open_conversations: Vec<String>,
    /// Open tabs Chrome discarded or froze.
    pub stalled_conversations: Vec<String>,
    pub can_reveal: bool,
    pub can_export_images: bool,
    /// The repair receipt the pass carries.
    pub query: StatusQuery,
    /// `x-extension-browser`.
    pub browser: Option<String>,
}

/// The parts of the `/status` reply that recorded chats, inputs, durable commands and browser
/// recovery own (E2.2, E2.3 and the recovery units).
#[derive(Clone, Debug, PartialEq)]
pub struct WorkParts {
    pub conversations: Vec<LiveConversation>,
    pub stop_turns: Vec<StopCommand>,
    pub input_opening_ids: Vec<String>,
    pub inputs: Vec<StatusInput>,
    pub command_ids: Vec<String>,
    pub revivals: Vec<RevivalEntry>,
    pub placement: Option<BrowserPlacement>,
    pub reveals: Option<Vec<String>>,
    pub follow: Option<String>,
    pub image_exports: Option<Vec<ImageExportRequest>>,
    pub repairs: Vec<RepairHandout>,
    pub tabs: TabPolicy,
    pub recovery_monitoring: bool,
}

impl WorkParts {
    /// The answer with no chat recorded, no input or command waiting and nothing to repair.
    /// A pass that said it can reveal or export images gets empty lists for those.
    pub fn none(call: &StatusCall) -> Self {
        Self {
            conversations: Vec::new(),
            stop_turns: Vec::new(),
            input_opening_ids: Vec::new(),
            inputs: Vec::new(),
            command_ids: Vec::new(),
            revivals: Vec::new(),
            placement: None,
            reveals: (call.post && call.can_reveal).then(Vec::new),
            follow: None,
            image_exports: (call.post && call.can_export_images).then(Vec::new),
            repairs: Vec::new(),
            tabs: TabPolicy {
                idle_reuse_after_ms: 120_000,
                idle_close_after_ms: 300_000,
                cancelled_decision_claims: Vec::new(),
                retired_conversations: Vec::new(),
                conversation_activity_at: Record::new(),
                managed_conversations: Vec::new(),
                reusable_conversations: Vec::new(),
                non_discardable_conversations: Vec::new(),
                blocked_conversations: Vec::new(),
                closable_conversations: Vec::new(),
            },
            recovery_monitoring: false,
        }
    }
}

/// Browser work other units own.
pub trait BrowserWork: Send + Sync + 'static {
    /// Applies the pass's repair receipt and stalled-tab report, then answers its parts.
    fn status(&self, call: StatusCall) -> BoxFuture<'static, WorkParts>;
    /// The CoS project a waiting message opens its new chat in (`listInputs()` by id).
    fn input_project(&self, input_id: String) -> BoxFuture<'static, Option<String>>;
}

/// No chat recorded, no input or command, nothing to repair.
pub struct NoBrowserWork;

impl BrowserWork for NoBrowserWork {
    fn status(&self, call: StatusCall) -> BoxFuture<'static, WorkParts> {
        Box::pin(async move { WorkParts::none(&call) })
    }

    fn input_project(&self, _input_id: String) -> BoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }
}

/// What the chat-level owners say about one conversation when the composer changes a switch:
/// Compact & Resume (E2.5), workers (E2.6), Goal and Loop (E2.7) and blocked chats.
pub trait ChatPolicy: Send + Sync + 'static {
    /// Compact & Resume moved this chat to a successor.
    fn superseded(&self, conversation: String) -> BoxFuture<'static, bool>;
    /// The person blocked this chat in the app.
    fn blocked(&self, conversation: &str) -> bool;
    /// A worker chat: its conversation is its agent identity and never compacts.
    fn worker(&self, conversation: &str) -> bool;
    /// `cancelAutomaticResumesNow()`: Auto Off durably cancels pending automatic tickets.
    fn cancel_automatic_resumes(&self) -> BoxFuture<'static, Result<(), String>>;
    /// `retireGoalDrafts(all)`: the instruction in force changed under drafts in flight.
    fn retire_goal_drafts(&self, all: bool);
}

/// No continuation, no worker, no Goal ledger and no blocked chat.
pub struct NoChatPolicy;

impl ChatPolicy for NoChatPolicy {
    fn superseded(&self, _conversation: String) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }

    fn blocked(&self, _conversation: &str) -> bool {
        false
    }

    fn worker(&self, _conversation: &str) -> bool {
        false
    }

    fn cancel_automatic_resumes(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn retire_goal_drafts(&self, _all: bool) {}
}

/// What a chat-scoped switch write answers: the switch it now holds, or the status and body
/// to refuse with.
pub type SwitchAnswer = Result<(bool, cos_types::config::GoalMode), (u16, serde_json::Value)>;

/// One chat's own Goal/Loop switch, held by the Goal owner (`state/goal-switches.json`).
pub trait ChatSwitches: Send + Sync + 'static {
    /// Whether an owner holds per-chat switches at all.
    fn served(&self) -> bool;
    /// `setGoalSwitchNow` and the owed-reply ticket that follows it. `None` when no owner holds
    /// switches; `Err` is the refusal to answer with.
    fn set(
        &self,
        conversation: String,
        which: cos_types::config::GoalMode,
        on: bool,
    ) -> BoxFuture<'static, Option<SwitchAnswer>>;
    /// `loopAfterTurn` for a recorded chat (`setSessionAutomation`): the whole answer, or `None`
    /// when no owner holds switches.
    fn after_turn(
        &self,
        conversation: String,
        after_turn: bool,
    ) -> BoxFuture<'static, Option<(u16, serde_json::Value)>>;
}

/// No Goal owner: a chat-scoped switch is answered as an unserved route.
pub struct NoChatSwitches;

impl ChatSwitches for NoChatSwitches {
    fn served(&self) -> bool {
        false
    }

    fn set(
        &self,
        _conversation: String,
        _which: cos_types::config::GoalMode,
        _on: bool,
    ) -> BoxFuture<'static, Option<SwitchAnswer>> {
        Box::pin(async { None })
    }

    fn after_turn(
        &self,
        _conversation: String,
        _after_turn: bool,
    ) -> BoxFuture<'static, Option<(u16, serde_json::Value)>> {
        Box::pin(async { None })
    }
}
