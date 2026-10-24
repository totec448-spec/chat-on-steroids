//! JavaScript string and number arithmetic the TypeScript owners rely on: UTF-16 lengths and
//! indices, `trim`, `Math.round` and the ISO day of an epoch.

/// JavaScript's white space and line terminators, which `trim` removes.
fn space(ch: char) -> bool {
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

/// `text.trim()`.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(space)
}

/// `text.trimStart()`.
pub(crate) fn trim_start(text: &str) -> &str {
    text.trim_start_matches(space)
}

/// `text.length`.
pub(crate) fn len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The byte offset of UTF-16 index `units`, rounded down to a character boundary.
fn byte_at(text: &str, units: usize) -> usize {
    let mut counted = 0;
    for (at, ch) in text.char_indices() {
        if counted + ch.len_utf16() > units {
            return at;
        }
        counted += ch.len_utf16();
    }
    text.len()
}

/// `text.slice(start, end)` in UTF-16 units. A cut through a surrogate pair drops the pair.
pub(crate) fn slice(text: &str, start: usize, end: usize) -> String {
    let from = byte_at(text, start);
    let to = byte_at(text, end.max(start));
    text[from..to].to_owned()
}

/// `text.indexOf(ch)` in UTF-16 units.
pub(crate) fn index_of(text: &str, needle: char) -> Option<usize> {
    let at = text.find(needle)?;
    Some(len(&text[..at]))
}

/// `text.lastIndexOf(ch)` in UTF-16 units.
pub(crate) fn last_index_of(text: &str, needle: char) -> Option<usize> {
    let at = text.rfind(needle)?;
    Some(len(&text[..at]))
}

/// `Math.round` for a non-negative value.
pub(crate) fn round_half_up(value: f64) -> u64 {
    (value + 0.5).floor() as u64
}

/// `new Date(ms).toISOString().slice(0, 10)`.
pub(crate) fn iso_day(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_cuts_in_utf16_units() {
        assert_eq!(len("a😀b"), 4);
        assert_eq!(slice("a😀b", 0, 3), "a😀");
        assert_eq!(slice("a😀b", 0, 2), "a");
        assert_eq!(slice("abcdef", 2, 4), "cd");
        assert_eq!(index_of("ab\ncd", '\n'), Some(2));
        assert_eq!(last_index_of("a\nb\nc", '\n'), Some(3));
        assert_eq!(trim("\u{a0} x \n"), "x");
    }

    #[test]
    fn writes_the_iso_day() {
        assert_eq!(iso_day(0), "1970-01-01");
        assert_eq!(iso_day(1_792_540_800_000), "2026-10-21");
        assert_eq!(round_half_up(20.5), 21);
        assert_eq!(round_half_up(318.422), 318);
    }
}
