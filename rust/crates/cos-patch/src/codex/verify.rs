// Derived from OpenAI Codex, `codex-rs/apply-patch/src/invocation.rs`
// (`verify_apply_patch_args_with_mode`) at commit 1a4096e273e80da30947e57fdfa45be92858ca91
// (https://github.com/openai/codex). Copyright 2025 OpenAI. Licensed under the Apache License,
// Version 2.0; see `codex/LICENSE` and `codex/NOTICE` in this crate.
//
// Modified for Chat On Steroids, following the TypeScript port in
// `src/main/codex/apply-patch/index.ts` (`verifyApplyPatchArgs`):
// - Upstream refuses a patch that names one path twice, though its own applier takes such a
//   patch hunk by hunk. Here a later hunk on a path reads what the earlier hunk would have left
//   (`pending`), so the dry run refuses exactly what the applier would refuse, for its reason.
// - Every target, including a move destination, is checked for kind and size before anything is
//   written, and a move onto its own source is refused.
// - The per-file unified diff for Codex's approval UI is not computed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::file_update::derive_new_contents_from_chunks;
use super::{ApplyPatchError, ApplyPatchFileUpdateMode, Hunk, MAX_PATCH_SOURCE_BYTES};
use crate::fs::{self, FsError};
use crate::resolve::{PatchPaths, same_file};

/// Why the dry run refused a patch. The tool words the two kinds differently: a patch error by
/// its message, anything else as `friendlyError` would.
#[derive(Debug)]
pub(crate) enum VerifyError {
    Patch(ApplyPatchError),
    Fs(FsError),
    /// A spelling the sandbox did not resolve. Unreachable when the paths come from the hunks.
    Unresolved(String),
}

impl From<FsError> for VerifyError {
    fn from(error: FsError) -> Self {
        Self::Fs(error)
    }
}

impl From<ApplyPatchError> for VerifyError {
    fn from(error: ApplyPatchError) -> Self {
        Self::Patch(error)
    }
}

/// What an earlier hunk of this patch would have left at a path. A path no hunk has touched is
/// not in the map: it is unknown and is read from disk.
enum Pending {
    Present(String),
    Absent,
}

/// The error the applier would raise reading a file this patch has already removed. Saying which
/// hunk removed it helps the model more than the `ENOENT` text it stands for.
fn removed_earlier(context: String) -> ApplyPatchError {
    ApplyPatchError::Io {
        context,
        source: "an earlier hunk in this patch removed it".to_owned(),
    }
}

/// `try_verify_apply_patch_args`: works out what every hunk would do, against the real disk,
/// without writing. A delete of a missing file or an update whose context cannot be found fails
/// here, before any file is touched.
pub(crate) fn verify(
    hunks: &[Hunk],
    mode: ApplyPatchFileUpdateMode,
    paths: &PatchPaths,
) -> Result<(), VerifyError> {
    let mut pending: HashMap<PathBuf, Pending> = HashMap::new();
    let real = |spelled: &str| paths.real(spelled).map_err(VerifyError::Unresolved);

    for hunk in hunks {
        let path = real(hunk.source_path())?;
        let before = pending.get(path);
        // The budget guards a file this call reads off disk. Text an earlier hunk wrote is the
        // patch's own, which the transport already bounded.
        if before.is_none() {
            verify_target(path, matches!(hunk, Hunk::AddFile { .. }))?;
        }
        let shown = path.display();

        match hunk {
            Hunk::AddFile { contents, .. } => {
                pending.insert(path.to_path_buf(), Pending::Present(contents.clone()));
            }
            Hunk::DeleteFile { .. } => {
                match before {
                    None => {
                        fs::read_text(path).map_err(|error| {
                            ApplyPatchError::io(format!("Failed to read {shown}"), &error)
                        })?;
                    }
                    Some(Pending::Present(_)) => {}
                    Some(Pending::Absent) => {
                        return Err(removed_earlier(format!("Failed to read {shown}")).into());
                    }
                }
                pending.insert(path.to_path_buf(), Pending::Absent);
            }
            Hunk::UpdateFile {
                move_path, chunks, ..
            } => {
                let original = match before {
                    Some(Pending::Absent) => {
                        return Err(removed_earlier(format!(
                            "Failed to read file to update {shown}"
                        ))
                        .into());
                    }
                    Some(Pending::Present(text)) => text.clone(),
                    None => fs::read_text(path).map_err(|error| {
                        ApplyPatchError::io(
                            format!("Failed to read file to update {shown}"),
                            &error,
                        )
                    })?,
                };
                let new_contents =
                    derive_new_contents_from_chunks(&shown.to_string(), original, chunks, mode)?
                        .new_contents;
                let destination = match move_path {
                    Some(move_path) => Some(real(move_path)?),
                    None => None,
                };
                if let Some(destination) = destination {
                    if same_file(path, destination) {
                        return Err(FsError::invalid_input(
                            "move source and destination resolve to the same file",
                        )
                        .into());
                    }
                    // A move writes its destination before it removes the source, so a
                    // destination on disk is checked now, while the whole patch can still be
                    // refused. One an earlier hunk touched is already simulated in `pending`.
                    if !pending.contains_key(destination) {
                        verify_target(destination, true)?;
                    }
                }
                match destination {
                    None => {
                        pending.insert(path.to_path_buf(), Pending::Present(new_contents));
                    }
                    Some(destination) => {
                        pending.insert(path.to_path_buf(), Pending::Absent);
                        pending.insert(destination.to_path_buf(), Pending::Present(new_contents));
                    }
                }
            }
        }
    }
    Ok(())
}

/// A target must be a regular file within the patch budget, or missing when that is allowed.
fn verify_target(path: &Path, allow_missing: bool) -> Result<(), FsError> {
    match fs::metadata(path) {
        Ok(meta) if !meta.is_file => {
            Err(FsError::invalid_input("patch target is not a regular file"))
        }
        Ok(meta) if meta.size > MAX_PATCH_SOURCE_BYTES => Err(FsError::invalid_input(format!(
            "file is too large to patch safely: limit is {MAX_PATCH_SOURCE_BYTES} bytes"
        ))),
        Ok(_) => Ok(()),
        Err(error) if allow_missing && error.is_not_found() => Ok(()),
        Err(error) => Err(error),
    }
}
