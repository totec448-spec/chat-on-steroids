//! The environment an `exec_command` child receives (`exec.ts` `childEnv`, `env.ts`,
//! `toolchain.ts` and codex's `UNIFIED_EXEC_ENV`).
//!
//! Windows compares variable names without case, so every lookup and write here does too. A
//! second spelling of `PATH` is how the TypeScript app once handed children a path holding only
//! the ripgrep folder.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Variables no child may read, whatever their spelling.
const SECRET_KEYS: &[&str] = &[
    "CONTROL_PLANE_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "CLOUDFLARED_TOKEN",
    "CLOUDFLARED_TUNNEL_TOKEN",
];

/// Codex forces these on every unified exec child so output is deterministic and pager-free.
fn unified_exec_env() -> [(&'static str, &'static str); 10] {
    let locale = if cfg!(target_os = "macos") {
        "en_US.UTF-8"
    } else {
        "C.UTF-8"
    };
    [
        ("NO_COLOR", "1"),
        ("TERM", "dumb"),
        ("LANG", locale),
        ("LC_CTYPE", locale),
        ("LC_ALL", locale),
        ("COLORTERM", ""),
        ("PAGER", "cat"),
        ("GIT_PAGER", "cat"),
        ("GH_PAGER", "cat"),
        ("CODEX_CI", "1"),
    ]
}

const PATH_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// An environment block with the host's name semantics.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Env(Vec<(OsString, OsString)>);

