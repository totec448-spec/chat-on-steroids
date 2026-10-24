//! `find`: file names and file contents, without a shell (`search.ts` and the `find` handler).
//!
//! Content search runs ripgrep's own engine in process: the `ignore` walker, `grep-searcher`
//! and `grep-regex`, configured as the bundled `rg` is with the flags `search.ts` passes. The
//! answers are the same and no process starts (see the crate README for the measurement).

use std::collections::VecDeque;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cos_fs::{Access, Glob, format_bytes, is_excluded_folder_name, resolve};
use cos_tools::{CallNotes, Grants, ToolError, ToolOutput, ToolResult};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkFinish, SinkMatch};
use ignore::WalkBuilder;
use ignore::overrides::{Override, OverrideBuilder};
use serde::Deserialize;

use crate::failure::Failure;
use crate::js;

/// Skipped unless the caller passes its own exclude list (`DEFAULT_EXCLUDES`).
pub(crate) const DEFAULT_EXCLUDES: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".gradle",
    ".gradle-user",
    ".idea",
    ".vs",
    ".vscode",
    "__pycache__",
    ".venv",
    "venv",
    "coverage",
    ".cache",
    ".turbo",
    ".go-build-cache",
    ".go-module-cache",
    ".go-tools",
    ".gopath",
    ".tmp",
    ".tmp-go-cache",
    ".tmp-go-path",
    ".android",
    ".bun",
    ".claude",
    ".claude-*",
    ".codex",
    ".cursor",
    ".gemini",
    ".npm",
    ".pnpm-store",
    ".yarn",
    "release",
    "release-*",
    "appdata",
];

/// Files above this are not content-searched, and the caller is told.
pub(crate) const MAX_CONTENT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES_SCANNED: u64 = 40_000;
const MAX_DIRECTORIES_SCANNED: u64 = 10_000;
const TIME_BUDGET: Duration = Duration::from_secs(10);
const MAX_LINE_UNITS: usize = 300;
/// What `rg` exits with for a pattern or glob it cannot compile; `search.ts` reports the code.
const ENGINE_REFUSED: &str = "ripgrep search failed (exit 2)";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FindMode {
    #[default]
    Name,
    Content,
}

/// One search, as `search.ts` receives it.
pub(crate) struct Query<'a> {
    pub text: &'a str,
    pub mode: FindMode,
    pub include: Option<&'a str>,
    pub case_sensitive: bool,
    pub regex: bool,
    pub max_results: usize,
    pub deadline: Instant,
}

pub(crate) struct Hit {
    pub path: String,
    pub line: Option<(u64, String)>,
}

impl Hit {
    pub(crate) fn render(&self) -> String {
        match &self.line {
            Some((number, text)) => format!("{}:{number}: {text}", self.path),
            None => self.path.clone(),
        }
    }
}

/// Why a search stopped early (`stoppedBecause`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stop {
    Limit,
    Time,
    Files,
    Size,
}

impl Stop {
    fn as_str(self) -> &'static str {
        match self {
            Self::Limit => "limit",
            Self::Time => "time",
            Self::Files => "files",
            Self::Size => "size",
        }
    }
}

#[derive(Default)]
pub(crate) struct Outcome {
    pub hits: Vec<Hit>,
    pub files_scanned: u64,
    pub stopped: Option<Stop>,
}

