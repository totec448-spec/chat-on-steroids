//! Narrow command rewrites from `exec-hints.ts`: PowerShell quoting repair, binding `rg` to the
//! shipped ripgrep, and the `&&`/`||` chains Windows PowerShell 5.1 cannot parse. Each acts only
//! when it can prove its reading of the line, and leaves anything else exactly as written.

use crate::shell::ShellKind;

/// A rewritten command and the note that tells the model what changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Rewrite {
    pub cmd: String,
    pub notes: Vec<String>,
}

impl Rewrite {
    fn unchanged(cmd: &str) -> Self {
        Self {
            cmd: cmd.to_owned(),
            notes: Vec::new(),
        }
    }
}

/// JavaScript's `\s`.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub(crate) struct Token {
    pub raw: String,
    pub value: String,
}

/// Splits on whitespace outside single and double quotes. Not a shell parser: it only has to
/// keep a quoted argument whole.
pub(crate) fn tokenize(segment: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let (mut raw, mut value) = (String::new(), String::new());
    let mut quote: Option<char> = None;
    for c in segment.chars() {
        if let Some(open) = quote {
            raw.push(c);
            if c == open {
                quote = None;
            } else {
                value.push(c);
            }
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            raw.push(c);
            continue;
        }
        if is_js_space(c) {
            if !raw.is_empty() {
                tokens.push(Token {
                    raw: std::mem::take(&mut raw),
                    value: std::mem::take(&mut value),
                });
            }
            continue;
        }
        raw.push(c);
        value.push(c);
    }
    if !raw.is_empty() {
        tokens.push(Token { raw, value });
    }
    tokens
}

/// Syntax this small reader cannot model without guessing: backticks, here-strings and comments.
pub(crate) fn has_unsupported_lexemes(command: &str) -> bool {
    if command.contains('`') || command.contains("@\"") || command.contains("@'") {
        return true;
    }
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match quote {
            Some(open) if c == open => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' => return true,
            None => {}
        }
    }
    false
}

/// Top-level split on `seps`, ignoring quoted and bracketed text. An unbalanced line comes back
/// whole. Blank parts are dropped.
pub(crate) fn split_top_level(
    command: &str,
    seps: &[&str],
    hits: Option<&mut Vec<String>>,
) -> Vec<String> {
    let chars: Vec<char> = command.chars().collect();
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut depth = 0usize;
    let mut found = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(open) = quote {
            current.push(c);
            if c == open {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            current.push(c);
            i += 1;
            continue;
        }
        if c == '(' || c == '{' {
            depth += 1;
        } else if c == ')' || c == '}' {
            if depth == 0 {
                return vec![command.to_owned()];
            }
            depth -= 1;
        }
        if depth == 0
            && let Some(sep) = seps.iter().find(|sep| starts_with_at(&chars, i, sep))
        {
            parts.push(std::mem::take(&mut current));
            found.push((*sep).to_owned());
            i += sep.chars().count();
            continue;
        }
        current.push(c);
        i += 1;
    }
    if quote.is_some() || depth != 0 {
        return vec![command.to_owned()];
    }
    parts.push(current);
    if let Some(hits) = hits {
        hits.extend(found);
    }
    parts
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect()
}

fn starts_with_at(chars: &[char], at: usize, needle: &str) -> bool {
    let needle: Vec<char> = needle.chars().collect();
    chars.get(at..at + needle.len()) == Some(&needle[..])
}

/// Splits on `seps`, maps each part, and joins it back with the separators it was cut on.
fn rebuild(text: &str, seps: &[&str], map: &mut dyn FnMut(&str) -> String) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut pieces = Vec::new();
    let mut separators = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut depth = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(open) = quote {
            current.push(c);
            if c == open {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            current.push(c);
            i += 1;
            continue;
        }
        if c == '(' || c == '{' {
            depth += 1;
        } else if c == ')' || c == '}' {
            depth = depth.saturating_sub(1);
        }
        if depth == 0
            && let Some(sep) = seps.iter().find(|sep| starts_with_at(&chars, i, sep))
        {
            pieces.push(std::mem::take(&mut current));
            separators.push(*sep);
            i += sep.chars().count();
            continue;
        }
        current.push(c);
        i += 1;
    }
    pieces.push(current);
    let mut out = String::new();
    for (index, piece) in pieces.iter().enumerate() {
        if index > 0 {
            out.push_str(separators[index - 1]);
        }
        out.push_str(&map(piece));
    }
    out
}

