use std::io;

use cos_fs::{FsOpError, SandboxError};
use cos_tools::ToolError;

/// Why one file operation failed, kept typed until it becomes model text. `read` turns a failure
/// into one section of its answer; the other tools return it as the call's error.
#[derive(Debug)]
pub(crate) enum Failure {
    Sandbox(SandboxError),
    Os(io::Error),
    /// A refusal worded by the tool (`FsOpError`, a `SandboxError` built from text).
    Refused(String),
    /// A plain `Error` in TypeScript: the text reaches the model, the call is an internal error.
    Internal(String),
}

impl Failure {
    /// `friendlyError`: the text the model reads. Never a host path.
    pub(crate) fn text(&self) -> String {
        match self {
            Self::Sandbox(error) => ToolError::from(error.clone()).to_string(),
            Self::Os(error) => ToolError::from_io(error).to_string(),
            Self::Refused(text) | Self::Internal(text) => text.clone(),
        }
    }

    pub(crate) fn is_not_found(&self) -> bool {
        matches!(self, Self::Sandbox(SandboxError::NotFound(_)))
    }
}

impl From<Failure> for ToolError {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::Sandbox(error) => error.into(),
            Failure::Os(error) => Self::from_io(&error),
            Failure::Refused(text) => Self::Refused(text),
            Failure::Internal(text) => Self::Internal(text),
        }
    }
}

impl From<SandboxError> for Failure {
    fn from(error: SandboxError) -> Self {
        Self::Sandbox(error)
    }
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self::Os(error)
    }
}

impl From<FsOpError> for Failure {
    fn from(error: FsOpError) -> Self {
        Self::Refused(error.0)
    }
}
