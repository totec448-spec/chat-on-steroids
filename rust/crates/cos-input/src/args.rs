//! `inputArgs`: what a composer, the control API or a plan hands the outbox. Parsed at the
//! boundary; the outbox trusts an [`InputArgs`] after this.

use cos_types::session::{InputAttachment, ReasoningEffort};
use cos_types::state::{
    AuthoredSource, InputAutomation, InputEntry, InputImage, InputMode, InputState, ToolDelivery,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::text::{js_length, js_trim};

/// `MAX_CHATGPT_MESSAGE_CHARS`.
pub const MAX_CHATGPT_MESSAGE_CHARS: usize = 96_000;
/// `MAX_INPUT_IMAGES`.
pub const MAX_INPUT_IMAGES: usize = 10;
/// `MAX_ATTACHMENT_BYTES`.
pub const MAX_ATTACHMENT_BYTES: u64 = 512 * 1024 * 1024;

/// One accepted request, in `inputArgs` key order (the idempotence check compares it whole).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputArgs {
    #[serde(
        default,
        deserialize_with = "cos_types::json::nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub project_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation: Option<InputAutomation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_after_turn: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_source: Option<AuthoredSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stages: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<InputImage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<InputAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<ToolDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_delivery: Option<ToolDelivery>,
    pub id: String,
    pub session_id: Option<String>,
    pub text: String,
    pub mode: InputMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_turn: Option<bool>,
    pub due_at: u64,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
}

fn invalid(field: &str) -> String {
    format!("Invalid message: {field}")
}

/// zod 4's `z.string().uuid()`.
pub(crate) fn uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    let shaped = parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()));
    if !shaped {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    if lower == "00000000-0000-0000-0000-000000000000"
        || lower == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let version = lower.as_bytes()[14];
    let variant = lower.as_bytes()[19];
    (b'1'..=b'8').contains(&version) && matches!(variant, b'8' | b'9' | b'a' | b'b')
}

impl InputArgs {
    /// `inputArgs.parse`: the shape, the bounds, and the trims zod applies.
    pub fn parse(raw: &Value) -> Result<Self, String> {
        let mut args: Self =
            serde_json::from_value(raw.clone()).map_err(|error| invalid(&error.to_string()))?;
        args.text = js_trim(&args.text).to_owned();
        if args.text.is_empty() || js_length(&args.text) > MAX_CHATGPT_MESSAGE_CHARS {
            return Err(invalid("text"));
        }
        if !uuid(&args.id) {
            return Err(invalid("id"));
        }
        if let Some(Some(project)) = &args.project_id
            && !uuid(project)
        {
            return Err(invalid("projectId"));
        }
        if let Some(session) = &args.session_id
            && !(8..=64).contains(&js_length(session))
        {
            return Err(invalid("sessionId"));
        }
        if let Some(objective) = &mut args.objective {
            *objective = js_trim(objective).to_owned();
            if js_length(objective) > 16_000 {
                return Err(invalid("objective"));
            }
        }
        if let Some(stages) = &mut args.stages {
            if stages.len() > 11 {
                return Err(invalid("stages"));
            }
            for stage in stages.iter_mut() {
                *stage = js_trim(stage).to_owned();
                if stage.is_empty() || js_length(stage) > 16_000 {
                    return Err(invalid("stages"));
                }
            }
        }
        if args
            .model
            .as_ref()
            .is_some_and(|model| js_length(model) > 80)
        {
            return Err(invalid("model"));
        }
        if let Some(images) = &args.images
            && (images.len() > MAX_INPUT_IMAGES || images.iter().any(|image| !valid_image(image)))
        {
            return Err(invalid("images"));
        }
        if let Some(attachments) = &args.attachments
            && (attachments.len() > 20 || attachments.iter().any(|file| !valid_attachment(file)))
        {
            return Err(invalid("attachments"));
        }
        Ok(args)
    }