fn quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `bindBundledRipgrep`: a bare `rg` at a statement or pipeline head runs the shipped ripgrep,
/// never a function or alias that happens to share its name.
pub(crate) fn bind_bundled_ripgrep(
    command: &str,
    kind: ShellKind,
    executable: Option<&str>,
) -> String {
    let Some(executable) = executable else {
        return command.to_owned();
    };
    if kind == ShellKind::Cmd || has_unsupported_lexemes(command) {
        return command.to_owned();
    }
    let mut changed = false;
    let bound = rebuild(command, &[";", "&&", "||", "\n"], &mut |statement| {
        rebuild(statement, &["|"], &mut |segment| {
            let body_start = segment.len() - segment.trim_start_matches(is_js_space).len();
            let body_end = segment.trim_end_matches(is_js_space).len().max(body_start);
            let (lead, body, trail) = (
                &segment[..body_start],
                &segment[body_start..body_end],
                &segment[body_end..],
            );
            let Some(first) = tokenize(body).into_iter().next() else {
                return segment.to_owned();
            };
            let name = first.value.to_ascii_lowercase();
            if first.raw != first.value
                || !matches!(name.as_str(), "rg" | "rg.exe" | "ripgrep" | "ripgrep.exe")
            {
                return segment.to_owned();
            }
            let Some(at) = body.find(&first.raw) else {
                return segment.to_owned();
            };
            changed = true;
            let replacement = if kind == ShellKind::PowerShell {
                format!("& {}", quote_powershell(executable))
            } else {
                quote_posix(executable)
            };
            format!(
                "{lead}{}{replacement}{}{trail}",
                &body[..at],
                &body[at + first.raw.len()..]
            )
        })
    });
    if changed { bound } else { command.to_owned() }
}

/// `normalizePowerShellOperators`: a short top-level `&&`/`||` chain, which Windows PowerShell
/// 5.1 refuses to parse, becomes guards on `$?`.
pub(crate) fn normalize_powershell_operators(
    cmd: &str,
    kind: ShellKind,
    shell_path: &str,
) -> Rewrite {
    if kind != ShellKind::PowerShell || !is_windows_powershell_5(shell_path) {
        return Rewrite::unchanged(cmd);
    }
    if (!cmd.contains("&&") && !cmd.contains("||")) || has_unsupported_lexemes(cmd) {
        return Rewrite::unchanged(cmd);
    }
    let mut operators = Vec::new();
    let operands = split_top_level(cmd, &["&&", "||"], Some(&mut operators));
    if operators.is_empty() || operands.len() != operators.len() + 1 || operands.len() > 4 {
        return Rewrite::unchanged(cmd);
    }
    let unsafe_operand = operands.iter().any(|operand| {
        let value = operand.trim();
        value.is_empty()
            || value.contains('>')
            || value.contains("$?")
            || split_top_level(value, &[";", "\n"], None).len() != 1
    });
    if unsafe_operand {
        return Rewrite::unchanged(cmd);
    }
    let rewritten = operands
        .iter()
        .enumerate()
        .map(|(index, operand)| {
            if index == 0 {
                return operand.trim().to_owned();
            }
            let guard = if operators[index - 1] == "&&" {
                "if ($?)"
            } else {
                "if (-not $?)"
            };
            format!("{guard} {{ {} }}", operand.trim())
        })
        .collect::<Vec<_>>()
        .join("; ");
    Rewrite {
        cmd: rewritten,
        notes: vec!["Windows PowerShell 5.1 cannot parse && or ||, so this simple chain was rewritten as guards on `$?`.".to_owned()],
    }
}

