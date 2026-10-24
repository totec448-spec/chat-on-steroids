// Derived from OpenAI Codex, `codex-rs/apply-patch/src/lib.rs` (`apply_hunks_to_files`,
// `print_summary`) at commit 1a4096e273e80da30947e57fdfa45be92858ca91
// (https://github.com/openai/codex). Copyright 2025 OpenAI. Licensed under the Apache License,
// Version 2.0; see `codex/LICENSE` and `codex/NOTICE` in this crate.
//
// Modified for Chat On Steroids, following the TypeScript port in
// `src/main/codex/apply-patch/index.ts`:
// - Paths come from the connector's sandbox resolution, not from `cwd.join(path)`.
// - The runtime records an `AppliedPatchDelta`, the changes it committed and whether they still
//   describe the disk, so the tool can roll a failed patch back without touching newer edits.
// - A size budget guards each file a hunk reads, a delete or move refuses a folder, and a move
//   whose source cannot be removed restores its destination when that is provably safe.
// - Errors are the message `anyhow` would print, written to an in-memory stderr.

use std::path::{Path, PathBuf};

use super::file_update::{AppliedPatch, derive_new_contents_from_chunks};
use super::{ApplyPatchError, ApplyPatchFileUpdateMode, Hunk, MAX_PATCH_SOURCE_BYTES};
use crate::fs::{self, FsError};
use crate::resolve::PatchPaths;

/// A committed file change, as the runtime wrote it.
#[derive(Debug)]
pub(crate) enum AppliedChange {
    Add {
        content: String,
        overwritten: Option<String>,
    },
    Delete {
        content: String,
    },
    Update {
        move_path: Option<PathBuf>,
        old_content: String,
        new_content: String,
    },
}

/// The textual file changes actually committed while applying a patch, in order.
#[derive(Debug)]
pub(crate) struct AppliedPatchDelta {
    pub(crate) changes: Vec<(PathBuf, AppliedChange)>,
    /// False once a partial write means the recorded changes may not describe what is on disk.
    pub(crate) exact: bool,
}

/// What `ApplyPatchRuntime::run` reports: an exec-shaped result plus the delta.
pub(crate) struct Execution {
    pub(crate) failed: bool,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) delta: AppliedPatchDelta,
}

/// Applies `hunks` in order. A failure stops at the hunk that failed and keeps what the earlier
/// hunks committed, as Codex does; the tool decides whether to roll it back.
pub(crate) fn execute(
    hunks: &[Hunk],
    mode: ApplyPatchFileUpdateMode,
    paths: &PatchPaths,
) -> Execution {
    let mut delta = AppliedPatchDelta {
        changes: Vec::new(),
        exact: true,
    };
    match apply_hunks_to_files(hunks, mode, paths, &mut delta) {
        Ok(affected) => Execution {
            failed: false,
            stdout: affected.summary(),
            stderr: String::new(),
            delta,
        },
        Err(message) => Execution {
            failed: true,
            stdout: String::new(),
            stderr: format!("{message}\n"),
            delta,
        },
    }
}

/// File paths affected by a patch, spelled as the patch spelled them.
#[derive(Default)]
struct AffectedPaths<'a> {
    added: Vec<&'a str>,
    modified: Vec<&'a str>,
    deleted: Vec<&'a str>,
}

impl AffectedPaths<'_> {
    /// `print_summary`: the summary of changes, in git-style format.
    fn summary(&self) -> String {
        let mut out = String::from("Success. Updated the following files:\n");
        for (tag, paths) in [
            ('A', &self.added),
            ('M', &self.modified),
            ('D', &self.deleted),
        ] {
            for path in paths {
                out.push_str(&format!("{tag} {path}\n"));
            }
        }
        out
    }
}

/// `with_context`: `anyhow` prints only the outermost context.
fn context<T>(result: Result<T, FsError>, context: impl FnOnce() -> String) -> Result<T, String> {
    result.map_err(|_| context())
}

