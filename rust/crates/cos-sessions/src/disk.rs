//! The files of one session folder, read and written synchronously (`store.ts`).
//!
//! ```text
//! sessions/<id>/events.jsonl      append-only journal, one event per line
//! sessions/<id>/messages/*.json   canonical messages and process calls, one shard per identity
//! sessions/<id>/messages.json     legacy canonical map, read as an overlay
//! sessions/<id>/meta.json         the summary plus its checkpoint fields
//! sessions/<id>/meta.backup.json  the last validated meta.json before the newest write
//! sessions/<id>/plan.json         the agent's displayed plan
//! sessions/<id>/assets/<hash>.*   screenshots and text too long to sit inline
//! ```
//!
//! Callers serialize per session; nothing here locks.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use cos_store::Logger;
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{AgentPlan, AssetRef, SessionEvent, SessionSummary};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::js;
use crate::summary::{self, Checkpoint};

/// A line that cannot be parsed back is dropped; this bounds the damage.
pub(crate) const MAX_LINE_BYTES: usize = 512 * 1024;
pub(crate) const MAX_CANONICAL_MESSAGE_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_ASSET_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_SESSION_ASSET_BYTES: u64 = 192 * 1024 * 1024;
pub(crate) const MAX_GLOBAL_ASSET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(crate) const MAX_AGENT_PLAN_BYTES: usize = 96 * 1024;

pub(crate) fn dir(root: &Path, id: &SessionId) -> PathBuf {
    root.join(id.as_str())
}

fn journal(dir: &Path) -> PathBuf {
    dir.join("events.jsonl")
}

fn temp_name(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_owned();
    name.push(format!(".{}.{}.tmp", std::process::id(), js::random_uuid()));
    PathBuf::from(name)
}

/// Writes the complete contents and waits until they are on the device.
fn write_durably(file: &Path, contents: &[u8]) -> io::Result<()> {
    let mut out = File::create(file)?;
    out.write_all(contents)?;
    out.sync_all()
}

