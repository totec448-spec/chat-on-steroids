//! The filesystem primitives the patch runtime uses (`src/main/codex/filesystem.ts`), with the
//! error texts the TypeScript app produced.
//!
//! The model reads some of these texts. The applier prints an error's message, which for an OS
//! error is Node's `CODE: description, syscall 'path'`, and the tool maps the same error to
//! `friendlyError` text when it refuses before writing. Every path here is already a sandbox
//! decision of `cos-fs`; the tool rewrites host paths to virtual ones before anything is shown.

use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

use cos_tools::ToolError;

/// Codex's `MAX_READ_FILE_BYTES`: the ceiling of a whole-file read.
const MAX_READ_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// A failed filesystem step, as `NodeJS.ErrnoException` carried it.
#[derive(Debug)]
pub(crate) struct FsError {
    /// Node's `err.code`.
    code: &'static str,
    /// Node's `err.message`.
    message: String,
    /// The OS error, when there was one.
    os: Option<io::Error>,
}

impl FsError {
    fn os(error: io::Error, syscall: &str, path: &Path) -> Self {
        let (code, description) = node_code(&error);
        Self {
            code,
            message: format!("{code}: {description}, {syscall} '{}'", path.display()),
            os: Some(error),
        }
    }

    /// `invalidInput(message)`: an `EINVAL` error with a message of our own.
    pub(crate) fn invalid_input(message: impl Into<String>) -> Self {
        Self {
            code: "EINVAL",
            message: message.into(),
            os: None,
        }
    }

    pub(crate) fn is_not_found(&self) -> bool {
        self.code == "ENOENT"
    }

    /// `friendlyError`: the refusal text, without the host path an OS message names.
    pub(crate) fn friendly(&self) -> String {
        match &self.os {
            Some(error) => ToolError::from_io(error).to_string(),
            None => format!("Filesystem error ({})", self.code),
        }
    }
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// libuv's code and description for an OS error, as Node prints them.
fn node_code(error: &io::Error) -> (&'static str, &'static str) {
    #[cfg(windows)]
    if let Some(code) = error.raw_os_error() {
        // `uv_translate_sys_error` for the codes a file operation produces.
        match code {
            2 | 3 | 15 | 123 | 161 => return ("ENOENT", "no such file or directory"),
            5 | 19 => return ("EPERM", "operation not permitted"),
            32 | 33 => return ("EBUSY", "resource busy or locked"),
            80 | 183 => return ("EEXIST", "file already exists"),
            112 => return ("ENOSPC", "no space left on device"),
            145 => return ("ENOTEMPTY", "directory not empty"),
            206 => return ("ENAMETOOLONG", "name too long"),
            267 => return ("ENOTDIR", "not a directory"),
            1921 => return ("ELOOP", "too many symbolic links encountered"),
            _ => {}
        }
    }
    use io::ErrorKind as Kind;
    match error.kind() {
        Kind::NotFound => ("ENOENT", "no such file or directory"),
        Kind::PermissionDenied => ("EACCES", "permission denied"),
        Kind::ResourceBusy => ("EBUSY", "resource busy or locked"),
        Kind::AlreadyExists => ("EEXIST", "file already exists"),
        Kind::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        Kind::NotADirectory => ("ENOTDIR", "not a directory"),
        Kind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        Kind::StorageFull => ("ENOSPC", "no space left on device"),
        Kind::InvalidFilename => ("ENAMETOOLONG", "name too long"),
        Kind::ReadOnlyFilesystem => ("EROFS", "read-only file system"),
        Kind::InvalidInput => ("EINVAL", "invalid argument"),
        _ => ("EIO", "i/o error"),
    }
}

/// `getMetadata`: stats the link itself, then follows it when it is one.
pub(crate) struct Metadata {
    pub(crate) is_file: bool,
    pub(crate) is_directory: bool,
    pub(crate) is_symlink: bool,
    pub(crate) size: u64,
}

pub(crate) fn metadata(path: &Path) -> Result<Metadata, FsError> {
    let link = fs::symlink_metadata(path).map_err(|error| FsError::os(error, "lstat", path))?;
    let is_symlink = link.file_type().is_symlink();
    let target = if is_symlink {
        fs::metadata(path).map_err(|error| FsError::os(error, "stat", path))?
    } else {
        link
    };
    Ok(Metadata {
        is_file: target.is_file(),
        is_directory: target.is_dir(),
        is_symlink,
        size: target.len(),
    })
}

/// `readFile`: a regular file, read whole, bounded by `MAX_READ_FILE_BYTES`.
pub(crate) fn read_bytes(path: &Path) -> Result<Vec<u8>, FsError> {
    let not_a_file = || FsError::invalid_input(format!("path `{}` is not a file", path.display()));
    let file = match fs::File::open(path) {
        Ok(file) => file,
        // Node opens a folder and refuses it after `fstat`; Windows refuses the open itself.
        Err(_) if fs::metadata(path).is_ok_and(|meta| meta.is_dir()) => return Err(not_a_file()),
        Err(error) => return Err(FsError::os(error, "open", path)),
    };
    let stat = file
        .metadata()
        .map_err(|error| FsError::os(error, "fstat", path))?;
    if !stat.is_file() {
        return Err(not_a_file());
    }
    let too_large = || {
        FsError::invalid_input(format!(
            "file is too large to read: limit is {MAX_READ_FILE_BYTES} bytes"
        ))
    };
    if stat.len() > MAX_READ_FILE_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(stat.len()).unwrap_or(0));
    file.take(MAX_READ_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| FsError::os(error, "read", path))?;
    if bytes.len() as u64 > MAX_READ_FILE_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

/// `readFileText`: `readFile` plus a strict UTF-8 decode that keeps a byte-order mark.
pub(crate) fn read_text(path: &Path) -> Result<String, FsError> {
    String::from_utf8(read_bytes(path)?).map_err(|_| FsError {
        code: "EILSEQ",
        message: "stream did not contain valid UTF-8".to_owned(),
        os: None,
    })
}

/// `writeFile`: create or truncate, then write.
pub(crate) fn write(path: &Path, contents: &[u8]) -> Result<(), FsError> {
    fs::write(path, contents).map_err(|error| FsError::os(error, "open", path))
}

/// `createDirectory(path, { recursive: true })`.
pub(crate) fn create_dir_all(path: &Path) -> Result<(), FsError> {
    fs::create_dir_all(path).map_err(|error| FsError::os(error, "mkdir", path))
}

/// `remove(path, { recursive: false, force })`: an empty folder or a file, never a tree.
pub(crate) fn remove(path: &Path, force: bool) -> Result<(), FsError> {
    let link = match fs::symlink_metadata(path) {
        Ok(link) => link,
        Err(error) if force && error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(FsError::os(error, "lstat", path)),
    };
    if link.is_dir() {
        fs::remove_dir(path).map_err(|error| FsError::os(error, "rmdir", path))
    } else {
        fs::remove_file(path).map_err(|error| FsError::os(error, "unlink", path))
    }
}
