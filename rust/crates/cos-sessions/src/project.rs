//! What a control API reader sees of a summary or an event (`control-reads.ts`): stored text
//! redacted and cut to the read caps, and only the fields a reader may have.

use cos_types::control_api::{
    ControlApiActivitySummary, ControlApiChange, ControlApiEvent, ControlApiOrigin,
    ControlApiPressure, ControlApiSession, ControlApiText, ControlApiToolCall,
};
use cos_types::session::{SessionEvent, SessionSummary, StoredText};

use crate::{js, redact, summary, timeline};

const TEXT_CAP: usize = 4_000;
const TOOL_TEXT_CAP: usize = 2_000;
const TITLE_CAP: usize = 200;
const TASK_CAP: usize = 1_000;
const SUMMARY_CAP: usize = 300;
const CHANGES_CAP: usize = 20;
const CHANGE_PATH_CAP: usize = 200;

/// `clip`: never ends on half of a surrogate pair.
fn clip(text: &str, cap: usize) -> (String, bool) {
    if js::len(text) <= cap {
        return (text.to_owned(), false);
    }
    (js::prefix(text, cap).to_owned(), true)
}

/// Redact first, then cut: a cut through a key must not leave a recognisable prefix.
fn line(value: &str, cap: usize) -> String {
    clip(&redact::secret_text(value), cap).0
}

fn stored(value: &StoredText, cap: usize) -> ControlApiText {
    let (text, clipped) = clip(&redact::secret_text(&value.text), cap);
    ControlApiText {
        text,
        chars: value.chars,
        truncated: value.truncated || clipped,
    }
}

fn plain(value: &str, cap: usize) -> ControlApiText {
    let (text, clipped) = clip(&redact::secret_text(value), cap);
    ControlApiText {
        text,
        chars: js::len(value) as u64,
        truncated: clipped,
    }
}

/// `projectSession`.
pub(crate) fn session(summary: &SessionSummary) -> ControlApiSession {
    let model = summary
        .selected_model
        .as_ref()
        .filter(|selected| Some(&selected.conversation_id) == summary.conversation_id.as_ref())
        .map(|selected| selected.model.clone());
    ControlApiSession {
        id: summary.id.as_str().to_owned(),
        title: line(&summary.title, TITLE_CAP),
        conversation_id: summary.conversation_id.clone(),
        project_id: summary.project_id.clone(),
        started_at: summary.started_at,
        updated_at: summary.updated_at,
        ended_at: summary.ended_at,
        events: summary.events,
        user_messages: summary.user_messages,
        tool_calls: summary.tool_calls,
        last_tool_call_at: summary.last_tool_call_at,
        last_assistant_final_at: summary.last_assistant_final_at.flatten(),
        last_turn_end_at: summary.last_turn_end_at.flatten(),
        activity_expires_at: summary.activity_expires_at.flatten(),
        errors: summary.errors,
        tool_rejected: summary.tool_rejected,
        tool_internal_errors: summary.tool_internal_errors,
        process_exit_nonzero: summary.process_exit_nonzero,
        estimated_tokens: summary.estimated_tokens,
        context_tokens: summary.context_tokens,
        last_turn_outcome: summary
            .last_turn_outcome
            .map(|outcome| outcome.as_str().to_owned()),
        active_turn_id: summary.active_turn_id.clone().flatten(),
        model,
        agents: summary.agents.clone(),
        origin: summary.origin.as_ref().map(|origin| ControlApiOrigin {
            kind: origin.kind.as_str().to_owned(),
            from_session_id: origin.from_session_id.clone(),
            agent_id: origin.agent_id.clone(),
            task: line(&origin.task, TASK_CAP),
        }),
    }
}

/// `tokenPressure` against the configured thresholds.
pub(crate) fn pressure(context_tokens: u64, advisory: u64, limit: u64) -> ControlApiPressure {
    let level = if context_tokens >= limit {
        "huge"
    } else if context_tokens >= advisory {
        "large"
    } else {
        "ok"
    };
    ControlApiPressure {
        level: level.into(),
        advisory,
        limit,
    }
}

fn base(event: &SessionEvent) -> ControlApiEvent {
    let common = event.base();
    ControlApiEvent {
        seq: common.seq,
        position: timeline::position_of(event),
        time: common.time,
        kind: timeline::kind_of(event).into(),
        source: common.source.as_str().into(),
        agent: common.agent.clone(),
        turn_id: common.turn_id.clone(),
        model: common.model.clone(),
        unreadable: None,
        message: None,
        message_id: None,
        input_id: None,
        input_delivery: None,
        attachments: None,
        images: None,
        is_final: None,
        state: None,
        resolved_model: None,
        conversation_id: None,
        title: None,
        outcome: None,
        detail: None,
        reason: None,
        recoverable: None,
        blocking: None,
        retry_at: None,
        label: None,
        preview_status: None,
        width: None,
        height: None,
        tool: None,
        from: None,
        to: None,
        delivery: None,
        handoff_id: None,
        chars: None,
    }
}

