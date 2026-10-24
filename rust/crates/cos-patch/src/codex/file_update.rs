// Vendored from OpenAI Codex, `codex-rs/apply-patch/src/file_update.rs` at commit
// 1a4096e273e80da30947e57fdfa45be92858ca91 (https://github.com/openai/codex).
// Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0; see `codex/LICENSE`
// and `codex/NOTICE` in this crate.
//
// Modified for Chat On Steroids, following the TypeScript port in
// `src/main/codex/apply-patch/file-update.ts`:
// - The caller reads the file. A dry run passes the text an earlier hunk of the same patch would
//   have left, and the applier passes what is on disk.
// - A leading UTF-8 byte-order mark is kept out of line one and put back on the result.
// - A match failure explains when the text lies behind the forward cursor, bounds the echoed
//   expected text, and carries a bounded source excerpt that the tool shows only with Read.
// - The unified diff for Codex's approval UI (`similar`) is not computed. Nothing here shows it.

use super::ApplyPatchError;
use super::ApplyPatchFileUpdateMode;
use super::UpdateFileChunk;
use super::seek_sequence;
use super::text_file::Replacement;
use super::text_file::SourceFile;

pub(crate) struct AppliedPatch {
    pub(crate) original_contents: String,
    pub(crate) new_contents: String,
}

const BYTE_ORDER_MARK: char = '\u{feff}';

/// Return *only* the new file contents (joined into a single `String`) after
/// applying the chunks to `original_contents`, the text of the file at `path`.
pub(crate) fn derive_new_contents_from_chunks(
    path: &str,
    original_contents: String,
    chunks: &[UpdateFileChunk],
    update_file_mode: ApplyPatchFileUpdateMode,
) -> Result<AppliedPatch, ApplyPatchError> {
    // The byte-order mark is not part of the first line: the model never sees it, so a patch for
    // line one would not match with it, and a matched line one would be replaced without it.
    let (mark, text) = match original_contents.strip_prefix(BYTE_ORDER_MARK) {
        Some(rest) => ("\u{feff}", rest),
        None => ("", original_contents.as_str()),
    };

    let new_contents = match update_file_mode {
        ApplyPatchFileUpdateMode::NormalizeToLf => {
            let mut original_lines = text.split('\n').map(String::from).collect::<Vec<_>>();

            // Drop the trailing empty element that results from the final newline so
            // that line counts match the behaviour of standard `diff`.
            if original_lines.last().is_some_and(String::is_empty) {
                original_lines.pop();
            }

            let replacements =
                compute_replacements(&original_lines, path, chunks, update_file_mode)?;
            let mut new_lines = apply_replacements(original_lines, &replacements);
            if !new_lines.last().is_some_and(String::is_empty) {
                new_lines.push(String::new());
            }
            new_lines.join("\n")
        }
        ApplyPatchFileUpdateMode::PreserveLineEndings => {
            let mut source_file = SourceFile::parse(text);
            let original_lines = source_file.line_texts();
            let replacements =
                compute_replacements(&original_lines, path, chunks, update_file_mode)?;
            source_file.apply_replacements(&replacements);
            source_file.into_contents()
        }
    };
    let new_contents = format!("{mark}{new_contents}");
    Ok(AppliedPatch {
        original_contents,
        new_contents,
    })
}

