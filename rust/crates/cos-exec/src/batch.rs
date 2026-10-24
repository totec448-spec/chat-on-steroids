//! `exec_command` with `cmds`: one shell program that runs each command in turn, labels each
//! section with a per-call random marker and exits with the first non-zero code
//! (`command-batch.ts`).

use crate::shell::ShellKind;

/// 12 random bytes as 24 hex characters: the framing no command output can forge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BatchMarker(String);

impl BatchMarker {
    pub(crate) fn new() -> Self {
        Self(crate::random::hex(12))
    }

    fn delimiter(&self) -> Vec<u8> {
        format!(" [clf-batch:{}]", self.0).into_bytes()
    }
}

fn banner(index: usize, count: usize, marker: &BatchMarker) -> String {
    format!("--- command {index}/{count} --- [clf-batch:{}]", marker.0)
}

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = u32::from(chunk[0]) << 16
            | u32::from(chunk.get(1).copied().unwrap_or(0)) << 8
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(TABLE[(n >> (18 - 6 * i) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `composeCommandBatch`.
pub(crate) fn compose(commands: &[String], kind: ShellKind, marker: &BatchMarker) -> String {
    match kind {
        ShellKind::PowerShell => powershell(commands, marker),
        ShellKind::Cmd => cmd(commands, marker),
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Sh => posix(commands, marker),
    }
}

fn powershell(commands: &[String], marker: &BatchMarker) -> String {
    let encoded: Vec<String> = commands
        .iter()
        .map(|command| format!("'{}'", base64(command.as_bytes())))
        .collect();
    let m = &marker.0;
    [
        format!("$__cos_batch_commands = @({})", encoded.join(", ")),
        "$__cos_batch_exit = 0".to_owned(),
        "for ($__cos_batch_index = 0; $__cos_batch_index -lt $__cos_batch_commands.Count; $__cos_batch_index++) {".to_owned(),
        format!("  [Console]::Out.WriteLine((\"--- command {{0}}/{{1}} --- [clf-batch:{m}]\" -f ($__cos_batch_index + 1), $__cos_batch_commands.Count))"),
        "  $global:LASTEXITCODE = 0".to_owned(),
        "  try {".to_owned(),
        "    $__cos_batch_text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__cos_batch_commands[$__cos_batch_index]))".to_owned(),
        "    . ([ScriptBlock]::Create($__cos_batch_text))".to_owned(),
        "    $__cos_batch_succeeded = $?".to_owned(),
        "    $__cos_batch_code = if ($LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } elseif ($__cos_batch_succeeded) { 0 } else { 1 }".to_owned(),
        "  } catch {".to_owned(),
        "    [Console]::Error.WriteLine($_.ToString())".to_owned(),
        "    $__cos_batch_code = 1".to_owned(),
        "  }".to_owned(),
        format!("  [Console]::Out.WriteLine((\"--- exit code {{0}} --- [clf-batch:{m}]\" -f $__cos_batch_code))"),
        "  if ($__cos_batch_code -ne 0 -and $__cos_batch_exit -eq 0) { $__cos_batch_exit = $__cos_batch_code }".to_owned(),
        "}".to_owned(),
        "exit $__cos_batch_exit".to_owned(),
    ]
    .join("\n")
}

fn posix(commands: &[String], marker: &BatchMarker) -> String {
    let mut lines = vec!["__cos_batch_exit=0".to_owned()];
    for (index, command) in commands.iter().enumerate() {
        lines.push(format!(
            "printf '%s\\n' {}",
            single_quote(&banner(index + 1, commands.len(), marker))
        ));
        lines.push(format!("eval {}", single_quote(command)));
        lines.push("__cos_batch_code=$?".to_owned());
        lines.push(format!(
            "printf '%s\\n' \"--- exit code $__cos_batch_code --- [clf-batch:{}]\"",
            marker.0
        ));
        lines.push("if [ \"$__cos_batch_code\" -ne 0 ] && [ \"$__cos_batch_exit\" -eq 0 ]; then __cos_batch_exit=$__cos_batch_code; fi".to_owned());
    }
    lines.push("exit \"$__cos_batch_exit\"".to_owned());
    lines.join("\n")
}

fn cmd(commands: &[String], marker: &BatchMarker) -> String {
    let mut lines = vec![
        "@echo off".to_owned(),
        "set \"__cos_batch_exit=0\"".to_owned(),
    ];
    for (index, command) in commands.iter().enumerate() {
        lines.push(format!(
            "echo {}",
            banner(index + 1, commands.len(), marker)
        ));
        lines.push(format!("call {command}"));
        lines.push("set \"__cos_batch_code=%errorlevel%\"".to_owned());
        lines.push(format!(
            "echo --- exit code %__cos_batch_code% --- [clf-batch:{}]",
            marker.0
        ));
        lines.push("if not \"%__cos_batch_code%\"==\"0\" if \"%__cos_batch_exit%\"==\"0\" set \"__cos_batch_exit=%__cos_batch_code%\"".to_owned());
    }
    lines.push("exit /b %__cos_batch_exit%".to_owned());
    lines.join("\r\n")
}

/// Removes this batch's private delimiter from the stream the model reads. At most one
/// delimiter's prefix waits for the next chunk (`CommandBatchDisplay`).
#[derive(Debug)]
pub(crate) struct BatchDisplay {
    delimiter: Vec<u8>,
    pending: Vec<u8>,
}

impl BatchDisplay {
    pub(crate) fn new(marker: &BatchMarker) -> Self {
        Self {
            delimiter: marker.delimiter(),
            pending: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8], last: bool) -> Vec<u8> {
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(chunk);
        let mut out = Vec::with_capacity(input.len());
        let mut start = 0;
        while let Some(at) = find(&input[start..], &self.delimiter) {
            out.extend_from_slice(&input[start..start + at]);
            start += at + self.delimiter.len();
        }
        let mut end = input.len();
        if !last {
            let longest = (self.delimiter.len() - 1).min(end - start);
            for length in (1..=longest).rev() {
                if input[end - length..] == self.delimiter[..length] {
                    end -= length;
                    break;
                }
            }
        }
        self.pending = input[end..].to_vec();
        out.extend_from_slice(&input[start..end]);
        out
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// One command's slice of a batch result, recovered from the authenticated framing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Section {
    /// 1-based, as the banner states it.
    pub index: usize,
    pub exit_code: i64,
    pub text: String,
}

/// `parseCommandBatchSections`: only sections with both a banner and an exit marker.
pub(crate) fn parse_sections(output: &str, marker: &BatchMarker) -> Vec<Section> {
    let tag = format!(" --- [clf-batch:{}]", marker.0);
    let lines: Vec<&str> = output
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let banner_of = |line: &str| -> Option<(usize, usize)> {
        let body = line.strip_prefix("--- command ")?.strip_suffix(&tag)?;
        let (index, count) = body.split_once('/')?;
        Some((index.parse().ok()?, count.parse().ok()?))
    };
    let exit_of = |line: &str| -> Option<i64> {
        line.strip_prefix("--- exit code ")?
            .strip_suffix(&tag)?
            .parse()
            .ok()
    };
    let Some(first) = lines
        .iter()
        .position(|line| banner_of(line).is_some_and(|(index, _)| index == 1))
    else {
        return Vec::new();
    };
    let count = banner_of(lines[first]).map_or(0, |(_, count)| count);
    let mut sections = Vec::new();
    let mut open: Option<(usize, Vec<&str>)> = None;
    for line in &lines[first..] {
        if let Some((index, total)) = banner_of(line)
            && total == count
        {
            open = Some((index, Vec::new()));
            continue;
        }
        let Some((index, body)) = open.as_mut() else {
            continue;
        };
        if let Some(exit_code) = exit_of(line) {
            sections.push(Section {
                index: *index,
                exit_code,
                text: body.join("\n"),
            });
            open = None;
            continue;
        }
        body.push(line);
    }
    sections
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker() -> BatchMarker {
        BatchMarker("0123456789abcdef01234567".to_owned())
    }

    #[test]
    fn display_drops_the_delimiter_even_across_chunks() {
        let marker = marker();
        let mut display = BatchDisplay::new(&marker);
        let raw = format!("--- command 1/1 --- [clf-batch:{}]\r\nok\r\n", marker.0);
        let (a, b) = raw.as_bytes().split_at(25);
        let mut out = display.push(a, false);
        out.extend(display.push(b, false));
        out.extend(display.push(b"", true));
        assert_eq!(
            String::from_utf8_lossy(&out),
            "--- command 1/1 ---\r\nok\r\n"
        );
    }

    #[test]
    fn sections_need_both_banner_and_exit_marker() {
        let marker = marker();
        let m = &marker.0;
        let output = format!(
            "--- command 1/2 --- [clf-batch:{m}]\r\nfirst\r\n--- exit code 0 --- [clf-batch:{m}]\r\n--- command 2/2 --- [clf-batch:{m}]\r\n--- exit code 1 --- [forged]\r\n"
        );
        let sections = parse_sections(&output, &marker);
        assert_eq!(
            sections,
            [Section {
                index: 1,
                exit_code: 0,
                text: "first".to_owned()
            }]
        );
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b"Write-Output first"), "V3JpdGUtT3V0cHV0IGZpcnN0");
        assert_eq!(base64(b"ab"), "YWI=");
    }
}
