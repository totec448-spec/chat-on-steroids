//! JavaScript string arithmetic the outbox repeats: UTF-16 lengths, `String.prototype.trim`
//! and `slice(0, n)`.

/// JavaScript's white space and line terminators, which `trim` removes.
fn js_space(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `text.length`.
pub(crate) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.trim()`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// `text.slice(0, max)`, counted in UTF-16 units. A cut through a surrogate pair keeps the
/// whole character out, where JavaScript keeps a lone half.
pub(crate) fn js_slice(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        out.push(ch);
    }
    out
}
