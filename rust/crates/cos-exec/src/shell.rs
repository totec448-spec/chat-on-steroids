//! Which shell runs a command and the argv it receives (`shell.ts`, a port of codex-rs
//! `shell_detect.rs`, `derive_exec_args` and the PowerShell UTF-8 prefix).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ShellKind {
    PowerShell,
    Cmd,
    Bash,
    Zsh,
    Sh,
}

impl ShellKind {
    pub fn is_posix(self) -> bool {
        matches!(self, Self::Bash | Self::Zsh | Self::Sh)
    }
}

/// A resolved shell: its language and the executable that speaks it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shell {
    pub kind: ShellKind,
    pub path: PathBuf,
}

/// Prefixed to every PowerShell script so pipe-mode output is UTF-8 like PTY output.
pub(crate) const UTF8_OUTPUT_PREFIX: &str =
    "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/// `detectShellType`: by exact name, else by the file stem.
pub(crate) fn detect_shell_kind(path: &str) -> Option<ShellKind> {
    match path {
        "zsh" => Some(ShellKind::Zsh),
        "sh" => Some(ShellKind::Sh),
        "cmd" => Some(ShellKind::Cmd),
        "bash" => Some(ShellKind::Bash),
        "pwsh" | "powershell" => Some(ShellKind::PowerShell),
        _ => {
            let stem = file_stem(path)?;
            if stem == path {
                None
            } else {
                detect_shell_kind(stem)
            }
        }
    }
}

/// Rust `Path::file_stem` over either separator.
fn file_stem(path: &str) -> Option<&str> {
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    if base.is_empty() || base == "." || base == ".." {
        return None;
    }
    match base.rfind('.') {
        Some(0) | None => Some(base),
        Some(dot) => Some(&base[..dot]),
    }
}

fn is_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

fn path_var() -> OsString {
    std::env::var_os("PATH").unwrap_or_default()
}

