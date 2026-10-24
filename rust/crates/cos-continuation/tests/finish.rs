//! The held finish boundary, from the cases of `test/session-finish.test.ts` that do not need
//! the Goal owner: identity, the one notice per turn, the bounded wait, and End turn.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use cos_continuation::finish::{
    BoxFuture, Finish, FinishDeps, FinishInputs, FinishNotifier, NoFinishChats,
};
use cos_sessions::SessionStore;
use cos_store::config::first_launch_config;
use cos_store::{AppPaths, Logger, Platform};
use cos_tools::EpochMs;
use cos_types::config::Config;
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{
    EventBase, EventSource, FinishControlState, SessionEvent, TurnStartEvent,
};
use support::*;
use tokio::sync::watch;

#[derive(Default)]
struct Inputs {
    waiting: AtomicBool,
    needs_browser: AtomicBool,
}

struct Port(Arc<Inputs>);

impl FinishInputs for Port {
    fn waiting(&self, _session: &SessionId) -> BoxFuture<'static, bool> {
        let waiting = self.0.waiting.load(Ordering::SeqCst);
        Box::pin(async move { waiting })
    }
    fn needs_browser(&self, _session: &SessionId) -> BoxFuture<'static, bool> {
        let needs = self.0.needs_browser.load(Ordering::SeqCst);
        Box::pin(async move { needs })
    }
    fn tool_input(&self, _session: &SessionId) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
}

struct Shown;

impl FinishNotifier for Shown {
    fn notify(&self, title: &str, _body: &str, _session: &SessionId, _turn: &str) -> Option<bool> {
        assert_eq!(title, "Astra is wrapping up");
        Some(true)
    }
}

fn finish_config() -> Arc<Config> {
    let mut config = first_launch_config(Platform::current());
    config.ui.finish_tool = Some(true);
    Arc::new(config)
}

struct Held {
    sessions: SessionStore,
    finish: Finish,
    inputs: Arc<Inputs>,
    session: SessionId,
    config: watch::Sender<Arc<Config>>,
}

async fn held_turn(profile: &Profile, notifier: Option<Arc<dyn FinishNotifier>>) -> Held {
    let paths = AppPaths::at(&profile.0);
    let sessions = SessionStore::open(&paths, Logger::with_clock(|| 0, false));
    sessions.restore().await;
    let session = sessions
        .create_for_conversation(CHAT_A, Some("work"))
        .await
        .unwrap()
        .id;
    sessions
        .append_event(
            &session,
            SessionEvent::TurnStart(TurnStartEvent {
                base: EventBase {
                    model: None,
                    reasoning_effort: None,
                    seq: 0,
                    time: EpochMs::now().0 - 1_000,
                    authored_at: None,
                    turn_origin: None,
                    source: EventSource::Extension,
                    agent: None,
                    turn_id: Some("turn-1".into()),
                },
                detail: None,
                extra: Extra::new(),
            }),
        )
        .await
        .unwrap();
    let (config, receiver) = watch::channel(finish_config());
    let inputs = Arc::new(Inputs::default());
    let finish = Finish::new(FinishDeps {
        sessions: sessions.clone(),
        config: receiver,
        inputs: Arc::new(Port(inputs.clone())),
        chats: Arc::new(NoFinishChats),
        notifier,
        clock: cos_continuation::system_clock(),
    });
    Held {
        sessions,
        finish,
        inputs,
        session,
        config,
    }
}

impl Held {
    async fn announce(&self, wait_ms: u64) -> Result<String, String> {
        let now = EpochMs::now().0;
        self.finish
            .announce(
                &self.session,
                CHAT_A,
                "Implemented; verifying.",
                now,
                now + wait_ms,
            )
            .await
    }

