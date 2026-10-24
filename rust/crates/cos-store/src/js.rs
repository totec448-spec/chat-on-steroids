//! The few JavaScript string and number rules the TypeScript validators depend on.
//!
//! Zod measures strings in UTF-16 code units and trims the ECMAScript white-space set, which is
//! neither Rust's `char` count nor `str::trim`. Dates print the way `Date.toISOString` does.

use serde_json::Value;

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

pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `text.length`.
pub(crate) fn len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, units)`. A cut through a surrogate pair drops the half that JavaScript would
/// keep as a lone surrogate, which a Rust string cannot hold.
pub(crate) fn prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, c) in text.char_indices() {
        used += c.len_utf16();
        if used > units {
            return &text[..index];
        }
    }
    text
}

/// A JSON number that `Number.isSafeInteger` accepts, as zod's `.int()` checks it.
pub(crate) fn safe_integer(value: &Value) -> Option<i64> {
    const MAX: f64 = 9_007_199_254_740_991.0;
    if let Some(int) = value.as_i64() {
        return (int.unsigned_abs() <= MAX as u64).then_some(int);
    }
    let float = value.as_f64()?;
    (float.fract() == 0.0 && float.abs() <= MAX).then_some(float as i64)
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso_time(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let rest = ms % 86_400_000;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_time_matches_javascript() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_792_397_103_007), "2026-10-19T08:05:03.007Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn lengths_and_prefixes_count_utf16_units() {
        assert_eq!(len("a😀"), 3);
        assert_eq!(prefix("a😀b", 2), "a");
        assert_eq!(prefix("a😀b", 3), "a😀");
        assert_eq!(trim("\u{feff} x \u{2028}"), "x");
        assert_eq!(trim("\u{85}x"), "\u{85}x");
    }
}
