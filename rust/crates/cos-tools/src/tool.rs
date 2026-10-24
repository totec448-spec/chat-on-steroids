//! The contract between the kernel and every tool crate.

use std::fmt;
use std::future::Future;
use std::pin::Pin;

use cos_fs::SandboxError;
use cos_types::config::Capability;
use cos_types::session::{FileChange, ToolOutcome};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::call::CallContext;
use crate::grants::Feature;
use crate::validate::{ArgIssue, StringCheck};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One model-facing tool.
///
/// The kernel validates the JSON arguments against the tool's declared schema before
/// `call` runs, so `Args` deserializes from a value that already passed validation. A tool
/// returns `Err` for every refusal; it never builds an `isError` result by hand.
pub trait Tool: Send + Sync + 'static {
    type Args: DeserializeOwned + Send + 'static;

    const SPEC: &'static ToolSpec;

    /// What zod checked on string properties that the published schema lost: a pattern's
    /// flags and a custom format or pattern message. The kernel's schema walk applies them in
    /// the property's place, as zod does.
    const STRING_CHECKS: &'static [StringCheck] = &[];

    /// The checks the published schema cannot express (zod refinements such as "exactly one of
    /// cmd or cmds"). The kernel runs this after schema validation, before admission, and words
    /// each issue like a schema error: `Input validation error: ...`, no identity notice.
    fn refine(args: &Self::Args) -> Result<(), Vec<ArgIssue>> {
        let _ = args;
        Ok(())
    }

    fn call(
        &self,
        cx: &CallContext,
        args: Self::Args,
    ) -> impl Future<Output = Result<ToolOutput, ToolError>> + Send;
}

/// The object-safe form of [`Tool`] the kernel stores. Implemented for every `Tool`.
pub trait DynTool: Send + Sync + 'static {
    fn spec(&self) -> &'static ToolSpec;

    /// [`Tool::STRING_CHECKS`].
    fn string_checks(&self) -> &'static [StringCheck] {
        &[]
    }

    /// [`Tool::refine`] on arguments that passed schema validation.
    fn refine_json(&self, args: &Value) -> Result<(), Vec<ArgIssue>> {
        let _ = args;
        Ok(())
    }

    fn call_json<'a>(
        &'a self,
        cx: &'a CallContext,
        args: Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>>;
}

impl<T: Tool> DynTool for T {
    fn spec(&self) -> &'static ToolSpec {
        T::SPEC
    }

    fn string_checks(&self) -> &'static [StringCheck] {
        T::STRING_CHECKS
    }

    fn refine_json(&self, args: &Value) -> Result<(), Vec<ArgIssue>> {
        // Arguments that do not parse are reported by `call_json` as an internal error.
        match T::Args::deserialize(args) {
            Ok(args) => T::refine(&args),
            Err(_) => Ok(()),
        }
    }

    fn call_json<'a>(
        &'a self,
        cx: &'a CallContext,
        args: Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let args = serde_json::from_value(args).map_err(|error| {
                ToolError::Internal(format!(
                    "{} arguments passed schema validation but did not parse: {error}",
                    T::SPEC.name
                ))
            })?;
            self.call(cx, args).await
        })
    }
}

/// Static facts about a tool. Its schema and description are not here: the kernel serves them
/// from the declaration templates recorded from the TypeScript app, keyed by `name`.
#[derive(Debug)]
pub struct ToolSpec {
    pub name: &'static str,
    /// When the tool appears in `tools/list`, judged against the surface's [`crate::Exposed`].
    pub listing: Listing,
    /// What must be live for a call to run, checked by the kernel before `call`.
    pub requires: Requirement,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Listing {
    Capability(Capability),
    AnyCapability(&'static [Capability]),
    Feature(Feature),
    /// `find`: listed when search was granted and command execution was not, at the first look.
    FindInsteadOfCommand,
    /// Code mode `exec`: listed when the surface lists at least one other tool.
    WithOtherTools,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Requirement {
    /// The tool checks finer permissions itself (for example per path or per patch operation).
    None,
    Capability(Capability),
    Feature(Feature),
}

/// An MCP `CallToolResult`. Field order is the wire order: `content`, `structuredContent`,
/// `isError`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub content: Vec<Content>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
}

impl ToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![Content::Text { text: text.into() }],
            structured_content: None,
            is_error: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Content {
    Text {
        text: String,
    },
    Image {
        /// Base64.
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

/// A tool's successful answer plus what it observed for the recorder.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutput {
    pub result: ToolResult,
    pub notes: CallNotes,
}

impl From<ToolResult> for ToolOutput {
    fn from(result: ToolResult) -> Self {
        Self {
            result,
            notes: CallNotes::default(),
        }
    }
}

/// Evidence a tool reports about its own call (`noteChanges`, `noteCount`, `noteDetail`,
/// `noteProcess`, `noteExec`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CallNotes {
    /// Overrides `ok` for a call that ran but whose program failed (`process_exit_nonzero`).
    pub outcome: Option<ToolOutcome>,
    pub changes: Vec<FileChange>,
    /// How many results a search or listing found.
    pub count: Option<u64>,
    /// A qualifier for the summary, such as `lines 200–420`.
    pub detail: Option<String>,
    /// What a process tool (`exec_command`, `write_stdin`) saw of its child.
    pub process: Option<ProcessNotes>,
}

/// One child process as a process tool saw it when its call answered.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcessNotes {
    /// `None` while the child runs or when it ended without a code.
    pub exit_code: Option<i64>,
    /// `None` when the tool did not say; the recorder then infers it from the other facts.
    pub running: Option<bool>,
    pub timed_out: bool,
    /// The tool proved a non-zero exit is a reported result, not a failure.
    pub benign_exit: bool,
    /// The child's lifetime as the tool measured it.
    pub duration_ms: Option<u64>,
    /// The managed-process id, when the child outlives this call.
    pub session_id: Option<String>,
}

/// Why a call produced no ordinary result. The kernel turns each into an `isError` result
/// whose text is the `Display` of this value, logs it and records its outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolError {
    /// An intentional refusal: validation, permission, sandbox, lifecycle (`tool_rejected`).
    Refused(String),
    /// A refusal because the caller's chat identity is missing. Arms the identity-recovered
    /// notice for a later call from the same chat.
    Identity(String),
    /// A refusal that also tells the model what went wrong as data: the result carries `detail`
    /// as `structuredContent.error` beside the text (`tool_rejected`).
    RefusedWithDetail { text: String, detail: Value },
    /// The tool failed its own contract (`tool_internal_error`). Logged as a warning.
    Internal(String),
}

