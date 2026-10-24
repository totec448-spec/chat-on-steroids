//! The filesystem primitives `read` stands on (`codex/filesystem.ts` and the listing, walk and
//! stat halves of `codex/read-backend.ts`). Every path here is already resolved by `cos-fs`.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{MAIN_SEPARATOR, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use cos_fs::{BINARY_SNIFF_BYTES, MAX_READ_BYTES, format_bytes, sniff_binary_bytes};

use crate::js;

/// `FILE_READ_CHUNK_SIZE`.
pub(crate) const CHUNK_BYTES: usize = 1024 * 1024;
/// Above this a file's line count is not worth a full scan (`MAX_LINE_COUNT_BYTES`).
pub(crate) const MAX_LINE_COUNT_BYTES: u64 = MAX_READ_BYTES * 8;

const MAX_WALK_DEPTH: usize = 64;
const MAX_WALK_DIRECTORIES: usize = 10_000;
const MAX_WALK_ENTRIES: usize = 50_000;
const MAX_WALK_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const WALK_RESPONSE_ITEM_OVERHEAD_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Directory,
    File,
    Other,
}

/// `FileMetadata`: the link itself, then its target when it is one.
pub(crate) struct Metadata {
    pub kind: Kind,
    pub is_symlink: bool,
    pub size: u64,
    pub created_ms: u64,
    pub modified_ms: u64,
}

fn kind_of(file_type: fs::FileType) -> Kind {
    if file_type.is_dir() {
        Kind::Directory
    } else if file_type.is_file() {
        Kind::File
    } else {
        Kind::Other
    }
}

