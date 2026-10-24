//! Late request-id proof: calls already filed as Unattributed move to the chat that proved
//! their request id (`repairDeterministicAttribution` in `src/main/session/recorder.ts` and
//! `rewriteUnattributedToolCalls` in `store.ts`).
//!
//! Only the exact request id decides. No tool name, clock or active tab is involved. A moved
//! call keeps its `callId`, so a crash between copying and rewriting the bucket is repaired on
//! the next pass without duplicates. Assets are copied before any history is removed.

use std::collections::HashSet;
use std::io;

use cos_types::ids::SessionId;
use cos_types::json::{Extra, Record};
use cos_types::session::{
    AttributionMethod, CallAttribution, EventBase, EventSource, SessionEvent, SessionStartEvent,
    ToolCallEvent,
};
use cos_types::state::RequestCorrelation;

use crate::{SessionStore, blocking, disk, lock, read, summary};

pub(crate) const UNATTRIBUTED_TITLE: &str = "Unattributed activity";
const MAX_REPAIR_BUCKETS: usize = 128;
const MAX_REPAIR_REQUEST_IDS: usize = 50_000;

/// What one repair pass moved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Repaired {
    /// Unattributed buckets rewritten.
    pub sessions: usize,
    /// Calls appended to their chat.
    pub calls: usize,
}

/// The request ids each bucket held when it was last read. A pass for named ids skips a bucket
/// that has not changed since and holds none of them. Never an ownership verdict.
#[derive(Default)]
pub(crate) struct Buckets {
    /// Oldest first.
    held: Vec<(SessionId, Bucket)>,
}

struct Bucket {
    tool_calls: u64,
    updated_at: u64,
    request_ids: HashSet<String>,
}

impl Buckets {
    fn unchanged_without(
        &self,
        id: &SessionId,
        tool_calls: u64,
        updated_at: u64,
        affected: &HashSet<String>,
    ) -> bool {
        self.held.iter().any(|(held, bucket)| {
            held == id
                && bucket.tool_calls == tool_calls
                && bucket.updated_at == updated_at
                && affected.iter().all(|id| !bucket.request_ids.contains(id))
        })
    }

    fn forget(&mut self, id: &SessionId) {
        self.held.retain(|(held, _)| held != id);
    }

    /// Remembers a bucket, evicting the oldest until both bounds hold.
    fn remember(&mut self, id: SessionId, bucket: Bucket) {
        let mut total: usize = bucket.request_ids.len()
            + self
                .held
                .iter()
                .map(|(_, held)| held.request_ids.len())
                .sum::<usize>();
        while !self.held.is_empty()
            && (self.held.len() >= MAX_REPAIR_BUCKETS || total > MAX_REPAIR_REQUEST_IDS)
        {
            total -= self.held.remove(0).1.request_ids.len();
        }
        self.held.push((id, bucket));
    }
}

/// A call whose request now has a proven owner, and that owner's conversation.
struct Placed {
    event: ToolCallEvent,
    conversation: String,
}

/// What the rewrite left in the bucket.
struct Rewritten {
    retained: usize,
    deleted: bool,
}

fn tool_calls(events: Vec<SessionEvent>) -> Vec<ToolCallEvent> {
    events
        .into_iter()
        .filter_map(|event| match event {
            SessionEvent::ToolCall(call) => Some(*call),
            _ => None,
        })
        .collect()
}

/// Every event in the journal that parses, in file order, as `rewriteUnattributedToolCalls`
/// reads the calls that arrived during a repair.
fn read_journal(dir: &std::path::Path) -> io::Result<Vec<SessionEvent>> {
    let mut events = Vec::new();
    disk::scan_journal(dir, |line| {
        if let Some(event) = disk::parse_line(line) {
            events.push(event);
        }
    })?;
    Ok(events)
}

/// The asset ids a call names, with the type each is written back as.
fn call_assets(event: &ToolCallEvent) -> Vec<(String, String)> {
    let call = &event.call;
    let text = |id: &Option<String>| id.clone().map(|id| (id, "text/plain".to_owned()));
    let mut assets: Vec<(String, String)> = Vec::new();
    let mut add = |asset: Option<(String, String)>| {
        if let Some((id, mime)) = asset {
            match assets.iter_mut().find(|(held, _)| *held == id) {
                Some(held) => held.1 = mime,
                None => assets.push((id, mime)),
            }
        }
    };
    add(text(&call.args.asset_id));
    add(text(&call.result.asset_id));
    for change in call.changes.iter().flatten() {
        add(text(&change.review_asset_id));
    }
    for asset in call.assets.iter().flatten() {
        add(Some((asset.id.clone(), asset.mime_type.clone())));
    }
    assets
}

