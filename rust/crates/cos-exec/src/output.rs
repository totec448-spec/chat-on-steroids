//! `ExecCommandToolOutput`: what one `exec_command` or `write_stdin` call answers, and the two
//! renderings the model receives (`response_text` and the structured `code_mode_result`).

use serde_json::{Map, Value, json};

use crate::buffer::{OUTPUT_MAX_BYTES, format_output_omission_marker};
use crate::truncate::{
    approx_bytes_for_tokens, approx_token_count, formatted_truncate_text, truncate_to_tokens,
};

/// The budget when the caller names none (`DEFAULT_MAX_OUTPUT_TOKENS`).
const DEFAULT_MAX_OUTPUT_TOKENS: usize = 10_000;
/// The ceiling over any requested budget: the collection cap in tokens
/// (`UNIFIED_EXEC_OUTPUT_MAX_TOKENS`).
const OUTPUT_CEILING_TOKENS: usize = OUTPUT_MAX_BYTES / 4;

/// Whether the session behind a result still runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    /// `Process running with session ID n`.
    Running(u32),
    /// `Process exited with code n` (when known) and `Completed session ID: n`.
    Completed { session: u32, exit: Option<i64> },
}

#[derive(Clone, Debug)]
pub(crate) struct ToolOutput {
    pub chunk_id: String,
    pub wall_time_ms: f64,
    pub status: Status,
    /// Retained output of an already completed session, reread without running anything.
    pub replayed: bool,
    pub expected_exit: bool,
    /// What the model reads: the batch display stream when there is one.
    pub output: Vec<u8>,
    /// The child's own stream, batch delimiters included (`rawOutput`).
    pub raw: Vec<u8>,
    pub max_output_tokens: Option<usize>,
    pub original_token_count: Option<usize>,
    /// Bytes the 1 MiB collection cap dropped before any model-facing truncation.
    pub omitted_bytes: Option<usize>,
}

impl ToolOutput {
    fn max_tokens(&self) -> usize {
        self.max_output_tokens
            .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
            .min(OUTPUT_CEILING_TOKENS)
    }

    /// `ExecCommandToolOutput::truncated_output`.
    pub(crate) fn truncated_output(&self) -> String {
        let max_tokens = self.max_tokens();
        let text = String::from_utf8_lossy(&self.output);
        let Some(omitted) = self.omitted_bytes.filter(|&omitted| omitted > 0) else {
            return formatted_truncate_text(&text, max_tokens);
        };
        let marker = format_output_omission_marker(omitted);
        if text.len() <= approx_bytes_for_tokens(max_tokens) {
            return if text.contains(&marker) {
                text.into_owned()
            } else {
                format!("{marker}\n{text}")
            };
        }
        let original = self
            .original_token_count
            .unwrap_or_else(|| approx_token_count(&text));
        let truncated = truncate_to_tokens(&text, max_tokens);
        let notice = if truncated.contains(&marker) {
            String::new()
        } else {
            format!("{marker}\n")
        };
        format!(
            "Warning: truncated output (original token count: {original})\n{notice}\n{truncated}"
        )
    }

    /// `ExecCommandToolOutput::response_text`: exactly the text the model is handed.
    pub(crate) fn response_text(&self) -> String {
        let mut sections = Vec::new();
        if !self.chunk_id.is_empty() {
            sections.push(format!("Chunk ID: {}", self.chunk_id));
        }
        sections.push(format!(
            "Wall time: {:.4} seconds",
            self.wall_time_ms / 1000.0
        ));
        match self.status {
            Status::Running(session) => {
                sections.push(format!("Process running with session ID {session}"));
            }
            Status::Completed { session, exit } => {
                if let Some(code) = exit {
                    sections.push(format!("Process exited with code {code}"));
                }
                sections.push(format!("Completed session ID: {session}"));
            }
        }
        if self.replayed {
            sections
                .push("Retained output (already completed; command was not run again):".to_owned());
        }
        if self.expected_exit {
            sections.push(
                "This non-zero exit is an expected command result, not a failure.".to_owned(),
            );
        }
        if let Some(count) = self.original_token_count {
            sections.push(format!("Original token count: {count}"));
        }
        sections.push("Output:".to_owned());
        sections.push(self.truncated_output());
        sections.join("\n")
    }

    /// `code_mode_result`, also the tool's declared output schema. Key order is the wire order.
    pub(crate) fn structured(&self) -> Map<String, Value> {
        let mut out = Map::new();
        if !self.chunk_id.is_empty() {
            out.insert("chunk_id".into(), json!(self.chunk_id));
        }
        out.insert(
            "wall_time_seconds".into(),
            json!(self.wall_time_ms / 1000.0),
        );
        match self.status {
            Status::Running(session) => {
                out.insert("session_id".into(), json!(session));
            }
            Status::Completed { session, exit } => {
                if let Some(code) = exit {
                    out.insert("exit_code".into(), json!(code));
                }
                out.insert("completed_session_id".into(), json!(session));
            }
        }
        if self.expected_exit {
            out.insert("expected_exit".into(), json!(true));
        }
        if self.replayed {
            out.insert("output_replayed".into(), json!(true));
        }
        if let Some(count) = self.original_token_count {
            out.insert("original_token_count".into(), json!(count));
        }
        out.insert("output".into(), json!(self.truncated_output()));
        out
    }

    /// The exit code a recorder judges the call by, once the process has finished.
    pub(crate) fn exit_code(&self) -> Option<i64> {
        match self.status {
            Status::Completed { exit, .. } => exit,
            Status::Running(_) => None,
        }
    }
}

/// Six random lowercase hex characters (`generate_chunk_id`).
pub(crate) fn chunk_id() -> String {
    format!("{:06x}", crate::random::next() & 0xff_ffff)
}
