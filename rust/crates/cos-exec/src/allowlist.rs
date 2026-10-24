//! The command allow/deny list from Settings (`src/shared/command-allowlist.ts`).
//!
//! A command is compared as an executable and its complete literal argument list. Anything the
//! small parser cannot read without guessing (operators, expansion, globs, escapes) is refused
//! while the policy is on, because a guessed argument list is not a decision.

use crate::shell::ShellKind;

pub const MAX_RULE_CHARS: usize = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyMode {
    Allow,
    Deny,
}

/// `commandAllowlist` from the settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandPolicy {
    pub enabled: bool,
    pub mode: PolicyMode,
    pub rules: Vec<String>,
}

impl CommandPolicy {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            mode: PolicyMode::Allow,
            rules: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    Unsupported,
    Unmatched,
    Denied,
    InvalidPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    /// The parsed argument lists, one per command (empty while the policy is off).
    Allowed(Vec<Vec<String>>),
    Refused {
        command_index: usize,
        kind: Refusal,
        detail: String,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Command,
    Rule,
}

/// The shell dialect a text is read in. Rules are written shell-neutrally.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Dialect {
    Shell(ShellKind),
    Neutral,
}

impl Dialect {
    fn posix(self) -> bool {
        matches!(self, Self::Shell(kind) if kind.is_posix())
    }
    fn is(self, kind: ShellKind) -> bool {
        self == Self::Shell(kind)
    }
}

struct Invocation {
    args: Vec<String>,
    wildcard: bool,
}

fn parse(source: &str, dialect: Dialect, mode: Mode) -> Result<Invocation, String> {
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    let mut args = Vec::new();
    let mut wildcard = false;
    let skip_space = |index: &mut usize| {
        while matches!(chars.get(*index), Some(' ' | '\t')) {
            *index += 1;
        }
    };

    skip_space(&mut index);
    if mode == Mode::Command && dialect.is(ShellKind::PowerShell) && chars.get(index) == Some(&'&')
    {
        if !matches!(chars.get(index + 1), Some(' ' | '\t')) {
            return Err("PowerShell call operator & must be followed by an executable.".into());
        }
        index += 1;
        skip_space(&mut index);
    }

    while index < chars.len() {
        if matches!(chars[index], '\r' | '\n') {
            return Err("Newlines are not supported.".into());
        }
        if mode == Mode::Rule && chars[index] == '*' {
            let rest: String = chars[index + 1..].iter().collect();
            if args.is_empty() || !rest.trim().is_empty() {
                return Err(
                    "The wildcard must be a standalone final argument after an executable.".into(),
                );
            }
            wildcard = true;
            break;
        }

        let mut value = String::new();
        let mut has_segment = false;
        while index < chars.len() && !matches!(chars[index], ' ' | '\t') {
            let character = chars[index];
            if matches!(character, '\r' | '\n') {
                return Err("Newlines are not supported.".into());
            }
            if character == '"' || character == '\'' {
                if character == '\'' && dialect.is(ShellKind::Cmd) {
                    return Err("Single quotes do not quote arguments in cmd.exe.".into());
                }
                if has_segment {
                    return Err("Quoted arguments must be wholly quoted.".into());
                }
                let quote = character;
                has_segment = true;
                index += 1;
                let mut closed = false;
                while index < chars.len() {
                    let quoted = chars[index];
                    if quoted == quote {
                        closed = true;
                        index += 1;
                        break;
                    }
                    if matches!(quoted, '\r' | '\n') {
                        return Err("Newlines are not supported.".into());
                    }
                    if quote == '"' {
                        if dialect.posix() && matches!(quoted, '$' | '`' | '\\') {
                            return Err(
                                "Expansion and escaping inside double quotes are not supported."
                                    .into(),
                            );
                        }
                        if dialect.is(ShellKind::PowerShell) && matches!(quoted, '$' | '`') {
                            return Err("PowerShell expansion and escaping inside double quotes are not supported.".into());
                        }
                        if dialect.is(ShellKind::Cmd) && matches!(quoted, '%' | '!') {
                            return Err("cmd.exe variable expansion is not supported.".into());
                        }
                    }
                    value.push(quoted);
                    index += 1;
                }
                if !closed {
                    let kind = if quote == '"' { "double" } else { "single" };
                    return Err(format!("Unclosed {kind} quote."));
                }
                if index < chars.len() && !matches!(chars[index], ' ' | '\t') {
                    return Err("Quoted arguments must be wholly quoted.".into());
                }
                continue;
            }

            let common_operator = "|;&<>(){}\r\n".contains(character);
            let expansion = matches!(character, '$' | '`');
            let glob = matches!(character, '*' | '?' | '[' | ']');
            let comment = character == '#';
            let posix_escape = character == '\\' && dialect.posix();
            let posix_tilde = character == '~' && dialect.posix();
            let cmd_escape = dialect.is(ShellKind::Cmd) && matches!(character, '^' | '%' | '!');
            let powershell_syntax = dialect.is(ShellKind::PowerShell)
                && (character == ',' || character == '`' || (character == '@' && value.is_empty()));
            if common_operator
                || expansion
                || glob
                || comment
                || posix_escape
                || posix_tilde
                || cmd_escape
                || powershell_syntax
            {
                return Err(format!(
                    "Unsupported shell syntax {}.",
                    serde_json::to_string(&character.to_string()).unwrap_or_default()
                ));
            }
            has_segment = true;
            value.push(character);
            index += 1;
        }
        if !has_segment {
            return Err("Expected a literal argument.".into());
        }
        args.push(value);
        skip_space(&mut index);
    }

    if args.is_empty() {
        return Err("The command is empty.".into());
    }
    if mode == Mode::Command && dialect.posix() && is_env_assignment(&args[0]) {
        return Err("Leading environment assignments are not supported.".into());
    }
    Ok(Invocation { args, wildcard })
}

