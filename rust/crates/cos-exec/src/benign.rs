//! Which non-zero exits are a reported result rather than a failure (`nonZeroExitIsBenign` and
//! `benignExitNote` in `exec-hints.ts`).
//!
//! A search that found nothing exits 1 and has not failed: ripgrep, grep and findstr spend 1 on
//! "no matches" and reserve another code for errors. So does a reporting command whose pipe
//! `Select-Object -First` closed early. Everything here only ever withholds the error mark, and
//! anything it cannot read with certainty stays a failure: a guessed exemption would launder a
//! real failure into "the search found nothing".

use std::sync::LazyLock;

use regex::Regex;

use crate::hints::{
    Token, has_unsupported_lexemes, is_js_space, program_name, split_top_level, tokenize,
};
use crate::shell::ShellKind;

/// Programs whose exit 1 means "found nothing"; each reserves another code for real errors.
const NO_MATCH_MEANS_EXIT_1: &[&str] = &["rg", "ripgrep", "grep", "egrep", "fgrep", "findstr"];

/// PowerShell aliases that are cmdlets despite not being spelled Verb-Noun.
const CMDLET_ALIASES: &[&str] = &[
    "select", "where", "foreach", "sort", "measure", "group", "tee", "ft", "fl", "fw", "gc", "gci",
    "gi", "ls", "dir", "cat", "echo", "write", "sls", "ogv", "%", "?",
];

/// Cmdlets known by exact name, because a token's Verb-Noun shape cannot prove one.
const KNOWN_CMDLETS: &[&str] = &[
    "add-content",
    "add-member",
    "clear-content",
    "compare-object",
    "convertfrom-csv",
    "convertfrom-json",
    "convertfrom-stringdata",
    "convertto-csv",
    "convertto-html",
    "convertto-json",
    "copy-item",
    "export-clixml",
    "export-csv",
    "format-custom",
    "format-list",
    "format-table",
    "format-wide",
    "get-childitem",
    "get-command",
    "get-content",
    "get-date",
    "get-filehash",
    "get-item",
    "get-itemproperty",
    "get-location",
    "get-member",
    "get-process",
    "get-random",
    "get-unique",
    "group-object",
    "import-csv",
    "join-path",
    "measure-object",
    "move-item",
    "new-item",
    "new-object",
    "out-file",
    "out-gridview",
    "out-host",
    "out-null",
    "out-string",
    "remove-item",
    "rename-item",
    "resolve-path",
    "select-object",
    "select-string",
    "select-xml",
    "set-content",
    "set-location",
    "sort-object",
    "split-path",
    "tee-object",
    "test-path",
    "where-object",
    "write-error",
    "write-host",
    "write-output",
    "write-warning",
    "foreach-object",
];

/// git subcommands that only report: a normal run has exactly one exit code.
const GIT_SUBCOMMANDS_THAT_ONLY_REPORT: &[&str] = &["diff", "log", "show", "status", "blame"];

/// Observed PowerShell native-pipeline cut statuses, including unsigned -1.
const CUT_PIPELINE_EXIT_CODES: [i64; 3] = [1, -1, 0xffff_ffff];

fn regex(pattern: &str) -> Regex {
    // The patterns are constants of this file; a test compiles each one.
    Regex::new(pattern).unwrap_or_else(|error| panic!("invalid pattern {pattern}: {error}"))
}

/// Downstream stages that cannot decide the exit status: argument-free or fixed shapes only.
static PASSIVE_STAGES: LazyLock<[Regex; 4]> = LazyLock::new(|| {
    [
        regex(r"(?i)^(?:select-object|select)\s+-(?:first|last)\s+[0-9]+$"),
        regex(r"(?i)^(?:sort-object|sort)$"),
        regex(r"(?i)^(?:measure-object|measure)$"),
        regex(r"(?i)^out-null$"),
    ]
});

/// The one passive stage that stops the pipeline.
static TRUNCATING_STAGE: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)^(?:select-object|select)\s+-first\s+[0-9]+$"));

static GIT_FLAGS_THAT_MAKE_THE_EXIT_MEAN_SOMETHING: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)^--(?:exit-code|quiet|check)$"));

