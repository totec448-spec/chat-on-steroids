//! Event pages from the journal and the canonical messages (`readEvents` and
//! `readRecentEventsFromDisk` in `store.ts`), bounded to the page they return.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::Path;

use cos_store::Logger;
use cos_types::ids::SessionId;
use cos_types::session::{SessionEvent, SessionSummary};

use crate::disk;
use crate::summary::message_key;
use crate::timeline::{self, kind_of, position_of};

/// The largest page a recent-history read returns.
const MAX_EVENT_TAIL: usize = 4096;

pub(crate) enum Window {
    /// `from`: every event whose seq is at least this, oldest first.
    From(u64),
    /// The newest events, optionally only those placed before `before`.
    Latest { before: Option<u64> },
    /// The oldest events placed after this position.
    After(u64),
}

fn kept(event: &SessionEvent, kinds: Option<&[String]>) -> bool {
    kinds.is_none_or(|kinds| kinds.iter().any(|kind| kind == kind_of(event)))
}

/// One page in reading order, plus how many lines could not be read.
pub(crate) fn page(
    dir: &Path,
    id: &SessionId,
    summary: Option<&SessionSummary>,
    window: Window,
    limit: usize,
    kinds: Option<&[String]>,
    logger: &Logger,
) -> io::Result<Vec<SessionEvent>> {
    let (messages, _) = disk::read_canonical_messages(dir, id.as_str(), logger);
    let mut damaged = 0u64;
    let selected: Vec<SessionEvent> = match window {
        Window::From(from) => {
            // Smallest seqs win; journal duplicates of a canonical identity are legacy copies.
            let mut best: BTreeMap<(u64, u64), SessionEvent> = BTreeMap::new();
            let mut counter = 0u64;
            let mut admit = |event: SessionEvent, best: &mut BTreeMap<(u64, u64), SessionEvent>| {
                counter += 1;
                best.insert((event.base().seq, counter), event);
                if best.len() > limit {
                    best.pop_last();
                }
            };
            damaged += disk::scan_journal(dir, |line| {
                if disk::blank(line) {
                    return;
                }
                let Some(event) = disk::parse_line(line) else {
                    damaged += 1;
                    return;
                };
                if event.base().seq < from || !kept(&event, kinds) {
                    return;
                }
                if message_key(&event).is_some_and(|key| messages.contains_key(&key)) {
                    return;
                }
                admit(event, &mut best);
            })?;
            for message in messages.values() {
                if message.base().seq >= from && kept(message, kinds) {
                    admit(message.clone(), &mut best);
                }
            }
            best.into_values().collect()
        }
        Window::Latest { before } => {
            let cap = limit.clamp(1, MAX_EVENT_TAIL);
            let accepts = |event: &SessionEvent| {
                before.is_none_or(|before| position_of(event) < before) && kept(event, kinds)
            };
            let newest = newest_revisions(dir, &messages, &accepts)?;
            let mut best: BTreeMap<(u64, u64), SessionEvent> = BTreeMap::new();
            let mut counter = 0u64;
            let mut admit = |event: SessionEvent, best: &mut BTreeMap<(u64, u64), SessionEvent>| {
                counter += 1;
                best.insert((position_of(&event), counter), event);
                if best.len() > cap {
                    best.pop_first();
                }
            };
            damaged += disk::scan_journal(dir, |line| {
                if disk::blank(line) {
                    return;
                }
                let Some(event) = disk::parse_line(line) else {
                    damaged += 1;
                    return;
                };
                if !accepts(&event) || !newest_revision(&newest, &event) {
                    return;
                }
                admit(event, &mut best);
            })?;
            for message in messages.values() {
                if accepts(message) {
                    admit(message.clone(), &mut best);
                }
            }
            best.into_values().collect()
        }
        Window::After(after) => {
            let cap = limit.clamp(1, MAX_EVENT_TAIL);
            let accepts = |event: &SessionEvent| position_of(event) > after && kept(event, kinds);
            let newest = newest_revisions(dir, &messages, &accepts)?;
            let mut best: BTreeMap<(u64, u64), SessionEvent> = BTreeMap::new();
            let mut counter = 0u64;
            let mut admit = |event: SessionEvent, best: &mut BTreeMap<(u64, u64), SessionEvent>| {
                counter += 1;
                best.insert((position_of(&event), counter), event);
                if best.len() > cap {
                    best.pop_last();
                }
            };
            damaged += disk::scan_journal(dir, |line| {
                if disk::blank(line) {
                    return;
                }
                let Some(event) = disk::parse_line(line) else {
                    damaged += 1;
                    return;
                };
                if event.base().seq <= after
                    || !accepts(&event)
                    || !newest_revision(&newest, &event)
                {
                    return;
                }
                admit(event, &mut best);
            })?;
            for message in messages.values() {
                if accepts(message) {
                    admit(message.clone(), &mut best);
                }
            }
            best.into_values().collect()
        }
    };
    if damaged > 0 {
        logger.warn(&format!(
            "session {id}: skipped {damaged} unreadable event line(s)"
        ));
    }
    let canonical: Vec<&SessionEvent> = messages.values().collect();
    Ok(timeline::order(selected, summary, &canonical))
}

/// For every message identity in the journal that passes `accepts`, the seq of its newest line.
/// Canonical identities are excluded outright.
fn newest_revisions(
    dir: &Path,
    messages: &cos_types::json::Record<SessionEvent>,
    accepts: &impl Fn(&SessionEvent) -> bool,
) -> io::Result<HashMap<String, u64>> {
    let mut newest: HashMap<String, u64> = HashMap::new();
    disk::scan_journal(dir, |line| {
        let Some(event) = disk::parse_line(line) else {
            return;
        };
        if !accepts(&event) {
            return;
        }
        let Some(key) = message_key(&event) else {
            return;
        };
        if messages.contains_key(&key) {
            newest.insert(key, u64::MAX);
            return;
        }
        let seq = event.base().seq;
        newest
            .entry(key)
            .and_modify(|held| *held = (*held).max(seq))
            .or_insert(seq);
    })?;
    Ok(newest)
}

fn newest_revision(newest: &HashMap<String, u64>, event: &SessionEvent) -> bool {
    message_key(event).is_none_or(|key| newest.get(&key) == Some(&event.base().seq))
}
