//! Root names and the approval of a new root (`sandbox.ts`).

use std::path::{Path, PathBuf};

use crate::error::SandboxError;
use crate::lexical::{NativePath, WINDOWS, matches_wsl};
use crate::rawfs::canonical;
use crate::sandbox::check_segment;
use crate::{RootName, Roots};

/// Root names this app keeps for itself. `/skills` is the managed skills library.
pub const RESERVED_ROOT_NAMES: [&str; 1] = [RootName::SKILLS];

/// Normalizes a user-supplied root name into the slug used in virtual paths.
pub fn normalise_root_name(input: &str) -> String {
    let mut slug = String::new();
    let mut in_run = false;
    for c in input.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            slug.push(c);
            in_run = false;
        } else if !in_run {
            slug.push('-');
            in_run = true;
        }
    }
    let trimmed = slug.trim_matches(['-', '.']);
    let cut: String = trimmed.chars().take(32).collect();
    if cut.is_empty() {
        "folder".to_owned()
    } else {
        cut
    }
}

/// A root name for `folder` that collides with neither `existing` nor a reserved name.
pub fn unique_root_name(folder: &Path, existing: &Roots) -> Result<String, SandboxError> {
    let base_name = folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "folder".to_owned());
    let base = normalise_root_name(&base_name);
    let taken = |name: &str| {
        RESERVED_ROOT_NAMES.contains(&name)
            || existing.iter().any(|root| root.name.as_str() == name)
    };
    if !taken(&base) {
        return Ok(base);
    }
    (2..1000)
        .map(|index| format!("{base}-{index}"))
        .find(|candidate| !taken(candidate))
        .ok_or(SandboxError::NoFreeRootName)
}

/// The approved spelling a refused path most likely meant: the first segment that names a root
/// by its folder name, with the rest carried over. A hint in the error text, never a resolution.
pub(crate) fn suggest_approved_spelling(roots: &Roots, segments: &[&str]) -> Option<String> {
    segments.iter().enumerate().find_map(|(index, segment)| {
        let slug = normalise_root_name(segment);
        let root = roots.iter().find(|root| root.name.as_str() == slug)?;
        let mut text = format!("/{}", root.name.as_str());
        for part in &segments[index + 1..] {
            text.push('/');
            text.push_str(part);
        }
        Some(text)
    })
}

/// `path.isAbsolute` for the host platform. On Windows a rooted `\folder` counts.
fn is_absolute(text: &str) -> bool {
    if !WINDOWS {
        return text.starts_with('/');
    }
    let bytes = text.as_bytes();
    matches!(bytes.first(), Some(b'\\' | b'/'))
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'))
}

/// Validates a folder the user picked before it becomes a root, returning its canonical path.
/// Local WSL folders are allowed; other network paths, whole drives and overlaps are refused.
pub fn validate_new_root(folder: &Path, existing: &Roots) -> Result<PathBuf, SandboxError> {
    let text = folder.to_string_lossy();
    if !is_absolute(&text) {
        return Err(SandboxError::NotAbsolute);
    }
    if WINDOWS {
        let windows_path = text.replace('/', "\\");
        let wsl = matches_wsl(&windows_path);
        if windows_path.starts_with("\\\\") && !wsl {
            return Err(SandboxError::NetworkPath);
        }
        if wsl {
            for segment in windows_path.split('\\').skip(1).filter(|s| !s.is_empty()) {
                check_segment(segment)?;
            }
        }
    }
    let real = canonical(folder)?;
    if !std::fs::metadata(&real)?.is_dir() {
        return Err(SandboxError::NotADirectory);
    }
    if NativePath::resolve(&real.to_string_lossy()).is_root() {
        return Err(if WINDOWS {
            SandboxError::EntireDrive
        } else {
            SandboxError::EntireFilesystem
        });
    }
    let real_text = NativePath::resolve(&real.to_string_lossy());
    for other in existing.iter() {
        let Ok(other_real) = canonical(&other.folder) else {
            continue;
        };
        let other_real = NativePath::resolve(&other_real.to_string_lossy());
        if other_real.contains(&real_text) || real_text.contains(&other_real) {
            return Err(SandboxError::Overlaps(other.name.clone()));
        }
    }
    Ok(real)
}
