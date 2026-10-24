//! Raw filesystem primitives the sandbox builds on (`rawfs.ts`).

use std::io;
use std::path::{Path, PathBuf};

/// The final path of `path`, with every link, junction and 8.3 alias resolved
/// (`fs.realpath.native`). On Windows the `\\?\` prefix the OS returns is removed and
/// `\\?\UNC\server\share` becomes `\\server\share`, as libuv does.
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    std::fs::canonicalize(path).map(strip_verbatim)
}

#[cfg(windows)]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    let unc: Vec<u16> = "\\\\?\\UNC\\".encode_utf16().collect();
    let verbatim: Vec<u16> = "\\\\?\\".encode_utf16().collect();
    if wide.starts_with(&unc) {
        let mut out: Vec<u16> = "\\\\".encode_utf16().collect();
        out.extend_from_slice(&wide[unc.len()..]);
        return PathBuf::from(OsString::from_wide(&out));
    }
    if wide.starts_with(&verbatim) {
        return PathBuf::from(OsString::from_wide(&wide[verbatim.len()..]));
    }
    path
}

#[cfg(not(windows))]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

/// The errors `realpath` reports as `ENOENT` or `ENOTDIR`: nothing exists at the path.
pub(crate) fn is_missing(error: &io::Error) -> bool {
    if cfg!(windows) {
        // libuv's `ENOENT` set: FILE_NOT_FOUND, PATH_NOT_FOUND, INVALID_DRIVE, INVALID_NAME,
        // MOD_NOT_FOUND, BAD_PATHNAME, ENVVAR_NOT_FOUND, DIRECTORY, INVALID_REPARSE_DATA,
        // WSAHOST_NOT_FOUND, WSANO_DATA.
        return matches!(
            error.raw_os_error(),
            Some(2 | 3 | 15 | 123 | 126 | 161 | 203 | 267 | 4392 | 11001 | 11004)
        );
    }
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}
