//! The broker (`main/agents.ts`): independent prime-owned worker families, who may act in
//! them, and what happens to their messages. Pure state: no IO, no clock of its own and no
//! locks. The owner in `lib.rs` runs every operation on a copy, writes the copy's snapshot,
//! and only then publishes it, which is the durable acceptance barrier of the TypeScript
//! broker without its staged overlays.

use std::collections::HashMap;

use cos_types::json::Extra;
use cos_types::session::{
    AgentInfo, AgentMessage, AgentRole, AgentState, ReasoningEffort, SwarmState,
};
use cos_types::state::{CleanupReason, ManagedWorktreeCleanupOffer, RetiredChat};
use indexmap::{IndexMap, IndexSet};

use crate::text::{first_line, js_length, js_slice, js_trim, worker_brief, worker_own_task};

pub const PRIME_ID: &str = "prime";
/// Unacknowledged messages held per agent before the broker refuses more.
const MAX_QUEUE: usize = 200;
pub const MAX_MESSAGE_CHARS: usize = 4000;
/// Broker prose appended to one MCP result, oldest first.
const MAX_INBOX_OFFER_CHARS: usize = 32_000;
pub const MAX_BATCH_MESSAGES: usize = 16;
const MAX_TASK_CHARS: usize = 4000;
const MAX_CONTEXT_CHARS: usize = 4000;
const MAX_LABEL_CHARS: usize = 60;
const MAX_MODEL_CHARS: usize = 80;
/// Where a worker chat stops being worth reviving.
pub const WORKER_CONTEXT_CEILING_TOKENS: u64 = 400_000;
const DORMANT_RUN_TTL_MS: u64 = 7 * 24 * 60 * 60_000;
const MAX_DORMANT_RUNS: usize = 16;
pub(crate) const RETIRED_WORKER_TTL_MS: u64 = 30 * 60_000;
const MAX_RECENT_FORMER_RUN_IDS: usize = 8;
/// Consecutive failed wakes, with no sign of life between them, that end a worker.
pub const WAKE_FAILURES_BEFORE_GIVING_UP: u32 = 2;

const IDENTITY_LOST: &str = "WORKER_IDENTITY_LOST: Chat On Steroids could not tell which conversation this call came from, so it cannot act on the run from here. No agent operation was performed. Wait briefly and retry this operation once. If it is still refused, preserve your result in the chat and report that delivery is unconfirmed; do not claim the message or finish report reached its recipient.";
const UNIDENTIFIED_CALLER: &str = "UNIDENTIFIED_CALLER: this app could not prove which ChatGPT conversation this call came from, so it will not make this chat the prime agent of a run. No workers were created. The paired browser extension has to be connected and this conversation has to be showing its connector activity; wait a moment and call agents action=spawn again.";
const AGENTS_BUSY: &str = "AGENTS_BUSY: no agent family belongs to this conversation. Other primes and their workers are isolated. Call agents action=spawn to create workers owned by this chat.";
const DISABLED: &str =
    "Multi-agent mode is switched off in Chat On Steroids. Ask the user to enable it.";

/// Why a broker operation changed nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentError {
    /// The call could not be placed in a conversation (`IdentityLostError`).
    Identity(String),
    /// Every other refusal (`AgentError`).
    Refused(String),
}

impl AgentError {
    fn refused(text: impl Into<String>) -> Self {
        Self::Refused(text.into())
    }

    fn busy() -> Self {
        Self::Refused(AGENTS_BUSY.to_owned())
    }

    pub fn text(&self) -> &str {
        match self {
            Self::Identity(text) | Self::Refused(text) => text,
        }
    }
}

type Result<T> = std::result::Result<T, AgentError>;

/// The live settings one operation runs under, read once from the config snapshot.
#[derive(Clone, Debug)]
pub struct Policy {
    pub enabled: bool,
    pub max_workers: u64,
    /// `0` is no cross-family cap.
    pub global_max_workers: u64,
    pub allow_unattributed: bool,
    pub default_model: Option<String>,
    pub default_reasoning: Option<ReasoningEffort>,
    pub auto_worktrees: bool,
    /// `liveConnectorName('core')`.
    pub core_connector: String,
    /// `ownCoreHint()`: ` of <connector>` when this computer's connectors carry a suffix.
    pub core_hint: String,
}

/// What a caller can offer as proof of who it is. No field is ever an agent id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Caller {
    pub conversation_id: Option<String>,
    pub request_id: Option<String>,
    pub setup_profile_id: Option<String>,
    /// A family selection; ownership is checked independently.
    pub run_id: Option<String>,
}

