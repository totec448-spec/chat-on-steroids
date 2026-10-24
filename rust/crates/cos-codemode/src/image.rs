//! An image a script emitted, checked before it reaches the model (`emittedImage`). A URL is
//! never fetched: only a base64 `data:` URL or an MCP image content item is accepted.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cos_fs::{MAX_VIEW_IMAGE_BYTES, validate_image_bytes};
use cos_tools::Content;
use serde_json::Value;

const MAX_BASE64_CHARS: u64 = MAX_VIEW_IMAGE_BYTES.div_ceil(3) * 4;

/// The emitted value as an MCP image item, or `None` when it is not an image that decodes,
/// by the same check `view_image` applies. CPU work: call it on a blocking thread.
pub(crate) fn emitted_image(value: &Value) -> Option<Content> {
    let (mime, data) = match value {
        Value::String(url) => data_url(url)?,
        Value::Object(fields) if fields.contains_key("image_url") => {
            data_url(fields.get("image_url")?.as_str()?)?
        }
        Value::Object(fields) if fields.get("type") == Some(&Value::from("image")) => (
            fields.get("mimeType")?.as_str()?,
            fields.get("data")?.as_str()?,
        ),
        _ => return None,
    };
    if data.len() as u64 > MAX_BASE64_CHARS || !data.len().is_multiple_of(4) || !is_base64(data) {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    if STANDARD.encode(&bytes) != data {
        return None;
    }
    let actual = validate_image_bytes(&bytes)?.as_str();
    if mime != actual && mime != "application/octet-stream" {
        return None;
    }
    Some(Content::Image {
        data: data.to_owned(),
        mime_type: actual.to_owned(),
    })
}

/// `/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/`: the MIME type and the payload.
fn data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (mime, data) = rest.split_once(";base64,")?;
    if mime.is_empty() || mime.contains([';', ',']) || !is_base64(data) {
        return None;
    }
    Some((mime, data))
}

/// `/^[A-Za-z0-9+/]*={0,2}$/`.
fn is_base64(data: &str) -> bool {
    let body = data.trim_end_matches('=');
    data.len() - body.len() <= 2
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}
