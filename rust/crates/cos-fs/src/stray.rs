//! `strayVirtualPath`: a virtual path written inside shell text, which nothing will translate.

use crate::Roots;
use crate::lexical::is_js_whitespace as is_js_space;

/// The characters that may stand right before a virtual path: `[\s'"`(,=[{]`.
fn opens_path(c: char) -> bool {
    is_js_space(c) || matches!(c, '\'' | '"' | '`' | '(' | ',' | '=' | '[' | '{')
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// `[^\s'"`;|)\]}]`
fn continues_path(c: char) -> bool {
    !(is_js_space(c) || matches!(c, '\'' | '"' | '`' | ';' | '|' | ')' | ']' | '}'))
}

/// `(\/[A-Za-z0-9._-]+(?:\/[^\s'"`;|)\]}]*)?)` at the start of `text`: its byte length.
fn path_at(text: &str) -> Option<usize> {
    let rest = text.strip_prefix('/')?;
    let name = rest.find(|c| !is_name_char(c)).unwrap_or(rest.len());
    if name == 0 {
        return None;
    }
    let mut end = 1 + name;
    if text[end..].starts_with('/') {
        let tail = &text[end + 1..];
        end += 1 + tail.find(|c| !continues_path(c)).unwrap_or(tail.len());
    }
    Some(end)
}

/// The first `/name/...` in `text` whose `name` is an approved root and which is not also an
/// approved native POSIX spelling, or `None`. A command diagnostic, not authorization.
pub fn stray_virtual_path<'a>(text: &'a str, roots: &Roots) -> Option<&'a str> {
    roots.iter().next()?;
    let names: Vec<String> = roots
        .iter()
        .map(|root| root.name.as_str().to_lowercase())
        .collect();
    let mut from = 0;
    while from <= text.len() {
        let (start, end) = next_match(text, from)?;
        from = end;
        let found = &text[start..end];
        let first = found[1..].split('/').next().unwrap_or("").to_lowercase();
        if !names.contains(&first) {
            continue;
        }
        let native = roots.iter().any(|root| {
            let folder = root.folder.to_string_lossy();
            if !folder.starts_with('/') {
                return false;
            }
            let prefix = folder.trim_end_matches('/');
            found == prefix
                || found
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with('/'))
        });
        if !native {
            return Some(found);
        }
    }
    None
}

/// The leftmost match at or after byte `from`: `(path start, match end)`.
fn next_match(text: &str, from: usize) -> Option<(usize, usize)> {
    if from == 0
        && let Some(end) = path_at(text)
    {
        return Some((0, end));
    }
    for (offset, c) in text[from..].char_indices() {
        if opens_path(c) {
            let start = from + offset + c.len_utf8();
            if let Some(len) = path_at(&text[start..]) {
                return Some((start, start + len));
            }
        }
    }
    None
}
