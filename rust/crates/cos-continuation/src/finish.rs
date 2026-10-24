//! The held finish boundary (`session/finish.ts`) and its `session_finish` tool
//! (`tools-core.ts`).
//!
//! HELD is a model instruction, not a lock on ChatGPT's finalization. The authority is the
//! session's own `finishTurn` projection, built from app progress receipts: a turn is held from
//! its start until a `released` receipt for that exact turn and chat is recorded.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cos_sessions::SessionStore;
use cos_tools::{
    CallContext, DynTool, Feature, Listing, Requirement, Tool, ToolError, ToolOutput, ToolResult,
    ToolSpec,
};
use cos_types::config::Config;
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{FinishControl, FinishControlState, SessionSummary};
use serde::Deserialize;
use tokio::sync::watch;

use crate::events::{Progress, record_progress};
use crate::{Clock, js};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `sessionFinishDeadline`: each call waits at most 25 seconds.
pub const FINISH_WAIT_MS: u64 = 25_000;
const REMAINING: &str = "Process any user input attached to this result.";
const EXACT_CALLER: &str = "Session finish requires this caller’s exact active session and turn";
const UNVERIFIED_START: &str = "The active turn changed or its start could not be verified";
/// How often a held wait looks again for input the outbox may have admitted.
const RECHECK_MS: u64 = 250;

/// What the outbox knows about one session's waiting messages.
pub trait FinishInputs: Send + Sync + 'static {
    /// A message of this session is `queued`, `browser` or `tool`.
    fn waiting(&self, session: &SessionId) -> BoxFuture<'static, bool>;
    /// `finishNeedsBrowserInput`: the head message must go through the browser after this turn,
    /// so the hold is released for it.
    fn needs_browser(&self, session: &SessionId) -> BoxFuture<'static, bool>;
    /// `hasEligibleToolInput(session, true)`: a message can join this tool result.
    fn tool_input(&self, session: &SessionId) -> BoxFuture<'static, bool>;
}

/// The chat-level owners the hold asks about: blocked chats, workers (E2.6) and the
/// automatic Goal check (E2.7).
pub trait FinishChats: Send + Sync + 'static {
    fn blocked(&self, conversation: &str) -> bool;
    /// `goalWorkerChat`: workers and decision helpers report another way.
    fn worker(&self, conversation: &str) -> bool;
    /// `automaticFinishEnabled`: the chat's Goal or Loop decides at the finish boundary.
    fn automatic(&self, conversation: &str) -> bool;
}

/// No outbox: nothing waits.
pub struct NoFinishInputs;

impl FinishInputs for NoFinishInputs {
    fn waiting(&self, _session: &SessionId) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
    fn needs_browser(&self, _session: &SessionId) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
    fn tool_input(&self, _session: &SessionId) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
}

/// No blocked chat, no worker, no automatic Goal.
pub struct NoFinishChats;

impl FinishChats for NoFinishChats {
    fn blocked(&self, _conversation: &str) -> bool {
        false
    }
    fn worker(&self, _conversation: &str) -> bool {
        false
    }
    fn automatic(&self, _conversation: &str) -> bool {
        false
    }
}

/// The desktop notification, when there is a desktop.
pub trait FinishNotifier: Send + Sync + 'static {
    /// `Some(false)`: the app is open and showed nothing. `None`: it could not be shown.
    fn notify(&self, title: &str, body: &str, session: &SessionId, turn: &str) -> Option<bool>;
}

/// What [`Finish::new`] needs.
pub struct FinishDeps {
    pub sessions: SessionStore,
    pub config: watch::Receiver<Arc<Config>>,
    pub inputs: Arc<dyn FinishInputs>,
    pub chats: Arc<dyn FinishChats>,
    /// `None` until a desktop shell sets one (`setFinishNotifier`).
    pub notifier: Option<Arc<dyn FinishNotifier>>,
    pub clock: Clock,
}

/// The finish owner. Clones share one.
#[derive(Clone)]
pub struct Finish {
    inner: Arc<Inner>,
}

type Notice = watch::Receiver<Option<Result<String, String>>>;

