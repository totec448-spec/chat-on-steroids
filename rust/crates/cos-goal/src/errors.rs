//! What a Goal failure means: whether asking again can answer it (`SETTLED_FAILURE`), and the
//! plain explanation and catalog key the page shows (`shared/goal-errors.ts`).

/// Failures that asking again cannot answer, whoever asks and however long they wait.
const SETTLED: &[&str] = &[
    "auth_rejected",
    "out_of_credit",
    "unknown_model",
    "no_api_key",
    "no_conversation",
    "no_objective",
    "invalid_provider",
    "goal_marker_missing",
    "goal_browser_cancelled",
    "goal_browser_send_unconfirmed",
    "goal_browser_send_failed",
];

/// `retryableGoalFailure`: everything that is not a setting is weather.
pub fn retryable(error: &str) -> bool {
    !SETTLED.iter().any(|code| {
        error
            .strip_prefix(code)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
    })
}

const EXPLANATIONS: &[(&str, &str)] = &[
    (
        "loop_mcp_call_missing",
        "No MCP tool call was recorded in the last response. ChatGPT may be asking you something, or the tool connection may have been lost. Answer it, or check the tunnel if tools stopped working. Automatic continuation is paused; Loop remains enabled.",
    ),
    (
        "goal_reply_not_pending",
        "There is no pending continuation for this answer. It may already have been handled or replaced by newer work. Check the latest chat activity before trying again.",
    ),
    (
        "goal_context_too_large",
        "The task and Goal/Loop instructions are too long to send to the helper. Shorten the task or the custom continuation instructions in Settings.",
    ),
    (
        "reply_too_long",
        "The helper wrote a continuation that is too long to send. Ask for shorter continuation instructions or choose another helper model in Settings.",
    ),
    (
        "stream_record_too_long",
        "The provider returned an oversized response. Choose another continuation model or ask for shorter replies.",
    ),
    (
        "response_body_too_large",
        "The provider response exceeded the size limit. Choose another continuation model or ask for shorter replies.",
    ),
    (
        "no_api_key",
        "No API key is configured for the continuation provider. Add one in Settings, or select the ChatGPT continuation source.",
    ),
    (
        "auth_rejected",
        "The continuation provider rejected the API credentials. Check its API key and access permissions in Settings.",
    ),
    (
        "out_of_credit",
        "The continuation provider account has no credit available. Add credit or choose another continuation source in Settings.",
    ),
    (
        "unknown_model",
        "The continuation provider could not find the selected model. Refresh its model list and choose an available model in Settings.",
    ),
    (
        "invalid_provider",
        "The custom continuation endpoint is invalid. Check its URL in Settings; use HTTPS or a local HTTP endpoint.",
    ),
    (
        "rate_limited",
        "The continuation provider is rate-limiting requests. Wait for the displayed retry, or choose another continuation model.",
    ),
    (
        "timeout_or_cancelled",
        "The continuation request timed out or was cancelled. Check the helper chat or provider status before trying again.",
    ),
    (
        "request_failed",
        "The continuation request failed. Check the selected helper or API endpoint and the app diagnostics before trying again.",
    ),
    (
        "goal_browser_busy",
        "A helper request is already pending. Let it finish or cancel that request before starting another.",
    ),
    (
        "goal_browser_cancelled",
        "The helper request was cancelled. Start it again when you want to continue.",
    ),
    (
        "goal_browser_send_failed",
        "The helper prompt could not be delivered to ChatGPT. Open the helper chat and check its composer or visible error before trying again.",
    ),
    (
        "goal_browser_send_unconfirmed",
        "The app could not confirm whether ChatGPT received the helper prompt. Check the helper chat before retrying to avoid sending it twice.",
    ),
    (
        "goal_owned_elsewhere",
        "Another browser tab is handling this continuation. Check that tab for progress.",
    ),
    (
        "goal_final_not_confirmed",
        "The app has not confirmed a final answer eligible for automatic continuation. Check the source chat for ongoing work or an error.",
    ),
    (
        "astra_finish_only",
        "This chat continues through the finish tool. A final browser answer does not trigger another message with the current setting.",
    ),
    (
        "goal_disabled",
        "Goal/Loop is off for this chat. Turn it on to allow continuation.",
    ),
    (
        "goal_worker_chat",
        "Workers cannot run their own Goal/Loop. Enable continuation in the parent chat instead.",
    ),
    (
        "conversation_superseded",
        "This chat was replaced by Compact & Resume. Continue in its successor chat.",
    ),
    (
        "chat_blocked",
        "This chat is blocked in the app. Unblock it there before enabling continuation.",
    ),
    (
        "session_not_recorded",
        "The app has no recorded history for this chat. Enable recording and send a message before using automatic continuation.",
    ),
    (
        "no_conversation",
        "No recorded conversation is available to continue. Send a task first.",
    ),
    (
        "no_objective",
        "No task was provided. Enter a task before starting Goal/Loop.",
    ),
    (
        "nothing_to_open_with",
        "The helper did not produce an opening message. Make the task more specific and try again.",
    ),
    (
        "loop_stop_refused",
        "The helper kept choosing to stop instead of writing a Loop continuation. Review the Loop instructions or choose another helper model.",
    ),
    (
        "goal_marker_missing",
        "The answer is missing the completion marker required by offline Goal templates. Check the template instructions or choose another continuation source.",
    ),
    (
        "goal_reply_not_durable",
        "The app could not save the pending continuation. Check free disk space and the app diagnostics.",
    ),
    (
        "goal_ack_not_durable",
        "The app could not save the delivery confirmation. Check free disk space; check the chat before manually resending.",
    ),
    (
        "goal_switch_not_durable",
        "The app could not save the Goal/Loop setting. Check free disk space and try saving it again.",
    ),
    (
        "goal_objective_not_durable",
        "The app could not save the task. Check free disk space and try saving it again.",
    ),
];

