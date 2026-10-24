//! The two string clean-ups `secrets.ts` applies to stored values.

/// `\s` in a JavaScript regular expression, which is also the set `String.prototype.trim`
/// strips. Rust's `char::is_whitespace` differs: it includes U+0085 and excludes U+FEFF.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
            | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `INVISIBLE_IN_KEYS` in `secrets.ts`.
fn is_invisible_in_keys(c: char) -> bool {
    is_js_whitespace(c)
        || matches!(
            c,
            '\u{85}' | '\u{ad}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202f}'
                | '\u{205f}'..='\u{2064}' | '\u{2066}'..='\u{206f}'
        )
}

/// `cleanApiKey`: removes whitespace and invisible characters that a copied API key can carry,
/// which providers would otherwise read as a malformed `Authorization` header.
pub fn clean_api_key(value: &str) -> String {
    value
        .chars()
        .filter(|&c| !is_invisible_in_keys(c))
        .collect()
}

/// `value.trim()` in JavaScript.
pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Code point ranges taken by running the `INVISIBLE_IN_KEYS` regex from `secrets.ts`, and
    /// `String.prototype.trim`, over every code point in Node 24.
    const CLEANED: &[(u32, u32)] = &[
        (0x9, 0xd),
        (0x20, 0x20),
        (0x85, 0x85),
        (0xa0, 0xa0),
        (0xad, 0xad),
        (0x1680, 0x1680),
        (0x180e, 0x180e),
        (0x2000, 0x200f),
        (0x2028, 0x202f),
        (0x205f, 0x2064),
        (0x2066, 0x206f),
        (0x3000, 0x3000),
        (0xfeff, 0xfeff),
    ];
    const TRIMMED: &[(u32, u32)] = &[
        (0x9, 0xd),
        (0x20, 0x20),
        (0xa0, 0xa0),
        (0x1680, 0x1680),
        (0x2000, 0x200a),
        (0x2028, 0x2029),
        (0x202f, 0x202f),
        (0x205f, 0x205f),
        (0x3000, 0x3000),
        (0xfeff, 0xfeff),
    ];

    fn assert_matches_ranges(predicate: fn(char) -> bool, ranges: &[(u32, u32)]) {
        for c in (0..=char::MAX as u32).filter_map(char::from_u32) {
            let expected = ranges
                .iter()
                .any(|&(low, high)| (low..=high).contains(&(c as u32)));
            assert_eq!(predicate(c), expected, "U+{:04X}", c as u32);
        }
    }

    #[test]
    fn clean_api_key_removes_exactly_what_the_typescript_regex_removes() {
        assert_matches_ranges(is_invisible_in_keys, CLEANED);
        assert_eq!(
            clean_api_key(" \u{ad}sk-or-\u{200b}v1\u{85}-abc\n"),
            "sk-or-v1-abc"
        );
    }

    #[test]
    fn js_trim_strips_exactly_what_javascript_trim_strips() {
        assert_matches_ranges(is_js_whitespace, TRIMMED);
        assert_eq!(js_trim("\u{feff} a b \u{3000}"), "a b");
        assert_eq!(js_trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
    }
}