struct Inner {
    sessions: SessionStore,
    config: watch::Receiver<Arc<Config>>,
    inputs: Arc<dyn FinishInputs>,
    chats: Arc<dyn FinishChats>,
    notifier: Option<Arc<dyn FinishNotifier>>,
    clock: Clock,
    /// `finishCalls`: session_finish calls waiting per turn.
    calls: Mutex<HashMap<String, usize>>,
    /// `running`: the notice already being prepared for a turn.
    running: Mutex<HashMap<String, Notice>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn active_turn(session: &SessionSummary) -> Option<String> {
    session.active_turn_id.clone().flatten()
}

impl Finish {
    pub fn new(deps: FinishDeps) -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: deps.sessions,
                config: deps.config,
                inputs: deps.inputs,
                chats: deps.chats,
                notifier: deps.notifier,
                clock: deps.clock,
                calls: Mutex::new(HashMap::new()),
                running: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn now(&self) -> u64 {
        (self.inner.clock)()
    }

    fn finish_tool_on(&self) -> bool {
        self.inner.config.borrow().ui.finish_tool == Some(true)
    }

    /// The `session_finish` tool on Core, listed while "Finish tool" is on.
    pub fn tool(&self) -> Arc<dyn DynTool> {
        Arc::new(SessionFinishTool {
            finish: self.clone(),
        })
    }

    /// `finishReleased`: an app-authored release receipt for this exact turn and chat, or a turn
    /// that is no longer the session's.
    async fn released(
        &self,
        session: &SessionId,
        turn: &str,
        conversation: &str,
    ) -> Result<bool, String> {
        let Some(summary) = self.inner.sessions.summary(session).await else {
            return Ok(true);
        };
        if active_turn(&summary).as_deref() != Some(turn)
            || summary.conversation_id.as_deref() != Some(conversation)
        {
            return Ok(true);
        }
        let Some(Some(finish)) = &summary.finish_turn else {
            return Err("This turn’s finish authority could not be recovered".into());
        };
        if finish.turn_id != turn {
            return Err("This turn’s finish authority could not be recovered".into());
        }
        Ok(finish.conversation_id.as_deref() == Some(conversation) && finish.released)
    }

    /// `sessionFinishHeld`: the turn is still held for its chat.
    pub async fn held(
        &self,
        session: &SessionId,
        turn: Option<&str>,
        conversation: Option<&str>,
    ) -> Result<bool, String> {
        let (Some(turn), Some(conversation)) = (turn, conversation) else {
            return Ok(false);
        };
        if !self.finish_tool_on() || self.inner.chats.blocked(conversation) {
            return Ok(false);
        }
        Ok(!self.released(session, turn, conversation).await?)
    }

    /// `sessionFinishWaiting`: a session_finish call is waiting on a held turn with no message
    /// queued for it.
    pub async fn waiting(
        &self,
        session: &SessionId,
        turn: Option<&str>,
        conversation: Option<&str>,
    ) -> bool {
        let Some(turn) = turn else {
            return false;
        };
        if !lock(&self.inner.calls).contains_key(&format!("{session}:{turn}")) {
            return false;
        }
        self.held(session, Some(turn), conversation)
            .await
            .unwrap_or(false)
            && !self.inner.inputs.waiting(session).await
    }