/// Compute a list of replacements needed to transform `original_lines` into the
/// new lines, given the patch `chunks`. Each replacement is returned as
/// `(start_index, old_len, new_lines)`.
fn compute_replacements(
    original_lines: &[String],
    path: &str,
    chunks: &[UpdateFileChunk],
    update_file_mode: ApplyPatchFileUpdateMode,
) -> Result<Vec<Replacement>, ApplyPatchError> {
    let mut replacements: Vec<Replacement> = Vec::new();
    let mut line_index: usize = 0;

    for chunk in chunks {
        let mut context_index = None;
        // If a chunk has a `change_context`, we use seek_sequence to find it, then
        // adjust our `line_index` to continue from there.
        if let Some(ctx_line) = &chunk.change_context {
            let pattern = std::slice::from_ref(ctx_line);
            match seek_sequence::seek_sequence(
                original_lines,
                pattern,
                line_index,
                /*eof*/ false,
                update_file_mode,
            ) {
                Some(idx) => {
                    context_index = Some(idx);
                    line_index = idx + 1;
                }
                None => {
                    return Err(match_failure(
                        &format!("Failed to find context in {path}:"),
                        original_lines,
                        pattern,
                        line_index,
                        update_file_mode,
                        None,
                    ));
                }
            }
        }

        if chunk.old_lines.is_empty() {
            // Preserve the legacy split representation's handling of a final
            // empty line. `SourceFile` only exposes real source lines, so its
            // insertion point is always after the final line.
            let insertion_idx = match update_file_mode {
                ApplyPatchFileUpdateMode::NormalizeToLf => {
                    if original_lines.last().is_some_and(String::is_empty) {
                        original_lines.len() - 1
                    } else {
                        original_lines.len()
                    }
                }
                ApplyPatchFileUpdateMode::PreserveLineEndings => original_lines.len(),
            };
            replacements.push((insertion_idx, 0, chunk.new_lines.clone()));
            continue;
        }

        // Otherwise, try to match the existing lines in the file with the old lines
        // from the chunk. If found, schedule that region for replacement.
        // Attempt to locate the `old_lines` verbatim within the file.  In many
        // real‑world diffs the last element of `old_lines` is an *empty* string
        // representing the terminating newline of the region being replaced.
        // This sentinel is not present in `original_lines` because `SourceFile`
        // stores the terminator on the preceding line rather than as an extra
        // trailing element. If a direct search fails and the pattern ends with
        // an empty string, retry without that final element so modifications
        // touching the end‑of‑file can be located reliably.

        let mut pattern: &[String] = &chunk.old_lines;
        let mut found = seek_sequence::seek_sequence(
            original_lines,
            pattern,
            line_index,
            chunk.is_end_of_file,
            update_file_mode,
        );

        let mut new_slice: &[String] = &chunk.new_lines;

        if found.is_none() && pattern.last().is_some_and(String::is_empty) {
            // Retry without the trailing empty line which represents the final
            // newline in the file.
            pattern = &pattern[..pattern.len() - 1];
            if new_slice.last().is_some_and(String::is_empty) {
                new_slice = &new_slice[..new_slice.len() - 1];
            }

            found = seek_sequence::seek_sequence(
                original_lines,
                pattern,
                line_index,
                chunk.is_end_of_file,
                update_file_mode,
            );
        }

        let Some(start_idx) = found else {
            return Err(match_failure(
                &format!("Failed to find expected lines in {path}:"),
                original_lines,
                pattern,
                line_index,
                update_file_mode,
                context_index,
            ));
        };
        match update_file_mode {
            ApplyPatchFileUpdateMode::NormalizeToLf => {
                replacements.push((start_idx, pattern.len(), new_slice.to_vec()));
            }
            ApplyPatchFileUpdateMode::PreserveLineEndings => {
                // Context lines occur in both sides of a patch chunk. Keep those
                // original lines in place so their exact contents and terminators
                // survive, especially when the file has mixed line endings.
                let mut old_start = 0;
                let mut new_start = 0;
                for &(old_context, new_context) in &chunk.context_line_indices {
                    // A trailing empty context line can be removed from `pattern`
                    // and `new_slice` above when it represents the final newline.
                    if old_context >= pattern.len() || new_context >= new_slice.len() {
                        break;
                    }
                    if old_start != old_context || new_start != new_context {
                        replacements.push((
                            start_idx + old_start,
                            old_context - old_start,
                            new_slice[new_start..new_context].to_vec(),
                        ));
                    }
                    old_start = old_context + 1;
                    new_start = new_context + 1;
                }
                if old_start != pattern.len() || new_start != new_slice.len() {
                    replacements.push((
                        start_idx + old_start,
                        pattern.len() - old_start,
                        new_slice[new_start..].to_vec(),
                    ));
                }
            }
        }
        line_index = start_idx + pattern.len();
    }

    replacements.sort_by_key(|(index, _, _)| *index);

    Ok(replacements)
}

/// Apply the `(start_index, old_len, new_lines)` replacements to `original_lines`,
/// returning the modified file contents as a vector of lines.
fn apply_replacements(mut lines: Vec<String>, replacements: &[Replacement]) -> Vec<String> {
    // We must apply replacements in descending order so that earlier replacements
    // don't shift the positions of later ones.
    for (start_idx, old_len, new_segment) in replacements.iter().rev() {
        let start_idx = *start_idx;
        let old_len = *old_len;

        // Remove old lines.
        for _ in 0..old_len {
            if start_idx < lines.len() {
                lines.remove(start_idx);
            }
        }

        // Insert new lines.
        for (offset, new_line) in new_segment.iter().enumerate() {
            lines.insert(start_idx + offset, new_line.clone());
        }
    }

    lines
}

/// Lines of expected text and source excerpt a match failure shows.
const DIAGNOSTIC_LINES: usize = 8;
/// UTF-16 units per echoed line, as the TypeScript port counts them.
const DIAGNOSTIC_LINE_UNITS: usize = 240;
/// Pattern lines tried as a literal anchor for the source excerpt.
const ANCHOR_CANDIDATES: usize = 12;
/// A shorter trimmed line is too common to anchor anything.
const ANCHOR_MIN_UNITS: usize = 8;

