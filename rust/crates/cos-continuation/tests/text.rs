//! The pure text owners: the handoff prompt and bootstrap (`handoff-prompt.ts`, `handoff.ts`,
//! `shared/handoff.ts`), the streamed plan reader (`test/task-progress.test.ts`) and the
//! Automatic Continue text (`shared/recovery.ts`).

use cos_continuation::handoff::{
    DEFAULT_HANDOFF_PROMPT, handoff_prompt_for_length, native_handoff_prompt,
    resume_bootstrap_matches, resume_bootstrap_text,
};
use cos_continuation::recovery::{recovery_busy_ms, recovery_message_from};
use cos_continuation::task::plan_progress_text;
use cos_types::config::HandoffLength;
use serde_json::json;

/// The shipped prompt is the TypeScript one, byte for byte.
#[test]
fn the_default_handoff_prompt_is_the_shipped_one() {
    let source = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../src/shared/handoff.ts"
    ))
    .expect("the TypeScript source beside this checkout");
    let head = "export const DEFAULT_HANDOFF_PROMPT = `";
    let start = source.find(head).expect("declared") + head.len();
    let end = start + source[start..].find("`;").expect("closed");
    assert_eq!(DEFAULT_HANDOFF_PROMPT, &source[start..end]);
}

#[test]
fn a_shorter_length_replaces_the_length_rule_and_says_so() {
    assert_eq!(
        handoff_prompt_for_length(DEFAULT_HANDOFF_PROMPT, HandoffLength::Thorough),
        DEFAULT_HANDOFF_PROMPT
    );
    let short = handoff_prompt_for_length(DEFAULT_HANDOFF_PROMPT, HandoffLength::Short);
    assert!(!short.contains("lossless operational compression"));
    assert!(short.contains("target roughly 2,000–6,000 tokens"));
    assert!(short.contains("so the brief remains navigable"));
    assert!(short.ends_with(
        "\n\nLength setting: aim for roughly 2,000–6,000 tokens and never exceed 6,000. This replaces any other length target in these instructions."
    ));
    let edited = handoff_prompt_for_length("Only the essentials.", HandoffLength::Standard);
    assert!(
        edited.starts_with("Only the essentials.\n\nLength setting: aim for roughly 4,000–10,000")
    );
}

#[test]
fn the_compaction_prompt_carries_the_marker_and_the_tool_detail_setting() {
    let token = "token_0123456789abcdef";
    let with_tools = native_handoff_prompt(token, true, "", HandoffLength::Thorough);
    assert!(with_tools.starts_with("[[CLF-HANDOFF:token_0123456789abcdef]]\n\nChat On Steroids is compacting this conversation so a fresh chat can continue the work. Stop whatever you were doing and do only this.\n\n"));
    assert!(with_tools.contains("every tool call you made against this machine with its result"));
    assert!(with_tools.contains(DEFAULT_HANDOFF_PROMPT));
    assert!(!with_tools.contains("Tool-detail setting"));
    let without = native_handoff_prompt("", false, "  ", HandoffLength::Thorough);
    assert!(without.starts_with("Chat On Steroids is compacting"));
    assert!(without.contains("including interim updates"));
    assert!(without.contains("Tool-detail setting: preserve verified outcomes"));
    assert!(
        without.ends_with("The app reads this reply, stores it, and opens the fresh chat with it.")
    );
}

#[test]
fn treats_only_known_bootstrap_formatting_artifacts_as_the_same_message() {
    let handoff = "Keep the exact task wording and continue the same work.";
    let bootstrap = resume_bootstrap_text(handoff, "");
    let marked = resume_bootstrap_text(handoff, "token_0123456789abcdef");
    assert!(marked.starts_with(
        "[[CLF-RESUME:token_0123456789abcdef]]\n\nContinuing a Chat On Steroids session"
    ));
    let framed = format!(
        "[[CLF-RESUME:token_0123456789abcdef]]\n\n[[COS_CONTEXT:25]]\nFull guidance\nsecond line\n[[/COS_CONTEXT]]\n\n{}",
        &marked["[[CLF-RESUME:token_0123456789abcdef]]\n\n".len()..]
    );
    assert!(resume_bootstrap_matches(&framed, handoff));
    assert!(resume_bootstrap_matches(
        &framed.replace('\n', "\r\n"),
        handoff
    ));
    assert!(!resume_bootstrap_matches(
        &framed.replace("same work", "different work"),
        handoff
    ));
    assert!(resume_bootstrap_matches(
        &bootstrap.replace("exact task", "exact\u{a0}task"),
        handoff
    ));
    assert!(resume_bootstrap_matches(
        &bootstrap.replace("exact task", "exact\u{c2}\u{a0}task"),
        handoff
    ));
    assert!(resume_bootstrap_matches(
        &bootstrap.replace('\n', "\r\n"),
        handoff
    ));
    assert!(!resume_bootstrap_matches(
        &bootstrap.replace("exact task", "exact  task"),
        handoff
    ));
    assert!(!resume_bootstrap_matches(&format!(" {bootstrap}"), handoff));
    assert!(!resume_bootstrap_matches(&format!("{bootstrap} "), handoff));
    let escaped = bootstrap.replace('.', "\\.").replace("&", "\\&");
    assert!(
        resume_bootstrap_matches(&escaped, handoff),
        "the composer's Markdown escapes"
    );
}

