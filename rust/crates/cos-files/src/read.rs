//! `read`: folders, text, images and metadata in one tool (`tools-core.ts`).

use cos_fs::{
    Access, DEFAULT_READ_BYTES, Glob, MAX_READ_BYTES, Roots, SandboxError, format_bytes, resolve,
};
use cos_tools::{CallNotes, Capability, Content, Grants, ToolError, ToolOutput, ToolResult};

use crate::ReadArgs;
use crate::disk::{self, Kind};
use crate::failure::Failure;
use crate::find::DEFAULT_EXCLUDES;
use crate::image::view_image;
use crate::js;
use crate::text::{TextError, read_text_file};

/// Entries one folder read returns before it says it stopped.
const MAX_DIR_ENTRIES: usize = 200;
/// Files one glob may expand to.
const MAX_GLOB_MATCHES: usize = 20;
/// Files one call may touch after every path and glob is expanded.
const MAX_READ_TARGETS: usize = 40;
const MAX_READ_IMAGES: usize = 4;
const MAX_READ_IMAGE_BYTES: u64 = 12 * 1024 * 1024;
/// Entries a glob walk looks at before it gives up on the pattern.
const GLOB_SCAN_LIMIT: usize = 5_000;
/// Entries a not-found error lists from the nearest folder that exists.
const MISSING_PATH_LISTING: usize = 40;
const IMAGE_EXTENSIONS: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp"];

const BINARY_NOTE: &str = "Binary file, so its bytes are not returned. Use exec_command if you need to inspect or convert it.";
const BROWSE_NEEDED: &str = "TOOL_DISABLED: listing folders needs the Browse folders permission.";

/// One path to read, with the range the caller attached to it (`path:12-40`), if any.
struct Target {
    path: String,
    range: Option<LineRange>,
}

#[derive(Clone, Copy)]
struct LineRange {
    start: u64,
    end: Option<u64>,
}

/// One section of the answer. `charged` is what it costs the call's text budget.
struct Section {
    text: String,
    charged: u64,
    image: Option<(String, &'static str)>,
    /// `lines a–b` of a text read, for the call record.
    detail: Option<String>,
}

impl Section {
    fn text(text: String) -> Self {
        Self {
            charged: text.len() as u64,
            text,
            image: None,
            detail: None,
        }
    }

    /// A section that costs nothing: a permission note, not file content.
    fn free(text: String) -> Self {
        Self {
            charged: 0,
            ..Self::text(text)
        }
    }
}

struct Permissions {
    read: bool,
    browse: bool,
}

/// The per-target knobs `readOne` takes.
struct ReadOne<'a> {
    roots: &'a Roots,
    permissions: &'a Permissions,
    range: Option<LineRange>,
    max_bytes: u64,
    image_budget: u64,
}

