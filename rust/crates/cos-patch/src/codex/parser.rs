// Vendored from OpenAI Codex, `codex-rs/apply-patch/src/parser.rs` at commit
// 1a4096e273e80da30947e57fdfa45be92858ca91 (https://github.com/openai/codex).
// Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0; see `codex/LICENSE`
// and `codex/NOTICE` in this crate.
//
// Modified for Chat On Steroids:
// - A hunk keeps its path as the `String` the patch spelled. The connector resolves it through
//   the sandbox, and `print_summary` prints the spelling.
// - `Hunk::resolve_path` (a `PathUri` join) and `ApplyPatchArgs::workdir` (set only by shell
//   interception) are removed. `ParseError` implements `Display` by hand instead of `thiserror`.
// - The tests are kept, adapted to `String` paths.

//! This module is responsible for parsing & validating a patch into a list of "hunks".
//! (It does not attempt to actually check that the patch can be applied to the filesystem.)
//!
//! The official Lark grammar for the apply-patch format is:
//!
//! start: begin_patch environment_id? hunk+ end_patch
//! begin_patch: "*** Begin Patch" LF
//! environment_id: "*** Environment ID: " filename LF
//! end_patch: "*** End Patch" LF?
//!
//! hunk: add_hunk | delete_hunk | update_hunk
//! add_hunk: "*** Add File: " filename LF add_line+
//! delete_hunk: "*** Delete File: " filename LF
//! update_hunk: "*** Update File: " filename LF change_move? change?
//! filename: /(.+)/
//! add_line: "+" /(.+)/ LF -> line
//!
//! change_move: "*** Move to: " filename LF
//! change: (change_context | change_line)+ eof_line?
//! change_context: ("@@" | "@@ " /(.+)/) LF
//! change_line: ("+" | "-" | " ") /(.+)/ LF
//! eof_line: "*** End of File" LF
//!
//! The parser below is a little more lenient than the explicit spec and allows for
//! leading/trailing whitespace around patch markers.

use std::fmt;

use super::streaming_parser::StreamingPatchParser;

pub(crate) const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";
pub(crate) const END_PATCH_MARKER: &str = "*** End Patch";
pub(crate) const ADD_FILE_MARKER: &str = "*** Add File: ";
pub(crate) const DELETE_FILE_MARKER: &str = "*** Delete File: ";
pub(crate) const UPDATE_FILE_MARKER: &str = "*** Update File: ";
pub(crate) const MOVE_TO_MARKER: &str = "*** Move to: ";
pub(crate) const EOF_MARKER: &str = "*** End of File";
pub(crate) const CHANGE_CONTEXT_MARKER: &str = "@@ ";
pub(crate) const EMPTY_CHANGE_CONTEXT_MARKER: &str = "@@";

/// Currently, the only OpenAI model that knowingly requires lenient parsing is
/// gpt-4.1. While we could try to require everyone to pass in a strictness
/// param when invoking apply_patch, it is a pain to thread it through all of
/// the call sites, so we resign ourselves allowing lenient parsing for all
/// models. See [`ParseMode::Lenient`] for details on the exceptions we make for
/// gpt-4.1.
const PARSE_IN_STRICT_MODE: bool = false;

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ParseError {
    InvalidPatchError(String),
    InvalidHunkError { message: String, line_number: usize },
}
use ParseError::*;

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InvalidPatchError(message) => write!(f, "invalid patch: {message}"),
            InvalidHunkError {
                message,
                line_number,
            } => write!(f, "invalid hunk at line {line_number}, {message}"),
        }
    }
}

impl std::error::Error for ParseError {}

#[derive(Debug, PartialEq, Eq, Clone)]
#[allow(clippy::enum_variant_names)]
pub enum Hunk {
    AddFile {
        path: String,
        contents: String,
    },
    DeleteFile {
        path: String,
    },
    UpdateFile {
        path: String,
        move_path: Option<String>,

        /// Chunks should be in order, i.e. the `change_context` of one chunk
        /// should occur later in the file than the previous chunk.
        chunks: Vec<UpdateFileChunk>,
    },
}

impl Hunk {
    /// Returns the path affected by this hunk, using the move destination for rename hunks.
    pub fn path(&self) -> &str {
        match self {
            Hunk::AddFile { path, .. } => path,
            Hunk::DeleteFile { path } => path,
            Hunk::UpdateFile {
                move_path: Some(path),
                ..
            } => path,
            Hunk::UpdateFile {
                path,
                move_path: None,
                ..
            } => path,
        }
    }