fn same_name(left: &OsStr, right: &str) -> bool {
    if cfg!(windows) {
        left.to_string_lossy().eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

impl Env {
    /// `normalizeEnvironment`: the first spelling of a name keeps it; a later duplicate only
    /// fills an empty value.
    pub(crate) fn from_pairs(pairs: impl IntoIterator<Item = (OsString, OsString)>) -> Self {
        let mut env = Self::default();
        for (key, value) in pairs {
            match env
                .0
                .iter_mut()
                .find(|(held, _)| same_name(held, &key.to_string_lossy()))
            {
                Some((_, held)) if held.is_empty() => *held = value,
                Some(_) => {}
                None => env.0.push((key, value)),
            }
        }
        env
    }

    pub(crate) fn get(&self, name: &str) -> Option<&OsStr> {
        self.0
            .iter()
            .find(|(key, _)| same_name(key, name))
            .map(|(_, value)| value.as_os_str())
    }

    /// Sets `name` under the spelling the block already uses and drops any other spelling.
    pub(crate) fn set(&mut self, name: &str, value: impl Into<OsString>) {
        let value = value.into();
        let mut kept = false;
        self.0.retain_mut(|(key, held)| {
            if !same_name(key, name) {
                return true;
            }
            if kept {
                return false;
            }
            kept = true;
            *held = value.clone();
            true
        });
        if !kept {
            self.0.push((name.into(), value));
        }
    }

    pub(crate) fn remove(&mut self, name: &str) {
        self.0.retain(|(key, _)| !same_name(key, name));
    }

    /// The path entries, unquoted and without blanks.
    pub(crate) fn path_entries(&self) -> Vec<String> {
        self.get("PATH")
            .map(|path| {
                path.to_string_lossy()
                    .split(PATH_SEPARATOR)
                    .map(|entry| entry.trim().trim_matches('"').to_owned())
                    .filter(|entry| !entry.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Puts `dir` first on the path, once.
    pub(crate) fn prepend_path(&mut self, dir: &Path) {
        let dir = dir.to_string_lossy().into_owned();
        let same = |entry: &String| {
            if cfg!(windows) {
                entry.eq_ignore_ascii_case(&dir)
            } else {
                *entry == dir
            }
        };
        let mut entries: Vec<String> = self
            .path_entries()
            .into_iter()
            .filter(|entry| !same(entry))
            .collect();
        entries.insert(0, dir);
        self.set("PATH", entries.join(&PATH_SEPARATOR.to_string()));
    }

    /// `ensureUsablePath`: the directories Windows always has, appended when missing, so a
    /// child of a broken parent can still start PowerShell.
    fn ensure_usable_path(&mut self) {
        if !cfg!(windows) {
            return;
        }
        let root = self
            .get("SystemRoot")
            .or_else(|| self.get("windir"))
            .map(|root| root.to_string_lossy().into_owned())
            .filter(|root| !root.is_empty())
            .unwrap_or_else(|| r"C:\Windows".to_owned());
        let system32 = format!(r"{root}\System32");
        let defaults = [
            system32.clone(),
            root,
            format!(r"{system32}\Wbem"),
            format!(r"{system32}\WindowsPowerShell\v1.0"),
        ];
        let mut entries = self.path_entries();
        let mut changed = false;
        for dir in defaults {
            if !entries.iter().any(|entry| entry.eq_ignore_ascii_case(&dir)) {
                entries.push(dir);
                changed = true;
            }
        }
        if changed {
            self.set("PATH", entries.join(";"));
        }
    }

    pub(crate) fn into_pairs(self) -> Vec<(OsString, OsString)> {
        self.0
    }
}

/// The environment of every `exec_command` child: this process's environment without the
/// connector secrets, the bundled ripgrep first on `PATH`, Windows' own folders guaranteed,
/// undeclared JDK and Go toolchains filled in, and codex's deterministic-output variables last.
pub(crate) fn exec_child_env(ripgrep: Option<&Path>) -> Env {
    let mut env = Env::from_pairs(std::env::vars_os());
    if let Some(dir) = ripgrep.and_then(Path::parent) {
        env.prepend_path(dir);
    }
    for secret in SECRET_KEYS {
        env.remove(secret);
    }
    env.ensure_usable_path();
    ensure_dev_toolchain(&mut env);
    for (key, value) in unified_exec_env() {
        env.set(key, value);
    }
    env
}

fn ripgrep_name() -> &'static str {
    if cfg!(windows) { "rg.exe" } else { "rg" }
}

/// `locateRipgrep`: the copy shipped beside the app (`resources/rg`, searched from the
/// executable's folder upwards so a development build finds the repository's copy), then `PATH`.
pub(crate) fn locate_ripgrep() -> Option<PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            let exe = std::env::current_exe().ok();
            let shipped = exe
                .iter()
                .flat_map(|exe| exe.ancestors().skip(1).take(5))
                .find_map(|dir| {
                    let candidate = dir.join("resources").join("rg").join(ripgrep_name());
                    candidate.is_file().then_some(candidate)
                });
            shipped.or_else(|| {
                std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                    .map(|dir| dir.join(ripgrep_name()))
                    .find(|candidate| candidate.is_file())
            })
        })
        .clone()
}

// ------------------------------------------------------------------ toolchain.ts

/// Where a JDK lives on Windows when nobody exported `JAVA_HOME`.
fn java_candidates(env: &Env) -> Vec<PathBuf> {
    let program_files = var_or(env, "ProgramFiles", r"C:\Program Files");
    let program_files_x86 = var_or(env, "ProgramFiles(x86)", r"C:\Program Files (x86)");
    let local = env.get("LOCALAPPDATA").map(PathBuf::from);
    let mut out = vec![
        program_files.join(r"Android\Android Studio\jbr"),
        program_files.join(r"Android\Android Studio\jre"),
    ];
    if let Some(local) = &local {
        out.push(local.join(r"Programs\Android Studio\jbr"));
    }
    out.push(program_files_x86.join(r"Android\Android Studio\jbr"));
    for vendor in [
        "Eclipse Adoptium",
        "Java",
        "Microsoft",
        "Amazon Corretto",
        "Zulu",
        r"JetBrains\Toolbox\apps",
    ] {
        out.push(program_files.join(vendor));
    }
    out
}

fn go_candidates(env: &Env) -> Vec<PathBuf> {
    let program_files = var_or(env, "ProgramFiles", r"C:\Program Files");
    let mut out = vec![program_files.join("Go")];
    if let Some(local) = env.get("LOCALAPPDATA") {
        out.push(PathBuf::from(local).join(r"Programs\Go"));
    }
    out.push(PathBuf::from(r"C:\Go"));
    out
}

fn var_or(env: &Env, name: &str, fallback: &str) -> PathBuf {
    env.get(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(fallback))
}

/// Natural-order descending comparison of folder names, so `jdk-21` beats `jdk-17`.
fn by_version_descending(left: &Path, right: &Path) -> std::cmp::Ordering {
    fn chunks(path: &Path) -> Vec<String> {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let mut out: Vec<String> = Vec::new();
        for c in name.chars() {
            match out.last_mut() {
                Some(last)
                    if last
                        .chars()
                        .next()
                        .is_some_and(|first| first.is_ascii_digit())
                        == c.is_ascii_digit() =>
                {
                    last.push(c);
                }
                _ => out.push(c.to_string()),
            }
        }
        out
    }
    let (a, b) = (chunks(left), chunks(right));
    for index in 0..a.len().max(b.len()) {
        let order = match (a.get(index), b.get(index)) {
            (None, _) => return std::cmp::Ordering::Greater,
            (_, None) => return std::cmp::Ordering::Less,
            (Some(x), Some(y)) => match (x.parse::<u128>(), y.parse::<u128>()) {
                (Ok(x), Ok(y)) => x.cmp(&y),
                _ => x.cmp(y),
            },
        };
        if order != std::cmp::Ordering::Equal {
            return order.reverse();
        }
    }
    right.cmp(left)
}

fn first_toolchain(candidates: &[PathBuf], executable: &str) -> Option<PathBuf> {
    for candidate in candidates {
        if candidate.join("bin").join(executable).is_file() {
            return Some(candidate.clone());
        }
        let mut children: Vec<PathBuf> = std::fs::read_dir(candidate)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                    .map(|entry| entry.path())
                    .collect()
            })
            .unwrap_or_default();
        children.sort_by(|a, b| by_version_descending(a, b));
        if let Some(found) = children
            .into_iter()
            .find(|child| child.join("bin").join(executable).is_file())
        {
            return Some(found);
        }
    }
    None
}

