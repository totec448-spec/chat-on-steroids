//! Untrusted model output, turned into the only two states the browser may act on
//! (`normalizeGoalDecision`, `decisionObjectIn`, `cleanGoalReply`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js;

/// The longest message a decision may ask the page to type.
pub const MAX_MESSAGE_CHARS: usize = 12_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// The goal is met: nothing is typed.
    Stop,
    /// The next user message.
    Continue(String),
    /// No usable answer, with its machine reason.
    Invalid(String),
}

fn pattern(source: &str) -> Regex {
    Regex::new(source).unwrap_or_else(|error| panic!("goal pattern {source}: {error}"))
}

static NO_REPLY_EXACT: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)^no[\s_-]?reply[\s.!]*$"));
static NO_REPLY_WORD: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)no[\s_-]?reply"));
static CONTROL_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)<\|[^|\r\n]{1,100}\|>|</?s>|\[/?INST\]|<</?SYS>>"));
static UNSAFE_REASONING_TAG: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)</?(?:think|analysis|reasoning)\b[^>]*>"));
static REASONING_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r"(?is)<think\b[^>]*>.*?</think\s*>|<analysis\b[^>]*>.*?</analysis\s*>|<reasoning\b[^>]*>.*?</reasoning\s*>",
    )
});
static CODE_FENCE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?is)^\s*```[a-z]*\s*(.*?)\s*```\s*$"));
static JSON_SHAPED: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)^(?:[\[{]|```(?:json)?\s*[\[{])"));

fn letter_or_number(c: char) -> bool {
    c.is_alphanumeric()
}

/// `NO_REPLY_TOKEN.test(text)`: the sentinel as a standalone word anywhere. The JavaScript
/// lookahead after `reply[\s.!]*` holds exactly when the character right after `reply` is the
/// end or not a letter or number.
fn has_no_reply_token(text: &str) -> bool {
    let mut from = 0;
    while let Some(found) = NO_REPLY_WORD.find_at(text, from) {
        let before = text[..found.start()].chars().next_back();
        let after = text[found.end()..].chars().next();
        if !before.is_some_and(letter_or_number) && !after.is_some_and(letter_or_number) {
            return true;
        }
        from = found.start()
            + text[found.start()..]
                .chars()
                .next()
                .map_or(1, char::len_utf8);
    }
    false
}

fn says_no_reply(text: &str) -> bool {
    has_no_reply_token(text) || NO_REPLY_EXACT.is_match(text)
}

fn nfkc(text: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfkc()
        .normalize(text)
        .into_owned()
}

/// Removes provider and tokenizer wrappers while keeping the proposed human message.
fn clean(value: &str) -> (String, bool) {
    let normalized = nfkc(value);
    let visible: String = normalized
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '\u{0}' | '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}'
            )
        })
        .collect();
    let stripped = CONTROL_TOKEN.replace_all(&visible, "").into_owned();
    let had_control = stripped != visible;
    (js::trim(&stripped).to_owned(), had_control)
}

fn unsafe_markers(text: &str) -> bool {
    text.contains("<|") || text.contains("|>") || UNSAFE_REASONING_TAG.is_match(text)
}

fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// The decision object inside a structured reply, or `None` when there is none.
fn decision_object(text: &str) -> Option<Value> {
    if let Some(direct) = parse(text) {
        return Some(direct);
    }
    let unwrapped = REASONING_BLOCK.replace_all(text, "");
    let unwrapped = js::trim(&unwrapped);
    let body = CODE_FENCE
        .captures(unwrapped)
        .and_then(|captures| captures.get(1))
        .map_or(unwrapped, |inner| inner.as_str());
    if let Some(parsed) = parse(body) {
        return Some(parsed);
    }
    let open = body.find('{')?;
    let close = body.rfind('}')?;
    if close <= open {
        return None;
    }
    parse(&body[open..=close])
}

/// The head of an unreadable reply, flattened, for the log line that says it was unreadable.
pub fn sample(text: &str) -> String {
    let flat = text
        .split(js::is_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if js::len(&flat) > 200 {
        format!("{}…", js::prefix(&flat, 200))
    } else {
        flat
    }
}

fn continue_with(reply: &str) -> Decision {
    let (text, had_control) = clean(reply);
    if text.is_empty() {
        return Decision::Invalid(
            if had_control {
                "control_tokens_only"
            } else {
                "empty_reply"
            }
            .to_owned(),
        );
    }
    if unsafe_markers(&text) {
        return Decision::Invalid("unsafe_control_tokens".to_owned());
    }
    Decision::Continue(text)
}

/// `normalizeGoalDecision(raw, legacy)`. `unreadable` receives the sample of a reply that was
/// not JSON, for the warning line.
pub fn normalize(raw: &str, legacy: bool, unreadable: &mut dyn FnMut(String)) -> Decision {
    let trimmed = js::trim(raw);
    if trimmed.is_empty() {
        return Decision::Invalid("empty_reply".to_owned());
    }
    if legacy && !JSON_SHAPED.is_match(trimmed) {
        if says_no_reply(trimmed) {
            return Decision::Stop;
        }
        return continue_with(trimmed);
    }
    let Some(decision) = decision_object(trimmed) else {
        unreadable(sample(trimmed));
        return Decision::Invalid("invalid_goal_decision_json".to_owned());
    };
    let schema = || Decision::Invalid("invalid_goal_decision_schema".to_owned());
    let Value::Object(object) = decision else {
        return schema();
    };
    if object.keys().any(|key| key != "action" && key != "reply") {
        return schema();
    }
    let action = object.get("action").and_then(Value::as_str);
    let Some(reply) = object.get("reply").and_then(Value::as_str) else {
        return schema();
    };
    match action {
        Some("stop") => Decision::Stop,
        Some("continue") => {
            // A continue that leaks the stop protocol is ambiguous; stopping spends nothing.
            if says_no_reply(reply) {
                return Decision::Stop;
            }
            match continue_with(reply) {
                Decision::Continue(text) if js::len(&text) > MAX_MESSAGE_CHARS => {
                    Decision::Invalid("reply_too_long".to_owned())
                }
                other => other,
            }
        }
        _ => schema(),
    }
}
