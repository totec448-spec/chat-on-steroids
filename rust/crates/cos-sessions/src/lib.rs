//! Session history under `<userData>/sessions/`: the store, its read model, tool-call recording
//! and the `update_plan` tool. Unit C1.8 owns this crate (port of `src/main/session/store.ts`,
//! `read-model.ts`, `request-plans.ts`, the tool-call half of `recorder.ts`, and
//! `src/main/mcp/plan-tool.ts`).
//!
//! Sessions are independent, so writes serialize per session, never through one global queue.
//! Readers never take a write lock: the list is a published [`SessionIndex`] snapshot, and the
//! event stream learns of new events from [`SessionStore::appended`].

mod access;
mod attribution;
mod chats;
mod conversation;
mod disk;
mod handoffs;
mod js;
mod native_image;
mod plan;
mod project;
mod read;
mod recorder;
mod redact;
mod reserved;
mod summarize;
mod summary;
mod timeline;
mod title;

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use cos_store::{AppPaths, Logger};
use cos_tools::{
    ArgIssue, BoxFuture, CallContext, CallRecord, CallRecorder, DynTool, EpochMs, Feature, Listing,
    Requirement, Tool, ToolError, ToolOutput, ToolSpec,
};
use cos_types::config::Config;
use cos_types::control_api::{
    ControlApiEvents, ControlApiListedSession, ControlApiSessionDetail, ControlApiSessionList,
};
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{
    AgentPlan, AgentPlanUpdate, AssetRef, EventBase, EventSource, SessionEvent, SessionOriginKind,
    SessionStartEvent, SessionSummary,
};
use tokio::sync::{Notify, broadcast, watch};

pub use access::{ChatAccess, STRICT_CHAT_REFUSAL};
pub use attribution::Repaired;
pub use chats::{BLOCKED_CHAT_REFUSAL, BlockedChatsLedger, ChatListError, TrustedChatsLedger};
pub use conversation::{UpsertOptions, Upserted};
pub use native_image::NativeImageUpserted;
pub use plan::PlanAttach;
pub use redact::user_prompt_text;

/// Every session, newest first, as the sidebar and `/v1/sessions` list them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionIndex {
    pub sessions: Vec<SessionSummary>,
}

/// One event appended to a session's `events.jsonl`, by its sequence number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Appended {
    pub session: SessionId,
    pub seq: u64,
}

/// What restore found. A session that could not be read is skipped and named, never fatal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RestoreReport {
    pub sessions: usize,
    pub skipped: Vec<String>,
}

/// An opaque `/v1/sessions` page cursor, as this store issued it: `<updatedAt>.<id>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cursor {
    updated_at: u64,
    id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvalidCursor;

impl Cursor {
    pub fn parse(text: &str) -> Result<Self, InvalidCursor> {
        let (updated_at, id) = text.split_once('.').ok_or(InvalidCursor)?;
        let digits = (1..=16).contains(&updated_at.len())
            && updated_at.bytes().all(|byte| byte.is_ascii_digit());
        let id_ok = (8..=64).contains(&id.len())
            && id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        let updated_at: u64 = updated_at.parse().map_err(|_| InvalidCursor)?;
        if !digits || !id_ok || updated_at > 9_007_199_254_740_991 {
            return Err(InvalidCursor);
        }
        Ok(Self {
            updated_at,
            id: id.to_owned(),
        })
    }

    fn of(summary: &SessionSummary) -> Self {
        Self {
            updated_at: summary.updated_at,
            id: summary.id.as_str().to_owned(),
        }
    }

    fn text(&self) -> String {
        format!("{}.{}", self.updated_at, self.id)
    }