/// The call as its owner's history records it.
fn attributed(placed: &Placed) -> SessionEvent {
    let source = &placed.event;
    let mut call = source.call.clone();
    call.attribution = CallAttribution::RequestId;
    call.conversation_id = Some(placed.conversation.clone());
    call.attribution_method = AttributionMethod::RequestId;
    SessionEvent::ToolCall(Box::new(ToolCallEvent {
        base: EventBase {
            model: None,
            reasoning_effort: None,
            seq: 0,
            time: source.base.time,
            authored_at: None,
            turn_origin: None,
            source: EventSource::Mcp,
            agent: source.base.agent.clone().filter(|agent| !agent.is_empty()),
            turn_id: source.base.turn_id.clone().filter(|turn| !turn.is_empty()),
        },
        call,
        origin: None,
        extra: Extra::new(),
    }))
}

impl SessionStore {
    /// `readEvents(id, { kinds })`: every event after the pending summary write, in timeline
    /// order and carrying the turn each belongs to, as a reader sees them.
    async fn read_events(
        &self,
        id: &SessionId,
        kind: Option<&str>,
    ) -> Result<Vec<SessionEvent>, String> {
        self.flush_session(id).await;
        let summary = self.get_summary(id).await;
        let dir = self.dir(id);
        let target = id.clone();
        let logger = self.logger().clone();
        let kinds: Option<Vec<String>> = kind.map(|kind| vec![kind.to_owned()]);
        blocking(move || {
            read::page(
                &dir,
                &target,
                summary.as_ref(),
                read::Window::From(0),
                usize::MAX,
                kinds.as_deref(),
                &logger,
            )
        })
        .await
        .and_then(|read| read)
        .map_err(|error| error.to_string())
    }

    /// `repairDeterministicAttribution`: moves every Unattributed call whose request id now has
    /// a proven owner into that owner's session. `affected` names the newly proven ids; a
    /// bucket that holds none of them and has not changed since its last read is skipped.
    /// `None` rereads every bucket.
    pub async fn repair_attribution(
        &self,
        owner_of: &(dyn Fn(&str) -> Option<RequestCorrelation> + Send + Sync),
        affected: Option<&HashSet<String>>,
    ) -> Repaired {
        let mut repaired = Repaired::default();
        let buckets: Vec<_> = self
            .summaries()
            .into_iter()
            .filter(|summary| {
                summary.conversation_id.is_none() && summary.title == UNATTRIBUTED_TITLE
            })
            .collect();
        for bucket in buckets {
            let id = bucket.id.clone();
            if let Some(affected) = affected
                && lock(&self.inner.repair_buckets).unchanged_without(
                    &id,
                    bucket.tool_calls,
                    bucket.updated_at,
                    affected,
                )
            {
                continue;
            }
            match self.repair_bucket(&id, owner_of, &bucket).await {
                Ok(Some(calls)) => {
                    repaired.sessions += 1;
                    repaired.calls += calls;
                }
                Ok(None) => {}
                Err(error) => self.logger().warn(&format!(
                    "could not repair unattributed session {id}: {error}"
                )),
            }
        }
        if repaired.sessions > 0 {
            self.publish_index();
        }
        repaired
    }

