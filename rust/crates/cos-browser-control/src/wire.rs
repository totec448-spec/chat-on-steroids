//! `POST /browser-control` and `/cos-browser/sign-in` as `bridge.ts` answers them: the body
//! parsed at the wire, then one broker or transfer operation.

use cos_tools::Capability;
use cos_types::mcp::{BrowserImage, BrowserResult, ImageMimeType};
use serde_json::{Map, Value, json};

use crate::broker::OwnerProof;
use crate::sign_in::{SignInError, SignInMethod};
use crate::{BrowserControl, TooManyBrowsers};

/// A route's answer: the status and the JSON body `bridge.ts` sends.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
}

impl Answer {
    fn new(status: u16, body: Value) -> Self {
        Self { status, body }
    }

    fn error(status: u16, word: &str) -> Self {
        Self::new(status, json!({ "error": word }))
    }

    /// What `handle()` answers when a route throws.
    pub fn internal() -> Self {
        Self::error(500, "internal")
    }
}

/// `/^[a-f\d-]{36}$/i`.
fn browser_id(text: &str) -> bool {
    text.len() == 36
        && text
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

/// A JavaScript string's `length`.
fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A command reference: `id` and `epoch`, each a string of at most 100 units.
fn reference(body: &Map<String, Value>) -> Option<(&str, &str)> {
    let id = body.get("id")?.as_str()?;
    let epoch = body.get("epoch")?.as_str()?;
    (units(id) <= 100 && units(epoch) <= 100).then_some((id, epoch))
}

/// `body.owners`: absent, or at most 32 `request:` owners of at most 1024 units.
fn owners(body: &Map<String, Value>) -> Result<Vec<&str>, ()> {
    let Some(owners) = body.get("owners") else {
        return Ok(Vec::new());
    };
    let owners = owners.as_array().ok_or(())?;
    if owners.len() > 32 {
        return Err(());
    }
    owners
        .iter()
        .map(|owner| match owner.as_str() {
            Some(text) if text.starts_with("request:") && units(text) <= 1024 => Ok(text),
            _ => Err(()),
        })
        .collect()
}

/// `body.result` as the broker takes it, or `None` for the shapes `bridge.ts` refuses: an
/// `error` that is not a string, or an image whose data is not a string or whose type is not
/// PNG or JPEG.
fn result(raw: &Map<String, Value>) -> Option<BrowserResult> {
    let error = match raw.get("error") {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return None,
    };
    let image = match raw.get("image") {
        None | Some(Value::Null | Value::Bool(false)) => None,
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(image) => {
            let data = image.get("data")?.as_str()?.to_owned();
            let mime_type = match image.get("mimeType")?.as_str()? {
                "image/png" => ImageMimeType::Png,
                "image/jpeg" => ImageMimeType::Jpeg,
                _ => return None,
            };
            Some(BrowserImage { data, mime_type })
        }
    };
    Some(BrowserResult {
        value: raw.get("value").cloned(),
        image,
        error,
    })
}

impl BrowserControl {
    /// `POST /browser-control`: the extension polls, claims, checks and reports.
    pub async fn answer(&self, body: &Value) -> Answer {
        let invalid = || Answer::error(400, "invalid_browser_request");
        let Some(body) = body.as_object() else {
            return invalid();
        };
        let Some(browser) = body
            .get("browserId")
            .and_then(Value::as_str)
            .filter(|id| browser_id(id))
        else {
            return invalid();
        };
        let action = body.get("action").and_then(Value::as_str);
        if action == Some("poll")
            && let (Some(Value::Bool(enabled)), Some(Value::String(name))) =
                (body.get("enabled"), body.get("name"))
        {
            let grants = self.grants();
            return match self.broker.poll(browser, name, *enabled) {
                Ok(poll) => Answer::new(
                    200,
                    json!({
                        "epoch": poll.epoch,
                        "requests": poll.requests,
                        "policy": {
                            "read": grants.capabilities.contains(Capability::Screen),
                            "write": grants.capabilities.contains(Capability::Control),
                        },
                    }),
                ),
                Err(TooManyBrowsers) => Answer::internal(),
            };
        }
        let Some((id, epoch)) = reference(body) else {
            return invalid();
        };
        match action {
            Some("claim") => {
                let Ok(owners) = owners(body) else {
                    return Answer::error(400, "invalid_browser_owners");
                };
                let proofs: Vec<OwnerProof> = owners
                    .into_iter()
                    .filter_map(|owner| {
                        let chat = self.proof.proven(&owner["request:".len()..])?;
                        Some(OwnerProof {
                            owner: owner.to_owned(),
                            session: chat.session.to_string(),
                        })
                    })
                    .collect();
                let command = self.broker.claim(browser, id, epoch, &proofs).await;
                let status = if command.is_some() { 200 } else { 409 };
                Answer::new(status, json!({ "command": command }))
            }
            Some("check") => {
                let allowed = self.broker.check(browser, id, epoch).await;
                Answer::new(200, json!({ "allowed": allowed }))
            }
            Some("result") => {
                let Some(raw) = body.get("result").and_then(Value::as_object) else {
                    return invalid();
                };
                let Some(result) = result(raw) else {
                    return Answer::error(400, "invalid_browser_result");
                };
                let accepted = self.broker.result(browser, id, epoch, result);
                Answer::new(if accepted { 200 } else { 409 }, json!({ "ok": accepted }))
            }
            _ => invalid(),
        }
    }

    /// `/cos-browser/sign-in`. `browser` is the request's `x-extension-browser`; `body` is read
    /// only for a `POST` that gets that far, with the 96 KiB cap, and is `None` when it could
    /// not be read.
    pub async fn sign_in_answer<F>(
        &self,
        method: SignInMethod,
        browser: Option<&str>,
        body: F,
    ) -> Answer
    where
        F: Future<Output = Option<Value>>,
    {
        if !self.cos_browser() {
            return Answer::error(409, "transfer_expired");
        }
        match method {
            SignInMethod::Get => {
                return Answer::new(200, json!({ "offer": self.transfer.pending() }));
            }
            SignInMethod::Post => {}
            SignInMethod::Other => return Answer::error(405, "method_not_allowed"),
        }
        let Some(browser) = browser else {
            return Answer::error(400, "invalid_browser_request");
        };
        let bad_request = || Answer::error(400, "bad_request");
        let Some(Value::Object(fields)) = body.await else {
            return bad_request();
        };
        let id = match fields.get("id") {
            Some(Value::String(id)) if browser_id(id) => id.clone(),
            _ => return bad_request(),
        };
        if fields.keys().any(|key| key != "id" && key != "cookies") {
            return bad_request();
        }
        let cookies = fields.get("cookies").cloned().unwrap_or(Value::Null);
        let control = self.clone();
        let current = move || control.cos_browser();
        match self.transfer.accept(&id, browser, &cookies, current).await {
            Ok(()) => Answer::new(200, json!({ "ok": true, "imported": true })),
            Err(error @ (SignInError::InvalidSession | SignInError::BadRequest)) => {
                Answer::error(400, error.reason())
            }
            Err(error) => Answer::error(409, error.reason()),
        }
    }
}
