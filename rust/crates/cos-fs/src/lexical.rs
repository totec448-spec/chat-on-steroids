//! String rules the TypeScript sandbox gets from JavaScript and `node:path`, reproduced exactly:
//! `String.prototype.trim`, UTF-16 lengths, and `path.resolve` / `isContained` on both platforms.

pub(crate) const WINDOWS: bool = cfg!(windows);

/// JavaScript `WhiteSpace` and `LineTerminator`, which `trim()` removes. Not Rust's set: JS
/// trims U+FEFF and keeps U+0085. The same set is `\s` in a regular expression.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `text.length` in JavaScript.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, units)`. A cut through a surrogate pair drops the whole pair, because a Rust
/// string cannot hold the lone surrogate JavaScript would keep.
pub(crate) fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, c) in text.char_indices() {
        used += c.len_utf16();
        if used > units {
            return &text[..index];
        }
    }
    text
}

fn is_separator(c: char) -> bool {
    c == '/' || (WINDOWS && c == '\\')
}

/// A path after `path.resolve()`: a device (`C:`, `\\server\share`, or empty on POSIX) and the
/// normalized parts below it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NativePath {
    device: String,
    parts: Vec<String>,
}

impl NativePath {
    /// `path.resolve(input)` for the host platform. Relative input resolves against the process
    /// working folder, as Node does.
    pub(crate) fn resolve(input: &str) -> Self {
        let (device, absolute, rest) = split_root(input);
        if absolute && (!device.is_empty() || !WINDOWS) {
            return Self::from_parts(device, rest);
        }
        let cwd = std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (cwd_device, _, cwd_rest) = split_root(&cwd);
        if absolute {
            // Rooted without a device (`\foo`, or `\\server` without a share): the current drive.
            return Self::from_parts(cwd_device, rest);
        }
        if !device.is_empty() && !device.eq_ignore_ascii_case(&cwd_device) {
            return Self::from_parts(device, rest);
        }
        let mut path = Self::from_parts(cwd_device, cwd_rest);
        push_parts(&mut path.parts, rest);
        path
    }

    fn from_parts(device: String, rest: &str) -> Self {
        let mut parts = Vec::new();
        push_parts(&mut parts, rest);
        Self { device, parts }
    }

    /// A UNC or device spelling (`\\server\share`, `\\?\C:`, `\\.\pipe`).
    pub(crate) fn is_unc(&self) -> bool {
        self.device.starts_with("\\\\")
    }

    /// `nativePathIdentity`: case-insensitive on Windows, except the Linux part of a WSL path.
    fn identity(&self) -> (String, Vec<String>) {
        if !WINDOWS {
            return (self.device.clone(), self.parts.clone());
        }
        if let Some(distro) = wsl_distro(&self.device) {
            return (
                format!("\\\\wsl.localhost\\{}", distro.to_lowercase()),
                self.parts.clone(),
            );
        }
        (
            self.device.to_lowercase(),
            self.parts.iter().map(|part| part.to_lowercase()).collect(),
        )
    }

    /// `isContained(self, child)`: `child` is this path or below it, by the identity rules.
    pub(crate) fn contains(&self, child: &Self) -> bool {
        self.relative(child).is_some()
    }

    /// The parts of `child` below this path, in `child`'s own spelling.
    pub(crate) fn relative<'a>(&self, child: &'a Self) -> Option<&'a [String]> {
        let (device, parts) = self.identity();
        let (child_device, child_parts) = child.identity();
        (device == child_device && child_parts.starts_with(&parts))
            .then(|| &child.parts[parts.len()..])
    }

    /// The root of this path is the whole path (`C:\`, `\\server\share\`, `/`).
    pub(crate) fn is_root(&self) -> bool {
        self.parts.is_empty()
    }
}

impl std::fmt::Display for NativePath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let sep = if WINDOWS { "\\" } else { "/" };
        write!(f, "{}{sep}{}", self.device, self.parts.join(sep))
    }
}

fn push_parts(parts: &mut Vec<String>, rest: &str) {
    for part in rest.split(is_separator) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part.to_owned()),
        }
    }
}

/// Node's root parse: `(device, absolute, rest)`. A UNC device needs both a server and a share.
fn split_root(input: &str) -> (String, bool, &str) {
    if !WINDOWS {
        return (String::new(), input.starts_with('/'), input);
    }
    let mut chars = input.chars();
    match (chars.next(), chars.next()) {
        (Some(a), Some(b)) if is_separator(a) && is_separator(b) => {
            if let Some((server, share, rest)) = unc_parts(&input[2..]) {
                return (format!("\\\\{server}\\{share}"), true, rest);
            }
            (String::new(), true, input)
        }
        (Some(a), _) if is_separator(a) => (String::new(), true, input),
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic() => {
            let rest = &input[2..];
            (input[..2].to_owned(), rest.starts_with(is_separator), rest)
        }
        _ => (String::new(), false, input),
    }
}