fn explanation(code: &str) -> Option<&'static str> {
    EXPLANATIONS
        .iter()
        .find(|(key, _)| *key == code)
        .map(|(_, text)| *text)
}

/// Opening, finish and planner requests wrap transport failures. Unwrap only that envelope,
/// with a bound; the machine code stays intact.
fn unwrap(error: &str) -> (&str, bool) {
    let mut raw = crate::js::trim(error);
    let mut wrapped = false;
    for _ in 0..4 {
        let Some(rest) = raw.strip_prefix("request_failed:") else {
            break;
        };
        raw = crate::js::trim(rest);
        wrapped = true;
    }
    (raw, wrapped)
}

fn code_of(raw: &str) -> &str {
    raw.split(':').next().unwrap_or(raw)
}

const UNUSABLE: &[&str] = &[
    "invalid_goal_decision_json",
    "invalid_goal_decision_schema",
    "malformed_completion_response",
    "malformed_stream_record",
    "empty_reply",
    "control_tokens_only",
    "unsafe_control_tokens",
];

fn provider_error(code: &str) -> bool {
    code == "provider_completion_error" || code == "provider_stream_error"
}

fn http_status(code: &str) -> Option<&str> {
    let digits = code.strip_prefix("http_")?;
    (digits.len() == 3 && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
}

/// `goalErrorKey`: the catalog key of a fixed explanation, or `None` when the explanation
/// carries detail and must stay as sent.
pub fn error_key(error: &str) -> Option<&'static str> {
    let (raw, wrapped) = unwrap(error);
    let code = code_of(raw);
    if code == "goal_browser_send_failed" && raw.contains(':') {
        return None;
    }
    if let Some((key, _)) = EXPLANATIONS.iter().find(|(key, _)| *key == code) {
        return Some(key);
    }
    if UNUSABLE.contains(&code) || provider_error(code) || http_status(code).is_some() {
        return None;
    }
    wrapped.then_some("request_failed")
}

/// `goalErrorMessage`: the failure in words for the browser and the desktop.
pub fn error_message(error: &str) -> String {
    let (raw, wrapped) = unwrap(error);
    let code = code_of(raw);
    if code == "goal_browser_send_failed"
        && let Some(at) = raw.find(':')
    {
        let detail = crate::js::prefix(crate::js::trim(&raw[at + 1..]), 200);
        return format!("The helper prompt could not be delivered. {detail}");
    }
    if let Some(text) = explanation(code) {
        return text.to_owned();
    }
    if UNUSABLE.contains(&code) {
        return "The helper returned an unusable continuation. Nothing was sent. Review the continuation instructions or choose another helper model.".to_owned();
    }
    if provider_error(code) {
        return "The provider reported an error while generating the continuation. Check its status or choose another model.".to_owned();
    }
    if let Some(status) = http_status(code) {
        return format!(
            "The continuation provider rejected the request (HTTP {status}). Check its status and the configured model or endpoint."
        );
    }
    if wrapped {
        return explanation("request_failed").unwrap_or_default().to_owned();
    }
    let bare = raw.len() > 1
        && raw.as_bytes()[0].is_ascii_lowercase()
        && raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if bare {
        return format!(
            "The continuation could not proceed. Check the app diagnostics for details ({raw})."
        );
    }
    raw.to_owned()
}