pub(crate) fn read(grants: &Grants, args: ReadArgs) -> Result<ToolOutput, ToolError> {
    let caps = grants.capabilities;
    let permissions = Permissions {
        read: caps.contains(Capability::Read),
        browse: caps.contains(Capability::Browse),
    };
    if !permissions.read && !permissions.browse && !caps.contains(Capability::Metadata) {
        return Err(ToolError::Refused(
            "TOOL_DISABLED: read is disabled by the current Chat On Steroids permissions. Ask the user to enable reading in the app.".to_owned(),
        ));
    }
    let roots = &grants.roots;

    let mut targets: Vec<Target> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    for item in &args.paths {
        if targets.len() >= MAX_READ_TARGETS {
            notes.push(format!("(stopped expanding at {MAX_READ_TARGETS} paths)"));
            break;
        }
        let (requested, range) = split_line_range(item);
        if !has_glob(requested) {
            targets.push(Target {
                path: requested.to_owned(),
                range,
            });
            continue;
        }
        let expansion = expand_glob(roots, requested).map_err(ToolError::from)?;
        if expansion.matches.is_empty() {
            notes.push(match expansion.truncated {
                Some(Truncation::Scan) => format!(
                    "{requested}: glob scan stopped after {GLOB_SCAN_LIMIT} entries before finding a match; narrow the pattern or start from a deeper folder"
                ),
                _ => format!("{requested}: no matches"),
            });
            continue;
        }
        let room = MAX_READ_TARGETS - targets.len();
        targets.extend(
            expansion
                .matches
                .into_iter()
                .take(room)
                .map(|path| Target { path, range }),
        );
        match expansion.truncated {
            Some(Truncation::Matches) => notes.push(format!(
                "{requested}: more than {MAX_GLOB_MATCHES} matches, narrow the pattern"
            )),
            Some(Truncation::Scan) => notes.push(format!(
                "{requested}: glob scan stopped after {GLOB_SCAN_LIMIT} entries; more matches may exist, narrow the pattern or start from a deeper folder"
            )),
            None => {}
        }
    }

    let call_range = (args.start_line.is_some() || args.end_line.is_some()).then(|| LineRange {
        start: args.start_line.map_or(1, u64::from),
        end: args.end_line.map(u64::from),
    });
    let shared = targets
        .iter()
        .filter(|target| target.range.is_none())
        .count();
    if shared > 1 && call_range.is_some() {
        notes.push(format!(
            "(start_line/end_line applied to each of the {shared} files this call resolved to; every header states the lines actually returned)"
        ));
    }

    let mut sections: Vec<String> = Vec::new();
    let mut images: Vec<Content> = Vec::new();
    let mut remaining = MAX_READ_BYTES as i64;
    let mut image_bytes = 0u64;
    let mut failures = 0;
    // What was actually read (`noteCount`): targets after the output cap are never attempted.
    let mut successes = 0u64;
    let mut notes_for_record = CallNotes::default();
    for target in &targets {
        if remaining <= 0 {
            sections
                .push("(output cap reached; read the remaining paths in another call)".to_owned());
            break;
        }
        let options = ReadOne {
            roots,
            permissions: &permissions,
            range: target.range.or(call_range),
            max_bytes: u64::from(args.max_bytes.unwrap_or(DEFAULT_READ_BYTES as u32))
                .min(remaining as u64),
            image_budget: if images.len() < MAX_READ_IMAGES {
                MAX_READ_IMAGE_BYTES.saturating_sub(image_bytes)
            } else {
                0
            },
        };
        match read_one(&target.path, &options) {
            Ok(section) => {
                successes += 1;
                remaining -= section.charged as i64;
                if let Some((data, mime)) = section.image {
                    image_bytes += data.len() as u64;
                    images.push(Content::Image {
                        data,
                        mime_type: mime.to_owned(),
                    });
                }
                if section.detail.is_some() {
                    notes_for_record.detail = section.detail;
                }
                sections.push(section.text);
            }
            Err(failure) => {
                failures += 1;
                let nearby = if permissions.browse {
                    nearest_folder_listing(roots, &target.path, &failure)
                } else {
                    String::new()
                };
                sections.push(format!(
                    "--- {} — ERROR ---\n{}{nearby}",
                    target.path,
                    failure.text()
                ));
            }
        }
    }

    notes_for_record.count = Some(successes);
    sections.extend(notes);
    let text = sections.join("\n\n");
    // Partial reads stay useful, but a call where every target failed is not a success.
    if !targets.is_empty() && failures == targets.len() {
        return Err(ToolError::Refused(if text.is_empty() {
            "Nothing could be read.".to_owned()
        } else {
            text
        }));
    }
    let text = if text.is_empty() && images.is_empty() {
        "Nothing to read.".to_owned()
    } else {
        text
    };
    let mut content = vec![Content::Text { text }];
    content.extend(images);
    Ok(ToolOutput {
        result: ToolResult {
            content,
            structured_content: None,
            is_error: false,
        },
        notes: notes_for_record,
    })
}

fn has_glob(path: &str) -> bool {
    path.contains(['*', '?'])
}

/// A `path:12-40` or `path:12` suffix. Only digits after the last colon that follows something
/// other than a separator or colon count, so `C:\...` is never read as a range, and a range that
/// runs backwards stays on the path for the sandbox to refuse.
fn split_line_range(requested: &str) -> (&str, Option<LineRange>) {
    let parse = || -> Option<(&str, LineRange)> {
        let (path, suffix) = requested.rsplit_once(':')?;
        let last = path.chars().last()?;
        if matches!(last, '\\' | '/' | ':') {
            return None;
        }
        let (start, end) = match suffix.split_once('-') {
            Some((start, end)) => (start, Some(end)),
            None => (suffix, None),
        };
        let digits = |text: &str| {
            (1..=9).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
        };
        if !digits(start) || end.is_some_and(|end| !digits(end)) {
            return None;
        }
        let start: u64 = start.parse().ok()?;
        let end: Option<u64> = end.map(str::parse).transpose().ok()?;
        if start < 1 || end.is_some_and(|end| end < start) {
            return None;
        }
        Some((path, LineRange { start, end }))
    };
    match parse() {
        Some((path, range)) => (path, Some(range)),
        None => (requested, None),
    }
}

enum Truncation {
    Matches,
    Scan,
}

struct Expansion {
    matches: Vec<String>,
    truncated: Option<Truncation>,
}