impl Caller {
    pub fn conversation(id: &str) -> Self {
        Self {
            conversation_id: Some(id.to_owned()),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Agent {
    pub info: AgentInfo,
    pub queue: Vec<AgentMessage>,
}

/// One prime's worker family, active or parked.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Family {
    pub former_run_ids: Vec<String>,
    pub setup_profile_id: Option<String>,
    pub prime_conversation_id: Option<String>,
    pub prime_request_id: Option<String>,
    pub started_at: u64,
    pub agents: IndexMap<String, Agent>,
}

impl Family {
    fn prime(&self) -> Option<&Agent> {
        self.agents.get(PRIME_ID)
    }

    fn has_worker_conversation(&self, conversation: &str) -> bool {
        self.agents.values().any(|agent| {
            agent.info.role == AgentRole::Worker
                && agent.info.conversation_id.as_deref() == Some(conversation)
        })
    }

    fn working(&self) -> usize {
        self.agents
            .values()
            .filter(|agent| agent.info.role == AgentRole::Worker && occupies_slot(agent.info.state))
            .count()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Dormant {
    pub family: Family,
    pub parked_at: u64,
}

/// Points at one family: an active incarnation by its run id, or parked history by its key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Slot {
    Active(String),
    Dormant(String),
}

impl Slot {
    fn key(&self) -> &str {
        match self {
            Self::Active(key) | Self::Dormant(key) => key,
        }
    }

    fn running(&self) -> bool {
        matches!(self, Self::Active(_))
    }
}

/// A worker whose chat still has to be opened. Carries no credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerSpawn {
    pub run_id: String,
    pub prime_conversation_id: Option<String>,
    pub id: String,
    pub task: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
}

/// What the browser has to do to wake one worker, and which messages ride on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerRevival {
    pub prime_conversation_id: Option<String>,
    pub id: String,
    pub conversation_id: String,
    pub run_id: String,
    pub text: String,
    pub message_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkerRequest {
    pub label: Option<String>,
    pub task: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpawnResult {
    pub created: Vec<AgentInfo>,
    pub became_prime: bool,
    pub run_id: String,
    /// Exact newly reserved workers; a repeat owns none.
    pub newly_staged: Vec<String>,
    pub default_notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MessageItem {
    pub to: String,
    pub text: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StagedMessages {
    pub run_id: String,
    pub messages: Vec<AgentMessage>,
    pub waking: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrimeMessage {
    pub source_run_id: String,
    pub target_run_id: String,
    pub message: AgentMessage,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FinishResult {
    pub info: AgentInfo,
    pub report: Option<AgentMessage>,
    pub repeat: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CallerStatus {
    pub self_info: Option<AgentInfo>,
    pub state: SwarmState,
    pub run_id: Option<String>,
    pub free_worker_slots: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FamilyChoice {
    pub run_id: String,
    pub running: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClearOutcome {
    Run,
    Worker(Option<Box<AgentMessage>>),
    None(String),
}

/// `WorkerPrimeOwner`: who owns a worker chat, for strict authorization.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkerPrimeOwner {
    /// This exact chat is a worker of some family, in any state.
    pub owned: bool,
    /// `None` when the owner is ambiguous or provisional: strict authorization fails closed.
    pub prime_conversation_id: Option<String>,
    /// Diagnostics only, never an authorization token.
    pub run_id: Option<String>,
    pub setup_profile_id: Option<String>,
}

/// The worker chats of every family, as one synchronous snapshot for policy readers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ownership {
    workers: HashMap<String, Vec<WorkerPrimeOwner>>,
}

impl Ownership {
    /// `isWorkerConversation`: a chat the app opened for a worker, in any state, ever.
    pub fn is_worker(&self, conversation: &str) -> bool {
        self.workers.contains_key(conversation)
    }

    /// `workerPrimeOwner`. A chat two families both claim is owned with no prime.
    pub fn prime_owner(&self, conversation: &str) -> WorkerPrimeOwner {
        match self.workers.get(conversation).map(Vec::as_slice) {
            None | Some([]) => WorkerPrimeOwner::default(),
            Some([owner]) => owner.clone(),
            Some(_) => WorkerPrimeOwner {
                owned: true,
                ..WorkerPrimeOwner::default()
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Level {
    Info,
    Warn,
}

/// Every family, the post-run worker fences, and the cleanup authority they leave behind.
#[derive(Clone, Debug, Default)]
pub struct Broker {
    pub(crate) runs: IndexMap<String, Family>,
    pub(crate) dormant: IndexMap<String, Dormant>,
    pub(crate) retired: IndexMap<String, RetiredChat>,
    pub(crate) managed_retired: IndexSet<String>,
    pub(crate) cleanup_history: IndexMap<String, ManagedWorktreeCleanupOffer>,
    pub(crate) managed_history_possible: bool,
    wake_failures: HashMap<String, u32>,
    /// The earliest instant this process watched anything; a restored `lastSeenAt` predates it.
    pub(crate) liveness_floor: u64,
    /// Log lines the owner forwards after the operation.
    pub(crate) log: Vec<(Level, String)>,
    /// The retired-worker fences changed and need their own write.
    pub(crate) retired_changed: bool,
}

pub(crate) fn is_over(state: AgentState) -> bool {
    matches!(state, AgentState::Finished | AgentState::Failed)
}

/// Whether this state holds one of the run's worker slots.
pub(crate) fn occupies_slot(state: AgentState) -> bool {
    matches!(
        state,
        AgentState::Invited | AgentState::Active | AgentState::Detached | AgentState::Waking
    )
}

fn has_stopped(state: AgentState) -> bool {
    is_over(state) || state == AgentState::Sleeping
}

fn can_stop(state: AgentState) -> bool {
    !has_stopped(state) && state != AgentState::Waking
}

fn ceiling_crossed(info: &AgentInfo) -> bool {
    info.context_tokens >= WORKER_CONTEXT_CEILING_TOKENS
}

fn silence_parked(info: &AgentInfo) -> bool {
    info.silence_parked == Some(true)
}

fn can_stage_finish(agent: &Agent) -> bool {
    can_stop(agent.info.state)
        || (agent.info.state == AgentState::Sleeping
            && !agent.info.revivable
            && silence_parked(&agent.info)
            && ceiling_crossed(&agent.info))
}

fn recount(agent: &mut Agent) {
    let live: Vec<&AgentMessage> = agent
        .queue
        .iter()
        .filter(|message| message.acked_at.is_none())
        .collect();
    agent.info.pending = live.len() as u64;
    agent.info.awaiting_ack = live
        .iter()
        .filter(|message| message.offered_at.is_some())
        .count() as u64;
}

fn clear_silence(info: &mut AgentInfo) {
    info.silence_parked = Some(false);
    info.silence_recovery_turn_id = Some(None);
    info.silence_recovery_request_origin_max = Some(None);
}

pub(crate) fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    // A failed OS generator leaves zeros; the id is still distinct enough for one process.
    let _ = getrandom::getrandom(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn new_message(from: &str, to: &str, text: String, now: u64) -> AgentMessage {
    AgentMessage {
        id: random_uuid()[..8].to_owned(),
        from: from.to_owned(),
        to: to.to_owned(),
        from_run_id: None,
        time: now,
        text,
        offered_at: None,
        offers: 0,
        offered_on_finish: false,
        offered_via_revival: false,
        acked_at: None,
        extra: Extra::default(),
    }
}

/// `MODEL_SLUG_RE`: `/^[A-Za-z0-9._-]{1,80}$/`.
pub(crate) fn is_model_slug(value: &str) -> bool {
    (1..=MAX_MODEL_CHARS).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) fn reasoning_effort(value: &str) -> Option<ReasoningEffort> {
    ReasoningEffort::ALL
        .iter()
        .copied()
        .find(|effort| effort.as_str() == value)
}

/// One stable reply address plus the eight most recent incarnations.
fn bounded_former_run_ids(ids: Vec<String>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    if unique.len() <= MAX_RECENT_FORMER_RUN_IDS + 1 {
        return unique;
    }
    let stable = unique[0].clone();
    let recent = unique.split_off(unique.len() - MAX_RECENT_FORMER_RUN_IDS);
    std::iter::once(stable).chain(recent).collect()
}

pub(crate) fn bounded(ids: Vec<String>) -> Vec<String> {
    bounded_former_run_ids(ids)
}

fn make_worker(
    id: &str,
    label: &str,
    task: String,
    model: Option<String>,
    reasoning_effort: Option<ReasoningEffort>,
    now: u64,
) -> Agent {
    let title = js_slice(js_trim(first_line(worker_own_task(&task))), 160);
    Agent {
        info: AgentInfo {
            run_id: None,
            worker_allocation_run_id: None,
            managed_worktree: None,
            managed_worktree_cleaned: None,
            prime_conversation_id: None,
            id: id.to_owned(),
            role: AgentRole::Worker,
            label: label.to_owned(),
            task,
            job_title: (!title.is_empty()).then_some(title),
            reasoning_effort,
            model,
            state: AgentState::Invited,
            created_at: now,
            activated_at: None,
            finished_at: None,
            result: None,
            pending: 0,
            awaiting_ack: 0,
            delivered: 0,
            conversation_id: None,
            detached_at: None,
            last_seen_at: None,
            revivable: false,
            silence_parked: Some(false),
            silence_recovery_turn_id: Some(None),
            silence_recovery_request_origin_max: Some(None),
            last_revival_command_id: None,
            slept_at: None,
            context_tokens: 0,
            extra: Extra::default(),
        },
        queue: Vec::new(),
    }
}

fn make_prime(conversation_id: Option<String>, now: u64) -> Agent {
    Agent {
        info: AgentInfo {
            run_id: None,
            worker_allocation_run_id: None,
            managed_worktree: None,
            managed_worktree_cleaned: None,
            prime_conversation_id: None,
            id: PRIME_ID.to_owned(),
            role: AgentRole::Prime,
            label: "Prime".to_owned(),
            task: "Coordinates the workers".to_owned(),
            job_title: None,
            reasoning_effort: None,
            model: None,
            state: AgentState::Active,
            created_at: now,
            activated_at: Some(now),
            finished_at: None,
            result: None,
            pending: 0,
            awaiting_ack: 0,
            delivered: 0,
            conversation_id,
            detached_at: None,
            last_seen_at: Some(now),
            revivable: false,
            silence_parked: Some(false),
            silence_recovery_turn_id: Some(None),
            silence_recovery_request_origin_max: Some(None),
            last_revival_command_id: None,
            slept_at: None,
            context_tokens: 0,
            extra: Extra::default(),
        },
        queue: Vec::new(),
    }
}

fn valid_setup_profile(value: Option<&str>) -> Option<&str> {
    value.filter(|id| (1..=64).contains(&id.encode_utf16().count()))
}

/// The prime row that `stateForAgents` sorts first, then workers by id.
fn sorted_infos(family: &Family) -> Vec<AgentInfo> {
    let mut list: Vec<AgentInfo> = family
        .agents
        .values()
        .map(|agent| agent.info.clone())
        .collect();
    list.sort_by(|a, b| match (a.role, b.role) {
        (AgentRole::Prime, AgentRole::Worker) => std::cmp::Ordering::Less,
        (AgentRole::Worker, AgentRole::Prime) => std::cmp::Ordering::Greater,
        _ => a.id.cmp(&b.id),
    });
    list
}

impl Broker {
    fn info(&mut self, text: String) {
        self.log.push((Level::Info, text));
    }

    fn warn(&mut self, text: String) {
        self.log.push((Level::Warn, text));
    }

    // ------------------------------------------------------------------ families

    pub(crate) fn family(&self, slot: &Slot) -> Option<&Family> {
        match slot {
            Slot::Active(key) => self.runs.get(key),
            Slot::Dormant(key) => self.dormant.get(key).map(|dormant| &dormant.family),
        }
    }

    fn family_mut(&mut self, slot: &Slot) -> Option<&mut Family> {
        match slot {
            Slot::Active(key) => self.runs.get_mut(key),
            Slot::Dormant(key) => self.dormant.get_mut(key).map(|dormant| &mut dormant.family),
        }
    }

    fn all_slots(&self) -> Vec<Slot> {
        self.runs
            .keys()
            .map(|key| Slot::Active(key.clone()))
            .chain(self.dormant.keys().map(|key| Slot::Dormant(key.clone())))
            .collect()
    }

    fn answers_to(&self, slot: &Slot, run_id: &str) -> bool {
        slot.key() == run_id
            || self
                .family(slot)
                .is_some_and(|family| family.former_run_ids.iter().any(|id| id == run_id))
    }

    fn reply_address(&self, slot: &Slot) -> String {
        self.family(slot)
            .and_then(|family| family.former_run_ids.first().cloned())
            .unwrap_or_else(|| slot.key().to_owned())
    }

    fn has_identity(caller: &Caller, policy: &Policy) -> bool {
        caller.conversation_id.is_some()
            || (policy.allow_unattributed && caller.request_id.is_some())
    }

    fn owns_prime(caller: &Caller, family: &Family, policy: &Policy) -> bool {
        if let Some(prime) = &family.prime_conversation_id {
            return caller.conversation_id.as_ref() == Some(prime);
        }
        family.prime_request_id.is_some()
            && caller.conversation_id.is_none()
            && policy.allow_unattributed
            && caller.request_id == family.prime_request_id
    }

    fn belongs(caller: &Caller, family: &Family, policy: &Policy) -> bool {
        Self::owns_prime(caller, family, policy)
            || caller
                .conversation_id
                .as_deref()
                .is_some_and(|conversation| family.has_worker_conversation(conversation))
    }

    fn profile_matches(caller: &Caller, family: &Family) -> bool {
        match (
            valid_setup_profile(caller.setup_profile_id.as_deref()),
            family.setup_profile_id.as_deref(),
        ) {
            (Some(current), Some(owner)) => current == owner,
            _ => true,
        }
    }

    fn require_matching_profile(&self, caller: &Caller, policy: &Policy) -> Result<()> {
        let Some(current) = valid_setup_profile(caller.setup_profile_id.as_deref()) else {
            return Ok(());
        };
        let mismatch = self.all_slots().into_iter().any(|slot| {
            self.family(&slot).is_some_and(|family| {
                Self::belongs(caller, family, policy)
                    && family
                        .setup_profile_id
                        .as_deref()
                        .is_some_and(|owner| owner != current)
            })
        });
        if mismatch {
            return Err(AgentError::refused(
                "CONNECTION_PROFILE_MISMATCH: this worker family belongs to a different Setup profile. No agent operation was performed. Switch back to the connection that created this family; cross-profile worker routing is not automatic.",
            ));
        }
        Ok(())
    }

    fn families_for(&self, caller: &Caller, policy: &Policy) -> Vec<Slot> {
        self.all_slots()
            .into_iter()
            .filter(|slot| {
                self.family(slot).is_some_and(|family| {
                    Self::profile_matches(caller, family) && Self::belongs(caller, family, policy)
                })
            })
            .collect()
    }

    fn selected(&self, caller: &Caller, policy: &Policy) -> Option<Slot> {
        let owned = self.families_for(caller, policy);
        match &caller.run_id {
            Some(run_id) => owned
                .iter()
                .find(|slot| slot.key() == run_id)
                .or_else(|| owned.iter().find(|slot| self.answers_to(slot, run_id)))
                .cloned(),
            None if owned.len() == 1 => owned.into_iter().next(),
            None => None,
        }
    }

    fn require_family_selection(&self, caller: &Caller, policy: &Policy) -> Result<()> {
        self.require_matching_profile(caller, policy)?;
        let owned = self.families_for(caller, policy);
        if let Some(run_id) = &caller.run_id
            && !owned.iter().any(|slot| self.answers_to(slot, run_id))
        {
            return Err(AgentError::busy());
        }
        if caller.run_id.is_none() && owned.len() > 1 {
            return Err(AgentError::refused(
                "RUN_SELECTION_REQUIRED: this caller owns several worker fleets. Use agents action=status and select the intended run_id; worker names are local to each fleet. No agent operation was performed.",
            ));
        }
        Ok(())
    }

    fn run_for_caller(&self, caller: &Caller, policy: &Policy) -> Option<String> {
        match self.selected(caller, policy) {
            Some(Slot::Active(key)) => Some(key),
            _ => None,
        }
    }

    fn dormant_for_caller(&self, caller: &Caller, policy: &Policy) -> Option<String> {
        match self.selected(caller, policy) {
            Some(Slot::Dormant(key)) => Some(key),
            _ => None,
        }
    }

    pub fn agent_families_for_caller(&self, caller: &Caller, policy: &Policy) -> Vec<FamilyChoice> {
        self.families_for(caller, policy)
            .into_iter()
            .map(|slot| FamilyChoice {
                running: slot.running(),
                run_id: slot.key().to_owned(),
            })
            .collect()
    }

    /// The one active run this conversation belongs to, prime or worker, or none when ambiguous.
    fn run_for_conversation(&self, conversation: &str) -> Option<String> {
        let mut found = None;
        for (key, family) in &self.runs {
            let member = family.prime_conversation_id.as_deref() == Some(conversation)
                || family
                    .agents
                    .values()
                    .any(|agent| agent.info.conversation_id.as_deref() == Some(conversation));
            if !member {
                continue;
            }
            if found.is_some() {
                return None;
            }
            found = Some(key.clone());
        }
        found
    }

    /// `currentRunId(conversation)`: the one active run this chat belongs to.
    pub fn current_run_id(&self, conversation: &str) -> Option<String> {
        self.run_for_conversation(conversation)
    }

    /// `boundAgent`: the agent of the active run bound to this conversation, terminal or not.
    fn bound_agent(&self, conversation: &str) -> Option<(String, String)> {
        let run_id = self.run_for_conversation(conversation)?;
        let family = &self.runs[&run_id];
        if family.prime_conversation_id.as_deref() == Some(conversation) {
            return family.prime().map(|_| (run_id, PRIME_ID.to_owned()));
        }
        let id = family
            .agents
            .values()
            .find(|agent| agent.info.conversation_id.as_deref() == Some(conversation))?
            .info
            .id
            .clone();
        Some((run_id, id))
    }

    /// `agentForConversationId`: like [`Self::bound_agent`], skipping terminal workers.
    fn live_agent_for_conversation(&self, conversation: &str) -> Option<(String, String)> {
        let run_id = self.run_for_conversation(conversation)?;
        let family = &self.runs[&run_id];
        if family.prime_conversation_id.as_deref() == Some(conversation) {
            return family.prime().map(|_| (run_id, PRIME_ID.to_owned()));
        }
        let id = family
            .agents
            .values()
            .find(|agent| {
                agent.info.conversation_id.as_deref() == Some(conversation)
                    && !is_over(agent.info.state)
            })?
            .info
            .id
            .clone();
        Some((run_id, id))
    }

    fn dormant_agent_for_conversation(&self, conversation: &str) -> Option<(String, String)> {
        let mut found = None;
        for (key, dormant) in &self.dormant {
            if dormant.family.prime_conversation_id.as_deref() == Some(conversation) {
                if dormant.family.prime().is_none() || found.is_some() {
                    return None;
                }
                found = Some((key.clone(), PRIME_ID.to_owned()));
                continue;
            }
            for agent in dormant.family.agents.values() {
                if agent.info.role != AgentRole::Worker
                    || agent.info.conversation_id.as_deref() != Some(conversation)
                {
                    continue;
                }
                if found.is_some() {
                    return None;
                }
                found = Some((key.clone(), agent.info.id.clone()));
            }
        }
        found
    }

    /// Every worker chat, active or parked, with the family that owns it: what
    /// `workerPrimeOwner` and `isWorkerConversation` answer from.
    pub fn worker_ownership(&self) -> Ownership {
        let mut workers: HashMap<String, Vec<WorkerPrimeOwner>> = HashMap::new();
        let families = self
            .runs
            .iter()
            .map(|(key, family)| (key.as_str(), family))
            .chain(
                self.dormant
                    .iter()
                    .map(|(key, dormant)| (key.as_str(), &dormant.family)),
            );
        for (key, family) in families {
            for agent in family.agents.values() {
                let Some(conversation) = &agent.info.conversation_id else {
                    continue;
                };
                if agent.info.role != AgentRole::Worker {
                    continue;
                }
                workers
                    .entry(conversation.clone())
                    .or_default()
                    .push(WorkerPrimeOwner {
                        owned: true,
                        prime_conversation_id: family.prime_conversation_id.clone(),
                        run_id: Some(key.to_owned()),
                        setup_profile_id: family.setup_profile_id.clone(),
                    });
            }
        }
        Ownership { workers }
    }

    pub fn is_worker_conversation(&self, conversation: &str) -> bool {
        !conversation.is_empty()
            && self
                .runs
                .values()
                .chain(self.dormant.values().map(|dormant| &dormant.family))
                .any(|family| family.has_worker_conversation(conversation))
    }

    fn stamp(&mut self, run_id: &str) {
        let Some(family) = self.runs.get_mut(run_id) else {
            return;
        };
        let prime = family.prime_conversation_id.clone();
        for agent in family.agents.values_mut() {
            agent.info.run_id = Some(run_id.to_owned());
            agent.info.prime_conversation_id = prime.clone();
        }
    }

    /// A parked family comes back as a fresh incarnation: the run id is the stale-command fence.
    fn reactivate(&mut self, key: &str, now: u64) -> Option<String> {
        let mut dormant = self.dormant.shift_remove(key)?;
        let prime = dormant.family.agents.get_mut(PRIME_ID)?;
        prime.info.state = AgentState::Active;
        prime.info.detached_at = None;
        prime.info.last_seen_at = Some(now);
        let run_id = random_uuid();
        let mut former = dormant.family.former_run_ids.clone();
        former.push(key.to_owned());
        dormant.family.former_run_ids = bounded_former_run_ids(former);
        let conversation = dormant.family.prime_conversation_id.clone();
        self.runs.insert(run_id.clone(), dormant.family);
        self.stamp(&run_id);
        self.info(format!(
            "multi-agent: reactivated workers owned by conversation {} as run {run_id}",
            conversation.as_deref().unwrap_or("null")
        ));
        Some(run_id)
    }

    // ------------------------------------------------------------------ reads

    fn require_enabled(policy: &Policy) -> Result<()> {
        if policy.enabled {
            Ok(())
        } else {
            Err(AgentError::refused(DISABLED))
        }
    }

    fn state_for(
        &self,
        family: &Family,
        running: bool,
        retained: bool,
        policy: &Policy,
    ) -> SwarmState {
        SwarmState {
            enabled: policy.enabled,
            running,
            retained_history: Some(retained),
            retained_workers: None,
            agents: sorted_infos(family),
        }
    }

    /// `swarmStateForCaller`: only this caller's families, never another prime's.
    pub fn swarm_state_for_caller(&self, caller: &Caller, policy: &Policy) -> Result<SwarmState> {
        Self::require_enabled(policy)?;
        if !Self::has_identity(caller, policy) {
            return Err(AgentError::Identity(IDENTITY_LOST.to_owned()));
        }
        self.require_matching_profile(caller, policy)?;
        let owned: Vec<Slot> = self
            .families_for(caller, policy)
            .into_iter()
            .filter(|slot| {
                caller
                    .run_id
                    .as_ref()
                    .is_none_or(|run_id| self.answers_to(slot, run_id))
            })
            .collect();
        Ok(SwarmState {
            enabled: true,
            running: owned.iter().any(Slot::running),
            retained_history: Some(owned.iter().any(|slot| !slot.running())),
            retained_workers: None,
            agents: owned
                .iter()
                .filter_map(|slot| self.family(slot))
                .flat_map(sorted_infos)
                .collect(),
        })
    }

    /// `swarmState()`: what the app and `/v1/agents` show.
    pub fn swarm_state(&self, policy: &Policy) -> SwarmState {
        SwarmState {
            enabled: policy.enabled,
            running: !self.runs.is_empty(),
            retained_history: Some(!self.dormant.is_empty()),
            retained_workers: Some(
                self.dormant
                    .values()
                    .flat_map(|dormant| sorted_infos(&dormant.family))
                    .filter(|info| info.role == AgentRole::Worker)
                    .collect(),
            ),
            agents: self.runs.values().flat_map(sorted_infos).collect(),
        }
    }

    fn resolve(&self, caller: &Caller, policy: &Policy) -> Option<(String, String)> {
        let run_id = self.run_for_caller(caller, policy)?;
        let family = &self.runs[&run_id];
        if Self::owns_prime(caller, family, policy) {
            return family.prime().map(|_| (run_id, PRIME_ID.to_owned()));
        }
        let conversation = caller.conversation_id.as_deref()?;
        let id = family
            .agents
            .values()
            .find(|agent| {
                agent.info.conversation_id.as_deref() == Some(conversation)
                    && !is_over(agent.info.state)
            })?
            .info
            .id
            .clone();
        Some((run_id, id))
    }

    pub fn free_worker_slots(&self, run_id: Option<&str>, policy: &Policy) -> u64 {
        let family = match run_id {
            Some(run_id) => self.runs.get(run_id),
            None if self.runs.len() == 1 => self.runs.values().next(),
            None => None,
        };
        match family {
            Some(family) => policy.max_workers.saturating_sub(family.working() as u64),
            None if run_id.is_none() && self.runs.is_empty() => policy.max_workers,
            None => 0,
        }
    }

    fn global_occupied(&self) -> u64 {
        self.runs
            .values()
            .map(|family| family.working() as u64)
            .sum()
    }

    fn global_free(&self, policy: &Policy) -> Option<u64> {
        (policy.global_max_workers > 0).then(|| {
            policy
                .global_max_workers
                .saturating_sub(self.global_occupied())
        })
    }

    /// `statusForCaller`: one caller-scoped snapshot, so no run id or slot count leaks.
    pub fn status_for_caller(&self, caller: &Caller, policy: &Policy) -> Result<CallerStatus> {
        let run = self.run_for_caller(caller, policy);
        Self::require_enabled(policy)?;
        if !Self::has_identity(caller, policy) {
            return Err(AgentError::Identity(IDENTITY_LOST.to_owned()));
        }
        self.require_matching_profile(caller, policy)?;
        if caller.run_id.is_some() && self.selected(caller, policy).is_none() {
            return Err(AgentError::busy());
        }
        if let Some(run_id) = run
            && let Some((_, id)) = self.resolve(caller, policy)
        {
            let family = &self.runs[&run_id];
            return Ok(CallerStatus {
                self_info: Some(family.agents[&id].info.clone()),
                state: self.state_for(family, true, false, policy),
                free_worker_slots: self.free_worker_slots(Some(&run_id), policy),
                run_id: Some(run_id),
            });
        }
        if let Some(key) = self.dormant_for_caller(caller, policy) {
            let family = &self.dormant[&key].family;
            let member = if Self::owns_prime(caller, family, policy) {
                family.prime()
            } else {
                family.agents.values().find(|agent| {
                    agent.info.role == AgentRole::Worker
                        && agent.info.conversation_id == caller.conversation_id
                })
            };
            if let Some(member) = member {
                return Ok(CallerStatus {
                    self_info: Some(member.info.clone()),
                    state: self.state_for(family, false, true, policy),
                    run_id: None,
                    free_worker_slots: policy.max_workers,
                });
            }
        }
        Ok(CallerStatus {
            self_info: None,
            state: SwarmState {
                enabled: policy.enabled,
                running: false,
                retained_history: Some(false),
                retained_workers: None,
                agents: Vec::new(),
            },
            run_id: None,
            free_worker_slots: policy.max_workers,
        })
    }

    /// Attribution for an ordinary tool call: only ever a binding, never a claim.
    pub fn agent_for_caller(&self, caller: &Caller, policy: &Policy) -> Option<String> {
        if !policy.enabled {
            return None;
        }
        if caller.run_id.is_none()
            && self.families_for(caller, policy).iter().any(|slot| {
                self.family(slot)
                    .is_some_and(|family| Self::owns_prime(caller, family, policy))
            })
        {
            return Some(PRIME_ID.to_owned());
        }
        self.resolve(caller, policy).map(|(_, id)| id)
    }

    fn require_member(&self, caller: &Caller, policy: &Policy) -> Result<(String, String)> {
        let run = self.run_for_caller(caller, policy);
        Self::require_enabled(policy)?;
        if !Self::has_identity(caller, policy) {
            return Err(AgentError::Identity(IDENTITY_LOST.to_owned()));
        }
        if run.is_none() && !self.runs.is_empty() {
            return Err(AgentError::busy());
        }
        if run.is_none() {
            return Err(AgentError::refused(format!(
                "No sub-agent run is active in {}. The chat that calls agents action=spawn becomes the prime agent of a new run.",
                policy.core_connector
            )));
        }
        self.resolve(caller, policy).ok_or_else(AgentError::busy)
    }

    // ------------------------------------------------------------------ lifecycle

    fn end_run(&mut self, run_id: &str, reason: &str, now: u64) {
        let agents: Vec<Agent> = match self.runs.get(run_id) {
            Some(family) => family.agents.values().cloned().collect(),
            None => return,
        };
        self.retire_cleanup_offers(&agents, CleanupReason::Cleared, now);
        let retired: Vec<RetiredChat> = agents
            .iter()
            .filter(|agent| agent.info.role == AgentRole::Worker)
            .filter_map(|agent| {
                Some(RetiredChat {
                    id: agent.info.id.clone(),
                    conversation_id: agent.info.conversation_id.clone()?,
                    reason: reason.to_owned(),
                    retired_at: now,
                    extra: Extra::default(),
                })
            })
            .collect();
        for worker in &retired {
            self.retired
                .insert(worker.conversation_id.clone(), worker.clone());
        }
        for agent in &agents {
            if agent.info.role == AgentRole::Worker
                && agent.info.managed_worktree == Some(true)
                && let Some(conversation) = &agent.info.conversation_id
            {
                self.managed_retired.insert(conversation.clone());
            }
        }
        self.retired_changed = true;
        let ids: Vec<&str> = agents.iter().map(|agent| agent.info.id.as_str()).collect();
        let what = format!("{run_id} ({})", ids.join(", "));
        self.runs.shift_remove(run_id);
        for worker in &retired {
            self.wake_failures.remove(&worker.conversation_id);
        }
        self.info(format!("multi-agent: ended run {what} \u{2014} {reason}"));
    }

    /// Parks an incarnation with no slot-holder, keeping its whole history.
    fn park_run(&mut self, run_id: &str, reason: &str, now: u64) -> bool {
        let Some(family) = self.runs.get(run_id) else {
            return false;
        };
        if family.working() > 0 {
            return false;
        }
        let Some(family) = self.runs.shift_remove(run_id) else {
            return false;
        };
        let conversation = family.prime_conversation_id.clone();
        self.dormant.insert(
            run_id.to_owned(),
            Dormant {
                family,
                parked_at: now,
            },
        );
        self.info(format!(
            "multi-agent: parked run {run_id} for conversation {} \u{2014} {reason}",
            conversation.as_deref().unwrap_or("null")
        ));
        self.prune_dormant(now);
        true
    }

    /// Drops parked families past a week or beyond the newest sixteen, oldest first.
    pub(crate) fn prune_dormant(&mut self, now: u64) -> bool {
        let mut candidates: Vec<(String, u64)> = self
            .dormant
            .iter()
            .map(|(key, dormant)| (key.clone(), dormant.parked_at))
            .collect();
        candidates.sort_by_key(|(_, parked_at)| *parked_at);
        let total = candidates.len();
        let evict: Vec<String> = candidates
            .into_iter()
            .enumerate()
            .filter(|(index, (_, parked_at))| {
                now.saturating_sub(*parked_at) >= DORMANT_RUN_TTL_MS
                    || total - index > MAX_DORMANT_RUNS
            })
            .map(|(_, (key, _))| key)
            .collect();
        if evict.is_empty() {
            return false;
        }
        for key in evict {
            let Some(dormant) = self.dormant.shift_remove(&key) else {
                continue;
            };
            let agents: Vec<Agent> = dormant.family.agents.values().cloned().collect();
            self.retire_cleanup_offers(&agents, CleanupReason::Evicted, now);
            for agent in &agents {
                let Some(conversation) = &agent.info.conversation_id else {
                    continue;
                };
                if agent.info.role != AgentRole::Worker {
                    continue;
                }
                if agent.info.managed_worktree == Some(true) {
                    self.managed_retired.insert(conversation.clone());
                }
                self.retired.insert(
                    conversation.clone(),
                    RetiredChat {
                        id: agent.info.id.clone(),
                        conversation_id: conversation.clone(),
                        reason: "its parked worker history was dropped".to_owned(),
                        retired_at: now,
                        extra: Extra::default(),
                    },
                );
            }
            self.info(format!(
                "multi-agent: dropped the parked worker history of conversation {}",
                dormant
                    .family
                    .prime_conversation_id
                    .as_deref()
                    .unwrap_or("null")
            ));
        }
        self.retired_changed = true;
        true
    }

    pub(crate) fn prune_retired(&mut self, now: u64) {
        let cutoff = now.saturating_sub(RETIRED_WORKER_TTL_MS);
        let before = self.retired.len();
        self.retired.retain(|_, worker| worker.retired_at >= cutoff);
        if self.retired.len() != before {
            self.retired_changed = true;
        }
    }

    pub fn retired_worker_for_conversation(
        &mut self,
        conversation: &str,
        now: u64,
    ) -> Option<RetiredChat> {
        self.prune_retired(now);
        self.retired.get(conversation).cloned()
    }

    fn retire_cleanup_offers(&mut self, agents: &[Agent], reason: CleanupReason, now: u64) {
        for agent in agents {
            let Some((run_id, agent_id)) = cleanup_identity(&agent.info) else {
                continue;
            };
            let key = format!("{run_id}:{agent_id}");
            if agent.info.managed_worktree_cleaned == Some(true) {
                self.cleanup_history.shift_remove(&key);
                continue;
            }
            let existing = self.cleanup_history.get(&key).cloned();
            let label = cleanup_label(&agent.info);
            self.cleanup_history.insert(
                key,
                ManagedWorktreeCleanupOffer {
                    run_id,
                    agent_id,
                    reason,
                    created_at: existing.as_ref().map_or(now, |offer| offer.created_at),
                    label: if label.is_empty() {
                        existing.and_then(|offer| offer.label)
                    } else {
                        Some(label)
                    },
                    extra: Extra::default(),
                },
            );
        }
    }

    // ------------------------------------------------------------------ spawn

    /// Claims the calling conversation as prime and creates its workers. Every check runs
    /// before the first mutation; the owner's copy-on-write discards a refused one entirely.
    pub fn spawn(
        &mut self,
        caller: &Caller,
        workers: &[WorkerRequest],
        context: Option<&str>,
        policy: &Policy,
        models: &[ObservedModel],
        now: u64,
    ) -> Result<SpawnResult> {
        Self::require_enabled(policy)?;
        self.require_family_selection(caller, policy)?;
        let mut run = self.run_for_caller(caller, policy);
        let max = policy.max_workers;
        if workers.is_empty() {
            return Err(AgentError::refused("At least one worker is required"));
        }
        let context = context.map(js_trim).unwrap_or_default();
        if js_length(context) > MAX_CONTEXT_CHARS {
            return Err(AgentError::refused(format!(
                "The shared context is too long (limit {MAX_CONTEXT_CHARS} characters)"
            )));
        }
        let mut notes: Vec<String> = Vec::new();
        let mut planned = Vec::with_capacity(workers.len());
        for (index, worker) in workers.iter().enumerate() {
            let task = js_trim(&worker.task);
            if task.is_empty() {
                return Err(AgentError::refused(format!(
                    "Worker {} has no task. Every worker needs one.",
                    index + 1
                )));
            }
            if js_length(task) > MAX_TASK_CHARS {
                return Err(AgentError::refused(format!(
                    "Worker {}'s task is too long",
                    index + 1
                )));
            }
            let label = worker.label.as_deref().map(js_trim).unwrap_or_default();
            if js_length(label) > MAX_LABEL_CHARS {
                return Err(AgentError::refused(format!(
                    "Worker {}'s label is too long (limit {MAX_LABEL_CHARS} characters)",
                    index + 1
                )));
            }
            let default_model = worker.model.is_none();
            let default_effort = worker.reasoning_effort.is_none();
            let model = normalize_model(
                index,
                worker.model.as_deref().or(policy.default_model.as_deref()),
            )?;
            let effort = match &worker.reasoning_effort {
                Some(value) => normalize_effort(index, value)?,
                None => policy.default_reasoning,
            };
            let (model, effort) = usable_defaults(
                model,
                effort,
                default_model,
                default_effort,
                models,
                &mut notes,
            );
            validate_worker_model(index, model.as_deref(), effort, models)?;
            planned.push(Planned {
                label: label.to_owned(),
                task: worker_brief(context, task),
                model,
                effort,
            });
        }

        let conversation = caller.conversation_id.clone();
        if !Self::has_identity(caller, policy) {
            return Err(AgentError::Identity(UNIDENTIFIED_CALLER.to_owned()));
        }
        if let Some(run_id) = &run {
            if let Some((_, id)) = self.resolve(caller, policy)
                && self.runs[run_id].agents[&id].info.role == AgentRole::Worker
            {
                return Err(AgentError::refused(format!(
                    "{id} is a worker in this run. Workers must not create workers of their own \u{2014} send the prime agent a message instead and let it decide."
                )));
            }
            if !Self::owns_prime(caller, &self.runs[run_id], policy) {
                return Err(AgentError::busy());
            }
        }
        if let Some(conversation) = &conversation
            && (self.is_worker_conversation(conversation)
                || self
                    .retired_worker_for_conversation(conversation, now)
                    .is_some()
                || self.managed_retired.contains(conversation))
        {
            return Err(AgentError::refused(
                "WORKTREE_OWNER_UNAVAILABLE: retired worker conversations cannot create new prime runs or workers.",
            ));
        }
        if caller.run_id.is_some()
            && run.is_none()
            && self.dormant_for_caller(caller, policy).is_none()
        {
            return Err(AgentError::busy());
        }
        let became_prime = run.is_none();
        if run.is_none() {
            if let Some(key) = self.dormant_for_caller(caller, policy) {
                run = self.reactivate(&key, now);
                if run.is_none() {
                    return Err(AgentError::refused(
                        "PRIME_TRANSFER_IN_PROGRESS: this conversation is being compacted/resumed, so its worker history cannot start a new active incarnation until that handoff settles.",
                    ));
                }
            } else {
                let run_id = random_uuid();
                let mut agents = IndexMap::new();
                agents.insert(PRIME_ID.to_owned(), make_prime(conversation.clone(), now));
                self.runs.insert(
                    run_id.clone(),
                    Family {
                        former_run_ids: Vec::new(),
                        setup_profile_id: valid_setup_profile(caller.setup_profile_id.as_deref())
                            .map(str::to_owned),
                        prime_conversation_id: conversation.clone(),
                        prime_request_id: if conversation.is_some() {
                            None
                        } else {
                            caller.request_id.clone()
                        },
                        started_at: now,
                        agents,
                    },
                );
                self.stamp(&run_id);
                run = Some(run_id);
            }
        }
        let Some(run_id) = run else {
            return Err(AgentError::refused(
                "The worker history could not acquire the active run slot.",
            ));
        };

        let live: Vec<AgentInfo> = self.runs[&run_id]
            .agents
            .values()
            .filter(|agent| agent.info.role == AgentRole::Worker && occupies_slot(agent.info.state))
            .map(|agent| agent.info.clone())
            .collect();
        if let Some(repeat) = match_existing(&planned, &live) {
            self.info(format!(
                "multi-agent: repeated spawn matched {} existing worker(s) in run {run_id}",
                repeat.len()
            ));
            return Ok(SpawnResult {
                created: repeat,
                became_prime,
                run_id,
                newly_staged: Vec::new(),
                default_notes: notes,
            });
        }
        let total = live.len() + planned.len();
        if total as u64 > max {
            return Err(AgentError::refused(format!(
                "That would make {total} live workers; the limit set in the app is {max}."
            )));
        }
        if policy.global_max_workers > 0 {
            let global = self.global_occupied() + planned.len() as u64;
            if global > policy.global_max_workers {
                return Err(AgentError::refused(format!(
                    "GLOBAL_WORKER_LIMIT: that would make {global} live workers across all prime families; the global worker admission limit set in the app is {}. Wait for a worker to stop and try again.",
                    policy.global_max_workers
                )));
            }
        }

        let mut ids = Vec::with_capacity(planned.len());
        let mut n = 1;
        while ids.len() < planned.len() {
            let id = format!("worker-{n}");
            if !self.runs[&run_id].agents.contains_key(&id) {
                ids.push(id);
            }
            n += 1;
        }
        let mut created = Vec::with_capacity(planned.len());
        for (worker, id) in planned.into_iter().zip(ids) {
            let label = if worker.label.is_empty() {
                id.clone()
            } else {
                worker.label
            };
            let mut agent = make_worker(&id, &label, worker.task, worker.model, worker.effort, now);
            agent.info.worker_allocation_run_id = Some(run_id.clone());
            if let Some(family) = self.runs.get_mut(&run_id) {
                family.agents.insert(id.clone(), agent);
            }
            self.stamp(&run_id);
            created.push(self.runs[&run_id].agents[&id].info.clone());
        }
        let conversation_text = conversation.as_deref().unwrap_or("null");
        self.info(if became_prime {
            format!(
                "multi-agent: run {run_id} started by conversation {conversation_text} with {} worker(s)",
                created.len()
            )
        } else {
            format!(
                "multi-agent: created {} worker(s) in run {run_id}",
                created.len()
            )
        });
        Ok(SpawnResult {
            newly_staged: created.iter().map(|info| info.id.clone()).collect(),
            created,
            became_prime,
            run_id,
            default_notes: notes,
        })
    }

    /// Marks a newly reserved worker as owning a managed checkout.
    pub fn mark_worker_worktree(&mut self, run_id: &str, agent_id: &str) -> Result<()> {
        let agent = self
            .runs
            .get_mut(run_id)
            .and_then(|family| family.agents.get_mut(agent_id))
            .filter(|agent| agent.info.role == AgentRole::Worker)
            .ok_or_else(|| {
                AgentError::refused(
                    "WORKTREE_OWNER_NOT_STAGED: only a newly reserved worker may claim a managed worktree",
                )
            })?;
        if agent.info.worker_allocation_run_id.as_deref() != Some(run_id) {
            return Err(AgentError::refused(
                "WORKTREE_OWNER_MISMATCH: worker allocation identity changed during staging",
            ));
        }
        agent.info.managed_worktree = Some(true);
        self.managed_history_possible = true;
        Ok(())
    }

    /// `managedWorkerRecoveryIdentities`: managed checkouts whose accepted worker could still
    /// execute. Terminal rows stay isolation fences and cleanup offers, never startup leases,
    /// and an identity two families claim restores neither.
    pub fn managed_recovery_identities(&self) -> Vec<(String, String)> {
        let families: Vec<&Family> = self
            .runs
            .values()
            .chain(self.dormant.values().map(|dormant| &dormant.family))
            .collect();
        let candidates: Vec<(String, String)> = families
            .iter()
            .flat_map(|family| family.agents.values())
            .filter(|agent| {
                let info = &agent.info;
                info.role == AgentRole::Worker
                    && info.managed_worktree == Some(true)
                    && info.managed_worktree_cleaned != Some(true)
                    && (occupies_slot(info.state)
                        || (info.state == AgentState::Sleeping
                            && (info.revivable
                                || (silence_parked(info)
                                    && info.conversation_id.is_some()
                                    && matches!(info.silence_recovery_turn_id, Some(Some(_)))
                                    && matches!(
                                        info.silence_recovery_request_origin_max,
                                        Some(Some(_))
                                    )))))
            })
            .filter_map(|agent| {
                let run = agent.info.worker_allocation_run_id.clone()?;
                cleanup_identity_shape(&run, &agent.info.id).then(|| (run, agent.info.id.clone()))
            })
            .collect();
        candidates
            .iter()
            .filter(|candidate| {
                candidates.iter().filter(|other| other == candidate).count() == 1
                    && families
                        .iter()
                        .filter(|family| {
                            family
                                .agents
                                .get(&candidate.1)
                                .and_then(|agent| agent.info.worker_allocation_run_id.as_deref())
                                == Some(candidate.0.as_str())
                        })
                        .count()
                        == 1
            })
            .cloned()
            .collect()
    }

    /// Workers still owed a browser tab.
    pub fn pending_worker_spawns(&self) -> Vec<WorkerSpawn> {
        self.runs
            .iter()
            .flat_map(|(run_id, family)| {
                family
                    .agents
                    .values()
                    .filter(|agent| {
                        agent.info.role == AgentRole::Worker
                            && agent.info.state == AgentState::Invited
                    })
                    .map(move |agent| WorkerSpawn {
                        run_id: run_id.clone(),
                        prime_conversation_id: family.prime_conversation_id.clone(),
                        id: agent.info.id.clone(),
                        task: agent.info.task.clone(),
                        model: agent.info.model.clone(),
                        reasoning_effort: agent.info.reasoning_effort,
                    })
            })
            .collect()
    }

    // ------------------------------------------------------------------ binding

    /// The extension acknowledged the tab it opened for this worker: bind and start it.
    pub fn bind_conversation(
        &mut self,
        id: &str,
        conversation: &str,
        run_id: Option<&str>,
        now: u64,
    ) -> bool {
        let Some(run_id) = self.scoped_run(run_id) else {
            return false;
        };
        let Some(agent) = self.runs[&run_id].agents.get(id) else {
            return false;
        };
        if agent.info.role != AgentRole::Worker || has_stopped(agent.info.state) {
            return false;
        }
        if conversation.is_empty() {
            return false;
        }
        if let Some(bound) = &agent.info.conversation_id {
            if bound != conversation {
                let text = format!(
                    "multi-agent: refused to move {id} from conversation {bound} to {conversation}"
                );
                self.warn(text);
                return false;
            }
        } else {
            if let Some((taken_run, taken)) = self.bound_agent(conversation)
                && !(taken_run == run_id && taken == id)
            {
                self.warn(format!(
                    "multi-agent: refused to bind {id} to conversation {conversation}, already held by {taken}"
                ));
                return false;
            }
            if let Some((_, taken)) = self.dormant_agent_for_conversation(conversation) {
                self.warn(format!(
                    "multi-agent: refused to bind {id} to conversation {conversation}, already owned by dormant {taken}"
                ));
                return false;
            }
        }
        let mut activated = false;
        if let Some(agent) = self
            .runs
            .get_mut(&run_id)
            .and_then(|family| family.agents.get_mut(id))
        {
            agent.info.conversation_id = Some(conversation.to_owned());
            if agent.info.state == AgentState::Invited {
                agent.info.state = AgentState::Active;
                agent.info.activated_at = Some(now);
                activated = true;
            }
        }
        if activated {
            self.info(format!(
                "multi-agent: {id} is active in conversation {conversation}"
            ));
        }
        true
    }

    fn scoped_run(&self, run_id: Option<&str>) -> Option<String> {
        match run_id {
            Some(run_id) => self.runs.contains_key(run_id).then(|| run_id.to_owned()),
            None if self.runs.len() == 1 => self.runs.keys().next().cloned(),
            None => None,
        }
    }

    // ------------------------------------------------------------------ messages

    fn assert_room(agent: &Agent, incoming: usize) -> Result<()> {
        let waiting = agent
            .queue
            .iter()
            .filter(|message| message.acked_at.is_none())
            .count();
        if waiting + incoming > MAX_QUEUE {
            return Err(AgentError::refused(format!(
                "QUEUE_FULL: {} already has {waiting} unacknowledged messages, which is the limit. Nothing was sent and nothing was discarded. A queue this deep normally means that agent has stopped calling tools.",
                agent.info.id
            )));
        }
        Ok(())
    }

    fn enqueue(agent: &mut Agent, message: AgentMessage) {
        agent.queue.push(message);
        if agent.queue.len() > MAX_QUEUE * 2 {
            let settled: Vec<AgentMessage> = agent
                .queue
                .iter()
                .filter(|message| message.acked_at.is_some())
                .cloned()
                .collect();
            let keep = settled.len().saturating_sub(MAX_QUEUE);
            let mut queue: Vec<AgentMessage> = settled.into_iter().skip(keep).collect();
            queue.extend(
                agent
                    .queue
                    .iter()
                    .filter(|message| message.acked_at.is_none())
                    .cloned(),
            );
            agent.queue = queue;
        }
        recount(agent);
    }

    /// One message from an existing prime to another prime family, by its opaque run address.
    pub fn prime_message(
        &mut self,
        caller: &Caller,
        target_run_id: &str,
        text: &str,
        policy: &Policy,
        now: u64,
    ) -> Result<PrimeMessage> {
        Self::require_enabled(policy)?;
        self.require_family_selection(caller, policy)?;
        if !Self::has_identity(caller, policy) {
            return Err(AgentError::Identity(IDENTITY_LOST.to_owned()));
        }
        let source = self.selected(caller, policy).ok_or_else(|| {
            AgentError::refused(
                "No prime family belongs to this conversation. Call agents action=spawn before messaging another prime.",
            )
        })?;
        let source_family = self.family(&source).cloned().ok_or_else(AgentError::busy)?;
        if !Self::owns_prime(caller, &source_family, policy) {
            return Err(AgentError::refused(
                "Only a prime agent may message another prime family.",
            ));
        }
        let address = js_trim(target_run_id);
        let matches: Vec<Slot> = if address.is_empty() {
            Vec::new()
        } else {
            self.all_slots()
                .into_iter()
                .filter(|slot| self.answers_to(slot, address))
                .collect()
        };
        let [target] = matches.as_slice() else {
            return Err(AgentError::refused(
                "TARGET_RUN_UNAVAILABLE: no addressable prime family matches target_run_id. Nothing was sent.",
            ));
        };
        let target = target.clone();
        let target_family = self.family(&target).cloned().ok_or_else(AgentError::busy)?;
        if Self::owns_prime(caller, &target_family, policy) {
            return Err(AgentError::refused(
                "A prime cannot message one of its own families through target_run_id.",
            ));
        }
        let Some(prime) = target_family.prime() else {
            return Err(AgentError::refused(
                "TARGET_RUN_UNAVAILABLE: the addressed prime family has no reachable prime. Nothing was sent.",
            ));
        };
        let trimmed = js_trim(text);
        if trimmed.is_empty() {
            return Err(AgentError::refused("The message is empty"));
        }
        if js_length(trimmed) > MAX_MESSAGE_CHARS {
            return Err(AgentError::refused(format!(
                "Message is too long (limit {MAX_MESSAGE_CHARS} characters)"
            )));
        }
        Self::assert_room(prime, 1)?;
        let source_run_id = self.reply_address(&source);
        let mut message = new_message(PRIME_ID, PRIME_ID, trimmed.to_owned(), now);
        message.from_run_id = Some(source_run_id.clone());
        if let Some(prime) = self
            .family_mut(&target)
            .and_then(|family| family.agents.get_mut(PRIME_ID))
        {
            Self::enqueue(prime, message.clone());
        }
        Ok(PrimeMessage {
            source_run_id,
            target_run_id: target.key().to_owned(),
            message,
        })
    }

    /// Several messages from the caller in one operation, all or nothing.
    pub fn stage_messages(
        &mut self,
        caller: &Caller,
        items: &[MessageItem],
        policy: &Policy,
        now: u64,
    ) -> Result<StagedMessages> {
        self.require_family_selection(caller, policy)?;
        if items.is_empty() {
            return Err(AgentError::refused("No messages were given"));
        }
        if items.len() > MAX_BATCH_MESSAGES {
            return Err(AgentError::refused(format!(
                "Too many messages in one call (limit {MAX_BATCH_MESSAGES})"
            )));
        }
        let mut caller = caller.clone();
        if self.run_for_caller(&caller, policy).is_none()
            && Self::has_identity(&caller, policy)
            && let Some(key) = self.dormant_for_caller(&caller, policy)
        {
            let run_id = self.reactivate(&key, now).ok_or_else(|| {
                AgentError::refused(
                    "PRIME_TRANSFER_IN_PROGRESS: this conversation is being compacted/resumed, so its sleeping workers cannot be woken until that handoff settles.",
                )
            })?;
            caller.run_id = Some(run_id);
        }
        self.stage_messages_active(&caller, items, policy, now)
    }

    fn stage_messages_active(
        &mut self,
        caller: &Caller,
        items: &[MessageItem],
        policy: &Policy,
        now: u64,
    ) -> Result<StagedMessages> {
        let (run_id, from_id) = self.require_member(caller, policy)?;
        let family = &self.runs[&run_id];
        let from = &family.agents[&from_id];
        if is_over(from.info.state) {
            return Err(AgentError::refused(format!(
                "{from_id} has {} and cannot send messages.",
                if from.info.state == AgentState::Failed {
                    "failed"
                } else {
                    "finished"
                }
            )));
        }
        let mut planned: Vec<(String, AgentMessage)> = Vec::new();
        let mut per_recipient: HashMap<String, usize> = HashMap::new();
        let mut reserved: Vec<String> = Vec::new();
        let mut labels: HashMap<String, String> = HashMap::new();
        let free = self.free_worker_slots(Some(&run_id), policy) as usize;
        let global_free = self.global_free(policy);
        for (index, item) in items.iter().enumerate() {
            let at = if items.len() > 1 {
                format!(" (message {} of {})", index + 1, items.len())
            } else {
                String::new()
            };
            let trimmed = js_trim(&item.text);
            if trimmed.is_empty() {
                return Err(AgentError::refused(format!("The message is empty{at}")));
            }
            if js_length(trimmed) > MAX_MESSAGE_CHARS {
                return Err(AgentError::refused(format!(
                    "Message is too long (limit {MAX_MESSAGE_CHARS} characters){at}"
                )));
            }
            let to_id = js_trim(&item.to);
            let Some(to) = (!to_id.is_empty())
                .then(|| family.agents.get(to_id))
                .flatten()
            else {
                return Err(AgentError::refused(format!(
                    "Unknown agent \"{to_id}\"{at}. Call agents action=status to see who exists."
                )));
            };
            if from.info.id == to.info.id {
                return Err(AgentError::refused("An agent cannot message itself"));
            }
            if from.info.role == AgentRole::Worker && to.info.role != AgentRole::Prime {
                return Err(AgentError::refused(
                    "Workers may only message the prime agent. Send it there and let the prime decide.",
                ));
            }
            if from.info.role == AgentRole::Prime && to.info.role != AgentRole::Worker {
                return Err(AgentError::refused(
                    "The prime agent can only message workers",
                ));
            }
            if let Some(label) = &item.label {
                let label = js_trim(label);
                if label.is_empty() || js_length(label) > MAX_LABEL_CHARS {
                    return Err(AgentError::refused(
                        "Worker label must contain 1\u{2013}60 characters.",
                    ));
                }
                if from.info.role != AgentRole::Prime
                    || to.info.role != AgentRole::Worker
                    || to.info.state != AgentState::Sleeping
                {
                    return Err(AgentError::refused(
                        "label is only valid when the prime wakes a sleeping worker.",
                    ));
                }
                if labels.get(to_id).is_some_and(|known| known != label) {
                    return Err(AgentError::refused(
                        "Conflicting labels for the same worker.",
                    ));
                }
                labels.insert(to_id.to_owned(), label.to_owned());
            }
            if is_over(to.info.state) {
                return Err(AgentError::refused(
                    if to.info.state == AgentState::Failed {
                        format!("{to_id} has failed and is no longer listening{at}")
                    } else {
                        format!(
                            "{to_id} is finished for good \u{2014} its own chat reached the context limit, so it cannot be woken{at}. Spawn a new worker for this work."
                        )
                    },
                ));
            }
            if to.info.state == AgentState::Waking {
                return Err(AgentError::refused(format!(
                    "REVIVE_IN_PROGRESS: {to_id} is being woken right now{at}. Nothing was sent; send this again once it is awake, or once you are told the revival failed."
                )));
            }
            if to.info.state == AgentState::Sleeping {
                if silence_parked(&to.info) && !to.info.revivable {
                    return Err(AgentError::refused(format!(
                        "{to_id} is context-limited and its previous turn is still unresolved{at}. Nothing was sent. Spawn a new worker for new work."
                    )));
                }
                if to.info.conversation_id.is_none() {
                    return Err(AgentError::refused(format!(
                        "{to_id} is asleep but this app never learned which chat it is in, so it cannot be woken{at}."
                    )));
                }
                if !reserved.iter().any(|id| id == to_id) {
                    if free.saturating_sub(reserved.len()) == 0 {
                        return Err(AgentError::refused(format!(
                            "NO_FREE_SLOT: {to_id} is asleep and all {} worker slots are busy, so it cannot be woken right now{at}. Nothing was sent. Wait for a worker to report and try again.",
                            policy.max_workers
                        )));
                    }
                    if let Some(global_free) = global_free
                        && global_free.saturating_sub(reserved.len() as u64) == 0
                    {
                        return Err(AgentError::refused(format!(
                            "GLOBAL_WORKER_LIMIT: {to_id} is asleep and all {} globally admitted worker slots are busy, so it cannot be woken right now{at}. Nothing was sent. Wait for a worker to stop and try again.",
                            policy.global_max_workers
                        )));
                    }
                    reserved.push(to_id.to_owned());
                }
            }
            let already = per_recipient.get(to_id).copied().unwrap_or(0);
            Self::assert_room(to, already + 1)?;
            per_recipient.insert(to_id.to_owned(), already + 1);
            planned.push((
                to_id.to_owned(),
                new_message(&from.info.id, to_id, trimmed.to_owned(), now),
            ));
        }
        let family = self.runs.get_mut(&run_id).ok_or_else(AgentError::busy)?;
        for (to, message) in &planned {
            if let Some(agent) = family.agents.get_mut(to) {
                Self::enqueue(agent, message.clone());
            }
        }
        let mut woken = Vec::new();
        for id in &reserved {
            if let Some(agent) = family.agents.get_mut(id) {
                begin_revival(agent, labels.get(id).map(String::as_str));
                woken.push(format!(
                    "multi-agent: {id} is being woken in conversation {}",
                    agent.info.conversation_id.as_deref().unwrap_or("null")
                ));
            }
        }
        for line in woken {
            self.info(line);
        }
        Ok(StagedMessages {
            run_id,
            messages: planned.into_iter().map(|(_, message)| message).collect(),
            waking: reserved,
        })
    }

    /// The inbox for this caller's next tool result: oldest first, bounded, at least once.
    pub fn offer_for_caller(
        &mut self,
        caller: &Caller,
        on_finish: bool,
        policy: &Policy,
        now: u64,
    ) -> Option<(String, Vec<AgentMessage>)> {
        let owned: Vec<Slot> = self
            .families_for(caller, policy)
            .into_iter()
            .filter(|slot| {
                self.family(slot)
                    .is_some_and(|family| Self::owns_prime(caller, family, policy))
                    && caller
                        .run_id
                        .as_ref()
                        .is_none_or(|run_id| self.answers_to(slot, run_id))
            })
            .collect();
        if !owned.is_empty() {
            let several = owned.len() > 1;
            let mut budget = MAX_INBOX_OFFER_CHARS;
            let mut messages = Vec::new();
            for slot in owned {
                let key = slot.key().to_owned();
                if let Some(prime) = self
                    .family_mut(&slot)
                    .and_then(|family| family.agents.get_mut(PRIME_ID))
                {
                    for mut message in offer_agent(prime, on_finish, budget, now) {
                        budget = budget.saturating_sub(js_length(&message.text));
                        if several {
                            message.extra.insert("runId".into(), key.clone().into());
                        }
                        messages.push(message);
                    }
                }
            }
            return Some((PRIME_ID.to_owned(), messages));
        }
        if caller.run_id.is_some() && self.selected(caller, policy).is_none() {
            return None;
        }
        let conversation = caller.conversation_id.as_deref()?;
        if let Some((run_id, id)) = self.bound_agent(conversation) {
            let agent = self.runs.get_mut(&run_id)?.agents.get_mut(&id)?;
            return Some((
                id,
                offer_agent(agent, on_finish, MAX_INBOX_OFFER_CHARS, now),
            ));
        }
        let (key, id) = self.dormant_agent_for_conversation(conversation)?;
        let agent = self.dormant.get_mut(&key)?.family.agents.get_mut(&id)?;
        if agent.info.role == AgentRole::Worker && !(on_finish && has_stopped(agent.info.state)) {
            return None;
        }
        Some((
            id,
            offer_agent(agent, on_finish, MAX_INBOX_OFFER_CHARS, now),
        ))
    }

    /// Retires what was offered before this call began, except finish-borne offers on a finish.
    pub fn acknowledge_for_caller(
        &mut self,
        caller: &Caller,
        by_finish: bool,
        call_started_at: u64,
        policy: &Policy,
        now: u64,
    ) -> Option<(String, Vec<AgentMessage>)> {
        let owned: Vec<Slot> = self
            .families_for(caller, policy)
            .into_iter()
            .filter(|slot| {
                self.family(slot)
                    .is_some_and(|family| Self::owns_prime(caller, family, policy))
                    && caller
                        .run_id
                        .as_ref()
                        .is_none_or(|run_id| self.answers_to(slot, run_id))
            })
            .collect();
        if !owned.is_empty() {
            let mut messages = Vec::new();
            for slot in owned {
                if let Some(prime) = self
                    .family_mut(&slot)
                    .and_then(|family| family.agents.get_mut(PRIME_ID))
                {
                    messages.extend(acknowledge_agent(prime, by_finish, call_started_at, now));
                }
            }
            return Some((PRIME_ID.to_owned(), messages));
        }
        if caller.run_id.is_some() && self.selected(caller, policy).is_none() {
            return None;
        }
        let conversation = caller.conversation_id.as_deref()?;
        if let Some((run_id, id)) = self.bound_agent(conversation) {
            let agent = self.runs.get_mut(&run_id)?.agents.get_mut(&id)?;
            return Some((
                id,
                acknowledge_agent(agent, by_finish, call_started_at, now),
            ));
        }
        let (key, id) = self.dormant_agent_for_conversation(conversation)?;
        let agent = self.dormant.get_mut(&key)?.family.agents.get_mut(&id)?;
        if agent.info.role == AgentRole::Worker && !(by_finish && has_stopped(agent.info.state)) {
            return None;
        }
        Some((
            id,
            acknowledge_agent(agent, by_finish, call_started_at, now),
        ))
    }

    /// Parks every run, or one, once none of its workers holds a slot.
    pub fn release_quiescent_run(&mut self, run_id: Option<&str>, reason: &str, now: u64) -> bool {
        let ids: Vec<String> = match run_id {
            Some(run_id) => vec![run_id.to_owned()],
            None => self.runs.keys().cloned().collect(),
        };
        let mut parked = false;
        for id in ids {
            parked |= self.park_run(&id, reason, now);
        }
        parked
    }

    // ------------------------------------------------------------------ finish

    fn finish_target(&self, caller: &Caller, policy: &Policy) -> Result<Slot2> {
        Self::require_enabled(policy)?;
        self.require_family_selection(caller, policy)?;
        if !Self::has_identity(caller, policy) {
            return Err(AgentError::Identity(IDENTITY_LOST.to_owned()));
        }
        let prime_refusal = || {
            AgentError::refused(
                "The prime agent does not finish: the run ends when its workers have reported and the user is done with it.",
            )
        };
        let found = self.resolve(caller, policy).or_else(|| {
            let conversation = caller.conversation_id.as_deref()?;
            let run_id = self.run_for_conversation(conversation)?;
            let agent = self.runs[&run_id].agents.values().find(|agent| {
                agent.info.conversation_id.as_deref() == Some(conversation)
                    && is_over(agent.info.state)
            })?;
            Some((run_id, agent.info.id.clone()))
        });
        if let Some((run_id, id)) = found {
            if id == PRIME_ID {
                return Err(prime_refusal());
            }
            return Ok(Slot2 {
                slot: Slot::Active(run_id),
                id,
            });
        }
        let dormant = caller
            .conversation_id
            .as_deref()
            .and_then(|conversation| self.dormant_agent_for_conversation(conversation));
        if let Some((key, id)) = &dormant {
            let info = &self.dormant[key].family.agents[id].info;
            if info.role == AgentRole::Worker && has_stopped(info.state) {
                return Ok(Slot2 {
                    slot: Slot::Dormant(key.clone()),
                    id: id.clone(),
                });
            }
        }
        if !self.runs.is_empty() {
            return Err(AgentError::busy());
        }
        let Some((key, id)) = dormant else {
            return Err(AgentError::refused(
                "No sub-agent run or worker history belongs to this conversation.",
            ));
        };
        if id == PRIME_ID {
            return Err(prime_refusal());
        }
        let _ = key;
        Err(AgentError::refused(format!(
            "{id} is dormant but has not finished, so finish cannot be retried from this state."
        )))
    }

    /// An explicit `agents finish` from the calling worker. A second finish is the same finish.
    pub fn finish(
        &mut self,
        caller: &Caller,
        result: &str,
        policy: &Policy,
        now: u64,
    ) -> Result<FinishResult> {
        let target = self.finish_target(caller, policy)?;
        self.finish_slot(&target, result, &[], policy, now)
    }

    /// The browser saw this worker's turn settle with an answer: the same finish, app-owned.
    pub fn finish_worker_conversation(
        &mut self,
        conversation: &str,
        result: &str,
        policy: &Policy,
        now: u64,
    ) -> Option<FinishResult> {
        let (run_id, id) = self.live_agent_for_conversation(conversation)?;
        let agent = &self.runs[&run_id].agents[&id];
        if agent.info.role != AgentRole::Worker || !can_stage_finish(agent) {
            return None;
        }
        let acknowledged: Vec<String> = agent
            .queue
            .iter()
            .filter(|message| {
                message.acked_at.is_none()
                    && message.offered_at.is_some()
                    && !message.offered_on_finish
            })
            .map(|message| message.id.clone())
            .collect();
        let target = Slot2 {
            slot: Slot::Active(run_id),
            id,
        };
        self.finish_slot(&target, result, &acknowledged, policy, now)
            .ok()
    }

    fn finish_slot(
        &mut self,
        target: &Slot2,
        result: &str,
        acknowledged: &[String],
        policy: &Policy,
        now: u64,
    ) -> Result<FinishResult> {
        let family = self.family(&target.slot).ok_or_else(AgentError::busy)?;
        let agent = &family.agents[&target.id];
        if !can_stage_finish(agent) {
            let text = format!(
                "multi-agent: {} called finish again after it had already stopped ({})",
                agent.info.id,
                agent.info.state.as_str()
            );
            let info = agent.info.clone();
            self.info(text);
            return Ok(FinishResult {
                info,
                report: None,
                repeat: true,
            });
        }
        let Slot::Active(_) = &target.slot else {
            return Err(AgentError::refused("No sub-agent run is active."));
        };
        let (info, report) = plan_finish(family, agent, result, policy, now);
        let family = self.family_mut(&target.slot).ok_or_else(AgentError::busy)?;
        if let Some(agent) = family.agents.get_mut(&target.id) {
            let mut delivered = 0;
            for message in &mut agent.queue {
                if message.acked_at.is_none() && acknowledged.contains(&message.id) {
                    message.acked_at = Some(now);
                    delivered += 1;
                }
            }
            agent.info.delivered += delivered;
            agent.info.state = info.state;
            agent.info.finished_at = info.finished_at;
            agent.info.slept_at = info.slept_at;
            agent.info.detached_at = None;
            agent.info.result = info.result.clone();
            agent.info.revivable = info.revivable;
            clear_silence(&mut agent.info);
            recount(agent);
        }
        if let Some(prime) = family.agents.get_mut(PRIME_ID) {
            prime.queue.push(report.clone());
            recount(prime);
        }
        let info = family.agents[&target.id].info.clone();
        self.info(format!(
            "multi-agent: {} {}",
            info.id,
            if info.state == AgentState::Finished {
                "finished for good"
            } else {
                "is sleeping"
            }
        ));
        Ok(FinishResult {
            info,
            report: Some(report),
            repeat: false,
        })
    }

    /// Ends a worker that never got off the ground (or that a person cleared), definitively.
    pub fn fail_agent(
        &mut self,
        id: &str,
        reason: &str,
        note: Option<String>,
        revivable: bool,
        run_id: Option<&str>,
        now: u64,
    ) -> Option<FinishResult> {
        let run_id = self.scoped_run(run_id)?;
        let family = self.runs.get_mut(&run_id)?;
        let agent = family.agents.get_mut(id)?;
        if agent.info.role != AgentRole::Worker || is_over(agent.info.state) {
            return None;
        }
        agent.info.state = AgentState::Failed;
        agent.info.finished_at = Some(now);
        agent.info.detached_at = None;
        agent.info.result = Some(js_slice(reason, MAX_MESSAGE_CHARS));
        agent.info.revivable = revivable;
        clear_silence(&mut agent.info);
        if !revivable {
            agent.queue.clear();
        }
        recount(agent);
        let result = agent.info.result.clone().unwrap_or_default();
        let info = agent.info.clone();
        let report = new_message(
            id,
            PRIME_ID,
            note.unwrap_or_else(|| format!(
                "[{id} failed] The worker did not start: {result}. It will not report. Continue that part of the work yourself. Resolve the reported startup problem before spawning a replacement; repeating the same failed startup opens more tabs without starting the work."
            )),
            now,
        );
        if let Some(prime) = family.agents.get_mut(PRIME_ID) {
            prime.queue.push(report.clone());
            recount(prime);
        }
        self.warn(format!("multi-agent: {id} failed \u{2014} {reason}"));
        Some(FinishResult {
            info,
            report: Some(report),
            repeat: false,
        })
    }

    /// Puts a worker to sleep on evidence that it stopped working, without ending it.
    pub fn sleep_worker(
        &mut self,
        id: &str,
        reason: &str,
        run_id: Option<&str>,
        now: u64,
    ) -> Option<FinishResult> {
        let run_id = self.scoped_run(run_id)?;
        let family = self.runs.get_mut(&run_id)?;
        let agent = family.agents.get_mut(id)?;
        if agent.info.role != AgentRole::Worker || !can_stop(agent.info.state) {
            return None;
        }
        let terminal = ceiling_crossed(&agent.info);
        agent.info.state = if terminal {
            AgentState::Finished
        } else {
            AgentState::Sleeping
        };
        agent.info.slept_at = Some(now);
        agent.info.finished_at = terminal.then_some(now);
        agent.info.detached_at = None;
        agent.info.revivable = !terminal;
        recount(agent);
        let info = agent.info.clone();
        let report = new_message(
            id,
            PRIME_ID,
            if terminal {
                format!(
                    "[{id} finished] {reason} Its chat has also reached the context limit, so it cannot be woken again. Its worker slot is free; spawn a new worker if that work still matters."
                )
            } else {
                format!(
                    "[{id} is sleeping] {reason} Its worker slot is free and its chat is intact \u{2014} wake it with agents action=message to=\"{id}\" when you have more for it, rather than spawning a new worker."
                )
            },
            now,
        );
        if let Some(prime) = family.agents.get_mut(PRIME_ID) {
            prime.queue.push(report.clone());
            recount(prime);
        }
        self.info(format!(
            "multi-agent: {id} {} \u{2014} {reason}",
            if terminal {
                "finished for good"
            } else {
                "is sleeping"
            }
        ));
        Some(FinishResult {
            info,
            report: Some(report),
            repeat: false,
        })
    }

    // ------------------------------------------------------------------ revival

    /// Workers whose slot is reserved and whose chat has not been typed into yet.
    pub fn pending_worker_revivals(&self, policy: &Policy) -> Vec<WorkerRevival> {
        let mut out = Vec::new();
        for (run_id, family) in &self.runs {
            for agent in family.agents.values() {
                let Some(conversation) = &agent.info.conversation_id else {
                    continue;
                };
                if agent.info.state != AgentState::Waking {
                    continue;
                }
                let (text, message_ids) = revival_text(agent, policy);
                out.push(WorkerRevival {
                    prime_conversation_id: family.prime_conversation_id.clone(),
                    id: agent.info.id.clone(),
                    conversation_id: conversation.clone(),
                    run_id: run_id.clone(),
                    text,
                    message_ids,
                });
            }
        }
        out
    }

    fn agent_mut(&mut self, id: &str, run_id: Option<&str>) -> Option<&mut Agent> {
        let run_id = self.scoped_run(run_id)?;
        self.runs.get_mut(&run_id)?.agents.get_mut(id)
    }

    /// The browser redeemed this wake: from now on it, not a late MCP call, owns it.
    pub fn claim_worker_revival(
        &mut self,
        id: &str,
        conversation: &str,
        run_id: Option<&str>,
    ) -> bool {
        let Some(agent) = self.agent_mut(id, run_id) else {
            return false;
        };
        if agent.info.state != AgentState::Waking
            || agent.info.conversation_id.as_deref() != Some(conversation)
        {
            return false;
        }
        agent.info.revivable = false;
        true
    }

    pub fn rollback_worker_revival_claim(
        &mut self,
        id: &str,
        conversation: &str,
        run_id: Option<&str>,
    ) -> bool {
        let Some(agent) = self.agent_mut(id, run_id) else {
            return false;
        };
        if agent.info.state != AgentState::Waking
            || agent.info.conversation_id.as_deref() != Some(conversation)
            || agent.info.revivable
        {
            return false;
        }
        agent.info.revivable = true;
        true
    }

    /// The browser typed the prime's message into the worker's own chat: an offer, not liveness.
    pub fn note_worker_revived(
        &mut self,
        id: &str,
        conversation: &str,
        message_ids: &[String],
        command_id: Option<&str>,
        run_id: Option<&str>,
        now: u64,
    ) -> bool {
        let Some(agent) = self.agent_mut(id, run_id) else {
            return false;
        };
        if agent.info.state != AgentState::Waking {
            return false;
        }
        if conversation.is_empty() || agent.info.conversation_id.as_deref() != Some(conversation) {
            self.warn(format!(
                "multi-agent: refused a revival ack for {id} naming conversation {conversation}"
            ));
            return false;
        }
        agent.info.revivable = false;
        agent.info.finished_at = None;
        agent.info.result = None;
        if let Some(command) = command_id {
            agent.info.last_revival_command_id = Some(Some(command.to_owned()));
        }
        for message in &mut agent.queue {
            if message.acked_at.is_some() || !message_ids.contains(&message.id) {
                continue;
            }
            message.offered_at = Some(now);
            message.offers += 1;
            message.offered_on_finish = false;
            message.offered_via_revival = true;
        }
        recount(agent);
        self.info(format!(
            "multi-agent: revival message reached {id} in conversation {conversation}; waiting for worker liveness"
        ));
        true
    }

    /// The browser could not wake this worker: the slot goes back and the prime is told.
    pub fn fail_worker_revival(
        &mut self,
        id: &str,
        why: &str,
        run_id: Option<&str>,
        now: u64,
    ) -> Option<AgentMessage> {
        let run = self.scoped_run(run_id)?;
        let agent = self.runs.get(&run)?.agents.get(id)?;
        if agent.info.state != AgentState::Waking {
            return None;
        }
        let chat = agent
            .info
            .conversation_id
            .clone()
            .unwrap_or_else(|| id.to_owned());
        let strikes = self.wake_failures.get(&chat).copied().unwrap_or(0) + 1;
        self.wake_failures.insert(chat.clone(), strikes);
        if strikes >= WAKE_FAILURES_BEFORE_GIVING_UP && !ceiling_crossed(&agent.info) {
            let failed = self.fail_agent(
                id,
                &format!("its chat did not answer {strikes} revivals in a row ({why})"),
                Some(format!(
                    "[{id} failed] Its chat did not answer {strikes} revivals in a row: {why} Treat it as gone \u{2014} do not try to wake it again. Do that part of the work yourself or spawn a replacement worker. Should its chat ever call in again, you will be told it is back."
                )),
                true,
                Some(&run),
                now,
            );
            if let Some(failed) = failed {
                self.wake_failures.remove(&chat);
                return failed.report;
            }
        }
        let family = self.runs.get_mut(&run)?;
        let agent = family.agents.get_mut(id)?;
        if let Some(report) = return_waking_to_stopped(
            agent,
            now,
            &format!("The browser could not complete its revival: {why}"),
            now,
        ) {
            if let Some(prime) = family.agents.get_mut(PRIME_ID) {
                prime.queue.push(report.clone());
                recount(prime);
            }
            self.wake_failures.remove(&chat);
            self.warn(format!(
                "multi-agent: could not wake {id}; the chat crossed its context ceiling while revival was in flight"
            ));
            return Some(report);
        }
        let report = new_message(
            id,
            PRIME_ID,
            format!(
                "[{id} could not be woken] {why} It is still asleep and still holds everything it knew. Any revival text ChatGPT accepted remains offered but was not proven read, so it will not be injected twice. Its slot is free again: try agents action=message to=\"{id}\" once more, or do that work another way."
            ),
            now,
        );
        if let Some(prime) = family.agents.get_mut(PRIME_ID) {
            prime.queue.push(report.clone());
            recount(prime);
        }
        self.warn(format!("multi-agent: could not wake {id} \u{2014} {why}"));
        Some(report)
    }

    /// What the session store measured this agent's own chat to carry. Never decreases.
    pub fn note_context_tokens(&mut self, conversation: &str, tokens: u64, now: u64) -> bool {
        let found = self
            .bound_agent(conversation)
            .map(|(run, id)| (Slot::Active(run), id))
            .or_else(|| {
                self.dormant_agent_for_conversation(conversation)
                    .map(|(key, id)| (Slot::Dormant(key), id))
            });
        let Some((slot, id)) = found else {
            return false;
        };
        let Some(family) = self.family_mut(&slot) else {
            return false;
        };
        let Some(agent) = family.agents.get_mut(&id) else {
            return false;
        };
        if agent.info.context_tokens >= tokens {
            return false;
        }
        let crossed = !ceiling_crossed(&agent.info) && tokens >= WORKER_CONTEXT_CEILING_TOKENS;
        agent.info.context_tokens = tokens;
        if crossed && agent.info.role == AgentRole::Worker {
            if agent.info.state == AgentState::Sleeping && !silence_parked(&agent.info) {
                let report = finish_stopped_at_ceiling(
                    agent,
                    "A late measurement crossed the context ceiling after this worker had already stopped.",
                    agent.info.slept_at.unwrap_or(now),
                    now,
                );
                if let Some(prime) = family.agents.get_mut(PRIME_ID) {
                    prime.queue.push(report);
                    recount(prime);
                }
            } else if has_stopped(agent.info.state) {
                agent.info.revivable = false;
            }
        }
        true
    }

    // ------------------------------------------------------------------ clearing

    /// Explicit "Clear swarm": every family ends and every worker chat stays fenced.
    pub fn reset(&mut self, now: u64) {
        let reason = "the run was cleared in the app";
        for run_id in self.runs.keys().cloned().collect::<Vec<_>>() {
            self.end_run(&run_id, reason, now);
        }
        self.wake_failures.clear();
        let dormant: Vec<Dormant> = self.dormant.drain(..).map(|(_, dormant)| dormant).collect();
        for dormant in dormant {
            let agents: Vec<Agent> = dormant.family.agents.values().cloned().collect();
            self.retire_cleanup_offers(&agents, CleanupReason::Cleared, now);
            for agent in agents {
                let Some(conversation) = agent.info.conversation_id.clone() else {
                    continue;
                };
                if agent.info.role != AgentRole::Worker {
                    continue;
                }
                if agent.info.managed_worktree == Some(true) {
                    self.managed_retired.insert(conversation.clone());
                }
                self.retired.insert(
                    conversation.clone(),
                    RetiredChat {
                        id: agent.info.id,
                        conversation_id: conversation,
                        reason: reason.to_owned(),
                        retired_at: now,
                        extra: Extra::default(),
                    },
                );
                self.retired_changed = true;
            }
        }
    }

    /// Feature off: live workers stop but stay reusable, and every family parks.
    pub fn pause_for_disable(&mut self, reason: &str, now: u64) -> bool {
        let mut parked = false;
        for run_id in self.runs.keys().cloned().collect::<Vec<_>>() {
            if let Some(family) = self.runs.get_mut(&run_id) {
                for agent in family.agents.values_mut() {
                    if agent.info.role != AgentRole::Worker {
                        continue;
                    }
                    let unresolved =
                        agent.info.state == AgentState::Sleeping && silence_parked(&agent.info);
                    if has_stopped(agent.info.state) && !unresolved {
                        continue;
                    }
                    if agent.info.conversation_id.is_none() {
                        agent.info.state = AgentState::Failed;
                        agent.info.finished_at = Some(now);
                        agent.info.slept_at = None;
                        agent.info.detached_at = None;
                        agent.info.revivable = false;
                        clear_silence(&mut agent.info);
                        agent.info.result = Some(js_slice(reason, MAX_MESSAGE_CHARS));
                        agent.queue.clear();
                        recount(agent);
                        continue;
                    }
                    let terminal = ceiling_crossed(&agent.info);
                    agent.info.state = if terminal {
                        AgentState::Finished
                    } else {
                        AgentState::Sleeping
                    };
                    agent.info.slept_at = Some(now);
                    agent.info.finished_at = terminal.then_some(now);
                    agent.info.detached_at = None;
                    agent.info.revivable = !terminal;
                    clear_silence(&mut agent.info);
                    recount(agent);
                }
            }
            parked |= self.park_run(&run_id, reason, now);
        }
        let mut terminalized = false;
        for dormant in self.dormant.values_mut() {
            for agent in dormant.family.agents.values_mut() {
                if agent.info.role != AgentRole::Worker
                    || agent.info.state != AgentState::Sleeping
                    || !silence_parked(&agent.info)
                    || !ceiling_crossed(&agent.info)
                {
                    continue;
                }
                agent.info.state = AgentState::Finished;
                agent.info.slept_at = agent.info.slept_at.or(Some(now));
                agent.info.finished_at = Some(now);
                agent.info.detached_at = None;
                agent.info.revivable = false;
                clear_silence(&mut agent.info);
                recount(agent);
                terminalized = true;
            }
        }
        parked || terminalized
    }

    /// A person cleared one row in the app. The prime is the run, so clearing it ends the run.
    pub fn clear_agent(&mut self, id: &str, run_id: Option<&str>, now: u64) -> ClearOutcome {
        let run = self.scoped_run(run_id);
        if id == PRIME_ID {
            let Some(run) = run else {
                return ClearOutcome::None("there is no run to clear".to_owned());
            };
            self.end_run(&run, "the run was cleared in the app", now);
            return ClearOutcome::Run;
        }
        let Some(agent) = run
            .as_ref()
            .and_then(|run| self.runs.get(run))
            .and_then(|family| family.agents.get(id))
            .cloned()
        else {
            return ClearOutcome::None(format!("{id} is not part of this run"));
        };
        if is_over(agent.info.state) {
            return ClearOutcome::None(format!("{id} has already ended"));
        }
        let outcome = self.fail_agent(
            id,
            "the user cleared this worker in the app",
            Some(format!(
                "[{id} cleared] The user ended this worker from the app. It will not report and cannot be messaged. Carry on without it, or spawn a replacement worker if the work still needs doing."
            )),
            false,
            run.as_deref(),
            now,
        );
        if outcome.is_some() {
            self.retire_cleanup_offers(&[agent], CleanupReason::Cleared, now);
        }
        ClearOutcome::Worker(outcome.and_then(|outcome| outcome.report).map(Box::new))
    }
}

fn cleanup_identity_shape(run_id: &str, agent_id: &str) -> bool {
    let valid_agent = agent_id.strip_prefix("worker-").is_some_and(|n| {
        (1..=6).contains(&n.len()) && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
    });
    valid_agent && is_allocation_uuid(run_id)
}

/// A finished or failed managed worker's cleanup identity: `(allocation run id, worker id)`.
pub(crate) fn cleanup_identity(info: &AgentInfo) -> Option<(String, String)> {
    let run_id = info.worker_allocation_run_id.as_deref()?;
    let agent = info.id.strip_prefix("worker-")?;
    let valid_agent = (1..=6).contains(&agent.len())
        && !agent.starts_with('0')
        && agent.bytes().all(|byte| byte.is_ascii_digit());
    (info.role == AgentRole::Worker
        && info.managed_worktree == Some(true)
        && valid_agent
        && is_allocation_uuid(run_id))
    .then(|| (run_id.to_ascii_lowercase(), info.id.clone()))
}

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`.
pub(crate) fn is_allocation_uuid(value: &str) -> bool {
    uuid_shape(value, |version| (b'1'..=b'8').contains(&version))
}

/// The same with version 4 only, the run-id rule for restored incarnations.
pub(crate) fn is_v4_uuid(value: &str) -> bool {
    uuid_shape(value, |version| version == b'4')
}

fn uuid_shape(value: &str, version: impl Fn(u8) -> bool) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let ok = match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => version(*byte),
            19 => matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_hexdigit(),
        };
        if !ok {
            return false;
        }
    }
    true
}

pub(crate) fn cleanup_label(info: &AgentInfo) -> String {
    let title = if !info.label.is_empty() && info.label != info.id {
        info.label.clone()
    } else {
        info.job_title
            .clone()
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| worker_own_task(&info.task).to_owned())
    };
    let line = js_trim(first_line(&title));
    let chosen = if !line.is_empty() {
        line.to_owned()
    } else if !info.label.is_empty() {
        info.label.clone()
    } else {
        info.id.clone()
    };
    js_slice(&chosen, 160)
}

/// The finish's result row and its report to the prime.
fn plan_finish(
    family: &Family,
    agent: &Agent,
    result: &str,
    policy: &Policy,
    now: u64,
) -> (AgentInfo, AgentMessage) {
    let unconfirmed: Vec<&AgentMessage> = agent
        .queue
        .iter()
        .filter(|message| {
            message.acked_at.is_none()
                && (message.offered_at.is_none() || message.offered_on_finish)
        })
        .collect();
    let terminal = ceiling_crossed(&agent.info);
    let mut info = agent.info.clone();
    info.state = if terminal {
        AgentState::Finished
    } else {
        AgentState::Sleeping
    };
    info.finished_at = terminal.then_some(now);
    info.slept_at = Some(now);
    info.detached_at = None;
    info.result = Some(js_slice(result, MAX_MESSAGE_CHARS));
    info.revivable = !terminal;
    clear_silence(&mut info);
    let queued_next: Vec<&str> = if terminal {
        Vec::new()
    } else {
        unconfirmed
            .iter()
            .filter(|message| message.offered_at.is_none())
            .map(|message| message.id.as_str())
            .collect()
    };
    let uncertain: Vec<&str> = unconfirmed
        .iter()
        .map(|message| message.id.as_str())
        .filter(|id| !queued_next.contains(id))
        .collect();
    let list = |ids: &[&str]| {
        let head: Vec<&str> = ids.iter().take(5).copied().collect();
        format!(
            "{}{}",
            head.join(", "),
            if ids.len() > 5 { ", \u{2026}" } else { "" }
        )
    };
    let id = &agent.info.id;
    let mut caveat = String::new();
    if !uncertain.is_empty() {
        caveat.push_str(&format!(
            "\n({id} ended without ever confirming {} message(s) you sent it \u{2014} {}. Assume it may not have read them and check the result against what you asked for.)",
            uncertain.len(),
            list(&uncertain)
        ));
    }
    if !queued_next.is_empty() {
        caveat.push_str(&format!(
            "\n({} message(s) you sent {id} arrived after its last step \u{2014} {}. They are still queued for it and reach it next; there is no need to send them again.)",
            queued_next.len(),
            list(&queued_next)
        ));
    }
    let max = policy.max_workers;
    let still_working = family
        .agents
        .values()
        .filter(|other| {
            other.info.role == AgentRole::Worker
                && other.info.id != *id
                && occupies_slot(other.info.state)
        })
        .count() as u64;
    let free = max.saturating_sub(still_working);
    let slots = if free > 0 {
        format!(
            "{free} of {max} worker slot{} {} free. ",
            if max == 1 { "" } else { "s" },
            if free == 1 { "is" } else { "are" }
        )
    } else {
        String::new()
    };
    let capacity = if terminal {
        format!(
            "\n({id} is finished for good: its own chat has reached the context limit, so it cannot be woken again. {slots}Spawn a new worker for any remaining work.)"
        )
    } else {
        format!(
            "\n({id} sleeping; {slots}Reuse first: agents action=message to=\"{id}\". Spawn only when no sleeping worker is suitable or more parallel capacity is needed.)"
        )
    };
    let report = new_message(
        id,
        PRIME_ID,
        format!(
            "[{id} {}] {}{caveat}{capacity}",
            if terminal { "finished" } else { "reported" },
            info.result.as_deref().unwrap_or_default()
        ),
        now,
    );
    (info, report)
}

fn offer_agent(
    agent: &mut Agent,
    on_finish: bool,
    max_chars: usize,
    now: u64,
) -> Vec<AgentMessage> {
    if agent.info.role == AgentRole::Worker
        && agent.info.state == AgentState::Waking
        && !agent.info.revivable
    {
        return Vec::new();
    }
    let mut chars = 0;
    let mut offered = Vec::new();
    for message in &mut agent.queue {
        if message.acked_at.is_some() || message.offered_via_revival {
            continue;
        }
        let length = js_length(&message.text);
        if chars + length > max_chars {
            break;
        }
        chars += length;
        message.offered_at = Some(now);
        message.offers += 1;
        message.offered_on_finish = on_finish;
        offered.push(message.clone());
    }
    if !offered.is_empty() {
        recount(agent);
    }
    offered
}

fn acknowledge_agent(
    agent: &mut Agent,
    by_finish: bool,
    call_started_at: u64,
    now: u64,
) -> Vec<AgentMessage> {
    let mut acked = Vec::new();
    for message in &mut agent.queue {
        let Some(offered_at) = message.offered_at else {
            continue;
        };
        if message.acked_at.is_some()
            || offered_at >= call_started_at
            || (by_finish && message.offered_on_finish)
        {
            continue;
        }
        message.acked_at = Some(now);
        acked.push(message.clone());
    }
    if !acked.is_empty() {
        agent.info.delivered += acked.len() as u64;
        recount(agent);
    }
    acked
}

/// Reserves a slot for a sleeping worker. The new task is the unread prime work.
fn begin_revival(agent: &mut Agent, label: Option<&str>) {
    if let Some(label) = label {
        agent.info.label = label.to_owned();
    }
    let task: Vec<&str> = agent
        .queue
        .iter()
        .filter(|message| message.acked_at.is_none() && !message.offered_via_revival)
        .map(|message| message.text.as_str())
        .collect();
    agent.info.task = js_slice(&task.join("\n\n"), MAX_TASK_CHARS);
    agent.info.result = None;
    agent.info.state = AgentState::Waking;
    agent.info.detached_at = None;
    agent.info.revivable = true;
    clear_silence(&mut agent.info);
    agent.info.last_revival_command_id = Some(None);
}

fn revival_text(agent: &Agent, policy: &Policy) -> (String, Vec<String>) {
    let mut waiting: Vec<&AgentMessage> = Vec::new();
    let mut chars = 0;
    for message in &agent.queue {
        if message.acked_at.is_some() || message.offered_via_revival {
            continue;
        }
        let length = js_length(&message.text);
        if !waiting.is_empty() && chars + length > MAX_INBOX_OFFER_CHARS {
            break;
        }
        waiting.push(message);
        chars += length;
    }
    let body: Vec<&str> = waiting
        .iter()
        .map(|message| message.text.as_str())
        .collect();
    let body = body.join("\n\n");
    let report = if policy.core_hint.is_empty() {
        "agents ".to_owned()
    } else {
        format!("the agents tool{}: ", policy.core_hint)
    };
    let text = format!(
        "{}\n\n(Chat On Steroids: you are still {} in the same run, and this is the prime agent talking to you again in the chat you already know. Pick up from what you did here before rather than starting over. Report with {report}action=message to=\"prime\" as you go and action=finish when this piece is done.)",
        if body.is_empty() {
            "The prime agent has more work for you; check your inbox on the next tool result."
        } else {
            &body
        },
        agent.info.id
    );
    (
        text,
        waiting.iter().map(|message| message.id.clone()).collect(),
    )
}

fn finish_stopped_at_ceiling(
    agent: &mut Agent,
    reason: &str,
    slept_at: u64,
    now: u64,
) -> AgentMessage {
    let never: Vec<AgentMessage> = agent
        .queue
        .iter()
        .filter(|message| message.acked_at.is_none() && message.offered_at.is_none())
        .cloned()
        .collect();
    if !never.is_empty() {
        agent
            .queue
            .retain(|message| !(message.acked_at.is_none() && message.offered_at.is_none()));
    }
    agent.info.state = AgentState::Finished;
    agent.info.slept_at = Some(slept_at);
    agent.info.finished_at = Some(now);
    agent.info.detached_at = None;
    agent.info.revivable = false;
    clear_silence(&mut agent.info);
    recount(agent);
    let missed = if never.is_empty() {
        String::new()
    } else {
        let quoted: Vec<String> = never
            .iter()
            .take(3)
            .map(|message| format!("\u{201C}{}\u{201D}", js_slice(&message.text, 180)))
            .collect();
        format!(
            " {} queued message{} could not be delivered before that limit ({}{}). Those instructions are no longer queued.",
            never.len(),
            if never.len() == 1 { "" } else { "s" },
            quoted.join(", "),
            if never.len() > 3 { ", \u{2026}" } else { "" }
        )
    };
    let id = agent.info.id.clone();
    new_message(
        &id,
        PRIME_ID,
        format!(
            "[{id} finished for good] {reason} Its chat has reached the context limit, so it cannot be woken again.{missed} Its worker slot is free; spawn a new worker for any remaining work."
        ),
        now,
    )
}

/// A failed or rolled-back wake returns to the only stopped state its context permits.
fn return_waking_to_stopped(
    agent: &mut Agent,
    slept_at: u64,
    reason: &str,
    now: u64,
) -> Option<AgentMessage> {
    if ceiling_crossed(&agent.info) {
        return Some(finish_stopped_at_ceiling(agent, reason, slept_at, now));
    }
    agent.info.state = AgentState::Sleeping;
    agent.info.slept_at = Some(slept_at);
    agent.info.finished_at = None;
    agent.info.detached_at = None;
    agent.info.revivable = true;
    recount(agent);
    None
}

/// A finish target: the family and the worker id inside it.
struct Slot2 {
    slot: Slot,
    id: String,
}

struct Planned {
    label: String,
    task: String,
    model: Option<String>,
    effort: Option<ReasoningEffort>,
}

/// An exact repeat of work already in flight is the same request arriving twice.
fn match_existing(requested: &[Planned], live: &[AgentInfo]) -> Option<Vec<AgentInfo>> {
    if requested.is_empty() || live.is_empty() {
        return None;
    }
    let shape =
        |label: &str, task: &str, model: &Option<String>, effort: &Option<ReasoningEffort>| {
            (
                js_trim(label).to_owned(),
                js_trim(task).to_owned(),
                model.clone(),
                *effort,
            )
        };
    let mut taken: Vec<usize> = Vec::new();
    let mut matched = Vec::new();
    for worker in requested {
        let found = live.iter().enumerate().find(|(index, info)| {
            if taken.contains(index) {
                return false;
            }
            let have = shape(&info.label, &info.task, &info.model, &info.reasoning_effort);
            let label = if worker.label.is_empty() {
                &info.id
            } else {
                &worker.label
            };
            have == shape(label, &worker.task, &worker.model, &worker.effort)
                || have == shape(&worker.label, &worker.task, &worker.model, &worker.effort)
        })?;
        taken.push(found.0);
        matched.push(found.1.clone());
    }
    Some(matched)
}

fn normalize_model(index: usize, value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let model = js_trim(value);
    if model.is_empty() {
        return Ok(None);
    }
    if !is_model_slug(model) {
        return Err(AgentError::refused(format!(
            "Worker {}'s model is not a ChatGPT model slug (letters, digits, dot, underscore, hyphen; limit {MAX_MODEL_CHARS} characters)",
            index + 1
        )));
    }
    Ok(Some(model.to_owned()))
}

fn normalize_effort(index: usize, value: &str) -> Result<Option<ReasoningEffort>> {
    let effort = js_trim(value).to_lowercase();
    if effort.is_empty() {
        return Ok(None);
    }
    reasoning_effort(&effort).map(Some).ok_or_else(|| {
        let all: Vec<&str> = ReasoningEffort::ALL
            .iter()
            .map(|effort| effort.as_str())
            .collect();
        AgentError::refused(format!(
            "Worker {}'s reasoning_effort must be one of: {}",
            index + 1,
            all.join(", ")
        ))
    })
}

/// One account-observed model choice (`ChatModelOption`): an id, its aliases and efforts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedModel {
    pub id: String,
    pub aliases: Vec<String>,
    pub efforts: Vec<ReasoningEffort>,
}

impl ObservedModel {
    fn named(&self, model: &str) -> bool {
        self.id == model || self.aliases.iter().any(|alias| alias == model)
    }
}

fn usable_defaults(
    mut model: Option<String>,
    mut effort: Option<ReasoningEffort>,
    default_model: bool,
    default_effort: bool,
    models: &[ObservedModel],
    notes: &mut Vec<String>,
) -> (Option<String>, Option<ReasoningEffort>) {
    if models.is_empty() {
        return (model, effort);
    }
    if default_model
        && let Some(name) = &model
        && !models.iter().any(|choice| choice.named(name))
    {
        let note = format!(
            "The default worker model \"{name}\" saved in Settings is not offered by this ChatGPT account, so workers use ChatGPT's current model. Choose an available model in Settings \u{2192} Agents & automation."
        );
        if !notes.contains(&note) {
            notes.push(note);
        }
        model = None;
    }
    let offered: Vec<&ObservedModel> = match &model {
        Some(name) => models.iter().filter(|choice| choice.named(name)).collect(),
        None => models.iter().collect(),
    };
    if default_effort
        && let Some(level) = effort
        && !offered.iter().any(|choice| choice.efforts.contains(&level))
    {
        let note = format!(
            "The default worker reasoning \"{}\" saved in Settings is not offered{} by this ChatGPT account, so workers use ChatGPT's current reasoning. Choose an available level in Settings \u{2192} Agents & automation.",
            level.as_str(),
            model
                .as_ref()
                .map(|name| format!(" for model \"{name}\""))
                .unwrap_or_default()
        );
        if !notes.contains(&note) {
            notes.push(note);
        }
        effort = None;
    }
    (model, effort)
}

fn validate_worker_model(
    index: usize,
    model: Option<&str>,
    effort: Option<ReasoningEffort>,
    models: &[ObservedModel],
) -> Result<()> {
    if models.is_empty() {
        return Ok(());
    }
    let choices: Vec<&ObservedModel> = match model {
        Some(name) => models.iter().filter(|choice| choice.named(name)).collect(),
        None => models.iter().collect(),
    };
    let available: Vec<String> = models
        .iter()
        .map(|choice| {
            let efforts: Vec<&str> = choice
                .efforts
                .iter()
                .map(|effort| effort.as_str())
                .collect();
            format!("{} ({})", choice.id, efforts.join(", "))
        })
        .collect();
    let available = available.join("; ");
    if let Some(name) = model
        && choices.len() != 1
    {
        return Err(AgentError::refused(format!(
            "Worker {}'s model \"{name}\" is {} in the ChatGPT account. Observed model ids and reasoning: {available}",
            index + 1,
            if choices.is_empty() {
                "not observed"
            } else {
                "ambiguous"
            }
        )));
    }
    if let Some(level) = effort
        && !choices.iter().any(|choice| choice.efforts.contains(&level))
    {
        return Err(AgentError::refused(format!(
            "Worker {}'s reasoning_effort \"{}\" is not observed{}. Observed model ids and reasoning: {available}",
            index + 1,
            level.as_str(),
            model
                .map(|name| format!(" for model \"{name}\""))
                .unwrap_or_else(|| " in the ChatGPT account".to_owned())
        )));
    }
    Ok(())
}