impl ToolError {
    pub fn outcome(&self) -> ToolOutcome {
        match self {
            Self::Refused(_) | Self::Identity(_) | Self::RefusedWithDetail { .. } => {
                ToolOutcome::ToolRejected
            }
            Self::Internal(_) => ToolOutcome::ToolInternalError,
        }
    }

    /// Model-facing text for an OS error, without the host path the OS put in its message
    /// (`friendlyError`).
    pub fn from_io(error: &std::io::Error) -> Self {
        use std::io::ErrorKind as Kind;
        // libuv reports ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION as EBUSY.
        if cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)) {
            return Self::Refused("The file is in use by another program".to_owned());
        }
        let text = match error.kind() {
            Kind::NotFound => "Not found",
            Kind::PermissionDenied => "Access denied by the operating system",
            Kind::ResourceBusy => "The file is in use by another program",
            Kind::DirectoryNotEmpty => "Directory is not empty",
            Kind::AlreadyExists => "Already exists",
            // libuv: ERROR_CANT_RESOLVE_FILENAME is ELOOP.
            _ if cfg!(windows) && error.raw_os_error() == Some(1921) => {
                return Self::Refused("Filesystem error (ELOOP)".to_owned());
            }
            kind => return Self::Refused(format!("Filesystem error ({})", errno_name(kind))),
        };
        Self::Refused(text.to_owned())
    }
}

/// The libuv code Node puts in `err.code` for an error of this kind, so the text matches
/// `friendlyError`'s `Filesystem error (<code>)`. Never the OS message, which names host paths.
fn errno_name(kind: std::io::ErrorKind) -> &'static str {
    use std::io::ErrorKind as Kind;
    match kind {
        Kind::InvalidFilename => "ENAMETOOLONG",
        Kind::InvalidInput => "EINVAL",
        Kind::StorageFull => "ENOSPC",
        Kind::NotADirectory => "ENOTDIR",
        Kind::IsADirectory => "EISDIR",
        Kind::ReadOnlyFilesystem => "EROFS",
        Kind::CrossesDevices => "EXDEV",
        Kind::TimedOut => "ETIMEDOUT",
        Kind::Interrupted => "EINTR",
        Kind::BrokenPipe => "EPIPE",
        Kind::FileTooLarge => "EFBIG",
        Kind::TooManyLinks => "EMLINK",
        Kind::Unsupported => "ENOTSUP",
        Kind::OutOfMemory => "ENOMEM",
        _ => "UNKNOWN",
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(text)
            | Self::Identity(text)
            | Self::Internal(text)
            | Self::RefusedWithDetail { text, .. } => f.write_str(text),
        }
    }
}

impl std::error::Error for ToolError {}

impl From<SandboxError> for ToolError {
    /// The sandbox's own refusals keep their text. An OS failure during resolution gets
    /// `friendlyError`'s words, because the OS message is not what the TypeScript app showed.
    fn from(error: SandboxError) -> Self {
        match error {
            SandboxError::Os(os) => Self::from_io(&os.to_io_error()),
            other => Self::Refused(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use cos_fs::{OsError, SandboxError};

    use super::ToolError;

    fn sandbox_os(error: io::Error) -> SandboxError {
        SandboxError::Os(OsError::from(&error))
    }

    #[test]
    fn an_os_error_during_resolution_reaches_the_model_as_friendly_text() {
        let denied = ToolError::from(sandbox_os(io::Error::from(io::ErrorKind::PermissionDenied)));
        assert_eq!(
            denied,
            ToolError::Refused("Access denied by the operating system".to_owned())
        );
        let missing = ToolError::from(sandbox_os(io::Error::from(io::ErrorKind::NotFound)));
        assert_eq!(missing.to_string(), "Not found");
        let other = ToolError::from(sandbox_os(io::Error::from(io::ErrorKind::InvalidInput)));
        assert_eq!(other.to_string(), "Filesystem error (EINVAL)");
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_access_denied_code_never_shows_the_os_message() {
        // ERROR_ACCESS_DENIED: the OS text ("Access is denied. (os error 5)") is not the model text.
        let error = ToolError::from(sandbox_os(io::Error::from_raw_os_error(5)));
        assert_eq!(error.to_string(), "Access denied by the operating system");
        // ERROR_SHARING_VIOLATION is libuv's EBUSY.
        let busy = ToolError::from(sandbox_os(io::Error::from_raw_os_error(32)));
        assert_eq!(busy.to_string(), "The file is in use by another program");
    }

    #[test]
    fn sandbox_refusals_keep_their_own_text() {
        assert_eq!(
            ToolError::from(SandboxError::Traversal),
            ToolError::Refused("Path traversal (\"..\") is not allowed".to_owned())
        );
    }
}