    /// One bucket. Answers how many calls were appended, or `None` when nothing moved.
    async fn repair_bucket(
        &self,
        id: &SessionId,
        owner_of: &(dyn Fn(&str) -> Option<RequestCorrelation> + Send + Sync),
        bucket: &cos_types::session::SessionSummary,
    ) -> Result<Option<usize>, String> {
        let events = self.read_events(id, None).await?;
        let scanned_through = events
            .iter()
            .map(|event| event.base().seq)
            .max()
            .unwrap_or(0);
        let foreign = events.iter().any(|event| {
            !matches!(
                event,
                SessionEvent::SessionStart(_) | SessionEvent::ToolCall(_)
            )
        });
        let tools = tool_calls(events);
        let mut request_ids = HashSet::new();
        for event in &tools {
            if let Some(request) = &event.call.request_id {
                request_ids.insert(request.clone());
            }
            if request_ids.len() > MAX_REPAIR_REQUEST_IDS {
                break;
            }
        }
        {
            let mut cache = lock(&self.inner.repair_buckets);
            cache.forget(id);
            if request_ids.len() <= MAX_REPAIR_REQUEST_IDS {
                cache.remember(
                    id.clone(),
                    Bucket {
                        tool_calls: bucket.tool_calls,
                        updated_at: bucket.updated_at,
                        request_ids,
                    },
                );
            }
        }
        if tools.is_empty() || foreign {
            return Ok(None);
        }

        let mut owned: Vec<(String, Vec<Placed>)> = Vec::new();
        let mut unknown: Vec<ToolCallEvent> = Vec::new();
        for mut event in tools {
            // The rows kept are written back as the reader saw them, with the turn each sits in.
            // A bucket has no turns, so that is always none.
            event.base.turn_origin = Some(None);
            // A superseded call is already attributed and deliberately kept out of its chat.
            let superseded = event.call.attribution_method == AttributionMethod::Superseded
                || event.call.attribution == CallAttribution::Superseded;
            let owner = event
                .call
                .request_id
                .as_deref()
                .filter(|_| !superseded)
                .and_then(owner_of);
            let Some(owner) = owner else {
                unknown.push(event);
                continue;
            };
            let placed = Placed {
                event,
                conversation: owner.conversation_id,
            };
            match owned.iter_mut().find(|(held, _)| *held == owner.session_id) {
                Some((_, group)) => group.push(placed),
                None => owned.push((owner.session_id, vec![placed])),
            }
        }
        if owned.is_empty() {
            return Ok(None);
        }
        let moved = owned.iter().map(|(_, group)| group.len()).sum::<usize>();

        // Every destination exists and holds a copy of every file its calls name before
        // anything is appended. A missing source asset leaves the bucket as it is.
        let mut targets: Vec<(SessionId, Vec<Placed>)> = Vec::new();
        for (target, group) in owned {
            let target = SessionId::parse(&target).map_err(|error| error.to_string())?;
            if target == *id || self.get_summary(&target).await.is_none() {
                return Ok(None);
            }
            for (asset, mime_type) in group.iter().flat_map(|placed| call_assets(&placed.event)) {
                let source = self.dir(id);
                let name = asset.clone();
                let data = blocking(move || disk::read_asset(&source, &name))
                    .await
                    .map_err(|error| error.to_string())?;
                let Some(data) = data else {
                    return Ok(None);
                };
                self.write_asset(&target, data, &mime_type).await?;
            }
            targets.push((target, group));
        }

        let mut appended = 0;
        for (target, group) in &targets {
            let mut existing: HashSet<String> =
                tool_calls(self.read_events(target, Some("tool_call")).await?)
                    .into_iter()
                    .map(|event| event.call.call_id)
                    .collect();
            for placed in group {
                if existing.contains(&placed.event.call.call_id) {
                    continue;
                }
                self.append(target, attributed(placed)).await?;
                existing.insert(placed.event.call.call_id.clone());
                appended += 1;
            }
        }

        let current = self.inner.unattributed.lock().await.clone();
        let rewritten = self
            .rewrite_unattributed(id, unknown, scanned_through, current.as_ref() != Some(id))
            .await;
        lock(&self.inner.repair_buckets).forget(id);
        let rewritten = rewritten?;
        if rewritten.retained == 0 {
            let mut shared = lock(&self.inner.shared);
            if shared.active.as_ref() == Some(id) {
                shared.active = targets.first().map(|(target, _)| target.clone());
            }
        }
        if !rewritten.deleted {
            let mut held = self.inner.unattributed.lock().await;
            if held.is_none() {
                *held = Some(id.clone());
            }
        }
        self.logger().info(&format!(
            "repaired {moved} deterministically attributed call(s) from session {id}; {} remain unknown",
            rewritten.retained
        ));
        Ok(Some(appended))
    }