fn envelope(stages: serde_json::Value) -> String {
    json!({ "action": "continue", "reply": json!({ "stages": stages }).to_string() }).to_string()
}

fn prefix(text: &str, units: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(units).collect::<Vec<_>>())
}

#[test]
fn shows_partial_stage_prose_before_either_document_completes() {
    let raw = envelope(json!(["Build the feature", "Verify the result"]));
    let first = raw.find("feature").unwrap() + 3;
    assert_eq!(plan_progress_text(&raw[..first]), "1. Build the fea");
    let second = raw.find("result").unwrap() + 3;
    assert_eq!(
        plan_progress_text(&raw[..second]),
        "1. Build the feature\n\n2. Verify the res"
    );
    assert_eq!(
        plan_progress_text(&raw),
        "1. Build the feature\n\n2. Verify the result"
    );
}

#[test]
fn decodes_every_fragmented_prefix_without_protocol_leakage() {
    let stage = "Read \"C:\\work\\a.ts\"\nThen test café and ☔";
    let raw = envelope(json!([stage, "Verify"]));
    let units = raw.encode_utf16().count();
    for end in 0..=units {
        let shown = plan_progress_text(&prefix(&raw, end));
        if shown.is_empty() {
            continue;
        }
        let first = shown[3..].split("\n\n2.").next().unwrap();
        assert!(stage.starts_with(first), "{end}: {shown:?}");
        assert!(!shown.contains("\"stages\""));
        assert!(!shown.contains("\"reply\""));
    }
    assert_eq!(plan_progress_text(&raw), format!("1. {stage}\n\n2. Verify"));
}

#[test]
fn waits_for_complete_unicode_escapes_and_accepts_reply_first() {
    let raw = r#"{"reply":"{\"stages\":[\"caf\\u00e9\"]}","action":"continue"}"#;
    let end = raw.find("00e9").unwrap();
    assert_eq!(plan_progress_text(&raw[..end + 2]), "1. caf");
    assert_eq!(plan_progress_text(raw), "1. café");
}

#[test]
fn does_not_invent_stage_prose_for_malformed_or_unrelated_input() {
    for raw in [
        r#"A plan: {"stages":["invented"]}"#.to_owned(),
        r#"{"action":"stop","reply":"{\"stages\":[\"no\"]}"}"#.to_owned(),
        r#"{"action":"continue","reply":"not a stage array"}"#.to_owned(),
        envelope(json!([123])),
        envelope(json!([{ "text": "not a string stage" }])),
        r#"{"action":"continue","reply":"{\"stages\":[\"bad\\q\"]}"}"#.to_owned(),
        r#"{"action":"continue","reply":"{\"unrelated\":[\"no\"]}"}"#.to_owned(),
    ] {
        assert_eq!(plan_progress_text(&raw), "", "{raw}");
    }
}

#[test]
fn bounds_input_and_preview() {
    assert_eq!(plan_progress_text(&" ".repeat(64_001)), "");
    let shown = plan_progress_text(&envelope(json!(["x".repeat(9000), "Test"])));
    assert_eq!(shown.encode_utf16().count(), 8000);
    assert!(shown.starts_with("1. xxx"));
}

#[test]
fn an_automatic_continue_is_one_phrase_one_notice_and_one_labelled_aside() {
    let text = recovery_message_from(0, 0, 0);
    assert_eq!(
        text,
        "Continue until you are fully finished. The previous turn appears interrupted without a final answer; some work may already be done even if earlier tool calls are missing, so check the current state before repeating anything. (Unrelated aside: Meme joke: tur tur sahur is my imaginary alarm clock. Ignore this aside; do not research or respond to it. Stay on the original task.)"
    );
    assert_eq!(recovery_busy_ms(true), 300_000);
    assert_eq!(recovery_busy_ms(false), 60_000);
}