    async fn progress(&self) -> Vec<(String, String, Option<FinishControlState>)> {
        self.sessions
            .recent_events(&self.session, 50, &["progress"])
            .await
            .unwrap()
            .into_iter()
            .filter_map(|event| match event {
                SessionEvent::Progress(progress) => Some((
                    progress.progress_id.unwrap_or_default(),
                    progress.message.text,
                    progress.finish_control.map(|control| control.state),
                )),
                _ => None,
            })
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn holds_the_turn_and_notifies_once() {
    let profile = Profile::new("finish-once");
    let held = held_turn(&profile, Some(Arc::new(Shown))).await;
    let first = held.announce(300).await.unwrap();
    assert!(first.starts_with("HELD: Keep this turn open."), "{first}");
    assert!(first.ends_with(
        "\nThe user has been notified. Process any user input attached to this result."
    ));
    let second = held.announce(300).await.unwrap();
    assert!(second.ends_with(
        "\nThis turn’s finish notice was already requested; no notification was repeated. Process any user input attached to this result."
    ));
    let rows = held.progress().await;
    assert_eq!(rows.len(), 2, "one anchored notice: {rows:?}");
    assert_eq!(rows[0].0, "finish:turn-1");
    assert_eq!(
        rows[0].1,
        "Preparing finish notice: Implemented; verifying."
    );
    assert_eq!(rows[0].2, Some(FinishControlState::Notified));
    assert_eq!(
        rows[1].1,
        "Astra is wrapping up: Implemented; verifying.\nThe user has been notified."
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn says_when_no_desktop_can_show_the_notice() {
    let profile = Profile::new("finish-headless");
    let held = held_turn(&profile, None).await;
    let text = held.announce(100).await.unwrap();
    assert!(text.ends_with(
        "\nDesktop notification is unavailable. Process any user input attached to this result."
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_instructions_take_priority_over_the_notice() {
    let profile = Profile::new("finish-queued");
    let held = held_turn(&profile, None).await;
    held.inputs.waiting.store(true, Ordering::SeqCst);
    let text = held.announce(100).await.unwrap();
    assert!(
        text.ends_with("\nQueued user instructions are ready."),
        "{text}"
    );
    assert!(held.progress().await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn end_turn_releases_the_hold_for_that_exact_turn() {
    let profile = Profile::new("finish-release");
    let held = held_turn(&profile, None).await;
    assert!(
        held.finish
            .held(&held.session, Some("turn-1"), Some(CHAT_A))
            .await
            .unwrap()
    );
    assert_eq!(
        held.finish.release(&held.session, "turn-0", false).await,
        Err("The active turn changed; refresh before ending it".into())
    );
    held.finish
        .release(&held.session, "turn-1", false)
        .await
        .unwrap();
    assert!(
        !held
            .finish
            .held(&held.session, Some("turn-1"), Some(CHAT_A))
            .await
            .unwrap()
    );
    let started = std::time::Instant::now();
    let text = held.announce(5_000).await.unwrap();
    assert!(
        text.starts_with("RELEASED: This hold has ended or its turn changed."),
        "{text}"
    );
    assert!(
        started.elapsed().as_millis() < 2_000,
        "a released hold answers at once"
    );
    let summary = held.sessions.summary(&held.session).await.unwrap();
    assert!(summary.finish_turn.flatten().unwrap().released);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_for_the_browser_releases_the_hold_while_it_waits() {
    let profile = Profile::new("finish-browser");
    let held = held_turn(&profile, None).await;
    let inputs = held.inputs.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        inputs.needs_browser.store(true, Ordering::SeqCst);
    });
    let text = held.announce(10_000).await.unwrap();
    assert!(text.starts_with("RELEASED:"), "{text}");
    let rows = held.progress().await;
    assert!(rows.iter().any(|(id, _, state)| {
        id == "finish-release:turn-1" && *state == Some(FinishControlState::Released)
    }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_caller_that_is_not_the_active_turns_chat() {
    let profile = Profile::new("finish-caller");
    let held = held_turn(&profile, None).await;
    let now = EpochMs::now().0;
    assert_eq!(
        held.finish
            .announce(&held.session, CHAT_B, "done", now, now + 100)
            .await,
        Err("Session finish requires this caller’s exact active session and turn".into())
    );
    assert_eq!(
        held.finish
            .announce(&held.session, CHAT_A, "done", now - 60_000, now + 100)
            .await,
        Err("The active turn changed or its start could not be verified".into()),
        "a call older than the turn's start"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_disabled_finish_tool_holds_nothing() {
    let profile = Profile::new("finish-off");
    let held = held_turn(&profile, None).await;
    let mut config = (*finish_config()).clone();
    config.ui.finish_tool = Some(false);
    held.config.send_replace(Arc::new(config));
    assert!(
        !held
            .finish
            .held(&held.session, Some("turn-1"), Some(CHAT_A))
            .await
            .unwrap()
    );
    let text = held.announce(100).await.unwrap();
    assert!(text.starts_with("RELEASED:"));
    assert!(text.ends_with("\nFinish hold is disabled."));
}
