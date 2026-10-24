//! Where the browser extension lives on this machine (`extension-path.ts`).
//!
//! Chrome loads an unpacked extension from a real folder and remembers that exact path. A
//! packaged build therefore mirrors `resources/extension` into `<userData>/extension` on every
//! launch and update, and keeps that folder's identity: it replaces the folder's children, never
//! the folder, because a sandboxed Chromium's document-portal grant belongs to the folder
//! itself. A complete backup stays beside it until the sync has succeeded, so a launch after an
//! interrupted update restores it first. A development checkout's `extension/` is used in place.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// The fingerprint of the package a mirror was made from, written into the mirror.
const MATERIALIZED_FINGERPRINT: &str = ".chat-on-steroids-source";
/// Written last at the root, so Chrome never reads a new manifest before its files exist.
const PUBLISH_LAST: [&str; 2] = ["manifest.json", MATERIALIZED_FINGERPRINT];
const STAMP_FILE: &str = "build-stamp.txt";

/// The extension this app ships, and the folder Chrome should load it from.
#[derive(Clone, Debug)]
pub struct ExtensionFolder(Arc<Inner>);

#[derive(Debug)]
struct Inner {
    source: Source,
    stable: PathBuf,
    shipped: OnceLock<Option<String>>,
}

#[derive(Clone, Debug)]
enum Source {
    /// `resources/extension` of an installed build, mirrored before use.
    Packaged(PathBuf),
    /// A development checkout's `extension/`, used where it is.
    Checkout(PathBuf),
    None,
}

/// `extensionUpdateOffer`: a newer build the running extension could reload into.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UpdateOffer {
    pub build: String,
}

/// `prepareExtensionUpdate`: the offered build, and whether the loaded folder now holds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PreparedUpdate {
    pub build: String,
    pub ready: bool,
}

impl ExtensionFolder {
    /// Looks beside the executable and up to five folders above it: `resources/extension` is a
    /// packaged build, `extension/` a checkout.
    pub fn locate(user_data: &Path) -> Self {
        let exe = std::env::current_exe().ok();
        let ancestors: Vec<PathBuf> = exe
            .iter()
            .flat_map(|exe| exe.ancestors().skip(1).take(6))
            .map(Path::to_path_buf)
            .collect();
        let packaged = ancestors
            .iter()
            .map(|dir| dir.join("resources").join("extension"))
            .find(|dir| valid_extension(dir));
        let source = match packaged {
            Some(dir) => Source::Packaged(dir),
            None => ancestors
                .iter()
                .map(|dir| dir.join("extension"))
                .find(|dir| valid_extension(dir))
                .map_or(Source::None, Source::Checkout),
        };
        Self::with_source(source, user_data)
    }

    /// A packaged build whose extension is `bundled`.
    pub fn packaged(bundled: PathBuf, user_data: &Path) -> Self {
        Self::with_source(Source::Packaged(bundled), user_data)
    }

    /// A checkout whose extension is used in place.
    pub fn checkout(dir: PathBuf, user_data: &Path) -> Self {
        Self::with_source(Source::Checkout(dir), user_data)
    }

    fn with_source(source: Source, user_data: &Path) -> Self {
        Self(Arc::new(Inner {
            source,
            stable: user_data.join("extension"),
            shipped: OnceLock::new(),
        }))
    }

    /// `extensionDir()`: the folder for Load unpacked, or `None` when there is none. For a
    /// packaged build this refreshes the mirror first, and a mirror that cannot be refreshed
    /// still answers if it holds a complete extension. Blocking file IO.
    pub fn dir(&self) -> Option<PathBuf> {
        match &self.0.source {
            Source::Packaged(bundled) => materialize(bundled, &self.0.stable)
                .ok()
                .flatten()
                .or_else(|| valid_extension(&self.0.stable).then(|| self.0.stable.clone())),
            Source::Checkout(dir) => Some(dir.clone()),
            Source::None => None,
        }
    }

    /// `shippedExtensionBuild`: the stamp `scripts/write-extension-stamp.mjs` wrote into the
    /// shipped extension, read once. `None` for an unstamped checkout.
    pub fn shipped_build(&self) -> Option<String> {
        self.0
            .shipped
            .get_or_init(|| {
                let candidates = match &self.0.source {
                    Source::Packaged(bundled) => vec![bundled.clone(), self.0.stable.clone()],
                    Source::Checkout(dir) => vec![dir.clone()],
                    Source::None => Vec::new(),
                };
                candidates
                    .into_iter()
                    .find(|dir| valid_extension(dir))
                    .and_then(|dir| read_stamp(&dir))
            })
            .clone()
    }

    /// `materializedExtensionBuild`: the stamp of the folder Chrome loads a packaged build from.
    pub fn materialized_build(&self) -> Option<String> {
        match self.0.source {
            Source::Packaged(_) => read_stamp(&self.0.stable),
            Source::Checkout(_) | Source::None => None,
        }
    }

