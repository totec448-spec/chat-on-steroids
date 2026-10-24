//! Durable browser commands (`bridge.ts`, the `commands` half): what a page is asked to do in a
//! chat, the one document that leased it, and the final receipt that answers a lost ACK. The
//! ledger is `state/bridge-commands.json`, version 4.
//!
//! Worker bootstraps, wakes and Compact & Resume replacements need the agent broker (E2.6) and
//! the continuation transaction (E2.5). Without them TypeScript retires those rows at restore
//! (`restoredCommandSpec`), so this ledger keeps the same rows: Stop commands and receipts.

use std::sync::Arc;

use cos_sessions::SessionStore;
use cos_store::{Durable, DurableStore, Logger};
use cos_types::bridge::{BridgeCommand, BridgeCommandKind, CommandSpecType};
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{EventSource, SessionEvent};
use cos_types::state::{
    BridgeCommands, BridgeCommandsVersion, CommandPhase, CommandReceipt, CommandReceiptOutcome,
    CommandSpec, DurableCommandRecord,
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::policy::active_turn;
use crate::text::js_slice;
use crate::{Answer, Clock, Notify};

const STATE: &str = "bridge-commands";
/// Past this age an ordinary command is stale, not pending.
const COMMAND_TTL_MS: u64 = 30 * 60_000;
const MAX_COMMANDS: usize = 20;
const MAX_COMMAND_RECEIPTS: usize = 64;
/// One absolute budget includes opening an absent tab and native hydration.
pub const STOP_COMMAND_TIMEOUT_MS: u64 = 120_000;
/// Bootstrap stages a page reports after redeeming, in order.
const COMMAND_STEPS: [&str; 9] = [
    "revival-waiting",
    "revival-busy",
    "revival-draft",
    "revival-editor",
    "composer",
    "model",
    "composer-after-model",
    "inserting",
    "sending",
];
/// Steps a wake reports while it waits, before redeeming.
const REVIVAL_WAIT_STEPS: [&str; 4] = [
    "revival-waiting",
    "revival-busy",
    "revival-draft",
    "revival-editor",
];

#[derive(Clone, Debug, PartialEq)]
struct Command {
    id: String,
    spec: CommandSpec,
    created_at: u64,
    claimed_at: Option<u64>,
    owner: Option<String>,
    last_error: Option<String>,
    /// How far opening this chat got. Memory only.
    step: Option<(String, u64)>,
}

impl Command {
    fn record(&self) -> DurableCommandRecord {
        DurableCommandRecord {
            id: self.id.clone(),
            spec: self.spec.clone(),
            created_at: self.created_at,
            phase: if self.claimed_at.is_some() {
                CommandPhase::Leased
            } else {
                CommandPhase::Queued
            },
            claimed_at: self.claimed_at,
            owner: self.owner.clone(),
            last_error: self.last_error.clone(),
            extra: Extra::new(),
        }
    }
}

#[derive(Default)]
struct Ledger {
    commands: Vec<Command>,
    receipts: Vec<CommandReceipt>,
}

/// The command ledger. Clones share one.
#[derive(Clone)]
pub struct Commands {
    inner: Arc<Inner>,
}

struct Inner {
    sessions: SessionStore,
    durable: Option<Durable<BridgeCommands>>,
    logger: Logger,
    notify: Notify,
    clock: Clock,
    ledger: Mutex<Ledger>,
}

fn spec_key(spec: &CommandSpec) -> String {
    match spec {
        CommandSpec::Stop {
            session_id,
            turn_id,
            ..
        } => format!("stop:{session_id}:{turn_id}"),
        CommandSpec::Worker { run_id, agent, .. } => format!("worker:{run_id}:{agent}"),
        CommandSpec::Revive { run_id, agent, .. } => format!("revive:{run_id}:{agent}"),
        CommandSpec::Resume { session_id, .. } => format!("resume:{session_id}"),
    }
}

/// `conversationId` in `bridge.ts`.
fn conversation_id(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    ((8..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
        .then(|| text.to_owned())
}

fn random_id() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::getrandom(&mut bytes).is_err() {
        use std::hash::{BuildHasher, RandomState};
        bytes = RandomState::new()
            .hash_one(std::time::Instant::now())
            .to_le_bytes();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `restoredCommandSpec`: a Stop row survives on its own fields; the other kinds need their
/// broker or continuation, which this build does not have.
fn restored_spec(raw: &Value) -> Option<CommandSpec> {
    if raw.get("type")?.as_str()? != "stop" {
        return None;
    }
    let session = raw.get("sessionId")?.as_str()?;
    let session_ok = (8..=64).contains(&session.len())
        && session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let conversation = conversation_id(raw.get("conversationId"))?;
    let turn = raw.get("turnId")?.as_str()?;
    let user_message = match raw.get("userMessageId") {
        None => None,
        Some(Value::String(id)) if !id.is_empty() && id.len() <= 256 => Some(id.clone()),
        Some(_) => return None,
    };
    (session_ok && !turn.is_empty() && turn.len() <= 256).then(|| CommandSpec::Stop {
        session_id: session.to_owned(),
        conversation_id: conversation,
        turn_id: turn.to_owned(),
        user_message_id: user_message,
        extra: Extra::new(),
    })
}

/// `restoredReceipt`: one durable receipt that is still useful.
fn restored_receipt(raw: &Value, now: u64) -> Option<CommandReceipt> {
    let id = raw.get("id")?.as_str()?;
    let client = match raw.get("client") {
        None | Some(Value::Null) => None,
        Some(Value::String(client)) if client.len() <= 64 => Some(client.clone()),
        Some(_) => return None,
    };
    let conversation = match raw.get("conversationId") {
        None | Some(Value::Null) => None,
        Some(Value::String(conversation)) => Some(conversation.clone()),
        Some(_) => return None,
    };
    let outcome = match raw.get("outcome")?.as_str()? {
        "committed" => CommandReceiptOutcome::Committed,
        "terminal-failure" => CommandReceiptOutcome::TerminalFailure,
        _ => return None,
    };
    let committed = raw.get("committed")?.as_bool()?;
    let completed = raw
        .get("completedAt")?
        .as_f64()
        .filter(|at| at.is_finite())?;
    if id.is_empty()
        || id.len() > 64
        || (now as f64) - completed > COMMAND_TTL_MS as f64
        || (outcome == CommandReceiptOutcome::Committed) != committed
    {
        return None;
    }
    Some(CommandReceipt {
        id: id.to_owned(),
        client,
        conversation_id: conversation,
        outcome,
        committed,
        error: raw
            .get("error")
            .and_then(Value::as_str)
            .map(|error| js_slice(error, 200)),
        completed_at: completed as u64,
        extra: Extra::new(),
    })
}

fn receipt_reply(receipt: &CommandReceipt) -> Value {
    json!({
        "ok": true, "final": true, "committed": receipt.committed, "outcome": receipt.outcome,
        "conversationId": receipt.conversation_id, "error": receipt.error,
    })
}

impl Commands {
    pub fn new(
        sessions: SessionStore,
        state: &DurableStore,
        logger: Logger,
        notify: Notify,
        clock: Clock,
    ) -> Self {
        let durable = match state.ledger(STATE) {
            Ok(ledger) => Some(ledger),
            Err(error) => {
                logger.error(&format!(
                    "bridge: the command ledger is unavailable: {error}"
                ));
                None
            }
        };
        Self {
            inner: Arc::new(Inner {
                sessions,
                durable,
                logger,
                notify,
                clock,
                ledger: Mutex::new(Ledger::default()),
            }),
        }
    }

    fn now(&self) -> u64 {
        (self.inner.clock)()
    }

    fn snapshot(&self, ledger: &Ledger, now: u64) -> BridgeCommands {
        let mut receipts: Vec<CommandReceipt> = ledger
            .receipts
            .iter()
            .filter(|receipt| now.saturating_sub(receipt.completed_at) <= COMMAND_TTL_MS)
            .cloned()
            .collect();
        let excess = receipts.len().saturating_sub(MAX_COMMAND_RECEIPTS);
        receipts.drain(..excess);
        BridgeCommands {
            version: BridgeCommandsVersion,
            commands: ledger.commands.iter().map(Command::record).collect(),
            receipts,
            extra: Extra::new(),
        }
    }

    /// `writeDurableNow`: the ledger on disk before the change is published.
    async fn write_now(&self, snapshot: BridgeCommands) -> bool {
        let Some(durable) = self.inner.durable.clone() else {
            return false;
        };
        matches!(
            tokio::task::spawn_blocking(move || durable.write_now(&snapshot)).await,
            Ok(Ok(()))
        )
    }

    /// `persistCommands`: a background write of the current ledger.
    fn persist_soon(&self, ledger: &Ledger) {
        if let Some(durable) = &self.inner.durable {
            let _ = durable.write_soon(&self.snapshot(ledger, self.now()));
        }
    }

    /// Shutdown: the queued ledger write.
    pub fn flush(&self) {
        if let Some(durable) = &self.inner.durable {
            let _ = durable.flush();
        }
    }

    /// `restoreCommands`: yesterday's commands are discarded, never acted on.
    pub async fn restore(&self) {
        let Some(durable) = self.inner.durable.clone() else {
            return;
        };
        let saved = tokio::task::spawn_blocking(move || durable.read())
            .await
            .ok()
            .flatten();
        let Some(saved) = saved else {
            return;
        };
        let version = saved.get("version").and_then(Value::as_u64);
        let Some(raw_commands) = saved.get("commands").and_then(Value::as_array) else {
            return;
        };
        if !matches!(version, Some(1..=4)) {
            return;
        }
        let now = self.now();
        let mut ledger = self.inner.ledger.lock().await;
        let mut receipts: Vec<CommandReceipt> = ledger
            .receipts
            .iter()
            .filter(|receipt| now.saturating_sub(receipt.completed_at) <= COMMAND_TTL_MS)
            .cloned()
            .collect();
        if version != Some(1)
            && let Some(raw) = saved.get("receipts").and_then(Value::as_array)
        {
            for receipt in raw.iter().filter_map(|raw| restored_receipt(raw, now)) {
                if !receipts.iter().any(|known| known.id == receipt.id) {
                    receipts.push(receipt);
                }
            }
        }
        let excess = receipts.len().saturating_sub(MAX_COMMAND_RECEIPTS);
        receipts.drain(..excess);
        let retained: Vec<String> = ledger
            .commands
            .iter()
            .map(|command| spec_key(&command.spec))
            .collect();
        let mut candidates: Vec<(String, Command, bool)> = Vec::new();
        for raw in raw_commands {
            let Some(id) = raw
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 64)
            else {
                continue;
            };
            let Some(spec) = raw.get("spec").and_then(restored_spec) else {
                continue;
            };
            let created_at = raw
                .get("createdAt")
                .and_then(Value::as_f64)
                .filter(|at| at.is_finite())
                .map_or(0, |at| at as u64);
            let key = spec_key(&spec);
            if retained.contains(&key) || receipts.iter().any(|receipt| receipt.id == id) {
                continue;
            }
            let leased = version != Some(1) && raw.get("phase") == Some(&json!("leased"));
            let command = Command {
                id: id.to_owned(),
                spec,
                created_at,
                claimed_at: None,
                owner: None,
                last_error: raw
                    .get("lastError")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                step: None,
            };
            match candidates.iter_mut().find(|(known, _, _)| *known == key) {
                Some(prior) if created_at >= prior.1.created_at => {
                    *prior = (key, command, leased);
                }
                Some(_) => {}
                None => candidates.push((key, command, leased)),
            }
        }
        let mut restored = 0;
        for (_, mut command, leased) in candidates {
            if now.saturating_sub(command.created_at) > COMMAND_TTL_MS {
                continue;
            }
            if leased {
                let raw = raw_commands
                    .iter()
                    .find(|raw| raw.get("id").and_then(Value::as_str) == Some(&command.id));
                let mut claimed = raw
                    .and_then(|raw| raw.get("claimedAt"))
                    .and_then(Value::as_f64)
                    .filter(|at| at.is_finite())
                    .map_or(now, |at| at as u64);
                if claimed > now + 90_000 {
                    claimed = now;
                }
                command.claimed_at = Some(claimed);
                command.owner = raw
                    .and_then(|raw| raw.get("owner"))
                    .and_then(Value::as_str)
                    .map(|owner| js_slice(owner, 64));
            }
            ledger.commands.push(command);
            restored += 1;
        }
        ledger.receipts = receipts;
        let snapshot = self.snapshot(&ledger, now);
        if !self.write_now(snapshot).await {
            self.inner
                .logger
                .warn("bridge: could not persist reconstructed command state");
            self.persist_soon(&ledger);
        }
        if restored > 0 {
            self.inner.logger.info(&format!(
                "bridge: restored {restored} chat command(s) from the previous run"
            ));
            (self.inner.notify)();
        }
    }

    async fn stop_current(&self, spec: &CommandSpec) -> bool {
        let CommandSpec::Stop {
            session_id,
            conversation_id,
            turn_id,
            ..
        } = spec
        else {
            return false;
        };
        let Ok(id) = SessionId::parse(session_id.as_str()) else {
            return false;
        };
        let Some(session) = self.inner.sessions.summary(&id).await else {
            return false;
        };
        session.conversation_id.as_deref() == Some(conversation_id)
            && active_turn(&session).as_deref() == Some(turn_id)
            && !self.inner.sessions.conversation_superseded(conversation_id)
    }

    /// `retire`: the command is done, for the logged reason.
    fn retire(&self, ledger: &mut Ledger, id: &str, why: &str) {
        let Some(index) = ledger.commands.iter().position(|command| command.id == id) else {
            return;
        };
        let command = ledger.commands.remove(index);
        self.inner.logger.info(&format!(
            "bridge: {} is done — {why}",
            spec_key(&command.spec)
        ));
        (self.inner.notify)();
        self.persist_soon(ledger);
    }

    /// `tidyCommands`: stale commands leave the ledger.
    fn tidy(&self, ledger: &mut Ledger, now: u64) {
        let stale: Vec<String> = ledger
            .commands
            .iter()
            .filter(|command| now.saturating_sub(command.created_at) > COMMAND_TTL_MS)
            .map(|command| command.id.clone())
            .collect();
        for id in stale {
            self.retire(
                ledger,
                &id,
                "it has been waiting too long to still be what the user expects",
            );
        }
    }

    /// `stopSessionTurn`'s command half: one durable Stop for one exact live turn. Goal,
    /// finish and continuation side effects belong to their own owners.
    pub async fn queue_stop(&self, session_id: &str, turn_id: &str) -> Result<String, String> {
        let id = SessionId::parse(session_id).map_err(|_| "session_not_found".to_owned())?;
        let session = self
            .inner
            .sessions
            .summary(&id)
            .await
            .ok_or_else(|| "session_not_found".to_owned())?;
        let conversation = session
            .conversation_id
            .clone()
            .ok_or_else(|| "active_turn_changed".to_owned())?;
        if turn_id.is_empty()
            || active_turn(&session).as_deref() != Some(turn_id)
            || self.inner.sessions.conversation_superseded(&conversation)
        {
            return Err("active_turn_changed".into());
        }
        let user_message_id = self.stop_user_anchor(&id, turn_id).await;
        let spec = CommandSpec::Stop {
            session_id: session_id.to_owned(),
            conversation_id: conversation.clone(),
            turn_id: turn_id.to_owned(),
            user_message_id,
            extra: Extra::new(),
        };
        let now = self.now();
        let mut ledger = self.inner.ledger.lock().await;
        let key = spec_key(&spec);
        let existing = ledger
            .commands
            .iter()
            .position(|command| spec_key(&command.spec) == key);
        let index = match existing {
            Some(index) => {
                if ledger.commands[index].spec != spec {
                    let command = &mut ledger.commands[index];
                    command.created_at = now;
                    command.claimed_at = None;
                    command.owner = None;
                    command.spec = spec;
                    command.last_error = None;
                }
                index
            }
            None => {
                ledger.commands.push(Command {
                    id: random_id(),
                    spec,
                    created_at: now,
                    claimed_at: None,
                    owner: None,
                    last_error: None,
                    step: None,
                });
                if ledger.commands.len() > MAX_COMMANDS {
                    let oldest = ledger.commands[0].id.clone();
                    self.retire(
                        &mut ledger,
                        &oldest,
                        "the command queue was full and this was the oldest entry in it",
                    );
                }
                ledger.commands.len() - 1
            }
        };
        // Status must not hand out an unsaved request: the lease is durable first.
        if ledger.commands[index].claimed_at.is_none() {
            let mut staged = Ledger {
                commands: ledger.commands.clone(),
                receipts: ledger.receipts.clone(),
            };
            staged.commands[index].claimed_at = Some(now);
            if !self.write_now(self.snapshot(&staged, now)).await {
                let id = ledger.commands[index].id.clone();
                self.retire(
                    &mut ledger,
                    &id,
                    "stop request could not be saved or its turn changed",
                );
                return Err("stop_request_not_durable".into());
            }
            ledger.commands[index].claimed_at = Some(now);
        }
        let command_id = ledger.commands[index].id.clone();
        if existing.is_none() {
            self.inner.logger.info(&format!(
                "bridge: desktop Stop requested for session {session_id}, conversation {conversation}, turn {turn_id}, command {command_id}; native cancellation is unconfirmed"
            ));
        }
        (self.inner.notify)();
        Ok(command_id)
    }

    /// `stopUserAnchor`: the page's own user message that started this turn.
    async fn stop_user_anchor(&self, id: &SessionId, turn_id: &str) -> Option<String> {
        let mut rows = self
            .inner
            .sessions
            .recent_events(id, 64, &["user_message", "turn_start", "turn_end"])
            .await
            .ok()?;
        let order = |event: &SessionEvent| match event {
            SessionEvent::UserMessage(message) => message.origin.unwrap_or(message.base.seq),
            other => other.base().seq,
        };
        rows.sort_by_key(order);
        let mut user = None;
        for event in &rows {
            match event {
                SessionEvent::UserMessage(message) => {
                    user = if message.base.source == EventSource::Extension {
                        message.message_id.clone()
                    } else {
                        None
                    };
                }
                SessionEvent::TurnStart(start)
                    if start.base.turn_id.as_deref() == Some(turn_id) =>
                {
                    return user;
                }
                _ => user = None,
            }
        }
        None
    }

    /// `pendingStopCommands`, for `/status` `stopTurns`.
    pub async fn pending_stops(&self) -> Vec<Value> {
        let now = self.now();
        let mut ledger = self.inner.ledger.lock().await;
        let mut pending = Vec::new();
        for command in ledger.commands.clone() {
            let CommandSpec::Stop {
                conversation_id,
                turn_id,
                ..
            } = &command.spec
            else {
                continue;
            };
            if now.saturating_sub(command.created_at) >= STOP_COMMAND_TIMEOUT_MS
                || !self.stop_current(&command.spec).await
            {
                self.retire(
                    &mut ledger,
                    &command.id,
                    "the requested turn is no longer stoppable",
                );
                continue;
            }
            pending.push(json!({ "id": command.id, "conversationId": conversation_id,
                "turnId": turn_id, "expiresAt": command.created_at + STOP_COMMAND_TIMEOUT_MS }));
        }
        pending
    }

    /// The ids `/status` reports as `commandIds`.
    pub async fn ids(&self) -> Vec<String> {
        let ledger = self.inner.ledger.lock().await;
        ledger
            .commands
            .iter()
            .map(|command| command.id.clone())
            .collect()
    }

    /// One of `/commands/{revivals/pending,redeem,step,ack}`.
    pub async fn answer(&self, route: &str, body: &Value) -> Answer {
        match route {
            "/commands/revivals/pending" => self.revivals_pending(body).await,
            "/commands/redeem" => self.redeem(body).await,
            "/commands/step" => self.step(body).await,
            "/commands/ack" => self.ack(body).await,
            _ => Answer::error(404, "not_found"),
        }
    }

    async fn revivals_pending(&self, body: &Value) -> Answer {
        let entries = body.get("entries").and_then(Value::as_array);
        if entries.is_none_or(|entries| entries.len() > 100) {
            return Answer::error(400, "bad_revival_entries");
        }
        let now = self.now();
        let mut ledger = self.inner.ledger.lock().await;
        self.tidy(&mut ledger, now);
        // No wake is pending without the agent broker, so no marker is fresh.
        Answer::ok(json!({ "pending": [] }))
    }

    async fn redeem(&self, body: &Value) -> Answer {
        let now = self.now();
        let mut ledger = self.inner.ledger.lock().await;
        self.tidy(&mut ledger, now);
        let wanted = body.get("id").and_then(Value::as_str).unwrap_or_default();
        let client = body
            .get("client")
            .and_then(Value::as_str)
            .map(|client| js_slice(client, 64))
            .unwrap_or_default();
        let reported = match body.get("conversationId") {
            None => None,
            Some(value) => match conversation_id(Some(value)) {
                Some(id) => Some(id),
                None => return Answer::error(400, "bad_conversation_id"),
            },
        };
        let Some(command) = ledger
            .commands
            .iter()
            .find(|command| command.id == wanted)
            .cloned()
        else {
            return Answer::error(404, "no_such_command");
        };
        let CommandSpec::Stop {
            conversation_id, ..
        } = &command.spec
        else {
            return Answer::error(404, "no_such_command");
        };
        if client.is_empty()
            || now.saturating_sub(command.created_at) >= STOP_COMMAND_TIMEOUT_MS
            || reported.as_ref() != Some(conversation_id)
            || !self.stop_current(&command.spec).await
        {
            return Answer::error(409, "stop_turn_changed");
        }
        if command.owner.as_ref().is_some_and(|owner| *owner != client) {
            return Answer::error(409, "stop_not_owned");
        }
        let mut staged = Ledger {
            commands: ledger.commands.clone(),
            receipts: ledger.receipts.clone(),
        };
        if let Some(leased) = staged.commands.iter_mut().find(|c| c.id == command.id) {
            leased.claimed_at = Some(now);
            leased.owner = Some(client.clone());
        }
        if !self.write_now(self.snapshot(&staged, now)).await {
            self.persist_soon(&ledger);
            return Answer::error(409, "stop_not_owned");
        }
        ledger.commands = staged.commands;
        if now.saturating_sub(command.created_at) >= STOP_COMMAND_TIMEOUT_MS
            || !self.stop_current(&command.spec).await
        {
            return Answer::error(409, "stop_turn_changed");
        }
        let described = describe(&command, now);
        Answer::ok(json!({ "command": described }))
    }

    async fn step(&self, body: &Value) -> Answer {
        let now = self.now();
        let mut ledger = self.inner.ledger.lock().await;
        let step = body
            .get("step")
            .and_then(Value::as_str)
            .filter(|step| COMMAND_STEPS.contains(step));
        let id = body.get("id").and_then(Value::as_str);
        let client = body.get("client");
        let Some(command) = ledger
            .commands
            .iter_mut()
            .find(|command| Some(command.id.as_str()) == id)
        else {
            return Answer::ok(json!({ "ok": false }));
        };
        let Some(step) = step else {
            return Answer::ok(json!({ "ok": false }));
        };
        let allowed = if REVIVAL_WAIT_STEPS.contains(&step) {
            command.owner.is_none()
        } else {
            command
                .owner
                .as_deref()
                .is_some_and(|owner| client.and_then(Value::as_str) == Some(owner))
        };
        if !allowed {
            return Answer::ok(json!({ "ok": false }));
        }
        command.step = Some((step.to_owned(), now));
        Answer::ok(json!({ "ok": true }))
    }

    async fn ack(&self, body: &Value) -> Answer {
        let now = self.now();
        let mut ledger = self.inner.ledger.lock().await;
        let id = body
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let sent = body.get("status").and_then(Value::as_str) != Some("failed");
        let error = body
            .get("error")
            .and_then(Value::as_str)
            .map(|error| js_slice(error, 200));
        let client = body
            .get("client")
            .and_then(Value::as_str)
            .map(|client| js_slice(client, 64))
            .unwrap_or_default();
        let conversation = conversation_id(body.get("conversationId"));
        ledger
            .receipts
            .retain(|receipt| now.saturating_sub(receipt.completed_at) <= COMMAND_TTL_MS);
        if let Some(prior) = ledger.receipts.iter().find(|receipt| receipt.id == id) {
            if prior.client.clone().unwrap_or_default() != client {
                return Answer::error(409, "receipt_client_changed");
            }
            if prior.conversation_id != conversation {
                return Answer::error(409, "receipt_conversation_changed");
            }
            return Answer::ok(receipt_reply(prior));
        }
        let Some(owned) = ledger
            .commands
            .iter()
            .find(|command| command.id == id)
            .cloned()
        else {
            if !client.is_empty() {
                return Answer::error(404, "no_such_command");
            }
            return Answer::ok(json!({ "ok": true }));
        };
        if !client.is_empty() && owned.owner.as_deref() != Some(client.as_str()) {
            return Answer::error(409, "command_owner_changed");
        }
        if !client.is_empty() && owned.claimed_at.is_none() {
            return Answer::error(409, "command_not_leased");
        }
        let CommandSpec::Stop {
            conversation_id: target,
            turn_id,
            ..
        } = &owned.spec
        else {
            return Answer::error(409, "command_identity_changed");
        };
        if client.is_empty()
            || conversation.as_ref() != Some(target)
            || body.get("turnId").and_then(Value::as_str) != Some(turn_id.as_str())
        {
            return Answer::error(409, "stop_identity_changed");
        }
        let receipt = CommandReceipt {
            id: id.clone(),
            client: Some(client),
            conversation_id: conversation,
            outcome: if sent {
                CommandReceiptOutcome::Committed
            } else {
                CommandReceiptOutcome::TerminalFailure
            },
            committed: sent,
            error: if sent {
                None
            } else {
                Some(
                    error
                        .filter(|error| !error.is_empty())
                        .unwrap_or_else(|| "native_stop_unavailable".into()),
                )
            },
            completed_at: now,
            extra: Extra::new(),
        };
        // The receipt and the retirement are one durable transition.
        let mut staged = Ledger {
            commands: ledger
                .commands
                .iter()
                .filter(|command| command.id != id)
                .cloned()
                .collect(),
            receipts: ledger
                .receipts
                .iter()
                .filter(|known| known.id != id)
                .cloned()
                .collect(),
        };
        staged.receipts.push(receipt.clone());
        let excess = staged.receipts.len().saturating_sub(MAX_COMMAND_RECEIPTS);
        staged.receipts.drain(..excess);
        if !self.write_now(self.snapshot(&staged, now)).await {
            self.persist_soon(&ledger);
            self.inner.logger.warn(&format!(
                "bridge: could not persist the final receipt for {}",
                spec_key(&owned.spec)
            ));
            return Answer::error(503, "command_receipt_not_durable");
        }
        *ledger = staged;
        (self.inner.notify)();
        Answer::ok(receipt_reply(&receipt))
    }
}

/// `describe` for a Stop: the wire form a page receives.
fn describe(command: &Command, now: u64) -> BridgeCommand {
    let (conversation, turn, user_message) = match &command.spec {
        CommandSpec::Stop {
            conversation_id,
            turn_id,
            user_message_id,
            ..
        } => (
            Some(conversation_id.clone()),
            Some(turn_id.clone()),
            user_message_id.clone(),
        ),
        _ => (None, None, None),
    };
    let deadline = (command.created_at + STOP_COMMAND_TIMEOUT_MS).saturating_sub(now);
    BridgeCommand {
        id: command.id.clone(),
        expires_at: now + deadline.max(1),
        project_entry: None,
        kind: BridgeCommandKind::StopTurn,
        turn_id: turn,
        user_message_id: user_message,
        spec_type: CommandSpecType::of(&command.spec),
        text: String::new(),
        agent: None,
        model: None,
        reasoning_effort: None,
        conversation_id: conversation,
    }
}