static EXECUTABLE_EXTENSION: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?i)\.(?:exe|cmd|bat|com|ps1)$"));

/// Diagnostics that mean the shell itself refused the command line.
static SHELL_REFUSED: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        "(?imR){}",
        [
            r"^\s*(?:[^\s:]*/)?(?:-?bash|-?zsh|dash|ksh|sh):",
            r"^\s*At line:[0-9]+ char:[0-9]+",
            r"The token '[^']*' is not a valid statement separator",
            r"ParserError",
            r"CommandNotFoundException",
            r"ParameterBindingException",
            r"is not recognized as (?:the name of )?a (?:cmdlet|command)",
            r"is not recognized as an internal or external command",
            r"The string (?:is missing the terminator|starting:)",
            r"Missing (?:argument|expression|closing|\))",
        ]
        .join("|")
    ))
});

/// A diagnostic line a search program printed about itself, rather than a match.
static SEARCH_DIAGNOSTIC: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?imR)^\s*(rg|ripgrep|grep|egrep|fgrep|findstr):"));

static GIT_DIAGNOSTIC: LazyLock<Regex> = LazyLock::new(|| regex(r"(?imR)^\s*(?:fatal|error):"));

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

fn has_path(token: &Token) -> bool {
    token.value.contains(['\\', '/'])
}

/// Whether a pipeline stage is PowerShell's own, and so cannot have set the exit code.
fn looks_like_cmdlet(token: Option<&Token>) -> bool {
    let Some(token) = token else {
        return false;
    };
    if has_path(token) || EXECUTABLE_EXTENSION.is_match(&token.value) {
        return false;
    }
    let name = token.value.to_lowercase();
    CMDLET_ALIASES
        .iter()
        .chain(KNOWN_CMDLETS)
        .any(|known| *known == name)
}

fn stage_is_passive(segment: &str) -> bool {
    PASSIVE_STAGES.iter().any(|shape| shape.is_match(segment))
}

/// The literal executable at the head of one stage: `& 'C:\...\rg.exe'` names its path, and a
/// dynamic `& $cmd` names nothing.
fn stage_program_token(segment: &str) -> Option<Token> {
    let mut tokens = tokenize(segment).into_iter();
    let first = tokens.next()?;
    if first.value != "&" {
        return Some(first);
    }
    tokens.next().filter(has_path)
}

fn last_statement(command: &str) -> Option<String> {
    split_top_level(command, &[";", "\n"], None).pop()
}

fn is_conditional_chain(command: &str) -> bool {
    split_top_level(command, &["&&", "||"], None).len() > 1
}

/// The token whose process status decides this command, when the parse can name one: the
/// rightmost stage of the last statement that is a program, reading through passive stages.
fn status_determining_token(command: &str) -> Option<Token> {
    if has_unsupported_lexemes(command) || is_conditional_chain(command) {
        return None;
    }
    let last = last_statement(command)?;
    let segments = split_top_level(&last, &["|"], None);
    for segment in segments.iter().skip(1).rev() {
        let segment = js_trim(segment);
        if stage_is_passive(segment) {
            continue;
        }
        let first = stage_program_token(segment);
        return if looks_like_cmdlet(first.as_ref()) {
            None
        } else {
            first
        };
    }
    stage_program_token(segments.first()?)
}

fn status_determining_program(command: &str) -> String {
    program_name(status_determining_token(command).as_ref())
}

/// The generator of a pipeline that `Select-Object -First` cut short, when every later stage
/// is passive.
fn pipeline_stop_candidate(command: &str) -> Option<Token> {
    if has_unsupported_lexemes(command) || is_conditional_chain(command) {
        return None;
    }
    let last = last_statement(command)?;
    let segments = split_top_level(&last, &["|"], None);
    if segments.len() < 2 {
        return None;
    }
    let mut truncates = false;
    for segment in &segments[1..] {
        let segment = js_trim(segment);
        if !stage_is_passive(segment) {
            return None;
        }
        truncates |= TRUNCATING_STAGE.is_match(segment);
    }
    if !truncates {
        return None;
    }
    stage_program_token(&segments[0])
}