/// Only Windows PowerShell 5.1 is named `powershell`; PowerShell 7 is `pwsh`.
fn is_windows_powershell_5(path: &str) -> bool {
    let tail = path
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    tail == "powershell" || tail == "powershell.exe"
}

// ------------------------------------------------------------------ quoting repair

/// Whether PowerShell reaches the end of the line with every quote closed. A backslash is an
/// ordinary character to PowerShell, which is the whole problem being repaired.
fn powershell_quoting_terminates(command: &[char]) -> bool {
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < command.len() {
        let c = command[i];
        match quote {
            None => {
                if c == '"' || c == '\'' {
                    quote = Some(c);
                }
            }
            Some('"') if c == '`' => i += 1,
            Some(open) if c == open => {
                if command.get(i + 1) == Some(&open) {
                    i += 1;
                } else {
                    quote = None;
                }
            }
            Some(_) => {}
        }
        i += 1;
    }
    quote.is_none()
}

/// A double-quoted string as bash reads it: char offsets of both quotes.
#[derive(Clone, Copy)]
struct Region {
    open: usize,
    close: usize,
}

/// The double-quoted strings under bash's escape rules, or `None` when even that reading
/// leaves a quote open.
fn bash_double_quoted_regions(command: &[char]) -> Option<Vec<Region>> {
    let mut regions = Vec::new();
    let mut quote: Option<char> = None;
    let mut open = 0;
    let mut i = 0;
    while i < command.len() {
        let c = command[i];
        match quote {
            None => {
                if c == '\\' {
                    i += 1;
                } else if c == '"' {
                    quote = Some('"');
                    open = i;
                } else if c == '\'' {
                    quote = Some('\'');
                }
            }
            Some('"') => {
                if c == '\\' {
                    i += 1;
                } else if c == '"' {
                    regions.push(Region { open, close: i });
                    quote = None;
                }
            }
            Some(_) => {
                if c == '\'' {
                    quote = None;
                }
            }
        }
        i += 1;
    }
    quote.is_none().then_some(regions)
}

/// The statement/pipeline prefix right before `end`, read under bash's rules.
fn bash_segment_prefix(command: &[char], end: usize) -> Option<String> {
    let mut quote: Option<char> = None;
    let mut depth = 0usize;
    let mut start = 0;
    let mut i = 0;
    while i < end {
        let c = command[i];
        match quote {
            Some('"') => {
                if c == '\\' {
                    i += 1;
                } else if c == '"' {
                    quote = None;
                }
                i += 1;
                continue;
            }
            Some(_) => {
                if c == '\'' {
                    quote = None;
                }
                i += 1;
                continue;
            }
            None => {}
        }
        if c == '\\' {
            i += 2;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            i += 1;
            continue;
        }
        if c == '(' || c == '{' {
            depth += 1;
            i += 1;
            continue;
        }
        if c == ')' || c == '}' {
            depth = depth.saturating_sub(1);
            i += 1;
            continue;
        }
        if depth != 0 {
            i += 1;
            continue;
        }
        if matches!(c, ';' | '|' | '\n' | '\r') {
            start = i + 1;
            let next = command.get(i + 1).copied();
            if (c == '|' && next == Some('|')) || (c == '\r' && next == Some('\n')) {
                i += 1;
                start = i + 1;
            }
        } else if c == '&' && command.get(i + 1) == Some(&'&') {
            i += 1;
            start = i + 1;
        }
        i += 1;
    }
    (quote.is_none() && depth == 0).then(|| command[start..end.min(command.len())].iter().collect())
}