/// The `which` crate: `PATH` plus `PATHEXT` on Windows.
fn which(binary: &str) -> Option<PathBuf> {
    let extensions: Vec<String> = if cfg!(windows) {
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        std::iter::once(String::new())
            .chain(
                pathext
                    .split(';')
                    .filter(|ext| !ext.is_empty())
                    .map(str::to_owned),
            )
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path_var()) {
        let dir = PathBuf::from(dir.to_string_lossy().trim_matches('"'));
        if dir.as_os_str().is_empty() {
            continue;
        }
        for extension in &extensions {
            let candidate = dir.join(format!("{binary}{extension}"));
            if is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn first_existing(candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| is_file(path))
}

const PWSH_FALLBACK: &[&str] = if cfg!(windows) {
    &[r"C:\Program Files\PowerShell\7\pwsh.exe"]
} else {
    &["/usr/local/bin/pwsh"]
};
const POWERSHELL_FALLBACK: &[&str] = if cfg!(windows) {
    &[r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"]
} else {
    &[]
};

/// `getShellPath`: an existing provided path, else `PATH`, else the fallbacks.
fn shell_path(provided: Option<&str>, binary: &str, fallbacks: &[&str]) -> Option<PathBuf> {
    if let Some(provided) = provided.map(PathBuf::from).filter(|path| is_file(path)) {
        return Some(provided);
    }
    which(binary).or_else(|| first_existing(fallbacks))
}

/// `getShell`.
fn get_shell(kind: ShellKind, provided: Option<&str>) -> Option<Shell> {
    let path = match kind {
        ShellKind::Zsh => shell_path(provided, "zsh", &["/bin/zsh"]),
        ShellKind::Bash => shell_path(provided, "bash", &["/bin/bash", "/usr/bin/bash"]),
        ShellKind::Sh => shell_path(provided, "sh", &["/bin/sh"]),
        ShellKind::Cmd => shell_path(provided, "cmd", &[]),
        ShellKind::PowerShell => shell_path(provided, "pwsh", PWSH_FALLBACK)
            .or_else(|| shell_path(provided, "powershell", POWERSHELL_FALLBACK)),
    }?;
    Some(Shell { kind, path })
}

fn ultimate_fallback() -> Shell {
    if cfg!(windows) {
        Shell {
            kind: ShellKind::Cmd,
            path: PathBuf::from("cmd.exe"),
        }
    } else {
        Shell {
            kind: ShellKind::Sh,
            path: PathBuf::from("/bin/sh"),
        }
    }
}

static DEFAULT_SHELL: Mutex<Option<(OsString, Shell)>> = Mutex::new(None);

/// `defaultUserShell`: PowerShell on Windows (pwsh first), else the login shell's kind, then the
/// platform's usual POSIX shells. Cached until `PATH` changes.
pub(crate) fn default_user_shell() -> Shell {
    let key = path_var();
    if let Ok(cached) = DEFAULT_SHELL.lock()
        && let Some((held, shell)) = cached.as_ref()
        && *held == key
    {
        return shell.clone();
    }
    let shell = if cfg!(windows) {
        get_shell(ShellKind::PowerShell, None).unwrap_or_else(ultimate_fallback)
    } else {
        let configured = std::env::var("SHELL")
            .ok()
            .and_then(|shell| detect_shell_kind(&shell));
        let preference: &[ShellKind] = if cfg!(target_os = "macos") {
            &[ShellKind::Zsh, ShellKind::Bash]
        } else {
            &[ShellKind::Bash, ShellKind::Zsh]
        };
        configured
            .into_iter()
            .chain(preference.iter().copied())
            .find_map(|kind| get_shell(kind, None))
            .unwrap_or_else(ultimate_fallback)
    };
    if let Ok(mut cached) = DEFAULT_SHELL.lock() {
        *cached = Some((key, shell.clone()));
    }
    shell
}

/// `getShellByModelProvidedPath`: an explicit request is honoured exactly or refused, never
/// replaced by another language.
pub(crate) fn shell_by_model_provided_path(provided: &str, cwd: &Path) -> Option<Shell> {
    let kind = detect_shell_kind(provided)?;
    let path_like = Path::new(provided).is_absolute() || provided.contains(['/', '\\']);
    if path_like {
        let resolved = if Path::new(provided).is_absolute() {
            PathBuf::from(provided)
        } else {
            cwd.join(provided)
        };
        return is_file(&resolved).then_some(Shell {
            kind,
            path: resolved,
        });
    }
    match file_stem(provided).map(str::to_lowercase).as_deref() {
        Some("pwsh") => which("pwsh")
            .or_else(|| first_existing(PWSH_FALLBACK))
            .map(|path| Shell {
                kind: ShellKind::PowerShell,
                path,
            }),
        Some("powershell") => which("powershell")
            .or_else(|| first_existing(POWERSHELL_FALLBACK))
            .map(|path| Shell {
                kind: ShellKind::PowerShell,
                path,
            }),
        _ => get_shell(kind, Some(provided)),
    }
}

/// `Shell::derive_exec_args`: the argv the operating system receives.
pub(crate) fn derive_exec_args(shell: &Shell, script: &str, login: bool) -> Vec<String> {
    let program = shell.path.to_string_lossy().into_owned();
    match shell.kind {
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh => vec![
            program,
            if login { "-lc" } else { "-c" }.to_owned(),
            script.to_owned(),
        ],
        ShellKind::PowerShell => {
            let mut args = vec![program];
            if !login {
                args.push("-NoProfile".to_owned());
            }
            args.push("-Command".to_owned());
            args.push(script.to_owned());
            args
        }
        ShellKind::Cmd => vec![program, "/c".to_owned(), script.to_owned()],
    }
}

/// `withPosixPathPrefix`: login profiles run after the environment is prepared, so the bundled
/// ripgrep folder is put back in front afterwards.
pub(crate) fn with_posix_path_prefix(script: &str, kind: ShellKind, dir: Option<&Path>) -> String {
    match dir {
        Some(dir) if kind.is_posix() => format!(
            "export PATH={}:\"${{PATH:-}}\"\n{script}",
            shlex_join(&[dir.to_string_lossy().into_owned()])
        ),
        _ => script.to_owned(),
    }
}

/// The shlex crate's quoting, as `exec_command failed for ...` quotes the command back.
pub(crate) fn shlex_join(tokens: &[String]) -> String {
    if tokens.iter().any(|token| token.contains('\0')) {
        return "<command included NUL byte>".to_owned();
    }
    tokens
        .iter()
        .map(|token| {
            let safe = !token.is_empty()
                && token
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ",._+:@%/-".contains(c));
            if token.is_empty() {
                "''".to_owned()
            } else if safe {
                token.clone()
            } else {
                format!("'{}'", token.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_kinds_follow_names_and_stems() {
        assert_eq!(detect_shell_kind("pwsh"), Some(ShellKind::PowerShell));
        assert_eq!(
            detect_shell_kind(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
            Some(ShellKind::PowerShell)
        );
        assert_eq!(detect_shell_kind("cmd.exe"), Some(ShellKind::Cmd));
        assert_eq!(detect_shell_kind("/bin/bash"), Some(ShellKind::Bash));
        assert_eq!(detect_shell_kind("fish"), None);
    }

    #[test]
    fn powershell_runs_without_profile_unless_login() {
        let shell = Shell {
            kind: ShellKind::PowerShell,
            path: PathBuf::from("pwsh"),
        };
        assert_eq!(
            derive_exec_args(&shell, "Get-Date", false),
            ["pwsh", "-NoProfile", "-Command", "Get-Date"]
        );
        assert_eq!(
            derive_exec_args(&shell, "Get-Date", true),
            ["pwsh", "-Command", "Get-Date"]
        );
    }

    #[test]
    fn shlex_quotes_like_the_shlex_crate() {
        let tokens = ["pwsh", "-Command", "it's a test", ""].map(str::to_owned);
        assert_eq!(shlex_join(&tokens), "pwsh -Command 'it'\\''s a test' ''");
    }

    #[test]
    fn an_unknown_explicit_shell_is_refused() {
        assert_eq!(shell_by_model_provided_path("fish", Path::new(".")), None);
        assert_eq!(
            shell_by_model_provided_path(r".\missing\pwsh.exe", Path::new(".")),
            None
        );
    }
}