    /// Only a packaged build with a stamp offers an update, and only to an extension that
    /// reported a different stamp. Offering does not touch the folder: a folder replaced under
    /// a live service worker hands new tabs new scripts while the old worker still runs.
    pub fn update_offer(&self, running: Option<&str>) -> Option<UpdateOffer> {
        let running = running?;
        if !matches!(self.0.source, Source::Packaged(_)) {
            return None;
        }
        let shipped = self.shipped_build()?;
        (shipped != running).then_some(UpdateOffer { build: shipped })
    }

    /// For an idle extension about to reload: brings the loaded folder up to the shipped build.
    /// Blocking file IO.
    pub fn prepare_update(&self, running: Option<&str>) -> Option<PreparedUpdate> {
        let offer = self.update_offer(running)?;
        let _ = self.dir();
        let ready = self.materialized_build().as_deref() == Some(offer.build.as_str());
        Some(PreparedUpdate {
            build: offer.build,
            ready,
        })
    }
}

fn read_stamp(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(STAMP_FILE)).ok()?;
    let stamp: String = text.trim().chars().take(12).collect();
    (!stamp.is_empty()).then_some(stamp)
}

fn valid_extension(dir: &Path) -> bool {
    fs::metadata(dir.join("manifest.json")).is_ok_and(|meta| meta.is_file())
}

fn materialized_fingerprint(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(MATERIALIZED_FINGERPRINT)).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Directory,
    File,
    Other,
    Missing,
}

fn entry_kind(target: &Path) -> EntryKind {
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.is_dir() => EntryKind::Directory,
        Ok(meta) if meta.is_file() => EntryKind::File,
        Ok(_) => EntryKind::Other,
        Err(_) => EntryKind::Missing,
    }
}

/// `rmSync(target, { recursive: true, force: true })`.
fn remove(target: &Path) -> io::Result<()> {
    let result = match entry_kind(target) {
        EntryKind::Missing => return Ok(()),
        EntryKind::Directory => fs::remove_dir_all(target),
        EntryKind::File | EntryKind::Other => fs::remove_file(target),
    };
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Names in a folder, sorted by bytes, with their kind.
fn entries(dir: &Path) -> io::Result<Vec<(String, EntryKind)>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "an extension file name is not Unicode",
            )
        })?;
        let kind = entry_kind(&entry.path());
        found.push((name, kind));
    }
    found.sort_by(|(a, _), (b, _)| a.cmp(b));
    Ok(found)
}

/// SHA-256 over every directory name and every file's name and bytes. A link or device in the
/// package is refused rather than mirrored into the folder Chrome trusts.
fn fingerprint(root: &Path) -> io::Result<String> {
    fn visit(hash: &mut Sha256, dir: &Path, relative: &str) -> io::Result<()> {
        for (name, kind) in entries(dir)? {
            let path = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let absolute = dir.join(&name);
            match kind {
                EntryKind::Directory => {
                    hash.update(format!("d\0{path}\0"));
                    visit(hash, &absolute, &path)?;
                }
                EntryKind::File => {
                    hash.update(format!("f\0{path}\0"));
                    hash.update(fs::read(&absolute)?);
                    hash.update(b"\0");
                }
                EntryKind::Other | EntryKind::Missing => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("Unsupported extension entry: {path}"),
                    ));
                }
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    visit(&mut hash, root, "")?;
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// `cpSync(from, to, { recursive: true, force: true })` for plain files and folders.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for (name, kind) in entries(from)? {
        match kind {
            EntryKind::Directory => copy_tree(&from.join(&name), &to.join(&name))?,
            EntryKind::File => {
                fs::copy(from.join(&name), to.join(&name))?;
            }
            EntryKind::Other | EntryKind::Missing => {}
        }
    }
    Ok(())
}

fn ensure_directory(target: &Path) -> io::Result<()> {
    match entry_kind(target) {
        EntryKind::Directory => Ok(()),
        EntryKind::Missing => fs::create_dir_all(target),
        EntryKind::File | EntryKind::Other => {
            remove(target)?;
            fs::create_dir_all(target)
        }
    }
}

/// Replaces one file through a complete temporary sibling, so a reader sees the old file or the
/// new one. Windows cannot rename over an existing file, so the old one goes only after the copy.
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "a file at the root"))?;
    ensure_directory(parent)?;
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let temporary = parent.join(format!(".{name}.cos-next-{}", std::process::id()));
    remove(&temporary)?;
    fs::copy(source, &temporary)?;
    fs::set_permissions(&temporary, fs::metadata(source)?.permissions())?;
    remove(target)?;
    fs::rename(&temporary, target)
}

