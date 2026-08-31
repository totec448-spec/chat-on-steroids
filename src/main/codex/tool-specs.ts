/**
 * The model-visible text of Codex's tool specs, copied verbatim from
 * `codex-rs/core/src/tools/handlers/shell_spec.rs`, `view_image_spec.rs` and
 * `apply_patch_spec.rs`.
 *
 * These strings are the tools' actual contract with the model, so they live in one place and are
 * quoted exactly. Where Codex switches on `cfg!(windows)` this switches on `process.platform`,
 * which is the same decision made at run time instead of compile time.
 */

import { defaultUserShell, isWindowsPowerShell5 } from './shell.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Whether the shell `exec_command` launches is the one without `&&` and `||`.
 *
 * Not the same question as "is this Windows": `defaultUserShell()` prefers `pwsh.exe`, so on a
 * PowerShell 7 machine the operators work and saying otherwise would cost the model a working line.
 */
export const LAUNCHES_WINDOWS_POWERSHELL_5 = IS_WINDOWS && isWindowsPowerShell5(defaultUserShell().shellPath);

/** `windows_shell_guidance()`. */
export const WINDOWS_SHELL_GUIDANCE = `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;

export const EXEC_COMMAND_DESCRIPTION = IS_WINDOWS
  ? `Runs a command in a PTY, returning output or a session ID for ongoing interaction. Every returned session ID must be polled with write_stdin until its terminal result is returned.\n\n${WINDOWS_SHELL_GUIDANCE}`
  : 'Runs a command in a PTY, returning output or a session ID for ongoing interaction. Every returned session ID must be polled with write_stdin until its terminal result is returned.';

/**
 * Codex's text is 'Shell command to execute.'; two measured additions.
 *
 * Windows PowerShell 5.1 has no `&&` or `||` at all, and recorded sessions show the model reaching
 * for them and getting a parse error that names the token without saying the feature is missing.
 * Separately, 109 recorded exec calls were a file being read through the shell, which `read` does
 * better and without the exec capability. Both live on the parameter because `tools/list` is
 * re-sent every turn while the session instructions are read once.
 */
export const EXEC_COMMAND_CMD_DESCRIPTION = LAUNCHES_WINDOWS_POWERSHELL_5
  ? 'Shell command to execute. To read a file, use the read tool instead. This shell is Windows PowerShell 5.1, which has no && or ||: use the cmds array for a sequence, or A; if ($?) { B }.'
  : 'Shell command to execute. To read a file, use the read tool instead.';

export const EXEC_COMMAND_CMDS_DESCRIPTION =
  'Sequential shell commands to run in one shell session. Use this for related checks instead of separate exec_command calls. Each command gets a labeled output section and exit code; all commands run after ordinary non-zero exits, and the overall exit code is the first non-zero code.';

export const EXEC_COMMAND_WORKDIR_DESCRIPTION = 'Working directory for the command. Defaults to the turn cwd.';

export const EXEC_COMMAND_TTY_DESCRIPTION =
  'True allocates a PTY for the command; false or omitted uses plain pipes.';

export const EXEC_COMMAND_YIELD_TIME_DESCRIPTION = IS_WINDOWS
  ? 'Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 250-30000 ms.'
  : 'Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.';

/**
 * `max_output_tokens` is retired from the model-facing surface, a divergence from Codex.
 *
 * ChatGPT drops a tool result over roughly 10,000 tokens before the model reads it, so raising the
 * budget bought nothing while the model spent a parameter and a guess on every call. The budget is
 * fixed at `DEFAULT_MAX_OUTPUT_TOKENS`; the runtime below still takes `maxOutputTokens`.
 *
 * It is still *accepted* because these schemas are `.strict()` and ChatGPT caches tool definitions:
 * dropping the key turned older chats' calls into `Unrecognized key`, refusing the whole command.
 * So take the key, ignore it, and say so once in the notes.
 */
export const MAX_OUTPUT_TOKENS_DESCRIPTION =
  'Ignored; still accepted so older cached schemas keep working. Omit it.';

/** The note a call that still sends the retired budget gets back, once, alongside its output. */
export const MAX_OUTPUT_TOKENS_RETIRED_NOTE =
  'max_output_tokens is retired and was ignored; output uses the fixed 10000-token budget. Omit the parameter.';

export const EXEC_COMMAND_SHELL_DESCRIPTION = "Shell binary to launch. Defaults to the user's default shell.";

export const EXEC_COMMAND_LOGIN_DESCRIPTION =
  IS_WINDOWS
    ? 'True loads the shell profile; false disables it. Defaults to false on Windows for deterministic, faster commands.'
    : 'True runs the shell with -l/-i semantics; false disables them. Defaults to true.';

export const WRITE_STDIN_DESCRIPTION =
  'Writes characters to an existing unified exec session and returns recent output. Keep polling a returned session ID until its terminal result; after a transient wait failure, retry this same session ID rather than starting replacement work.';

export const WRITE_STDIN_SESSION_ID_DESCRIPTION = 'Identifier of the running unified exec session.';

export const WRITE_STDIN_CHARS_DESCRIPTION =
  'Bytes to write to stdin. Defaults to empty, which polls without writing.';

export const WRITE_STDIN_YIELD_TIME_DESCRIPTION =
  'Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait up to 5000-300000 ms by default but return early when the first output arrives.';

/**
 * `APPLY_PATCH_LARK_GRAMMAR` (`core/src/tools/handlers/apply_patch.lark`).
 *
 * On Codex this grammar *is* the schema: `apply_patch` is `ToolSpec::Freeform`, so the model is
 * given the grammar and emits raw patch text against it. MCP advertises JSON object schemas only,
 * so the grammar moves into the description -- otherwise the model would lose the exact syntax
 * spec that Freeform hands it.
 */
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

/**
 * Codex's description is "The `apply_patch` tool can be used to edit files. This is a FREEFORM
 * tool, so do not wrap the patch in JSON."
 *
 * The second sentence cannot survive the move to MCP -- here the patch *is* carried in JSON, as
 * the single `patch` string -- so it is replaced by the truth about this transport and followed by
 * the grammar the Freeform spec would otherwise supply. That substitution is the only adaptation;
 * the grammar, the parser, the matching, the update semantics and the output format are the ported
 * Codex ones.
 */
export const APPLY_PATCH_DESCRIPTION = `The \`apply_patch\` tool can be used to edit files. Pass the patch text as the \`patch\` string; everything else about the format below is unchanged.

The patch must match this grammar:

${APPLY_PATCH_LARK_GRAMMAR}`;

export const APPLY_PATCH_ARGUMENT_DESCRIPTION =
  'The patch text, from *** Begin Patch through *** End Patch, exactly as the grammar describes it.';
