//! The JavaScript string rules the TypeScript tools relied on, where Rust's differ.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};

/// `String.prototype.trim`: ECMAScript whitespace, which includes U+FEFF and excludes U+0085.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

/// `text.length`: UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, units)`, except that a surrogate pair is never split: JavaScript would leave a
/// lone surrogate, which a Rust string cannot hold, so the pair is dropped whole.
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

/// `a < b` on JavaScript strings: UTF-16 code unit order.
pub(crate) fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `a.localeCompare(b)` with no locale: ICU's root collation at tertiary strength, the order
/// Node gives for an English system locale.
pub(crate) fn locale_compare(a: &str, b: &str) -> Ordering {
    static COLLATOR: LazyLock<Option<CollatorBorrowed<'static>>> = LazyLock::new(|| {
        Collator::try_new(CollatorPreferences::default(), CollatorOptions::default()).ok()
    });
    match COLLATOR.as_ref() {
        Some(collator) => collator.compare(a, b),
        None => utf16_cmp(a, b),
    }
}

/// `path.win32.extname(path).toLowerCase()` (or the POSIX form elsewhere).
pub(crate) fn extension_lowercase(path: &str) -> String {
    let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    let trimmed = path.trim_end_matches(separators);
    let base = trimmed.rsplit(separators).next().unwrap_or(trimmed);
    match base.rfind('.') {
        Some(0) | None => String::new(),
        Some(dot) => base[dot..].to_lowercase(),
    }
}

/// Node's `fs` error text, `CODE: description, syscall 'path'`, for the messages the TypeScript
/// tools passed through. Only the codes a read of an already resolved path can meet are named.
pub(crate) fn node_error_message(
    error: &std::io::Error,
    syscall: &str,
    path: Option<&str>,
) -> String {
    use std::io::ErrorKind as Kind;
    let (code, description) = match (error.raw_os_error(), error.kind()) {
        (Some(32 | 33), _) if cfg!(windows) => ("EBUSY", "resource busy or locked"),
        (Some(5), _) if cfg!(windows) => ("EPERM", "operation not permitted"),
        (Some(1921), _) if cfg!(windows) => ("ELOOP", "too many symbolic links encountered"),
        (Some(206), _) if cfg!(windows) => ("ENAMETOOLONG", "name too long"),
        (_, Kind::NotFound) => ("ENOENT", "no such file or directory"),
        (_, Kind::PermissionDenied) => ("EACCES", "permission denied"),
        (_, Kind::IsADirectory) => ("EISDIR", "illegal operation on a directory"),
        (_, Kind::NotADirectory) => ("ENOTDIR", "not a directory"),
        (_, Kind::ResourceBusy) => ("EBUSY", "resource busy or locked"),
        _ => ("UNKNOWN", "unknown error"),
    };
    match path {
        Some(path) => format!("{code}: {description}, {syscall} '{path}'"),
        None => format!("{code}: {description}, {syscall}"),
    }
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use super::*;

    #[test]
    fn trim_follows_ecmascript_whitespace() {
        assert_eq!(trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn a_prefix_never_splits_a_surrogate_pair() {
        assert_eq!(utf16_prefix("ab😀c", 3), "ab");
        assert_eq!(utf16_prefix("ab😀c", 4), "ab😀");
        assert_eq!(utf16_prefix("abc", 9), "abc");
    }

    #[test]
    fn locale_order_ignores_case_before_it_ranks_it() {
        // `localeCompare` order, not code unit order: `a.txt` sorts before `README.md`.
        assert_eq!(locale_compare("a.txt", "README.md"), Ordering::Less);
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
        assert_eq!(locale_compare("file10", "file2"), Ordering::Less);
        assert_eq!(locale_compare("_x", "a"), Ordering::Less);
    }

    #[test]
    fn locale_order_equals_node() {
        // `[...].sort((a, b) => a.localeCompare(b))` in Node 24 on Windows, en-US.
        let mut names = [
            "b.txt",
            "A.txt",
            "_x.txt",
            "a.txt",
            "README.md",
            "file10",
            "file2",
            "Ä.txt",
            "-y",
            "é",
            "e",
            "f",
            "10",
            "9",
        ];
        names.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            names.join(" | "),
            "_x.txt | -y | 10 | 9 | a.txt | A.txt | Ä.txt | b.txt | e | é | f | file10 | file2 | README.md"
        );
    }

    #[test]
    fn extension_matches_node_extname() {
        assert_eq!(extension_lowercase("/project/src/pixel.PNG"), ".png");
        assert_eq!(extension_lowercase("/project/.png"), "");
        assert_eq!(extension_lowercase("/project/a"), "");
        assert_eq!(extension_lowercase("/project/a."), ".");
    }
}