    /// The path this hunk reads or replaces: the source of a rename, not its destination.
    pub fn source_path(&self) -> &str {
        match self {
            Hunk::AddFile { path, .. } | Hunk::DeleteFile { path } => path,
            Hunk::UpdateFile { path, .. } => path,
        }
    }
}

#[cfg(test)]
use Hunk::*;

#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub struct UpdateFileChunk {
    /// A single line of context used to narrow down the position of the chunk
    /// (this is usually a class, method, or function definition.)
    pub change_context: Option<String>,

    /// A contiguous block of lines that should be replaced with `new_lines`.
    /// `old_lines` must occur strictly after `change_context`.
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,

    /// Pairs of indices into `old_lines` and `new_lines` that identify lines
    /// parsed as context rather than inferred to be equal by their contents.
    pub context_line_indices: Vec<(usize, usize)>,

    /// If set to true, `old_lines` must occur at the end of the source file.
    /// (Tolerance around trailing newlines should be encouraged.)
    pub is_end_of_file: bool,
}

impl UpdateFileChunk {
    /// Adds a context line to both sides while recording its corresponding
    /// indices so it remains distinguishable from identical changed lines.
    pub(crate) fn push_context_line(&mut self, line: String) {
        self.context_line_indices
            .push((self.old_lines.len(), self.new_lines.len()));
        self.old_lines.push(line.clone());
        self.new_lines.push(line);
    }
}

/// Both the raw PATCH argument and the argument parsed into hunks.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct ApplyPatchArgs {
    pub patch: String,
    pub hunks: Vec<Hunk>,
    pub environment_id: Option<String>,
}

pub fn parse_patch(patch: &str) -> Result<ApplyPatchArgs, ParseError> {
    let mode = if PARSE_IN_STRICT_MODE {
        ParseMode::Strict
    } else {
        ParseMode::Lenient
    };
    parse_patch_text(patch, mode)
}

enum ParseMode {
    /// Parse the patch text argument as is.
    #[cfg_attr(not(test), allow(dead_code))]
    Strict,

    /// GPT-4.1 is known to formulate the `command` array for the `local_shell`
    /// tool call for `apply_patch` call using something like the following:
    ///
    /// ```json
    /// [
    ///   "apply_patch",
    ///   "<<'EOF'\n*** Begin Patch\n*** Update File: README.md\n@@...\n*** End Patch\nEOF\n",
    /// ]
    /// ```
    ///
    /// This is a problem because `local_shell` is a bit of a misnomer: the
    /// `command` is not invoked by passing the arguments to a shell like Bash,
    /// but are invoked using something akin to `execvpe(3)`.
    ///
    /// This is significant in this case because where a shell would interpret
    /// `<<'EOF'...` as a heredoc and pass the contents via stdin (which is
    /// fine, as `apply_patch` is specified to read from stdin if no argument is
    /// passed), `execvpe(3)` interprets the heredoc as a literal string. To get
    /// the `local_shell` tool to run a command the way shell would, the
    /// `command` array must be something like:
    ///
    /// ```json
    /// [
    ///   "bash",
    ///   "-lc",
    ///   "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: README.md\n@@...\n*** End Patch\nEOF\n",
    /// ]
    /// ```
    ///
    /// In lenient mode, we check if the argument to `apply_patch` starts with
    /// `<<'EOF'` and ends with `EOF\n`. If so, we strip off these markers,
    /// trim() the result, and treat what is left as the patch text.
    Lenient,
}

fn parse_patch_text(patch: &str, mode: ParseMode) -> Result<ApplyPatchArgs, ParseError> {
    let lines: Vec<&str> = patch.trim().lines().collect();
    let patch_lines = match mode {
        ParseMode::Strict => check_patch_boundaries_strict(&lines)?,
        ParseMode::Lenient => check_patch_boundaries_lenient(&lines)?,
    };

    let patch = patch_lines.join("\n");
    let mut parser = StreamingPatchParser::default();
    parser.push_delta(&patch)?;
    let hunks = parser.finish()?;
    let environment_id = parser.environment_id().map(str::to_owned);
    Ok(ApplyPatchArgs {
        hunks,
        patch,
        environment_id,
    })
}