const RG_VALUE_FLAGS: &[&str] = &[
    "--after-context",
    "--before-context",
    "--color",
    "--colors",
    "--context",
    "--context-separator",
    "--dfa-size-limit",
    "--encoding",
    "--engine",
    "--field-context-separator",
    "--field-match-separator",
    "--file",
    "--generate",
    "--glob",
    "--hostname-bin",
    "--hyperlink-format",
    "--iglob",
    "--ignore-file",
    "--max-columns",
    "--max-count",
    "--max-depth",
    "--max-filesize",
    "--path-separator",
    "--pre",
    "--pre-glob",
    "--regex-size-limit",
    "--regexp",
    "--replace",
    "--sort",
    "--sortr",
    "--threads",
    "--type",
    "--type-add",
    "--type-clear",
    "--type-not",
    "-A",
    "-B",
    "-C",
    "-E",
    "-M",
    "-T",
    "-d",
    "-e",
    "-f",
    "-g",
    "-j",
    "-m",
    "-r",
    "-t",
];

const RG_BOOLEAN_FLAGS: &[&str] = &[
    "--auto-hybrid-regex",
    "--binary",
    "--block-buffered",
    "--byte-offset",
    "--case-sensitive",
    "--column",
    "--count",
    "--count-matches",
    "--crlf",
    "--debug",
    "--files",
    "--files-with-matches",
    "--files-without-match",
    "--fixed-strings",
    "--follow",
    "--glob-case-insensitive",
    "--heading",
    "--help",
    "--hidden",
    "--ignore-case",
    "--ignore-file-case-insensitive",
    "--include-zero",
    "--invert-match",
    "--json",
    "--line-buffered",
    "--line-number",
    "--line-regexp",
    "--max-columns-preview",
    "--mmap",
    "--multiline",
    "--multiline-dotall",
    "--no-config",
    "--no-filename",
    "--no-ignore",
    "--no-ignore-dot",
    "--no-ignore-exclude",
    "--no-ignore-files",
    "--no-ignore-global",
    "--no-ignore-messages",
    "--no-ignore-parent",
    "--no-ignore-vcs",
    "--no-line-number",
    "--no-messages",
    "--no-pcre2-unicode",
    "--no-require-git",
    "--no-unicode",
    "--null",
    "--null-data",
    "--one-file-system",
    "--only-matching",
    "--passthru",
    "--pcre2",
    "--pcre2-version",
    "--pretty",
    "--quiet",
    "--search-zip",
    "--smart-case",
    "--sort-files",
    "--stats",
    "--stop-on-nonmatch",
    "--text",
    "--trace",
    "--trim",
    "--type-list",
    "--unrestricted",
    "--version",
    "--vimgrep",
    "--with-filename",
    "--word-regexp",
    "-.",
    "-0",
    "-F",
    "-H",
    "-I",
    "-L",
    "-N",
    "-P",
    "-S",
    "-U",
    "-V",
    "-a",
    "-b",
    "-c",
    "-h",
    "-i",
    "-l",
    "-n",
    "-o",
    "-p",
    "-q",
    "-s",
    "-u",
    "-v",
    "-w",
    "-x",
    "-z",
];

/// The bare program name: last path segment, lowercased, without `.exe` only.
pub(crate) fn program_name(token: Option<&Token>) -> String {
    let Some(token) = token else {
        return String::new();
    };
    let tail = token
        .value
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default()
        .to_lowercase();
    tail.strip_suffix(".exe").map(str::to_owned).unwrap_or(tail)
}

/// Whether the next argument after `tokens` is ripgrep's search-pattern slot.
fn next_ripgrep_argument_is_pattern(tokens: &[Token]) -> bool {
    if !matches!(program_name(tokens.first()).as_str(), "rg" | "ripgrep") {
        return false;
    }
    let mut seen_pattern = false;
    let mut options_ended = false;
    let mut pending: Option<bool> = None;
    for token in &tokens[1..] {
        if let Some(is_pattern) = pending.take() {
            if is_pattern {
                seen_pattern = true;
            }
            continue;
        }
        if !options_ended && token.value == "--" {
            options_ended = true;
            continue;
        }
        if !options_ended && token.value.starts_with('-') {
            let flag = token.value.split('=').next().unwrap_or_default();
            let takes_value = RG_VALUE_FLAGS.contains(&flag);
            if !takes_value && !RG_BOOLEAN_FLAGS.contains(&flag) {
                return false;
            }
            if matches!(flag, "--files" | "--type-list") {
                seen_pattern = true;
            }
            if takes_value {
                let pattern_flag = matches!(flag, "-e" | "--regexp" | "-f" | "--file");
                if token.value.contains('=') {
                    seen_pattern |= pattern_flag;
                } else {
                    pending = Some(pattern_flag);
                }
            }
            continue;
        }
        seen_pattern = true;
    }
    match pending {
        Some(is_pattern) => is_pattern,
        None => !seen_pattern,
    }
}

