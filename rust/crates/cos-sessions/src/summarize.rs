//! One tool call as one line a person can read (`src/main/session/summarize.ts`).
//!
//! A pure function of the arguments, the notes the tool reported and the outcome.

use cos_tools::{CallNotes, ProcessNotes};
use cos_types::json::Extra;
use cos_types::session::{ActivityKind, ActivitySummary, ActivityTone, FileChange, ToolOutcome};
use serde_json::{Map, Value};

use crate::js;

/// A call with no process notes summarizes as `emptyEvidence()` does.
const NO_PROCESS: ProcessNotes = ProcessNotes {
    exit_code: None,
    running: None,
    timed_out: false,
    benign_exit: false,
    duration_ms: None,
    session_id: None,
};

pub(crate) struct SummaryInput<'a> {
    pub tool: &'a str,
    pub args: &'a Value,
    pub notes: &'a CallNotes,
    pub outcome: ToolOutcome,
    pub duration_ms: f64,
    /// First line of the result, used only where nothing better exists.
    pub result_head: &'a str,
}

fn summary(kind: ActivityKind, tone: ActivityTone, title: impl Into<String>) -> ActivitySummary {
    ActivitySummary {
        title: title.into(),
        detail: None,
        metric: None,
        tone,
        kind,
        extra: Extra::new(),
    }
}

fn with_detail(mut entry: ActivitySummary, detail: Option<String>) -> ActivitySummary {
    entry.detail = detail;
    entry
}

fn with_metric(mut entry: ActivitySummary, metric: Option<String>) -> ActivitySummary {
    entry.metric = metric;
    entry
}

/// `shortPath`: drops the virtual root segment.
pub(crate) fn short_path(virtual_path: &str) -> String {
    let parts: Vec<&str> = virtual_path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() <= 1 {
        return format!("/{}", parts.join("/"));
    }
    parts[1..].join("/")
}

fn format_duration(ms: f64) -> String {
    if ms < 1000.0 {
        format!("{}ms", js::number_text(js::round(ms)))
    } else if ms < 60_000.0 {
        format!("{}s", js::to_fixed_1(ms / 1000.0))
    } else {
        format!("{}m", js::number_text(js::round(ms / 60_000.0)))
    }
}

fn plural(count: usize, one: &str, many: Option<&str>) -> String {
    if count == 1 {
        format!("{count} {one}")
    } else {
        match many {
            Some(many) => format!("{count} {many}"),
            None => format!("{count} {one}s"),
        }
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);

fn record(value: Option<&Value>) -> &Map<String, Value> {
    value.and_then(Value::as_object).unwrap_or(&EMPTY)
}

/// `formatDelta`.
fn format_delta(added: u64, removed: u64) -> Option<String> {
    let mut parts = Vec::new();
    if added > 0 {
        parts.push(format!("+{added}"));
    }
    if removed > 0 {
        parts.push(format!("\u{2212}{removed}"));
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn total_delta(changes: &[FileChange]) -> Option<String> {
    if changes.is_empty() {
        return None;
    }
    let added = changes.iter().map(|change| change.added).sum();
    let removed = changes.iter().map(|change| change.removed).sum();
    let text = format_delta(added, removed)?;
    Some(if changes.iter().any(|change| change.approximate) {
        format!("~{text}")
    } else {
        text
    })
}

/// "lines 200–420" becomes "221 lines".
fn line_range_metric(detail: Option<&str>) -> Option<String> {
    static RANGE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^lines\s+([0-9]+)[\x{2013}-]([0-9]+)(?:\s+of\s+[0-9]+)?$")
            .unwrap_or_else(|error| panic!("line range pattern: {error}"))
    });
    let found = RANGE.captures(js::trim(detail?))?;
    let first: f64 = found.get(1)?.as_str().parse().ok()?;
    let last: f64 = found.get(2)?.as_str().parse().ok()?;
    let safe = 9_007_199_254_740_991.0;
    if first > safe || last > safe || last < first {
        return None;
    }
    Some(plural((last - first + 1.0) as usize, "line", None))
}

fn script_label(script: Option<&str>) -> String {
    let Some(script) = script else {
        return "a command".into();
    };
    let lines: Vec<&str> = script
        .split('\n')
        .map(|line| js::trim(line.strip_suffix('\r').unwrap_or(line)))
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    let first = lines
        .first()
        .map(|line| collapse_space(line))
        .unwrap_or_default();
    if first.is_empty() {
        return "a command".into();
    }
    let shown = js::prefix(&first, 70);
    if lines.len() > 1 || shown.len() < first.len() {
        format!("{shown} \u{2026}")
    } else {
        shown.to_owned()
    }
}

/// `replace(/\s+/g, ' ')`.
fn collapse_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if js::is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

fn file_title(verb: &str, changes: &[FileChange]) -> String {
    match changes {
        [one] => format!("{verb} {}", short_path(&one.path)),
        [] => verb.to_owned(),
        many => format!("{verb} {}", plural(many.len(), "file", None)),
    }
}

/// Past tense to plain infinitive, for the titles of calls that did not happen.
fn undone(verb: &str) -> Option<&'static str> {
    Some(match verb {
        "Edited" => "edit",
        "Applied" => "apply",
        "Rewrote" => "rewrite",
        "Appended" => "append",
        "Created" => "create",
        "Saved" => "save",
        "Interrupted" => "interrupt",
        "Filled" => "fill",
        "Wrote" => "write",
        "Moved" => "move",
        "Deleted" => "delete",
        "Read" => "read",
        "Viewed" => "view",
        "Inspected" => "inspect",
        "Listed" => "list",
        "Searched" => "search",
        "Checked" => "check",
        "Ran" => "run",
        "Launched" => "launch",
        "Started" => "start",
        "Stopped" => "stop",
        "Opened" => "open",
        "Looked" => "look",
        "Waited" => "wait",
        "Clicked" => "click",
        "Double-clicked" => "double-click",
        "Dragged" => "drag",
        "Scrolled" => "scroll",
        "Typed" => "type",
        "Pressed" => "press",
        "Focused" => "focus",
        "Acted" => "act",
        "Replaced" => "replace",
        "Loaded" => "load",
        "Messaged" => "message",
        "Reported" => "report",
        "Requested" => "request",
        _ => return None,
    })
}

