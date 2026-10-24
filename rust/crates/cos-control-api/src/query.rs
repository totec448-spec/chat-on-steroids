//! Request targets and query strings, decided the way the TypeScript listener decides them:
//! WHATWG URL parsing against `http://127.0.0.1`, then a strict zod object per route.
//!
//! Unknown, repeated and malformed parameters are refused rather than ignored. When several
//! things are wrong, the answer names the one zod reports first: the route's parameters in
//! declaration order, then an unknown name.

use crate::reply::Refusal;

/// A request target that passed the origin-form check: its normalized path and decoded query.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) path: String,
    /// `url.search` without its `?`; empty when there is none or it is bare.
    pub(crate) search: String,
    pub(crate) params: Vec<(String, String)>,
}

/// `control-api.ts`: a target that is not plain origin-form is refused before it is parsed, so
/// no spelling of a path (a backslash, a leading `//`) reaches a route by another name.
pub(crate) fn parse_target(raw: &str) -> Result<Target, Refusal> {
    if !raw.starts_with('/') || raw.starts_with("//") || raw.contains('\\') {
        return Err(Refusal::InvalidTarget);
    }
    let raw = raw.split_once('#').map_or(raw, |(before, _)| before);
    let (path, search) = raw.split_once('?').unwrap_or((raw, ""));
    Ok(Target {
        path: remove_dot_segments(path),
        search: search.to_owned(),
        params: form_urlencoded(search),
    })
}

fn single_dot(segment: &str) -> bool {
    segment == "." || segment.eq_ignore_ascii_case("%2e")
}

fn double_dot(segment: &str) -> bool {
    matches!(
        segment.to_ascii_lowercase().as_str(),
        ".." | ".%2e" | "%2e." | "%2e%2e"
    )
}

/// The WHATWG path state for a path that starts with `/`.
fn remove_dot_segments(path: &str) -> String {
    let segments: Vec<&str> = path[1..].split('/').collect();
    let last = segments.len() - 1;
    let mut out: Vec<&str> = Vec::new();
    for (index, segment) in segments.into_iter().enumerate() {
        if double_dot(segment) {
            out.pop();
            if index == last {
                out.push("");
            }
        } else if single_dot(segment) {
            if index == last {
                out.push("");
            }
        } else {
            out.push(segment);
        }
    }
    format!("/{}", out.join("/"))
}

/// `URLSearchParams`: `&`-separated pairs, `+` is a space, `%XX` is a byte, UTF-8 with
/// replacement characters.
fn form_urlencoded(search: &str) -> Vec<(String, String)> {
    search
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(name), percent_decode(value))
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        let hex = |at: usize| {
            bytes
                .get(at)
                .and_then(|digit| (*digit as char).to_digit(16))
        };
        match (byte, hex(index + 1), hex(index + 2)) {
            (b'%', Some(high), Some(low)) => {
                // Two hex digits are at most 0xFF.
                out.push(u8::try_from(high * 16 + low).unwrap_or(u8::MAX));
                index += 3;
            }
            (b'+', _, _) => {
                out.push(b' ');
                index += 1;
            }
            _ => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// How one parameter is checked (the zod pieces `control-reads.ts` uses).
#[derive(Clone, Copy, Debug)]
pub(crate) enum Rule {
    /// `integer(min, max)`: one to sixteen digits, then the range.
    Integer { min: u64, max: u64 },
    /// `z.string().min(1).max(100)`, counted in UTF-16 units as JavaScript does.
    Text { min: usize, max: usize },
    /// `z.literal('1')`.
    Literal(&'static str),
    /// `csv(allowed)`: comma-separated words from a fixed set, at most as many as the set.
    Words(&'static [&'static str]),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Value {
    Integer(u64),
    Text(String),
    Words(Vec<&'static str>),
}

fn integer(value: &str, min: u64, max: u64) -> Option<u64> {
    let digits = (1..=16).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit());
    let number: u64 = digits.then(|| value.parse().ok()).flatten()?;
    (min..=max).contains(&number).then_some(number)
}

impl Rule {
    /// The checked value, or the JSON path zod names for the first problem.
    fn check(self, name: &str, value: &str) -> Result<Value, String> {
        let invalid = || name.to_owned();
        match self {
            Self::Integer { min, max } => integer(value, min, max)
                .map(Value::Integer)
                .ok_or_else(invalid),
            Self::Text { min, max } => {
                let units = value.encode_utf16().count();
                if (min..=max).contains(&units) {
                    Ok(Value::Text(value.to_owned()))
                } else {
                    Err(invalid())
                }
            }
            Self::Literal(expected) => {
                if value == expected {
                    Ok(Value::Text(value.to_owned()))
                } else {
                    Err(invalid())
                }
            }
            Self::Words(allowed) => {
                let mut words = Vec::new();
                for (index, word) in value.split(',').enumerate() {
                    let Some(known) = allowed.iter().find(|candidate| **candidate == word) else {
                        return Err(format!("{name}.{index}"));
                    };
                    words.push(*known);
                }
                if words.len() > allowed.len() {
                    return Err(invalid());
                }
                Ok(Value::Words(words))
            }
        }
    }
}

/// The parameters a route accepts, in declaration order.
pub(crate) type Shape = &'static [(&'static str, Rule)];

