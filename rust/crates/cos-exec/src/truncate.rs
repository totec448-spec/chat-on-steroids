// Vendored from openai/codex at 1a4096e273e80da30947e57fdfa45be92858ca91,
// codex-rs/utils/string/src/truncate.rs and `formatted_truncate_text` from
// codex-rs/utils/output-truncation/src/lib.rs (Apache-2.0, see ../NOTICE).
// Modified: only the token policy is kept, because exec output never uses the byte policy.

//! Truncation that keeps a prefix and a suffix on UTF-8 boundaries. Every length is a UTF-8 byte
//! length and a token is four bytes.

const APPROX_BYTES_PER_TOKEN: usize = 4;

pub(crate) fn approx_token_count(text: &str) -> usize {
    text.len().div_ceil(APPROX_BYTES_PER_TOKEN)
}

pub(crate) fn approx_tokens_from_byte_count(bytes: usize) -> usize {
    bytes.div_ceil(APPROX_BYTES_PER_TOKEN)
}

pub(crate) fn approx_bytes_for_tokens(tokens: usize) -> usize {
    tokens.saturating_mul(APPROX_BYTES_PER_TOKEN)
}

/// `truncate_text` with `TruncationPolicy::Tokens`.
pub(crate) fn truncate_to_tokens(text: &str, max_tokens: usize) -> String {
    if text.is_empty() {
        return String::new();
    }
    if max_tokens > 0 && text.len() <= approx_bytes_for_tokens(max_tokens) {
        return text.to_owned();
    }
    truncate_with_byte_estimate(text, approx_bytes_for_tokens(max_tokens))
}

/// `formatted_truncate_text`: the text itself when it fits, otherwise a warning header with the
/// original size and the middle-truncated text.
pub(crate) fn formatted_truncate_text(content: &str, max_tokens: usize) -> String {
    if content.len() <= approx_bytes_for_tokens(max_tokens) {
        return content.to_owned();
    }
    let original_token_count = approx_token_count(content);
    let total_lines = content.lines().count();
    let result = truncate_to_tokens(content, max_tokens);
    format!(
        "Warning: truncated output (original token count: {original_token_count})\nTotal output lines: {total_lines}\n\n{result}"
    )
}

fn truncate_with_byte_estimate(text: &str, max_bytes: usize) -> String {
    if max_bytes == 0 {
        return format_truncation_marker(approx_tokens_from_byte_count(text.len()));
    }
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let left_budget = max_bytes / 2;
    let right_budget = max_bytes - left_budget;
    let (before, after) = split_string(text, left_budget, right_budget);
    let marker = format_truncation_marker(approx_tokens_from_byte_count(
        text.len().saturating_sub(max_bytes),
    ));
    let mut out = String::with_capacity(before.len() + marker.len() + after.len());
    out.push_str(before);
    out.push_str(&marker);
    out.push_str(after);
    out
}

fn split_string(text: &str, beginning_bytes: usize, end_bytes: usize) -> (&str, &str) {
    let len = text.len();
    let tail_start_target = len.saturating_sub(end_bytes);
    let mut prefix_end = 0usize;
    let mut suffix_start = len;
    let mut suffix_started = false;
    for (idx, ch) in text.char_indices() {
        let char_end = idx + ch.len_utf8();
        if char_end <= beginning_bytes {
            prefix_end = char_end;
            continue;
        }
        if idx >= tail_start_target && !suffix_started {
            suffix_start = idx;
            suffix_started = true;
        }
    }
    if suffix_start < prefix_end {
        suffix_start = prefix_end;
    }
    (&text[..prefix_end], &text[suffix_start..])
}

fn format_truncation_marker(removed_tokens: usize) -> String {
    format!("…{removed_tokens} tokens truncated…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_untouched() {
        assert_eq!(formatted_truncate_text("abc\n", 10), "abc\n");
    }

    #[test]
    fn long_text_keeps_both_ends_on_char_boundaries() {
        let text = "é".repeat(20);
        let cut = truncate_to_tokens(&text, 2);
        assert!(cut.starts_with("éé"), "{cut}");
        assert!(cut.ends_with("éé"), "{cut}");
        assert!(cut.contains("…8 tokens truncated…"), "{cut}");
    }

    #[test]
    fn formatted_header_counts_tokens_and_lines() {
        let text = "line\n".repeat(10);
        let out = formatted_truncate_text(&text, 2);
        assert!(out.starts_with(
            "Warning: truncated output (original token count: 13)\nTotal output lines: 10\n\n"
        ));
    }
}
