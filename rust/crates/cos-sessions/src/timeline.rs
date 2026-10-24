//! The order a recorded turn is read in (`src/shared/chronology.ts`).
//!
//! `seq` is the append order and the cursor. Reading reorders only inside a turn the log
//! opened; nothing outside a turn moves.

use std::collections::HashMap;

use cos_types::json::{Extra, Record, True};
use cos_types::session::{
    EventSource, NativeQuestion, RequestTurn, SessionEvent, SessionSummary, TimelineTurn,
};

/// The fields of an event the ordering reads.
struct Facts<'a> {
    seq: u64,
    origin: Option<u64>,
    time: u64,
    authored_at: Option<f64>,
    message_id: Option<&'a str>,
    input_id: Option<&'a str>,
    kind: &'static str,
    source: EventSource,
    agent: Option<&'a str>,
    turn_id: Option<&'a str>,
    call: Option<(Option<&'a str>, Option<&'a str>, &'static str)>,
    is_final: bool,
    continued: bool,
}

pub(crate) fn kind_of(event: &SessionEvent) -> &'static str {
    match event {
        SessionEvent::SessionStart(_) => "session_start",
        SessionEvent::UserMessage(_) => "user_message",
        SessionEvent::AssistantMessage(_) => "assistant_message",
        SessionEvent::NativeImage(_) => "native_image",
        SessionEvent::Progress(_) => "progress",
        SessionEvent::PageTool(_) => "page_tool",
        SessionEvent::TurnStart(_) => "turn_start",
        SessionEvent::TurnEnd(_) => "turn_end",
        SessionEvent::ChatError(_) => "chat_error",
        SessionEvent::ToolCall(_) => "tool_call",
        SessionEvent::Note(_) => "note",
        SessionEvent::AgentMessage(_) => "agent_message",
        SessionEvent::Handoff(_) => "handoff",
    }
}

/// The canonical `origin` of the kinds that carry one.
pub(crate) fn origin_of(event: &SessionEvent) -> Option<u64> {
    match event {
        SessionEvent::UserMessage(event) => event.origin,
        SessionEvent::AssistantMessage(event) => event.origin,
        SessionEvent::NativeImage(event) => event.origin,
        SessionEvent::Progress(event) => event.origin,
        SessionEvent::PageTool(event) => event.origin,
        SessionEvent::ToolCall(event) => event.origin,
        _ => None,
    }
}

/// `positionOf`: first appearance for a revised item, otherwise `seq`.
pub(crate) fn position_of(event: &SessionEvent) -> u64 {
    origin_of(event).unwrap_or(event.base().seq)
}

fn facts(event: &SessionEvent) -> Facts<'_> {
    let base = event.base();
    let (message_id, input_id) = match event {
        SessionEvent::UserMessage(event) => {
            (event.message_id.as_deref(), event.input_id.as_deref())
        }
        SessionEvent::AssistantMessage(event) => (event.message_id.as_deref(), None),
        SessionEvent::NativeImage(event) => (Some(event.message_id.as_str()), None),
        SessionEvent::PageTool(event) => (Some(event.message_id.as_str()), None),
        SessionEvent::AgentMessage(event) => (Some(event.message_id.as_str()), None),
        _ => (None, None),
    };
    let call = match event {
        SessionEvent::ToolCall(event) => Some((
            event.call.request_id.as_deref(),
            event.call.conversation_id.as_deref(),
            event.call.attribution.as_str(),
        )),
        _ => None,
    };
    let is_final = match event {
        SessionEvent::AssistantMessage(event) => {
            event.is_final || event.state == Some(cos_types::session::MessageState::Final)
        }
        _ => false,
    };
    let continued = matches!(event, SessionEvent::TurnEnd(end) if end.continued.is_some());
    Facts {
        seq: base.seq,
        origin: origin_of(event),
        time: base.time,
        authored_at: base.authored_at.map(|at| at.0),
        message_id,
        input_id,
        kind: kind_of(event),
        source: base.source,
        agent: base.agent.as_deref(),
        turn_id: base.turn_id.as_deref(),
        call,
        is_final,
        continued,
    }
}

