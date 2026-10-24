//! Approved roots and virtual paths: the one place a model-supplied path becomes a real path.
//!
//! Unit C1.3 owns this crate (port of `src/main/sandbox.ts`, with the parts of `fsops.ts`,
//! `rawfs.ts` and `diffstat.ts` the file tools use, and `globToRegExp` from `search.ts`). Every
//! file tool (C1.4, C1.5) and the exec working-folder check (C1.6) resolve through [`resolve`]
//! or [`resolve_from`]; none of them joins a root and a model path by hand.
//!
//! The model only ever sees virtual paths (`/project/src/main.rs`). [`Resolved`] carries both
//! spellings, so a result can never echo a real host path by accident.
//!
//! Resolution does blocking filesystem IO (canonicalization); run it on a blocking thread.

mod diffstat;
mod error;
mod fsops;
mod glob;
mod image;
mod lexical;
mod rawfs;
mod roots;
mod sandbox;
mod stray;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use diffstat::{LineDelta, format_delta, line_delta};
pub use error::{Approved, OsError, SandboxError};
pub use fsops::{
    BINARY_SNIFF_BYTES, DEFAULT_READ_BYTES, FsOpError, ImageMime, MAX_IMAGE_BYTES, MAX_READ_BYTES,
    clamp, format_bytes, image_mime, is_excluded_folder_name, sniff_binary_bytes,
    validate_image_structure,
};
pub use glob::Glob;
pub use image::{MAX_VIEW_IMAGE_BYTES, validate_image_bytes};
pub use rawfs::canonical;
pub use roots::{RESERVED_ROOT_NAMES, normalise_root_name, unique_root_name, validate_new_root};
pub use sandbox::{is_absolute_virtual_path, is_native_windows_path};
pub use stray::stray_virtual_path;

/// The name of an approved root, as addressed in virtual paths: `/project` is root `project`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RootName(String);

impl RootName {
    /// The managed skills root every Core endpoint adds (`withManagedSkills`).
    pub const SKILLS: &'static str = "skills";

    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RootName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "/{}", self.0)
    }
}

/// Where a root came from. Managed roots follow their own write rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RootKind {
    /// A folder the user approved in Settings (`config.roots`).
    User,
    /// The profile's `skills` folder, exposed as `/skills`.
    ManagedSkills,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovedRoot {
    pub name: RootName,
    /// The folder as configured. Canonicalized at resolve time, never trusted as canonical.
    pub folder: PathBuf,
    pub kind: RootKind,
}

/// The live approved roots, in the order the model sees them (user roots, then `/skills`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Roots(Arc<[ApprovedRoot]>);

impl Roots {
    /// The roots one config grants: its user roots plus the managed skills folder, which
    /// replaces any user root named `skills`. No IO.
    pub fn from_config(roots: &[cos_types::config::Root], skills_dir: &Path) -> Self {
        let user = roots
            .iter()
            .filter(|root| root.name.to_lowercase() != RootName::SKILLS)
            .map(|root| ApprovedRoot {
                name: RootName::new(root.name.clone()),
                folder: PathBuf::from(&root.path),
                kind: RootKind::User,
            });
        let skills = ApprovedRoot {
            name: RootName::new(RootName::SKILLS),
            folder: skills_dir.to_path_buf(),
            kind: RootKind::ManagedSkills,
        };
        Self::new(user.chain(std::iter::once(skills)))
    }

    /// Exactly these roots, in this order (a linked skill package's own single root, a test).
    pub fn new(roots: impl IntoIterator<Item = ApprovedRoot>) -> Self {
        Self(roots.into_iter().collect())
    }

    pub fn iter(&self) -> impl Iterator<Item = &ApprovedRoot> {
        self.0.iter()
    }

    pub fn get(&self, name: &str) -> Option<&ApprovedRoot> {
        self.0.iter().find(|root| root.name.as_str() == name)
    }
}

/// A path in the model's namespace, always absolute: `/<root>/<rest>`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct VirtualPath(String);

impl VirtualPath {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The virtual path of the entry `name` inside this folder, as a directory listing names it.
    pub fn child(&self, name: &str) -> VirtualPath {
        VirtualPath(format!("{}/{name}", self.0))
    }
}

impl fmt::Display for VirtualPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// What the caller intends to do at the path. Decides the existence rules: only `Create` may
/// name a path that does not exist yet, and `WorkingFolder` must be an existing folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Create,
    Write,
    Delete,
    /// A command's working folder.
    WorkingFolder,
}

impl Access {
    fn allows_missing(self) -> bool {
        self == Self::Create
    }
}

/// A path that passed every sandbox check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub virtual_path: VirtualPath,
    /// The canonical host path. Never shown to the model.
    pub real: PathBuf,
    pub root: RootName,
}

/// Resolves a model-supplied path (virtual, or a native path inside a root) for `access`.
/// A relative path is refused: there is no folder to start from.
pub fn resolve(roots: &Roots, path: &str, access: Access) -> Result<Resolved, SandboxError> {
    sandbox::resolve_with(roots, path, None, access)
}

/// [`resolve`], with a relative path taken to start at `base` (the chat's workspace). The join
/// happens before validation, so `..` is still refused and cannot climb out of `base`.
pub fn resolve_from(
    roots: &Roots,
    base: &VirtualPath,
    path: &str,
    access: Access,
) -> Result<Resolved, SandboxError> {
    sandbox::resolve_with(roots, path, Some(base), access)
}

/// The virtual spelling of a canonical real path inside one of `roots`, if it is inside one.
/// Canonicalizes each root to compare, so it does blocking IO.
pub fn to_virtual(roots: &Roots, real: &Path) -> Option<VirtualPath> {
    sandbox::to_virtual(roots, real)
}
