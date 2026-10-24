//! What a message carries beside its text: the user's emoji reaction, the images attached to a
//! request, and the sources a reply cites (`messageReaction` in `shared/message-reaction.ts`,
//! the attachment filter of `parseObservations` in `bridge.ts`, and `messageReferences` in
//! `shared/session.ts`). All three are presentation; none of them decides a turn or an owner.

use std::sync::LazyLock;

use cos_types::json::Extra;
use cos_types::session::{InputAttachment, MessageReference, ReferenceSource};
use regex::Regex;
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

const MAX_ATTACHMENTS: usize = 4;
const MAX_ATTACHMENT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MESSAGE_REFERENCES: usize = 32;
const MAX_REFERENCE_SOURCES: usize = 8;
/// Characters of titles, links, source names and snippets one reply's references may hold.
const MAX_REFERENCES_CHARS: usize = 32_000;
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

static EMOJI_ONLY: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r"^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[\x{200d}\x{fe0f}\x{20e3}\x{e0020}-\x{e007f}0-9#*])+$",
    )
    .ok()
});
static EMOJI_BASE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"[\p{Extended_Pictographic}\p{Regional_Indicator}\x{20e3}]").ok());
static IMAGE_TYPE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)^image/[a-z0-9.+-]{1,80}$").ok());

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn matches(pattern: &LazyLock<Option<Regex>>, value: &str) -> bool {
    pattern.as_ref().is_some_and(|regex| regex.is_match(value))
}

/// `messageReaction`: exactly one emoji, never HTML or text.
pub(crate) fn reaction(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    let fits = (1..=32).contains(&utf16_len(value))
        && matches(&EMOJI_ONLY, value)
        && matches(&EMOJI_BASE, value)
        && value.graphemes(true).count() == 1;
    fits.then(|| value.to_owned())
}

fn safe_integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&number)).then_some(number as u64)
}

/// The images a user message names, at most four, each checked field by field.
pub(crate) fn attachments(value: &Value) -> Option<Vec<InputAttachment>> {
    let rows = value.as_array()?;
    Some(
        rows.iter()
            .take(MAX_ATTACHMENTS)
            .filter_map(|file| {
                let file = file.as_object()?;
                let id = file.get("id")?.as_str()?;
                let name = file.get("name")?.as_str()?;
                let mime_type = file.get("mimeType")?.as_str()?;
                let size = safe_integer(file.get("size")?)?;
                let valid = (1..=100).contains(&utf16_len(id))
                    && (1..=200).contains(&utf16_len(name))
                    && matches(&IMAGE_TYPE, mime_type)
                    && size <= MAX_ATTACHMENT_BYTES;
                valid.then(|| InputAttachment {
                    id: id.to_owned(),
                    name: name.to_owned(),
                    size,
                    mime_type: mime_type.to_owned(),
                    preview: None,
                    extra: Extra::new(),
                })
            })
            .collect(),
    )
}

/// `text`: whitespace runs collapsed, trimmed, then the first `max` UTF-16 units.
fn text(value: Option<&Value>, max: usize) -> String {
    let Some(value) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    crate::parse::js_slice(&collapsed, max)
}

/// `/^https?://[^s]+$/i`.
fn web_link(link: &str) -> bool {
    ["https://", "http://"].iter().any(|scheme| {
        link.get(..scheme.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(scheme))
            && link.len() > scheme.len()
            && !link[scheme.len()..].chars().any(char::is_whitespace)
    })
}