fn undo_title(title: &str, refused: bool) -> String {
    let negative = ["Could not", "Refused", "Failed", "Command failed"]
        .iter()
        .any(|lead| {
            title.strip_prefix(lead).is_some_and(|rest| {
                rest.chars()
                    .next()
                    .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
            })
        });
    if negative {
        return title.to_owned();
    }
    let lead = if refused { "Refused to" } else { "Could not" };
    let (first, rest) = match title.find(' ') {
        Some(space) => (&title[..space], &title[space..]),
        None => (title, ""),
    };
    match undone(first) {
        Some(verb) => format!("{lead} {verb}{rest}"),
        None => format!("{}: {title}", if refused { "Refused" } else { "Failed" }),
    }
}

/// `summarizeToolCall`.
pub(crate) fn summarize(input: &SummaryInput<'_>) -> ActivitySummary {
    let args = record(Some(input.args));
    let changes = &input.notes.changes;
    let built = build(input.tool, args, input.notes, changes, input.duration_ms);
    if matches!(
        input.outcome,
        ToolOutcome::Ok | ToolOutcome::ProcessExitNonzero
    ) {
        return built;
    }
    let refused = input.outcome == ToolOutcome::ToolRejected;
    let head = js::trim(input.result_head);
    let patch_mismatch = refused
        && input.tool == "apply_patch"
        && changes.is_empty()
        && head
            .strip_prefix("apply_patch verification failed: Failed to find ")
            .is_some_and(|rest| {
                rest.starts_with("expected lines in ")
                    || rest.starts_with("context in ")
                    || rest.starts_with("context '")
            });
    let mut failed = built;
    failed.tone = if input.outcome == ToolOutcome::ToolInternalError {
        ActivityTone::Bad
    } else {
        ActivityTone::Warn
    };
    failed.title = if patch_mismatch {
        "Patch didn\u{2019}t match".into()
    } else if input.outcome == ToolOutcome::ToolExecutionError {
        format!("Tool {} failed", input.tool)
    } else {
        undo_title(&failed.title, refused)
    };
    if patch_mismatch {
        failed.metric = Some("not applied".into());
    } else if refused {
        failed.metric = Some("refused".into());
    } else if !failed
        .metric
        .as_deref()
        .is_some_and(|metric| !metric.is_empty() && metric.starts_with('\u{2715}'))
    {
        failed.metric = Some("\u{2715} failed".into());
    }
    if !head.is_empty() && failed.detail.as_deref().is_none_or(str::is_empty) {
        failed.detail = Some(js::prefix(head, 120).to_owned());
    }
    failed
}

