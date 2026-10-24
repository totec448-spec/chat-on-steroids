//! The JavaScript string, number and JSON rules the recorded files depend on.
//!
//! Lengths and caps count UTF-16 code units (`text.length`), numbers print the way
//! `JSON.stringify` and `toFixed` print them, and dates follow `Date.toISOString`.

use cos_types::json::JsNumber;
use serde_json::Value;

/// ECMAScript `WhiteSpace` and `LineTerminator`: what `String.prototype.trim` removes.
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

/// `Math.ceil(units / 4)`, the recorder's token estimate.
pub(crate) fn quarter_ceil(units: u64) -> u64 {
    units.div_ceil(4)
}

/// `Math.round(x)` for the non-negative values the summaries print.
pub(crate) fn round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `x.toFixed(1)` for a finite non-negative `x` below 1e21: the exact binary value, rounded
/// half up at the first decimal, as ECMAScript specifies (Rust's `{:.1}` rounds ties to even).
pub(crate) fn to_fixed_1(x: f64) -> String {
    // 1100 fractional digits cover every f64 exactly.
    let exact = format!("{x:.1100}");
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, "0"));
    let mut digits: Vec<u8> = whole.bytes().chain(fraction.bytes().take(1)).collect();
    let up = fraction
        .as_bytes()
        .get(1)
        .is_some_and(|digit| *digit >= b'5');
    if up {
        let mut index = digits.len();
        loop {
            if index == 0 {
                digits.insert(0, b'1');
                break;
            }
            index -= 1;
            if digits[index] == b'9' {
                digits[index] = b'0';
            } else {
                digits[index] += 1;
                break;
            }
        }
    }
    let split = digits.len() - 1;
    let text = String::from_utf8_lossy(&digits).into_owned();
    format!("{}.{}", &text[..split], &text[split..])
}

/// `String(number)` for the integral and fractional values a summary prints.
pub(crate) fn number_text(value: f64) -> String {
    serde_json::to_string(&JsNumber(value)).unwrap_or_else(|_| "null".to_owned())
}

/// `JSON.stringify(value)`: compact, insertion order, integral floats without a fraction.
pub(crate) fn stringify(value: &Value) -> String {
    serde_json::to_string(&js_value(value)).unwrap_or_else(|_| "null".to_owned())
}

/// `JSON.stringify(text)`.
pub(crate) fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned())
}

fn js_value(value: &Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => number
            .as_f64()
            .map(|float| serde_json::to_value(JsNumber(float)).unwrap_or(Value::Null))
            .unwrap_or(Value::Null),
        Value::Array(items) => Value::Array(items.iter().map(js_value).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), js_value(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `new Date(ms).toISOString().slice(0, 10)`.
pub(crate) fn iso_day(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
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
    format!("{year:04}-{month:02}-{day:02}")
}

/// `crypto.randomUUID()`.
pub(crate) fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        // No OS randomness: fall back to the per-process hasher keys, still unique per call.
        use std::hash::{BuildHasher, RandomState};
        let high = RandomState::new().hash_one(std::time::Instant::now());
        let low = RandomState::new().hash_one(std::process::id());
        bytes[..8].copy_from_slice(&high.to_le_bytes());
        bytes[8..].copy_from_slice(&low.to_le_bytes());
    }
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_the_exact_value_half_up() {
        assert_eq!(to_fixed_1(1.25), "1.3");
        assert_eq!(to_fixed_1(1.15), "1.1");
        assert_eq!(to_fixed_1(1.05), "1.1");
        assert_eq!(to_fixed_1(9.96), "10.0");
        assert_eq!(to_fixed_1(1.4), "1.4");
        assert_eq!(to_fixed_1(59.99), "60.0");
    }

    #[test]
    fn stringify_writes_integral_floats_as_javascript_does() {
        let value: Value = serde_json::from_str(r#"{"b":10.0,"a":[1.5,2]}"#).expect("json");
        assert_eq!(stringify(&value), r#"{"b":10,"a":[1.5,2]}"#);
    }

    #[test]
    fn lengths_prefixes_days_and_uuids() {
        assert_eq!(len("a😀"), 3);
        assert_eq!(prefix("a😀b", 2), "a");
        assert_eq!(prefix("a😀b", 3), "a😀");
        assert_eq!(iso_day(1_792_397_103_007), "2026-10-19");
        let uuid = random_uuid();
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[14..15], "4");
        assert_ne!(uuid, random_uuid());
    }
}
