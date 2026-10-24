use std::fmt;
use std::io;

use crate::{RootName, VirtualPath};

/// Why a path was refused. `Display` is the model-facing text, exactly as `sandbox.ts` words it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SandboxError {
    EmptySegment,
    Traversal,
    NullByte,
    ControlCharacter,
    /// `:` would open an alternate data stream or a drive-relative path (Windows).
    Colon,
    InvalidCharacter,
    TrailingDotOrSpace,
    ReservedName(String),
    SegmentTooLong,
    PathTooLong,
    Empty,
    /// A link exists at the path but cannot be canonicalized.
    UnresolvableLink,
    UnsafeResolution,
    NoExistingParent,
    RootUnavailable(RootName),
    NativeOutside {
        path: String,
        approved: Approved,
        suggestion: Option<String>,
    },
    EscapesViaLink,
    Escapes,
    Relative {
        path: String,
        approved: Approved,
    },
    UnknownRoot {
        name: String,
        approved: Approved,
        suggestion: Option<String>,
    },
    NotFound(VirtualPath),
    /// `Access::WorkingFolder` resolved to something that is not a folder.
    NotAFolder,
    NotAbsolute,
    NetworkPath,
    NotADirectory,
    EntireDrive,
    EntireFilesystem,
    Overlaps(RootName),
    NoFreeRootName,
    /// The operating system failed a lookup for a reason other than a missing path.
    Os(OsError),
}

impl fmt::Display for SandboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptySegment => f.write_str("Path contains an empty segment"),
            Self::Traversal => f.write_str("Path traversal (\"..\") is not allowed"),
            Self::NullByte => f.write_str("Path contains a null byte"),
            Self::ControlCharacter => f.write_str("Path contains a control character"),
            Self::Colon => f.write_str("Path contains \":\", which is not allowed"),
            Self::InvalidCharacter => {
                f.write_str("Path contains a character Windows does not allow")
            }
            Self::TrailingDotOrSpace => f.write_str("Path segment ends with a dot or space"),
            Self::ReservedName(segment) => {
                write!(f, "\"{segment}\" is a reserved Windows device name")
            }
            Self::SegmentTooLong => f.write_str("Path segment is too long"),
            Self::PathTooLong => f.write_str("Path is too long"),
            Self::Empty => {
                f.write_str("Path is empty. Use an approved virtual root such as /<root>/file.txt.")
            }
            Self::UnresolvableLink => {
                f.write_str("Path contains a link that could not be resolved")
            }
            Self::UnsafeResolution => f.write_str("Path could not be resolved safely"),
            Self::NoExistingParent => f.write_str("Path has no existing parent directory"),
            Self::RootUnavailable(name) => write!(
                f,
                "Root \"{name}\" is not available or changed on disk. Remove it and approve the folder again."
            ),
            Self::NativeOutside {
                path,
                approved,
                suggestion,
            } => {
                write!(
                    f,
                    "Native path \"{path}\" is not inside an approved folder. Approved roots: {approved}"
                )?;
                write_suggestion(f, suggestion.as_deref())
            }
            Self::EscapesViaLink => f.write_str("Path escapes its approved folder via a link"),
            Self::Escapes => f.write_str("Path escapes its approved folder"),
            Self::Relative { path, approved } => write!(
                f,
                "\"{path}\" is relative and this chat has no active folder yet. Use a full path: {approved}"
            ),
            Self::UnknownRoot {
                name,
                approved,
                suggestion,
            } => {
                write!(f, "Unknown root \"/{name}\". Approved roots: {approved}")?;
                write_suggestion(f, suggestion.as_deref())
            }
            Self::NotFound(path) => write!(f, "Not found: {path}"),
            Self::NotAFolder => f.write_str("workdir must be a folder"),
            Self::NotAbsolute => f.write_str("Folder path must be absolute"),
            Self::NetworkPath => f.write_str(
                "Network (UNC) paths are not supported. Map it to a drive letter first.",
            ),
            Self::NotADirectory => f.write_str("That is not a folder"),
            Self::EntireDrive => {
                f.write_str("Approving an entire drive is not allowed. Pick a folder inside it.")
            }
            Self::EntireFilesystem => f.write_str(
                "Approving the entire filesystem root is not allowed. Pick a folder inside it.",
            ),
            Self::Overlaps(name) => write!(f, "That folder overlaps the existing root \"{name}\""),
            Self::NoFreeRootName => f.write_str("Could not find a free root name"),
            Self::Os(error) => fmt::Display::fmt(&error.to_io_error(), f),
        }
    }
}

fn write_suggestion(f: &mut fmt::Formatter<'_>, suggestion: Option<&str>) -> fmt::Result {
    match suggestion {
        Some(path) => write!(f, " If you meant the approved folder, its path is {path}."),
        None => Ok(()),
    }
}

impl std::error::Error for SandboxError {}

/// The approved root names a refusal lists: `/project, /skills`, or `(none approved)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Approved(pub Vec<RootName>);

impl fmt::Display for Approved {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_empty() {
            return f.write_str("(none approved)");
        }
        for (index, name) in self.0.iter().enumerate() {
            if index > 0 {
                f.write_str(", ")?;
            }
            write!(f, "{name}")?;
        }
        Ok(())
    }
}

/// An OS error, kept comparable so `SandboxError` stays `Clone + Eq`. Map it to model text with
/// `ToolError::from_io(&error.to_io_error())`; the OS message never names the host path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OsError {
    kind: io::ErrorKind,
    raw: Option<i32>,
}

impl OsError {
    pub fn to_io_error(&self) -> io::Error {
        match self.raw {
            Some(code) => io::Error::from_raw_os_error(code),
            None => io::Error::from(self.kind),
        }
    }
}

impl From<&io::Error> for OsError {
    fn from(error: &io::Error) -> Self {
        Self {
            kind: error.kind(),
            raw: error.raw_os_error(),
        }
    }
}

impl From<io::Error> for SandboxError {
    fn from(error: io::Error) -> Self {
        Self::Os(OsError::from(&error))
    }
}