fn replace(target: &Path, contents: &[u8], durable: bool) -> io::Result<()> {
    let tmp = temp_name(target);
    let result = (|| {
        if durable {
            write_durably(&tmp, contents)?;
        } else {
            fs::write(&tmp, contents)?;
        }
        fs::rename(&tmp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// `createSession`'s folder: the journal, an empty legacy map, then the first `meta.json`.
pub(crate) fn create(dir: &Path, summary: &SessionSummary) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal(dir))?;
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("messages.json"))
    {
        Ok(mut file) => file.write_all(b"{}")?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    write_summary(dir, summary, 0)
}

/// `writeSummary`: `meta.json` replaced atomically, the previous valid one kept as backup.
pub(crate) fn write_summary(
    dir: &Path,
    summary: &SessionSummary,
    history_seq: u64,
) -> io::Result<()> {
    let target = dir.join("meta.json");
    let persisted = summary::persisted(summary, history_seq);
    let text = serde_json::to_string_pretty(&persisted).map_err(io::Error::other)?;
    fs::create_dir_all(dir)?;
    let tmp = temp_name(&target);
    let result = (|| {
        write_durably(&tmp, text.as_bytes())?;
        let current = fs::read(&target)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(|current| {
                current.get("id").and_then(Value::as_str) == Some(summary.id.as_str())
            });
        if let Some(current) = current
            && let Ok(backup) = serde_json::to_string_pretty(&current)
        {
            replace(&dir.join("meta.backup.json"), backup.as_bytes(), true)?;
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Why an append did not land.
#[derive(Debug)]
pub(crate) enum AppendError {
    TooLarge,
    Io(io::Error),
}

impl std::fmt::Display for AppendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge => f.write_str("Session event is too large to store"),
            Self::Io(error) => error.fmt(f),
        }
    }
}

/// Appends one event line. An error after the line became durable counts as committed.
pub(crate) fn append(dir: &Path, event: &SessionEvent, logger: &Logger) -> Result<(), AppendError> {
    let mut line =
        serde_json::to_string(event).map_err(|error| AppendError::Io(io::Error::other(error)))?;
    line.push('\n');
    if line.len() > MAX_LINE_BYTES {
        return Err(AppendError::TooLarge);
    }
    let written = OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal(dir))
        .and_then(|mut file| file.write_all(line.as_bytes()));
    let Err(error) = written else { return Ok(()) };
    seal_torn_tail(dir, &event_id(dir), logger);
    let durable = last_seq_on_disk(dir).unwrap_or(0);
    if durable < event.base().seq {
        return Err(AppendError::Io(error));
    }
    logger.warn(&format!(
        "session {}: append reported an error after sequence {} was already durable",
        event_id(dir),
        event.base().seq
    ));
    Ok(())
}

fn event_id(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `lastSeqOnDisk`: the highest seq in the journal's tail. Only an absent journal is zero.
pub(crate) fn last_seq_on_disk(dir: &Path) -> io::Result<u64> {
    let mut file = match File::open(journal(dir)) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(0);
        }
        Err(error) => return Err(error),
    };
    let size = file.metadata()?.len();
    let window = (MAX_LINE_BYTES * 2 + 2) as u64;
    let from = size.saturating_sub(window);
    file.seek(SeekFrom::Start(from))?;
    let mut buffer = Vec::with_capacity((size - from) as usize);
    file.read_to_end(&mut buffer)?;
    let text = String::from_utf8_lossy(&buffer);
    for line in text.split('\n').rev() {
        let line = js::trim(line);
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(line)
            && let Some(seq) = parsed.get("seq").and_then(Value::as_f64)
        {
            return Ok(seq.max(0.0) as u64);
        }
    }
    Ok(0)
}

/// `sealTornTail`: closes an unterminated last line before anything is appended after it.
pub(crate) fn seal_torn_tail(dir: &Path, id: &str, logger: &Logger) {
    let file = journal(dir);
    let sealed = (|| -> io::Result<bool> {
        let mut handle = File::open(&file)?;
        let size = handle.metadata()?.len();
        if size == 0 {
            return Ok(false);
        }
        handle.seek(SeekFrom::Start(size - 1))?;
        let mut last = [0u8; 1];
        handle.read_exact(&mut last)?;
        if last[0] == b'\n' {
            return Ok(false);
        }
        OpenOptions::new()
            .append(true)
            .open(&file)?
            .write_all(b"\n")?;
        Ok(true)
    })();
    if matches!(sealed, Ok(true)) {
        logger.warn(&format!(
            "session {id}: sealed an unterminated final line before appending"
        ));
    }
}

/// Every line of the journal, in order, handing each complete line under the cap to `accept`.
/// Returns how many lines were too long to read.
pub(crate) fn scan_journal(dir: &Path, mut accept: impl FnMut(&[u8])) -> io::Result<u64> {
    let mut file = match File::open(journal(dir)) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(0);
        }
        Err(error) => return Err(error),
    };
    // A live recorder may append during the scan; read the extent captured now.
    let size = file.metadata()?.len();
    let mut block = vec![0u8; 256 * 1024];
    let mut carry: Vec<u8> = Vec::new();
    let mut skipping = false;
    let mut damaged = 0;
    let mut position = 0u64;
    while position < size {
        let wanted = block.len().min((size - position) as usize);
        let read = file.read(&mut block[..wanted])?;
        if read == 0 {
            break;
        }
        position += read as u64;
        let mut start = 0;
        let bytes = &block[..read];
        while start < bytes.len() {
            let newline = bytes[start..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|at| start + at);
            let part = &bytes[start..newline.unwrap_or(bytes.len())];
            if !skipping {
                if carry.len() + part.len() > MAX_LINE_BYTES {
                    skipping = true;
                    carry.clear();
                } else if newline.is_some() {
                    if carry.is_empty() {
                        accept(part);
                    } else {
                        carry.extend_from_slice(part);
                        accept(&carry);
                    }
                } else {
                    carry.extend_from_slice(part);
                }
            }
            let Some(newline) = newline else { break };
            if skipping {
                damaged += 1;
                skipping = false;
            }
            carry.clear();
            start = newline + 1;
        }
    }
    if skipping {
        damaged += 1;
    } else if !carry.is_empty() {
        accept(&carry);
    }
    Ok(damaged)
}

/// One journal line as an event, or `None` for a line that is damaged or not an event.
pub(crate) fn parse_line(line: &[u8]) -> Option<SessionEvent> {
    serde_json::from_slice(line).ok()
}

