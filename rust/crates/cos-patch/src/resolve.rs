//! Every path a patch names, resolved through the sandbox before the runtime touches anything
//! (`resolvePatchPaths` in `src/main/mcp/tools-core.ts`).
//!
//! Codex joins a hunk path onto its cwd. The connector instead resolves each spelling once, with
//! `cos-fs`, against the patch base, and the dry run and the applier read the result back. A path
//! the sandbox refuses refuses the whole patch before any file is read.

use std::collections::HashMap;
use std::path::Path;

use cos_fs::{Access, Resolved, Roots, SandboxError, VirtualPath, is_native_windows_path};

use crate::codex::Hunk;

pub(crate) struct PatchPaths {
    by_spelling: HashMap<String, usize>,
    /// Each real path once, in the order the patch first named it.
    targets: Vec<Resolved>,
    /// Host spellings that must never be echoed, each with its virtual path.
    rewrites: Vec<(String, String)>,
}

impl PatchPaths {
    /// Resolves every hunk path relative to `base`, the way the dry run and the applier will meet
    /// them. A later hunk may name a path an earlier Add or Move creates, so a path only has to
    /// exist on disk when no earlier hunk decided whether it exists.
    pub(crate) fn resolve(
        roots: &Roots,
        base: &VirtualPath,
        hunks: &[Hunk],
    ) -> Result<Self, SandboxError> {
        let mut paths = Self {
            by_spelling: HashMap::new(),
            targets: Vec::new(),
            rewrites: Vec::new(),
        };
        let mut presence: HashMap<String, bool> = HashMap::new();

        for hunk in hunks {
            match hunk {
                Hunk::AddFile { path, .. } => {
                    let target = paths.add(roots, base, path, &presence, false)?;
                    presence.insert(target, true);
                }
                Hunk::DeleteFile { path } => {
                    let target = paths.add(roots, base, path, &presence, true)?;
                    presence.insert(target, false);
                }
                Hunk::UpdateFile {
                    path, move_path, ..
                } => {
                    let source = paths.add(roots, base, path, &presence, true)?;
                    let Some(move_path) = move_path else {
                        presence.insert(source, true);
                        continue;
                    };
                    let destination = paths.add(roots, base, move_path, &presence, false)?;
                    presence.insert(source, false);
                    presence.insert(destination, true);
                }
            }
        }
        paths
            .rewrites
            .sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
        Ok(paths)
    }

    /// Resolves one spelling and returns its presence key.
    fn add(
        &mut self,
        roots: &Roots,
        base: &VirtualPath,
        spelled: &str,
        presence: &HashMap<String, bool>,
        require_existing: bool,
    ) -> Result<String, SandboxError> {
        // The sandbox identity first, without requiring the leaf, so a path that exists only in
        // the patch's own sequence has a stable key.
        let mut resolved = cos_fs::resolve_from(roots, base, spelled, Access::Create)?;
        let key = presence_key(&resolved.real);
        // An untouched Update or Delete target keeps the strict `Not found` refusal. Once an
        // earlier hunk decided the path's presence, the dry run owns the verdict.
        if require_existing && !presence.contains_key(&key) {
            resolved = cos_fs::resolve_from(roots, base, spelled, Access::Write)?;
        }
        let real = resolved.real.display().to_string();
        let shown = resolved.virtual_path.to_string();
        self.rewrites.push((real, shown.clone()));
        if is_native_windows_path(spelled) {
            self.rewrites.push((spelled.to_owned(), shown));
        }
        let index = match self
            .targets
            .iter()
            .position(|known| known.real == resolved.real)
        {
            Some(index) => index,
            None => {
                self.targets.push(resolved);
                self.targets.len() - 1
            }
        };
        self.by_spelling.insert(spelled.to_owned(), index);
        Ok(key)
    }

    /// The real path a spelling resolved to. The error is the sandbox's own text.
    pub(crate) fn real(&self, spelled: &str) -> Result<&Path, String> {
        self.by_spelling
            .get(spelled)
            .map(|&index| self.targets[index].real.as_path())
            .ok_or_else(|| format!("Patch path was not validated before use: {spelled}"))
    }

    /// Every resolved path once, by real path, with its virtual spelling.
    pub(crate) fn targets(&self) -> impl Iterator<Item = (&Path, &VirtualPath)> {
        self.targets
            .iter()
            .map(|resolved| (resolved.real.as_path(), &resolved.virtual_path))
    }

    /// The virtual spelling of a real path this patch resolved.
    pub(crate) fn virtual_of(&self, real: &Path) -> Option<&VirtualPath> {
        self.targets
            .iter()
            .find(|resolved| resolved.real == real)
            .map(|resolved| &resolved.virtual_path)
    }

    /// `safePatchOutput`: text with every host spelling replaced by its virtual path.
    pub(crate) fn redact(&self, text: &str) -> String {
        let mut safe = text.to_owned();
        for (from, to) in &self.rewrites {
            if from.is_empty() || from == to || !safe.contains(from.as_str()) {
                continue;
            }
            safe = safe.replace(from.as_str(), to);
        }
        safe
    }
}

/// Windows paths name the same file regardless of case.
fn presence_key(real: &Path) -> String {
    let text = real.display().to_string();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// Whether two real paths are one file, so a write-then-remove move would delete it.
pub(crate) fn same_file(left: &Path, right: &Path) -> bool {
    presence_key(left) == presence_key(right)
}

/// The root a relative patch path starts from: the first root that is not the managed Skills
/// folder (`firstTaskRoot`), as `/<name>`. `None` when no folder is approved.
pub(crate) fn first_task_root(roots: &Roots) -> Option<String> {
    roots
        .iter()
        .find(|root| {
            root.kind == cos_fs::RootKind::User
                && !root
                    .name
                    .as_str()
                    .eq_ignore_ascii_case(cos_fs::RootName::SKILLS)
        })
        .map(|root| root.name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_file_follows_the_platform_case_rule() {
        let left = Path::new("/a/File.txt");
        let right = Path::new("/a/file.txt");
        assert_eq!(same_file(left, right), cfg!(windows));
        assert!(same_file(left, left));
    }
}