fn position(facts: &Facts<'_>) -> u64 {
    facts.origin.unwrap_or(facts.seq)
}

fn injected_user_message(facts: &Facts<'_>, turns: Option<&Record<TimelineTurn>>) -> bool {
    facts.kind == "user_message"
        && facts.input_id.is_some_and(|id| !id.is_empty())
        && (facts.message_id.is_some_and(|id| id.starts_with("input:"))
            || facts.turn_id.is_some_and(|turn| {
                !turn.is_empty() && turns.is_some_and(|turns| turns.contains_key(turn))
            }))
}

/// `responseTurnId`.
pub(crate) fn response_turn_id<'a>(
    turns: Option<&'a Record<TimelineTurn>>,
    id: &'a str,
) -> &'a str {
    let Some(turns) = turns else { return id };
    let Some(turn) = turns.get(id) else { return id };
    match turn.response_turn_id.as_deref() {
        Some(owner)
            if turns
                .get(owner)
                .is_some_and(|other| other.origin < turn.origin) =>
        {
            owner
        }
        _ => id,
    }
}

fn overlapping_request_turns(
    turns: &Record<TimelineTurn>,
    left: &str,
    right: &str,
    requests: &Record<Option<RequestTurn>>,
    request_id: &str,
) -> bool {
    let first = response_turn_id(Some(turns), left);
    let second = response_turn_id(Some(turns), right);
    let (Some(a), Some(b)) = (turns.get(first), turns.get(second)) else {
        return false;
    };
    let Some(question) = a.question_id.as_deref() else {
        return false;
    };
    if b.question_id.as_deref() != Some(question) {
        return false;
    }
    if first != second
        && requests.iter().any(|(id, owner)| {
            id != request_id
                && owner.as_ref().is_some_and(|owner| {
                    let owned = response_turn_id(Some(turns), &owner.turn_id);
                    owned == first || owned == second
                })
        })
    {
        return false;
    }
    let (earlier, later) = if a.origin <= b.origin { (a, b) } else { (b, a) };
    earlier.end_origin.is_none_or(|end| later.origin < end)
}

fn continued_request_turn(
    turns: &Record<TimelineTurn>,
    held: &str,
    later: &str,
    started_at: u64,
) -> Option<String> {
    let ended_id = response_turn_id(Some(turns), held);
    let next_id = response_turn_id(Some(turns), later);
    let ended = turns.get(ended_id)?;
    let next = turns.get(next_id)?;
    if ended_id == next_id {
        return None;
    }
    let end = ended.end_time?;
    if ended.continued.is_none() || started_at <= end || next.time < end || started_at < next.time {
        return None;
    }
    Some(next_id.to_owned())
}

fn turn_open_at(turns: &Record<TimelineTurn>, at: f64) -> Option<String> {
    let mut found: Option<&str> = None;
    for (id, turn) in turns {
        if turn.time as f64 > at || turn.end_time.is_some_and(|end| at > end as f64) {
            continue;
        }
        if found.is_none_or(|found| turns.get(found).is_some_and(|held| held.time < turn.time)) {
            found = Some(id);
        }
    }
    found.map(|found| response_turn_id(Some(turns), found).to_owned())
}

fn recorded_request_turn<'a>(
    requests: Option<&'a Record<Option<RequestTurn>>>,
    request_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Option<Option<&'a RequestTurn>> {
    let request_id = request_id.filter(|id| !id.is_empty())?;
    let owner = requests?.get(request_id)?;
    Some(
        owner
            .as_ref()
            .filter(|owner| Some(owner.conversation_id.as_str()) == conversation_id),
    )
}

fn new_turn(origin: u64, time: u64, question: Option<String>) -> TimelineTurn {
    TimelineTurn {
        origin,
        time,
        end_time: None,
        end_origin: None,
        question_id: question,
        response_turn_id: None,
        continued: None,
        extra: Extra::new(),
    }
}