/// Makes `target` hold exactly `source`'s tree while keeping `target`'s own folder.
fn sync_tree_in_place(source: &Path, target: &Path, root: bool) -> io::Result<()> {
    ensure_directory(target)?;
    let source_entries = entries(source)?;
    let last = |name: &str| root && PUBLISH_LAST.contains(&name);
    let publish = |name: &str, kind: EntryKind| -> io::Result<()> {
        let (from, to) = (source.join(name), target.join(name));
        match kind {
            EntryKind::Directory => sync_tree_in_place(&from, &to, false),
            EntryKind::File => replace_file(&from, &to),
            EntryKind::Other | EntryKind::Missing => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Unsupported staged extension entry: {name}"),
            )),
        }
    };
    for (name, kind) in source_entries.iter().filter(|(name, _)| !last(name)) {
        publish(name, *kind)?;
    }
    for (name, _) in entries(target)? {
        if !source_entries.iter().any(|(kept, _)| *kept == name) {
            remove(&target.join(&name))?;
        }
    }
    for (name, kind) in source_entries.iter().filter(|(name, _)| last(name)) {
        publish(name, *kind)?;
    }
    Ok(())
}

/// A previous run stopped part way. The backup is the last published tree and wins over the
/// stage; a stage counts only once its fingerprint was written, after its copy completed.
fn recover_interrupted(stable: &Path, stage: &Path, backup: &Path) -> io::Result<()> {
    if valid_extension(backup) {
        if entry_kind(stable) == EntryKind::Directory {
            sync_tree_in_place(backup, stable, true)?;
        } else {
            remove(stable)?;
            copy_tree(backup, stable)?;
        }
        if valid_extension(stable) {
            remove(backup)?;
            remove(stage)?;
        }
        return Ok(());
    }
    if valid_extension(stage) && materialized_fingerprint(stage).is_some() {
        if entry_kind(stable) == EntryKind::Directory {
            sync_tree_in_place(stage, stable, true)?;
            if valid_extension(stable) {
                remove(stage)?;
            }
        } else {
            remove(stable)?;
            fs::rename(stage, stable)?;
        }
        return Ok(());
    }
    if valid_extension(stable) {
        remove(stage)?;
        remove(backup)?;
    }
    Ok(())
}

fn sibling(stable: &Path, suffix: &str) -> PathBuf {
    let mut name = stable.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// `materializePackagedExtension`: the published folder, or `None` when there is no complete
/// extension to publish.
fn materialize(bundled: &Path, stable: &Path) -> io::Result<Option<PathBuf>> {
    let stage = sibling(stable, ".new");
    let backup = sibling(stable, ".old");
    if let Some(parent) = stable.parent() {
        fs::create_dir_all(parent)?;
    }
    recover_interrupted(stable, &stage, &backup)?;
    let published = || valid_extension(stable).then(|| stable.to_path_buf());
    if !valid_extension(bundled) {
        return Ok(published());
    }
    let fingerprint = fingerprint(bundled)?;
    if valid_extension(stable) && materialized_fingerprint(stable).as_deref() == Some(&fingerprint)
    {
        return Ok(Some(stable.to_path_buf()));
    }
    remove(&stage)?;
    match publish(bundled, stable, &stage, &backup, &fingerprint) {
        Ok(()) => Ok(Some(stable.to_path_buf())),
        Err(_) => {
            // Restore the known-good copy in place. If that fails too, the backup and stage
            // stay for the next launch's recovery.
            if valid_extension(&backup) {
                let restored = if entry_kind(stable) == EntryKind::Directory {
                    sync_tree_in_place(&backup, stable, true)
                } else {
                    remove(stable).and_then(|()| copy_tree(&backup, stable))
                };
                if restored.is_err() {
                    return Ok(published());
                }
            }
            if valid_extension(stable) {
                remove(&stage)?;
                remove(&backup)?;
            }
            Ok(published())
        }
    }
}

fn publish(
    bundled: &Path,
    stable: &Path,
    stage: &Path,
    backup: &Path,
    fingerprint: &str,
) -> io::Result<()> {
    copy_tree(bundled, stage)?;
    if !valid_extension(stage) {
        return Err(io::Error::other(
            "Staged extension is missing manifest.json",
        ));
    }
    fs::write(stage.join(MATERIALIZED_FINGERPRINT), fingerprint)?;
    // A valid published copy becomes the rollback authority before any of its children
    // change. Copying, not renaming, keeps the published folder itself in place.
    remove(backup)?;
    let had_directory = entry_kind(stable) == EntryKind::Directory;
    if valid_extension(stable) {
        copy_tree(stable, backup)?;
    }
    if had_directory {
        sync_tree_in_place(stage, stable, true)?;
        if !valid_extension(stable)
            || materialized_fingerprint(stable).as_deref() != Some(fingerprint)
        {
            return Err(io::Error::other(
                "Published extension did not match staged source",
            ));
        }
        remove(stage)?;
    } else {
        remove(stable)?;
        fs::rename(stage, stable)?;
    }
    remove(backup)
}