/// `system_time_to_unix_ms`: a time before the epoch or one the OS cannot give is zero.
fn unix_ms(time: io::Result<SystemTime>) -> u64 {
    time.ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// `getMetadata`.
pub(crate) fn metadata(path: &Path) -> io::Result<Metadata> {
    let link = fs::symlink_metadata(path)?;
    let is_symlink = link.file_type().is_symlink();
    let target = if is_symlink {
        fs::metadata(path)?
    } else {
        link
    };
    Ok(Metadata {
        kind: kind_of(target.file_type()),
        is_symlink,
        size: target.len(),
        created_ms: unix_ms(target.created()),
        modified_ms: unix_ms(target.modified()),
    })
}

/// `Date.prototype.toISOString` of epoch milliseconds.
pub(crate) fn iso_time(ms: u64) -> String {
    let (seconds, millis) = (ms / 1000, ms % 1000);
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    // Howard Hinnant's civil_from_days, for days since 1970-01-01.
    let z = i64::try_from(days).unwrap_or(i64::MAX / 2) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// One child of a folder. A link is neither a folder nor a file here: classifying it would read
/// metadata of a target that has not passed the sandbox (`readDirectory`).
pub(crate) struct Child {
    pub name: String,
    pub kind: Kind,
}

/// `readDirectory`.
pub(crate) fn read_directory(path: &Path) -> io::Result<Vec<Child>> {
    let mut children = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        children.push(Child {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: if file_type.is_symlink() {
                Kind::Other
            } else {
                kind_of(file_type)
            },
        });
    }
    Ok(children)
}

pub(crate) struct Listed {
    pub name: String,
    pub virtual_path: String,
    pub kind: Kind,
    pub bytes: Option<u64>,
}

/// `listDirectoryLevel`: folders first, then names in `localeCompare` order.
pub(crate) fn list_directory_level(
    real: &Path,
    virtual_dir: &str,
    max_entries: usize,
    include_file_sizes: bool,
) -> io::Result<(Vec<Listed>, bool)> {
    let mut children = read_directory(real)?;
    children.sort_by(|left, right| {
        let rank = |child: &Child| u8::from(child.kind != Kind::Directory);
        rank(left)
            .cmp(&rank(right))
            .then_with(|| js::locale_compare(&left.name, &right.name))
    });
    let truncated = children.len() > max_entries;
    children.truncate(max_entries);
    let listed = children
        .into_iter()
        .map(|child| {
            let bytes = (include_file_sizes && child.kind == Kind::File)
                .then(|| metadata(&real.join(&child.name)).ok().map(|meta| meta.size))
                .flatten();
            Listed {
                virtual_path: format!("{virtual_dir}/{}", child.name),
                name: child.name,
                kind: child.kind,
                bytes,
            }
        })
        .collect();
    Ok((listed, truncated))
}

/// What a bounded walk spends its 4 MiB response budget on (`reserve_walk_response_bytes`).
struct Budget {
    used: usize,
    truncated: bool,
}

impl Budget {
    fn reserve(&mut self, content_bytes: usize) -> bool {
        let total = self.used + content_bytes + WALK_RESPONSE_ITEM_OVERHEAD_BYTES;
        if total > MAX_WALK_RESPONSE_BYTES {
            self.truncated = true;
            return false;
        }
        self.used = total;
        true
    }
}

fn path_bytes(path: &Path) -> usize {
    path.as_os_str().len()
}

/// Every file below `real` as a virtual path, for glob expansion (`walkFiles` over Codex's
/// breadth-first `walk`, never following a link). Folders named in `exclude` are listed but not
/// entered. The second value says a limit stopped the walk.
pub(crate) fn walk_files(
    real: &Path,
    virtual_dir: &str,
    max_entries: usize,
    exclude: &[&str],
) -> io::Result<(Vec<String>, bool)> {
    let max_entries = max_entries.clamp(1, MAX_WALK_ENTRIES);
    let root = metadata(real)?;
    if root.kind != Kind::Directory || root.is_symlink {
        return Ok((Vec::new(), false));
    }
    let mut files = Vec::new();
    let mut budget = Budget {
        used: 0,
        truncated: false,
    };
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(real.to_path_buf(), 0)]);
    let mut directories = 1;
    let mut entries_seen = 0;
    while let Some((directory, depth)) = queue.pop_front() {
        let mut children = match read_directory(&directory) {
            Ok(children) => children,
            Err(error) => {
                if !budget.reserve(path_bytes(&directory) + error.to_string().len()) {
                    return Ok((files, true));
                }
                continue;
            }
        };
        children.sort_by(|left, right| js::utf16_cmp(&left.name, &right.name));
        for child in children {
            if entries_seen == max_entries {
                return Ok((files, true));
            }
            entries_seen += 1;
            let path = directory.join(&child.name);
            let meta = match metadata(&path) {
                Ok(meta) => meta,
                Err(error) => {
                    if !budget.reserve(path_bytes(&path) + error.to_string().len()) {
                        return Ok((files, true));
                    }
                    continue;
                }
            };
            if meta.is_symlink || meta.kind == Kind::Other {
                continue;
            }
            if !budget.reserve(path_bytes(&path)) {
                return Ok((files, true));
            }
            if meta.kind == Kind::File {
                files.push(virtual_child(real, virtual_dir, &path));
                continue;
            }
            if cos_fs::is_excluded_folder_name(&child.name, exclude) {
                continue;
            }
            // The folder itself counts, but its children were not inspected, so the walk is
            // reported as stopped rather than complete.
            if depth >= MAX_WALK_DEPTH {
                budget.truncated = true;
                continue;
            }
            if directories == MAX_WALK_DIRECTORIES {
                budget.truncated = true;
            } else {
                directories += 1;
                queue.push_back((path, depth + 1));
            }
        }
    }
    Ok((files, budget.truncated))
}

fn virtual_child(real_root: &Path, virtual_dir: &str, path: &Path) -> String {
    let relative = path
        .strip_prefix(real_root)
        .unwrap_or(path)
        .to_string_lossy()
        .split(MAIN_SEPARATOR)
        .collect::<Vec<_>>()
        .join("/");
    format!("{virtual_dir}/{relative}")
}

