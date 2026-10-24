//! `resolvePath` and everything it decides (`sandbox.ts`).

use std::borrow::Cow;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::{Approved, SandboxError};
use crate::lexical::{NativePath, WINDOWS, js_trim, matches_wsl, utf16_len, utf16_prefix};
use crate::rawfs::{canonical, is_missing};
use crate::roots::suggest_approved_spelling;
use crate::{Access, ApprovedRoot, Resolved, Roots, VirtualPath};

/// Windows treats these as devices no matter which directory they appear in.
const RESERVED_NAMES: [&str; 26] = [
    "con", "prn", "aux", "nul", "conin$", "conout$", "com0", "com1", "com2", "com3", "com4",
    "com5", "com6", "com7", "com8", "com9", "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6",
    "lpt7", "lpt8", "lpt9",
];

/// Validates one path segment. Traversal and control rules apply everywhere; Windows also
/// refuses drive and stream syntax, reserved device names and names Win32 silently aliases.
pub(crate) fn check_segment(segment: &str) -> Result<(), SandboxError> {
    if segment.is_empty() || segment == "." {
        return Err(SandboxError::EmptySegment);
    }
    if segment == ".." {
        return Err(SandboxError::Traversal);
    }
    if segment.contains('\0') {
        return Err(SandboxError::NullByte);
    }
    if segment.chars().any(|c| c < '\u{20}') {
        return Err(SandboxError::ControlCharacter);
    }
    if WINDOWS {
        if segment.contains(':') {
            return Err(SandboxError::Colon);
        }
        if segment.contains(['<', '>', '"', '|', '?', '*']) {
            return Err(SandboxError::InvalidCharacter);
        }
        if segment.ends_with(['.', ' ']) {
            return Err(SandboxError::TrailingDotOrSpace);
        }
        let stem = segment.split('.').next().unwrap_or(segment).to_lowercase();
        if RESERVED_NAMES.contains(&stem.as_str()) {
            return Err(SandboxError::ReservedName(segment.to_owned()));
        }
    }
    if utf16_len(segment) > 255 {
        return Err(SandboxError::SegmentTooLong);
    }
    Ok(())
}

fn is_separator(c: char) -> bool {
    c == '/' || (WINDOWS && c == '\\')
}

fn split_parts(text: &str) -> impl Iterator<Item = &str> {
    text.split(is_separator).filter(|part| !part.is_empty())
}

/// Splits a virtual path into validated segments. Windows accepts both separators.
pub(crate) fn split_virtual_path(input: &str) -> Result<Vec<&str>, SandboxError> {
    if input.contains('\0') {
        return Err(SandboxError::NullByte);
    }
    if utf16_len(input) > 4096 {
        return Err(SandboxError::PathTooLong);
    }
    let segments: Vec<&str> = split_parts(input).collect();
    if segments.is_empty() {
        return Err(SandboxError::Empty);
    }
    for segment in &segments {
        check_segment(segment)?;
    }
    Ok(segments)
}

/// True for a path that names its root rather than starting from somewhere already known.
pub fn is_absolute_virtual_path(input: &str) -> bool {
    js_trim(input).starts_with(is_separator)
}

