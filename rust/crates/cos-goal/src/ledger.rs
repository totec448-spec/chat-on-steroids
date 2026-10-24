//! The three per-chat ledgers and their durable files: objectives (`goal-objectives`),
//! switches (`goal-switches`) and owed replies (`goal-replies`). Each is keyed by conversation
//! in insertion order, as a JavaScript `Map` is, and each restores row by row: a damaged row is
//! dropped and the rest are kept.

use serde_json::Value;

use cos_types::config::{GoalMode, GoalSettings};
use cos_types::ids::ConversationId;
use cos_types::json::True;
use cos_types::state::{
    GoalObjective, GoalObjectives, GoalReplies, GoalReplyObligation, GoalReplyState, GoalSwitch,
    GoalSwitchContext, GoalSwitchRole, GoalSwitches, V1,
};

pub const OBJECTIVES: &str = "goal-objectives";
pub const SWITCHES: &str = "goal-switches";
pub const REPLIES: &str = "goal-replies";

/// How long one reply may wait for its decision, and how many chats may be waiting.
pub const REPLY_TTL_MS: u64 = 12 * 60 * 60_000;
pub const MAX_REPLIES: usize = 200;
/// As many chats as anyone plausibly drives. Helper roles never lapse.
pub const MAX_SWITCHES: usize = 400;
/// `BROWSER_PICKUP_MAX_ATTEMPTS`.
pub const PICKUP_MAX_ATTEMPTS: u64 = 3;

/// A JavaScript `Map<string, V>`: setting a present key keeps its place.
#[derive(Clone, Debug, PartialEq)]
pub struct OrderedMap<V> {
    rows: Vec<(String, V)>,
}

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        Self { rows: Vec::new() }
    }
}