    /// `rewriteUnattributedToolCalls`: keeps only `calls`, plus any call appended after the
    /// repair read the bucket, renumbered after a fresh `session_start`. With `delete_empty`, a
    /// bucket left with no call is removed instead.
    async fn rewrite_unattributed(
        &self,
        id: &SessionId,
        calls: Vec<ToolCallEvent>,
        scanned_through: u64,
        delete_empty: bool,
    ) -> Result<Rewritten, String> {
        let live = self.ensure_open(id).await?;
        let mut writer = live.writer.lock().await;
        if writer.summary.conversation_id.is_some() || writer.summary.title != UNATTRIBUTED_TITLE {
            return Err(format!(
                "Session {id} is not an Unattributed activity bucket"
            ));
        }
        let dir = self.dir(id);
        let concurrent = blocking(move || read_journal(&dir))
            .await
            .and_then(|read| read)
            .map_err(|error| error.to_string())?;
        let mut retained: Vec<ToolCallEvent> = calls;
        retained.extend(
            tool_calls(concurrent)
                .into_iter()
                .filter(|event| event.base.seq > scanned_through),
        );
        retained.sort_by_key(|event| event.base.seq);

        if delete_empty && retained.is_empty() {
            let dir = self.dir(id);
            blocking(move || disk::remove(&dir))
                .await
                .and_then(|removed| removed)
                .map_err(|error| error.to_string())?;
            {
                let mut shared = lock(&self.inner.shared);
                if shared
                    .open
                    .get(id)
                    .is_some_and(|held| std::sync::Arc::ptr_eq(held, &live))
                {
                    shared.open.remove(id);
                }
                shared.catalog.remove(id);
            }
            let mut usage = self.inner.assets.lock().await;
            usage.sessions.remove(id);
            usage.global = None;
            return Ok(Rewritten {
                retained: 0,
                deleted: true,
            });
        }

        let start = SessionEvent::SessionStart(SessionStartEvent {
            base: EventBase {
                model: None,
                reasoning_effort: None,
                seq: 1,
                time: writer.summary.started_at,
                authored_at: None,
                turn_origin: None,
                source: EventSource::App,
                agent: None,
                turn_id: None,
            },
            conversation_id: None,
            title: writer.summary.title.clone(),
            extra: Extra::new(),
        });
        let retained_count = retained.len();
        let mut kept = vec![start];
        for (index, mut event) in retained.into_iter().enumerate() {
            event.base.seq = index as u64 + 2;
            kept.push(SessionEvent::ToolCall(Box::new(event)));
        }
        let dir = self.dir(id);
        let written = kept.clone();
        blocking(move || disk::rewrite_journal(&dir, &written))
            .await
            .and_then(|written| written)
            .map_err(|error| error.to_string())?;

        let mut staged = writer.summary.clone();
        staged.updated_at = staged.started_at;
        staged.events = 0;
        staged.request_turns = Some(Record::new());
        staged.user_messages = 0;
        staged.tool_calls = 0;
        staged.last_tool_call_at = None;
        staged.last_tool_activity = Some(None);
        staged.last_assistant_final_at = Some(None);
        staged.last_turn_end_at = Some(None);
        staged.last_finish_report_at = Some(None);
        staged.process_exit_nonzero = 0;
        staged.tool_rejected = 0;
        staged.tool_internal_errors = 0;
        staged.errors = 0;
        staged.estimated_tokens = 0;
        staged.context_tokens = 0;
        staged.last_handoff_id = None;
        staged.last_handoff_at = None;
        staged.last_committed_resume_handoff_id = Some(None);
        staged.last_turn_outcome = None;
        staged.agents = Vec::new();
        for event in &kept {
            summary::apply(&mut staged, event);
        }
        let history_seq = kept.len() as u64;
        let dir = self.dir(id);
        let meta = staged.clone();
        blocking(move || disk::write_summary(&dir, &meta, history_seq))
            .await
            .and_then(|written| written)
            .map_err(|error| error.to_string())?;
        writer.summary = staged;
        writer.next_seq = history_seq + 1;
        writer.history_seq = history_seq;
        writer.meta_dirty = false;
        *lock(&live.published) = writer.summary.clone();
        lock(&self.inner.shared)
            .catalog
            .insert(id.clone(), writer.summary.clone());
        Ok(Rewritten {
            retained: retained_count,
            deleted: false,
        })
    }
}