/// The parsed parameters, in the order of the route's shape.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Query(Vec<(&'static str, Value)>);

impl Query {
    pub(crate) fn integer(&self, name: &str) -> Option<u64> {
        self.0.iter().find_map(|(key, value)| match value {
            Value::Integer(number) if *key == name => Some(*number),
            _ => None,
        })
    }

    pub(crate) fn text(&self, name: &str) -> Option<&str> {
        self.0.iter().find_map(|(key, value)| match value {
            Value::Text(text) if *key == name => Some(text.as_str()),
            _ => None,
        })
    }

    /// The parsed values as zod returns them, for comparing with the TypeScript oracle.
    #[cfg(test)]
    pub(crate) fn to_json(&self) -> serde_json::Value {
        let entries = self.0.iter().map(|(name, value)| {
            let value = match value {
                Value::Integer(number) => serde_json::json!(number),
                Value::Text(text) => serde_json::json!(text),
                Value::Words(words) => serde_json::json!(words),
            };
            ((*name).to_owned(), value)
        });
        serde_json::Value::Object(entries.collect())
    }

    pub(crate) fn words(&self, name: &str) -> Option<&[&'static str]> {
        self.0.iter().find_map(|(key, value)| match value {
            Value::Words(words) if *key == name => Some(words.as_slice()),
            _ => None,
        })
    }
}

fn invalid(detail: impl Into<String>) -> Refusal {
    Refusal::InvalidQuery(detail.into())
}

/// `parseQuery`: refuses a repeated name, then checks the shape, then refuses unknown names.
pub(crate) fn parse_query(params: &[(String, String)], shape: Shape) -> Result<Query, Refusal> {
    for (index, (name, _)) in params.iter().enumerate() {
        if params[..index].iter().any(|(earlier, _)| earlier == name) {
            return Err(invalid("a parameter was given more than once"));
        }
    }
    let mut query = Query::default();
    for (name, rule) in shape {
        let Some((_, value)) = params.iter().find(|(given, _)| given == name) else {
            continue;
        };
        let value = rule
            .check(name, value)
            .map_err(|path| invalid(format!("{path} is not valid")))?;
        query.0.push((name, value));
    }
    if params
        .iter()
        .any(|(given, _)| !shape.iter().any(|(name, _)| name == given))
    {
        return Err(invalid("unknown parameter"));
    }
    Ok(query)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dot_segment_that_ends_the_path_leaves_its_slash() {
        assert_eq!(remove_dot_segments("/v1/health/."), "/v1/health/");
        assert_eq!(remove_dot_segments("/v1/health/.."), "/v1/");
        assert_eq!(remove_dot_segments("/.."), "/");
        assert_eq!(remove_dot_segments("/"), "/");
    }
}
