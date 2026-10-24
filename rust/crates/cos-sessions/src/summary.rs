//! The session summary projection: what `meta.json` holds and how each event moves it
//! (`emptySummary`, `applyToSummary`, `normalizeSummary` in `store.ts`, and the token and
//! outcome rules of `shared/session.ts`).

use cos_types::ids::SessionId;
use cos_types::json::{Extra, Record};
use cos_types::session::{
    ActivitySummary, FinishControlState, FinishTurn, SessionEvent, SessionMeta, SessionSummary,
    StoredText, ToolActivity, ToolCallRecord, ToolOutcome,
};
use serde_json::Value;

use crate::js;
use crate::timeline::apply_turn_identity;

pub(crate) const MAX_TOOL_RESULT_TOKENS: u64 = 10_000;

/// `emptySummary`.
pub(crate) fn empty(
    id: SessionId,
    title: &str,
    conversation_id: Option<String>,
    now: u64,
) -> SessionSummary {
    SessionSummary {
        timeline_turns: Some(Record::new()),
        request_turns: Some(Record::new()),
        native_question: Some(None),
        title_source: None,
        auto_title: None,
        selected_model: None,
        project_id: None,
        id,
        title: title.to_owned(),
        chat_ids: conversation_id.iter().cloned().collect(),
        conversation_id,
        retired_chat_at: None,
        started_at: now,
        updated_at: now,
        ended_at: None,
        browser_recovery_dismissed_at: None,
        events: 0,
        user_messages: 0,
        tool_calls: 0,
        last_tool_call_at: None,
        last_tool_activity: Some(None),
        worker_assignment: None,
        last_assistant_final_at: Some(None),
        last_turn_end_at: Some(None),
        activity_expires_at: None,
        last_finish_report_at: Some(None),
        process_exit_nonzero: 0,
        tool_rejected: 0,
        tool_internal_errors: 0,
        errors: 0,
        estimated_tokens: 0,
        context_tokens: 0,
        last_handoff_id: None,
        last_handoff_at: None,
        last_committed_resume_handoff_id: Some(None),
        last_turn_outcome: None,
        active_turn_id: Some(None),
        auto_compaction_refusal: None,
        finish_turn: Some(None),
        agents: Vec::new(),
        origin: None,
        extra: Extra::new(),
    }
}

/// `storedTextTokens`.
pub(crate) fn stored_text_tokens(value: &StoredText) -> u64 {
    let units = if value.truncated {
        value.chars
    } else {
        js::len(&value.text) as u64
    };
    js::quarter_ceil(units)
}

/// `eventTokens`: the context weight of one recorded event.
pub(crate) fn event_tokens(event: &SessionEvent) -> u64 {
    match event {
        SessionEvent::UserMessage(event) => {
            let wire = event
                .wire_token_estimate
                .map(|estimate| estimate.0)
                .filter(|estimate| estimate.is_finite())
                .map_or(0, |estimate| estimate.floor().max(0.0) as u64);
            stored_text_tokens(&event.message).max(wire)
        }
        SessionEvent::AssistantMessage(event) => stored_text_tokens(&event.message),
        SessionEvent::ChatError(event) => stored_text_tokens(&event.message),
        SessionEvent::Note(event) => stored_text_tokens(&event.message),
        SessionEvent::AgentMessage(event) => stored_text_tokens(&event.message),
        SessionEvent::ToolCall(event) => {
            let call = &event.call;
            if call.nested == Some(true) {
                return 0;
            }
            stored_text_tokens(&call.args)
                + stored_text_tokens(&call.result).min(MAX_TOOL_RESULT_TOKENS)
                + js::quarter_ceil(js::len(&call.summary.title) as u64)
        }
        _ => 0,
    }
}

/// `normalizedToolOutcome`: current outcomes and only self-proving legacy rows.
pub(crate) fn normalized_outcome(call: &ToolCallRecord) -> Option<ToolOutcome> {
    match call.outcome {
        ToolOutcome::LegacyRejected => Some(ToolOutcome::ToolRejected),
        ToolOutcome::LegacyError => {
            let metric = call.summary.metric.as_deref().unwrap_or("");
            let exit = metric
                .strip_prefix("\u{2715} exit ")
                .map(|code| code.strip_prefix('-').unwrap_or(code))
                .is_some_and(|code| !code.is_empty() && code.bytes().all(|b| b.is_ascii_digit()));
            ((call.tool == "exec_command" || call.tool == "write_stdin") && exit)
                .then_some(ToolOutcome::ProcessExitNonzero)
        }
        outcome => Some(outcome),
    }
}

