#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use cos_fs::{Access, ApprovedRoot, RootKind, RootName, Roots, SandboxError, canonical};

/// A scratch folder under the system temp folder, removed on drop. Its path is canonical, as a
/// root approved through `validate_new_root` would be.
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let name = format!(
            "cos-fs-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(canonical(&path).unwrap())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, relative: &str) -> PathBuf {
        relative
            .split('/')
            .fold(self.0.clone(), |path, part| path.join(part))
    }

    pub fn write(&self, relative: &str, content: &[u8]) -> PathBuf {
        let path = self.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }

    pub fn dir(&self, relative: &str) -> PathBuf {
        let path = self.join(relative);
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn root(name: &str, folder: &Path) -> ApprovedRoot {
    ApprovedRoot {
        name: RootName::new(name),
        folder: folder.to_path_buf(),
        kind: RootKind::User,
    }
}

pub fn roots(list: &[(&str, &Path)]) -> Roots {
    Roots::new(list.iter().map(|(name, folder)| root(name, folder)))
}

/// Resolves and expects a refusal, returning it.
pub fn refused(roots: &Roots, path: &str, access: Access) -> SandboxError {
    match cos_fs::resolve(roots, path, access) {
        Ok(resolved) => panic!("expected {path:?} to be refused, but it resolved to {resolved:?}"),
        Err(error) => error,
    }
}

/// A directory link at `link` pointing to `target`: a junction on Windows (no privilege needed),
/// a symlink elsewhere. `target` need not exist.
pub fn dir_link(target: &Path, link: &Path) {
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .arg("/d")
            .arg("/c")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J failed");
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// A file symlink, or `false` when the OS refuses to create one (Windows without the privilege).
pub fn file_symlink(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    return std::os::windows::fs::symlink_file(target, link).is_ok();
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link).unwrap();
        true
    }
}
