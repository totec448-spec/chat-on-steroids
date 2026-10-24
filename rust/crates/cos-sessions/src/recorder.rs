//! One finished call as a `tool_call` event (`fileToolCall` and `storeText` in
//! `src/main/session/recorder.ts`). A call with no browser proof goes to this process's
//! Unattributed session.

use base64::Engine;
use cos_tools::{CallRecord, Content};
use cos_types::json::{Extra, JsNumber};
use cos_types::session::{
    AssetRef, AttributionMethod, CallAttribution, EventBase, EventSource, SessionEvent, StoredText,
    ToolCallEvent, ToolCallRecord,
};

use crate::summarize::{self, SummaryInput};
use crate::{SessionStore, js, redact};

const MAX_TOOL_ARGS_CHARS: usize = 8_000;
const MAX_TOOL_RESULT_CHARS: usize = 8_000;
/// Nothing is spilled to an overflow asset past this; the inline note records the shortfall.
const MAX_OVERFLOW_ASSET_CHARS: usize = 8 * 1024 * 1024;

/// Where a call is filed.
struct Target {
    session: cos_types::ids::SessionId,
    conversation: Option<String>,
    attribution: CallAttribution,
}

/// `storeText`: inline up to `cap` UTF-16 units, the whole text spilled to an asset beyond.
pub(crate) async fn store_text(
    store: &SessionStore,
    session: &cos_types::ids::SessionId,
    value: String,
    cap: usize,
) -> StoredText {
    let chars = js::len(&value);
    if chars <= cap {
        return StoredText {
            text: value,
            truncated: false,
            chars: chars as u64,
            asset_id: None,
            digest: None,
            extra: Extra::new(),
        };
    }
    let asset = if chars > MAX_OVERFLOW_ASSET_CHARS {
        None
    } else {
        match store
            .write_asset(session, value.as_bytes().to_vec(), "text/plain")
            .await
        {
            Ok(asset) => Some(asset.id),
            Err(error) => {
                if error != crate::GLOBAL_ASSET_QUOTA_EXCEEDED {
                    store.logger().warn(&format!(
                        "session {session}: overflow text not stored: {error}"
                    ));
                }
                None
            }
        }
    };
    let rest = chars - cap;
    let note = match &asset {
        Some(id) => format!("\n\u{2026}[{rest} more characters stored in full as {id}]"),
        None => format!("\n\u{2026}[{rest} more characters were too large to store and are lost]"),
    };
    StoredText {
        text: format!("{}{note}", js::prefix(&value, cap)),
        truncated: true,
        chars: chars as u64,
        asset_id: asset,
        digest: None,
        extra: Extra::new(),
    }
}

async fn target(store: &SessionStore, call: &CallRecord<'_>) -> Result<Target, String> {
    if let Some((conversation, session)) = &call.caller.chat {
        // Exact proof names the session; it must still own that chat.
        let owned = store.get_summary(session).await.is_some_and(|summary| {
            summary
                .chat_ids
                .iter()
                .any(|chat| chat == conversation.as_str())
        });
        if owned {
            return Ok(Target {
                session: session.clone(),
                conversation: Some(conversation.as_str().to_owned()),
                attribution: CallAttribution::RequestId,
            });
        }
        return Err(format!(
            "request attribution session {session} for conversation {} is unavailable; refusing to downgrade to a newer conversation epoch",
            conversation.as_str()
        ));
    }
    Ok(Target {
        session: store.unattributed_session().await?,
        conversation: None,
        attribution: CallAttribution::Unattributed,
    })
}

/// Files one finished call. Never fails the call: a storage failure is logged.
pub(crate) async fn record(store: &SessionStore, call: CallRecord<'_>) {
    if let Err(error) = file(store, &call).await {
        store.logger().warn(&format!(
            "session recorder could not store a tool call: {error}"
        ));
    }
}