/// `applyTurnIdentity`: the store-owned turn and request projection on the summary.
pub(crate) fn apply_turn_identity(summary: &mut SessionSummary, event: &SessionEvent) {
    let facts = facts(event);
    let origin = position(&facts);
    if facts.kind == "user_message"
        && let Some(message_id) = facts.message_id.filter(|id| !id.is_empty())
        && !injected_user_message(&facts, summary.timeline_turns.as_ref())
        && summary
            .native_question
            .as_ref()
            .and_then(Option::as_ref)
            .is_none_or(|question| origin > question.origin)
    {
        summary.native_question = Some(Some(NativeQuestion {
            message_id: message_id.to_owned(),
            origin,
            extra: Extra::new(),
        }));
    }
    let question = summary
        .native_question
        .as_ref()
        .and_then(Option::as_ref)
        .map(|question| question.message_id.clone());
    let turns = summary.timeline_turns.get_or_insert_with(Record::new);
    if let Some(turn_id) = facts.turn_id.filter(|id| !id.is_empty()) {
        if facts.kind == "turn_start" && !turns.contains_key(turn_id) {
            turns.insert(turn_id.to_owned(), new_turn(origin, facts.time, question));
        } else if facts.kind == "turn_start"
            && let Some(turn) = turns.get_mut(turn_id)
            && turn.end_origin.is_some_and(|end| origin > end)
        {
            turn.end_time = None;
            turn.end_origin = None;
        } else if facts.kind == "turn_end"
            && let Some(turn) = turns.get_mut(turn_id)
        {
            turn.end_time = Some(turn.end_time.unwrap_or(0).max(facts.time));
            turn.end_origin = Some(turn.end_origin.map_or(origin, |end| end.min(origin)));
            if facts.continued || turn.continued.is_some() {
                turn.continued = Some(True);
            }
        }
    }
    let Some((Some(request_id), Some(conversation_id), "request_id")) = facts.call else {
        return;
    };
    let Some(turn_id) = facts.turn_id.filter(|id| !id.is_empty()) else {
        return;
    };
    if facts.kind != "tool_call" || facts.source != EventSource::Mcp || request_id.is_empty() {
        return;
    }
    let turns = summary.timeline_turns.get_or_insert_with(Record::new);
    let requests = summary.request_turns.get_or_insert_with(Record::new);
    let held = recorded_request_turn(Some(requests), Some(request_id), Some(conversation_id))
        .map(|held| held.cloned());
    let mut owner = response_turn_id(Some(turns), turn_id).to_owned();
    if let Some(Some(held)) = &held
        && response_turn_id(Some(turns), &held.turn_id) != owner
        && continued_request_turn(turns, &held.turn_id, &owner, facts.time).as_deref()
            == Some(owner.as_str())
    {
        requests.insert(
            request_id.to_owned(),
            Some(request_turn(&owner, conversation_id, origin)),
        );
        return;
    }
    if let Some(Some(held)) = &held {
        let held_owner = response_turn_id(Some(turns), &held.turn_id).to_owned();
        if held_owner != owner
            && turns.contains_key(&held_owner)
            && continued_request_turn(turns, &owner, &held.turn_id, u64::MAX).as_deref()
                == Some(held_owner.as_str())
            && turns
                .get(&owner)
                .and_then(|turn| turn.end_time)
                .is_some_and(|end| facts.time <= end)
        {
            return;
        }
        if held_owner != owner {
            if !overlapping_request_turns(turns, &held.turn_id, &owner, requests, request_id) {
                requests.insert(request_id.to_owned(), None);
                return;
            }
            let prior = held_owner;
            let prior_origin = turns.get(&prior).map_or(u64::MAX, |turn| turn.origin);
            let owner_origin = turns.get(&owner).map_or(u64::MAX, |turn| turn.origin);
            let (earlier, later) = if prior_origin <= owner_origin {
                (prior, owner.clone())
            } else {
                (owner.clone(), prior)
            };
            for (id, turn) in turns.iter_mut() {
                if *id == later || turn.response_turn_id.as_deref() == Some(later.as_str()) {
                    turn.response_turn_id = Some(earlier.clone());
                }
            }
            owner = earlier;
        }
    }
    match held {
        Some(None) => {
            if !matches!(requests.get(request_id), Some(None)) {
                requests.insert(request_id.to_owned(), None);
            }
        }
        Some(Some(held)) if held.turn_id == owner && held.origin <= origin => {}
        held => {
            let first = held
                .flatten()
                .map_or(origin, |held| held.origin.min(origin));
            requests.insert(
                request_id.to_owned(),
                Some(request_turn(&owner, conversation_id, first)),
            );
        }
    }
}

