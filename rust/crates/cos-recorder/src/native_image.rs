//! An image ChatGPT generated in the chat (`native_image`): the page's report rebuilt field by
//! field (`parseObservations` in `bridge.ts`), then stored metadata first, with a small WebP
//! preview once the provider says the image is finished (`recordNativeImage` in
//! `src/main/session/recorder.ts`). It is transcript content only: it renews no activity,
//! closes no turn and is never a tool call.

use std::io::Cursor;

use base64::Engine;
use cos_types::bridge::PageObservation;
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{
    EventBase, NativeImageEvent, PreviewError, PreviewStatus, ProviderChannel, ProviderRole,
    ProviderStatus,
};
use serde_json::{Map, Value};

use crate::Recorder;

/// Images larger than this many source pixels get no preview.
const MAX_SOURCE_PIXELS: u64 = 30_000_000;
const MAX_SOURCE_SIDE: u64 = 30_000;
const MAX_PREVIEW_SIDE: u64 = 1600;
const MAX_PREVIEW_PIXELS: u64 = 2_560_000;
const MAX_DATA_URL_CHARS: usize = 512_100;
const MAX_PREVIEW_BYTES: usize = 384_000;
const DATA_URL_PREFIX: &str = "data:image/webp;base64,";

fn uuid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `/^file_[A-Za-z0-9_-]{8,100}$/`.
fn provider_asset(value: &str) -> bool {
    value.strip_prefix("file_").is_some_and(|rest| {
        (8..=100).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// A safe integer in `1..=max`, or `None`.
fn side(value: Option<&Value>, max: u64) -> Option<u64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number >= 1.0 && number <= max as f64).then_some(number as u64)
}

/// `/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/` and the length bound.
fn webp_data_url(value: &str) -> bool {
    let Some(data) = value.strip_prefix(DATA_URL_PREFIX) else {
        return false;
    };
    let body = data.trim_end_matches('=');
    value.len() <= MAX_DATA_URL_CHARS
        && data.len() - body.len() <= 2
        && !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// The `native_image` fields of one page row. `false` drops the whole row.
pub(crate) fn parse(item: &Map<String, Value>, observation: &mut PageObservation) -> bool {
    let text = |key: &str| item.get(key).and_then(Value::as_str);
    let (Some(message), Some(asset)) = (text("messageId"), text("providerAssetId")) else {
        return false;
    };
    let role = match text("providerRole") {
        Some("tool") => ProviderRole::Tool,
        Some("assistant") => ProviderRole::Assistant,
        _ => return false,
    };
    if !uuid(message) || !provider_asset(asset) {
        return false;
    }
    observation.message_id = Some(message.to_owned());
    observation.provider_asset_id = Some(asset.to_owned());
    observation.provider_role = Some(role);
    match item.get("providerChannel") {
        Some(Value::String(channel)) if channel == "final" => {
            observation.provider_channel = Some(ProviderChannel::Final);
        }
        Some(_) => return false,
        None => {}
    }
    match item.get("providerStatus").map(|status| status.as_str()) {
        Some(Some("in_progress")) => observation.provider_status = Some(ProviderStatus::InProgress),
        Some(Some("finished_successfully")) => {
            observation.provider_status = Some(ProviderStatus::FinishedSuccessfully);
        }
        Some(_) => return false,
        None => {}
    }
    let width = side(item.get("width"), MAX_SOURCE_SIDE);
    let height = side(item.get("height"), MAX_SOURCE_SIDE);
    if (item.contains_key("width") && width.is_none())
        || (item.contains_key("height") && height.is_none())
    {
        return false;
    }
    observation.width = width;
    observation.height = height;
    observation.preview_status = match text("previewStatus") {
        Some("pending") => Some(PreviewStatus::Pending),
        Some("available") => Some(PreviewStatus::Available),
        Some("unavailable") => Some(PreviewStatus::Unavailable),
        _ => None,
    };
    observation.preview_error = match text("previewError") {
        Some("not_loaded") => Some(PreviewError::NotLoaded),
        Some("ambiguous") => Some(PreviewError::Ambiguous),
        Some("tainted") => Some(PreviewError::Tainted),
        Some("oversized") => Some(PreviewError::Oversized),
        Some("invalid") => Some(PreviewError::Invalid),
        Some("quota") => Some(PreviewError::Quota),
        _ => None,
    };
    let oversized = matches!((width, height), (Some(w), Some(h)) if w * h > MAX_SOURCE_PIXELS);
    if oversized {
        observation.preview_status = Some(PreviewStatus::Unavailable);
        observation.preview_error = Some(PreviewError::Oversized);
    }
    if !oversized && let Some(data_url) = text("previewDataUrl") {
        let preview_width = side(item.get("previewWidth"), MAX_PREVIEW_SIDE);
        let preview_height = side(item.get("previewHeight"), MAX_PREVIEW_SIDE);
        if observation.provider_status != Some(ProviderStatus::FinishedSuccessfully) {
            // Only the provider's own finished status admits pixels.
            observation.preview_status = Some(PreviewStatus::Pending);
            observation.preview_error = None;
        } else if let (true, Some(w), Some(h)) =
            (webp_data_url(data_url), preview_width, preview_height)
            && w * h <= MAX_PREVIEW_PIXELS
        {
            observation.preview_data_url = Some(data_url.to_owned());
            observation.preview_width = Some(w);
            observation.preview_height = Some(h);
            observation.preview_status = Some(PreviewStatus::Available);
        } else {
            observation.preview_status = Some(PreviewStatus::Unavailable);
            observation.preview_error = Some(PreviewError::Invalid);
        }
    }
    true
}

/// The preview's WebP bytes, once they decode to exactly the size the page reported.
fn preview_bytes(
    data_url: &str,
    width: Option<u64>,
    height: Option<u64>,
) -> Result<Vec<u8>, String> {
    const INVALID: &str = "invalid native image preview";
    if !webp_data_url(data_url) {
        return Err(INVALID.into());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_url[DATA_URL_PREFIX.len()..])
        .map_err(|_| INVALID.to_owned())?;
    if data.is_empty() || data.len() > MAX_PREVIEW_BYTES {
        return Err(INVALID.into());
    }
    let reader = || {
        let mut reader =
            image::ImageReader::with_format(Cursor::new(&data), image::ImageFormat::WebP);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(MAX_PREVIEW_SIDE as u32);
        limits.max_image_height = Some(MAX_PREVIEW_SIDE as u32);
        limits.max_alloc = Some(MAX_PREVIEW_PIXELS * 4 + 1024 * 1024);
        reader.limits(limits);
        reader
    };
    let (w, h) = reader().into_dimensions().map_err(|_| INVALID.to_owned())?;
    let (w, h) = (u64::from(w), u64::from(h));
    if w == 0 || h == 0 || w * h > MAX_PREVIEW_PIXELS || Some(w) != width || Some(h) != height {
        return Err(INVALID.into());
    }
    reader().decode().map_err(|_| INVALID.to_owned())?;
    Ok(data)
}

fn row(item: &PageObservation, base: &EventBase) -> Option<NativeImageEvent> {
    Some(NativeImageEvent {
        base: base.clone(),
        message_id: item.message_id.clone()?,
        provider_asset_id: item.provider_asset_id.clone()?,
        provider_role: item.provider_role?,
        provider_channel: item.provider_channel,
        provider_status: item.provider_status,
        width: item.width,
        height: item.height,
        preview_width: None,
        preview_height: None,
        preview_status: PreviewStatus::Pending,
        preview_error: None,
        asset: None,
        origin: None,
        extra: Extra::new(),
    })
}

impl Recorder {
    /// `recordNativeImage`: answers how many rows changed.
    pub(crate) async fn record_native_image(
        &self,
        session: &SessionId,
        item: &PageObservation,
        mut base: EventBase,
    ) -> u64 {
        base.model = None;
        base.reasoning_effort = None;
        base.authored_at = None;
        let Some(metadata) = row(item, &base) else {
            return 0;
        };
        let sessions = &self.inner.sessions;
        let first = NativeImageEvent {
            preview_status: if item.preview_data_url.is_some() {
                PreviewStatus::Pending
            } else {
                item.preview_status.unwrap_or(PreviewStatus::Pending)
            },
            preview_error: item.preview_error,
            ..metadata.clone()
        };
        let written = match sessions.upsert_native_image(session, first).await {
            Ok(written) => written,
            Err(error) => {
                self.inner.logger.warn(&format!(
                    "session {session}: native image not stored: {error}"
                ));
                return 0;
            }
        };
        if !written.accepted {
            return 0;
        }
        let mut changed = u64::from(written.changed);
        let Some(data_url) = item.preview_data_url.clone() else {
            return changed;
        };
        if written.event.asset.is_some() {
            return changed;
        }
        let (width, height) = (item.preview_width, item.preview_height);
        let decoded = tokio::task::spawn_blocking(move || preview_bytes(&data_url, width, height))
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
        let stored = match decoded {
            Ok(data) => sessions
                .write_asset(session, data, "image/webp")
                .await
                .map(|asset| (asset, width, height)),
            Err(error) => Err(error),
        };
        let next = match stored {
            Ok((asset, width, height)) => NativeImageEvent {
                preview_status: PreviewStatus::Available,
                preview_width: width,
                preview_height: height,
                asset: Some(asset),
                ..metadata
            },
            Err(error) => {
                self.inner.logger.warn(&format!(
                    "native generated image preview unavailable: {error}"
                ));
                NativeImageEvent {
                    preview_status: PreviewStatus::Unavailable,
                    preview_error: Some(if error.to_lowercase().contains("quota") {
                        PreviewError::Quota
                    } else {
                        PreviewError::Invalid
                    }),
                    ..metadata
                }
            }
        };
        if let Ok(written) = sessions.upsert_native_image(session, next).await
            && written.changed
        {
            changed += 1;
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cos_types::bridge::ObservationKind;
    use serde_json::json;

    const MESSAGE: &str = "11111111-2222-4333-8444-555555555555";

    fn webp(width: u32, height: u32) -> String {
        let pixels = vec![200u8; (width * height * 3) as usize];
        let mut out = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut out)
            .encode(&pixels, width, height, image::ExtendedColorType::Rgb8)
            .expect("encode");
        format!(
            "{DATA_URL_PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(out)
        )
    }

    fn parsed(row: Value) -> Option<PageObservation> {
        let mut observation = crate::observe::observation(ObservationKind::NativeImage, 1.0);
        parse(row.as_object()?, &mut observation).then_some(observation)
    }

    #[test]
    fn a_row_needs_a_provider_message_asset_and_role() {
        let row = json!({ "messageId": MESSAGE, "providerAssetId": "file_abcdefgh", "providerRole": "assistant" });
        assert!(parsed(row.clone()).is_some());
        for (key, bad) in [
            ("messageId", json!("not-a-uuid")),
            ("providerAssetId", json!("file_short")),
            ("providerRole", json!("user")),
            ("providerChannel", json!("commentary")),
            ("providerStatus", json!("done")),
            ("width", json!(0)),
            ("height", json!(30_001)),
        ] {
            let mut broken = row.clone();
            broken[key] = bad;
            assert!(parsed(broken).is_none(), "{key}");
        }
    }

    #[test]
    fn pixels_wait_for_the_finished_status_and_must_match_their_size() {
        let row = |status: &str, url: &str, width: u64| {
            json!({ "messageId": MESSAGE, "providerAssetId": "file_abcdefgh", "providerRole": "assistant",
                "providerStatus": status, "previewDataUrl": url, "previewWidth": width, "previewHeight": 3 })
        };
        let url = webp(4, 3);
        let early = parsed(row("in_progress", &url, 4)).expect("row");
        assert_eq!(early.preview_status, Some(PreviewStatus::Pending));
        assert_eq!(early.preview_data_url, None);
        let done = parsed(row("finished_successfully", &url, 4)).expect("row");
        assert_eq!(done.preview_status, Some(PreviewStatus::Available));
        assert!(preview_bytes(&url, Some(4), Some(3)).is_ok());
        assert!(
            preview_bytes(&url, Some(5), Some(3)).is_err(),
            "the reported size is wrong"
        );
        let bad = parsed(row(
            "finished_successfully",
            "data:image/png;base64,AAAA",
            4,
        ))
        .expect("row");
        assert_eq!(bad.preview_status, Some(PreviewStatus::Unavailable));
        assert_eq!(bad.preview_error, Some(PreviewError::Invalid));
        let huge = parsed(
            json!({ "messageId": MESSAGE, "providerAssetId": "file_abcdefgh",
            "providerRole": "tool", "width": 10_000, "height": 10_000, "previewDataUrl": url }),
        )
        .expect("row");
        assert_eq!(huge.preview_error, Some(PreviewError::Oversized));
        assert_eq!(huge.preview_data_url, None);
    }
}