    /// `releaseSessionFinish`: End turn (or Stop) releases the hold, recorded as an app receipt.
    pub async fn release(
        &self,
        session: &SessionId,
        expected_turn: &str,
        stop: bool,
    ) -> Result<(), String> {
        const CHANGED: &str = "The active turn changed; refresh before ending it";
        let summary = self.inner.sessions.summary(session).await;
        let Some(conversation) = summary
            .as_ref()
            .filter(|summary| active_turn(summary).as_deref() == Some(expected_turn))
            .and_then(|summary| summary.conversation_id.clone())
        else {
            return Err(CHANGED.into());
        };
        if self.released(session, expected_turn, &conversation).await? {
            return Ok(());
        }
        let latest = self.inner.sessions.summary(session).await;
        if latest.as_ref().is_none_or(|latest| {
            active_turn(latest).as_deref() != Some(expected_turn)
                || latest.conversation_id.as_deref() != Some(&conversation)
        }) {
            return Err(CHANGED.into());
        }
        let message = if stop {
            "Stop requested. The finish hold was released; ChatGPT has not yet confirmed that generation stopped."
        } else {
            "Finish hold released. ChatGPT may finish its answer; generation has not been stopped."
        };
        let receipt = record_progress(
            &self.inner.sessions,
            session,
            Progress {
                id: &format!("finish-release:{expected_turn}"),
                text: message,
                anchor: None,
                turn: Some(expected_turn),
                finish: Some(control(FinishControlState::Released, &conversation)),
            },
            self.now(),
        )
        .await;
        if receipt.is_none() {
            return Err("End turn could not be saved; this turn remains held".into());
        }
        Ok(())
    }

    /// `announceSessionFinish`: the tool's work. Prepares this turn's one notice, then waits at
    /// most until `deadline` for input to deliver or for the hold to end.
    pub async fn announce(
        &self,
        session: &SessionId,
        conversation: &str,
        summary: &str,
        started_at: u64,
        deadline: u64,
    ) -> Result<String, String> {
        let current = self.inner.sessions.summary(session).await;
        let (Some(current), Some(turn)) =
            (current.as_ref(), current.as_ref().and_then(active_turn))
        else {
            return Err(EXACT_CALLER.into());
        };
        if current.conversation_id.as_deref() != Some(conversation) {
            return Err(EXACT_CALLER.into());
        }
        let authority = current.finish_turn.clone().flatten();
        if authority
            .as_ref()
            .is_none_or(|finish| finish.turn_id != turn || finish.started_at > started_at)
        {
            return Err(UNVERIFIED_START.into());
        }
        let key = format!("{session}:{turn}");
        *lock(&self.inner.calls).entry(key.clone()).or_default() += 1;
        let outcome = self
            .announce_counted(session, conversation, &turn, summary, started_at, deadline)
            .await;
        let mut calls = lock(&self.inner.calls);
        let remaining = calls.get(&key).copied().unwrap_or(1).saturating_sub(1);
        if remaining == 0 {
            calls.remove(&key);
        } else {
            calls.insert(key, remaining);
        }
        outcome
    }

    async fn announce_counted(
        &self,
        session: &SessionId,
        conversation: &str,
        turn: &str,
        summary: &str,
        started_at: u64,
        deadline: u64,
    ) -> Result<String, String> {
        let queued = self.inner.inputs.waiting(session).await;
        let automatic = self.inner.chats.automatic(conversation);
        let notice = if queued {
            "Queued user instructions are ready.".to_owned()
        } else if automatic {
            // The Goal check belongs to the Goal owner (E2.7); with it absent no chat is
            // automatic, so this branch is the TypeScript wording for when it lands.
            "Automatic Goal generation is running. Its instruction will arrive on a later tool call."
                .to_owned()
        } else {
            self.prepare_notice(session, conversation, summary, started_at)
                .await?
        };
        let held = self
            .wait_for_boundary(session, turn, conversation, deadline)
            .await?;
        Ok(if held {
            format!(
                "HELD: Keep this turn open. Complete and verify the remaining requested work, including attached instructions, before calling session_finish again. New messages and progress updates are not finish checkpoints. If no requested work remains, wait here with session_finish; do not invent work. The user can stop generation with the composer Stop button.\n{notice}"
            )
        } else {
            format!(
                "RELEASED: This hold has ended or its turn changed. Do not repeat the hold; follow the latest user instruction. This is not confirmation that provider generation stopped.\n{notice}"
            )
        })
    }