fn build(
    tool: &str,
    args: &Map<String, Value>,
    notes: &CallNotes,
    changes: &[FileChange],
    duration_ms: f64,
) -> ActivitySummary {
    use ActivityKind as Kind;
    use ActivityTone as Tone;
    let count = notes.count.map(|count| count as usize);
    let process = notes.process.as_ref().unwrap_or(&NO_PROCESS);
    match tool {
        "read" => {
            let paths: Vec<String> = array(args.get("paths"))
                .iter()
                .map(|path| match path {
                    Value::String(text) => text.clone(),
                    other => js::stringify(other),
                })
                .collect();
            let start = number(args.get("start_line")).filter(|start| *start != 0.0);
            let end = number(args.get("end_line")).filter(|end| *end != 0.0);
            let range = (paths.len() == 1)
                .then(|| {
                    notes.detail.clone().or_else(|| match (start, end) {
                        (Some(start), Some(end)) => Some(format!(
                            "lines {}\u{2013}{}",
                            js::number_text(start),
                            js::number_text(end)
                        )),
                        (Some(start), None) => {
                            Some(format!("from line {}", js::number_text(start)))
                        }
                        _ => None,
                    })
                })
                .flatten();
            let metric = line_range_metric(range.as_deref());
            let multi = match paths.len() {
                0 | 1 => None,
                2 | 3 => Some(
                    paths
                        .iter()
                        .map(|path| short_path(path))
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
                many => Some(format!(
                    "{} +{} more",
                    paths[..2]
                        .iter()
                        .map(|path| short_path(path))
                        .collect::<Vec<_>>()
                        .join(", "),
                    many - 2
                )),
            };
            let title = match paths.as_slice() {
                [first] if !first.is_empty() => format!("Read {}", short_path(first)),
                _ => format!("Read {}", plural(paths.len(), "path", None)),
            };
            let detail = range.filter(|range| !range.is_empty()).or(multi);
            with_metric(
                with_detail(summary(Kind::Read, Tone::Neutral, title), detail),
                metric,
            )
        }
        "find" => {
            let query = text(args.get("query")).unwrap_or("");
            let mode = text(args.get("mode")).unwrap_or("name");
            let detail = match count {
                Some(count) => format!(
                    "{}{}",
                    plural(count, "match", Some("matches")),
                    if mode == "content" {
                        " in file contents"
                    } else {
                        ""
                    }
                ),
                None if mode == "content" => "in file contents".into(),
                None => "by name".into(),
            };
            with_detail(
                summary(
                    Kind::Search,
                    Tone::Neutral,
                    format!("Searched {}", js::quote(js::prefix(query, 60))),
                ),
                Some(detail),
            )
        }
        "apply_patch" => {
            let patch = text(args.get("patch")).unwrap_or("");
            let has = |marker: &str| patch.split('\n').any(|line| line.starts_with(marker));
            let adds = has("*** Add File:");
            let deletes = has("*** Delete File:");
            let updates = has("*** Update File:");
            let moves = has("*** Move to:");
            let (kind, verb) = if adds && !deletes && !updates {
                (Kind::Create, "Created")
            } else if deletes && !adds && !updates {
                (Kind::Delete, "Deleted")
            } else if moves && !adds && !deletes {
                (Kind::Move, "Moved")
            } else {
                (Kind::Edit, "Edited")
            };
            let tone = if kind == Kind::Delete {
                Tone::Warn
            } else {
                Tone::Good
            };
            let title = if changes.is_empty() {
                "Applied a patch".to_owned()
            } else {
                file_title(verb, changes)
            };
            with_metric(summary(kind, tone, title), total_delta(changes))
        }
        "exec_command" => {
            let commands: Vec<&str> = array(args.get("cmds"))
                .iter()
                .filter_map(Value::as_str)
                .collect();
            let command = if commands.is_empty() {
                script_label(text(args.get("cmd")))
            } else {
                format!(
                    "{} commands: {}",
                    commands.len(),
                    script_label(
                        Some(commands.join("; ").as_str()).filter(|joined| !joined.is_empty())
                    )
                )
            };
            let failed = process.timed_out
                || (!process.benign_exit && process.exit_code.is_some_and(|code| code != 0));
            let running = process.running == Some(true)
                || (process.running.is_none()
                    && !process.timed_out
                    && process.exit_code.is_none()
                    && process.duration_ms.is_some());
            let took = process.duration_ms.map_or(duration_ms, |ms| ms as f64);
            let tone = if failed {
                Tone::Bad
            } else if running {
                Tone::Neutral
            } else {
                Tone::Good
            };
            let title = if failed {
                format!("Command failed {command}")
            } else if running {
                format!("Started {command}")
            } else {
                format!("Ran {command}")
            };
            let metric = if running {
                "started".to_owned()
            } else if process.timed_out {
                "\u{2715} timed out".to_owned()
            } else if failed {
                format!("\u{2715} exit {}", exit_text(process.exit_code))
            } else {
                format!("\u{2713} {}", format_duration(took))
            };
            with_metric(summary(Kind::Run, tone, title), Some(metric))
        }
        "write_stdin" => {
            let id = match args.get("session_id") {
                Some(Value::Number(number)) => js::number_text(number.as_f64().unwrap_or_default()),
                other => text(other).unwrap_or("").to_owned(),
            };
            let signal = text(args.get("signal"));
            let title = match signal {
                Some("kill") => format!("Stopped session {id}"),
                Some("int") => format!("Interrupted session {id}"),
                _ if text(args.get("chars")).is_some() => format!("Wrote to session {id}"),
                _ => format!("Waited on session {id}"),
            };
            let title = js::trim(&title).to_owned();
            let failed = !process.benign_exit && process.exit_code.is_some_and(|code| code != 0);
            let tone = if signal == Some("kill") {
                Tone::Warn
            } else if failed {
                Tone::Bad
            } else {
                Tone::Neutral
            };
            let metric = process.exit_code.map(|code| {
                if failed {
                    format!("\u{2715} exit {code}")
                } else {
                    "\u{2713} finished".to_owned()
                }
            });
            with_metric(summary(Kind::Process, tone, title), metric)
        }
        "observe" => {
            let wait_for = text(args.get("wait_for"));
            let what = text(args.get("what")).unwrap_or(if wait_for.is_some() {
                "window"
            } else {
                "active"
            });
            if let Some(wait_for) = wait_for {
                return summary(
                    Kind::Screen,
                    Tone::Neutral,
                    format!("Waited for {wait_for}"),
                );
            }
            match what {
                "windows" => with_detail(
                    summary(Kind::Screen, Tone::Neutral, "Listed open windows"),
                    count.map(|count| plural(count, "window", None)),
                ),
                "ui" => with_detail(
                    summary(
                        Kind::Screen,
                        Tone::Neutral,
                        format!(
                            "Looked for {}",
                            js::quote(js::prefix(text(args.get("match")).unwrap_or(""), 40))
                        ),
                    ),
                    count.map(|count| plural(count, "match", Some("matches"))),
                ),
                _ => with_detail(
                    summary(Kind::Screen, Tone::Neutral, "Looked at the screen"),
                    count.map(|count| plural(count, "control", None)),
                ),
            }
        }
        "list_windows" => summary(Kind::Screen, Tone::Neutral, "Listed open windows"),
        "get_window" => summary(Kind::Screen, Tone::Neutral, "Inspected a window"),
        "list_apps" => summary(Kind::Screen, Tone::Neutral, "Listed installed apps"),
        "get_window_state" => summary(Kind::Screen, Tone::Neutral, "Inspected window state"),
        "launch_app" => summary(Kind::Input, Tone::Neutral, "Requested an app launch"),
        "click" => summary(Kind::Input, Tone::Neutral, "Clicked in a window"),
        "press_key" => summary(Kind::Input, Tone::Neutral, "Pressed keys in a window"),
        "type_text" => summary(Kind::Input, Tone::Neutral, "Typed in a window"),
        "scroll" => summary(Kind::Input, Tone::Neutral, "Scrolled in a window"),
        "set_value" => summary(Kind::Input, Tone::Neutral, "Replaced a field value"),
        "drag" => summary(Kind::Input, Tone::Neutral, "Dragged in a window"),
        "perform_secondary_action" => {
            summary(Kind::Input, Tone::Neutral, "Acted on a window control")
        }
        "activate_window" => summary(Kind::Input, Tone::Neutral, "Focused a window"),
        "read_clipboard" => summary(Kind::Clipboard, Tone::Neutral, "Read the clipboard"),
        "write_clipboard" => summary(
            Kind::Clipboard,
            Tone::Neutral,
            "Replaced the clipboard text",
        ),
        "computer" => {
            let actions: Vec<String> = array(args.get("actions"))
                .iter()
                .map(|action| {
                    text(record(Some(action)).get("type"))
                        .unwrap_or("?")
                        .to_owned()
                })
                .collect();
            let mut kinds: Vec<&str> = Vec::new();
            for action in &actions {
                if !kinds.contains(&action.as_str()) {
                    kinds.push(action);
                }
            }
            let label = |kind: &str| -> Option<&'static str> {
                Some(match kind {
                    "click" | "click_ref" => "Clicked",
                    "set_value" => "Filled in a field",
                    "double_click" => "Double-clicked",
                    "move" => "Moved the pointer",
                    "drag" => "Dragged",
                    "scroll" => "Scrolled",
                    "type" => "Typed",
                    "keypress" => "Pressed keys",
                    "focus" => "Focused a window",
                    "wait" => "Waited",
                    "read_clipboard" => "Read the clipboard",
                    "write_clipboard" => "Replaced the clipboard text",
                    _ => return None,
                })
            };
            let first = kinds.first().copied().unwrap_or("undefined");
            let title = if kinds.len() == 1 {
                label(first).unwrap_or("Acted on the desktop").to_owned()
            } else {
                format!(
                    "{} and {} more",
                    label(first).unwrap_or("Acted"),
                    kinds.len() as i64 - 1
                )
            };
            let kind = if kinds.iter().all(|kind| kind.ends_with("_clipboard")) {
                Kind::Clipboard
            } else {
                Kind::Input
            };
            with_detail(
                summary(kind, Tone::Neutral, title),
                (actions.len() > 1).then(|| plural(actions.len(), "action", None)),
            )
        }
        "update_plan" => {
            let steps = array(args.get("plan"));
            let completed = steps
                .iter()
                .filter(|step| record(Some(step)).get("status") == Some(&Value::from("completed")))
                .count();
            let title = if steps.is_empty() {
                "Cleared the task plan"
            } else {
                "Updated the task plan"
            };
            with_detail(
                summary(Kind::Session, Tone::Neutral, title),
                (!steps.is_empty()).then(|| format!("{completed} / {} completed", steps.len())),
            )
        }
        "session" => {
            let action = text(args.get("action")).unwrap_or("search");
            let query = text(args.get("query"));
            if action == "search" {
                let title = match query {
                    Some(query) => {
                        format!("Searched recordings {}", js::quote(js::prefix(query, 40)))
                    }
                    None => "Listed recent recordings".into(),
                };
                return with_detail(
                    summary(Kind::Session, Tone::Neutral, title),
                    count.map(|count| plural(count, "session", None)),
                );
            }
            let title = if text(args.get("tool_call")).is_some() {
                "Opened one recorded tool call"
            } else if text(args.get("cursor")).is_some() {
                "Continued reading a recorded session"
            } else {
                "Read a recorded session"
            };
            with_detail(
                summary(Kind::Session, Tone::Neutral, title),
                count.map(|count| plural(count, "entry", Some("entries"))),
            )
        }
        "agents" => match text(args.get("action")).unwrap_or("status") {
            "spawn" => summary(
                Kind::Agent,
                Tone::Good,
                format!(
                    "Created {}",
                    plural(array(args.get("workers")).len(), "worker agent", None)
                ),
            ),
            "message" => {
                let batch = array(args.get("messages"));
                if batch.len() > 1 {
                    return summary(
                        Kind::Agent,
                        Tone::Neutral,
                        format!("Messaged {}", plural(batch.len(), "agent", None)),
                    );
                }
                let only = if batch.len() == 1 {
                    record(batch.first())
                } else {
                    args
                };
                summary(
                    Kind::Agent,
                    Tone::Neutral,
                    format!(
                        "Messaged {}",
                        text(only.get("to")).unwrap_or("the prime agent")
                    ),
                )
            }
            "finish" => summary(Kind::Agent, Tone::Good, "Reported the finished task"),
            _ => with_detail(
                summary(Kind::Agent, Tone::Neutral, "Checked agent status"),
                count.map(|count| plural(count, "message", None)),
            ),
        },
        _ => summary(Kind::Other, Tone::Neutral, format!("Ran {tool}")),
    }
}

