//! `/settings`: the automatic-compaction and Goal/Loop switches a ChatGPT composer draws, read
//! (`GET`) and written (`POST`). A switch sent with a conversation is that chat's own answer and
//! belongs to the Goal owner; without one it moves the app-wide setting every chat inherits.

use std::sync::{Arc, Mutex};

use cos_secrets::{SecretKey, SecretStore};
use cos_store::Logger;
use cos_types::config::{
    Config, GoalBackend, GoalMode, GoalProviderKind, GoalSettings, LoopBackend,
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::models::{ChatModelCatalog, helper_selection};
use crate::ports::{ChatPolicy, ChatSwitches, ConfigWriter};
use crate::text::conversation_id;

/// `contextView()`: both lines the meter fills against, and whether anything acts on them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ContextView {
    pub auto: bool,
    pub threshold: u64,
    pub warn: u64,
    pub limit: u64,
}

impl ContextView {
    /// With no chat in view, automatic compaction is allowed exactly when it is on.
    pub fn of(config: &Config) -> Self {
        Self {
            auto: config.compaction.auto,
            threshold: config.compaction.auto_tokens,
            warn: config.sessions.advisory_tokens,
            limit: config.sessions.limit_tokens,
        }
    }
}

/// `goalProgressFor(mode)` and `goalKeyPresent(mode)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalDriver {
    pub backend: GoalBackend,
    pub model: String,
    pub provider: GoalProviderKind,
    pub has_key: bool,
}

/// `goalBackendFor(mode)`.
fn backend_for(goal: &GoalSettings, mode: GoalMode) -> GoalBackend {
    match mode {
        GoalMode::Loop => match goal.loop_backend.unwrap_or(LoopBackend::Chatgpt) {
            LoopBackend::Api => GoalBackend::Api,
            LoopBackend::Chatgpt => GoalBackend::Chatgpt,
        },
        GoalMode::Goal => goal.backend.unwrap_or(GoalBackend::Chatgpt),
    }
}

/// What reads the Goal provider's key: an API driver needs one, unless it is a custom endpoint,
/// which is often a keyless local server.
#[derive(Clone)]
pub struct GoalKeys {
    secrets: Arc<Mutex<SecretStore>>,
}

impl GoalKeys {
    pub fn new(secrets: Arc<Mutex<SecretStore>>) -> Self {
        Self { secrets }
    }

    async fn openrouter(&self) -> bool {
        let secrets = self.secrets.clone();
        // The first read decrypts the store, which is file and DPAPI work.
        tokio::task::spawn_blocking(move || {
            secrets
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .has(&SecretKey::OpenRouterApiKey)
        })
        .await
        .unwrap_or(false)
    }
}

/// The driver a mode runs on, as the composer names it.
pub async fn driver(
    config: &Config,
    catalog: &ChatModelCatalog,
    keys: &GoalKeys,
    mode: GoalMode,
) -> GoalDriver {
    let goal = &config.goal;
    let backend = backend_for(goal, mode);
    let model = match backend {
        GoalBackend::Chatgpt => helper_selection(config, catalog)
            .model
            .unwrap_or_else(|| "ChatGPT's current selection".to_owned()),
        GoalBackend::Templates => "Offline templates".to_owned(),
        GoalBackend::Api => goal.model.clone(),
    };
    let has_key = backend != GoalBackend::Api
        || goal.provider.kind == GoalProviderKind::Custom
        || keys.openrouter().await;
    GoalDriver {
        backend,
        model,
        provider: goal.provider.kind,
        has_key,
    }
}

/// `GET /settings`. Nothing here is conversation-scoped: a New Chat has no conversation yet.
pub async fn view(config: &Config, catalog: &ChatModelCatalog, keys: &GoalKeys) -> Value {
    let mode = config.goal.mode;
    let driver = driver(config, catalog, keys, mode).await;
    json!({
        "context": ContextView::of(config),
        "followOutput": config.ui.follow_output != Some(false),
        "mentionCore": config.ui.mention_core != Some(false),
        "goal": {
            "enabled": config.goal.enabled,
            // The app-wide setting is nobody's own answer: it is what a chat that never said
            // anything inherits.
            "own": false,
            "mode": mode,
            "backend": driver.backend,
            "model": driver.model,
            "provider": driver.provider,
            "hasKey": driver.has_key,
            "objective": "",
            "blocked": "",
        }
    })
}

/// `applyGoalSwitch(goal, which, on)`: on selects that mode; off only turns off the mode that
/// is on.
pub fn apply_goal_switch(goal: &GoalSettings, which: GoalMode, on: bool) -> GoalSettings {
    let mut next = goal.clone();
    if on {
        next.enabled = true;
        next.mode = which;
    } else if goal.enabled && goal.mode == which {
        next.enabled = false;
    }
    next
}

/// The answer to `POST /settings`.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Reply(u16, Value),
    /// A chat-scoped switch before the Goal owner exists: answered as an unserved route.
    NotServed,
}

fn refusal(status: u16, error: &str) -> Outcome {
    Outcome::Reply(status, json!({ "error": error }))
}

pub struct Writers<'a> {
    pub config: &'a dyn ConfigWriter,
    pub policy: &'a dyn ChatPolicy,
    pub switches: &'a dyn ChatSwitches,
    pub keys: &'a GoalKeys,
    pub catalog: &'a ChatModelCatalog,
    pub logger: &'a Logger,
}