/// `ensureDevToolchain`: fills in `JAVA_HOME` and `GOROOT` (and their `bin` on `PATH`) when they
/// are unset and the tool is not already reachable. Windows only, discovered once per process.
fn ensure_dev_toolchain(env: &mut Env) {
    if !cfg!(windows) {
        return;
    }
    let reachable = |exe: &str| {
        env.path_entries()
            .iter()
            .any(|dir| Path::new(dir).join(exe).is_file())
    };
    let needs_java = env.get("JAVA_HOME").is_none() && !reachable("java.exe");
    let needs_go = env.get("GOROOT").is_none() && !reachable("go.exe");
    if !needs_java && !needs_go {
        return;
    }
    static FOUND: OnceLock<(Option<PathBuf>, Option<PathBuf>)> = OnceLock::new();
    let (java, go) = FOUND.get_or_init(|| {
        (
            first_toolchain(&java_candidates(env), "javac.exe"),
            first_toolchain(&go_candidates(env), "go.exe"),
        )
    });
    if needs_java && let Some(java) = java {
        env.set("JAVA_HOME", java.as_os_str());
        env.prepend_path(&java.join("bin"));
    }
    if needs_go && let Some(go) = go {
        env.set("GOROOT", go.as_os_str());
        env.prepend_path(&go.join("bin"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(items: &[(&str, &str)]) -> Env {
        Env::from_pairs(
            items
                .iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v))),
        )
    }

    #[cfg(windows)]
    #[test]
    fn path_edits_keep_one_spelling() {
        let mut env = pairs(&[("Path", r"C:\A;C:\B")]);
        env.prepend_path(Path::new(r"C:\rg"));
        env.prepend_path(Path::new(r"c:\RG"));
        assert_eq!(env.get("PATH"), Some(OsStr::new(r"c:\RG;C:\A;C:\B")));
        let names: Vec<_> = env.into_pairs().into_iter().map(|(k, _)| k).collect();
        assert_eq!(names, [OsString::from("Path")]);
    }

    #[cfg(windows)]
    #[test]
    fn secrets_are_removed_in_any_spelling_and_exec_variables_win() {
        let mut env = pairs(&[
            ("openai_api_key", "x"),
            ("Path", r"C:\A"),
            ("PAGER", "less"),
        ]);
        for secret in SECRET_KEYS {
            env.remove(secret);
        }
        for (key, value) in unified_exec_env() {
            env.set(key, value);
        }
        assert_eq!(env.get("OPENAI_API_KEY"), None);
        assert_eq!(env.get("pager"), Some(OsStr::new("cat")));
    }

    #[cfg(windows)]
    #[test]
    fn a_broken_path_regains_the_windows_folders() {
        let mut env = pairs(&[("SystemRoot", r"C:\Windows"), ("PATH", r"C:\rg")]);
        env.ensure_usable_path();
        let entries = env.path_entries();
        assert_eq!(entries[0], r"C:\rg");
        assert!(entries.contains(&r"C:\Windows\System32\WindowsPowerShell\v1.0".to_owned()));
    }

    #[test]
    fn newest_version_folder_sorts_first() {
        let mut names = [
            PathBuf::from("jdk-17.0.2"),
            PathBuf::from("jdk-21.0.1"),
            PathBuf::from("jdk-8"),
        ];
        names.sort_by(|a, b| by_version_descending(a, b));
        assert_eq!(names[0], PathBuf::from("jdk-21.0.1"));
        assert_eq!(names[2], PathBuf::from("jdk-8"));
    }
}