/// `projectEvent`.
pub(crate) fn event(event: &SessionEvent) -> ControlApiEvent {
    let mut out = base(event);
    match event {
        SessionEvent::SessionStart(start) => {
            out.conversation_id = Some(start.conversation_id.clone());
            out.title = Some(line(&start.title, TITLE_CAP));
        }
        SessionEvent::UserMessage(message) => {
            let authored = message
                .authored_text
                .clone()
                .or_else(|| redact::user_prompt_text(&message.message.text));
            out.message = Some(match authored {
                Some(authored) => plain(&authored, TEXT_CAP),
                None => stored(&message.message, TEXT_CAP),
            });
            out.message_id = message.message_id.clone();
            out.input_id = message.input_id.clone();
            out.input_delivery = message
                .input_delivery
                .map(|delivery| delivery.as_str().into());
            out.attachments = Some(message.attachments.as_ref().map_or(0, Vec::len) as u64);
            out.images = Some(message.assets.as_ref().map_or(0, Vec::len) as u64);
        }
        SessionEvent::AssistantMessage(message) => {
            out.message = Some(stored(&message.message, TEXT_CAP));
            out.message_id = message.message_id.clone();
            out.is_final = Some(message.is_final);
            out.state = message.state.map(|state| state.as_str().into());
            out.resolved_model = message.resolved_model.clone();
        }
        SessionEvent::NativeImage(image) => {
            out.preview_status = Some(image.preview_status.as_str().into());
            out.width = image.width;
            out.height = image.height;
        }
        SessionEvent::Progress(progress) => out.message = Some(stored(&progress.message, TEXT_CAP)),
        SessionEvent::Note(note) => out.message = Some(stored(&note.message, TEXT_CAP)),
        SessionEvent::PageTool(tool) => out.label = Some(line(&tool.label, SUMMARY_CAP)),
        SessionEvent::TurnStart(start) => {
            out.detail = start
                .detail
                .as_deref()
                .map(|detail| line(detail, SUMMARY_CAP));
        }
        SessionEvent::TurnEnd(end) => {
            out.outcome = Some(end.outcome.as_str().into());
            out.detail = end
                .detail
                .as_deref()
                .map(|detail| line(detail, SUMMARY_CAP));
            out.reason = end.reason.map(|reason| reason.as_str().into());
        }
        SessionEvent::ChatError(error) => {
            out.message = Some(stored(&error.message, TEXT_CAP));
            out.recoverable = error.recoverable;
            out.blocking = error.blocking;
            out.retry_at = error.retry_at;
            out.reason = error.reason.map(|reason| reason.as_str().into());
        }
        SessionEvent::ToolCall(tool) => {
            let call = &tool.call;
            let shown = summary::tool_call_summary(call);
            out.tool = Some(ControlApiToolCall {
                call_id: call.call_id.clone(),
                name: line(&call.tool, TITLE_CAP),
                outcome: summary::normalized_outcome(call)
                    .unwrap_or(call.outcome)
                    .as_str()
                    .into(),
                duration_ms: call.duration_ms,
                attribution: call.attribution.as_str().into(),
                summary: ControlApiActivitySummary {
                    title: line(&shown.title, SUMMARY_CAP),
                    detail: shown
                        .detail
                        .as_deref()
                        .map(|detail| line(detail, SUMMARY_CAP)),
                    metric: shown
                        .metric
                        .as_deref()
                        .map(|metric| line(metric, SUMMARY_CAP)),
                    tone: shown.tone.as_str().into(),
                    kind: shown.kind.as_str().into(),
                },
                args: stored(&call.args, TOOL_TEXT_CAP),
                result: stored(&call.result, TOOL_TEXT_CAP),
                changes: call
                    .changes
                    .iter()
                    .flatten()
                    .take(CHANGES_CAP)
                    .map(|change| ControlApiChange {
                        path: line(&change.path, CHANGE_PATH_CAP),
                        added: change.added,
                        removed: change.removed,
                    })
                    .collect(),
            });
        }
        SessionEvent::AgentMessage(message) => {
            out.message_id = Some(message.message_id.clone());
            out.from = Some(message.from.clone());
            out.to = Some(message.to.clone());
            out.message = Some(stored(&message.message, TEXT_CAP));
            out.delivery = Some(message.delivery.as_str().into());
        }
        SessionEvent::Handoff(handoff) => {
            out.handoff_id = Some(handoff.handoff_id.clone());
            out.chars = Some(handoff.chars);
            out.reason = Some(line(&handoff.reason, SUMMARY_CAP));
        }
    }
    out
}