/// `expandGlob`: the longest glob-free prefix is the folder, the rest is the pattern. `**`
/// walks; a single-level pattern reads one folder.
fn expand_glob(roots: &Roots, pattern: &str) -> Result<Expansion, Failure> {
    let normalised = if cfg!(windows) {
        pattern.replace('\\', "/")
    } else {
        pattern.to_owned()
    };
    let segments: Vec<&str> = normalised.split('/').collect();
    let fixed = segments
        .iter()
        .take_while(|segment| !has_glob(segment))
        .count();
    let mut base = segments[..fixed].join("/");
    // A leading wildcard is relative to the chat's folder, never to `/`.
    if base.is_empty() && normalised.starts_with('/') {
        base = "/".to_owned();
    }
    let rest = segments[fixed..].join("/");

    let resolved = resolve(roots, &base, Access::Read)?;
    let virtual_dir = resolved.virtual_path.as_str();
    let info = disk::stat_info(&resolved.real, virtual_dir, false)?;
    if info.kind != Kind::Directory {
        return Err(Failure::Refused(format!(
            "{virtual_dir} is not a folder, so it cannot be globbed"
        )));
    }
    let (candidates, scan_truncated) = if rest.contains("**") {
        disk::walk_files(
            &resolved.real,
            virtual_dir,
            GLOB_SCAN_LIMIT,
            DEFAULT_EXCLUDES,
        )?
    } else {
        let (listed, truncated) =
            disk::list_directory_level(&resolved.real, virtual_dir, GLOB_SCAN_LIMIT, false)?;
        let files = listed
            .into_iter()
            .filter(|entry| entry.kind == Kind::File)
            .map(|entry| entry.virtual_path)
            .collect();
        (files, truncated)
    };

    let matcher = Glob::new(&rest, false);
    let prefix = virtual_dir.len() + 1;
    let mut matches = Vec::new();
    for candidate in candidates {
        if !matcher.is_match(&candidate[prefix..]) {
            continue;
        }
        // Truncated means a match was left out, not that the result landed on the cap.
        if matches.len() >= MAX_GLOB_MATCHES {
            return Ok(Expansion {
                matches,
                truncated: Some(Truncation::Matches),
            });
        }
        matches.push(candidate);
    }
    Ok(Expansion {
        matches,
        truncated: scan_truncated.then_some(Truncation::Scan),
    })
}

fn is_virtual_root(requested: &str) -> bool {
    let trimmed = js::trim(requested);
    let separator = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    !trimmed.is_empty() && trimmed.chars().all(separator)
}

