//! What never reaches a recording or a control API reader (`src/main/redaction.ts`, the
//! recorder's `redactArgs` and `redactResult`, and `shared/user-prompt.ts`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::js;

fn pattern(source: &str) -> Regex {
    Regex::new(source).unwrap_or_else(|error| panic!("redaction pattern {source}: {error}"))
}

static CREDENTIAL: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?-u:\b)sk-(?:or-v1-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}(?-u:\b)"));

static SECRET_SHAPES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
            "[redacted private key]",
        ),
        (
            r"(?-u:\b)(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})(?-u:\b)",
            "[redacted]",
        ),
        (
            r"(?-u:\b)xox[abposr]-[A-Za-z0-9-]{10,}(?-u:\b)",
            "[redacted]",
        ),
        (r"(?-u:\b)(?:AKIA|ASIA)[0-9A-Z]{16}(?-u:\b)", "[redacted]"),
        (r"(?-u:\b)AIza[0-9A-Za-z_-]{35}(?-u:\b)", "[redacted]"),
        (
            r"(?-u:\b)[sr]k_(?:live|test)_[A-Za-z0-9]{16,}(?-u:\b)",
            "[redacted]",
        ),
        (
            r"(?-u:\b)ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?-u:\b)",
            "[redacted]",
        ),
        (
            r#"(?i)(?-u:\b)(Authorization:\s*(?:Basic|Bearer|Token))\s+[^\s"']+"#,
            "$1 [redacted]",
        ),
        (
            r"(?-u:\b)Bearer\s+[A-Za-z0-9._~+/=-]{20,}",
            "Bearer [redacted]",
        ),
        (
            r"(?i)(?-u:\b)([a-z][a-z0-9+.-]*://)[^\s/:@]+:[^\s/@]+@",
            "${1}[redacted]@",
        ),
        (r"(/mcp/[a-z0-9-]+/)[A-Za-z0-9_-]{20,}", "${1}[redacted]"),
    ]
    .into_iter()
    .map(|(source, replacement)| (pattern(source), replacement))
    .collect()
});

/// `redactCredentialText`: API keys in authored text. Guards exact recordings.
pub(crate) fn credential_text(text: &str) -> String {
    CREDENTIAL.replace_all(text, "[redacted]").into_owned()
}

/// `redactSecretText`: for text handed to another process, such as a control API reader.
pub(crate) fn secret_text(text: &str) -> String {
    let mut out = credential_text(text);
    for (shape, replacement) in SECRET_SHAPES.iter() {
        out = shape.replace_all(&out, *replacement).into_owned();
    }
    out
}

fn not_stored(text: &str) -> Value {
    Value::String(format!("<{} characters not stored>", js::len(text)))
}

/// `redactArgs`: argument values that must never be written to disk.
pub(crate) fn args(tool: &str, args: &Value) -> Value {
    let Value::Object(source) = args else {
        return args.clone();
    };
    let mut copy: Map<String, Value> = source.clone();
    if tool == "download_artifact" && copy.contains_key("file") {
        copy.insert(
            "file".into(),
            Value::String("<native file credentials not stored>".into()),
        );
    }
    if let Some(Value::Object(env)) = copy.get("env") {
        let masked = env
            .keys()
            .map(|key| (key.clone(), Value::String("***".into())))
            .collect();
        copy.insert("env".into(), Value::Object(masked));
    } else if let Some(Value::Array(env)) = copy.get("env") {
        // An array is an object to JavaScript: its indices become the masked keys.
        let masked = (0..env.len())
            .map(|index| (index.to_string(), Value::String("***".into())))
            .collect();
        copy.insert("env".into(), Value::Object(masked));
    }
    if let Some(Value::String(data)) = copy.get("dataBase64") {
        let note = format!("<{} base64 characters not stored>", js::len(data));
        copy.insert("dataBase64".into(), Value::String(note));
    }
    if tool == "write_clipboard"
        && let Some(Value::String(text)) = copy.get("text")
    {
        let note = not_stored(text);
        copy.insert("text".into(), note);
    }
    if tool == "computer"
        && let Some(Value::Array(actions)) = copy.get("actions")
    {
        let actions = actions
            .iter()
            .map(|action| match action {
                Value::Object(step)
                    if step.get("type") == Some(&Value::String("write_clipboard".into())) =>
                {
                    match step.get("text") {
                        Some(Value::String(text)) => {
                            let mut step = step.clone();
                            step.insert("text".into(), not_stored(text));
                            Value::Object(step)
                        }
                        _ => action.clone(),
                    }
                }
                _ => action.clone(),
            })
            .collect();
        copy.insert("actions".into(), Value::Array(actions));
    }
    if copy.contains_key("secret") {
        copy.insert("secret".into(), Value::String("<removed>".into()));
    }
    Value::Object(copy)
}