fn apply_hunks_to_files<'a>(
    hunks: &'a [Hunk],
    mode: ApplyPatchFileUpdateMode,
    paths: &PatchPaths,
    delta: &mut AppliedPatchDelta,
) -> Result<AffectedPaths<'a>, String> {
    if hunks.is_empty() {
        return Err("No files were modified.".to_owned());
    }
    let mut affected = AffectedPaths::default();

    for hunk in hunks {
        let resolved = paths.real(hunk.source_path())?;
        match hunk {
            Hunk::AddFile { contents, .. } => {
                ensure_within_budget(resolved, true)?;
                let overwritten = read_optional_for_delta(resolved, delta);
                // A failed write can still have changed the target (a truncate before ENOSPC).
                write_with_missing_parent_retry(resolved, contents).inspect_err(|_| {
                    delta.exact = false;
                })?;
                delta.changes.push((
                    resolved.to_path_buf(),
                    AppliedChange::Add {
                        content: contents.clone(),
                        overwritten,
                    },
                ));
                affected.added.push(hunk.path());
            }
            Hunk::DeleteFile { .. } => {
                ensure_within_budget(resolved, false)?;
                note_existing_path_delta_support(resolved, delta);
                let deleted = fs::read_text(resolved).ok();
                if deleted.is_none() {
                    delta.exact = false;
                }
                let failed = || format!("Failed to delete file {}", resolved.display());
                context(ensure_not_directory(resolved), failed)?;
                if let Err(error) = context(fs::remove(resolved, false), failed) {
                    delta.exact = delta.exact && unchanged(resolved, deleted.as_deref());
                    return Err(error);
                }
                if let Some(content) = deleted {
                    delta
                        .changes
                        .push((resolved.to_path_buf(), AppliedChange::Delete { content }));
                }
                affected.deleted.push(hunk.path());
            }
            Hunk::UpdateFile {
                move_path, chunks, ..
            } => {
                ensure_within_budget(resolved, false)?;
                note_existing_path_delta_support(resolved, delta);
                let path_text = resolved.display().to_string();
                let original = fs::read_text(resolved).map_err(|error| {
                    ApplyPatchError::io(
                        format!("Failed to read file to update {path_text}"),
                        &error,
                    )
                    .to_string()
                })?;
                let AppliedPatch {
                    original_contents,
                    new_contents,
                } = derive_new_contents_from_chunks(&path_text, original, chunks, mode)
                    .map_err(|error| error.to_string())?;

                let Some(move_path) = move_path else {
                    context(fs::write(resolved, new_contents.as_bytes()), || {
                        format!("Failed to write file {path_text}")
                    })
                    .inspect_err(|_| delta.exact = false)?;
                    delta.changes.push((
                        resolved.to_path_buf(),
                        AppliedChange::Update {
                            move_path: None,
                            old_content: original_contents,
                            new_content: new_contents,
                        },
                    ));
                    affected.modified.push(hunk.path());
                    continue;
                };

                let destination = paths.real(move_path)?;
                let overwritten = read_optional_for_delta(destination, delta);
                write_with_missing_parent_retry(destination, &new_contents)
                    .inspect_err(|_| delta.exact = false)?;
                let destination_change = delta.changes.len();
                delta.changes.push((
                    destination.to_path_buf(),
                    AppliedChange::Add {
                        content: new_contents.clone(),
                        overwritten: overwritten.clone(),
                    },
                ));
                let failed = || format!("Failed to remove original {path_text}");
                let removed = context(ensure_not_directory(resolved), failed)
                    .and_then(|()| context(fs::remove(resolved, false), failed));
                if let Err(error) = removed {
                    let side_effect_free = unchanged(resolved, Some(&original_contents));
                    delta.exact = delta.exact && side_effect_free;
                    // The destination was written before the source removal failed. With the
                    // source proven unchanged, put the destination back exactly as it was, so a
                    // sharing violation cannot destroy an existing file while reporting an error.
                    // When the source is uncertain, keep the destination: it may be the only copy.
                    if side_effect_free {
                        // Never restore a stale preimage over somebody else's newer edit.
                        let still_ours =
                            fs::read_text(destination).is_ok_and(|current| current == new_contents);
                        if !still_ours {
                            delta.exact = false;
                            return Err(error);
                        }
                        let restored = match &overwritten {
                            None => fs::remove(destination, true),
                            Some(previous) => fs::write(destination, previous.as_bytes()),
                        };
                        match restored {
                            Ok(()) => {
                                delta.changes.remove(destination_change);
                            }
                            Err(_) => delta.exact = false,
                        }
                    }
                    return Err(error);
                }
                delta.changes[destination_change] = (
                    resolved.to_path_buf(),
                    AppliedChange::Update {
                        move_path: Some(destination.to_path_buf()),
                        old_content: original_contents,
                        new_content: new_contents,
                    },
                );
                affected.modified.push(hunk.path());
            }
        }
    }

    Ok(affected)
}

fn ensure_within_budget(path: &Path, allow_missing: bool) -> Result<(), String> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file && meta.size > MAX_PATCH_SOURCE_BYTES => Err(format!(
            "file is too large to patch safely: limit is {MAX_PATCH_SOURCE_BYTES} bytes"
        )),
        Ok(_) => Ok(()),
        Err(error) if allow_missing && error.is_not_found() => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn ensure_not_directory(path: &Path) -> Result<(), FsError> {
    if fs::metadata(path)?.is_directory {
        return Err(FsError::invalid_input("path is a directory"));
    }
    Ok(())
}

/// Whether a failed removal left the file exactly as it was.
fn unchanged(path: &Path, expected: Option<&str>) -> bool {
    expected.is_some_and(|expected| fs::read_text(path).is_ok_and(|current| current == expected))
}

fn read_optional_for_delta(path: &Path, delta: &mut AppliedPatchDelta) -> Option<String> {
    note_existing_path_delta_support(path, delta);
    match fs::read_text(path) {
        Ok(text) => Some(text),
        Err(error) => {
            if !error.is_not_found() {
                delta.exact = false;
            }
            None
        }
    }
}

/// Only a regular file, not a link or a folder, is text the delta can describe and restore.
fn note_existing_path_delta_support(path: &Path, delta: &mut AppliedPatchDelta) {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file && !meta.is_symlink => {}
        Ok(_) => delta.exact = false,
        Err(error) if error.is_not_found() => {}
        Err(_) => delta.exact = false,
    }
}

fn write_with_missing_parent_retry(path: &Path, contents: &str) -> Result<(), String> {
    let failed_write = || format!("Failed to write file {}", path.display());
    match fs::write(path, contents.as_bytes()) {
        Ok(()) => return Ok(()),
        Err(error) if !error.is_not_found() => return Err(failed_write()),
        Err(_) => {}
    }
    let parent = path.parent().unwrap_or(path);
    context(fs::create_dir_all(parent), || {
        format!("Failed to create parent directories for {}", path.display())
    })?;
    context(fs::write(path, contents.as_bytes()), failed_write)
}
