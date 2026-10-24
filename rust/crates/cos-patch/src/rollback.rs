//! The connector's promise around raw Codex: a patch that fails part-way leaves the files as they
//! were (`capturePatchRollbackSnapshots` and `rollbackFailedPatch` in `tools-core.ts`).
//!
//! Before the runtime writes, every path the patch names is snapshotted. After a failure, a path
//! is restored only while it still holds exactly what this patch wrote. A path somebody else
//! changed in between is left alone and reported, because restoring over it would destroy a newer
//! edit the patch has no claim to.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::codex::{AppliedChange, AppliedPatchDelta};
use crate::fs;
use crate::resolve::PatchPaths;

/// Existing data a patch may touch, bounded so the snapshots stay small.
const MAX_ROLLBACK_BYTES: u64 = 64 * 1024 * 1024;

/// What a path held before the patch: its bytes, or nothing.
type State = Option<Vec<u8>>;

pub(crate) struct Snapshots(Vec<Snapshot>);

struct Snapshot {
    real: PathBuf,
    shown: String,
    before: State,
}

/// `readOptionalPatchBytes`: a regular file's bytes, nothing for a missing path, else an error.
fn read_state(real: &Path) -> Result<State, String> {
    match std::fs::symlink_metadata(real) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(cos_tools::ToolError::from_io(&error).to_string()),
        Ok(meta) if !meta.is_file() => {
            return Err("apply_patch target changed from a file before execution".to_owned());
        }
        Ok(_) => {}
    }
    match std::fs::read(real) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(cos_tools::ToolError::from_io(&error).to_string()),
    }
}

impl Snapshots {
    pub(crate) fn capture(paths: &PatchPaths) -> Result<Self, String> {
        let mut snapshots = Vec::new();
        let mut total = 0u64;
        for (real, shown) in paths.targets() {
            let before = read_state(real)?;
            total += before.as_ref().map_or(0, |bytes| bytes.len() as u64);
            if total > MAX_ROLLBACK_BYTES {
                return Err(format!(
                    "apply_patch touches more than {} of existing file data; split it into smaller patches so atomic rollback stays bounded.",
                    cos_fs::format_bytes(MAX_ROLLBACK_BYTES)
                ));
            }
            snapshots.push(Snapshot {
                real: real.to_path_buf(),
                shown: shown.to_string(),
                before,
            });
        }
        Ok(Self(snapshots))
    }

    /// What each path should hold if the recorded changes are all that happened.
    fn expected(&self, delta: &AppliedPatchDelta) -> HashMap<PathBuf, State> {
        let mut expected: HashMap<PathBuf, State> = self
            .0
            .iter()
            .map(|snapshot| (snapshot.real.clone(), snapshot.before.clone()))
            .collect();
        for (real, change) in &delta.changes {
            match change {
                AppliedChange::Add { content, .. } => {
                    expected.insert(real.clone(), Some(content.as_bytes().to_vec()));
                }
                AppliedChange::Delete { .. } => {
                    expected.insert(real.clone(), None);
                }
                AppliedChange::Update {
                    move_path: None,
                    new_content,
                    ..
                } => {
                    expected.insert(real.clone(), Some(new_content.as_bytes().to_vec()));
                }
                AppliedChange::Update {
                    move_path: Some(destination),
                    new_content,
                    ..
                } => {
                    expected.insert(real.clone(), None);
                    expected.insert(destination.clone(), Some(new_content.as_bytes().to_vec()));
                }
            }
        }
        expected
    }

    /// Restores what can be proven ours, then proves the result. On a complete rollback the delta
    /// is emptied, because nothing it describes is on disk any more. Returns the note the model
    /// reads after the runtime's own error.
    pub(crate) fn roll_back(&self, delta: &mut AppliedPatchDelta) -> String {
        let expected = self.expected(delta);
        let mut problems: Vec<String> = Vec::new();

        for snapshot in &self.0 {
            let current = match read_state(&snapshot.real) {
                Ok(current) => current,
                Err(_) => {
                    problems.push(format!(
                        "{}: could not inspect current state",
                        snapshot.shown
                    ));
                    continue;
                }
            };
            if current == snapshot.before {
                continue;
            }
            let ours = expected.get(&snapshot.real).cloned().flatten();
            if current != ours {
                problems.push(format!(
                    "{}: changed outside the recorded patch state",
                    snapshot.shown
                ));
                continue;
            }
            let restored = match &snapshot.before {
                None => fs::remove(&snapshot.real, true),
                Some(bytes) => fs::write(&snapshot.real, bytes),
            };
            if restored.is_err() {
                problems.push(format!("{}: restore failed", snapshot.shown));
            }
        }

        for snapshot in &self.0 {
            let restored = read_state(&snapshot.real).is_ok_and(|state| state == snapshot.before);
            let named = |problems: &[String]| {
                let prefix = format!("{}:", snapshot.shown);
                problems.iter().any(|problem| problem.starts_with(&prefix))
            };
            if !restored && !named(&problems) {
                problems.push(format!("{}: restore verification failed", snapshot.shown));
            }
        }

        if problems.is_empty() {
            delta.changes.clear();
            delta.exact = true;
            return "All file changes from this failed patch were rolled back.".to_owned();
        }
        delta.exact = false;
        format!(
            "WARNING: failed patch rollback was incomplete: {}",
            problems.join("; ")
        )
    }
}
