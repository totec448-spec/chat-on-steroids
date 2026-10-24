//! JavaScript string rules the wire depends on: lengths and cuts count UTF-16 code units.

use cos_types::ids::BridgeConversationId;
use serde_json::Value;

/// `value.length`.
pub(crate) fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value.slice(0, units)`. A cut that would split a surrogate pair keeps the whole character
/// out, since Rust strings cannot hold the lone half JavaScript would keep.
pub(crate) fn js_cut(value: &str, units: usize) -> String {
    let mut used = 0;
    value
        .chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= units
        })
        .collect()
}

pub(crate) fn string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// `/^[a-f0-9-]{36}$/i`, the shape every handshake id must have.
pub(crate) fn request_id(value: Option<&Value>) -> Option<&str> {
    string(value)
        .filter(|id| id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
}

/// `conversationId(value)` in `bridge.ts`.
pub(crate) fn conversation_id(value: Option<&Value>) -> Option<BridgeConversationId> {
    string(value).and_then(|id| BridgeConversationId::parse(id).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_count_utf16_units() {
        assert_eq!(js_cut("abc", 2), "ab");
        assert_eq!(js_cut("a😀b", 2), "a");
        assert_eq!(js_cut("a😀b", 3), "a😀");
        assert_eq!(js_len("a😀"), 3);
    }
}