/// `regular_file::open`: a handle that is known to be a regular file.
pub(crate) fn open_regular_file(path: &Path, shown: &str) -> io::Result<(File, u64)> {
    let file = File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path `{shown}` is not a file"),
        ));
    }
    Ok((file, meta.len()))
}

/// One `read` into `buffer` that retries on interruption, like Node's `handle.read`.
pub(crate) fn read_chunk(file: &mut File, buffer: &mut [u8]) -> io::Result<usize> {
    loop {
        match file.read(buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            other => return other,
        }
    }
}

/// `FileInfo`, the header `read` prints for a path it does not return as text.
pub(crate) struct FileInfo {
    pub virtual_path: String,
    pub kind: Kind,
    pub bytes: u64,
    pub modified: String,
    pub created: String,
    pub binary: Option<bool>,
    pub lines: Option<u64>,
}

/// `statInfo`. With `scan_content`, one pass over a file learns whether it is binary and, when
/// it is small enough, how many lines it has.
pub(crate) fn stat_info(
    real: &Path,
    virtual_path: &str,
    scan_content: bool,
) -> io::Result<FileInfo> {
    let meta = metadata(real)?;
    let mut info = FileInfo {
        virtual_path: virtual_path.to_owned(),
        kind: meta.kind,
        bytes: meta.size,
        modified: iso_time(meta.modified_ms),
        created: iso_time(meta.created_ms),
        binary: None,
        lines: None,
    };
    if meta.kind == Kind::File && scan_content {
        let (binary, lines) = scan_file(real, virtual_path, meta.size <= MAX_LINE_COUNT_BYTES)?;
        info.binary = Some(binary);
        info.lines = lines;
    }
    Ok(info)
}

/// `scanFile`: newline bytes counted in the raw stream, as TypeScript counts them.
fn scan_file(real: &Path, shown: &str, want_lines: bool) -> io::Result<(bool, Option<u64>)> {
    let (mut file, _) = open_regular_file(real, shown)?;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    let mut sniffed = false;
    let mut lines = 0u64;
    let mut saw_any = false;
    let mut ends_with_newline = true;
    loop {
        let read = read_chunk(&mut file, &mut buffer)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        if !sniffed {
            sniffed = true;
            if sniff_binary_bytes(&chunk[..chunk.len().min(BINARY_SNIFF_BYTES)]) {
                return Ok((true, None));
            }
            if !want_lines {
                return Ok((false, None));
            }
        }
        saw_any = true;
        lines += chunk.iter().filter(|&&byte| byte == b'\n').count() as u64;
        ends_with_newline = chunk.last() == Some(&b'\n');
    }
    if !want_lines {
        return Ok((false, None));
    }
    if !saw_any {
        return Ok((false, Some(0)));
    }
    Ok((
        false,
        Some(if ends_with_newline { lines } else { lines + 1 }),
    ))
}

/// `formatFileInfo`.
pub(crate) fn format_file_info(info: &FileInfo) -> String {
    let kind = match info.kind {
        Kind::Directory => "directory",
        Kind::File => "file",
        Kind::Other => "other",
    };
    let mut lines = vec![
        format!("path: {}", info.virtual_path),
        format!("type: {kind}"),
        format!("size: {}", format_bytes(info.bytes)),
        format!("modified: {}", info.modified),
        format!("created: {}", info.created),
    ];
    if let Some(binary) = info.binary {
        lines.push(format!("binary: {binary}"));
    }
    if let Some(count) = info.lines {
        lines.push(format!("lines: {count}"));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::iso_time;

    #[test]
    fn iso_time_matches_to_iso_string() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(951_782_400_123), "2000-02-29T00:00:00.123Z");
        assert_eq!(iso_time(1_792_454_400_000), "2026-10-20T00:00:00.000Z");
    }
}
