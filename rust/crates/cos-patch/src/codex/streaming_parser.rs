// Vendored from OpenAI Codex, `codex-rs/apply-patch/src/streaming_parser.rs` at commit
// 1a4096e273e80da30947e57fdfa45be92858ca91 (https://github.com/openai/codex).
// Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0; see `codex/LICENSE`
// and `codex/NOTICE` in this crate.
//
// Modified for Chat On Steroids: hunk paths are the `String` the patch spelled instead of a
// `PathBuf`, and the upstream tests are not vendored (`tests/parser.rs` covers the grammar
// through `parse_patch`).

use super::parser::ADD_FILE_MARKER;
use super::parser::BEGIN_PATCH_MARKER;
use super::parser::CHANGE_CONTEXT_MARKER;
use super::parser::DELETE_FILE_MARKER;
use super::parser::EMPTY_CHANGE_CONTEXT_MARKER;
use super::parser::END_PATCH_MARKER;
use super::parser::EOF_MARKER;
use super::parser::Hunk;
use super::parser::MOVE_TO_MARKER;
use super::parser::ParseError;
use super::parser::UPDATE_FILE_MARKER;
use super::parser::UpdateFileChunk;

use Hunk::*;
use ParseError::*;

const ENVIRONMENT_ID_MARKER: &str = "*** Environment ID:";

#[derive(Debug, Default, Clone)]
pub struct StreamingPatchParser {
    line_buffer: String,
    state: StreamingParserState,
    line_number: usize,
}

#[derive(Debug, Default, Clone)]
struct StreamingParserState {
    mode: StreamingParserMode,
    hunks: Vec<Hunk>,
    environment_id: Option<String>,
}

#[derive(Debug, Default, Clone, Copy)]
enum StreamingParserMode {
    #[default]
    NotStarted,
    StartedPatch,
    AddFile,
    DeleteFile,
    UpdateFile {
        hunk_line_number: usize,
    },
    EndedPatch,
}

impl StreamingPatchParser {
    pub fn environment_id(&self) -> Option<&str> {
        self.state.environment_id.as_deref()
    }

    fn ensure_update_hunk_is_not_empty(&self, line: &str) -> Result<(), ParseError> {
        if let Some(UpdateFile { path, chunks, .. }) = self.state.hunks.last() {
            if chunks.is_empty()
                && let StreamingParserMode::UpdateFile { hunk_line_number } = self.state.mode
            {
                return Err(InvalidHunkError {
                    message: format!("Update file hunk for path '{}' is empty", path),
                    line_number: hunk_line_number,
                });
            }
            if chunks
                .last()
                .is_some_and(|chunk| chunk.old_lines.is_empty() && chunk.new_lines.is_empty())
            {
                if line == END_PATCH_MARKER {
                    return Err(InvalidHunkError {
                        message: "Update hunk does not contain any lines".to_string(),
                        line_number: self.line_number,
                    });
                }
                return Err(InvalidHunkError {
                    message: format!(
                        "Unexpected line found in update hunk: '{line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
                    ),
                    line_number: self.line_number,
                });
            }
        }
        Ok(())
    }

    fn handle_hunk_headers_and_end_patch(&mut self, trimmed: &str) -> Result<bool, ParseError> {
        if matches!(self.state.mode, StreamingParserMode::StartedPatch)
            && let Some(environment_id) = trimmed.strip_prefix(ENVIRONMENT_ID_MARKER)
        {
            if self.state.environment_id.is_some() {
                return Err(InvalidPatchError(
                    "apply_patch environment_id cannot be specified more than once".to_string(),
                ));
            }
            let environment_id = environment_id.trim();
            if environment_id.is_empty() {
                return Err(InvalidPatchError(
                    "apply_patch environment_id cannot be empty".to_string(),
                ));
            }
            self.state.environment_id = Some(environment_id.to_string());
            return Ok(true);
        }
        if trimmed == END_PATCH_MARKER {
            self.ensure_update_hunk_is_not_empty(trimmed)?;
            self.state.mode = StreamingParserMode::EndedPatch;
            return Ok(true);
        }
        if let Some(path) = trimmed.strip_prefix(ADD_FILE_MARKER) {
            self.ensure_update_hunk_is_not_empty(trimmed)?;
            self.state.hunks.push(AddFile {
                path: path.to_string(),
                contents: String::new(),
            });
            self.state.mode = StreamingParserMode::AddFile;
            return Ok(true);
        }
        if let Some(path) = trimmed.strip_prefix(DELETE_FILE_MARKER) {
            self.ensure_update_hunk_is_not_empty(trimmed)?;
            self.state.hunks.push(DeleteFile {
                path: path.to_string(),
            });
            self.state.mode = StreamingParserMode::DeleteFile;
            return Ok(true);
        }
        if let Some(path) = trimmed.strip_prefix(UPDATE_FILE_MARKER) {
            self.ensure_update_hunk_is_not_empty(trimmed)?;
            self.state.hunks.push(UpdateFile {
                path: path.to_string(),
                move_path: None,
                chunks: Vec::new(),
            });
            self.state.mode = StreamingParserMode::UpdateFile {
                hunk_line_number: self.line_number,
            };
            return Ok(true);
        }
        Ok(false)
    }