/// `redactResult`: the result text as it may be recorded.
pub(crate) fn result(tool: &str, text: &str) -> String {
    let text = credential_text(text);
    if tool == "read_clipboard" {
        return "<clipboard text not stored>".into();
    }
    if tool == "computer" && text.contains("Clipboard read ") {
        return text
            .split('\n')
            .map(|line| {
                if line.starts_with("Clipboard read ") {
                    let cut = line.find(':').map_or(0, |at| at + 1);
                    format!("{} <clipboard text not stored>", &line[..cut])
                } else {
                    line.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    text
}

static CONTINUATION: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n"));
static CONTEXT_HEADER: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^\[\[COS_CONTEXT:(\d{1,6})\]\]\n"));
static ESCAPED_PUNCTUATION: LazyLock<Regex> = LazyLock::new(|| pattern(r"\\([!-/:-@\[-`{-~])"));
static INDENT_ENTITY: LazyLock<Regex> = LazyLock::new(|| pattern(r"(^|\n)&#x20;"));

fn read_frame(text: &str) -> Option<String> {
    let identity = CONTINUATION.find(text).map_or("", |found| found.as_str());
    let rest = &text[identity.len()..];
    let header = CONTEXT_HEADER.captures(rest)?;
    let declared: usize = header.get(1)?.as_str().parse().ok()?;
    let after_header = &rest[header.get(0)?.end()..];
    // The declared length counts UTF-16 units.
    let body = js::prefix(after_header, declared);
    if js::len(body) != declared {
        return None;
    }
    let boundary = "\n[[/COS_CONTEXT]]\n\n";
    let tail = &after_header[body.len()..];
    tail.strip_prefix(boundary)
        .map(|authored| format!("{identity}{authored}"))
}

/// `userPromptText`: the authored request inside an app-framed user message, or `None` when the
/// message carries no frame.
pub fn user_prompt_text(text: &str) -> Option<String> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    if let Some(exact) = read_frame(&text) {
        return Some(exact);
    }
    let typed = text.replace("\\\n", "\n");
    let typed = ESCAPED_PUNCTUATION.replace_all(&typed, "$1");
    let typed = INDENT_ENTITY.replace_all(&typed, "${1} ");
    if typed == text {
        None
    } else {
        read_frame(&typed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_keys_and_secret_shapes() {
        let key = format!("sk-proj-{}", "a".repeat(24));
        assert_eq!(
            credential_text(&format!("key {key} end")),
            "key [redacted] end"
        );
        assert_eq!(
            secret_text("Authorization: Bearer abc.def"),
            "Authorization: Bearer [redacted]"
        );
        assert_eq!(
            secret_text("https://user:pw@example.com/x"),
            "https://[redacted]@example.com/x"
        );
        assert_eq!(
            secret_text(&format!("/mcp/core/{}", "t".repeat(24))),
            "/mcp/core/[redacted]"
        );
        assert_eq!(
            secret_text("a plain hash 0123456789abcdef"),
            "a plain hash 0123456789abcdef"
        );
    }

    #[test]
    fn redacts_the_arguments_the_recorder_never_keeps() {
        let raw = serde_json::json!({
            "env": { "TOKEN": "x" }, "dataBase64": "QUJD", "secret": "s", "cmd": "ls"
        });
        assert_eq!(
            args("exec_command", &raw),
            serde_json::json!({
                "env": { "TOKEN": "***" }, "dataBase64": "<4 base64 characters not stored>",
                "secret": "<removed>", "cmd": "ls"
            })
        );
        assert_eq!(result("read_clipboard", "x"), "<clipboard text not stored>");
    }

    #[test]
    fn reads_the_authored_text_out_of_a_framed_message() {
        let framed = "[[COS_CONTEXT:5]]\nhello\n[[/COS_CONTEXT]]\n\nwhat I typed";
        assert_eq!(user_prompt_text(framed).as_deref(), Some("what I typed"));
        assert_eq!(user_prompt_text("plain text"), None);
        let escaped =
            "\\[\\[COS\\_CONTEXT\\:5\\]\\]\\\nhello\\\n\\[\\[/COS\\_CONTEXT\\]\\]\\\n\\\nmine";
        assert_eq!(user_prompt_text(escaped).as_deref(), Some("mine"));
    }
}