fn is_ripgrep_pattern_region(command: &[char], region: Region) -> bool {
    let before = region.open.checked_sub(1).map(|i| command[i]);
    let after = command.get(region.close + 1).copied();
    if before.is_some_and(|c| !is_js_space(c)) {
        return false;
    }
    if after.is_some_and(|c| !(is_js_space(c) || matches!(c, ';' | '|' | '&' | '\r' | '\n' | ')')))
    {
        return false;
    }
    bash_segment_prefix(command, region.open)
        .is_some_and(|prefix| next_ripgrep_argument_is_pattern(&tokenize(&prefix)))
}

/// `repairPowerShellQuoting`: a bash-style `\"` inside a double-quoted argument, which
/// PowerShell reads as the end of the string, is re-quoted with single quotes, and in a proven
/// ripgrep regex slot the quote becomes `\x22`. Acts only when bash's reading closes every
/// quote and the repaired line closes every quote under PowerShell's rules.
pub(crate) fn repair_powershell_quoting(cmd: &str, kind: ShellKind) -> Rewrite {
    if kind != ShellKind::PowerShell || !cmd.contains("\\\"") {
        return Rewrite::unchanged(cmd);
    }
    let chars: Vec<char> = cmd.chars().collect();
    let balanced = powershell_quoting_terminates(&chars);
    if balanced && has_unsupported_lexemes(cmd) {
        return Rewrite::unchanged(cmd);
    }
    let Some(regions) = bash_double_quoted_regions(&chars) else {
        return Rewrite::unchanged(cmd);
    };
    // The same offsets with escaped quotes masked, for reading flags around each region.
    let mut shape = chars.clone();
    for region in &regions {
        let mut i = region.open + 1;
        while i + 1 < region.close {
            if shape[i] == '\\' && shape[i + 1] == '"' {
                shape[i] = '_';
                shape[i + 1] = '_';
                i += 2;
            } else {
                i += 1;
            }
        }
    }

    let mut out = String::new();
    let mut cursor = 0;
    let mut repaired = 0;
    let mut regex_quotes = false;
    for region in &regions {
        let body: String = chars[region.open + 1..region.close].iter().collect();
        if !body.contains("\\\"") {
            continue;
        }
        let pattern_slot = is_ripgrep_pattern_region(&chars, *region);
        if balanced && !pattern_slot {
            continue;
        }
        if body.contains(['$', '`']) || body.contains("\\\\") {
            continue;
        }
        let rest: String = shape[region.close + 1..].iter().collect();
        let suffix = split_top_level(&rest, &[";", "|", "&&", "||", "\n"], None)
            .into_iter()
            .next()
            .unwrap_or_default();
        let pattern_command = format!(
            "{} {suffix}",
            bash_segment_prefix(&shape, region.open).unwrap_or_default()
        );
        let regex_pattern = pattern_slot
            && !body.contains("\\Q")
            && !body.contains("\\E")
            && !pattern_command.contains(['`', '$', '#'])
            && !tokenize(&pattern_command).iter().any(|token| {
                token.value == "--fixed-strings"
                    || token.value.strip_prefix('-').is_some_and(|flags| {
                        flags.split('-').next().is_some_and(|run| run.contains('F'))
                    })
            });
        let body = if regex_pattern {
            body.replace("\\\"", "\\x22")
        } else {
            body
        };
        regex_quotes |= regex_pattern;
        out.extend(&chars[cursor..region.open]);
        out.push_str(&quote_powershell(&body));
        cursor = region.close + 1;
        repaired += 1;
    }
    if repaired == 0 {
        return Rewrite::unchanged(cmd);
    }
    out.extend(&chars[cursor..]);
    if !powershell_quoting_terminates(&out.chars().collect::<Vec<_>>()) {
        return Rewrite::unchanged(cmd);
    }
    let detail = if regex_quotes {
        " In ripgrep regex patterns, literal double quotes use \\x22 to preserve one native argument on Windows PowerShell and pwsh."
    } else {
        " Native embedded-quote handling also depends on the shell; use a script file for complex code arguments."
    };
    Rewrite {
        cmd: out,
        notes: vec![format!(
            "PowerShell does not use backslash to escape quotes. Re-quoted the affected argument with single quotes.{detail}"
        )],
    }
}