/// `readOne`: what is at one path, as one section.
fn read_one(requested: &str, options: &ReadOne<'_>) -> Result<Section, Failure> {
    // `/` itself: the shared folders are what it contains.
    if is_virtual_root(requested) {
        if !options.permissions.browse {
            return Ok(Section::free(format!("--- / ---\n{BROWSE_NEEDED}")));
        }
        let names: Vec<String> = options
            .roots
            .iter()
            .map(|root| format!("d {}", root.name.as_str()))
            .collect();
        let text = match names.len() {
            0 => "--- / — no folders are shared yet ---".to_owned(),
            count => format!(
                "--- / — {count} {}, one level ---\n{}",
                entries_word(count),
                names.join("\n")
            ),
        };
        return Ok(Section::text(text));
    }

    let resolved = resolve(options.roots, requested, Access::Read)?;
    let shown = resolved.virtual_path.as_str();
    let real = resolved.real.as_path();
    let mut info = disk::stat_info(real, shown, !options.permissions.read)?;

    if info.kind == Kind::Directory {
        if !options.permissions.browse {
            return Ok(Section::free(format!("--- {shown} ---\n{BROWSE_NEEDED}")));
        }
        let (entries, truncated) = disk::list_directory_level(real, shown, MAX_DIR_ENTRIES, true)?;
        if entries.is_empty() {
            return Ok(Section::text(format!("--- {shown} — empty folder ---")));
        }
        let body: Vec<String> = entries
            .iter()
            .map(|entry| {
                let kind = match entry.kind {
                    Kind::Directory => 'd',
                    Kind::File => 'f',
                    Kind::Other => '?',
                };
                let size = entry
                    .bytes
                    .map(|bytes| format!("  {}", format_bytes(bytes)))
                    .unwrap_or_default();
                format!("{kind} {}{size}", entry.name)
            })
            .collect();
        let note = if truncated {
            format!(
                "\n(stopped at {MAX_DIR_ENTRIES} entries — read a subfolder, or use a glob such as {shown}/**/*.ts)"
            )
        } else {
            String::new()
        };
        return Ok(Section::text(format!(
            "--- {shown} — {} {}, one level ---\n{}{note}",
            entries.len(),
            entries_word(entries.len()),
            body.join("\n")
        )));
    }

    if info.kind != Kind::File {
        return Ok(Section::text(format!(
            "--- {shown} ---\n{}\nNot a regular file, so there is nothing to read.",
            disk::format_file_info(&info)
        )));
    }

    if !options.permissions.read {
        // Metadata is a real answer when that is exactly what the user granted.
        return Ok(Section::text(format!(
            "--- {shown} ---\n{}\n(file contents need the Read files permission)",
            disk::format_file_info(&info)
        )));
    }

    if IMAGE_EXTENSIONS.contains(&js::extension_lowercase(shown).as_str()) {
        return read_image(real, shown, options.image_budget);
    }

    // `info.binary` is only known from a content scan, which a reader with Read skips.
    let range = options.range;
    let read = match read_text_file(
        real,
        shown,
        range.map(|range| range.start),
        range.and_then(|range| range.end),
        Some(options.max_bytes),
    ) {
        Ok(read) => read,
        Err(TextError::Binary) => {
            info.binary = Some(true);
            return Ok(Section::text(format!(
                "--- {shown} ---\n{}\n{BINARY_NOTE}",
                disk::format_file_info(&info)
            )));
        }
        Err(TextError::Failed(failure)) => return Err(failure),
    };

    let has_line = read.last_line >= read.first_line;
    let detail = has_line.then(|| format!("lines {}–{}", read.first_line, read.last_line));
    let numbered = numbered_lines(&read.lines, read.first_line, has_line, options.max_bytes);
    let visible_last = numbered.last_line;
    let span = match (visible_last < read.first_line, read.total_lines) {
        (true, None) => "no lines in that range".to_owned(),
        (true, Some(total)) => format!("no lines in that range; the file has {total}"),
        (false, None) => format!("lines {}-{visible_last}", read.first_line),
        (false, Some(total)) => format!("lines {}-{visible_last} of {total}", read.first_line),
    };
    let note = if read.truncated || numbered.truncated {
        format!(
            "\n(output cap reached; continue from line {} or raise max_bytes up to {MAX_READ_BYTES})",
            visible_last + 1
        )
    } else if read.has_more {
        format!(
            "\n(more lines follow — continue from line {})",
            visible_last + 1
        )
    } else {
        String::new()
    };
    let header = format!(
        "--- {shown} — {span}, {}, modified {} ---",
        format_bytes(info.bytes),
        info.modified
    );
    let body = if numbered.text.is_empty() && visible_last < read.first_line {
        String::new()
    } else {
        format!("\n{}", numbered.text)
    };
    Ok(Section {
        detail,
        ..Section::text(format!("{header}{body}{note}"))
    })
}

fn entries_word(count: usize) -> &'static str {
    if count == 1 { "entry" } else { "entries" }
}

/// An image path through `read`: the same loader as `view_image`, with its own budget of
/// base64 per call, checked before decoding and again after.
fn read_image(real: &std::path::Path, shown: &str, budget: u64) -> Result<Section, Failure> {
    if budget == 0 {
        return Err(Failure::Internal(
            "Read image output cap reached; read remaining images in another call or use view_image.".to_owned(),
        ));
    }
    let image = view_image(real, shown).map_err(Failure::Refused)?;
    if image.base64.len() as u64 > budget {
        return Err(Failure::Internal(format!(
            "Read image output cap reached ({} base64 per call); read remaining images in another call or use view_image.",
            format_bytes(MAX_READ_IMAGE_BYTES)
        )));
    }
    let mime = image.mime.as_str();
    Ok(Section {
        image: Some((image.base64, mime)),
        ..Section::text(format!(
            "--- {shown} — {} {mime} ---",
            format_bytes(image.bytes)
        ))
    })
}

struct Numbered {
    text: String,
    last_line: u64,
    truncated: bool,
}

/// `boundedNumberedRead`: the `N\t` prefixes spend the same byte budget as the text, so many
/// short lines cannot inflate a bounded slice. The first line is always kept.
fn numbered_lines(lines: &[String], first_line: u64, has_line: bool, max_bytes: u64) -> Numbered {
    if !has_line {
        return Numbered {
            text: String::new(),
            last_line: first_line - 1,
            truncated: false,
        };
    }
    let mut text = String::new();
    let mut kept = 0u64;
    let mut bytes = 0u64;
    for (index, line) in lines.iter().enumerate() {
        let rendered = format!("{}\t{line}", first_line + index as u64);
        let cost = rendered.len() as u64 + u64::from(kept > 0);
        if kept > 0 && bytes + cost > max_bytes {
            break;
        }
        if kept > 0 {
            text.push('\n');
        }
        text.push_str(&rendered);
        kept += 1;
        bytes += cost;
    }
    Numbered {
        text,
        last_line: first_line + kept - 1,
        truncated: kept < lines.len() as u64,
    }
}