async fn file(store: &SessionStore, call: &CallRecord<'_>) -> Result<(), String> {
    let target = target(store, call).await?;
    let session = &target.session;
    let texts: Vec<&str> = call
        .result
        .content
        .iter()
        .filter_map(|part| match part {
            Content::Text { text } => Some(text.as_str()),
            Content::Image { .. } => None,
        })
        .collect();
    let result_text = redact::result(call.tool, &texts.join("\n"));
    let mut assets: Vec<AssetRef> = Vec::new();
    let mut missing_images = 0usize;
    let mut reasons: Vec<&'static str> = Vec::new();
    for part in &call.result.content {
        let Content::Image { data, mime_type } = part else {
            continue;
        };
        let stored = match base64::engine::general_purpose::STANDARD.decode(data) {
            Ok(bytes) if !bytes.is_empty() && bytes.len() <= crate::disk::MAX_ASSET_BYTES => {
                store.write_asset(session, bytes, mime_type).await
            }
            _ => Err("Session image exceeds the recording limit".to_owned()),
        };
        match stored {
            Ok(asset) => assets.push(asset),
            Err(message) => {
                missing_images += 1;
                let reason = match message.as_str() {
                    crate::GLOBAL_ASSET_QUOTA_EXCEEDED | crate::SESSION_ASSET_QUOTA_EXCEEDED => {
                        "recording storage limit reached"
                    }
                    "Session image exceeds the recording limit" => "recording image size limit",
                    _ => "recording write failed",
                };
                if !reasons.contains(&reason) {
                    reasons.push(reason);
                }
                if message != crate::GLOBAL_ASSET_QUOTA_EXCEEDED {
                    store
                        .logger()
                        .warn(&format!("session image not stored: {reason}"));
                }
            }
        }
    }
    let duration_ms = call.finished_at.0.saturating_sub(call.started_at.0) as f64;
    let head = result_text.split('\n').next().unwrap_or("");
    let mut summary = summarize::summarize(&SummaryInput {
        tool: call.tool,
        args: call.arguments,
        notes: call.notes,
        outcome: call.outcome,
        duration_ms,
        result_head: head,
    });
    if missing_images > 0 {
        let notice = format!(
            "{missing_images} image preview(s) not saved: {}. Image content remains in the tool response.",
            reasons.join("; ")
        );
        summary.detail = Some(
            match summary.detail.take().filter(|detail| !detail.is_empty()) {
                Some(detail) => format!("{detail} \u{b7} {notice}"),
                None => notice,
            },
        );
        if summary.tone != cos_types::session::ActivityTone::Bad {
            summary.tone = cos_types::session::ActivityTone::Warn;
        }
    }
    let args_text =
        redact::credential_text(&js::stringify(&redact::args(call.tool, call.arguments)));
    let request_id = call
        .caller
        .request_id
        .as_ref()
        .map(|id| id.as_str().to_owned());
    let attribution_method = if target.conversation.is_some() && request_id.is_some() {
        AttributionMethod::RequestId
    } else {
        AttributionMethod::Unattributed
    };
    let record = ToolCallRecord {
        nested: call.nested.then_some(true),
        process: None,
        model: None,
        reasoning_effort: None,
        call_id: js::random_uuid(),
        tool: call.tool.to_owned(),
        attribution: target.attribution,
        request_id,
        conversation_id: target.conversation.clone(),
        attribution_method,
        args: store_text(store, session, args_text, MAX_TOOL_ARGS_CHARS).await,
        result: store_text(store, session, result_text, MAX_TOOL_RESULT_CHARS).await,
        outcome: call.outcome,
        duration_ms: JsNumber(duration_ms),
        summary,
        changes: (!call.notes.changes.is_empty()).then(|| call.notes.changes.clone()),
        assets: (!assets.is_empty()).then_some(assets),
        retired_image_asset_ids: None,
        ends_activity: None,
        extra: Extra::new(),
    };
    let event = SessionEvent::ToolCall(Box::new(ToolCallEvent {
        base: EventBase {
            model: None,
            reasoning_effort: None,
            seq: 0,
            time: call.started_at.0,
            authored_at: None,
            turn_origin: None,
            source: EventSource::Mcp,
            agent: None,
            turn_id: None,
        },
        call: record,
        origin: None,
        extra: Extra::new(),
    }));
    store.append(session, event).await.map(|_| ())
}