fn is_env_assignment(arg: &str) -> bool {
    let Some((name, _)) = arg.split_once('=') else {
        return false;
    };
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `validateCommandAllowlistRule`: `None` when the rule is usable.
pub fn validate_rule(rule: &str) -> Option<String> {
    if rule.chars().count() > MAX_RULE_CHARS {
        return Some(format!("Rule is longer than {MAX_RULE_CHARS} characters."));
    }
    parse(rule.trim(), Dialect::Neutral, Mode::Rule).err()
}

fn matches(rule: &Invocation, args: &[String]) -> bool {
    let length_ok = if rule.wildcard {
        args.len() >= rule.args.len()
    } else {
        args.len() == rule.args.len()
    };
    length_ok && rule.args.iter().zip(args).all(|(rule, arg)| rule == arg)
}

/// `evaluateCommandAllowlist`: one decision for a whole batch.
pub(crate) fn evaluate(policy: &CommandPolicy, commands: &[String], shell: ShellKind) -> Decision {
    if !policy.enabled {
        return Decision::Allowed(Vec::new());
    }
    let mut rules = Vec::with_capacity(policy.rules.len());
    for (index, rule) in policy.rules.iter().enumerate() {
        if let Some(message) = validate_rule(rule) {
            return Decision::Refused {
                command_index: 0,
                kind: Refusal::InvalidPolicy,
                detail: format!("Saved rule {} is invalid: {message}", index + 1),
            };
        }
        match parse(rule.trim(), Dialect::Neutral, Mode::Rule) {
            Ok(rule) => rules.push(rule),
            Err(message) => {
                return Decision::Refused {
                    command_index: 0,
                    kind: Refusal::InvalidPolicy,
                    detail: format!("Saved rule {} is invalid: {message}", index + 1),
                };
            }
        }
    }

    let mut parsed = Vec::with_capacity(commands.len());
    for (index, command) in commands.iter().enumerate() {
        let invocation = match parse(command, Dialect::Shell(shell), Mode::Command) {
            Ok(invocation) => invocation,
            Err(detail) => {
                return Decision::Refused {
                    command_index: index,
                    kind: Refusal::Unsupported,
                    detail,
                };
            }
        };
        let matched = rules
            .iter()
            .position(|rule| matches(rule, &invocation.args));
        match (policy.mode, matched) {
            (PolicyMode::Allow, None) => {
                return Decision::Refused {
                    command_index: index,
                    kind: Refusal::Unmatched,
                    detail: "No allowlist rule matched the executable and complete argument list."
                        .into(),
                };
            }
            (PolicyMode::Deny, Some(rule)) => {
                return Decision::Refused {
                    command_index: index,
                    kind: Refusal::Denied,
                    detail: format!(
                        "Denylist rule {} matched the executable and complete argument list.",
                        rule + 1
                    ),
                };
            }
            _ => {}
        }
        parsed.push(invocation.args);
    }
    Decision::Allowed(parsed)
}

/// `commandHasSameArguments`: whether normalization left the authorized argument list intact.
pub(crate) fn same_arguments(expected: &[String], command: &str, shell: ShellKind) -> bool {
    parse(command, Dialect::Shell(shell), Mode::Command)
        .is_ok_and(|invocation| invocation.args == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(mode: PolicyMode, rules: &[&str]) -> CommandPolicy {
        CommandPolicy {
            enabled: true,
            mode,
            rules: rules.iter().map(|rule| (*rule).to_owned()).collect(),
        }
    }

    fn eval(policy: &CommandPolicy, commands: &[&str], shell: ShellKind) -> Decision {
        let commands: Vec<String> = commands.iter().map(|c| (*c).to_owned()).collect();
        evaluate(policy, &commands, shell)
    }

    #[test]
    fn an_off_policy_allows_everything() {
        assert_eq!(
            eval(&CommandPolicy::disabled(), &["rm -rf /"], ShellKind::Bash),
            Decision::Allowed(Vec::new())
        );
    }

    #[test]
    fn allow_rules_match_whole_argument_lists_and_wildcards() {
        let policy = policy(PolicyMode::Allow, &["git status", "npm test *"]);
        assert!(matches!(
            eval(&policy, &["git status"], ShellKind::PowerShell),
            Decision::Allowed(_)
        ));
        assert!(matches!(
            eval(&policy, &["npm test -- --watch"], ShellKind::PowerShell),
            Decision::Allowed(_)
        ));
        assert!(matches!(
            eval(&policy, &["git status --short"], ShellKind::PowerShell),
            Decision::Refused {
                kind: Refusal::Unmatched,
                ..
            }
        ));
    }

    #[test]
    fn deny_rules_name_the_rule_and_batches_name_the_command() {
        let policy = policy(PolicyMode::Deny, &["git push *"]);
        assert_eq!(
            eval(&policy, &["git status", "git push origin"], ShellKind::Bash),
            Decision::Refused {
                command_index: 1,
                kind: Refusal::Denied,
                detail: "Denylist rule 1 matched the executable and complete argument list.".into()
            }
        );
    }

    #[test]
    fn shell_syntax_is_refused_rather_than_guessed() {
        let policy = policy(PolicyMode::Allow, &["git status"]);
        assert_eq!(
            eval(&policy, &["git status; rm x"], ShellKind::PowerShell),
            Decision::Refused {
                command_index: 0,
                kind: Refusal::Unsupported,
                detail: "Unsupported shell syntax \";\".".into()
            }
        );
        assert!(matches!(
            eval(&policy, &["echo \"$HOME\""], ShellKind::Bash),
            Decision::Refused {
                kind: Refusal::Unsupported,
                ..
            }
        ));
        assert!(matches!(
            eval(&policy, &["FOO=1 git status"], ShellKind::Bash),
            Decision::Refused {
                kind: Refusal::Unsupported,
                ..
            }
        ));
    }

    #[test]
    fn powershell_call_operator_reaches_the_executable() {
        let policy = policy(PolicyMode::Allow, &["C:/tools/rg.exe -n x"]);
        assert!(matches!(
            eval(
                &policy,
                &["& 'C:/tools/rg.exe' -n x"],
                ShellKind::PowerShell
            ),
            Decision::Allowed(_)
        ));
    }

    #[test]
    fn invalid_saved_rules_refuse_the_launch() {
        let policy = policy(PolicyMode::Allow, &["* git"]);
        assert!(matches!(
            eval(&policy, &["git"], ShellKind::Bash),
            Decision::Refused {
                kind: Refusal::InvalidPolicy,
                ..
            }
        ));
    }
}
