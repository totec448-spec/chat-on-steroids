//! Finds the tunnel executables (`tunnel/locate.ts`). A path the user chose wins. Otherwise
//! the bundled copy wins, so an unrelated stale executable on `PATH` cannot replace the
//! version this app was tested with. `PATH` and the common install folders come last.

use std::path::{Path, PathBuf};

use super::Host;

fn file_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

fn is_executable(candidate: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(candidate) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

/// `hint` may name the executable itself or the folder that holds it.
pub(crate) fn locate(name: &str, hint: &str, host: &Host) -> Option<PathBuf> {
    let file = file_name(name);
    let hint = hint.trim();
    if !hint.is_empty() {
        let hint = Path::new(hint);
        if hint.exists() {
            let inside = hint.join(&file);
            if is_executable(&inside) {
                return Some(inside);
            }
            let named = hint
                .file_name()
                .is_some_and(|given| given.to_string_lossy().eq_ignore_ascii_case(&file));
            if named && is_executable(hint) {
                return Some(hint.to_path_buf());
            }
        }
        let sibling = hint.parent().unwrap_or(Path::new("")).join(&file);
        return is_executable(&sibling).then_some(sibling);
    }
    let bundled = host.bundled_dir.iter().cloned();
    let on_path = host
        .var("PATH")
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default();
    bundled
        .chain(on_path)
        .chain(common_dirs(host))
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| strip_quotes(&dir).join(&file))
        .find(|candidate| is_executable(candidate))
}

fn strip_quotes(dir: &Path) -> PathBuf {
    let text = dir.to_string_lossy();
    PathBuf::from(text.trim_matches('"').to_owned())
}

fn common_dirs(host: &Host) -> Vec<PathBuf> {
    let var = |name: &str| host.var(name).map(PathBuf::from);
    if cfg!(windows) {
        let home = var("USERPROFILE");
        let local = var("LOCALAPPDATA");
        let program_files =
            var("ProgramFiles").unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
        let mut dirs = Vec::new();
        if let Some(local) = &local {
            dirs.push(local.join("Programs").join("tunnel-client"));
            dirs.push(local.join("tunnel-client"));
        }
        if let Some(home) = &home {
            dirs.push(home.join(".tunnel-client"));
            dirs.push(home.join("bin"));
            dirs.push(home.join("Downloads").join("tunnel-client"));
        }
        dirs.push(program_files.join("tunnel-client"));
        dirs.push(program_files.join("cloudflared"));
        dirs
    } else {
        let mut dirs = Vec::new();
        if let Some(home) = var("HOME") {
            dirs.push(home.join(".tunnel-client"));
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join("bin"));
            dirs.push(home.join("Downloads").join("tunnel-client"));
        }
        let system: &[&str] = if cfg!(target_os = "macos") {
            &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        } else {
            &[
                "/home/linuxbrew/.linuxbrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/snap/bin",
            ]
        };
        dirs.extend(system.iter().map(PathBuf::from));
        dirs
    }
}
