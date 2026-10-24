//! The Core as GPUI models. It replaces the TypeScript `AppState` push and the renderer's
//! `getSession` re-reads. Each snapshot the Core publishes becomes one entity, and the task that
//! follows its `watch` is the only writer of that entity. A view observes the entities it reads
//! and nothing else, so a usage change never repaints the session list. Nothing polls. A watch
//! wakes its task, and a chat's timeline wakes on the session store's append broadcast.

use std::sync::Arc;

use cos_companion::{ChatModelCatalog, UsageSnapshot};
use cos_core::AppCore;
use cos_sessions::{EventPosition, EventQuery, EventsError, SessionIndex};
use cos_types::app_state::{BridgeStatus, ConnectionStatus};
use cos_types::config::Config;
use cos_types::control_api::ControlApiEvents;
use cos_types::ids::SessionId;
use gpui::{App, AppContext as _, AsyncApp, Entity, Task, WeakEntity};
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
use tokio::sync::watch;

use crate::timeline::{TIMELINE_BATCH, TimelinePage};

/// The latest value of one Core snapshot.
pub struct Snapshot<T>(Arc<T>);

impl<T> Snapshot<T> {
    /// The value itself, to keep past this read.
    pub fn shared(&self) -> Arc<T> {
        self.0.clone()
    }
}

impl<T> std::ops::Deref for Snapshot<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.0
    }
}

/// The session index, and whether restore has finished reading it.
pub struct Sessions {
    pub index: Arc<SessionIndex>,
    /// Until restore ends, an empty index means "loading", not "no chats".
    pub restored: bool,
}

/// Every model the views read, and the Core they ask for work.
#[derive(Clone)]
pub struct Models {
    pub core: AppCore,
    pub settings: Entity<Snapshot<Config>>,
    pub connection: Entity<Snapshot<ConnectionStatus>>,
    pub bridge: Entity<Snapshot<BridgeStatus>>,
    pub sessions: Entity<Sessions>,
    pub chat_models: Entity<Snapshot<ChatModelCatalog>>,
    pub usage: Entity<Snapshot<UsageSnapshot>>,
}

impl Models {
    /// Reads every current snapshot and follows each one from here on.
    pub fn bind(core: AppCore, cx: &mut App) -> Self {
        let watches = core.watches();
        let sessions = cx.new(|_| Sessions {
            index: watches.sessions.borrow().clone(),
            restored: false,
        });
        follow(watches.sessions, &sessions, cx, |model, index| {
            model.index = index;
        });
        let restored = sessions.downgrade();
        let admission = watches.admission;
        cx.spawn(async move |cx| {
            // A shutdown before restore ends leaves the list as it is.
            if admission.admit().await.is_ok() {
                let _ = restored.update(cx, |model, cx| {
                    model.restored = true;
                    cx.notify();
                });
            }
        })
        .detach();
        Self {
            settings: snapshot(watches.config, cx),
            connection: snapshot(watches.connection, cx),
            bridge: snapshot(watches.bridge, cx),
            chat_models: snapshot(watches.chat_models, cx),
            usage: snapshot(watches.usage, cx),
            sessions,
            core,
        }
    }
}

fn snapshot<T: 'static>(receiver: watch::Receiver<Arc<T>>, cx: &mut App) -> Entity<Snapshot<T>> {
    let model = cx.new(|_| Snapshot(receiver.borrow().clone()));
    follow(receiver, &model, cx, |snapshot, value| snapshot.0 = value);
    model
}

/// Applies every later value of `receiver` to `model` on the UI thread, then notifies its
/// observers. The caller has already read the current value. Ends with the model or the Core.
fn follow<T: Clone + 'static, M: 'static>(
    mut receiver: watch::Receiver<T>,
    model: &Entity<M>,
    cx: &mut App,
    apply: impl Fn(&mut M, T) + 'static,
) {
    let model = model.downgrade();
    cx.spawn(async move |cx| {
        while receiver.changed().await.is_ok() {
            let value = receiver.borrow_and_update().clone();
            let applied = model.update(cx, |model, cx| {
                apply(model, value);
                cx.notify();
            });
            if applied.is_err() {
                break;
            }
        }
    })
    .detach();
}

/// Where one chat's timeline stands.
#[derive(Clone, Debug, PartialEq)]
pub enum TimelineState {
    Loading,
    Ready(TimelinePage),
    /// The session is gone, or the Core stopped.
    Missing,
}

/// One open chat's timeline. Dropping the entity stops following the chat.
pub struct Timeline {
    session: SessionId,
    state: TimelineState,
    _follow: Task<()>,
}

impl Timeline {
    pub fn open(core: &AppCore, session: SessionId, cx: &mut App) -> Entity<Self> {
        cx.new(|cx| {
            let (core, id) = (core.clone(), session.clone());
            let follow = cx.spawn(async move |this, cx| follow_timeline(core, id, this, cx).await);
            Self {
                session,
                state: TimelineState::Loading,
                _follow: follow,
            }
        })
    }

    pub fn session(&self) -> &SessionId {
        &self.session
    }

    pub fn state(&self) -> &TimelineState {
        &self.state
    }
}

async fn read(core: &AppCore, id: &SessionId, position: EventPosition) -> Option<ControlApiEvents> {
    let id = id.clone();
    let query = EventQuery {
        position,
        limit: TIMELINE_BATCH,
        kinds: None,
    };
    let read: Result<Result<ControlApiEvents, EventsError>, _> = core
        .spawn(move |domains| async move { domains.sessions.events(&id, query).await })
        .await;
    read.ok()?.ok()
}

async fn follow_timeline(
    core: AppCore,
    id: SessionId,
    this: WeakEntity<Timeline>,
    cx: &mut AsyncApp,
) {
    let set = |state: TimelineState, cx: &mut AsyncApp| {
        this.update(cx, |timeline, cx| {
            timeline.state = state;
            cx.notify();
        })
        .is_ok()
    };
    // Subscribed before the first read, so an append between the two arrives as a delta.
    let Ok(mut appended) = core
        .spawn(|domains| async move { domains.sessions.appended() })
        .await
    else {
        set(TimelineState::Missing, cx);
        return;
    };
    let Some(first) = read(&core, &id, EventPosition::Latest).await else {
        set(TimelineState::Missing, cx);
        return;
    };
    let mut cursor = first.next_from;
    if !set(TimelineState::Ready(TimelinePage::opened(first)), cx) {
        return;
    }
    loop {
        match appended.recv().await {
            Ok(event) if event.session != id => continue,
            Ok(_) | Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return,
        }
        // A burst of appends is one delta read.
        while !matches!(
            appended.try_recv(),
            Err(TryRecvError::Empty | TryRecvError::Closed)
        ) {}
        loop {
            let Some(delta) = read(&core, &id, EventPosition::From(cursor)).await else {
                set(TimelineState::Missing, cx);
                return;
            };
            let merged = this.update(cx, |timeline, cx| {
                let TimelineState::Ready(page) = &mut timeline.state else {
                    return None;
                };
                let more = page.merge(delta);
                cx.notify();
                Some((more, page.cursor))
            });
            let Ok(Some((more, next))) = merged else {
                return;
            };
            cursor = next;
            if !more {
                break;
            }
        }
    }
}