/// True when a model-supplied path is an absolute native Windows path: a drive path or UNC.
pub fn is_native_windows_path(input: &str) -> bool {
    WINDOWS && {
        let trimmed = js_trim(input);
        let bytes = trimmed.as_bytes();
        trimmed.starts_with("\\\\")
            || (bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/'))
    }
}

/// POSIX absolute paths and virtual paths both begin with `/`. The virtual namespace wins when
/// the first segment names an approved root.
fn is_native_posix_path(roots: &Roots, input: &str) -> bool {
    if WINDOWS {
        return false;
    }
    let trimmed = js_trim(input);
    if !trimmed.starts_with('/') {
        return false;
    }
    match trimmed.split('/').find(|part| !part.is_empty()) {
        Some(first) => {
            let first = first.to_lowercase();
            !roots
                .iter()
                .any(|root| root.name.as_str().to_lowercase() == first)
        }
        None => false,
    }
}

fn approved(roots: &Roots) -> Approved {
    Approved(roots.iter().map(|root| root.name.clone()).collect())
}

/// What `realpathDeepest` found: the canonical deepest existing ancestor and the parts below it
/// that do not exist yet.
struct Deepest {
    real: PathBuf,
    missing: Vec<OsString>,
    /// A missing part is itself a link whose target is gone.
    dangling_link: bool,
}

impl Deepest {
    fn full(&self) -> PathBuf {
        let mut path = self.real.clone();
        path.extend(&self.missing);
        path
    }
}

fn realpath_deepest(path: &Path) -> Result<Deepest, SandboxError> {
    let mut current = path.to_path_buf();
    let mut missing = Vec::new();
    let mut dangling_link = false;
    loop {
        match canonical(&current) {
            Ok(real) => {
                missing.reverse();
                return Ok(Deepest {
                    real,
                    missing,
                    dangling_link,
                });
            }
            Err(error) if is_missing(&error) => {}
            Err(error) => return Err(error.into()),
        }
        // A link whose target is gone reads as missing. Under WSL, TypeScript refuses it at once.
        // Elsewhere it is only marked, so a read still says "Not found" and a create through it
        // is refused instead of writing wherever the link points.
        let wsl = WINDOWS && matches_wsl(&current.to_string_lossy());
        match std::fs::symlink_metadata(&current) {
            Ok(_) if wsl => return Err(SandboxError::UnresolvableLink),
            Ok(_) => dangling_link = true,
            Err(error) if is_missing(&error) => {}
            Err(_) if wsl => return Err(SandboxError::UnsafeResolution),
            Err(_) => {}
        }
        let (Some(parent), Some(name)) = (current.parent(), current.file_name()) else {
            return Err(SandboxError::NoExistingParent);
        };
        missing.push(name.to_os_string());
        current = parent.to_path_buf();
    }
}

/// The canonical folder of an approved root, refusing a root that is gone or was replaced by a
/// link. The configured path is a liveness check, never permission to follow a new target.
pub(crate) fn real_root(root: &ApprovedRoot) -> Result<PathBuf, SandboxError> {
    let unavailable = || SandboxError::RootUnavailable(root.name.clone());
    let current = canonical(&root.folder).map_err(|_| unavailable())?;
    let configured = NativePath::resolve(&root.folder.to_string_lossy());
    let resolved = NativePath::resolve(&current.to_string_lossy());
    if configured.contains(&resolved) && resolved.contains(&configured) {
        Ok(current)
    } else {
        Err(unavailable())
    }
}

/// The virtual spelling of `real`, which must already be proven inside `root_real`.
fn virtual_of(root: &ApprovedRoot, root_real: &Path, real: &Path) -> VirtualPath {
    let mut text = format!("/{}", root.name.as_str());
    if let Ok(rest) = real.strip_prefix(root_real) {
        for part in rest.iter() {
            text.push('/');
            text.push_str(&part.to_string_lossy());
        }
    }
    VirtualPath(text)
}

/// Converts a native absolute path inside an approved root to its virtual spelling. It only
/// chooses the root; the caller runs the result through every check a virtual path gets.
fn native_to_virtual(roots: &Roots, input: &str) -> Result<Option<String>, SandboxError> {
    let native_windows = is_native_windows_path(input);
    if !native_windows && !is_native_posix_path(roots, input) {
        return Ok(None);
    }
    let trimmed = js_trim(input);
    // Validate the caller's own segments before any normalization can erase a `..`.
    let below_root = if native_windows {
        strip_unc_root(strip_drive_root(trimmed))
    } else {
        trimmed.trim_start_matches('/')
    };
    let segments: Vec<&str> = split_parts(below_root).collect();
    for segment in &segments {
        check_segment(segment)?;
    }
    let native = NativePath::resolve(trimmed);
    // Refuse any other UNC spelling lexically, before a remote host can trigger DNS, SMB or
    // credentials. An approved WSL folder or a mapped drive's canonical UNC root still passes.
    if native_windows
        && native.is_unc()
        && !roots
            .iter()
            .any(|root| NativePath::resolve(&root.folder.to_string_lossy()).contains(&native))
    {
        return Err(SandboxError::NativeOutside {
            path: trimmed.to_owned(),
            approved: approved(roots),
            suggestion: None,
        });
    }
    let native_text = native.to_string();
    let canonical_native = match realpath_deepest(Path::new(&native_text)) {
        Ok(deepest) => NativePath::resolve(&deepest.full().to_string_lossy()),
        Err(_) => native.clone(),
    };
    for root in roots.iter() {
        let Ok(root_real) = real_root(root) else {
            continue;
        };
        let root_real = NativePath::resolve(&root_real.to_string_lossy());
        if let Some(rest) = root_real.relative(&canonical_native) {
            let mut text = format!("/{}", root.name.as_str());
            for part in rest {
                text.push('/');
                text.push_str(part);
            }
            return Ok(Some(text));
        }
        // A spelling that started under the root but was redirected out by a link.
        if root_real.contains(&native) {
            return Err(SandboxError::EscapesViaLink);
        }
    }
    Err(SandboxError::NativeOutside {
        path: trimmed.to_owned(),
        approved: approved(roots),
        suggestion: suggest_approved_spelling(roots, &segments),
    })
}

/// `^[A-Za-z]:[\\/]+`
fn strip_drive_root(text: &str) -> &str {
    let bytes = text.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
    {
        text[2..].trim_start_matches(['\\', '/'])
    } else {
        text
    }
}

/// `^\\\\[^\\/]+[\\/]+[^\\/]+[\\/]*`
fn strip_unc_root(text: &str) -> &str {
    let Some(after) = text.strip_prefix("\\\\") else {
        return text;
    };
    let server = after.find(['\\', '/']).unwrap_or(after.len());
    if server == 0 {
        return text;
    }
    let tail = after[server..].trim_start_matches(['\\', '/']);
    if tail.len() == after.len() - server {
        return text;
    }
    let share = tail.find(['\\', '/']).unwrap_or(tail.len());
    if share == 0 {
        return text;
    }
    tail[share..].trim_start_matches(['\\', '/'])
}

pub(crate) fn resolve_with(
    roots: &Roots,
    input: &str,
    base: Option<&VirtualPath>,
    access: Access,
) -> Result<Resolved, SandboxError> {
    let supplied: Cow<'_, str> = match native_to_virtual(roots, input)? {
        Some(path) => Cow::Owned(path),
        None => Cow::Borrowed(input),
    };
    // Relative shorthand becomes one absolute path before anything is validated, so a `..` in it
    // still meets `check_segment` and cannot climb out of the base.
    let requested: Cow<'_, str> = match base {
        Some(base) if !base.as_str().is_empty() && !is_absolute_virtual_path(&supplied) => {
            let base = base.as_str().trim_end_matches(is_separator);
            let rest = supplied.trim_start_matches(is_separator);
            Cow::Owned(format!("{base}/{rest}"))
        }
        _ => supplied,
    };
    if !js_trim(&requested).is_empty() && !is_absolute_virtual_path(&requested) {
        return Err(SandboxError::Relative {
            path: utf16_prefix(&requested, 120).to_owned(),
            approved: approved(roots),
        });
    }
    let segments = split_virtual_path(&requested)?;
    let wanted = segments[0].to_lowercase();
    let Some(root) = roots
        .iter()
        .find(|root| root.name.as_str().to_lowercase() == wanted)
    else {
        return Err(SandboxError::UnknownRoot {
            name: segments[0].to_owned(),
            approved: approved(roots),
            suggestion: suggest_approved_spelling(roots, &segments[1..]),
        });
    };

    let root_real = real_root(root)?;
    let mut candidate = root_real.clone();
    candidate.extend(&segments[1..]);
    let deepest = realpath_deepest(&candidate)?;
    // Canonical paths spell a folder exactly as it is stored, so containment of one canonical
    // path in another is an exact prefix. Case folding here would let a sibling whose name
    // differs only by a character NTFS keeps distinct (KELVIN SIGN versus `k`) pass as inside.
    if !deepest.real.starts_with(&root_real) {
        return Err(SandboxError::EscapesViaLink);
    }
    if !deepest.missing.is_empty() && !access.allows_missing() {
        return Err(SandboxError::NotFound(virtual_of(
            root, &root_real, &candidate,
        )));
    }
    if deepest.dangling_link {
        return Err(SandboxError::UnresolvableLink);
    }
    let real = deepest.full();
    if !real.starts_with(&root_real) {
        return Err(SandboxError::Escapes);
    }
    if access == Access::WorkingFolder && !std::fs::metadata(&real)?.is_dir() {
        return Err(SandboxError::NotAFolder);
    }
    Ok(Resolved {
        virtual_path: virtual_of(root, &root_real, &real),
        real,
        root: root.name.clone(),
    })
}

pub(crate) fn to_virtual(roots: &Roots, real: &Path) -> Option<VirtualPath> {
    roots.iter().find_map(|root| {
        let root_real = real_root(root).ok()?;
        real.starts_with(&root_real)
            .then(|| virtual_of(root, &root_real, real))
    })
}