fn request_turn(turn: &str, conversation: &str, origin: u64) -> RequestTurn {
    RequestTurn {
        turn_id: turn.to_owned(),
        conversation_id: conversation.to_owned(),
        origin,
        extra: Extra::new(),
    }
}

/// `authoredTimeOf`.
fn authored_time(facts: &Facts<'_>) -> Option<f64> {
    if let Some(at) = facts.authored_at.filter(|at| at.is_finite() && *at > 0.0) {
        return Some(at);
    }
    if facts.kind != "assistant_message" {
        return None;
    }
    let parts: Vec<&str> = facts.message_id?.split(':').collect();
    let [head, working, exchange, stamp] = parts.as_slice() else {
        return None;
    };
    let uuidish = |part: &str| {
        part.len() == 36
            && part
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    };
    let working_ok = working.is_empty() || uuidish(working);
    let exchange_ok = exchange.is_empty() || uuidish(exchange);
    if !head.eq_ignore_ascii_case("assistant")
        || !working_ok
        || !exchange_ok
        || (working.is_empty() && exchange.is_empty())
        || stamp.len() != 13
        || !stamp.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    stamp.parse().ok()
}

fn is_uuid(part: &str) -> bool {
    let groups: Vec<&str> = part.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn assistant_response_key(facts: &Facts<'_>) -> Option<String> {
    if facts.kind != "assistant_message" || facts.source != EventSource::Extension {
        return None;
    }
    let parts: Vec<&str> = facts.message_id?.split(':').collect();
    if parts.len() != 4 || parts[0] != "assistant" {
        return None;
    }
    let timestamped = parts[3].len() == 13 && parts[3].bytes().all(|b| b.is_ascii_digit());
    if !timestamped && !is_uuid(parts[1]) {
        return None;
    }
    let (working, exchange) = if timestamped {
        (parts[1], parts[2])
    } else {
        (parts[2], parts[3])
    };
    if !is_uuid(working) || !is_uuid(exchange) {
        return None;
    }
    Some(format!(
        "{}\u{0}{}:{}",
        facts.agent.unwrap_or(""),
        working.to_lowercase(),
        exchange.to_lowercase()
    ))
}

/// One placed entry: the event plus its projected turn origin and authored time.
struct Placed<'a> {
    event: SessionEvent,
    facts: Facts<'a>,
    turn_origin: Option<u64>,
    authored: Option<f64>,
}

