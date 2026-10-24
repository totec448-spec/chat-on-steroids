//! Free text for the wire: known credential shapes masked (`redactSecretText` in
//! `src/main/redaction.ts`), then cut to a cap counted in UTF-16 units as JavaScript counts.

use std::sync::LazyLock;

use regex::Regex;

/// JavaScript's `\s`, which differs from Rust's in U+FEFF (JS only) and U+0085 (Rust only).
const JS_SPACE: &str =
    r"\t\n\x0B\x0C\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";

struct Shape {
    pattern: Regex,
    replacement: &'static str,
}

fn shape(pattern: &str, replacement: &'static str) -> Shape {
    let pattern = pattern.replace("JS_SPACE", JS_SPACE);
    Shape {
        // The patterns are fixed text; a typo fails every test that redacts.
        pattern: Regex::new(&pattern).unwrap_or_else(|error| panic!("{pattern}: {error}")),
        replacement,
    }
}

static SHAPES: LazyLock<Vec<Shape>> = LazyLock::new(|| {
    let b = r"(?-u:\b)";
    vec![
        // redactCredentialText
        shape(
            &format!(r"{b}sk-(?:or-v1-|proj-|svcacct-)?[A-Za-z0-9_-]{{20,}}{b}"),
            "[redacted]",
        ),
        shape(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?s:.)*?(?:-----END [A-Z ]*PRIVATE KEY-----|\z)",
            "[redacted private key]",
        ),
        shape(
            &format!(r"{b}(?:gh[pousr]_[A-Za-z0-9]{{30,}}|github_pat_[A-Za-z0-9_]{{40,}}){b}"),
            "[redacted]",
        ),
        shape(
            &format!(r"{b}xox[abposr]-[A-Za-z0-9-]{{10,}}{b}"),
            "[redacted]",
        ),
        shape(&format!(r"{b}(?:AKIA|ASIA)[0-9A-Z]{{16}}{b}"), "[redacted]"),
        shape(&format!(r"{b}AIza[0-9A-Za-z_-]{{35}}{b}"), "[redacted]"),
        shape(
            &format!(r"{b}[sr]k_(?:live|test)_[A-Za-z0-9]{{16,}}{b}"),
            "[redacted]",
        ),
        shape(
            &format!(r"{b}ey[A-Za-z0-9_-]{{10,}}\.[A-Za-z0-9_-]{{10,}}\.[A-Za-z0-9_-]{{10,}}{b}"),
            "[redacted]",
        ),
        shape(
            &format!(
                r#"(?i){b}(Authorization:[JS_SPACE]*(?:Basic|Bearer|Token))[JS_SPACE]+[^JS_SPACE"']+"#
            ),
            "${1} [redacted]",
        ),
        shape(
            &format!(r"{b}Bearer[JS_SPACE]+[A-Za-z0-9._~+/=-]{{20,}}"),
            "Bearer [redacted]",
        ),
        shape(
            &format!(r"(?i){b}([a-z][a-z0-9+.-]*://)[^JS_SPACE/:@]+:[^JS_SPACE/@]+@"),
            "${1}[redacted]@",
        ),
        shape(r"(/mcp/[a-z0-9-]+/)[A-Za-z0-9_-]{20,}", "${1}[redacted]"),
    ]
});

pub(crate) fn redact_secret_text(text: &str) -> String {
    SHAPES.iter().fold(text.to_owned(), |text, shape| {
        shape
            .pattern
            .replace_all(&text, shape.replacement)
            .into_owned()
    })
}

/// The length JavaScript reports for `text`.
pub(crate) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `clip`: at most `cap` UTF-16 units, never half of a surrogate pair.
fn clip(text: &str, cap: usize) -> (&str, bool) {
    let mut units = 0;
    for (at, character) in text.char_indices() {
        units += character.len_utf16();
        if units > cap {
            return (&text[..at], true);
        }
    }
    (text, false)
}

/// `line`: redact first, then cut, so a cut through a key leaves no recognisable prefix.
pub(crate) fn line(value: &str, cap: usize) -> String {
    clip(&redact_secret_text(value), cap).0.to_owned()
}

/// A log line cut for `/v1/log`, and whether it was cut.
pub(crate) fn clipped_line(value: &str, cap: usize) -> (String, bool) {
    let redacted = redact_secret_text(value);
    let (text, truncated) = clip(&redacted, cap);
    (text.to_owned(), truncated)
}

/// `String.prototype.trim`: JavaScript's white space and line terminators, U+FEFF included.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|character: char| {
        matches!(
            character,
            '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200A}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202F}'
                    | '\u{205F}'
                    | '\u{3000}'
                    | '\u{FEFF}'
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_never_splits_a_surrogate_pair() {
        let text = format!("{}\u{1F600}", "a".repeat(3));
        assert_eq!(clip(&text, 4), ("aaa", true));
        assert_eq!(clip(&text, 5), (text.as_str(), false));
        assert_eq!(js_length(&text), 5);
    }

    #[test]
    fn a_long_line_is_cut_at_its_cap_and_says_so() {
        let (text, truncated) = clipped_line(&"z".repeat(9_000), 4_000);
        assert_eq!((js_length(&text), truncated), (4_000, true));
    }
}