/// The subcommand straight after a `git` generator, unless a flag turns it into a predicate.
fn git_generator_subcommand(command: &str) -> Option<String> {
    let last = last_statement(command)?;
    let generator = split_top_level(&last, &["|"], None).into_iter().next()?;
    let tokens = tokenize(&generator);
    if program_name(tokens.first()) != "git" {
        return None;
    }
    let subcommand = tokens.get(1)?;
    if tokens
        .iter()
        .any(|argument| GIT_FLAGS_THAT_MAKE_THE_EXIT_MEAN_SOMETHING.is_match(&argument.value))
    {
        return None;
    }
    Some(subcommand.value.to_lowercase())
}

/// Whether a cut pipeline's generator has no second reason to exit non-zero.
fn cut_pipeline_generator_only_reports(command: &str) -> bool {
    let Some(token) = pipeline_stop_candidate(command) else {
        return false;
    };
    if program_name(Some(&token)) != "git" {
        return cut_pipeline_generator_is_proven_search(&token);
    }
    git_generator_subcommand(command)
        .is_some_and(|subcommand| GIT_SUBCOMMANDS_THAT_ONLY_REPORT.contains(&subcommand.as_str()))
}

/// Whether the first stage is the one whose status the shell reported.
fn generator_decides_status(command: &str) -> bool {
    let Some(last) = last_statement(command) else {
        return false;
    };
    split_top_level(&last, &["|"], None)
        .iter()
        .skip(1)
        .all(|segment| stage_is_passive(js_trim(segment)))
}

/// A path-proven search generator, whose own failures are visible in its output.
fn cut_pipeline_generator_is_proven_search(token: &Token) -> bool {
    NO_MATCH_MEANS_EXIT_1.contains(&program_name(Some(token)).as_str()) && has_path(token)
}

/// The output lines that are the command's own, without the response framing.
fn command_output_body(output: &str) -> Vec<&str> {
    let lines: Vec<&str> = output
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let body = match lines.iter().position(|line| *line == "Output:") {
        Some(start) => &lines[start + 1..],
        None => &lines[..],
    };
    body.iter()
        .copied()
        .filter(|line| {
            !js_trim(line).is_empty()
                && !line.starts_with("---")
                && !line.starts_with("Warning: truncated output")
        })
        .collect()
}

/// `nonZeroExitIsBenign`: the program spends this exit on "no matches" (or a proven reporting
/// command was cut by `Select-Object -First`), and printed no error of its own.
pub(crate) fn non_zero_exit_is_benign(command: &str, exit: Option<i64>, output: &str) -> bool {
    let Some(code) = exit else {
        return false;
    };
    if SHELL_REFUSED.is_match(output) {
        return false;
    }
    if CUT_PIPELINE_EXIT_CODES.contains(&code)
        && cut_pipeline_generator_only_reports(command)
        && !command_output_body(output).is_empty()
        && !GIT_DIAGNOSTIC.is_match(output)
        && !SEARCH_DIAGNOSTIC.is_match(output)
    {
        return true;
    }
    if code != 1 {
        return false;
    }
    let token = status_determining_token(command);
    let program = program_name(token.as_ref());
    if program == "git" {
        return git_generator_subcommand(command).as_deref() == Some("grep")
            && generator_decides_status(command)
            && !GIT_DIAGNOSTIC.is_match(output);
    }
    if !NO_MATCH_MEANS_EXIT_1.contains(&program.as_str()) {
        return false;
    }
    // A bare name may be a profile function or a local script; only a path proves the program.
    token.as_ref().is_some_and(has_path) && !SEARCH_DIAGNOSTIC.is_match(output)
}