/// `chronological(projectTimeline(entries, turns, requests, messages))`.
pub(crate) fn order(
    entries: Vec<SessionEvent>,
    summary: Option<&SessionSummary>,
    messages: &[&SessionEvent],
) -> Vec<SessionEvent> {
    let empty_turns = Record::new();
    let empty_requests = Record::new();
    let turns = summary
        .and_then(|summary| summary.timeline_turns.as_ref())
        .unwrap_or(&empty_turns);
    let requests = summary
        .and_then(|summary| summary.request_turns.as_ref())
        .unwrap_or(&empty_requests);
    // Facts borrow from the events; keep owned copies alive for the borrow.
    let owned: Vec<SessionEvent> = entries;
    let mut starts: Vec<&TimelineTurn> = turns.values().collect();
    starts.sort_by_key(|turn| turn.origin);
    let mut responses: HashMap<String, Option<u64>> = HashMap::new();
    for message in messages {
        let facts = facts(message);
        let Some(turn_id) = facts.turn_id.filter(|id| !id.is_empty()) else {
            continue;
        };
        let Some(key) = assistant_response_key(&facts) else {
            continue;
        };
        let boundary = turns
            .get(response_turn_id(Some(turns), turn_id))
            .map(|turn| turn.origin);
        match responses.get(&key) {
            None => {
                responses.insert(key, boundary);
            }
            Some(held) if boundary.is_none() || *held != boundary => {
                responses.insert(key, None);
            }
            Some(_) => {}
        }
    }
    let placed: Vec<(usize, Option<u64>, Option<f64>)> = owned
        .iter()
        .enumerate()
        .map(|(index, event)| {
            let facts = facts(event);
            let mut boundary: Option<&TimelineTurn> = facts
                .turn_id
                .filter(|id| !id.is_empty())
                .and_then(|id| turns.get(response_turn_id(Some(turns), id)));
            let untagged = facts.turn_id.is_none_or(str::is_empty);
            if untagged && let Some(key) = assistant_response_key(&facts) {
                boundary = responses
                    .get(&key)
                    .copied()
                    .flatten()
                    .and_then(|origin| turns.values().find(|turn| turn.origin == origin));
            }
            let request_owner = if untagged
                && facts.kind == "tool_call"
                && facts.source == EventSource::Mcp
                && facts.call.is_some_and(|call| call.2 == "request_id")
            {
                let call = facts.call.unwrap_or((None, None, ""));
                recorded_request_turn(Some(requests), call.0, call.1)
            } else {
                None
            };
            if let Some(Some(owner)) = request_owner {
                boundary = turns.get(response_turn_id(Some(turns), &owner.turn_id));
            }
            let written = (boundary.is_none() && untagged && facts.kind == "assistant_message")
                .then(|| authored_time(&facts))
                .flatten();
            if let Some(written) = written
                && starts
                    .iter()
                    .any(|start| start.time as f64 > written && start.origin < position(&facts))
                && let Some(owner) = turn_open_at(turns, written)
            {
                boundary = turns.get(owner.as_str());
            }
            if boundary.is_none()
                && request_owner.is_none()
                && untagged
                && !matches!(
                    facts.kind,
                    "user_message" | "assistant_message" | "native_image"
                )
            {
                let low = starts.partition_point(|start| start.origin < position(&facts));
                if let Some(candidate) = low.checked_sub(1).and_then(|at| starts.get(at))
                    && candidate.end_time.is_none_or(|end| facts.time <= end)
                {
                    boundary = Some(candidate);
                }
            }
            (
                index,
                boundary.map(|turn| turn.origin),
                authored_time(&facts),
            )
        })
        .collect();
    let mut entries: Vec<Placed<'_>> = placed
        .into_iter()
        .map(|(index, turn_origin, authored)| Placed {
            event: owned[index].clone(),
            facts: facts(&owned[index]),
            turn_origin,
            authored,
        })
        .collect();
    chronological(&mut entries);
    entries.into_iter().map(|entry| entry.event).collect()
}

const SAME_READ_MS: f64 = 50.0;
const CALL_TRANSIT_MS: f64 = 1_000.0;