pub(crate) fn find(grants: &Grants, args: crate::FindArgs) -> Result<ToolOutput, ToolError> {
    let started = Instant::now();
    let query = Query {
        text: &args.query,
        mode: args.mode.unwrap_or_default(),
        include: args.include.as_deref(),
        case_sensitive: args.case_sensitive == Some(true),
        regex: args.regex == Some(true),
        max_results: args
            .max_results
            .map_or(50, |max| max as usize)
            .clamp(1, 500),
        deadline: started + TIME_BUDGET,
    };
    let roots = &grants.roots;
    let mut scopes = Vec::new();
    if let Some(path) = &args.path {
        let resolved = resolve(roots, path, Access::Read)?;
        let meta = fs::metadata(&resolved.real).map_err(|error| ToolError::from_io(&error))?;
        let shown = resolved.virtual_path.as_str();
        if meta.is_file() {
            let outcome = search_file(&resolved.real, shown, &query).map_err(ToolError::from)?;
            if outcome.stopped == Some(Stop::Size) {
                return Err(ToolError::Refused(format!(
                    "File was not searched: content search skips files over {}. Narrow it with read start_line/end_line, or use exec_command when command execution is available.",
                    format_bytes(MAX_CONTENT_FILE_BYTES)
                )));
            }
            let hits: Vec<String> = outcome.hits.iter().map(Hit::render).collect();
            let text = if hits.is_empty() {
                "No matches".to_owned()
            } else {
                format!("{} matches\n{}", hits.len(), hits.join("\n"))
            };
            return Ok(answer(text, hits.len()));
        }
        if !meta.is_dir() {
            return Err(ToolError::Refused(format!(
                "{shown} is not a regular file or folder"
            )));
        }
        scopes.push(resolved);
    } else {
        for root in roots.iter() {
            scopes.push(resolve(
                roots,
                &format!("/{}", root.name.as_str()),
                Access::Read,
            )?);
        }
    }
    if scopes.is_empty() {
        return Err(ToolError::Refused("No folders are approved".to_owned()));
    }

    let exclude: Vec<&str> = match &args.exclude {
        Some(list) => list.iter().map(String::as_str).collect(),
        None => DEFAULT_EXCLUDES.to_vec(),
    };
    let mut hits: Vec<String> = Vec::new();
    let mut stops: Vec<Stop> = Vec::new();
    let mut scanned = 0;
    let mut elapsed_ms = 0;
    for scope in &scopes {
        if Instant::now() >= query.deadline {
            push_unique(&mut stops, Stop::Time);
            break;
        }
        if hits.len() >= query.max_results {
            break;
        }
        let scope_started = Instant::now();
        let remaining = Query {
            max_results: query.max_results - hits.len(),
            ..query
        };
        let outcome = search_dir(
            &scope.real,
            scope.virtual_path.as_str(),
            &remaining,
            &exclude,
        )
        .map_err(ToolError::from)?;
        scanned += outcome.files_scanned;
        elapsed_ms += scope_started.elapsed().as_millis();
        if let Some(stop) = outcome.stopped {
            push_unique(&mut stops, stop);
        }
        hits.extend(outcome.hits.iter().map(Hit::render));
    }
    let reason = if stops.is_empty() {
        String::new()
    } else {
        let names: Vec<&str> = stops.iter().map(|stop| stop.as_str()).collect();
        format!("\ntruncated: {}", names.join(","))
    };
    let content_limit = if query.mode == FindMode::Content {
        format!(
            "\ncontent_file_limit: {}",
            format_bytes(MAX_CONTENT_FILE_BYTES)
        )
    } else {
        String::new()
    };
    let meta = format!(
        "\n\nfiles_scanned: {scanned}\nelapsed_ms: {elapsed_ms}\nresults_returned: {}{content_limit}{reason}",
        hits.len()
    );
    let text = if hits.is_empty() {
        format!("No matches{meta}")
    } else {
        format!("{} matches\n{}{meta}", hits.len(), hits.join("\n"))
    };
    Ok(answer(text, hits.len()))
}

/// The answer, with the number of hits for the session summary (`noteCount`).
fn answer(text: String, hits: usize) -> ToolOutput {
    ToolOutput {
        result: ToolResult::text(text),
        notes: CallNotes {
            count: Some(hits as u64),
            ..CallNotes::default()
        },
    }
}

/// A `Set` of stop reasons in insertion order.
fn push_unique(stops: &mut Vec<Stop>, stop: Stop) {
    if !stops.contains(&stop) {
        stops.push(stop);
    }
}

/// `compileIncludeMatcher`: a pattern without a slash also matches the bare file name.
fn include_matches(glob: &Glob, slash_free: bool, relative: &str) -> bool {
    glob.is_match(relative)
        || (slash_free && glob.is_match(relative.rsplit('/').next().unwrap_or(relative)))
}

/// `search`: one folder, by name or by content.
pub(crate) fn search_dir(
    real: &Path,
    shown: &str,
    query: &Query<'_>,
    exclude: &[&str],
) -> Result<Outcome, Failure> {
    match query.mode {
        FindMode::Content => search_content(real, shown, query, exclude),
        FindMode::Name => Ok(search_names(real, shown, query, exclude)),
    }
}