fn unc_parts(after: &str) -> Option<(&str, &str, &str)> {
    let server_end = after.find(is_separator)?;
    let server = &after[..server_end];
    let tail = after[server_end..].trim_start_matches(is_separator);
    let share_end = tail.find(is_separator).unwrap_or(tail.len());
    let share = &tail[..share_end];
    (!server.is_empty() && !share.is_empty()).then_some((server, share, &tail[share_end..]))
}

/// The distribution of a `\\wsl.localhost\<distro>` or `\\wsl$\<distro>` device.
fn wsl_distro(device: &str) -> Option<&str> {
    let rest = device.strip_prefix("\\\\")?;
    let (host, distro) = rest.split_once('\\')?;
    (host.eq_ignore_ascii_case("wsl.localhost") || host.eq_ignore_ascii_case("wsl$"))
        .then_some(distro)
}

/// `WSL_PATH.test(text)`: `^\\(wsl.localhost|wsl$)\<distro>`, case-insensitive host.
pub(crate) fn matches_wsl(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("\\\\") else {
        return false;
    };
    let Some((host, after)) = rest.split_once('\\') else {
        return false;
    };
    (host.eq_ignore_ascii_case("wsl.localhost") || host.eq_ignore_ascii_case("wsl$"))
        && !after.is_empty()
        && !after.starts_with('\\')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_contained(parent: &str, child: &str) -> bool {
        NativePath::resolve(parent).contains(&NativePath::resolve(child))
    }

    #[test]
    fn js_trim_matches_javascript() {
        assert_eq!(js_trim(" \u{feff}x\u{85} "), "x\u{85}");
        assert_eq!(js_trim("\u{3000}a\u{2028}"), "a");
    }

    #[test]
    fn utf16_prefix_counts_code_units() {
        assert_eq!(utf16_prefix("ab\u{1f600}c", 3), "ab");
        assert_eq!(utf16_prefix("ab\u{1f600}c", 4), "ab\u{1f600}");
        assert_eq!(utf16_len("ab\u{1f600}c"), 5);
    }

    #[cfg(windows)]
    #[test]
    fn resolves_like_node_win32() {
        let cases = [
            ("C:/Windows/win.ini", "C:\\Windows\\win.ini"),
            ("c:\\x\\\\y\\", "c:\\x\\y"),
            ("C:\\", "C:\\"),
            ("\\\\server\\share", "\\\\server\\share\\"),
            ("\\\\server\\\\share", "\\\\server\\share\\"),
            ("\\\\server/share/x/", "\\\\server\\share\\x"),
            ("\\\\?\\C:\\Windows", "\\\\?\\C:\\Windows"),
            ("\\\\.\\pipe\\x", "\\\\.\\pipe\\x"),
            ("\\\\wsl$\\Ubuntu\\home", "\\\\wsl$\\Ubuntu\\home"),
            ("//server/share/x", "\\\\server\\share\\x"),
        ];
        for (input, expected) in cases {
            assert_eq!(NativePath::resolve(input).to_string(), expected, "{input}");
        }
        let drive = NativePath::resolve("\\").to_string();
        assert_eq!(
            NativePath::resolve("\\\\server").to_string(),
            format!("{drive}server")
        );
    }

    #[cfg(windows)]
    #[test]
    fn containment_follows_the_identity_rules() {
        assert!(is_contained("C:\\Root", "C:\\Root"));
        assert!(is_contained("C:\\Root", "C:\\Root\\a\\b"));
        assert!(is_contained("C:\\Root", "c:\\root\\a"));
        assert!(!is_contained("C:\\Root", "C:\\RootEvil"));
        assert!(!is_contained("C:\\Root", "C:\\Root-2\\a"));
        assert!(!is_contained("C:\\share", "\\\\C:\\share\\x"));
        let wsl = "\\\\wsl.localhost\\Ubuntu\\home\\you\\Project";
        assert!(is_contained(
            wsl,
            "\\\\WSL$\\ubuntu\\home\\you\\Project\\File.txt"
        ));
        assert!(!is_contained(
            wsl,
            "\\\\wsl.localhost\\Ubuntu\\home\\you\\project"
        ));
    }
}
