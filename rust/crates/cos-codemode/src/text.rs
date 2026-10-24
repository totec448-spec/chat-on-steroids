//! JavaScript's view of strings where it differs from Rust's: what `trim` strips, how `length`
//! counts, and how `JSON.parse` reads a lone surrogate.

/// ECMAScript WhiteSpace and LineTerminator, which `String.prototype.trim` and `\s` strip.
/// Rust's `char::is_whitespace` differs: it has U+0085 and lacks U+FEFF.
pub(crate) fn is_js_space(c: char) -> bool {
    const SPACES: [char; 9] = [
        ' ', '\u{a0}', '\u{1680}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}',
        '\u{feff}',
    ];
    matches!(c, '\t'..='\r' | '\u{2000}'..='\u{200a}') || SPACES.contains(&c)
}

pub(crate) fn is_blank(text: &str) -> bool {
    text.chars().all(is_js_space)
}

pub(crate) fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_space)
}

/// `string.length`: UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `JSON.parse` of a JSON string literal, then the UTF-8 encoding Node's `Buffer` gives it: a
/// lone surrogate escape becomes U+FFFD. `None` when `json` is not one JSON string.
pub(crate) fn decode_json_string(json: &str) -> Option<String> {
    if let Ok(text) = serde_json::from_str::<String>(json) {
        return Some(text);
    }
    // serde_json refuses lone surrogates, which JavaScript's JSON.stringify writes as escapes.
    let body = json
        .trim_matches(is_json_space)
        .strip_prefix('"')?
        .strip_suffix('"')?;
    let mut units: Vec<u16> = Vec::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return None,
            '\\' => {
                let unit = match chars.next()? {
                    '"' => u16::from(b'"'),
                    '\\' => u16::from(b'\\'),
                    '/' => u16::from(b'/'),
                    'b' => 0x08,
                    'f' => 0x0c,
                    'n' => u16::from(b'\n'),
                    'r' => u16::from(b'\r'),
                    't' => u16::from(b'\t'),
                    'u' => {
                        let hex: String = chars.by_ref().take(4).collect();
                        if hex.len() != 4 {
                            return None;
                        }
                        u16::from_str_radix(&hex, 16).ok()?
                    }
                    _ => return None,
                };
                units.push(unit);
            }
            c if u32::from(c) < 0x20 => return None,
            c => {
                let mut buffer = [0u16; 2];
                units.extend_from_slice(c.encode_utf16(&mut buffer));
            }
        }
    }
    Some(String::from_utf16_lossy(&units))
}

fn is_json_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}