/// The breadth-first name walk of `search.ts`, in the order the OS lists each folder.
fn search_names(real: &Path, shown: &str, query: &Query<'_>, exclude: &[&str]) -> Outcome {
    let mut outcome = Outcome::default();
    let needle = case(query.text, query.case_sensitive);
    let include = query.include.map(|pattern| {
        (
            Glob::new(pattern, query.case_sensitive),
            !pattern.contains('/'),
        )
    });
    let mut pending: VecDeque<(PathBuf, String)> =
        VecDeque::from([(real.to_path_buf(), String::new())]);
    let mut directories = 0;
    let out_of_budget = |outcome: &mut Outcome| {
        if Instant::now() > query.deadline {
            outcome.stopped = Some(Stop::Time);
            return true;
        }
        if outcome.files_scanned >= MAX_FILES_SCANNED {
            outcome.stopped = Some(Stop::Files);
            return true;
        }
        false
    };
    'folders: while !pending.is_empty() && !out_of_budget(&mut outcome) {
        if directories >= MAX_DIRECTORIES_SCANNED {
            outcome.stopped = Some(Stop::Files);
            break;
        }
        let Some((dir, relative)) = pending.pop_front() else {
            break;
        };
        directories += 1;
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries {
            if out_of_budget(&mut outcome) {
                break;
            }
            let Ok(entry) = entry else {
                break;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            if file_type.is_dir() {
                if !is_excluded_folder_name(&name, exclude) {
                    pending.push_back((entry.path(), child));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            outcome.files_scanned += 1;
            if let Some((glob, slash_free)) = &include
                && !include_matches(glob, *slash_free, &child)
            {
                continue;
            }
            if case(&name, query.case_sensitive).contains(&needle) {
                outcome.hits.push(Hit {
                    path: format!("{shown}/{child}"),
                    line: None,
                });
                if outcome.hits.len() >= query.max_results {
                    outcome.stopped = Some(Stop::Limit);
                    break 'folders;
                }
            }
        }
    }
    outcome
}

fn case(text: &str, sensitive: bool) -> String {
    if sensitive {
        text.to_owned()
    } else {
        text.to_lowercase()
    }
}

/// `searchOneFile`: one named file. Include filters apply to it even though `rg` ignores them
/// for an explicit path, and an oversized file is reported as not searched.
pub(crate) fn search_file(real: &Path, shown: &str, query: &Query<'_>) -> Result<Outcome, Failure> {
    let name = shown.rsplit('/').next().unwrap_or(shown);
    if let Some(pattern) = query.include
        && !include_matches(
            &Glob::new(pattern, query.case_sensitive),
            !pattern.contains('/'),
            name,
        )
    {
        return Ok(Outcome {
            files_scanned: 1,
            ..Outcome::default()
        });
    }
    match query.mode {
        FindMode::Name => {
            let found =
                case(name, query.case_sensitive).contains(&case(query.text, query.case_sensitive));
            Ok(Outcome {
                hits: if found {
                    vec![Hit {
                        path: shown.to_owned(),
                        line: None,
                    }]
                } else {
                    Vec::new()
                },
                files_scanned: 1,
                stopped: None,
            })
        }
        FindMode::Content => {
            if fs::metadata(real).is_ok_and(|meta| meta.len() > MAX_CONTENT_FILE_BYTES) {
                return Ok(Outcome {
                    stopped: Some(Stop::Size),
                    ..Outcome::default()
                });
            }
            let matcher = matcher(query)?;
            let mut searcher = searcher(BinaryDetection::convert(b'\0'));
            let mut outcome = Outcome::default();
            let mut sink = Collect {
                shown,
                query,
                outcome: &mut outcome,
            };
            if searcher.search_path(&matcher, real, &mut sink).is_err() {
                return Err(Failure::Internal(ENGINE_REFUSED.to_owned()));
            }
            Ok(outcome)
        }
    }
}

/// `rg --json --line-number --hidden --no-ignore --max-filesize 2097152 [--ignore-case]
/// [--fixed-strings] [--iglob include] --iglob !**/<exclude>/** -- <query> .`, in process.
fn search_content(
    real: &Path,
    shown: &str,
    query: &Query<'_>,
    exclude: &[&str],
) -> Result<Outcome, Failure> {
    let mut outcome = Outcome::default();
    if Instant::now() >= query.deadline {
        outcome.stopped = Some(Stop::Time);
        return Ok(outcome);
    }
    let matcher = matcher(query)?;
    let overrides = include_override(real, query)?;
    let mut searcher = searcher(BinaryDetection::quit(b'\0'));
    // `search.ts` passed each exclude as `--iglob !**/<name>/**`, which ignores everything
    // inside a folder of that name. Not entering the folder gives the same files without
    // compiling forty globs per search.
    let exclude: Vec<String> = exclude.iter().map(|name| (*name).to_owned()).collect();
    let walker = WalkBuilder::new(real)
        .standard_filters(false)
        .follow_links(false)
        .max_filesize(Some(MAX_CONTENT_FILE_BYTES))
        .overrides(overrides)
        .filter_entry(move |entry| {
            entry.depth() == 0
                || !entry.file_type().is_some_and(|kind| kind.is_dir())
                || !is_excluded_folder_name(&entry.file_name().to_string_lossy(), &exclude)
        })
        .build();
    for entry in walker {
        if outcome.stopped.is_some() {
            break;
        }
        if Instant::now() >= query.deadline {
            outcome.stopped = Some(Stop::Time);
            break;
        }
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(real)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        let shown_file = format!("{shown}/{relative}");
        let mut sink = Collect {
            shown: &shown_file,
            query,
            outcome: &mut outcome,
        };
        // An unreadable file is skipped, as `rg` reports it on stderr and goes on.
        let _ = searcher.search_path(&matcher, entry.path(), &mut sink);
    }
    Ok(outcome)
}

fn matcher(query: &Query<'_>) -> Result<RegexMatcher, Failure> {
    RegexMatcherBuilder::new()
        .multi_line(true)
        .unicode(true)
        .octal(false)
        .fixed_strings(!query.regex)
        .case_insensitive(!query.case_sensitive)
        .line_terminator(Some(b'\n'))
        .dot_matches_new_line(false)
        .ban_byte(Some(b'\0'))
        .build(query.text)
        .map_err(|_| Failure::Internal(ENGINE_REFUSED.to_owned()))
}

fn searcher(binary: BinaryDetection) -> Searcher {
    SearcherBuilder::new()
        .line_number(true)
        .binary_detection(binary)
        .build()
}

/// The include glob as `rg --iglob` (or `--glob` when case matters) applies it.
fn include_override(real: &Path, query: &Query<'_>) -> Result<Override, Failure> {
    let Some(include) = query.include else {
        return Ok(Override::empty());
    };
    let refused = |_| Failure::Internal(ENGINE_REFUSED.to_owned());
    let mut builder = OverrideBuilder::new(real);
    builder
        .case_insensitive(!query.case_sensitive)
        .map_err(refused)?;
    builder.add(&include_glob(include)).map_err(refused)?;
    builder.build().map_err(refused)
}

/// `ripgrepIncludeGlob`: only `*`, `?` and `/` keep a meaning; ripgrep's other glob syntax is
/// literal, as in the connector's own matcher.
fn include_glob(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    for c in pattern.chars() {
        if matches!(c, '\\' | '[' | ']' | '{' | '}' | '!') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The JSON printer's `match` events, as `search.ts` read them: one hit per matching line, the
/// line without its terminator, trimmed and cut at 300 UTF-16 units. A line that is not UTF-8
/// arrives as `bytes`, which `search.ts` turns into empty text.
struct Collect<'a, 'q> {
    shown: &'a str,
    query: &'a Query<'q>,
    outcome: &'a mut Outcome,
}

impl Sink for Collect<'_, '_> {
    type Error = io::Error;

    fn matched(&mut self, _: &Searcher, found: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if Instant::now() >= self.query.deadline {
            self.outcome.stopped = Some(Stop::Time);
            return Ok(false);
        }
        let text = std::str::from_utf8(found.bytes()).map_or(String::new(), line_text);
        self.outcome.hits.push(Hit {
            path: self.shown.to_owned(),
            line: found.line_number().map(|number| (number, text)),
        });
        if self.outcome.hits.len() >= self.query.max_results {
            self.outcome.stopped = Some(Stop::Limit);
            return Ok(false);
        }
        Ok(true)
    }

    fn finish(&mut self, _: &Searcher, _: &SinkFinish) -> Result<(), io::Error> {
        self.outcome.files_scanned += 1;
        Ok(())
    }
}

fn line_text(line: &str) -> String {
    let line = line.strip_suffix('\n').unwrap_or(line);
    let line = line.strip_suffix('\r').unwrap_or(line);
    let trimmed = js::trim(line);
    if js::utf16_len(trimmed) > MAX_LINE_UNITS {
        format!("{}…", js::utf16_prefix(trimmed, MAX_LINE_UNITS))
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{include_glob, line_text};

    #[test]
    fn globs_are_translated_as_search_ts_does() {
        assert_eq!(include_glob("**/[a]{b}!.ts"), "**/\\[a\\]\\{b\\}\\!.ts");
    }

    #[test]
    fn a_long_line_is_trimmed_and_cut() {
        assert_eq!(line_text("  x  \r\n"), "x");
        let long = "y".repeat(400);
        assert_eq!(line_text(&long), format!("{}…", "y".repeat(300)));
    }
}