/// `toolCallSummary`: a persisted launch never proves its child is still alive.
pub(crate) fn tool_call_summary(call: &ToolCallRecord) -> ActivitySummary {
    let mut summary = call.summary.clone();
    if call.tool == "exec_command" && summary.metric.as_deref() == Some("running") {
        summary.metric = Some("started".into());
    }
    summary
}

/// `workSequence`.
pub(crate) fn work_sequence(event: &SessionEvent) -> u64 {
    match event {
        SessionEvent::UserMessage(event) => {
            event.content_seq.or(event.origin).unwrap_or(event.base.seq)
        }
        SessionEvent::AssistantMessage(event) => event
            .content_seq
            .or(event.final_content_seq)
            .or(event.origin)
            .unwrap_or(event.base.seq),
        SessionEvent::PageTool(event) => {
            event.content_seq.or(event.origin).unwrap_or(event.base.seq)
        }
        SessionEvent::ToolCall(event) => event.origin.unwrap_or(event.base.seq),
        other => other.base().seq,
    }
}

fn is_lower_hex_64(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn note_finish_work(summary: &mut SessionSummary, event: &SessionEvent) {
    let Some(Some(finish)) = summary.finish_turn.as_mut() else {
        return;
    };
    let turn = event.base().turn_id.as_deref();
    if turn.is_some_and(|turn| !turn.is_empty() && turn != finish.turn_id) {
        return;
    }
    let meaningful = match event {
        SessionEvent::UserMessage(_) | SessionEvent::AssistantMessage(_) => true,
        SessionEvent::Progress(progress) => {
            progress.base.source != cos_types::session::EventSource::App
        }
        SessionEvent::ToolCall(call) => {
            !["keep_astra_on_forever", "session_finish"].contains(&call.call.tool.as_str())
        }
        _ => false,
    };
    if meaningful {
        finish.work_seq = finish.work_seq.max(work_sequence(event));
    }
}

/// `applyToSummary`: how one appended event moves the summary.
pub(crate) fn apply(summary: &mut SessionSummary, event: &SessionEvent) {
    apply_turn_identity(summary, event);
    let base = event.base();
    summary.events += 1;
    summary.updated_at = summary.updated_at.max(base.time);
    let tokens = event_tokens(event);
    summary.estimated_tokens += tokens;
    summary.context_tokens += tokens;
    match event {
        SessionEvent::UserMessage(_) => summary.user_messages += 1,
        SessionEvent::ToolCall(tool) => {
            let call = &tool.call;
            summary.tool_calls += 1;
            let prior = summary.last_tool_call_at.unwrap_or(0);
            summary.last_tool_call_at = Some(prior.max(base.time));
            if base.time >= prior {
                summary.last_tool_activity = Some(Some(ToolActivity {
                    kind: call.summary.kind,
                    title: js::prefix(&call.summary.title, 200).to_owned(),
                    extra: Extra::new(),
                }));
            }
            if call.ends_activity.is_some() {
                let prior = summary.last_finish_report_at.flatten().unwrap_or(0);
                summary.last_finish_report_at = Some(Some(prior.max(base.time)));
            }
            match normalized_outcome(call) {
                Some(ToolOutcome::ProcessExitNonzero) => summary.process_exit_nonzero += 1,
                Some(ToolOutcome::ToolRejected) => summary.tool_rejected += 1,
                Some(ToolOutcome::ToolInternalError) => {
                    summary.tool_internal_errors += 1;
                    summary.errors += 1;
                }
                _ => {}
            }
        }
        SessionEvent::AssistantMessage(message)
            if message.is_final
                || message.state == Some(cos_types::session::MessageState::Final) =>
        {
            let prior = summary.last_assistant_final_at.flatten().unwrap_or(0);
            summary.last_assistant_final_at = Some(Some(prior.max(base.time)));
        }
        SessionEvent::ChatError(_) => summary.errors += 1,
        SessionEvent::TurnEnd(end) => {
            summary.last_turn_outcome = Some(end.outcome);
            let prior = summary.last_turn_end_at.flatten().unwrap_or(0);
            summary.last_turn_end_at = Some(Some(prior.max(base.time)));
        }
        SessionEvent::TurnStart(_) => {
            let active = base
                .turn_id
                .clone()
                .filter(|turn| !turn.is_empty())
                .unwrap_or_else(|| format!("seq-{}", base.seq));
            let same =
                matches!(&summary.finish_turn, Some(Some(finish)) if finish.turn_id == active);
            if !same {
                summary.finish_turn = Some(Some(FinishTurn {
                    turn_id: active.clone(),
                    conversation_id: summary.conversation_id.clone(),
                    started_at: base.time,
                    notified: false,
                    released: false,
                    decision_revision: None,
                    work_seq: 0,
                    decision_seq: 0,
                    decision_input_revision: None,
                    decision_at: None,
                    extra: Extra::new(),
                }));
            }
            summary.active_turn_id = Some(Some(active));
        }
        _ => {}
    }
    if let SessionEvent::Progress(progress) = event
        && progress.base.source == cos_types::session::EventSource::App
        && let Some(turn) = base.turn_id.as_deref().filter(|turn| !turn.is_empty())
        && let Some(Some(finish)) = summary.finish_turn.as_mut()
        && finish.turn_id == turn
    {
        let control = progress.finish_control.as_ref();
        let progress_id = progress.progress_id.as_deref();
        if progress_id == Some(format!("finish:{turn}").as_str())
            || control.is_some_and(|control| control.state == FinishControlState::Notified)
        {
            finish.notified = true;
        }
        let prefix = format!("finish-goal:{turn}:");
        let revision = match control {
            Some(control) if control.state == FinishControlState::Decision => {
                control.revision.clone()
            }
            _ => progress_id
                .and_then(|id| id.strip_prefix(prefix.as_str()))
                .map(str::to_owned),
        };
        let work_seq = control.and_then(|control| control.work_seq);
        if let Some(revision) = revision
            .as_deref()
            .filter(|revision| is_lower_hex_64(revision))
            && finish.decision_revision.as_deref() != Some(revision)
        {
            finish.decision_revision = Some(revision.to_owned());
            finish.decision_at = Some(base.time);
            finish.decision_seq = work_seq.unwrap_or(base.seq);
            finish.decision_input_revision =
                control.and_then(|control| control.input_revision.clone());
        } else if revision.is_some()
            && revision == finish.decision_revision
            && control.is_some_and(|control| control.state == FinishControlState::Decision)
            && let Some(work_seq) = work_seq
        {
            finish.decision_seq = finish.decision_seq.max(work_seq);
        }
        if let Some(control) = control {
            finish.conversation_id = Some(control.conversation_id.clone());
            if control.state == FinishControlState::Released {
                finish.released = true;
            }
        }
    }
    note_finish_work(summary, event);
    if let SessionEvent::TurnEnd(_) = event {
        let turn = base.turn_id.as_deref().filter(|turn| !turn.is_empty());
        let active = summary
            .active_turn_id
            .as_ref()
            .and_then(|turn| turn.as_deref());
        if turn.is_none() || active == turn {
            summary.active_turn_id = Some(None);
        }
    }
    if let SessionEvent::Handoff(handoff) = event {
        summary.last_handoff_id = Some(handoff.handoff_id.clone());
        summary.last_handoff_at = Some(base.time);
    }
    if let Some(agent) = base.agent.as_deref().filter(|agent| !agent.is_empty())
        && !summary.agents.iter().any(|known| known == agent)
    {
        summary.agents.push(agent.to_owned());
    }
}

/// A validated `meta.json` and what its checkpoint fields say (`MetaCheckpoint`).
pub(crate) struct Checkpoint {
    pub summary: SessionSummary,
    /// `None`: written before the history watermark existed.
    pub history_seq: Option<u64>,
    pub canonical_projection_current: bool,
    pub token_estimate_current: bool,
    pub outcome_counters_missing: bool,
    pub activity_boundary_missing: bool,
}

impl Checkpoint {
    /// Whether this checkpoint can be served without replaying history at `history_seq`.
    pub(crate) fn current_at(&self, history_seq: u64, aliases_collapsed: bool) -> bool {
        self.history_seq == Some(history_seq)
            && self.token_estimate_current
            && (!aliases_collapsed || self.canonical_projection_current)
            && !self.outcome_counters_missing
            && !self.activity_boundary_missing
            && self.summary.timeline_turns.is_some()
            && self.summary.request_turns.is_some()
            && self.summary.native_question.is_some()
            && self.summary.finish_turn.is_some()
    }
}

/// `normalizeSummary`: one `meta.json` as this session's checkpoint, or `None` when it is not.
pub(crate) fn checkpoint(id: &SessionId, raw: &str) -> Option<Checkpoint> {
    let mut value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object_mut()?;
    if object.get("id").and_then(Value::as_str) != Some(id.as_str()) {
        return None;
    }
    drop_invalid_optional_fields(object);
    let outcome_counters_missing = ["processExitNonzero", "toolRejected", "toolInternalErrors"]
        .iter()
        .any(|key| !object.get(*key).is_some_and(Value::is_number));
    let activity_boundary_missing = !object.contains_key("lastAssistantFinalAt");
    for key in ["processExitNonzero", "toolRejected", "toolInternalErrors"] {
        if !object.get(key).is_some_and(Value::is_number) {
            object.insert(key.into(), Value::from(0));
        }
    }
    for key in [
        "lastToolCallAt",
        "lastAssistantFinalAt",
        "lastTurnEndAt",
        "lastFinishReportAt",
    ] {
        if !object
            .get(key)
            .is_some_and(|at| at.as_f64().is_some_and(f64::is_finite))
        {
            object.insert(key.into(), Value::Null);
        }
    }
    if !object.contains_key("lastToolActivity") {
        object.insert("lastToolActivity".into(), Value::Null);
    }
    if !object.get("agents").is_some_and(Value::is_array) {
        object.insert("agents".into(), Value::Array(Vec::new()));
    }
    if !object.contains_key("origin") {
        object.insert("origin".into(), Value::Null);
    }
    if !object.get("chatIds").is_some_and(Value::is_array) {
        let ids = object
            .get("conversationId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(|id| vec![Value::from(id)])
            .unwrap_or_default();
        object.insert("chatIds".into(), Value::Array(ids));
    }
    if !object.get("contextTokens").is_some_and(Value::is_number) {
        let estimated = object
            .get("estimatedTokens")
            .cloned()
            .unwrap_or(Value::Null);
        object.insert("contextTokens".into(), estimated);
    }
    let resume_ok = object
        .get("lastCommittedResumeHandoffId")
        .and_then(Value::as_str)
        .is_some_and(|id| SessionId::parse(id).is_ok());
    if !resume_ok {
        object.insert("lastCommittedResumeHandoffId".into(), Value::Null);
    }
    let meta: SessionMeta = serde_json::from_value(value).ok()?;
    let history_seq = meta.history_seq.filter(|seq| *seq <= 9_007_199_254_740_991);
    Some(Checkpoint {
        canonical_projection_current: meta.canonical_projection == Some(1),
        token_estimate_current: meta.token_estimate == Some(1),
        history_seq,
        outcome_counters_missing,
        activity_boundary_missing,
        summary: meta.summary,
    })
}

fn fits<T: serde::de::DeserializeOwned>(value: &Value) -> Option<T> {
    serde_json::from_value(value.clone()).ok()
}

/// The field-level repairs of `normalizeSummary`: a damaged optional field is dropped, never
/// the whole checkpoint.
fn drop_invalid_optional_fields(object: &mut serde_json::Map<String, Value>) {
    use cos_types::session::{AutoTitle, SelectedModel, TitleSource, WorkerAssignmentSummary};
    if let Some(retired) = object.get("retiredChatAt").cloned() {
        let chats: Vec<String> = object
            .get("chatIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let current = object
            .get("conversationId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let kept: serde_json::Map<String, Value> = retired
            .as_object()
            .map(|retired| {
                retired
                    .iter()
                    .filter(|(chat, at)| {
                        chats.contains(chat)
                            && current.as_deref() != Some(chat.as_str())
                            && at.as_f64().is_some_and(|at| at.is_finite() && at >= 0.0)
                    })
                    .map(|(chat, at)| (chat.clone(), at.clone()))
                    .collect()
            })
            .unwrap_or_default();
        object.insert("retiredChatAt".into(), Value::Object(kept));
    }
    if object
        .get("titleSource")
        .is_some_and(|source| fits::<TitleSource>(source).is_none())
    {
        object.remove("titleSource");
    }
    let manual = object.get("titleSource").and_then(Value::as_str) == Some("manual");
    if object
        .get("autoTitle")
        .is_some_and(|auto| !manual || fits::<AutoTitle>(auto).is_none())
    {
        object.remove("autoTitle");
    }
    let model_ok = |selected: &Value| {
        fits::<SelectedModel>(selected).is_some_and(|selected| {
            (1..=80).contains(&selected.model.len())
                && selected
                    .model
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b" ._-".contains(&b))
        })
    };
    if object
        .get("selectedModel")
        .is_some_and(|selected| !model_ok(selected))
    {
        object.remove("selectedModel");
    }
    let activity_ok = |activity: &Value| {
        activity.is_null()
            || fits::<ToolActivity>(activity)
                .is_some_and(|activity| (1..=200).contains(&js::len(&activity.title)))
    };
    if object
        .get("lastToolActivity")
        .is_some_and(|activity| !activity_ok(activity))
    {
        object.remove("lastToolActivity");
    }
    let assignment_ok = |assignment: &Value| {
        fits::<WorkerAssignmentSummary>(assignment).is_some_and(|assignment| {
            js::len(&assignment.label) <= 60 && js::len(&assignment.task) <= 8200
        })
    };
    if object
        .get("workerAssignment")
        .is_some_and(|assignment| !assignment_ok(assignment))
    {
        object.remove("workerAssignment");
    }
    let finish_ok = |finish: &Value| {
        fits::<Option<FinishTurn>>(finish).is_some_and(|finish| {
            finish.is_none_or(|finish| {
                finish
                    .decision_input_revision
                    .as_deref()
                    .is_none_or(is_lower_hex_64)
                    && finish
                        .decision_revision
                        .as_deref()
                        .is_none_or(is_lower_hex_64)
            })
        })
    };
    if object
        .get("finishTurn")
        .is_some_and(|finish| !finish_ok(finish))
    {
        object.remove("finishTurn");
    }
}

/// The persisted form of a summary at `history_seq` (`PersistedSummary`).
pub(crate) fn persisted(summary: &SessionSummary, history_seq: u64) -> SessionMeta {
    SessionMeta {
        summary: summary.clone(),
        history_seq: Some(history_seq),
        canonical_projection: Some(1),
        token_estimate: Some(1),
    }
}

/// The identity a canonical message or process call is stored under (`messageKey`).
pub(crate) fn message_key(event: &SessionEvent) -> Option<String> {
    match event {
        SessionEvent::ToolCall(call) if !call.call.call_id.is_empty() => {
            Some(format!("tool_call\u{0}{}", call.call.call_id))
        }
        SessionEvent::NativeImage(image)
            if !image.message_id.is_empty() && !image.provider_asset_id.is_empty() =>
        {
            Some(format!(
                "native_image\u{0}{}\u{0}{}",
                image.message_id, image.provider_asset_id
            ))
        }
        SessionEvent::UserMessage(message) => message
            .message_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .map(|id| format!("user_message\u{0}{id}")),
        SessionEvent::AssistantMessage(message) => message
            .message_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .map(|id| format!("assistant_message\u{0}{id}")),
        _ => None,
    }
}

/// Orders summaries newest first (`compareSummariesNewestFirst`).
pub(crate) fn newest_first(left: &SessionSummary, right: &SessionSummary) -> std::cmp::Ordering {
    right
        .updated_at
        .cmp(&left.updated_at)
        .then_with(|| right.id.as_str().cmp(left.id.as_str()))
}