impl<V> OrderedMap<V> {
    pub fn get(&self, key: &str) -> Option<&V> {
        self.rows.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.rows.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn set(&mut self, key: &str, value: V) {
        match self.get_mut(key) {
            Some(slot) => *slot = value,
            None => self.rows.push((key.to_owned(), value)),
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.rows.iter().position(|(k, _)| k == key)?;
        Some(self.rows.remove(at).1)
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.rows.iter().map(|(k, v)| (k, v))
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.rows.iter().map(|(_, v)| v)
    }

    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.rows.iter_mut().map(|(_, v)| v)
    }

    pub fn retain(&mut self, mut keep: impl FnMut(&str, &V) -> bool) {
        self.rows.retain(|(k, v)| keep(k, v));
    }
}

/// `/^[0-9a-z-]{8,256}$/i`: the conversation ids every ledger accepts.
pub fn valid_conversation(id: &str) -> bool {
    (8..=256).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `/^[\w-]{8,64}$/`: a helper's source session id.
pub fn valid_source_session(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn safe_integer(value: Option<&Value>) -> Option<u64> {
    const MAX: u64 = 9_007_199_254_740_991;
    let value = value?;
    if let Some(int) = value.as_u64() {
        return (int <= MAX).then_some(int);
    }
    let float = value.as_f64()?;
    (float.fract() == 0.0 && (0.0..=MAX as f64).contains(&float)).then_some(float as u64)
}

fn rows<'a>(snapshot: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    (snapshot.get("version") == Some(&Value::from(1)))
        .then(|| snapshot.get(key).and_then(Value::as_array))
        .flatten()
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn cut(text: &str) -> String {
    crate::js::prefix(text, 200)
}

// ------------------------------------------------------------------ objectives

pub type Objectives = OrderedMap<String>;

pub fn objectives_snapshot(objectives: &Objectives, now: u64) -> GoalObjectives {
    GoalObjectives {
        version: V1,
        saved_at: now,
        objectives: objectives
            .iter()
            .map(|(conversation_id, objective)| GoalObjective {
                conversation_id: conversation_id.clone(),
                objective: objective.clone(),
                extra: Default::default(),
            })
            .collect(),
        extra: Default::default(),
    }
}

/// `restoreGoalObjectives`.
pub fn restore_objectives(snapshot: Option<&Value>) -> Objectives {
    let mut out = Objectives::default();
    let Some(list) = snapshot.and_then(|s| rows(s, "objectives")) else {
        return out;
    };
    for raw in list {
        let (Some(id), Some(objective)) = (text(raw, "conversationId"), text(raw, "objective"))
        else {
            continue;
        };
        let objective = crate::js::trim(objective);
        if valid_conversation(id) && !objective.is_empty() {
            out.set(id, objective.to_owned());
        }
    }
    out
}

// ------------------------------------------------------------------ switches

/// One chat's own answer to "may the loop write here, and in which mode".
#[derive(Clone, Debug, PartialEq)]
pub struct SwitchRow {
    pub enabled: bool,
    pub mode: GoalMode,
    pub after_turn: Option<bool>,
    pub at: u64,
    /// A helper's transcript: durable chat identity that always disables driving.
    pub decision: bool,
    pub source_session_id: Option<String>,
    pub context: Option<GoalSwitchContext>,
}

pub type Switches = OrderedMap<SwitchRow>;

/// `goalSwitchFor(id)`: the chat's own row, or the app-wide setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Switch {
    pub enabled: bool,
    pub mode: GoalMode,
    pub own: bool,
    pub after_turn: bool,
}

pub fn switch_for(switches: &Switches, goal: &GoalSettings, id: &str) -> Switch {
    match switches.get(id) {
        Some(row) => Switch {
            enabled: !row.decision && row.enabled,
            mode: row.mode,
            own: true,
            after_turn: row.after_turn == Some(true),
        },
        None => Switch {
            enabled: goal.enabled,
            mode: goal.mode,
            own: false,
            after_turn: false,
        },
    }
}

/// `applyGoalSwitch`: on names the mode; off only turns off the mode that is running.
pub fn apply_switch(enabled: bool, mode: GoalMode, which: GoalMode, on: bool) -> (bool, GoalMode) {
    if on {
        (true, which)
    } else if enabled && mode == which {
        (false, mode)
    } else {
        (enabled, mode)
    }
}

/// Oldest ordinary preferences go first.
pub fn bound_switches(switches: &mut Switches) {
    if switches.len() <= MAX_SWITCHES {
        return;
    }
    let mut ordinary: Vec<(String, u64)> = switches
        .iter()
        .filter(|(_, row)| !row.decision)
        .map(|(id, row)| (id.clone(), row.at))
        .collect();
    ordinary.sort_by_key(|(_, at)| *at);
    let excess = switches.len() - MAX_SWITCHES;
    for (id, _) in ordinary.into_iter().take(excess) {
        switches.remove(&id);
    }
}

pub fn switches_snapshot(switches: &Switches, now: u64) -> GoalSwitches {
    GoalSwitches {
        version: V1,
        saved_at: now,
        switches: switches
            .iter()
            .map(|(conversation_id, row)| GoalSwitch {
                conversation_id: conversation_id.clone(),
                enabled: row.enabled,
                mode: row.mode,
                after_turn: row.after_turn,
                at: row.at,
                role: row.decision.then_some(GoalSwitchRole::Decision),
                source_session_id: row.source_session_id.clone(),
                context: row.context.clone(),
                extra: Default::default(),
            })
            .collect(),
        extra: Default::default(),
    }
}

fn hex64(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| {
        text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// `restoreGoalSwitches`.
pub fn restore_switches(snapshot: Option<&Value>, now: u64) -> Switches {
    let mut out = Switches::default();
    let Some(list) = snapshot.and_then(|s| rows(s, "switches")) else {
        return out;
    };
    for raw in list {
        let Some(id) = text(raw, "conversationId").filter(|id| valid_conversation(id)) else {
            continue;
        };
        let Some(enabled) = raw.get("enabled").and_then(Value::as_bool) else {
            continue;
        };
        let mode = match text(raw, "mode") {
            Some("goal") => GoalMode::Goal,
            Some("loop") => GoalMode::Loop,
            _ => continue,
        };
        let at = safe_integer(raw.get("at"))
            .filter(|&at| at > 0)
            .unwrap_or(now);
        let decision = text(raw, "role") == Some("decision");
        let source_session_id = text(raw, "sourceSessionId")
            .filter(|source| decision && valid_source_session(source))
            .filter(|source| {
                !out.values()
                    .any(|row| row.source_session_id.as_deref() == Some(source))
            })
            .map(str::to_owned);
        let context = raw
            .get("context")
            .filter(|_| source_session_id.is_some())
            .filter(|context| {
                safe_integer(context.get("count")).is_some()
                    && hex64(context.get("hash"))
                    && hex64(context.get("instructions"))
            })
            .and_then(|context| serde_json::from_value(context.clone()).ok());
        out.set(
            id,
            SwitchRow {
                enabled: !decision && enabled,
                mode,
                after_turn: (raw.get("afterTurn") == Some(&Value::Bool(true)) && !decision)
                    .then_some(true),
                at,
                decision,
                source_session_id: if decision { source_session_id } else { None },
                context: if decision { context } else { None },
            },
        );
    }
    bound_switches(&mut out);
    out
}

// ------------------------------------------------------------------ replies

pub type Replies = OrderedMap<GoalReplyObligation>;

/// Retires expired pickups and caps the ledger to its newest conversations.
pub fn bound_replies(replies: &mut Replies, now: u64) {
    for reply in replies.values_mut() {
        if reply.state == GoalReplyState::Pending
            && now.saturating_sub(reply.accepted_at) >= REPLY_TTL_MS
        {
            reply.state = GoalReplyState::Handled;
        }
    }
    if replies.len() <= MAX_REPLIES {
        return;
    }
    let mut oldest: Vec<(String, u64)> = replies
        .iter()
        .map(|(id, reply)| (id.clone(), reply.accepted_at))
        .collect();
    oldest.sort_by_key(|(_, at)| *at);
    let excess = replies.len() - MAX_REPLIES;
    for (id, _) in oldest.into_iter().take(excess) {
        replies.remove(&id);
    }
}

pub fn replies_snapshot(replies: &Replies, now: u64) -> GoalReplies {
    GoalReplies {
        version: V1,
        saved_at: now,
        replies: replies.values().cloned().collect(),
        extra: Default::default(),
    }
}

/// `restoreGoalReplies`.
pub fn restore_replies(snapshot: Option<&Value>, now: u64) -> Replies {
    let mut out = Replies::default();
    let Some(list) = snapshot.and_then(|s| rows(s, "replies")) else {
        return out;
    };
    for raw in list {
        let Some(id) = text(raw, "conversationId").filter(|id| valid_conversation(id)) else {
            continue;
        };
        let Ok(conversation_id) = ConversationId::parse(id) else {
            continue;
        };
        let present = |key: &str| match raw.get(key) {
            Some(Value::String(text)) => (!text.is_empty()).then(|| text.clone()),
            Some(Value::Null | Value::Bool(false)) | None => None,
            Some(other) => Some(other.to_string()),
        };
        let (Some(session_id), Some(reply_id), Some(turn_id)) =
            (present("sessionId"), present("replyId"), present("turnId"))
        else {
            continue;
        };
        let Some(event_seq) = safe_integer(raw.get("eventSeq")) else {
            continue;
        };
        if event_seq == 0 && reply_id != cut(&format!("turn:{turn_id}")) {
            continue;
        }
        let Some(accepted_at) = safe_integer(raw.get("acceptedAt")).filter(|&at| at > 0) else {
            continue;
        };
        let state = match text(raw, "state") {
            Some("pending") => GoalReplyState::Pending,
            Some("handled") => GoalReplyState::Handled,
            _ => continue,
        };
        let positive = |key: &str| safe_integer(raw.get(key)).filter(|&v| v > 0);
        let attempts = safe_integer(raw.get("pickupAttempts"));
        let stopped = positive("pickupStoppedAt").or_else(|| {
            attempts
                .filter(|&a| a >= PICKUP_MAX_ATTEMPTS)
                .map(|_| accepted_at)
        });
        out.set(
            id,
            GoalReplyObligation {
                explicit_activation: (raw.get("explicitActivation") == Some(&Value::Bool(true)))
                    .then_some(True),
                silence_source_turn_id: text(raw, "silenceSourceTurnId")
                    .filter(|t| !t.is_empty())
                    .map(cut),
                silence_pro: (raw.get("silencePro") == Some(&Value::Bool(true))).then_some(true),
                listen_until: positive("listenUntil"),
                recovery_stop_claimed: (raw.get("recoveryStopClaimed") == Some(&Value::Bool(true)))
                    .then_some(True),
                pickup_attempts: attempts.map(|a| a.min(PICKUP_MAX_ATTEMPTS)),
                pickup_next_at: positive("pickupNextAt"),
                pickup_stopped_at: stopped,
                conversation_id,
                session_id: cut(&session_id),
                reply_id: cut(&reply_id),
                turn_id: cut(&turn_id),
                event_seq,
                accepted_at,
                state,
                extra: Default::default(),
            },
        );
    }
    bound_replies(&mut out, now);
    out
}