/// Checks the start and end lines of the patch text for `apply_patch`,
/// returning an error if they do not match the expected markers.
fn check_patch_boundaries_strict<'a>(lines: &'a [&'a str]) -> Result<&'a [&'a str], ParseError> {
    let (first_line, last_line) = match lines {
        [] => (None, None),
        [first] => (Some(first), Some(first)),
        [first, .., last] => (Some(first), Some(last)),
    };
    check_start_and_end_lines_strict(first_line, last_line)?;
    Ok(lines)
}

/// If we are in lenient mode, we check if the first line starts with `<<EOF`
/// (possibly quoted) and the last line ends with `EOF`. There must be at least
/// 4 lines total because the heredoc markers take up 2 lines and the patch text
/// must have at least 2 lines.
///
/// If successful, returns the lines of the patch text that contain the patch
/// contents, excluding the heredoc markers.
fn check_patch_boundaries_lenient<'a>(
    original_lines: &'a [&'a str],
) -> Result<&'a [&'a str], ParseError> {
    let original_parse_error = match check_patch_boundaries_strict(original_lines) {
        Ok(lines) => return Ok(lines),
        Err(e) => e,
    };

    match original_lines {
        [first, .., last] => {
            if (first == &"<<EOF" || first == &"<<'EOF'" || first == &"<<\"EOF\"")
                && last.ends_with("EOF")
                && original_lines.len() >= 4
            {
                let inner_lines = &original_lines[1..original_lines.len() - 1];
                check_patch_boundaries_strict(inner_lines)
            } else {
                Err(original_parse_error)
            }
        }
        _ => Err(original_parse_error),
    }
}

fn check_start_and_end_lines_strict(
    first_line: Option<&&str>,
    last_line: Option<&&str>,
) -> Result<(), ParseError> {
    let first_line = first_line.map(|line| line.trim());
    let last_line = last_line.map(|line| line.trim());

    match (first_line, last_line) {
        (Some(first), Some(last)) if first == BEGIN_PATCH_MARKER && last == END_PATCH_MARKER => {
            Ok(())
        }
        (Some(first), _) if first != BEGIN_PATCH_MARKER => Err(InvalidPatchError(String::from(
            "The first line of the patch must be '*** Begin Patch'",
        ))),
        _ => Err(InvalidPatchError(String::from(
            "The last line of the patch must be '*** End Patch'",
        ))),
    }
}

#[test]
fn test_parse_patch() {
    assert_eq!(
        parse_patch_text("bad", ParseMode::Strict),
        Err(InvalidPatchError(
            "The first line of the patch must be '*** Begin Patch'".to_string()
        ))
    );
    assert_eq!(
        parse_patch_text("*** Begin Patch\nbad", ParseMode::Strict),
        Err(InvalidPatchError(
            "The last line of the patch must be '*** End Patch'".to_string()
        ))
    );

    assert_eq!(
        parse_patch_text(
            concat!(
                "*** Begin Patch",
                " ",
                "\n*** Add File: foo\n+hi\n",
                " ",
                "*** End Patch"
            ),
            ParseMode::Strict
        )
        .map(|args| args.hunks),
        Ok(vec![AddFile {
            path: "foo".to_string(),
            contents: "hi\n".to_string()
        }])
    );
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Update File: test.py\n\
             *** End Patch",
            ParseMode::Strict
        ),
        Err(InvalidHunkError {
            message: "Update file hunk for path 'test.py' is empty".to_string(),
            line_number: 2,
        })
    );
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** End Patch",
            ParseMode::Strict
        )
        .map(|args| args.hunks),
        Ok(Vec::new())
    );
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Add File: path/add.py\n\
             +abc\n\
             +def\n\
             *** Delete File: path/delete.py\n\
             *** Update File: path/update.py\n\
             *** Move to: path/update2.py\n\
             @@ def f():\n\
             -    pass\n\
             +    return 123\n\
             *** End Patch",
            ParseMode::Strict
        )
        .map(|args| args.hunks),
        Ok(vec![
            AddFile {
                path: "path/add.py".to_string(),
                contents: "abc\ndef\n".to_string()
            },
            DeleteFile {
                path: "path/delete.py".to_string()
            },
            UpdateFile {
                path: "path/update.py".to_string(),
                move_path: Some("path/update2.py".to_string()),
                chunks: vec![UpdateFileChunk {
                    change_context: Some("def f():".to_string()),
                    old_lines: vec!["    pass".to_string()],
                    new_lines: vec!["    return 123".to_string()],
                    context_line_indices: vec![],
                    is_end_of_file: false
                }]
            }
        ])
    );
    // Update hunk followed by another hunk (Add File).
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Update File: file.py\n\
             @@\n\
             +line\n\
             *** Add File: other.py\n\
             +content\n\
             *** End Patch",
            ParseMode::Strict
        )
        .map(|args| args.hunks),
        Ok(vec![
            UpdateFile {
                path: "file.py".to_string(),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: vec![],
                    new_lines: vec!["line".to_string()],
                    context_line_indices: vec![],
                    is_end_of_file: false
                }],
            },
            AddFile {
                path: "other.py".to_string(),
                contents: "content\n".to_string()
            }
        ])
    );

    // Update hunk without an explicit @@ header for the first chunk should parse.
    // Use a raw string to preserve the leading space diff marker on the context line.
    assert_eq!(
        parse_patch_text(
            r#"*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch"#,
            ParseMode::Strict
        )
        .map(|args| args.hunks),
        Ok(vec![UpdateFile {
            path: "file2.py".to_string(),
            move_path: None,
            chunks: vec![UpdateFileChunk {
                change_context: None,
                old_lines: vec!["import foo".to_string()],
                new_lines: vec!["import foo".to_string(), "bar".to_string()],
                context_line_indices: vec![(0, 0)],
                is_end_of_file: false,
            }],
        }])
    );
}