/// Diagnostics only: never retry a replacement at a different location.
fn match_failure(
    heading: &str,
    lines: &[String],
    pattern: &[String],
    start: usize,
    mode: ApplyPatchFileUpdateMode,
    context_index: Option<usize>,
) -> ApplyPatchError {
    let earlier = if start > 0 {
        seek_sequence::seek_sequence(lines, pattern, 0, false, mode)
    } else {
        None
    };
    let out_of_order = earlier.filter(|&index| index < start);
    let guidance = match out_of_order {
        Some(index) => format!(
            "Matching text exists at line {}, before the current search position at line {}. Put edits in file order and avoid overlapping hunks.",
            index + 1,
            start + 1
        ),
        None => "Use the current file text as patch context; do not reconstruct or reformat the old lines.".to_owned(),
    };
    let mut expected = pattern
        .iter()
        .take(DIAGNOSTIC_LINES)
        .map(|line| clip(line))
        .collect::<Vec<_>>()
        .join("\n");
    if pattern.len() > DIAGNOSTIC_LINES {
        expected.push_str("\n… (expected text truncated)");
    }

    // A matched @@ context or a unique literal anchor can locate a useful excerpt. Never
    // choose a vaguely similar block or dump the file start when there is no reliable anchor.
    let anchor = out_of_order
        .or(context_index)
        .or_else(|| unique_anchor(lines, pattern));
    let source_context = anchor.map(|anchor| {
        let from = anchor.saturating_sub(2);
        let excerpt = lines
            .iter()
            .enumerate()
            .skip(from)
            .take(DIAGNOSTIC_LINES)
            .map(|(index, line)| format!("{}\t{}", index + 1, clip(line)))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "Source excerpt from the patch verification snapshot (line numbers are not file content):\n{excerpt}"
        )
    });
    ApplyPatchError::ComputeReplacements {
        message: format!("{heading}\n{guidance}\nExpected text:\n{expected}"),
        source_context,
    }
}

fn unique_anchor(lines: &[String], pattern: &[String]) -> Option<usize> {
    pattern
        .iter()
        .take(ANCHOR_CANDIDATES)
        .find_map(|candidate| {
            let text = js_trim(candidate);
            if utf16_len(text) < ANCHOR_MIN_UNITS {
                return None;
            }
            let first = lines.iter().position(|line| js_trim(line) == text)?;
            let repeated = lines[first + 1..].iter().any(|line| js_trim(line) == text);
            (!repeated).then_some(first)
        })
}