/// `POST /settings`: one switch per request, refused before anything is written when the chat
/// it names may not take it.
pub async fn change(body: &Value, writers: Writers<'_>) -> Outcome {
    let flag = |key: &str| body.get(key).and_then(Value::as_bool);
    let auto = flag("autoCompact");
    let goal = flag("goal");
    let looping = flag("loop");
    let conversation = conversation_id(body.get("conversationId")).map(|id| id.as_str().to_owned());
    if body.get("loopAfterTurn").is_some_and(Value::is_boolean) {
        if conversation.is_none() || auto.is_some() || goal.is_some() || looping.is_some() {
            return refusal(400, "bad_loop_delivery");
        }
        let (Some(chat), Some(after)) = (
            conversation,
            body.get("loopAfterTurn").and_then(Value::as_bool),
        ) else {
            return Outcome::NotServed;
        };
        return match writers.switches.after_turn(chat, after).await {
            Some((status, answer)) => Outcome::Reply(status, answer),
            None => Outcome::NotServed,
        };
    }
    // Goal and Loop are one setting drawn as two controls: a body carrying both describes a
    // state that does not exist.
    if goal.is_some() && looping.is_some() {
        return refusal(400, "goal_and_loop_exclusive");
    }
    if auto.is_none() && goal.is_none() && looping.is_none() {
        return refusal(400, "nothing_to_change");
    }
    let turns_on = [auto, goal, looping].contains(&Some(true));
    if let Some(chat) = &conversation {
        if turns_on && writers.policy.superseded(chat.clone()).await {
            return refusal(409, "conversation_superseded");
        }
        // Turning anything on from a blocked chat is refused; turning it off stays possible.
        if turns_on && writers.policy.blocked(chat) {
            return Outcome::Reply(
                409,
                json!({
                    "error": "chat_blocked",
                    "message": "This chat is blocked in the app. Release it there before turning Goal, Loop or auto-compaction on."
                }),
            );
        }
        if auto.is_some() && writers.policy.worker(chat) {
            return Outcome::Reply(
                409,
                json!({
                    "error": "worker_compaction_disabled",
                    "message": "Worker chats never auto-compact and cannot change Compact & Resume from their composer."
                }),
            );
        }
    }
    let which = match (goal, looping) {
        (Some(on), _) => Some((GoalMode::Goal, on)),
        (None, Some(on)) => Some((GoalMode::Loop, on)),
        (None, None) => None,
    };
    // A composer's switch answers for its own chat: the Goal owner holds it. Only a New Chat,
    // with no id yet, moves the app-wide setting every chat inherits.
    let scoped = match (which, &conversation) {
        (Some((mode, on)), Some(chat)) => Some((chat.clone(), mode, on)),
        _ => None,
    };
    if scoped.is_some() && !writers.switches.served() {
        return Outcome::NotServed;
    }
    let driving = Arc::new(Mutex::new(None::<GoalMode>));
    let seen = driving.clone();
    let app_wide = if scoped.is_some() { None } else { which };
    let updated = writers
        .config
        .update(Box::new(move |config| {
            *seen.lock().unwrap_or_else(|poison| poison.into_inner()) =
                config.goal.enabled.then_some(config.goal.mode);
            let mut next = config.clone();
            if let Some(auto) = auto {
                next.compaction.auto = auto;
            }
            if let Some((mode, on)) = app_wide {
                next.goal = apply_goal_switch(&config.goal, mode, on);
            }
            next
        }))
        .await;
    let next = match updated {
        Ok(next) => next,
        Err(error) => {
            writers
                .logger
                .warn(&format!("bridge request failed: {error}"));
            return Outcome::Reply(500, json!({ "error": "internal" }));
        }
    };
    let chat_switch = match &scoped {
        Some((chat, mode, on)) => match writers.switches.set(chat.clone(), *mode, *on).await {
            Some(Ok(held)) => Some(held),
            Some(Err((status, body))) => return Outcome::Reply(status, body),
            None => return Outcome::NotServed,
        },
        None => None,
    };
    if auto == Some(false)
        && let Err(error) = writers.policy.cancel_automatic_resumes().await
    {
        writers.logger.warn(&format!(
            "bridge: Auto Off could not durably cancel its compaction ticket(s) — {error}"
        ));
        return Outcome::Reply(
            503,
            json!({ "error": "auto_compaction_cancel_not_durable", "retryable": true }),
        );
    }
    let was = *driving.lock().unwrap_or_else(|poison| poison.into_inner());
    if chat_switch.is_none() && was != next.goal.enabled.then_some(next.goal.mode) {
        writers.policy.retire_goal_drafts(!next.goal.enabled);
    }
    let changes: Vec<String> = [
        auto.map(|on| format!("automatic compaction {}", on_off(on))),
        goal.map(|on| format!("Goal {}", on_off(on))),
        looping.map(|on| format!("Loop {}", on_off(on))),
    ]
    .into_iter()
    .flatten()
    .collect();
    let scope = match &scoped {
        Some((chat, _, _)) => format!(" for chat {chat}"),
        None => String::new(),
    };
    writers.logger.info(&format!(
        "bridge: browser set {}{scope}",
        changes.join(" and ")
    ));
    let (enabled, mode) = chat_switch.unwrap_or((next.goal.enabled, next.goal.mode));
    let driver = driver(&next, writers.catalog, writers.keys, mode).await;
    Outcome::Reply(
        200,
        json!({
            "context": ContextView::of(&next),
            "goal": {
                "enabled": enabled,
                "own": chat_switch.is_some(),
                "mode": mode,
                "backend": driver.backend,
                "model": driver.model,
                "provider": driver.provider,
                "hasKey": driver.has_key,
            }
        }),
    )
}

fn on_off(on: bool) -> &'static str {
    if on { "on" } else { "off" }
}