/// Whether a non-empty line is not readable as an event (`typeof seq/kind` failed or bad JSON).
pub(crate) fn blank(line: &[u8]) -> bool {
    line.iter().all(|byte| byte.is_ascii_whitespace())
}

/// `readCanonicalMessages`: the legacy map overlaid by the shards, aliases collapsed.
pub(crate) fn read_canonical_messages(
    dir: &Path,
    id: &str,
    logger: &Logger,
) -> (cos_types::json::Record<SessionEvent>, bool) {
    let mut out: cos_types::json::Record<SessionEvent> = cos_types::json::Record::new();
    match fs::read(dir.join("messages.json")) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => {
                for (key, value) in map {
                    let Ok(event) = serde_json::from_value::<SessionEvent>(value) else {
                        continue;
                    };
                    if !canonical_kind(&event) {
                        continue;
                    }
                    if summary::message_key(&event).as_deref() == Some(key.as_str()) {
                        out.insert(key, event);
                    }
                }
            }
            Ok(_) => {}
            Err(_) => logger.warn(&format!(
                "session {id}: canonical message file unreadable; legacy event log remains available"
            )),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => logger.warn(&format!(
            "session {id}: canonical message file unreadable; legacy event log remains available"
        )),
    }
    match fs::read_dir(dir.join("messages")) {
        Ok(entries) => {
            let mut names: Vec<String> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| shard_name(name))
                .collect();
            names.sort();
            for name in names {
                let path = dir.join("messages").join(&name);
                let read = (|| -> Option<(String, SessionEvent)> {
                    if fs::metadata(&path).ok()?.len() > MAX_CANONICAL_MESSAGE_BYTES {
                        return None;
                    }
                    let event: SessionEvent =
                        serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
                    let key = summary::message_key(&event)?;
                    (format!("{}.json", sha256_hex(key.as_bytes())) == name).then_some((key, event))
                })();
                match read {
                    Some((key, event)) => {
                        out.insert(key, event);
                    }
                    None => logger.warn(&format!(
                        "session {id}: ignored unreadable canonical message shard {name}"
                    )),
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => logger.warn(&format!(
            "session {id}: canonical message shards unreadable"
        )),
    }
    let collapsed = collapse_aliases(&mut out);
    (out, collapsed)
}

fn canonical_kind(event: &SessionEvent) -> bool {
    matches!(
        event,
        SessionEvent::UserMessage(_)
            | SessionEvent::AssistantMessage(_)
            | SessionEvent::NativeImage(_)
            | SessionEvent::ToolCall(_)
    )
}

fn shard_name(name: &str) -> bool {
    name.strip_suffix(".json").is_some_and(|hash| {
        hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// Older builds stored reload aliases of one provider message as separate shards. First
/// observation owns chronology; the latest terminal revision owns content.
fn collapse_aliases(out: &mut cos_types::json::Record<SessionEvent>) -> bool {
    let mut ordered: Vec<(String, u64)> = out
        .iter()
        .map(|(key, event)| (key.clone(), crate::timeline::position_of(event)))
        .collect();
    ordered.sort_by_key(|(_, at)| *at);
    let mut groups: cos_types::json::Record<Vec<String>> = cos_types::json::Record::new();
    for (key, _) in ordered {
        if let Some(SessionEvent::AssistantMessage(message)) = out.get(&key)
            && let Some(provider) = message
                .provider_message_id
                .as_deref()
                .filter(|id| !id.is_empty())
        {
            groups.entry(provider.to_owned()).or_default().push(key);
        }
    }
    let mut collapsed = false;
    for keys in groups.values().filter(|keys| keys.len() > 1) {
        collapsed = true;
        let messages: Vec<_> = keys
            .iter()
            .filter_map(|key| match out.get(key) {
                Some(SessionEvent::AssistantMessage(message)) => Some(message.clone()),
                _ => None,
            })
            .collect();
        let Some(first) = messages.first().cloned() else {
            continue;
        };
        let is_final = |message: &cos_types::session::AssistantMessageEvent| {
            message.is_final || message.state == Some(cos_types::session::MessageState::Final)
        };
        let mut latest = first.clone();
        let mut seq = first.base.seq;
        for message in &messages {
            let replace = if is_final(&latest) != is_final(message) {
                is_final(message)
            } else {
                message.base.seq > latest.base.seq
            };
            if replace {
                latest = message.clone();
            }
            seq = seq.max(message.base.seq);
        }
        for key in keys {
            out.shift_remove(key);
        }
        let mut merged = latest;
        merged.message_id = first.message_id.clone();
        merged.origin = Some(first.origin.unwrap_or(first.base.seq));
        merged.base.time = first.base.time;
        merged.base.seq = seq;
        merged.base.turn_id = messages
            .iter()
            .find_map(|message| message.base.turn_id.clone());
        if messages
            .iter()
            .any(|message| message.goal_eligible == Some(true))
        {
            merged.goal_eligible = Some(true);
        }
        out.insert(keys[0].clone(), SessionEvent::AssistantMessage(merged));
    }
    collapsed
}

/// What one `meta.json` or its backup holds.
enum MetaFile {
    Valid(Box<Checkpoint>),
    Absent,
    Damaged,
    Unreadable(io::Error),
}

fn read_meta_file(id: &SessionId, file: &Path) -> MetaFile {
    match fs::read(file) {
        Ok(bytes) => match summary::checkpoint(id, &String::from_utf8_lossy(&bytes)) {
            Some(checkpoint) => MetaFile::Valid(Box::new(checkpoint)),
            None => MetaFile::Damaged,
        },
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            MetaFile::Absent
        }
        Err(error) => MetaFile::Unreadable(error),
    }
}

fn state_name(file: &MetaFile) -> &'static str {
    match file {
        MetaFile::Valid(_) => "valid",
        MetaFile::Absent => "absent",
        MetaFile::Damaged => "damaged",
        MetaFile::Unreadable(_) => "unreadable",
    }
}

/// `readMetaCheckpoint`: the primary, else the backup; an unreadable file is an error.
pub(crate) fn read_checkpoint(
    dir: &Path,
    id: &SessionId,
    history_seq: u64,
    logger: &Logger,
) -> io::Result<Option<Checkpoint>> {
    let primary = read_meta_file(id, &dir.join("meta.json"));
    if let MetaFile::Valid(checkpoint) = primary {
        return Ok(Some(*checkpoint));
    }
    let backup = read_meta_file(id, &dir.join("meta.backup.json"));
    if let MetaFile::Valid(checkpoint) = backup {
        logger.warn(&format!(
            "session {id}: meta.json {}; using the last validated checkpoint",
            state_name(&primary)
        ));
        return Ok(Some(*checkpoint));
    }
    for file in [&primary, &backup] {
        if let MetaFile::Unreadable(error) = file {
            return Err(io::Error::new(
                error.kind(),
                format!("Session {id} metadata could not be read ({error})"),
            ));
        }
    }
    if history_seq > 0
        || !matches!(primary, MetaFile::Absent)
        || !matches!(backup, MetaFile::Absent)
    {
        logger.warn(&format!(
            "session {id}: meta.json {}, meta.backup.json {}; refusing to treat it as an empty session",
            state_name(&primary),
            state_name(&backup)
        ));
    }
    Ok(None)
}

/// The durable truth of one session (`DurableSessionSnapshot`).
pub(crate) struct Snapshot {
    pub summary: SessionSummary,
    pub history_seq: u64,
    pub reconciled: bool,
}

/// `readDurableSnapshot`: the checkpoint when it is current, otherwise a rebuild from history.
pub(crate) fn read_snapshot(
    dir: &Path,
    id: &SessionId,
    logger: &Logger,
) -> io::Result<Option<Snapshot>> {
    let (messages, aliases_collapsed) = read_canonical_messages(dir, id.as_str(), logger);
    let message_seq = messages
        .values()
        .map(|event| event.base().seq)
        .max()
        .unwrap_or(0);
    let journal_seq = last_seq_on_disk(dir)?;
    let history_seq = journal_seq.max(message_seq);
    let checkpoint = read_checkpoint(dir, id, history_seq, logger)?;
    if let Some(checkpoint) = &checkpoint
        && checkpoint.current_at(history_seq, aliases_collapsed)
    {
        let migrated = !checkpoint.canonical_projection_current;
        if migrated {
            write_summary(dir, &checkpoint.summary, history_seq)?;
        }
        return Ok(Some(Snapshot {
            summary: checkpoint.summary.clone(),
            history_seq,
            reconciled: migrated,
        }));
    }
    if let Some(checkpoint) = &checkpoint
        && history_seq == 0
    {
        let mut summary = checkpoint.summary.clone();
        if checkpoint.outcome_counters_missing {
            summary.errors = 0;
        }
        summary.timeline_turns = Some(cos_types::json::Record::new());
        summary.native_question = Some(None);
        summary.request_turns = Some(cos_types::json::Record::new());
        summary.last_tool_call_at = None;
        summary.last_assistant_final_at = Some(None);
        summary.last_turn_end_at = Some(None);
        summary.last_finish_report_at = Some(None);
        summary.finish_turn = Some(None);
        write_summary(dir, &summary, 0)?;
        return Ok(Some(Snapshot {
            summary,
            history_seq: 0,
            reconciled: true,
        }));
    }
    if checkpoint.is_none() && history_seq == 0 {
        return Ok(None);
    }
    let preserve_turn = checkpoint
        .as_ref()
        .is_some_and(|checkpoint| checkpoint.history_seq == Some(history_seq));
    let migrate_tokens = checkpoint
        .as_ref()
        .is_some_and(|checkpoint| !checkpoint.token_estimate_current);
    let summary = rebuild(
        dir,
        id,
        &messages,
        checkpoint.map(|checkpoint| checkpoint.summary),
        history_seq,
        preserve_turn,
        migrate_tokens,
        logger,
    )?;
    Ok(Some(Snapshot {
        summary,
        history_seq,
        reconciled: true,
    }))
}

/// `rebuildSummaryFromHistory`: replays the journal and the canonical messages, keeps the
/// checkpoint's metadata-only facts, and writes the result.
#[expect(
    clippy::too_many_arguments,
    reason = "mirrors the recovery inputs one to one"
)]
fn rebuild(
    dir: &Path,
    id: &SessionId,
    messages: &cos_types::json::Record<SessionEvent>,
    checkpoint: Option<SessionSummary>,
    history_seq: u64,
    preserve_attachment_turn: bool,
    migrate_token_estimate: bool,
    logger: &Logger,
) -> io::Result<SessionSummary> {
    let mut rebuilt = summary::empty(id.clone(), "Recovered session", None, 0);
    let mut seen = false;
    let mut historical_return_reduction = 0u64;
    let mut identities: Vec<SessionEvent> = Vec::new();
    let checkpoint_conversation = checkpoint
        .as_ref()
        .and_then(|summary| summary.conversation_id.clone());
    let mut project = |event: SessionEvent, rebuilt: &mut SessionSummary| {
        if !seen {
            rebuilt.started_at = event.base().time;
            rebuilt.updated_at = event.base().time;
        }
        if let SessionEvent::SessionStart(start) = &event
            && !seen
            && !start.title.is_empty()
        {
            rebuilt.title = start.title.clone();
        }
        let conversation = match &event {
            SessionEvent::SessionStart(start) => start.conversation_id.clone(),
            _ => None,
        };
        if let Some(conversation) = conversation.filter(|id| !id.is_empty()) {
            rebuilt.conversation_id = Some(conversation.clone());
            if !rebuilt.chat_ids.contains(&conversation) {
                rebuilt.chat_ids.push(conversation);
            }
        }
        if migrate_token_estimate
            && let SessionEvent::ToolCall(call) = &event
            && let (Some(current), Some(called)) =
                (&checkpoint_conversation, &call.call.conversation_id)
            && called != current
        {
            historical_return_reduction += summary::stored_text_tokens(&call.call.result)
                .saturating_sub(summary::MAX_TOOL_RESULT_TOKENS);
        }
        summary::apply(rebuilt, &event);
        if matches!(
            event,
            SessionEvent::UserMessage(_)
                | SessionEvent::TurnStart(_)
                | SessionEvent::TurnEnd(_)
                | SessionEvent::ToolCall(_)
        ) {
            identities.push(event);
        }
        seen = true;
    };
    scan_journal(dir, |line| {
        if line.is_empty() {
            return;
        }
        let Some(event) = parse_line(line) else {
            return;
        };
        if summary::message_key(&event).is_some_and(|key| messages.contains_key(&key)) {
            return;
        }
        project(event, &mut rebuilt);
    })?;
    let mut canonical: Vec<&SessionEvent> = messages.values().collect();
    canonical.sort_by_key(|event| event.base().seq);
    for message in canonical {
        project(message.clone(), &mut rebuilt);
    }
    if !seen {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Session {id} has no recoverable metadata or history"),
        ));
    }
    rebuilt.timeline_turns = Some(cos_types::json::Record::new());
    rebuilt.request_turns = Some(cos_types::json::Record::new());
    rebuilt.native_question = Some(None);
    identities.sort_by_key(crate::timeline::position_of);
    for event in &identities {
        crate::timeline::apply_turn_identity(&mut rebuilt, event);
    }
    let summary = match checkpoint {
        None => rebuilt,
        Some(checkpoint) => {
            let context = (checkpoint.context_tokens as i128 + rebuilt.estimated_tokens as i128
                - checkpoint.estimated_tokens as i128
                + historical_return_reduction as i128)
                .max(0) as u64;
            let finish_turn = match &rebuilt.finish_turn {
                Some(Some(finish)) if finish.conversation_id == checkpoint.conversation_id => {
                    Some(Some(finish.clone()))
                }
                _ => Some(None),
            };
            let mut agents = checkpoint.agents.clone();
            for agent in &rebuilt.agents {
                if !agents.contains(agent) {
                    agents.push(agent.clone());
                }
            }
            SessionSummary {
                updated_at: checkpoint.updated_at.max(rebuilt.updated_at),
                events: rebuilt.events,
                timeline_turns: rebuilt.timeline_turns,
                request_turns: rebuilt.request_turns,
                native_question: rebuilt.native_question,
                user_messages: rebuilt.user_messages,
                tool_calls: rebuilt.tool_calls,
                last_tool_call_at: rebuilt.last_tool_call_at,
                last_tool_activity: rebuilt.last_tool_activity,
                last_assistant_final_at: rebuilt.last_assistant_final_at,
                last_turn_end_at: rebuilt.last_turn_end_at,
                last_finish_report_at: rebuilt.last_finish_report_at,
                process_exit_nonzero: rebuilt.process_exit_nonzero,
                tool_rejected: rebuilt.tool_rejected,
                tool_internal_errors: rebuilt.tool_internal_errors,
                errors: rebuilt.errors,
                estimated_tokens: rebuilt.estimated_tokens,
                context_tokens: context,
                last_handoff_id: rebuilt.last_handoff_id,
                last_handoff_at: rebuilt.last_handoff_at,
                last_turn_outcome: rebuilt.last_turn_outcome,
                active_turn_id: if preserve_attachment_turn {
                    Some(checkpoint.active_turn_id.clone().flatten())
                } else {
                    Some(rebuilt.active_turn_id.flatten())
                },
                finish_turn,
                agents,
                ..checkpoint
            }
        }
    };
    logger.warn(&format!(
        "session {id}: rebuilt metadata from durable event/message history"
    ));
    write_summary(dir, &summary, history_seq)?;
    Ok(summary)
}