/// `line.length > 240 ? line.slice(0, 240) + '…' : line`, in UTF-16 units. A cut never splits a
/// surrogate pair: the pair that would straddle the limit is left out.
fn clip(line: &str) -> String {
    if utf16_len(line) <= DIAGNOSTIC_LINE_UNITS {
        return line.to_owned();
    }
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in line.char_indices() {
        if units + ch.len_utf16() > DIAGNOSTIC_LINE_UNITS {
            break;
        }
        units += ch.len_utf16();
        end = index + ch.len_utf8();
    }
    format!("{}…", &line[..end])
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// JavaScript's `String.prototype.trim`: Rust's `trim` set without U+0085, plus U+FEFF.
fn js_trim(text: &str) -> &str {
    let js_space = |ch: char| ch == '\u{feff}' || (ch != '\u{85}' && ch.is_whitespace());
    text.trim_matches(js_space)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::{Hunk, parse_patch};

    fn chunks(body: &str) -> Vec<UpdateFileChunk> {
        let patch = format!("*** Begin Patch\n*** Update File: sample.ts\n{body}\n*** End Patch");
        match parse_patch(&patch).map(|args| args.hunks) {
            Ok(hunks) => match hunks.into_iter().next() {
                Some(Hunk::UpdateFile { chunks, .. }) => chunks,
                other => panic!("expected an update hunk, got {other:?}"),
            },
            Err(error) => panic!("{error}"),
        }
    }

    fn failure(
        body: &str,
        mode: ApplyPatchFileUpdateMode,
        source: &str,
    ) -> (String, Option<String>) {
        match derive_new_contents_from_chunks("sample.ts", source.to_owned(), &chunks(body), mode) {
            Err(ApplyPatchError::ComputeReplacements {
                message,
                source_context,
            }) => (message, source_context),
            Err(other) => panic!("unexpected error {other}"),
            Ok(applied) => panic!("unexpectedly applied: {:?}", applied.new_contents),
        }
    }

    fn applied(body: &str, mode: ApplyPatchFileUpdateMode, source: &str) -> String {
        match derive_new_contents_from_chunks("sample.ts", source.to_owned(), &chunks(body), mode) {
            Ok(applied) => applied.new_contents,
            Err(error) => panic!("{error}"),
        }
    }

    const MODES: [ApplyPatchFileUpdateMode; 2] = [
        ApplyPatchFileUpdateMode::NormalizeToLf,
        ApplyPatchFileUpdateMode::PreserveLineEndings,
    ];

    #[test]
    fn explains_backward_edits_and_accepts_the_ordered_correction() {
        let source = "function early() {}\r\nseparator\r\nfunction late() {}\r\n";
        let early = "@@\n-function early() {}\n+function early() { return 1; }";
        let late = "@@\n-function late() {}\n+function late() { return 2; }";
        for mode in MODES {
            let (message, excerpt) = failure(&format!("{late}\n{early}"), mode, source);
            assert!(message.contains(
                "Matching text exists at line 1, before the current search position at line 4"
            ));
            assert!(message.contains("Put edits in file order"));
            assert!(
                excerpt
                    .unwrap_or_default()
                    .contains("1\tfunction early() {}")
            );
            let corrected = applied(&format!("{early}\n{late}"), mode, source);
            assert!(corrected.contains("function early() { return 1; }"));
            assert!(corrected.contains("function late() { return 2; }"));
            if mode == ApplyPatchFileUpdateMode::PreserveLineEndings {
                assert!(corrected.contains("\r\n"));
            }
        }
    }

    #[test]
    fn explains_backward_context_markers_too() {
        let (message, _) = failure(
            "@@\n-late();\n+later();\n@@ function early() {\n-old();\n+new();",
            ApplyPatchFileUpdateMode::NormalizeToLf,
            "function early() {\nold();\n}\nlate();\n",
        );
        assert!(message.contains("Failed to find context in sample.ts"));
        assert!(message.contains("Matching text exists at line 1"));
    }

    #[test]
    fn shows_a_bounded_snapshot_near_a_unique_anchor() {
        let source = format!(
            "unrelated\nfor (const tab of exact) {{\n  try {{\n    reload(tab.id);\n  }} catch {{ /* actual comment */ }}\n}}\n{}\n{}",
            "x".repeat(5000),
            "tail\n".repeat(100)
        );
        let (message, excerpt) = failure(
            "@@\n for (const tab of exact) {\n-  try { reload(tab.id); } catch { /* guessed */ }\n+  fixed();\n }",
            ApplyPatchFileUpdateMode::NormalizeToLf,
            &source,
        );
        assert!(message.contains("Use the current file text as patch context"));
        assert!(!message.contains("Matching text exists"));
        assert!(!message.contains("actual comment"));
        let excerpt = excerpt.unwrap_or_default();
        assert!(excerpt.contains("5\t  } catch { /* actual comment */ }"));
        assert!(excerpt.len() < 2200);
        assert_eq!(excerpt.split('\n').count(), 9);
    }

    #[test]
    fn invents_no_excerpt_from_absent_or_ambiguous_anchors() {
        for source in [
            "other text\n",
            "sharedAnchor();\nfirst();\nsharedAnchor();\nsecond();\n",
        ] {
            let (_, excerpt) = failure(
                "@@\n sharedAnchor();\n-missing();\n+new();",
                ApplyPatchFileUpdateMode::NormalizeToLf,
                source,
            );
            assert_eq!(excerpt, None);
        }
    }

    #[test]
    fn bounds_echoed_expected_text() {
        let mut body = vec!["@@".to_owned()];
        body.extend((0..100).map(|_| format!("-{}", "x".repeat(10_000))));
        body.push("+replacement".to_owned());
        let (message, excerpt) = failure(
            &body.join("\n"),
            ApplyPatchFileUpdateMode::NormalizeToLf,
            "actual\n",
        );
        assert!(message.len() < 2400);
        assert!(message.contains("(expected text truncated)"));
        assert_eq!(excerpt, None);
    }

    #[test]
    fn keeps_a_byte_order_mark_off_line_one_and_on_the_result() {
        let source = "\u{feff}using System;\nclass Program {}\n";
        let result = applied(
            "@@\n-using System;\n+using System.Text;\n class Program {}",
            ApplyPatchFileUpdateMode::NormalizeToLf,
            source,
        );
        assert_eq!(result, "\u{feff}using System.Text;\nclass Program {}\n");
    }

    #[test]
    fn preserves_mixed_line_endings_and_inserts_with_the_first_one() {
        let source = "one\r\ntwo\nthree\r\n";
        let result = applied(
            "@@\n one\n-two\n+TWO\n+inserted\n three",
            ApplyPatchFileUpdateMode::PreserveLineEndings,
            source,
        );
        assert_eq!(result, "one\r\nTWO\r\ninserted\r\nthree\r\n");
    }

    #[test]
    fn clips_by_utf16_units() {
        let line = "😀".repeat(200);
        let clipped = clip(&line);
        assert_eq!(utf16_len(&clipped), 241);
        assert!(clipped.ends_with('…'));
    }
}