/// `benignExitNote`: what to tell the model about an exit [`non_zero_exit_is_benign`] accepted.
pub(crate) fn benign_exit_note(
    command: &str,
    shell: ShellKind,
    exit: Option<i64>,
    output: Option<&str>,
) -> String {
    let cut = (shell == ShellKind::PowerShell && cut_pipeline_generator_only_reports(command))
        .then(|| pipeline_stop_candidate(command))
        .flatten()
        .filter(|generator| {
            !cut_pipeline_generator_is_proven_search(generator)
                || output.is_some_and(|output| !command_output_body(output).is_empty())
        });
    if let Some(generator) = cut {
        let program = program_name(Some(&generator));
        return format!(
            "Exit code {} here is `Select-Object -First` stopping the pipeline, not a failure: it closes the pipe while `{program}` is still writing, and `{program}` has no other way to exit non-zero once it has printed. The output above is the first N objects and is complete for that window, so the command does not need to be run again. Add `-Wait` to the same stage to keep the exit code meaningful, at the cost of letting the command run to the end.",
            exit.unwrap_or(1)
        );
    }
    let deciding = status_determining_program(command);
    let program = if deciding == "git" {
        format!(
            "git {}",
            git_generator_subcommand(command).unwrap_or_default()
        )
        .trim_matches(is_js_space)
        .to_owned()
    } else {
        deciding
    };
    if shell != ShellKind::PowerShell {
        return format!(
            "Exit code 1 from `{program}` is a result, not a failure: this search program uses it when it finds no matches. Nothing went wrong, and the command does not need to be run again."
        );
    }
    format!(
        "Exit code 1 from `{program}` is a result, not a failure: it is what a search reports when it finds no matches, and also what it reports when a later stage such as `Select-Object -First` stops the pipeline early. Nothing went wrong, and the command does not need to be run again."
    )
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    /// Every call the TypeScript suites make, as `differential/benign-oracle.mjs` recorded it.
    fn oracle() -> Value {
        let file = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/benign-oracle.json");
        serde_json::from_slice(&std::fs::read(file).expect("oracle file")).expect("oracle JSON")
    }

    fn shell(name: &str) -> ShellKind {
        match name {
            "powershell" => ShellKind::PowerShell,
            "cmd" => ShellKind::Cmd,
            "bash" => ShellKind::Bash,
            "zsh" => ShellKind::Zsh,
            "sh" => ShellKind::Sh,
            other => panic!("unknown shell {other}"),
        }
    }

    #[test]
    fn every_pattern_compiles() {
        LazyLock::force(&PASSIVE_STAGES);
        for pattern in [
            &TRUNCATING_STAGE,
            &GIT_FLAGS_THAT_MAKE_THE_EXIT_MEAN_SOMETHING,
            &EXECUTABLE_EXTENSION,
            &SHELL_REFUSED,
            &SEARCH_DIAGNOSTIC,
            &GIT_DIAGNOSTIC,
        ] {
            LazyLock::force(pattern);
        }
    }

    #[test]
    fn classifies_every_recorded_exit_like_the_typescript_app() {
        let oracle = oracle();
        let cases = oracle["benign"].as_array().expect("cases");
        let wrong: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let command = case["command"].as_str().expect("command");
                let output = case["outputText"].as_str().expect("output");
                let got = non_zero_exit_is_benign(command, case["exitCode"].as_i64(), output);
                (Value::Bool(got) != case["benign"])
                    .then(|| format!("{command} exit {} -> {got}", case["exitCode"]))
            })
            .collect();
        assert!(cases.len() > 80, "{} cases", cases.len());
        assert!(
            wrong.is_empty(),
            "{} of {}:\n{}",
            wrong.len(),
            cases.len(),
            wrong.join("\n")
        );
    }

    #[test]
    fn words_every_recorded_note_like_the_typescript_app() {
        let oracle = oracle();
        let cases = oracle["note"].as_array().expect("cases");
        let wrong: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let command = case["command"].as_str().expect("command");
                let got = benign_exit_note(
                    command,
                    shell(case["shellType"].as_str().expect("shell")),
                    case["exitCode"].as_i64(),
                    case["outputText"].as_str(),
                );
                (got != case["note"].as_str().expect("note"))
                    .then(|| format!("{command}\n  rust {got}\n  ts   {}", case["note"]))
            })
            .collect();
        assert!(cases.len() > 30, "{} cases", cases.len());
        assert!(
            wrong.is_empty(),
            "{} of {}:\n{}",
            wrong.len(),
            cases.len(),
            wrong.join("\n")
        );
    }
}