#[test]
fn test_parse_patch_preserves_end_of_file_marker() {
    let patch =
        "*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch";
    assert_eq!(
        parse_patch(patch),
        Ok(ApplyPatchArgs {
            hunks: vec![UpdateFile {
                path: "file.txt".to_string(),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: Vec::new(),
                    new_lines: vec!["quux".to_string()],
                    context_line_indices: vec![],
                    is_end_of_file: true,
                }],
            }],
            patch: patch.to_string(),
            environment_id: None,
        })
    );
}

#[test]
fn test_parse_patch_lenient() {
    let patch_text = r#"*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch"#;
    let expected_patch = vec![UpdateFile {
        path: "file2.py".to_string(),
        move_path: None,
        chunks: vec![UpdateFileChunk {
            change_context: None,
            old_lines: vec!["import foo".to_string()],
            new_lines: vec!["import foo".to_string(), "bar".to_string()],
            context_line_indices: vec![(0, 0)],
            is_end_of_file: false,
        }],
    }];
    let expected_error =
        InvalidPatchError("The first line of the patch must be '*** Begin Patch'".to_string());
    let parsed = |hunks: Vec<Hunk>| ApplyPatchArgs {
        hunks,
        patch: patch_text.to_string(),
        environment_id: None,
    };

    for heredoc in [
        format!("<<EOF\n{patch_text}\nEOF\n"),
        format!("<<'EOF'\n{patch_text}\nEOF\n"),
        format!("<<\"EOF\"\n{patch_text}\nEOF\n"),
    ] {
        assert_eq!(
            parse_patch_text(&heredoc, ParseMode::Strict),
            Err(expected_error.clone())
        );
        assert_eq!(
            parse_patch_text(&heredoc, ParseMode::Lenient),
            Ok(parsed(expected_patch.clone()))
        );
    }

    let patch_text_in_mismatched_quotes_heredoc = format!("<<\"EOF'\n{patch_text}\nEOF\n");
    assert_eq!(
        parse_patch_text(&patch_text_in_mismatched_quotes_heredoc, ParseMode::Strict),
        Err(expected_error.clone())
    );
    assert_eq!(
        parse_patch_text(&patch_text_in_mismatched_quotes_heredoc, ParseMode::Lenient),
        Err(expected_error.clone())
    );

    let patch_text_with_missing_closing_heredoc =
        "<<EOF\n*** Begin Patch\n*** Update File: file2.py\nEOF\n".to_string();
    assert_eq!(
        parse_patch_text(&patch_text_with_missing_closing_heredoc, ParseMode::Strict),
        Err(expected_error)
    );
    assert_eq!(
        parse_patch_text(&patch_text_with_missing_closing_heredoc, ParseMode::Lenient),
        Err(InvalidPatchError(
            "The last line of the patch must be '*** End Patch'".to_string()
        ))
    );
}

#[test]
fn test_parse_patch_environment_id_preamble() {
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Environment ID: remote\n\
             *** Add File: hello.txt\n\
             +hello\n\
             *** End Patch",
            ParseMode::Strict
        ),
        Ok(ApplyPatchArgs {
            hunks: vec![AddFile {
                path: "hello.txt".to_string(),
                contents: "hello\n".to_string(),
            }],
            patch: "*** Begin Patch\n*** Environment ID: remote\n*** Add File: hello.txt\n+hello\n*** End Patch".to_string(),
            environment_id: Some("remote".to_string()),
        })
    );

    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Environment ID:   \n\
             *** Add File: hello.txt\n\
             +hello\n\
             *** End Patch",
            ParseMode::Strict
        ),
        Err(InvalidPatchError(
            "apply_patch environment_id cannot be empty".to_string()
        ))
    );
}