    /// `comesAfterCursor`.
    fn before(&self, summary: &SessionSummary) -> bool {
        summary.updated_at < self.updated_at
            || (summary.updated_at == self.updated_at && summary.id.as_str() < self.id.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListQuery {
    pub limit: u32,
    pub cursor: Option<Cursor>,
    /// `live=1`: include the live turn and job state.
    pub live: bool,
}

/// `/v1/sessions/{id}/events` paging. At most one of `from`, `before` and `after`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventQuery {
    pub position: EventPosition,
    pub limit: u32,
    /// Event kinds to keep; `None` keeps every kind.
    pub kinds: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventPosition {
    Latest,
    From(u64),
    Before(u64),
    After(u64),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventsError {
    NotFound,
    UnknownKind(String),
}

/// How many sessions one list page may hold.
const MAX_LISTED_SESSIONS: usize = 200;
/// The summary is rewritten on this delay rather than on every event.
const META_DELAY: Duration = Duration::from_millis(1500);
/// `DEFAULT_SESSIONS` thresholds, used until a config snapshot is attached.
const DEFAULT_ADVISORY_TOKENS: u64 = 400_000;
const DEFAULT_LIMIT_TOKENS: u64 = 533_333;
const EVENT_KINDS: [&str; 13] = [
    "session_start",
    "user_message",
    "assistant_message",
    "native_image",
    "progress",
    "page_tool",
    "turn_start",
    "turn_end",
    "chat_error",
    "tool_call",
    "note",
    "agent_message",
    "handoff",
];

pub(crate) const GLOBAL_ASSET_QUOTA_EXCEEDED: &str = "Global session asset quota exceeded";
pub(crate) const SESSION_ASSET_QUOTA_EXCEEDED: &str = "Session asset quota exceeded";

/// The session store. Clones share one store.
#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Inner>,
}

struct Inner {
    root: PathBuf,
    logger: Logger,
    index: watch::Sender<Arc<SessionIndex>>,
    appended: broadcast::Sender<Appended>,
    shared: Mutex<Shared>,
    /// Reconstructing a session from disk happens once; concurrent openers wait here.
    opening: tokio::sync::Mutex<()>,
    /// This process's Unattributed session, created on the first call that needs it.
    unattributed: tokio::sync::Mutex<Option<SessionId>>,
    request_plans: tokio::sync::Mutex<plan::RequestPlansLedger>,
    /// What each Unattributed bucket held when the last repair read it.
    repair_buckets: Mutex<attribution::Buckets>,
    assets: tokio::sync::Mutex<AssetUsage>,
    config: Mutex<Option<watch::Receiver<Arc<Config>>>>,
    recording: AtomicUsize,
    recorded: Notify,
}

#[derive(Default)]
struct Shared {
    /// Durable summaries of every session restore found or this process closed.
    catalog: HashMap<SessionId, SessionSummary>,
    /// Sessions written in this process; their summaries are authoritative over the catalog.
    open: HashMap<SessionId, Arc<Live>>,
    /// The session written to most recently (`activeSessionId`).
    active: Option<SessionId>,
}

#[derive(Default)]
struct AssetUsage {
    sessions: HashMap<SessionId, u64>,
    global: Option<u64>,
}

/// One open session: its single writer, and the summary readers see between writes.
struct Live {
    writer: tokio::sync::Mutex<Writer>,
    published: Mutex<SessionSummary>,
}

struct Writer {
    summary: SessionSummary,
    /// Canonical messages by identity (`entry.messages`), read from disk on first need.
    messages: Option<cos_types::json::Record<SessionEvent>>,
    next_seq: u64,
    history_seq: u64,
    meta_dirty: bool,
    meta_scheduled: bool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Runs file work on the blocking pool.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> io::Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| io::Error::other(format!("session file work stopped: {error}")))
}

fn valid_session_name(name: &str) -> Option<SessionId> {
    SessionId::parse(name).ok()
}

fn helper(summary: &SessionSummary) -> bool {
    summary
        .origin
        .as_ref()
        .is_some_and(|origin| origin.kind == SessionOriginKind::Helper)
}

impl SessionStore {
    /// A store over `<userData>/sessions/`. Reads nothing yet: [`Self::restore`] does.
    pub fn open(paths: &AppPaths, logger: Logger) -> Self {
        let (index, _) = watch::channel(Arc::new(SessionIndex::default()));
        let (appended, _) = broadcast::channel(1024);
        let request_plans = plan::RequestPlansLedger::new(&paths.state(), &logger);
        Self {
            inner: Arc::new(Inner {
                root: paths.user_data().join("sessions"),
                logger,
                index,
                appended,
                shared: Mutex::new(Shared::default()),
                opening: tokio::sync::Mutex::new(()),
                unattributed: tokio::sync::Mutex::new(None),
                request_plans: tokio::sync::Mutex::new(request_plans),
                repair_buckets: Mutex::new(attribution::Buckets::default()),
                assets: tokio::sync::Mutex::new(AssetUsage::default()),
                config: Mutex::new(None),
                recording: AtomicUsize::new(0),
                recorded: Notify::new(),
            }),
        }
    }

    /// Follows the published settings for the context pressure thresholds. Until this is called
    /// the list grades pressure against the default thresholds.
    pub fn watch_config(&self, config: watch::Receiver<Arc<Config>>) {
        *lock(&self.inner.config) = Some(config);
    }

    pub(crate) fn logger(&self) -> &Logger {
        &self.inner.logger
    }

    fn dir(&self, id: &SessionId) -> PathBuf {
        disk::dir(&self.inner.root, id)
    }

    /// Reads every session's metadata and publishes the index. Runs behind the startup fence.
    pub async fn restore(&self) -> RestoreReport {
        let root = self.inner.root.clone();
        let logger = self.inner.logger.clone();
        let names = match std::fs::read_dir(&root) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .filter_map(|entry| valid_session_name(&entry.file_name().to_string_lossy()))
                .collect::<Vec<_>>(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                logger.warn(&format!(
                    "session catalog: the sessions folder could not be read: {error}"
                ));
                return RestoreReport::default();
            }
        };
        let workers = 8.min(names.len().max(1));
        let mut chunks: Vec<Vec<SessionId>> = vec![Vec::new(); workers];
        for (index, name) in names.into_iter().enumerate() {
            chunks[index % workers].push(name);
        }
        let mut tasks = Vec::new();
        for chunk in chunks {
            let root = root.clone();
            let logger = logger.clone();
            tasks.push(tokio::task::spawn_blocking(move || {
                chunk
                    .into_iter()
                    .map(|id| {
                        let found =
                            disk::read_catalog_summary(&disk::dir(&root, &id), &id, &logger);
                        (id, found)
                    })
                    .collect::<Vec<_>>()
            }));
        }
        let mut report = RestoreReport::default();
        let mut found = Vec::new();
        for task in tasks {
            match task.await {
                Ok(rows) => found.extend(rows),
                Err(error) => logger.warn(&format!(
                    "session catalog: a restore worker stopped: {error}"
                )),
            }
        }
        {
            let mut shared = lock(&self.inner.shared);
            for (id, row) in found {
                match row {
                    Ok(Some(summary)) => {
                        report.sessions += 1;
                        if !shared.open.contains_key(&id) {
                            shared.catalog.insert(id, summary);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        logger.warn(&format!(
                            "session catalog: {id} could not be read this pass: {error}"
                        ));
                        report.skipped.push(id.as_str().to_owned());
                    }
                }
            }
        }
        report.skipped.sort();
        self.publish_index();
        report
    }

    pub fn index(&self) -> watch::Receiver<Arc<SessionIndex>> {
        self.inner.index.subscribe()
    }

    pub fn appended(&self) -> broadcast::Receiver<Appended> {
        self.inner.appended.subscribe()
    }

    /// Every summary this process knows, live ones over durable ones.
    fn summaries(&self) -> Vec<SessionSummary> {
        let shared = lock(&self.inner.shared);
        let mut rows: Vec<SessionSummary> = shared
            .catalog
            .iter()
            .filter(|(id, _)| !shared.open.contains_key(*id))
            .map(|(_, summary)| summary.clone())
            .collect();
        rows.extend(
            shared
                .open
                .values()
                .map(|live| lock(&live.published).clone()),
        );
        rows
    }

    fn publish_index(&self) {
        let mut sessions: Vec<SessionSummary> = self
            .summaries()
            .into_iter()
            .filter(|summary| !helper(summary))
            .collect();
        sessions.sort_by(summary::newest_first);
        self.inner
            .index
            .send_replace(Arc::new(SessionIndex { sessions }));
    }

    fn thresholds(&self) -> (u64, u64) {
        lock(&self.inner.config)
            .as_ref()
            .map(|config| {
                let config = config.borrow();
                (
                    config.sessions.advisory_tokens,
                    config.sessions.limit_tokens,
                )
            })
            .unwrap_or((DEFAULT_ADVISORY_TOKENS, DEFAULT_LIMIT_TOKENS))
    }

    pub async fn list(&self, query: ListQuery) -> ControlApiSessionList {
        let limit = (query.limit as usize).clamp(1, MAX_LISTED_SESSIONS);
        let all: Vec<SessionSummary> = self
            .summaries()
            .into_iter()
            .filter(|summary| !helper(summary))
            .collect();
        let total = all.len() as u64;
        let mut candidates: Vec<SessionSummary> = all
            .into_iter()
            .filter(|summary| {
                query
                    .cursor
                    .as_ref()
                    .is_none_or(|cursor| cursor.before(summary))
            })
            .collect();
        candidates.sort_by(summary::newest_first);
        let has_more = candidates.len() > limit;
        candidates.truncate(limit);
        let next_cursor = if has_more {
            candidates.last().map(|last| Cursor::of(last).text())
        } else {
            None
        };
        let (advisory, limit_tokens) = self.thresholds();
        let active_id = lock(&self.inner.shared)
            .active
            .as_ref()
            .map(|id| id.as_str().to_owned());
        ControlApiSessionList {
            sessions: candidates
                .iter()
                .map(|summary| ControlApiListedSession {
                    session: project::session(summary),
                    pressure: project::pressure(summary.context_tokens, advisory, limit_tokens),
                })
                .collect(),
            total,
            next_cursor,
            active_id,
        }
    }

    /// `getSession`: the live summary, else the durable one, repaired if it lagged its history.
    pub(crate) async fn get_summary(&self, id: &SessionId) -> Option<SessionSummary> {
        let live = lock(&self.inner.shared).open.get(id).cloned();
        if let Some(live) = live {
            return Some(lock(&live.published).clone());
        }
        let dir = self.dir(id);
        let target = id.clone();
        let logger = self.inner.logger.clone();
        match blocking(move || disk::read_snapshot(&dir, &target, &logger)).await {
            Ok(Ok(Some(snapshot))) => {
                let summary = snapshot.summary;
                if snapshot.reconciled {
                    lock(&self.inner.shared)
                        .catalog
                        .insert(id.clone(), summary.clone());
                }
                Some(summary)
            }
            Ok(Ok(None)) => None,
            Ok(Err(error)) | Err(error) => {
                self.inner
                    .logger
                    .warn(&format!("session {id}: could not be read: {error}"));
                None
            }
        }
    }

    pub async fn detail(&self, id: &SessionId) -> Option<ControlApiSessionDetail> {
        let summary = self.get_summary(id).await?;
        Some(ControlApiSessionDetail {
            session: project::session(&summary),
            live: None,
        })
    }

    pub async fn events(
        &self,
        id: &SessionId,
        query: EventQuery,
    ) -> Result<ControlApiEvents, EventsError> {
        if let Some(unknown) = query
            .kinds
            .iter()
            .flatten()
            .find(|kind| !EVENT_KINDS.contains(&kind.as_str()))
        {
            return Err(EventsError::UnknownKind(unknown.clone()));
        }
        let summary = self.get_summary(id).await.ok_or(EventsError::NotFound)?;
        self.flush_session(id).await;
        let (window, start) = match query.position {
            EventPosition::From(from) => (read::Window::From(from), from),
            EventPosition::Latest => (read::Window::Latest { before: None }, 0),
            EventPosition::Before(before) => (
                read::Window::Latest {
                    before: Some(before),
                },
                0,
            ),
            EventPosition::After(after) => (read::Window::After(after), 0),
        };
        let dir = self.dir(id);
        let target = id.clone();
        let logger = self.inner.logger.clone();
        let limit = query.limit as usize;
        let kinds = query.kinds;
        let timeline = summary.clone();
        let read = blocking(move || {
            read::page(
                &dir,
                &target,
                Some(&timeline),
                window,
                limit,
                kinds.as_deref(),
                &logger,
            )
        })
        .await;
        let events = match read {
            Ok(Ok(events)) => events,
            Ok(Err(error)) | Err(error) => {
                self.inner
                    .logger
                    .warn(&format!("session {id}: events could not be read: {error}"));
                Vec::new()
            }
        };
        let next_from = events
            .iter()
            .map(|event| event.base().seq + 1)
            .fold(start, u64::max);
        Ok(ControlApiEvents {
            events: events.iter().map(project::event).collect(),
            total: summary.events,
            next_from,
        })
    }

    /// The kernel's recorder: files each finished call, into Unattributed when no chat owns it.
    pub fn recorder(&self) -> Arc<dyn CallRecorder> {
        Arc::new(Recorder {
            store: self.clone(),
        })
    }

    pub fn plan_tool(&self) -> Arc<dyn DynTool> {
        Arc::new(UpdatePlan {
            store: self.clone(),
        })
    }

    /// Shutdown phase 3: recorder work still queued, which can enqueue session writes.
    pub async fn flush_recorder(&self) {
        loop {
            let notified = self.inner.recorded.notified();
            if self.inner.recording.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }

    /// Shutdown phase 4: every pending session file write.
    pub async fn flush(&self) {
        let open: Vec<(SessionId, Arc<Live>)> = lock(&self.inner.shared)
            .open
            .iter()
            .map(|(id, live)| (id.clone(), live.clone()))
            .collect();
        for (id, live) in open {
            let mut writer = live.writer.lock().await;
            self.write_meta(&id, &live, &mut writer).await;
        }
        self.publish_index();
    }

    async fn flush_session(&self, id: &SessionId) {
        let live = lock(&self.inner.shared).open.get(id).cloned();
        if let Some(live) = live {
            let mut writer = live.writer.lock().await;
            self.write_meta(id, &live, &mut writer).await;
        }
    }

    /// Writes the summary when it changed since the last write.
    async fn write_meta(&self, id: &SessionId, live: &Live, writer: &mut Writer) {
        if !writer.meta_dirty {
            return;
        }
        let dir = self.dir(id);
        let summary = writer.summary.clone();
        let history_seq = writer.history_seq;
        match blocking(move || disk::write_summary(&dir, &summary, history_seq)).await {
            Ok(Ok(())) => {
                writer.meta_dirty = false;
                *lock(&live.published) = writer.summary.clone();
                lock(&self.inner.shared)
                    .catalog
                    .insert(id.clone(), writer.summary.clone());
            }
            Ok(Err(error)) | Err(error) => self
                .inner
                .logger
                .error(&format!("session meta write failed: {error}")),
        }
    }

    fn schedule_meta(&self, id: &SessionId, live: &Arc<Live>, writer: &mut Writer) {
        writer.meta_dirty = true;
        if writer.meta_scheduled {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        writer.meta_scheduled = true;
        let store = self.clone();
        let id = id.clone();
        let live = live.clone();
        runtime.spawn(async move {
            tokio::time::sleep(META_DELAY).await;
            let mut writer = live.writer.lock().await;
            writer.meta_scheduled = false;
            store.write_meta(&id, &live, &mut writer).await;
            drop(writer);
            store.publish_index();
        });
    }

    /// `ensureOpen`: the live session, reconstructed from disk on first use.
    async fn ensure_open(&self, id: &SessionId) -> Result<Arc<Live>, String> {
        if let Some(live) = lock(&self.inner.shared).open.get(id).cloned() {
            return Ok(live);
        }
        let _opening = self.inner.opening.lock().await;
        if let Some(live) = lock(&self.inner.shared).open.get(id).cloned() {
            return Ok(live);
        }
        let dir = self.dir(id);
        let target = id.clone();
        let logger = self.inner.logger.clone();
        let snapshot = blocking(move || {
            disk::seal_torn_tail(&dir, target.as_str(), &logger);
            disk::read_snapshot(&dir, &target, &logger)
        })
        .await
        .and_then(|read| read)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Session {id} has no recoverable metadata or history"))?;
        let live = Arc::new(Live {
            published: Mutex::new(snapshot.summary.clone()),
            writer: tokio::sync::Mutex::new(Writer {
                summary: snapshot.summary,
                messages: None,
                next_seq: snapshot.history_seq + 1,
                history_seq: snapshot.history_seq,
                meta_dirty: false,
                meta_scheduled: false,
            }),
        });
        lock(&self.inner.shared)
            .open
            .insert(id.clone(), live.clone());
        Ok(live)
    }

    /// `appendEvent`: assigns the next seq, appends the line, then moves the summary. Nothing
    /// advances in memory until the line is on disk.
    pub(crate) async fn append(
        &self,
        id: &SessionId,
        mut event: SessionEvent,
    ) -> Result<u64, String> {
        let live = self.ensure_open(id).await?;
        let mut writer = live.writer.lock().await;
        let seq = writer.next_seq;
        set_seq(&mut event, seq);
        let dir = self.dir(id);
        let logger = self.inner.logger.clone();
        let (written, event) = blocking(move || {
            let written = disk::append(&dir, &event, &logger);
            (written, event)
        })
        .await
        .map_err(|error| error.to_string())?;
        if let Err(error) = written {
            self.inner
                .logger
                .error(&format!("session append failed: {error}"));
            return Err(error.to_string());
        }
        writer.next_seq += 1;
        summary::apply(&mut writer.summary, &event);
        writer.history_seq = seq;
        *lock(&live.published) = writer.summary.clone();
        self.schedule_meta(id, &live, &mut writer);
        drop(writer);
        lock(&self.inner.shared).active = Some(id.clone());
        let _ = self.inner.appended.send(Appended {
            session: id.clone(),
            seq,
        });
        Ok(seq)
    }

    /// `createSession` for this process's Unattributed stream, then its `session_start`.
    pub(crate) async fn unattributed_session(&self) -> Result<SessionId, String> {
        let mut held = self.inner.unattributed.lock().await;
        if let Some(id) = held.as_ref() {
            return Ok(id.clone());
        }
        let now = EpochMs::now().0;
        let uuid = js::random_uuid();
        let id = SessionId::parse(format!("{}-{}", js::iso_day(now), &uuid[..8]))
            .map_err(|error| error.to_string())?;
        let title = attribution::UNATTRIBUTED_TITLE;
        let summary = summary::empty(id.clone(), title, None, now);
        let dir = self.dir(&id);
        let created = summary.clone();
        blocking(move || disk::create(&dir, &created))
            .await
            .and_then(|written| written)
            .map_err(|error| error.to_string())?;
        let live = Arc::new(Live {
            published: Mutex::new(summary.clone()),
            writer: tokio::sync::Mutex::new(Writer {
                summary: summary.clone(),
                messages: Some(cos_types::json::Record::new()),
                next_seq: 1,
                history_seq: 0,
                meta_dirty: false,
                meta_scheduled: false,
            }),
        });
        {
            let mut shared = lock(&self.inner.shared);
            shared.open.insert(id.clone(), live);
            shared.catalog.insert(id.clone(), summary);
        }
        self.publish_index();
        let start = SessionEvent::SessionStart(SessionStartEvent {
            base: EventBase {
                model: None,
                reasoning_effort: None,
                seq: 0,
                time: EpochMs::now().0,
                authored_at: None,
                turn_origin: None,
                source: EventSource::App,
                agent: None,
                turn_id: None,
            },
            conversation_id: None,
            title: title.to_owned(),
            extra: Extra::new(),
        });
        self.append(&id, start).await?;
        *held = Some(id.clone());
        Ok(id)
    }

    /// `writeAsset`: content addressed, inside the per-session and global quotas.
    pub async fn write_asset(
        &self,
        id: &SessionId,
        data: Vec<u8>,
        mime_type: &str,
    ) -> Result<AssetRef, String> {
        if data.is_empty() || data.len() > disk::MAX_ASSET_BYTES {
            return Err("Session asset exceeds the per-asset limit".into());
        }
        let asset = disk::asset_id(&data, mime_type);
        let mut usage = self.inner.assets.lock().await;
        let dir = self.dir(id);
        let root = self.inner.root.clone();
        let bytes = data.len() as u64;
        let known_session = usage.sessions.get(id).copied();
        let known_global = usage.global;
        let name = asset.clone();
        let outcome = blocking(move || -> io::Result<Result<(bool, u64, u64), String>> {
            if dir.join("assets").join(&name).exists() {
                return Ok(Ok((
                    false,
                    known_session.unwrap_or(0),
                    known_global.unwrap_or(0),
                )));
            }
            let used = match known_session {
                Some(used) => used,
                None => disk::folder_bytes(&dir.join("assets"))?,
            };
            let global = match known_global {
                Some(global) => global,
                None => global_asset_bytes(&root)?,
            };
            if used + bytes > disk::MAX_SESSION_ASSET_BYTES {
                return Ok(Err(SESSION_ASSET_QUOTA_EXCEEDED.into()));
            }
            if global + bytes > disk::MAX_GLOBAL_ASSET_BYTES {
                return Ok(Err(GLOBAL_ASSET_QUOTA_EXCEEDED.into()));
            }
            let written = disk::write_asset_file(&dir, &name, &data)?;
            Ok(Ok((written, used, global)))
        })
        .await
        .and_then(|result| result)
        .map_err(|error| error.to_string())??;
        let (written, used, global) = outcome;
        if written {
            usage.sessions.insert(id.clone(), used + bytes);
            usage.global = Some(global + bytes);
        }
        Ok(disk::asset_ref(asset, mime_type, bytes as usize))
    }

    /// `updateSessionPlan`: replaces the chat's plan unless the call is older than it. A plan
    /// held for a request (`recovered`: when it was stored) may still land after its chat was
    /// replaced, if it was accepted before that chat retired.
    pub(crate) async fn update_session_plan(
        &self,
        id: &SessionId,
        conversation: &str,
        update: AgentPlanUpdate,
        started_at: u64,
        recovered: Option<u64>,
    ) -> Result<bool, String> {
        let plan = AgentPlan {
            explanation: update.explanation,
            plan: update.plan,
            updated_at: cos_types::json::JsNumber(started_at as f64),
        };
        let bytes = serde_json::to_vec(&plan).map_err(|error| error.to_string())?;
        if bytes.len() > disk::MAX_AGENT_PLAN_BYTES {
            return Err("Plan exceeds its storage budget".into());
        }
        let live = self.ensure_open(id).await?;
        let writer = live.writer.lock().await;
        let summary = &writer.summary;
        if summary.conversation_id.as_deref() != Some(conversation) {
            let retired_at = summary
                .retired_chat_at
                .as_ref()
                .and_then(|retired| retired.get(conversation));
            let before_retirement = matches!((recovered, retired_at), (Some(stored_at), Some(retired_at))
                if started_at.max(stored_at) < *retired_at);
            if !before_retirement
                || summary.conversation_id.is_none()
                || !summary.chat_ids.iter().any(|chat| chat == conversation)
            {
                return Ok(false);
            }
        }
        let dir = self.dir(id);
        let accepted = blocking(move || -> io::Result<bool> {
            if let Some(previous) = disk::read_plan(&dir)?
                && previous.updated_at.0 > started_at as f64
            {
                return Ok(false);
            }
            disk::write_plan(&dir, &bytes)?;
            Ok(true)
        })
        .await
        .and_then(|result| result)
        .map_err(|error| error.to_string())?;
        drop(writer);
        Ok(accepted)
    }

    /// `updateRequestPlan`: holds the newest plan of a request whose chat is not proven yet.
    /// Answers `false` when a newer call already holds one.
    pub async fn update_request_plan(
        &self,
        request_id: &str,
        update: AgentPlanUpdate,
        started_at: u64,
    ) -> Result<bool, String> {
        let mut ledger = self.inner.request_plans.lock().await;
        ledger.update(request_id, update, started_at, EpochMs::now().0)
    }
}

fn global_asset_bytes(root: &std::path::Path) -> io::Result<u64> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut total = 0;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if valid_session_name(&name).is_some() && entry.path().is_dir() {
            total += disk::folder_bytes(&entry.path().join("assets"))?;
        }
    }
    Ok(total)
}

fn set_seq(event: &mut SessionEvent, seq: u64) {
    let base = match event {
        SessionEvent::SessionStart(event) => &mut event.base,
        SessionEvent::UserMessage(event) => &mut event.base,
        SessionEvent::AssistantMessage(event) => &mut event.base,
        SessionEvent::NativeImage(event) => &mut event.base,
        SessionEvent::Progress(event) => &mut event.base,
        SessionEvent::PageTool(event) => &mut event.base,
        SessionEvent::TurnStart(event) => &mut event.base,
        SessionEvent::TurnEnd(event) => &mut event.base,
        SessionEvent::ChatError(event) => &mut event.base,
        SessionEvent::ToolCall(event) => &mut event.base,
        SessionEvent::Note(event) => &mut event.base,
        SessionEvent::AgentMessage(event) => &mut event.base,
        SessionEvent::Handoff(event) => &mut event.base,
    };
    base.seq = seq;
}

struct Recorder {
    store: SessionStore,
}

impl CallRecorder for Recorder {
    fn record<'a>(&'a self, call: CallRecord<'a>) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let inner = &self.store.inner;
            inner.recording.fetch_add(1, Ordering::AcqRel);
            recorder::record(&self.store, call).await;
            if inner.recording.fetch_sub(1, Ordering::AcqRel) == 1 {
                inner.recorded.notify_waiters();
            }
        })
    }
}

pub struct UpdatePlan {
    store: SessionStore,
}

impl Tool for UpdatePlan {
    type Args = AgentPlanUpdate;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "update_plan",
        listing: Listing::Feature(Feature::SessionRecording),
        requires: Requirement::Feature(Feature::SessionRecording),
    };

    fn refine(args: &AgentPlanUpdate) -> Result<(), Vec<ArgIssue>> {
        plan::refine(args)
    }

    async fn call(&self, cx: &CallContext, args: AgentPlanUpdate) -> Result<ToolOutput, ToolError> {
        plan::call(&self.store, cx, args).await
    }
}