/// `messageReferences`: bounded, http(s) links only, anything else dropped.
pub(crate) fn references(value: &Value) -> Option<Vec<MessageReference>> {
    let rows = value.as_array()?;
    let mut out: Vec<MessageReference> = Vec::new();
    let mut budget = MAX_REFERENCES_CHARS;
    for entry in rows.iter().take(MAX_MESSAGE_REFERENCES) {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let Some(index) = entry
            .get("index")
            .and_then(Value::as_f64)
            .filter(|index| index.fract() == 0.0 && (0.0..=9999.0).contains(index))
            .map(|index| index as u64)
        else {
            continue;
        };
        let Some(sources) = entry.get("sources").and_then(Value::as_array) else {
            continue;
        };
        if out.iter().any(|held| held.index == index) {
            continue;
        }
        let mut kept: Vec<ReferenceSource> = Vec::new();
        for source in sources.iter().take(MAX_REFERENCE_SOURCES) {
            let Some(source) = source.as_object() else {
                continue;
            };
            let link = text(source.get("url"), 2000);
            if !web_link(&link) {
                continue;
            }
            let label = text(source.get("source"), 80);
            let summary = text(source.get("snippet"), 300);
            let heading = match text(source.get("title"), 300) {
                heading if heading.is_empty() => link.clone(),
                heading => heading,
            };
            let size =
                utf16_len(&heading) + utf16_len(&link) + utf16_len(&label) + utf16_len(&summary);
            if size > budget {
                break;
            }
            budget -= size;
            let date = source
                .get("date")
                .and_then(Value::as_f64)
                .filter(|date| date.is_finite() && *date > 0.0 && *date < 1e13)
                .map(|date| date.round() as u64)
                .filter(|date| *date > 0);
            kept.push(ReferenceSource {
                title: heading,
                url: link,
                source: (!label.is_empty()).then_some(label),
                date,
                snippet: (!summary.is_empty()).then_some(summary),
                extra: Extra::new(),
            });
        }
        if kept.is_empty() {
            continue;
        }
        out.push(MessageReference {
            index,
            sources: kept,
            extra: Extra::new(),
        });
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_reaction_is_exactly_one_emoji() {
        for accepted in ["👍", "❤️", "🇵🇸", "1️⃣", "👍🏽", "👨‍👩‍👧"]
        {
            assert_eq!(
                reaction(&json!(accepted)).as_deref(),
                Some(accepted),
                "{accepted}"
            );
        }
        for refused in ["", "a", "👍👍", "<b>👍</b>", "1", "#", "🇵🇸🇵🇸", "👍 "] {
            assert_eq!(reaction(&json!(refused)), None, "{refused:?}");
        }
        assert_eq!(reaction(&json!(1)), None);
    }

    #[test]
    fn attachments_keep_four_well_formed_images() {
        let image =
            |id: &str| json!({ "id": id, "name": "a.png", "size": 10, "mimeType": "image/png" });
        let kept = attachments(&json!([
            image("1"),
            { "id": "2", "name": "a.txt", "size": 10, "mimeType": "text/plain" },
            { "id": "3", "name": "b.png", "size": 1.5, "mimeType": "image/png" },
            image("4"),
            image("5")
        ]))
        .expect("an array");
        assert_eq!(
            kept.iter().map(|file| file.id.as_str()).collect::<Vec<_>>(),
            ["1", "4"],
            "only the first four are read"
        );
        assert_eq!(attachments(&json!("nope")), None);
    }

    #[test]
    fn references_keep_bounded_web_links() {
        let kept = references(&json!([
            { "index": 0, "sources": [
                { "title": "  A   title ", "url": "https://example.com/a", "source": "Example", "date": 1700000000000.4, "snippet": "x" },
                { "title": "bad", "url": "javascript:alert(1)" },
                { "url": "http://example.com/b" }
            ] },
            { "index": 0, "sources": [{ "url": "https://example.com/dup" }] },
            { "index": 1.5, "sources": [{ "url": "https://example.com/c" }] },
            { "index": 2, "sources": [{ "url": "ftp://example.com" }] }
        ]))
        .expect("references");
        assert_eq!(
            serde_json::to_value(&kept).expect("json"),
            json!([{ "index": 0, "sources": [
                { "title": "A title", "url": "https://example.com/a", "source": "Example", "date": 1700000000000u64, "snippet": "x" },
                { "title": "http://example.com/b", "url": "http://example.com/b" }
            ] }])
        );
        assert_eq!(references(&json!([])), None);
    }
}
