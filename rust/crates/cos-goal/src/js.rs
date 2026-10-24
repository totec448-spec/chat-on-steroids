//! The JavaScript string rules `goal.ts` depends on. Lengths, cuts and offsets are UTF-16 code
//! units, and `trim` removes the ECMAScript white-space set, which is neither Rust's `char` count
//! nor `str::trim`.

/// ECMAScript `WhiteSpace` and `LineTerminator`: what `String.prototype.trim` and `\s` remove.
pub(crate) fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub(crate) fn is_space_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_space)
}

pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `text.length`.
pub(crate) fn len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(crate) fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

pub(crate) fn string(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `text.slice(0, count)`.
pub(crate) fn prefix(text: &str, count: usize) -> String {
    let all = units(text);
    string(&all[..count.min(all.len())])
}

/// The UTF-16 offset of each byte offset a Rust regex reports.
pub(crate) fn utf16_offset(text: &str, byte: usize) -> usize {
    text[..byte].encode_utf16().count()
}
