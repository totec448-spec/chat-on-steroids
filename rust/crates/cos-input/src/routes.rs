//! The outbox's bridge routes (`/input/*`, `/conversation-deleted`, `/image-export` in
//! `bridge.ts`), as status and body. The family in `cos-bridge` reads the body and calls these.

use serde_json::{Value, json};

use crate::outbox::Outbox;
use crate::{Answer, OutboxError};

/// The largest original image `/image-export` accepts, base64, plus the JSON around it.
pub const IMAGE_EXPORT_BODY_BYTES: usize = (25usize * 1024 * 1024).div_ceil(3) * 4 + 64 * 1024;

/// `conversationId` in `bridge.ts`.
fn conversation_id(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    ((8..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
        .then(|| text.to_owned())
}

/// `/^[a-f0-9-]{36}$/i`.
fn input_id(text: &str) -> bool {
    text.len() == 36 && text.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn detail_word(text: &str) -> bool {
    (1..=40).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
}

fn thrown(result: Result<Answer, OutboxError>) -> Answer {
    result.unwrap_or_else(|_| Answer::internal())
}

impl Outbox {
    /// One of `/input/{claim,bind,ack,fail,answer,progress,attachment}`.
    pub async fn answer(&self, route: &str, body: &Value) -> Answer {
        let id = body.get("id").and_then(Value::as_str);
        let owner = body.get("owner").and_then(Value::as_str);
        let (Some(id), Some(owner)) = (id, owner) else {
            return Answer::error(400, "invalid_input_claim");
        };
        if !input_id(id) || owner.encode_utf16().count() > 160 {
            return Answer::error(400, "invalid_input_claim");
        }
        thrown(self.route(route, id, owner, body).await)
    }

    async fn route(
        &self,
        route: &str,
        id: &str,
        owner: &str,
        body: &Value,
    ) -> Result<Answer, OutboxError> {
        match route {
            "/input/attachment" => self.attachment(id, owner, body).await,
            "/input/fail" => {
                let error = body
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Unable to prepare ChatGPT");
                let detail = body
                    .get("detail")
                    .and_then(Value::as_str)
                    .filter(|detail| detail_word(detail));
                let ok = self.fail(id, owner, error, detail).await?;
                Ok(Answer::ok(json!({ "ok": ok })))
            }
            "/input/progress" => {
                // A Goal helper's partial answer is shown to its waiter, which this build has
                // none of; the list read keeps the same side effects.
                self.list().await?;
                Ok(Answer::ok(json!({ "ok": false })))
            }
            "/input/bind" => {
                let Some(target) = conversation_id(body.get("conversationId")) else {
                    return Ok(Answer::error(400, "bad_conversation_id"));
                };
                let ok = self.bind(id, owner, &target).await?;
                Ok(Answer::ok(json!({ "ok": ok })))
            }
            "/input/answer" | "/input/ack" => self.receipt(route, id, owner, body).await,
            _ => self.claim_route(id, owner, body).await,
        }
    }

    async fn attachment(&self, id: &str, owner: &str, body: &Value) -> Result<Answer, OutboxError> {
        use cos_types::state::InputState;
        let rows = self.list().await?;
        let entry = rows.iter().find(|row| {
            row.id == id
                && row.owner.as_deref() == Some(owner)
                && row.state == InputState::Browser
                && row.send_authorized_at.is_none()
        });
        let companion = entry.and_then(|entry| {
            let companion_id = entry.companion_input_id.as_ref()?;
            rows.iter().find(|row| {
                &row.id == companion_id
                    && row.state == InputState::Browser
                    && row.send_authorized_at.is_none()
                    && row.owner == entry.owner
                    && row.session_id == entry.session_id
                    && row.conversation_id == entry.conversation_id
                    && row.completed_turn_id == entry.completed_turn_id
            })
        });
        let wanted = body.get("attachmentId");
        let attachment = entry
            .iter()
            .chain(companion.iter())
            .flat_map(|row| row.attachments.iter().flatten())
            .find(|file| wanted.and_then(Value::as_str) == Some(file.id.as_str()))
            .cloned();
        let same_chat = match (entry, body.get("conversationId")) {
            (Some(entry), Some(reported)) => {
                &entry
                    .conversation_id
                    .clone()
                    .map_or(Value::Null, Value::String)
                    == reported
            }
            _ => false,
        };
        let offset = body.get("offset").and_then(Value::as_f64);
        let (Some(attachment), true, Some(offset)) = (attachment, same_chat, offset) else {
            return Ok(Answer::error(409, "attachment_not_owned"));
        };
        if offset.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&offset) {
            return Err(OutboxError("Invalid attachment offset".into()));
        }
        let chunk =
            crate::attachments::read_chunk(&self.inner().user_data, &attachment, offset as u64)
                .await
                .map_err(OutboxError)?;
        Ok(Answer::ok(json!({ "chunk": chunk })))
    }

    async fn receipt(
        &self,
        route: &str,
        id: &str,
        owner: &str,
        body: &Value,
    ) -> Result<Answer, OutboxError> {
        use cos_types::state::{InputLifetime, InputPurpose, InputState};
        let rows = self.list().await?;
        let Some(entry) = rows
            .iter()
            .find(|row| row.id == id && row.owner.as_deref() == Some(owner))
        else {
            return Ok(Answer::error(409, "input_not_owned"));
        };
        let delivered = conversation_id(body.get("conversationId"));
        let planner = entry.lifetime == Some(InputLifetime::TemporaryPlanner);
        let decision = entry.purpose == Some(InputPurpose::Decision);
        let pending = match entry.state {
            InputState::Browser | InputState::Decision | InputState::Sent => true,
            InputState::Cancelled => !decision && route == "/input/ack",
            _ => false,
        };
        if (delivered.is_none() && !planner)
            || entry
                .conversation_id
                .as_ref()
                .is_some_and(|known| Some(known) != delivered.as_ref())
            || !pending
        {
            return Ok(Answer::error(409, "input_not_pending"));
        }
        if decision && !planner && delivered.is_none() {
            return Ok(Answer::error(409, "helper_conversation_not_ready"));
        }
        if route == "/input/answer" {
            let ok = match body.get("response").and_then(Value::as_str) {
                Some(response) => self.complete_decision(id, owner, response).await?,
                None => false,
            };
            return Ok(Answer::ok(json!({ "ok": ok })));
        }
        let message_id = body.get("messageId").and_then(Value::as_str);
        let ok = self
            .acknowledge(id, owner, Some(delivered.as_deref()), message_id)
            .await?;
        Ok(Answer::ok(json!({ "ok": ok })))
    }

    async fn claim_route(
        &self,
        id: &str,
        owner: &str,
        body: &Value,
    ) -> Result<Answer, OutboxError> {
        let reported = body.get("conversationId");
        let target = if reported == Some(&Value::Null) {
            None
        } else {
            match conversation_id(reported) {
                Some(target) => Some(target),
                None => return Ok(Answer::error(400, "bad_conversation_id")),
            }
        };
        let action = body.get("recoveryAction").and_then(Value::as_str);
        if matches!(action, Some("stop" | "stopped" | "reloaded")) {
            // Automatic Continue needs browser recovery, which is not ported yet.
            return Ok(Answer::ok(json!({ "ok": false })));
        }
        if body.get("recoveryVeto").and_then(Value::as_str) == Some("page-final") {
            let ended = match &target {
                Some(target) => self.end_recovery(id, target).await?,
                None => false,
            };
            return Ok(Answer::ok(json!({ "ok": ended })));
        }
        if body.get("silenceBusyTurnId").is_some_and(Value::is_string) {
            // A native busy refusal extends a silence ticket; tickets need call evidence this
            // build does not keep, so none is deferred.
            return Ok(Answer::ok(json!({ "ok": false })));
        }
        if body.get("authorize") == Some(&Value::Bool(true)) {
            let ok = self.authorize(id, owner, target.as_deref()).await?;
            return Ok(Answer::ok(json!({ "ok": ok })));
        }
        let requires = body.get("requiresAuthorization") == Some(&Value::Bool(true));
        let input = self.claim(id, owner, target.as_deref(), requires).await?;
        Ok(Answer::ok(json!({ "input": input })))
    }

    /// `POST /conversation-deleted`: the messages still waiting for that chat end.
    pub async fn deleted_answer(&self, body: &Value) -> Answer {
        let Some(id) = conversation_id(body.get("conversationId")) else {
            return Answer::error(400, "invalid_request");
        };
        match self.conversation_deleted(&id).await {
            Ok(ended) => {
                let note = if ended > 0 {
                    format!("; {ended} waiting message(s) ended")
                } else {
                    String::new()
                };
                self.inner()
                    .logger
                    .warn(&format!("bridge: ChatGPT says chat {id} was deleted{note}"));
                Answer::ok(json!({ "ok": true, "ended": ended }))
            }
            Err(_) => Answer::internal(),
        }
    }
}

/// `POST /image-export`: a page delivering one exported image. Exports are registered by the
/// image-export tool, which this build does not have, so every nonce is unknown.
pub fn image_export_answer(_body: &Value) -> Answer {
    Answer::ok(json!({ "ok": false }))
}
