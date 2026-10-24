// Derived from OpenAI Codex at commit 1a4096e273e80da30947e57fdfa45be92858ca91
// (https://github.com/openai/codex): `format_exec_output_for_model` in
// `codex-rs/core/src/tools/mod.rs` and the token-budget truncation in
// `codex-rs/utils/string/src/truncate.rs` and `codex-rs/utils/output-truncation/src/lib.rs`.
// Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0; see `codex/LICENSE` and
// `codex/NOTICE` in this crate.
//
// Modified for Chat On Steroids: only the token policy `apply_patch` uses is kept, following the
// TypeScript port in `src/main/codex/{exec-output,truncate}.ts`.

//! The exec-shaped text the model reads for a patch that ran: Codex runs `apply_patch` as an
//! exec call, so success and failure both arrive as `Exit code`, `Wall time` and `Output`.

use std::time::Duration;

/// `DEFAULT_MAX_OUTPUT_TOKENS`, the whole budget for output the model cannot ask about.
const MAX_OUTPUT_TOKENS: usize = 10_000;
const APPROX_BYTES_PER_TOKEN: usize = 4;

/// `format_exec_output_for_model` under the default token policy.
pub(crate) fn format_exec_output(exit_code: i32, wall_time: Duration, output: &str) -> String {
    // Rounded to a tenth of a second and printed in its shortest form, as Rust's f32 Display and
    // a JavaScript number both print it.
    let seconds = (wall_time.as_secs_f64() * 10.0).round() / 10.0;
    let formatted = truncate_middle(output, MAX_OUTPUT_TOKENS * APPROX_BYTES_PER_TOKEN);
    let mut sections = vec![
        format!("Exit code: {exit_code}"),
        format!("Wall time: {seconds} seconds"),
    ];
    let total_lines = output.lines().count();
    if total_lines != formatted.lines().count() {
        sections.push(format!("Total output lines: {total_lines}"));
    }
    sections.push("Output:".to_owned());
    sections.push(formatted);
    sections.join("\n")
}

/// Keeps the head and tail of `text` within `max_bytes`, naming the tokens cut from the middle.
fn truncate_middle(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let left = max_bytes / 2;
    let right = max_bytes - left;
    let tail_start = text.len() - right;
    let mut prefix_end = 0;
    let mut suffix_start = text.len();
    for (index, ch) in text.char_indices() {
        let end = index + ch.len_utf8();
        if end <= left {
            prefix_end = end;
        } else if index >= tail_start {
            suffix_start = index;
            break;
        }
    }
    let suffix_start = suffix_start.max(prefix_end);
    let removed_tokens = (text.len() - max_bytes).div_ceil(APPROX_BYTES_PER_TOKEN);
    format!(
        "{}…{removed_tokens} tokens truncated…{}",
        &text[..prefix_end],
        &text[suffix_start..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_output_has_three_sections() {
        assert_eq!(
            format_exec_output(0, Duration::from_millis(40), "Success.\n"),
            "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess.\n"
        );
        assert_eq!(
            format_exec_output(1, Duration::from_millis(1260), "x"),
            "Exit code: 1\nWall time: 1.3 seconds\nOutput:\nx"
        );
    }

    #[test]
    fn long_output_keeps_head_and_tail_and_counts_lines() {
        let output = "line\n".repeat(20_000);
        let text = format_exec_output(0, Duration::ZERO, &output);
        assert!(text.starts_with(
            "Exit code: 0\nWall time: 0 seconds\nTotal output lines: 20000\nOutput:\nline\n"
        ));
        assert!(text.contains("…15000 tokens truncated…"));
        assert!(text.ends_with("line\n"));
    }

    #[test]
    fn a_cut_never_splits_a_character() {
        let output = "é".repeat(30_000);
        let cut = truncate_middle(&output, 40_000);
        assert!(cut.contains("tokens truncated"));
        assert!(cut.len() <= 40_000 + 40);
    }
}