    pub fn push_delta(&mut self, delta: &str) -> Result<Vec<Hunk>, ParseError> {
        for ch in delta.chars() {
            if ch == '\n' {
                let mut line = std::mem::take(&mut self.line_buffer);
                line.truncate(line.strip_suffix('\r').map_or(line.len(), str::len));
                self.line_number += 1;
                self.process_line(&line)?;
            } else {
                self.line_buffer.push(ch);
            }
        }

        Ok(self.state.hunks.clone())
    }

    pub fn finish(&mut self) -> Result<Vec<Hunk>, ParseError> {
        if !self.line_buffer.is_empty() {
            let line = std::mem::take(&mut self.line_buffer);
            self.line_number += 1;
            if line.trim() == END_PATCH_MARKER {
                self.ensure_update_hunk_is_not_empty(line.trim())?;
                self.state.mode = StreamingParserMode::EndedPatch;
            } else {
                self.process_line(&line)?;
            }
        }

        if !matches!(self.state.mode, StreamingParserMode::EndedPatch) {
            return Err(InvalidPatchError(
                "The last line of the patch must be '*** End Patch'".to_string(),
            ));
        }

        Ok(self.state.hunks.clone())
    }

    fn process_line(&mut self, line: &str) -> Result<(), ParseError> {
        let trimmed = line.trim();
        match self.state.mode {
            StreamingParserMode::NotStarted => {
                if trimmed == BEGIN_PATCH_MARKER {
                    self.state.mode = StreamingParserMode::StartedPatch;
                    return Ok(());
                }
                Err(InvalidPatchError(
                    "The first line of the patch must be '*** Begin Patch'".to_string(),
                ))
            }
            StreamingParserMode::StartedPatch => {
                if self.handle_hunk_headers_and_end_patch(trimmed)? {
                    return Ok(());
                }
                Err(InvalidHunkError {
                    message: format!(
                        "'{trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', '*** Delete File: {{path}}', '*** Update File: {{path}}'"
                    ),
                    line_number: self.line_number,
                })
            }
            StreamingParserMode::AddFile => {
                if self.handle_hunk_headers_and_end_patch(trimmed)? {
                    return Ok(());
                }
                if let Some(line_to_add) = line.strip_prefix('+')
                    && let Some(AddFile { contents, .. }) = self.state.hunks.last_mut()
                {
                    contents.push_str(line_to_add);
                    contents.push('\n');
                    return Ok(());
                }
                Err(InvalidHunkError {
                    message: format!(
                        "'{trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', '*** Delete File: {{path}}', '*** Update File: {{path}}'"
                    ),
                    line_number: self.line_number,
                })
            }
            StreamingParserMode::DeleteFile => {
                if self.handle_hunk_headers_and_end_patch(trimmed)? {
                    return Ok(());
                }
                Err(InvalidHunkError {
                    message: format!(
                        "'{trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', '*** Delete File: {{path}}', '*** Update File: {{path}}'"
                    ),
                    line_number: self.line_number,
                })
            }
            StreamingParserMode::UpdateFile { hunk_line_number } => {
                let update_line = line.trim_end();
                if self.handle_hunk_headers_and_end_patch(update_line)? {
                    return Ok(());
                }

                if let Some(UpdateFile {
                    move_path, chunks, ..
                }) = self.state.hunks.last_mut()
                {
                    if chunks.last().is_some_and(|chunk| chunk.is_end_of_file) {
                        if update_line.is_empty() {
                            return Ok(());
                        }
                        if update_line != EMPTY_CHANGE_CONTEXT_MARKER
                            && !update_line.starts_with(CHANGE_CONTEXT_MARKER)
                        {
                            return Err(InvalidHunkError {
                                message: format!(
                                    "Expected update hunk to start with a @@ context marker, got: '{line}'"
                                ),
                                line_number: self.line_number,
                            });
                        }
                    }

                    if chunks.is_empty()
                        && move_path.is_none()
                        && let Some(move_to_path) = update_line.strip_prefix(MOVE_TO_MARKER)
                    {
                        *move_path = Some(move_to_path.to_string());
                        self.state.mode = StreamingParserMode::UpdateFile { hunk_line_number };
                        return Ok(());
                    }

                    if (update_line == EMPTY_CHANGE_CONTEXT_MARKER
                        || update_line.starts_with(CHANGE_CONTEXT_MARKER))
                        && chunks.last().is_some_and(|chunk| {
                            chunk.old_lines.is_empty() && chunk.new_lines.is_empty()
                        })
                    {
                        return Err(InvalidHunkError {
                            message: format!(
                                "Unexpected line found in update hunk: '{line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
                            ),
                            line_number: self.line_number,
                        });
                    }

                    if update_line == EMPTY_CHANGE_CONTEXT_MARKER {
                        chunks.push(UpdateFileChunk::default());
                        self.state.mode = StreamingParserMode::UpdateFile { hunk_line_number };
                        return Ok(());
                    }

                    if let Some(change_context) = update_line.strip_prefix(CHANGE_CONTEXT_MARKER) {
                        chunks.push(UpdateFileChunk {
                            change_context: Some(change_context.to_string()),
                            ..UpdateFileChunk::default()
                        });
                        self.state.mode = StreamingParserMode::UpdateFile { hunk_line_number };
                        return Ok(());
                    }

                    if update_line == EOF_MARKER {
                        if chunks.last().is_some_and(|chunk| {
                            chunk.old_lines.is_empty() && chunk.new_lines.is_empty()
                        }) {
                            return Err(InvalidHunkError {
                                message: "Update hunk does not contain any lines".to_string(),
                                line_number: self.line_number,
                            });
                        }
                        if let Some(chunk) = chunks.last_mut() {
                            chunk.is_end_of_file = true;
                        }
                        self.state.mode = StreamingParserMode::UpdateFile { hunk_line_number };
                        return Ok(());
                    }

                    if line.is_empty() {
                        if chunks.is_empty() {
                            chunks.push(UpdateFileChunk::default());
                        }
                        if let Some(chunk) = chunks.last_mut() {
                            chunk.push_context_line(String::new());
                        }
                        self.state.mode = StreamingParserMode::UpdateFile { hunk_line_number };
                        return Ok(());
                    }

                    if let Some(line_to_add) = line.strip_prefix(' ') {
                        if chunks.is_empty() {
                            chunks.push(UpdateFileChunk::default());
                        }
                        if let Some(chunk) = chunks.last_mut() {
                            chunk.push_context_line(line_to_add.to_string());
                        }
                        self.state.mode = StreamingParserMode::UpdateFile { hunk_line_number };
                        return Ok(());
                    }

                    if let Some(line_to_add) = line.strip_prefix('+') {
                        if chunks.is_empty() {
                            chunks.push(UpdateFileChunk::default());
                        }
                        if let Some(chunk) = chunks.last_mut() {
                            chunk.new_lines.push(line_to_add.to_string());
                        }
                        self.state.mode = StreamingParserMode::UpdateFile { hunk_line_number };
                        return Ok(());
                    }

                    if let Some(line_to_remove) = line.strip_prefix('-') {
                        if chunks.is_empty() {
                            chunks.push(UpdateFileChunk::default());
                        }
                        if let Some(chunk) = chunks.last_mut() {
                            chunk.old_lines.push(line_to_remove.to_string());
                        }
                        self.state.mode = StreamingParserMode::UpdateFile { hunk_line_number };
                        return Ok(());
                    }

                    if chunks.last().is_some_and(|chunk| {
                        !chunk.old_lines.is_empty() || !chunk.new_lines.is_empty()
                    }) {
                        return Err(InvalidHunkError {
                            message: format!(
                                "Expected update hunk to start with a @@ context marker, got: '{line}'"
                            ),
                            line_number: self.line_number,
                        });
                    }
                }
                Err(InvalidHunkError {
                    message: format!(
                        "Unexpected line found in update hunk: '{line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
                    ),
                    line_number: self.line_number,
                })
            }
            StreamingParserMode::EndedPatch => {
                if trimmed.is_empty() {
                    Ok(())
                } else {
                    Err(InvalidPatchError(
                        "The last line of the patch must be '*** End Patch'".to_string(),
                    ))
                }
            }
        }
    }
}