fn exit_text(code: Option<i64>) -> String {
    code.map_or_else(|| "null".to_owned(), |code| code.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, added: u64, removed: u64, approximate: bool) -> FileChange {
        FileChange {
            path: path.into(),
            added,
            removed,
            approximate,
            review_asset_id: None,
            review_unavailable: None,
            extra: Extra::new(),
        }
    }

    fn run(tool: &str, args: Value, notes: CallNotes, outcome: ToolOutcome) -> ActivitySummary {
        summarize(&SummaryInput {
            tool,
            args: &args,
            notes: &notes,
            outcome,
            duration_ms: 0.0,
            result_head: "head line",
        })
    }

    fn ok(tool: &str, args: Value, notes: CallNotes) -> ActivitySummary {
        run(tool, args, notes, ToolOutcome::Ok)
    }

    fn process(process: ProcessNotes) -> CallNotes {
        CallNotes {
            process: Some(process),
            ..CallNotes::default()
        }
    }

    fn exited(code: i64) -> CallNotes {
        process(ProcessNotes {
            exit_code: Some(code),
            ..ProcessNotes::default()
        })
    }

    fn patch(kind: &str, path: &str) -> String {
        format!("*** Begin Patch\n*** {kind}: {path}\n+x\n*** End Patch")
    }

    #[test]
    fn names_edits_creates_deletes_and_moves_from_the_patch() {
        let one = ok(
            "apply_patch",
            serde_json::json!({ "patch": patch("Update File", "/p/src/a.ts") }),
            CallNotes {
                changes: vec![change("/p/src/a.ts", 18, 4, false)],
                ..CallNotes::default()
            },
        );
        assert_eq!(
            (one.title.as_str(), one.metric.as_deref()),
            ("Edited src/a.ts", Some("+18 \u{2212}4"))
        );
        let approximate = ok(
            "apply_patch",
            serde_json::json!({ "patch": patch("Update File", "/p/big.ts") }),
            CallNotes {
                changes: vec![change("/p/big.ts", 4000, 3000, true)],
                ..CallNotes::default()
            },
        );
        assert_eq!(approximate.metric.as_deref(), Some("~+4000 \u{2212}3000"));
        let deleted = ok(
            "apply_patch",
            serde_json::json!({ "patch": patch("Delete File", "/p/old-helper.ts") }),
            CallNotes {
                changes: vec![change("/p/old-helper.ts", 0, 83, false)],
                ..CallNotes::default()
            },
        );
        assert_eq!(deleted.title, "Deleted old-helper.ts");
        assert_eq!(deleted.tone, ActivityTone::Warn);
        let refused = run(
            "apply_patch",
            serde_json::json!({ "patch": patch("Delete File", "/p/x.ts") }),
            CallNotes {
                changes: vec![change("/p/x.ts", 0, 3, false)],
                ..CallNotes::default()
            },
            ToolOutcome::ToolRejected,
        );
        assert_eq!(refused.title, "Refused to delete x.ts");
        assert_eq!(refused.metric.as_deref(), Some("refused"));
    }

    #[test]
    fn describes_reads_commands_and_sessions() {
        let read = ok(
            "read",
            serde_json::json!({ "paths": ["/p/tools.ts"], "start_line": 200, "end_line": 420 }),
            CallNotes::default(),
        );
        assert_eq!(read.detail.as_deref(), Some("lines 200\u{2013}420"));
        assert_eq!(read.metric.as_deref(), Some("221 lines"));
        let three = ok(
            "read",
            serde_json::json!({ "paths": ["/p/a.ts", "/p/b.ts", "/p/c.ts"] }),
            CallNotes::default(),
        );
        assert_eq!(
            (three.title.as_str(), three.detail.as_deref()),
            ("Read 3 paths", Some("a.ts, b.ts, c.ts"))
        );
        let ran = ok(
            "exec_command",
            serde_json::json!({ "cmd": "npm run verify" }),
            process(ProcessNotes {
                exit_code: Some(0),
                duration_ms: Some(4800),
                ..ProcessNotes::default()
            }),
        );
        assert_eq!(
            (ran.title.as_str(), ran.metric.as_deref()),
            ("Ran npm run verify", Some("\u{2713} 4.8s"))
        );
        let started = ok(
            "exec_command",
            serde_json::json!({ "cmd": "npm run verify" }),
            process(ProcessNotes {
                duration_ms: Some(10_000),
                ..ProcessNotes::default()
            }),
        );
        assert_eq!(started.title, "Started npm run verify");
        let multi = ok(
            "exec_command",
            serde_json::json!({ "cmd": "# find the build\r\nGet-ChildItem -Recurse -Filter *.log\nSelect-Object -First 5" }),
            exited(0),
        );
        assert_eq!(
            multi.title,
            "Ran Get-ChildItem -Recurse -Filter *.log \u{2026}"
        );
        let failed = ok("exec_command", serde_json::json!({}), exited(1));
        assert_eq!(failed.title, "Command failed a command");
        assert_eq!(
            ok(
                "write_stdin",
                serde_json::json!({ "session_id": "p1", "signal": "int" }),
                CallNotes::default()
            )
            .title,
            "Interrupted session p1"
        );
        assert_eq!(
            ok(
                "session",
                serde_json::json!({ "action": "search", "query": "tunnel" }),
                CallNotes::default()
            )
            .title,
            "Searched recordings \"tunnel\""
        );
        assert_eq!(
            ok(
                "some_future_tool",
                serde_json::json!({}),
                CallNotes::default()
            )
            .title,
            "Ran some_future_tool"
        );
    }

    /// `keeps benign exit classification, batch labels and numeric wait ids consistent`
    /// (`test/exec-completed-results.test.ts`).
    #[test]
    fn a_benign_exit_is_a_result_and_a_failed_wait_names_its_exit() {
        let benign = ok(
            "exec_command",
            serde_json::json!({ "cmds": ["git diff", "C:/tools/rg.exe needle file.txt | Select-Object -First 40"] }),
            process(ProcessNotes {
                exit_code: Some(4_294_967_295),
                benign_exit: true,
                running: Some(false),
                ..ProcessNotes::default()
            }),
        );
        assert_eq!(benign.tone, ActivityTone::Good);
        assert!(benign.title.contains("2 commands: git diff"), "{benign:?}");
        for code in [1, 2] {
            let wait = run(
                "write_stdin",
                serde_json::json!({ "session_id": 1234 }),
                exited(code),
                ToolOutcome::ProcessExitNonzero,
            );
            assert_eq!(
                (wait.title.as_str(), wait.tone, wait.metric.as_deref()),
                (
                    "Waited on session 1234",
                    ActivityTone::Bad,
                    Some(format!("\u{2715} exit {code}").as_str())
                )
            );
        }
        let timed_out = ok(
            "exec_command",
            serde_json::json!({ "cmd": "sleep 900" }),
            process(ProcessNotes {
                timed_out: true,
                running: Some(false),
                ..ProcessNotes::default()
            }),
        );
        assert_eq!(
            (timed_out.title.as_str(), timed_out.metric.as_deref()),
            ("Command failed sleep 900", Some("\u{2715} timed out"))
        );
    }

    #[test]
    fn a_search_names_how_many_matches_it_found() {
        let found = |count: Option<u64>, mode: &str| {
            ok(
                "find",
                serde_json::json!({ "query": "quartz-lantern", "mode": mode }),
                CallNotes {
                    count,
                    ..CallNotes::default()
                },
            )
            .detail
        };
        assert_eq!(
            found(Some(3), "content").as_deref(),
            Some("3 matches in file contents")
        );
        assert_eq!(found(Some(1), "name").as_deref(), Some("1 match"));
        assert_eq!(found(Some(0), "name").as_deref(), Some("0 matches"));
        assert_eq!(found(None, "name").as_deref(), Some("by name"));
    }

    #[test]
    fn says_a_failed_call_failed_for_every_family() {
        let cases = [
            (
                "read",
                serde_json::json!({ "paths": ["/p/x.ts"] }),
                "Could not read x.ts",
            ),
            (
                "find",
                serde_json::json!({ "query": "todo" }),
                "Could not search \"todo\"",
            ),
            (
                "exec_command",
                serde_json::json!({ "cmd": "npm test" }),
                "Could not run npm test",
            ),
            (
                "observe",
                serde_json::json!({}),
                "Could not look at the screen",
            ),
            (
                "agents",
                serde_json::json!({ "action": "spawn", "workers": [{}, {}] }),
                "Could not create 2 worker agents",
            ),
            (
                "agents",
                serde_json::json!({ "action": "finish" }),
                "Could not report the finished task",
            ),
            (
                "some_future_tool",
                serde_json::json!({}),
                "Could not run some_future_tool",
            ),
        ];
        for (tool, args, title) in cases {
            let summary = run(
                tool,
                args,
                CallNotes::default(),
                ToolOutcome::ToolInternalError,
            );
            assert_eq!(summary.title, title, "{tool}");
            if tool != "find" {
                assert_eq!(summary.detail.as_deref(), Some("head line"), "{tool}");
            }
            assert_eq!(summary.tone, ActivityTone::Bad);
        }
    }

    /// What a process tool notes about the child its recorded result describes.
    fn corpus_process(result: &str) -> Option<ProcessNotes> {
        let exited = result
            .lines()
            .find_map(|line| line.strip_prefix("Process exited with code "))
            .and_then(|code| code.parse().ok());
        let running = result
            .lines()
            .find_map(|line| line.strip_prefix("Process running with session ID "));
        if exited.is_none() && running.is_none() {
            return None;
        }
        Some(ProcessNotes {
            exit_code: exited,
            running: Some(running.is_some()),
            duration_ms: Some(395),
            session_id: running.map(str::to_owned),
            ..ProcessNotes::default()
        })
    }

    /// The notes each recorded tool reported: process facts from its own result, and the
    /// changes and read range the recorder stored.
    fn corpus_notes(tool: &str, summary: &Value, changes: &[Value], result: &str) -> CallNotes {
        CallNotes {
            changes: changes
                .iter()
                .map(|change| {
                    change_of(
                        change["path"].as_str().unwrap_or(""),
                        change["added"].as_u64().unwrap_or(0),
                        change["removed"].as_u64().unwrap_or(0),
                    )
                })
                .collect(),
            detail: (tool == "read")
                .then(|| {
                    summary["detail"]
                        .as_str()
                        .filter(|detail| detail.starts_with("lines "))
                })
                .flatten()
                .map(str::to_owned),
            process: corpus_process(result),
            ..CallNotes::default()
        }
    }

    /// The corpus writes a process id as a bare `<EXEC_SESSION:n>`; quoting it makes the
    /// arguments JSON again, and the summary names it the same way.
    fn quote_process_ids(args: &str) -> String {
        let mut quoted = String::with_capacity(args.len());
        let mut rest = args;
        while let Some(start) = rest.find("<EXEC_SESSION:") {
            let Some(end) = rest[start..].find('>') else {
                break;
            };
            let end = start + end + 1;
            quoted.push_str(&rest[..start]);
            quoted.push('"');
            quoted.push_str(&rest[start..end]);
            quoted.push('"');
            rest = &rest[end..];
        }
        quoted.push_str(rest);
        quoted
    }

    fn change_of(path: &str, added: u64, removed: u64) -> FileChange {
        change(path, added, removed, false)
    }

    #[test]
    fn every_recorded_corpus_call_gets_the_summary_the_typescript_app_wrote() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../golden/base/api/sse/stream.json");
        let corpus: Value =
            serde_json::from_slice(&std::fs::read(path).expect("corpus")).expect("json");
        let mut compared = 0;
        for frame in corpus["response"]["frames"].as_array().expect("frames") {
            let Some(tool) = frame["data"].get("tool") else {
                continue;
            };
            let name = tool["name"].as_str().expect("name");
            if tool["args"]["truncated"] == Value::Bool(true) {
                continue;
            }
            let args: Value = serde_json::from_str(&quote_process_ids(
                tool["args"]["text"].as_str().expect("args"),
            ))
            .expect("arguments are JSON");
            let outcome: ToolOutcome =
                serde_json::from_value(tool["outcome"].clone()).expect("outcome");
            let result = tool["result"]["text"].as_str().expect("result");
            let notes = corpus_notes(
                name,
                &tool["summary"],
                tool["changes"].as_array().expect("changes"),
                result,
            );
            let summary = summarize(&SummaryInput {
                tool: name,
                args: &args,
                notes: &notes,
                outcome,
                duration_ms: 395.0,
                result_head: result.split('\n').next().unwrap_or(""),
            });
            let mut written = serde_json::to_value(&summary).expect("summary");
            if written["metric"] == "✓ 395ms" {
                written["metric"] = Value::from("✓ <DURATION>");
            }
            let mut expected = tool["summary"].clone();
            // The read model cuts a detail at 300 units; the stored one is at most 120.
            if let (Some(want), Some(got)) =
                (expected["detail"].as_str(), written["detail"].as_str())
            {
                assert!(
                    got.starts_with(want) || want.starts_with(got),
                    "{name}: {got} / {want}"
                );
                expected["detail"] = written["detail"].clone();
            }
            assert_eq!(written, expected, "{name} seq {}", frame["data"]["seq"]);
            compared += 1;
        }
        assert!(compared >= 60, "compared {compared} recorded calls");
    }
}
