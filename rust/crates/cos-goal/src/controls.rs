//! What drives one chat: its own switch or the app-wide one, its saved objective, and the
//! backend and key each mode runs on. Objective and switch saves are durable before they are
//! published; one writer per file stages, writes and publishes.

use std::sync::Arc;

use cos_secrets::SecretKey;
use cos_types::config::{Config, GoalBackend, GoalMode, GoalProviderKind, LoopBackend};
use cos_types::ids::SessionId;
use cos_types::session::ReasoningEffort;

use crate::ledger::{self, MAX_SWITCHES, Switch, SwitchRow, apply_switch, valid_conversation};
use crate::{Goal, NotDurable, js, write_now};

fn hyphenated(model: &str) -> String {
    js::trim(model)
        .to_lowercase()
        .split(js::is_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// `(?:gpt-?)?6(?:\.0)?` and what follows it.
fn after_six(name: &str) -> Option<&str> {
    let rest = name
        .strip_prefix("gpt")
        .map_or(name, |r| r.strip_prefix('-').unwrap_or(r));
    let rest = rest.strip_prefix('6')?;
    Some(rest.strip_prefix(".0").unwrap_or(rest))
}

/// `isAstraModel` (`shared/chat-models.ts`).
pub(crate) fn astra_model(model: &str, effort: Option<ReasoningEffort>) -> bool {
    let name = hyphenated(model);
    if name == "astra" {
        return true;
    }
    match after_six(&name) {
        Some("-pro" | "-astra") => true,
        Some("") => effort == Some(ReasoningEffort::Pro),
        _ => false,
    }
}

/// `isProModel`.
pub(crate) fn pro_model(model: &str, effort: Option<ReasoningEffort>) -> bool {
    if effort == Some(ReasoningEffort::Pro) || astra_model(model, effort) {
        return true;
    }
    let name = hyphenated(model);
    if name == "pro" {
        return true;
    }
    let Some(stem) = name.strip_suffix("-pro") else {
        return false;
    };
    let stem = stem
        .strip_prefix("gpt")
        .map_or(stem, |r| r.strip_prefix('-').unwrap_or(r));
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    let mut parts = stem.splitn(2, ['.', '-']);
    parts.next().is_some_and(digits) && parts.next().is_none_or(digits)
}

impl Goal {
    /// `goalObjectiveFor`: this chat's goal, or empty.
    pub fn objective_for(&self, conversation: &str) -> String {
        self.lock()
            .objectives
            .get(conversation)
            .cloned()
            .unwrap_or_default()
    }

    /// `goalSwitchFor`.
    pub fn switch_for(&self, conversation: &str) -> Switch {
        let config = self.config();
        ledger::switch_for(&self.lock().switches, &config.goal, conversation)
    }

    /// `goalArmedFor`: a chat's own switch answers alone; otherwise its goal also arms it.
    pub fn armed_for(&self, conversation: &str) -> bool {
        let held = self.switch_for(conversation);
        if held.own {
            return held.enabled;
        }
        held.enabled || !self.objective_for(conversation).is_empty()
    }

    /// `goalDrivingMode`: Loop is never entered by inheritance from a saved goal alone.
    pub fn driving_mode(&self, conversation: Option<&str>) -> GoalMode {
        let (enabled, mode) = match conversation {
            Some(id) => {
                let held = self.switch_for(id);
                (held.enabled, held.mode)
            }
            None => {
                let config = self.config();
                (config.goal.enabled, config.goal.mode)
            }
        };
        if enabled && mode == GoalMode::Loop {
            GoalMode::Loop
        } else {
            GoalMode::Goal
        }
    }

    /// `goalBackendFor(mode)`.
    pub fn backend_for(&self, mode: GoalMode) -> GoalBackend {
        let config = self.config();
        match mode {
            GoalMode::Loop => match config.goal.loop_backend.unwrap_or(LoopBackend::Chatgpt) {
                LoopBackend::Api => GoalBackend::Api,
                LoopBackend::Chatgpt => GoalBackend::Chatgpt,
            },
            GoalMode::Goal => config.goal.backend.unwrap_or(GoalBackend::Chatgpt),
        }
    }

    /// The helper model as it will actually run, for progress and logs.
    pub(crate) fn helper_label(&self, config: &Config) -> String {
        self.shared()
            .helper
            .model(config)
            .unwrap_or_else(|| "ChatGPT's current selection".to_owned())
    }

    /// `goalProgressFor(mode)`'s model before a draft exists.
    pub fn driver_model(&self, backend: GoalBackend) -> String {
        let config = self.config();
        match backend {
            GoalBackend::Chatgpt => self.helper_label(&config),
            GoalBackend::Templates => "Offline templates".to_owned(),
            GoalBackend::Api => config.goal.model.clone(),
        }
    }

    pub(crate) async fn secret(&self, key: SecretKey) -> Option<String> {
        let secrets = self.shared().secrets.clone();
        tokio::task::spawn_blocking(move || {
            secrets
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(&key)
        })
        .await
        .ok()
        .flatten()
    }

    /// `goalProviderKey(kind)`.
    pub(crate) async fn provider_key(&self, kind: GoalProviderKind) -> Option<String> {
        self.secret(match kind {
            GoalProviderKind::Custom => SecretKey::CustomProviderApiKey,
            GoalProviderKind::Openrouter => SecretKey::OpenRouterApiKey,
        })
        .await
    }

    /// `goalKeyPresent(mode)`: a custom endpoint is often a keyless local server.
    pub async fn key_present(&self, mode: GoalMode) -> bool {
        if self.backend_for(mode) != GoalBackend::Api {
            return true;
        }
        if self.config().goal.provider.kind == GoalProviderKind::Custom {
            return true;
        }
        self.provider_key(GoalProviderKind::Openrouter)
            .await
            .is_some()
    }

    /// `loopAfterTurnFor`: after-turn serves Goal and Loop; finish off makes it effective.
    pub fn loop_after_turn_for(&self, conversation: &str) -> bool {
        let control = self.switch_for(conversation);
        control.enabled && (control.after_turn || self.config().ui.finish_tool != Some(true))
    }

    /// `supportsFinishAutomation` for this chat's selected model, read off its session.
    async fn finish_model(&self, session: &str, conversation: &str) -> bool {
        let control = self.switch_for(conversation);
        if !control.enabled || self.config().ui.finish_tool != Some(true) {
            return false;
        }
        let Ok(id) = SessionId::parse(session) else {
            return false;
        };
        let Some(summary) = self.shared().sessions.summary(&id).await else {
            return false;
        };
        summary.conversation_id.as_deref() == Some(conversation)
            && summary.selected_model.as_ref().is_some_and(|selection| {
                selection.conversation_id == conversation
                    && (astra_model(&selection.model, selection.reasoning_effort)
                        || (control.mode == GoalMode::Loop
                            && pro_model(&selection.model, selection.reasoning_effort)))
            })
    }

    /// `astraFinishOnly`: a finish-only chat continues through the finish tool alone.
    pub async fn finish_only(&self, session: &str, conversation: &str) -> bool {
        self.finish_model(session, conversation).await && !self.loop_after_turn_for(conversation)
    }

    /// `proLoopDelivery` of `/activity`.
    pub async fn pro_loop_delivery(&self, session: Option<&str>, conversation: &str) -> bool {
        match session {
            Some(session) => self.finish_model(session, conversation).await,
            None => false,
        }
    }

    // ------------------------------------------------------------ objectives

    async fn commit_objectives(&self, staged: ledger::Objectives) -> Result<(), NotDurable> {
        let snapshot = ledger::objectives_snapshot(&staged, self.now());
        write_now(&self.files()?.objectives, snapshot).await?;
        self.lock().objectives = staged;
        Ok(())
    }

    /// `setGoalObjectiveNow`: durable before it is published. Returns what is stored, trimmed.
    pub async fn set_objective_now(
        &self,
        conversation: &str,
        text: &str,
    ) -> Result<String, NotDurable> {
        let goal = js::trim(text).to_owned();
        let _writer = self.shared().objectives_writes.lock().await;
        let mut staged = self.lock().objectives.clone();
        staged.remove(conversation);
        if !goal.is_empty() {
            staged.set(conversation, goal.clone());
        }
        self.commit_objectives(staged).await?;
        Ok(goal)
    }

    /// `clearGoalObjective`.
    pub async fn clear_objective(&self, conversation: &str) -> Result<(), NotDurable> {
        let _writer = self.shared().objectives_writes.lock().await;
        let mut staged = self.lock().objectives.clone();
        if staged.remove(conversation).is_none() {
            return Ok(());
        }
        self.commit_objectives(staged).await
    }

    /// `moveGoalObjective`: Compact & Resume carries a chat's goal to its replacement.
    pub async fn move_objective(&self, from: &str, to: &str) -> Result<bool, NotDurable> {
        if from.is_empty() || to.is_empty() || from == to {
            return Ok(false);
        }
        let _writer = self.shared().objectives_writes.lock().await;
        let mut staged = self.lock().objectives.clone();
        let Some(objective) = staged.remove(from) else {
            return Ok(false);
        };
        staged.remove(to);
        staged.set(to, objective);
        self.commit_objectives(staged).await?;
        Ok(true)
    }

    // ------------------------------------------------------------ switches

    async fn commit_switches(&self, mut staged: ledger::Switches) -> Result<(), NotDurable> {
        ledger::bound_switches(&mut staged);
        let snapshot = ledger::switches_snapshot(&staged, self.now());
        write_now(&self.files()?.switches, snapshot).await?;
        self.lock().switches = staged;
        Ok(())
    }

    /// `setGoalSwitchNow`: one chat's own switch, durable before it is published.
    pub async fn set_switch_now(
        &self,
        conversation: &str,
        which: GoalMode,
        on: bool,
        after_turn: Option<bool>,
    ) -> Result<(bool, GoalMode), NotDurable> {
        let writer = self.shared().switches_writes.lock().await;
        let config: Arc<Config> = self.config();
        let mut staged = self.lock().switches.clone();
        let before = staged.get(conversation).cloned();
        if let Some(row) = &before
            && row.decision
        {
            return Ok((false, row.mode));
        }
        if before.is_none() && staged.values().filter(|row| row.decision).count() >= MAX_SWITCHES {
            return Err(NotDurable("goal_switch_capacity".to_owned()));
        }
        let held = ledger::switch_for(&staged, &config.goal, conversation);
        let (enabled, mode) = apply_switch(held.enabled, held.mode, which, on);
        let after_turn = after_turn
            .or(before.as_ref().and_then(|row| row.after_turn))
            .unwrap_or(false);
        staged.set(
            conversation,
            SwitchRow {
                enabled,
                mode,
                after_turn: Some(after_turn),
                at: self.now(),
                decision: false,
                source_session_id: None,
                context: None,
            },
        );
        self.commit_switches(staged).await?;
        drop(writer);
        self.notify();
        Ok((enabled, mode))
    }

    /// `registerGoalDecisionChat`: committed before a helper's first send is acknowledged.
    pub async fn register_decision_chat(
        &self,
        conversation: &str,
        source: Option<&str>,
    ) -> Result<(), NotDurable> {
        let refuse = |code: &str| Err(NotDurable(code.to_owned()));
        if !valid_conversation(conversation) {
            return refuse("bad_conversation_id");
        }
        if source.is_some_and(|s| !ledger::valid_source_session(s)) {
            return refuse("bad_source_session_id");
        }
        let _writer = self.shared().switches_writes.lock().await;
        let mut staged = self.lock().switches.clone();
        let before = staged.get(conversation).cloned();
        let bound = before
            .as_ref()
            .and_then(|row| row.source_session_id.clone());
        if let (Some(source), Some(bound)) = (source, bound.as_deref())
            && bound != source
        {
            return refuse("goal_helper_wrong_source");
        }
        if let Some(source) = source
            && staged.iter().any(|(id, row)| {
                id != conversation && row.source_session_id.as_deref() == Some(source)
            })
        {
            return refuse("goal_helper_already_bound");
        }
        let was_decision = before.as_ref().is_some_and(|row| row.decision);
        if was_decision && (source.is_none() || bound.as_deref() == source) {
            return Ok(());
        }
        if !was_decision && staged.values().filter(|row| row.decision).count() >= MAX_SWITCHES {
            return refuse("goal_helper_capacity");
        }
        staged.set(
            conversation,
            SwitchRow {
                enabled: false,
                mode: before.as_ref().map_or(GoalMode::Goal, |row| row.mode),
                after_turn: None,
                at: self.now(),
                decision: true,
                source_session_id: source.map(str::to_owned),
                context: None,
            },
        );
        self.commit_switches(staged).await
    }

    /// `isGoalDecisionChat`.
    pub fn is_decision_chat(&self, conversation: &str) -> bool {
        self.lock()
            .switches
            .get(conversation)
            .is_some_and(|row| row.decision)
    }

    /// `clearAllGoalSwitches`: the master stop. Helper identities stay.
    pub async fn clear_all_switches(&self) -> Result<(), NotDurable> {
        let _writer = self.shared().switches_writes.lock().await;
        let mut staged = self.lock().switches.clone();
        if staged.is_empty() {
            return Ok(());
        }
        staged.retain(|_, row| row.decision);
        self.commit_switches(staged).await
    }

    /// `moveGoalSwitch`: Compact & Resume carries a chat's own switch to its replacement.
    pub async fn move_switch(&self, from: &str, to: &str) -> Result<bool, NotDurable> {
        if from.is_empty() || to.is_empty() || from == to {
            return Ok(false);
        }
        let _writer = self.shared().switches_writes.lock().await;
        let mut staged = self.lock().switches.clone();
        let decision = |id: &str| staged.get(id).is_some_and(|row| row.decision);
        if decision(from) || decision(to) {
            return Ok(false);
        }
        let Some(row) = staged.remove(from) else {
            return Ok(false);
        };
        staged.set(to, row);
        self.commit_switches(staged).await?;
        Ok(true)
    }
}