    /// `prepareNotice` for a model-issued call on a chat with no automatic Goal: one desktop
    /// notice per turn, recorded as a `notified` receipt first.
    async fn prepare_notice(
        &self,
        session: &SessionId,
        conversation: &str,
        summary: &str,
        requested_at: u64,
    ) -> Result<String, String> {
        let configuration = self.inner.config.borrow().clone();
        if configuration.ui.finish_tool != Some(true) {
            return Ok("Finish hold is disabled.".into());
        }
        let current = self.inner.sessions.summary(session).await;
        let turn = current.as_ref().and_then(active_turn);
        let (Some(current), Some(turn)) = (current, turn) else {
            return Err(EXACT_CALLER.into());
        };
        if current.conversation_id.as_deref() != Some(conversation)
            || self.inner.chats.blocked(conversation)
        {
            return Err(EXACT_CALLER.into());
        }
        let key = format!("{session}:{turn}");
        let joined = lock(&self.inner.running).get(&key).cloned();
        if let Some(mut answer) = joined {
            let finish = self
                .inner
                .sessions
                .summary(session)
                .await
                .and_then(|summary| summary.finish_turn.flatten());
            if finish
                .as_ref()
                .is_none_or(|finish| finish.turn_id != turn || finish.started_at > requested_at)
            {
                return Err("This request predates the active turn".into());
            }
            loop {
                if let Some(result) = answer.borrow().clone() {
                    return result;
                }
                if answer.changed().await.is_err() {
                    return Err("The finish notice stopped".into());
                }
            }
        }
        let (publish, answer) = watch::channel(None);
        lock(&self.inner.running).insert(key.clone(), answer);
        let result = self
            .notice_work(
                session,
                conversation,
                &turn,
                summary,
                requested_at,
                &configuration,
            )
            .await;
        let _ = publish.send(Some(result.clone()));
        lock(&self.inner.running).remove(&key);
        result
    }

    async fn notice_work(
        &self,
        session: &SessionId,
        conversation: &str,
        turn: &str,
        summary: &str,
        requested_at: u64,
        configuration: &Arc<Config>,
    ) -> Result<String, String> {
        let current = self.inner.sessions.summary(session).await;
        let authority = current
            .as_ref()
            .and_then(|summary| summary.finish_turn.clone().flatten());
        let verified = current.as_ref().is_some_and(|current| {
            active_turn(current).as_deref() == Some(turn)
                && current.conversation_id.as_deref() == Some(conversation)
        }) && authority
            .as_ref()
            .is_some_and(|finish| finish.turn_id == turn && finish.started_at <= requested_at);
        let Some(authority) = authority.filter(|_| verified) else {
            return Err(UNVERIFIED_START.into());
        };
        if !self.held(session, Some(turn), Some(conversation)).await? {
            return Ok("The finish hold is no longer active for this turn.".into());
        }
        if self.inner.inputs.waiting(session).await {
            return Ok(
                "Queued user instructions take priority over finish notices and automatic Goal work."
                    .into(),
            );
        }
        let notice_id = format!("finish:{turn}");
        let description = js::slice(js::trim(summary), 0, 1000);
        let mut notification =
            "This turn’s finish notice was already requested; no notification was repeated."
                .to_owned();
        if !authority.notified {
            let anchor = record_progress(
                &self.inner.sessions,
                session,
                Progress {
                    id: &notice_id,
                    text: &format!("Preparing finish notice: {description}"),
                    anchor: None,
                    turn: Some(turn),
                    finish: Some(control(FinishControlState::Notified, conversation)),
                },
                self.now(),
            )
            .await
            .ok_or_else(|| {
                "Finish notice could not be recorded; nothing was notified or drafted".to_owned()
            })?;
            if !self
                .still_current(session, conversation, turn, configuration)
                .await
            {
                return Ok("The turn changed before its finish notice was delivered.".into());
            }
            notification = match &self.inner.notifier {
                None => "Desktop notification is unavailable.".into(),
                Some(notifier) => match notifier.notify(
                    "Astra is wrapping up",
                    "Send an automatic Goal or write your next instruction.",
                    session,
                    turn,
                ) {
                    Some(false) => "The app is open; no desktop notification was shown.".into(),
                    Some(true) => "The user has been notified.".into(),
                    None => "The desktop notification could not be shown.".into(),
                },
            };
            record_progress(
                &self.inner.sessions,
                session,
                Progress {
                    id: &notice_id,
                    text: &format!("Astra is wrapping up: {description}\n{notification}"),
                    anchor: Some(anchor),
                    turn: Some(turn),
                    finish: None,
                },
                self.now(),
            )
            .await;
        }
        Ok(format!("{notification} {REMAINING}"))
    }