/// The advisory notes of an exec result, one `Note:` line each.
pub(crate) fn notes_text(notes: &[String]) -> String {
    notes
        .iter()
        .map(|note| format!("Note: {note}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PS: ShellKind = ShellKind::PowerShell;

    #[test]
    fn an_unbalanced_bash_escape_is_requoted() {
        let fixed = repair_powershell_quoting(r#"git diff; Write-Output "say \"hi now""#, PS);
        assert_eq!(fixed.cmd, r#"git diff; Write-Output 'say \"hi now'"#);
        assert_eq!(fixed.notes.len(), 1);
    }

    #[test]
    fn a_ripgrep_pattern_gets_a_hex_quote() {
        let fixed = repair_powershell_quoting(r#"rg -n "a|state === \"starting" src"#, PS);
        assert_eq!(fixed.cmd, r#"rg -n 'a|state === \x22starting' src"#);
        assert!(fixed.notes[0].contains(r"\x22"));
    }

    #[test]
    fn fixed_strings_never_get_regex_escapes() {
        let fixed = repair_powershell_quoting(r#"rg -F "say \"hi" src"#, PS);
        assert_eq!(fixed.cmd, r#"rg -F 'say \"hi' src"#);
    }

    #[test]
    fn interpolation_and_other_shells_are_left_alone() {
        let line = r#"Write-Output "$env:X \"y""#;
        assert_eq!(repair_powershell_quoting(line, PS).cmd, line);
        let line = r#"echo "a \"b\"""#;
        assert_eq!(repair_powershell_quoting(line, ShellKind::Bash).cmd, line);
    }

    #[test]
    fn a_balanced_non_pattern_argument_is_not_touched() {
        let line = r#"Write-Output "a \"b\" c""#;
        assert_eq!(repair_powershell_quoting(line, PS).cmd, line);
    }

    #[test]
    fn bare_rg_binds_to_the_shipped_binary() {
        let bound = bind_bundled_ripgrep(
            "rg -n x . | Select-Object -First 3; git status",
            PS,
            Some(r"C:\app\rg.exe"),
        );
        assert_eq!(
            bound,
            r"& 'C:\app\rg.exe' -n x . | Select-Object -First 3; git status"
        );
        assert_eq!(
            bind_bundled_ripgrep("rg x", ShellKind::Cmd, Some("rg.exe")),
            "rg x"
        );
        assert_eq!(
            bind_bundled_ripgrep("C:/x/rg.exe y", PS, Some("rg.exe")),
            "C:/x/rg.exe y"
        );
    }

    #[test]
    fn short_chains_become_guards_on_windows_powershell() {
        let shell = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        let fixed = normalize_powershell_operators("cd src && npm test || echo failed", PS, shell);
        assert_eq!(
            fixed.cmd,
            "cd src; if ($?) { npm test }; if (-not $?) { echo failed }"
        );
        assert_eq!(
            normalize_powershell_operators("a && b", PS, r"C:\pwsh\pwsh.exe").cmd,
            "a && b"
        );
        assert_eq!(
            normalize_powershell_operators("a > x && b", PS, shell).cmd,
            "a > x && b"
        );
    }
}