    /// The same request as a row once held it (`inputArgs.parse` of the stored row).
    pub(crate) fn of_row(row: &InputEntry) -> Self {
        Self {
            project_id: row.project_id.clone(),
            automation: row.automation,
            loop_after_turn: row.loop_after_turn,
            objective: row.objective.clone(),
            authored_source: row.authored_source,
            stages: row.stages.clone(),
            images: row.images.clone(),
            attachments: row.attachments.clone(),
            delivery: row.delivery,
            attachment_delivery: row.attachment_delivery,
            id: row.id.clone(),
            session_id: if row.opening.is_some() {
                row.requested_session_id.clone().flatten()
            } else {
                row.session_id.clone()
            },
            text: row.text.clone(),
            mode: row.requested_mode.unwrap_or(row.mode),
            after_turn: row.after_turn,
            due_at: row.due_at,
            model: row.model.clone(),
            reasoning_effort: row.reasoning_effort,
        }
    }

    /// A new queued row for this request.
    pub(crate) fn into_row(self, created_at: u64) -> InputEntry {
        InputEntry {
            project_id: self.project_id,
            automation: self.automation,
            loop_after_turn: self.loop_after_turn,
            objective: self.objective,
            authored_source: self.authored_source,
            stages: self.stages,
            images: self.images,
            attachments: self.attachments,
            delivery: self.delivery,
            attachment_delivery: self.attachment_delivery,
            id: self.id,
            session_id: self.session_id,
            text: self.text,
            mode: self.mode,
            after_turn: self.after_turn,
            due_at: self.due_at,
            model: self.model,
            reasoning_effort: self.reasoning_effort,
            opening: None,
            requested_session_id: None,
            auto_skills: None,
            tool_images: None,
            silence_boundary: None,
            queued_turn: None,
            recovery: None,
            direct_turn: None,
            finish_owner: None,
            requested_mode: None,
            transport_intent: None,
            delivery_text: None,
            companion_input_id: None,
            purpose: None,
            lifetime: None,
            decision_source_session_id: None,
            response: None,
            state: InputState::Queued,
            offered_at: None,
            tool_turn_id: None,
            send_authorized_at: None,
            requires_authorization: None,
            pickup_failed_at: None,
            pickup_retry_count: None,
            not_taken_retries: None,
            pickup_recovery: None,
            cancelled_by_user: None,
            error: None,
            owner: None,
            created_at,
            conversation_id: None,
            delivered_session_id: None,
            message_id: None,
            delivered_at: None,
            stages_applied: None,
            history_recorded: None,
            history_anchored: None,
            history_seq: None,
            completed_turn_id: None,
            queue_order: None,
            extra: Default::default(),
        }
    }
}

fn webp_data_url(text: &str, max: usize) -> bool {
    let Some(data) = text.strip_prefix("data:image/webp;base64,") else {
        return false;
    };
    let body = data.trim_end_matches('=');
    text.len() <= max
        && data.len() - body.len() <= 2
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

fn valid_image(image: &InputImage) -> bool {
    (1..=110).contains(&js_length(&image.name)) && webp_data_url(&image.data_url, 512_100)
}

/// `attachmentSchema`.
pub(crate) fn valid_attachment(file: &InputAttachment) -> bool {
    let mime = file.mime_type.split_once('/').is_some_and(|(kind, sub)| {
        let word = |text: &str| {
            !text.is_empty()
                && text
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'))
        };
        word(kind) && word(sub)
    });
    uuid(&file.id)
        && (1..=255).contains(&js_length(&file.name))
        && file.size <= MAX_ATTACHMENT_BYTES
        && js_length(&file.mime_type) <= 120
        && mime
        && file
            .preview
            .as_ref()
            .is_none_or(|preview| webp_data_url(preview, 32_768))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Value {
        json!({ "id": "0f8fad5b-d9cb-469f-a165-70867728950e", "sessionId": "2026-01-01-abcdef12",
            "text": "  hello  ", "mode": "auto", "dueAt": 1, "model": null, "reasoningEffort": null })
    }

    #[test]
    fn trims_text_and_refuses_what_zod_refuses() {
        let args = InputArgs::parse(&base()).expect("valid");
        assert_eq!(args.text, "hello");
        let mut blank = base();
        blank["text"] = json!("   ");
        assert!(InputArgs::parse(&blank).is_err());
        let mut short = base();
        short["sessionId"] = json!("abc");
        assert!(InputArgs::parse(&short).is_err());
        let mut id = base();
        id["id"] = json!("not-a-uuid");
        assert!(InputArgs::parse(&id).is_err());
    }
}