    /// `stillCurrent`: the settings, the turn, the chat and the hold are those the notice began
    /// under.
    async fn still_current(
        &self,
        session: &SessionId,
        conversation: &str,
        turn: &str,
        configuration: &Arc<Config>,
    ) -> bool {
        let settings = Arc::ptr_eq(&self.inner.config.borrow(), configuration);
        let latest = self.inner.sessions.summary(session).await;
        settings
            && latest.is_some_and(|latest| {
                active_turn(&latest).as_deref() == Some(turn)
                    && latest.conversation_id.as_deref() == Some(conversation)
            })
            && self.finish_tool_on()
            && !self.inner.chats.blocked(conversation)
            && self
                .held(session, Some(turn), Some(conversation))
                .await
                .unwrap_or(false)
    }

    /// `waitForFinishBoundary`: one bounded wait. Input that can join this result ends it held;
    /// input that must go through the browser releases the hold for it.
    async fn wait_for_boundary(
        &self,
        session: &SessionId,
        turn: &str,
        conversation: &str,
        deadline: u64,
    ) -> Result<bool, String> {
        let mut index = self.inner.sessions.index();
        loop {
            let summary = self.inner.sessions.summary(session).await;
            let current = summary.as_ref().is_some_and(|summary| {
                active_turn(summary).as_deref() == Some(turn)
                    && summary.conversation_id.as_deref() == Some(conversation)
            });
            if !current || !self.held(session, Some(turn), Some(conversation)).await? {
                return Ok(false);
            }
            if self.inner.inputs.tool_input(session).await {
                return Ok(true);
            }
            if self.inner.inputs.needs_browser(session).await {
                self.release(session, turn, false).await?;
                return Ok(false);
            }
            let now = self.now();
            if now >= deadline {
                return Ok(true);
            }
            let step = (deadline - now).min(RECHECK_MS);
            tokio::select! {
                _ = index.changed() => {}
                () = tokio::time::sleep(Duration::from_millis(step)) => {}
            }
        }
    }
}

fn control(state: FinishControlState, conversation: &str) -> FinishControl {
    FinishControl {
        state,
        conversation_id: conversation.to_owned(),
        revision: None,
        input_revision: None,
        work_seq: None,
        extra: Extra::new(),
    }
}

struct SessionFinishTool {
    finish: Finish,
}

#[derive(Deserialize)]
struct SessionFinishArgs {
    summary: String,
}

impl Tool for SessionFinishTool {
    type Args = SessionFinishArgs;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "session_finish",
        listing: Listing::Feature(Feature::FinishTool),
        requires: Requirement::None,
    };

    async fn call(
        &self,
        cx: &CallContext,
        args: SessionFinishArgs,
    ) -> Result<ToolOutput, ToolError> {
        if !self.finish.finish_tool_on() {
            return Ok(ToolResult::text(
                "RELEASED: The user disabled finish hold. You may write your final answer.",
            )
            .into());
        }
        let Some((conversation, session)) = cx.caller.chat.clone() else {
            return Err(ToolError::Identity(
                "Exact session identity is required".into(),
            ));
        };
        let conversation = conversation.as_str().to_owned();
        if self.finish.inner.chats.worker(&conversation) {
            return Err(ToolError::Refused(
                "Session finish hold is not applicable to workers or decision helpers. Workers report with agents action=finish; decision helpers answer normally."
                    .into(),
            ));
        }
        let started_at = cx.started_at.0;
        let deadline = started_at + FINISH_WAIT_MS;
        match self
            .finish
            .announce(&session, &conversation, &args.summary, started_at, deadline)
            .await
        {
            Ok(text) => Ok(ToolResult::text(text).into()),
            Err(message) => Err(ToolError::Internal(message)),
        }
    }
}