/// `readCatalogSummary`: a current checkpoint older than every history file is served as is;
/// anything else goes through the full durable read.
pub(crate) fn read_catalog_summary(
    dir: &Path,
    id: &SessionId,
    logger: &Logger,
) -> io::Result<Option<SessionSummary>> {
    let fast = (|| -> Option<SessionSummary> {
        let meta = fs::metadata(dir.join("meta.json")).ok()?.modified().ok()?;
        let checkpoint = summary::checkpoint(
            id,
            &String::from_utf8_lossy(&fs::read(dir.join("meta.json")).ok()?),
        )?;
        let current = checkpoint.history_seq.is_some()
            && checkpoint.canonical_projection_current
            && checkpoint.token_estimate_current
            && !checkpoint.outcome_counters_missing
            && !checkpoint.activity_boundary_missing
            && checkpoint.summary.finish_turn.is_some();
        if !current {
            return None;
        }
        for name in ["events.jsonl", "messages.json", "messages"] {
            match fs::metadata(dir.join(name)) {
                Ok(stat) => {
                    if stat.modified().ok()? >= meta {
                        return None;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return None,
            }
        }
        Some(checkpoint.summary)
    })();
    if let Some(summary) = fast {
        return Ok(Some(summary));
    }
    Ok(read_snapshot(dir, id, logger)?.map(|snapshot| snapshot.summary))
}

/// The lowercase hex SHA-256 of `data` (`createHash('sha256')`). Names only: nothing here is a
/// security boundary.
pub(crate) fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

/// `writeAsset`'s file: content addressed, never overwritten.
pub(crate) fn asset_id(data: &[u8], mime_type: &str) -> String {
    let hash = sha256_hex(data);
    let extension = match mime_type {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "text/plain" => ".txt",
        _ => ".bin",
    };
    format!("{}{extension}", &hash[..32])
}

/// Whether the asset already exists, and writes it when it does not.
pub(crate) fn write_asset_file(dir: &Path, id: &str, data: &[u8]) -> io::Result<bool> {
    let folder = dir.join("assets");
    fs::create_dir_all(&folder)?;
    let target = folder.join(id);
    if fs::metadata(&target).is_ok() {
        return Ok(false);
    }
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
    {
        Ok(mut file) => {
            file.write_all(data)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error),
    }
}

/// Bytes of the regular files directly inside `folder`.
pub(crate) fn folder_bytes(folder: &Path) -> io::Result<u64> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    Ok(entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .filter(fs::Metadata::is_file)
        .map(|stat| stat.len())
        .sum())
}

pub(crate) fn asset_ref(id: String, mime_type: &str, bytes: usize) -> AssetRef {
    AssetRef {
        id,
        mime_type: mime_type.to_owned(),
        bytes: bytes as u64,
        width: None,
        height: None,
        extra: Extra::new(),
    }
}

/// `readPlanFile`: the plan, or `None` when it is absent, too large or not a plan.
pub(crate) fn read_plan(dir: &Path) -> io::Result<Option<AgentPlan>> {
    let mut file = match File::open(dir.join("plan.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut buffer = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_AGENT_PLAN_BYTES as u64 + 1)
        .read_to_end(&mut buffer)?;
    if buffer.len() > MAX_AGENT_PLAN_BYTES {
        return Ok(None);
    }
    Ok(serde_json::from_slice(&buffer).ok())
}

pub(crate) fn write_plan(dir: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = dir.join("plan.json");
    let mut name = target.as_os_str().to_owned();
    name.push(format!(".{}.tmp", js::random_uuid()));
    let tmp = PathBuf::from(name);
    let result = fs::write(&tmp, bytes).and_then(|()| fs::rename(&tmp, &target));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// `writeCanonicalMessage`: one shard per identity, `messages/<sha256(key)>.json`, replaced whole.
pub(crate) fn write_canonical_message(
    dir: &Path,
    key: &str,
    event: &SessionEvent,
) -> io::Result<()> {
    let folder = dir.join("messages");
    fs::create_dir_all(&folder)?;
    let text = serde_json::to_vec(event).map_err(io::Error::other)?;
    if text.len() as u64 > MAX_CANONICAL_MESSAGE_BYTES {
        return Err(io::Error::other("Canonical message is too large"));
    }
    replace(
        &folder.join(format!("{}.json", sha256_hex(key.as_bytes()))),
        &text,
        false,
    )
}

/// `readAsset`: the bytes of one asset, or `None` for an id this store never names or a file
/// that is gone.
pub(crate) fn read_asset(dir: &Path, id: &str) -> Option<Vec<u8>> {
    let (hash, extension) = id.split_once('.')?;
    let named = (8..=64).contains(&hash.len())
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && matches!(extension, "png" | "jpg" | "txt" | "bin");
    if !named {
        return None;
    }
    fs::read(dir.join("assets").join(id)).ok()
}

/// Replaces the whole journal with these events, one line each.
pub(crate) fn rewrite_journal(dir: &Path, events: &[SessionEvent]) -> io::Result<()> {
    let mut contents = Vec::new();
    for event in events {
        serde_json::to_writer(&mut contents, event).map_err(io::Error::other)?;
        contents.push(b'\n');
    }
    replace(&journal(dir), &contents, true)
}

/// Removes the session folder and everything in it.
pub(crate) fn remove(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}