/// For a missing path, the approved root it names further down, or the nearest folder above it
/// that exists, listed. Empty unless one of them resolved.
fn nearest_folder_listing(roots: &Roots, requested: &str, failure: &Failure) -> String {
    if !failure.is_not_found() {
        return String::new();
    }
    if let Some(meant) = path_under_named_root(roots, requested) {
        return format!("\nDid you mean {meant}? It exists under the approved root of that name.");
    }
    let mut candidate = requested;
    for _ in 0..8 {
        let Some(parent) = parent_path(candidate) else {
            return String::new();
        };
        if parent.is_empty() || is_drive(parent) {
            return String::new();
        }
        candidate = parent;
        let resolved = match resolve(roots, candidate, Access::Read) {
            Ok(resolved) => resolved,
            Err(SandboxError::NotFound(_)) => continue,
            Err(_) => return String::new(),
        };
        let shown = resolved.virtual_path.as_str();
        let Ok((entries, truncated)) =
            disk::list_directory_level(&resolved.real, shown, MISSING_PATH_LISTING, false)
        else {
            return String::new();
        };
        if entries.is_empty() {
            return format!("\nThe nearest existing folder is {shown}, and it is empty.");
        }
        let names: Vec<String> = entries
            .iter()
            .map(|entry| {
                let kind = if entry.kind == Kind::Directory {
                    'd'
                } else {
                    'f'
                };
                format!("{kind} {}", entry.name)
            })
            .collect();
        let more = if truncated { ", …" } else { "" };
        return format!(
            "\nThe nearest existing folder is {shown}; it contains: {}{more}",
            names.join(", ")
        );
    }
    String::new()
}

fn is_separator(c: char) -> bool {
    c == '/' || c == '\\'
}

/// The path without its last segment and the separators before it, or `None` when it has no
/// separator before a last segment (`path.replace(/[\\/]+[^\\/]+[\\/]*$/, '')`).
fn parent_path(path: &str) -> Option<&str> {
    let trimmed = path.trim_end_matches(is_separator);
    let last = trimmed.rfind(is_separator)?;
    Some(trimmed[..last].trim_end_matches(is_separator))
}

fn is_drive(path: &str) -> bool {
    matches!(path.as_bytes(), [letter, b':'] if letter.is_ascii_alphabetic())
}

/// A missing path that names another approved root further down, where the rest exists.
fn path_under_named_root(roots: &Roots, requested: &str) -> Option<String> {
    let segments: Vec<&str> = requested
        .split(is_separator)
        .filter(|segment| !segment.is_empty())
        .collect();
    for index in 1..segments.len().saturating_sub(1) {
        let wanted = segments[index].to_lowercase();
        let Some(root) = roots
            .iter()
            .find(|root| root.name.as_str().to_lowercase() == wanted)
        else {
            continue;
        };
        let candidate = std::iter::once(root.name.as_str())
            .chain(segments[index + 1..].iter().copied())
            .collect::<Vec<_>>()
            .join("/");
        if let Ok(resolved) = resolve(roots, &format!("/{candidate}"), Access::Read) {
            return Some(resolved.virtual_path.as_str().to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{parent_path, split_line_range};

    #[test]
    fn a_line_range_suffix_is_split_off_but_a_drive_colon_is_not() {
        let (path, range) = split_line_range("/project/a.txt:3-4");
        assert_eq!(path, "/project/a.txt");
        let range = range.map(|range| (range.start, range.end));
        assert_eq!(range, Some((3, Some(4))));
        assert_eq!(split_line_range("/project/a.txt:48").0, "/project/a.txt");
        assert!(split_line_range("C:\\x").1.is_none());
        assert!(split_line_range("/project/a.txt:9-3").1.is_none());
        assert!(split_line_range("/project/a.txt:0").1.is_none());
        assert!(split_line_range("/project/:3").1.is_none());
        assert!(split_line_range("/project/a.txt:1234567890").1.is_none());
    }

    #[test]
    fn parent_drops_the_last_segment_and_its_separators() {
        assert_eq!(parent_path("/a/b/"), Some("/a"));
        assert_eq!(parent_path("//a"), Some(""));
        assert_eq!(parent_path("/project"), Some(""));
        assert_eq!(parent_path("abc"), None);
        assert_eq!(parent_path("///"), None);
    }
}
