//! The patch grammar and runtime, vendored from OpenAI Codex `codex-rs/apply-patch` at commit
//! 1a4096e273e80da30947e57fdfa45be92858ca91 and adapted the way the TypeScript port
//! (`src/main/codex/apply-patch/*`) adapted it. Each file names its upstream source and its
//! changes. The Codex license and notice are in `codex/` at the crate root.
//!
//! Not vendored: `invocation.rs` (shell interception with tree-sitter-bash, which belongs to
//! `exec_command`), `standalone_executable.rs`, and the `ExecutorFileSystem` plumbing. The
//! `apply_patch` tool takes the patch text itself, so a heredoc around it is refused by the
//! grammar (`invalid patch: The first line of the patch must be '*** Begin Patch'`).

mod apply;
mod file_update;
mod parser;
mod seek_sequence;
mod streaming_parser;
mod text_file;
mod verify;

use std::fmt;

use crate::fs::FsError;

pub(crate) use apply::{AppliedChange, AppliedPatchDelta, execute};
pub(crate) use parser::{Hunk, UpdateFileChunk, parse_patch};
pub(crate) use verify::{VerifyError, verify};

/// Controls how updates reconstruct the target file after matching a patch.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum ApplyPatchFileUpdateMode {
    /// Preserve the historical behavior of normalizing updated files to LF.
    #[default]
    NormalizeToLf,
    /// Preserve existing line endings and use the file's preferred ending for new lines.
    PreserveLineEndings,
}

/// Codex's `ApplyPatchError`, less the variants only shell interception produces.
#[derive(Debug)]
pub(crate) enum ApplyPatchError {
    /// `IoError { context, source }`, shown as `{context}: {source}`.
    Io { context: String, source: String },
    /// A chunk could not be located. `source_context` is a bounded excerpt of the file, shown
    /// only to a caller that may read it.
    ComputeReplacements {
        message: String,
        source_context: Option<String>,
    },
}

impl ApplyPatchError {
    fn io(context: String, source: &FsError) -> Self {
        Self::Io {
            context,
            source: source.to_string(),
        }
    }
}

impl fmt::Display for ApplyPatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { context, source } => write!(f, "{context}: {source}"),
            Self::ComputeReplacements { message, .. } => f.write_str(message),
        }
    }
}

/// A patch may hold a file only this large: matching keeps the old and the new text at once.
pub(crate) const MAX_PATCH_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