fn chronological(entries: &mut Vec<Placed<'_>>) {
    entries.sort_by(|a, b| {
        position(&a.facts)
            .cmp(&position(&b.facts))
            .then(a.facts.seq.cmp(&b.facts.seq))
    });
    let mut anchors: HashMap<String, u64> = HashMap::new();
    for entry in entries.iter() {
        if let (Some(turn), Some(origin)) = (entry.facts.turn_id, entry.turn_origin)
            && !turn.is_empty()
        {
            let held = anchors.entry(turn.to_owned()).or_insert(origin);
            *held = (*held).min(origin);
        }
        if entry.facts.kind == "turn_start"
            && let Some(turn) = entry.facts.turn_id.filter(|id| !id.is_empty())
            && !anchors.contains_key(turn)
        {
            anchors.insert(turn.to_owned(), position(&entry.facts));
        }
    }
    let mut groups: Vec<(u64, Vec<usize>)> = Vec::new();
    let mut group_of: HashMap<u64, usize> = HashMap::new();
    // Every entry here went through the projection, so its turn origin is either a proven
    // group or a proven absence; the TypeScript inference for unprojected rows never applies.
    for (index, entry) in entries.iter().enumerate() {
        let anchor = entry
            .facts
            .turn_id
            .filter(|id| !id.is_empty())
            .and_then(|id| anchors.get(id).copied())
            .or(entry.turn_origin)
            .unwrap_or_else(|| position(&entry.facts));
        match group_of.get(&anchor) {
            Some(slot) => groups[*slot].1.push(index),
            None => {
                group_of.insert(anchor, groups.len());
                groups.push((anchor, vec![index]));
            }
        }
    }
    groups.sort_by_key(|(anchor, _)| *anchor);
    let mut out: Vec<usize> = Vec::with_capacity(entries.len());
    for (_, mut group) in groups {
        let closing = group
            .iter()
            .copied()
            .filter(|index| {
                entries[*index].facts.kind == "assistant_message" && entries[*index].facts.is_final
            })
            .max_by_key(|index| position(&entries[*index].facts));
        let read_before = place_before(entries, &group);
        let rank = |index: usize| -> f64 {
            match entries[index].facts.kind {
                "turn_start" => -1.0,
                "turn_end" => 1.0,
                _ if Some(index) == closing => 0.5,
                _ => 0.0,
            }
        };
        let when = |index: usize| -> f64 {
            read_before
                .get(&index)
                .copied()
                .or(entries[index].authored)
                .unwrap_or(entries[index].facts.time as f64)
        };
        group.sort_by(|&a, &b| {
            let by_rank = rank(a) - rank(b);
            if by_rank != 0.0 {
                return by_rank
                    .partial_cmp(&0.0)
                    .unwrap_or(std::cmp::Ordering::Equal);
            }
            let apart = when(a) - when(b);
            if apart.is_finite() && apart != 0.0 {
                return apart.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
            }
            position(&entries[a].facts)
                .cmp(&position(&entries[b].facts))
                .then(entries[a].facts.seq.cmp(&entries[b].facts.seq))
        });
        out.extend(group);
    }
    let mut taken: Vec<Option<Placed<'_>>> = entries.drain(..).map(Some).collect();
    for index in out {
        if let Some(entry) = taken[index].take() {
            entries.push(entry);
        }
    }
}

fn place_before(entries: &[Placed<'_>], group: &[usize]) -> HashMap<usize, f64> {
    let mut read_before = HashMap::new();
    let mut paragraphs: Vec<usize> = group
        .iter()
        .copied()
        .filter(|index| {
            entries[*index].facts.kind == "assistant_message" && entries[*index].authored.is_some()
        })
        .collect();
    paragraphs.sort_by(|&a, &b| {
        position(&entries[a].facts)
            .cmp(&position(&entries[b].facts))
            .then(entries[a].facts.seq.cmp(&entries[b].facts.seq))
    });
    let mut live: Vec<usize> = paragraphs
        .iter()
        .copied()
        .filter(|&paragraph| {
            group.iter().any(|&later| {
                entries[later].facts.kind != "turn_end"
                    && entries[later].facts.time > entries[paragraph].facts.time
            })
        })
        .collect();
    live.sort_by(|&a, &b| {
        let left = entries[a].authored.unwrap_or_default();
        let right = entries[b].authored.unwrap_or_default();
        left.partial_cmp(&right)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for &work in group {
        let entry = &entries[work];
        if !matches!(entry.facts.kind, "page_tool" | "tool_call") || entry.authored.is_some() {
            continue;
        }
        let time = entry.facts.time as f64;
        let prose = if entry.facts.kind == "page_tool" {
            paragraphs.iter().copied().find(|&paragraph| {
                let opened = entries[paragraph].authored.unwrap_or_default();
                position(&entries[paragraph].facts) > position(&entry.facts)
                    && opened < time
                    && time <= entries[paragraph].facts.time as f64 + SAME_READ_MS
            })
        } else {
            live.iter().copied().find(|&paragraph| {
                let opened = entries[paragraph].authored.unwrap_or_default();
                opened < time && time <= opened + CALL_TRANSIT_MS
            })
        };
        let Some(prose) = prose else { continue };
        let opened = entries[prose].authored.unwrap_or_default();
        let span = (entries[prose].facts.time as f64 + SAME_READ_MS).max(opened + CALL_TRANSIT_MS)
            - opened;
        read_before.insert(work, opened - 1.0 + 0.9 * (time - opened) / span);
    }
    read_before
}
