//! The `exec_command` and `write_stdin` handlers (`tools-core.ts`).

use std::sync::Arc;
use std::time::Duration;

use cos_fs::{Access, RootKind, SandboxError};
use cos_tools::{CallContext, CallNotes, Content, ProcessNotes, ToolError, ToolOutput, ToolResult};
use serde_json::{Value, json};

use crate::allowlist::{self, Decision, Refusal};
use crate::batch::{self, BatchMarker};
use crate::benign::{benign_exit_note, non_zero_exit_is_benign};
use crate::env::{exec_child_env, locate_ripgrep};
use crate::hints;
use crate::launch::LaunchRequest;
use crate::manager::{
    CustodyRefusal, DEFAULT_EXEC_YIELD, DEFAULT_WRITE_STDIN_YIELD, ExecError, ExecRequest,
    ExitClassifier, MAX_UNREAD_RESULTS, Principal,
};
use crate::output;
use crate::shell::{self, ShellKind, UTF8_OUTPUT_PREFIX};
use crate::{ExecCommandArgs, ExecManager, WriteStdinArgs};

/// PowerShell profiles are arbitrary user startup programs; Windows runs without them unless
/// the caller asks.
const DEFAULT_LOGIN: bool = !cfg!(windows);

/// The launch an `exec_command` makes when it names no `shell`, `login` or `tty`, without its
/// script and folder: what a launcher prepares for before the first call.
pub(crate) fn default_launch() -> LaunchRequest {
    LaunchRequest {
        shell: shell::default_user_shell(),
        script: String::new(),
        login: DEFAULT_LOGIN,
        working_folder: std::env::temp_dir(),
        env: exec_child_env(locate_ripgrep().as_deref()).into_pairs(),
        tty: false,
    }
}

fn refuse(text: impl Into<String>) -> ToolError {
    ToolError::Refused(text.into())
}

fn sandbox_error(error: SandboxError) -> ToolError {
    match error {
        SandboxError::Os(os) => ToolError::from_io(&os.to_io_error()),
        other => ToolError::from(other),
    }
}

/// `cos_types::session::ToolOutcome::ProcessExitNonzero`, built through its wire name because
/// this crate does not depend on `cos-types` (the kernel only re-exports some of its types).
fn process_exit_nonzero<T: serde::de::DeserializeOwned>() -> Option<T> {
    serde_json::from_value(json!("process_exit_nonzero")).ok()
}

/// The working folder (`resolveCwd`): the requested one, or the first approved folder that is
/// not the skills folder. An empty `workdir` means none.
async fn working_folder(
    cx: &CallContext,
    workdir: Option<&str>,
) -> Result<cos_fs::Resolved, ToolError> {
    let roots = cx.grants.roots.clone();
    let target = match workdir.filter(|dir| !dir.is_empty()) {
        Some(dir) => dir.to_owned(),
        None => roots
            .iter()
            .find(|root| root.kind == RootKind::User)
            .map(|root| root.name.to_string())
            .ok_or_else(|| refuse("No folder is approved, so there is nowhere to run"))?,
    };
    tokio::task::spawn_blocking(move || cos_fs::resolve(&roots, &target, Access::WorkingFolder))
        .await
        .map_err(|error| ToolError::Internal(format!("working folder lookup failed: {error}")))?
        .map_err(sandbox_error)
}

impl ExecManager {
    pub(crate) async fn exec_command(
        &self,
        cx: &CallContext,
        args: ExecCommandArgs,
    ) -> Result<ToolOutput, ToolError> {
        let dir = working_folder(cx, args.workdir.as_deref()).await?;
        let is_batch = args.cmd.is_none();
        let raw_commands: Vec<String> = match (args.cmd, args.cmds) {
            (Some(cmd), _) => vec![cmd],
            (None, Some(cmds)) => cmds,
            (None, None) => {
                return Err(ToolError::Internal(
                    "exec_command requires exactly one of cmd or cmds".into(),
                ));
            }
        };
        let location = |index: usize| {
            if is_batch {
                format!(" in command {}", index + 1)
            } else {
                String::new()
            }
        };
        for (index, raw) in raw_commands.iter().enumerate() {
            if let Some(path) = cos_fs::stray_virtual_path(raw, &cx.grants.roots) {
                return Err(refuse(format!(
                    "INVALID_COMMAND_PATH{}: {path} is an app virtual path, but shell commands do not understand virtual paths. Use workdir plus a relative path, or use the approved folder's native filesystem path. No command was run.",
                    location(index)
                )));
            }
        }
        let shell = match &args.shell {
            None => shell::default_user_shell(),
            Some(requested) => shell::shell_by_model_provided_path(requested, &dir.real).ok_or_else(|| {
                refuse(format!(
                    "SHELL_NOT_FOUND: the explicitly requested shell {} could not be resolved. No command was run. Omit shell to use the configured default, or provide an existing recognised shell binary.",
                    serde_json::to_string(requested).unwrap_or_default()
                ))
            })?,
        };

        let policy = (self.policy)();
        let authorized = match allowlist::evaluate(&policy, &raw_commands, shell.kind) {
            Decision::Allowed(args) => args,
            Decision::Refused {
                command_index,
                kind,
                detail,
            } => {
                let reason = match kind {
                    Refusal::Unmatched => "the command did not match any allow rule",
                    Refusal::Denied => "the command matched a deny rule",
                    Refusal::InvalidPolicy => "the saved policy is invalid",
                    Refusal::Unsupported => {
                        "the command uses unsupported or ambiguous shell syntax"
                    }
                };
                return Err(refuse(format!(
                    "COMMAND_NOT_ALLOWED{}: {reason}. {detail} No command was run. Change the command policy in Settings if this launch should be permitted.",
                    location(command_index)
                )));
            }
        };

        // Repair first, because everything after reads the line by its quotes; bind ripgrep
        // after, because binding rewrites the program token the other steps recognise.
        let ripgrep = locate_ripgrep();
        let mut notes = Vec::new();
        let mut normalized = Vec::with_capacity(raw_commands.len());
        let mut bound = Vec::with_capacity(raw_commands.len());
        for (index, raw) in raw_commands.iter().enumerate() {
            let prefix = |note: String| {
                if is_batch {
                    format!("Command {}: {note}", index + 1)
                } else {
                    note
                }
            };
            let repaired = hints::repair_powershell_quoting(raw, shell.kind);
            normalized.push(repaired.cmd.clone());
            let with_rg = hints::bind_bundled_ripgrep(
                &repaired.cmd,
                shell.kind,
                if shell.kind == ShellKind::Cmd {
                    None
                } else {
                    ripgrep.as_deref().and_then(|path| path.to_str())
                },
            );
            let chained = hints::normalize_powershell_operators(
                &with_rg,
                shell.kind,
                &shell.path.to_string_lossy(),
            );
            notes.extend(repaired.notes.into_iter().map(&prefix));
            notes.extend(chained.notes.into_iter().map(&prefix));
            bound.push(chained.cmd);
        }
        if policy.enabled
            && let Some(changed) = normalized.iter().enumerate().position(|(index, command)| {
                !allowlist::same_arguments(&authorized[index], command, shell.kind)
            })
        {
            return Err(refuse(format!(
                "COMMAND_NOT_ALLOWED{}: command normalization changed the authorized argument list. No command was run. Change the command policy in Settings if this launch should be permitted.",
                location(changed)
            )));
        }

        let marker = is_batch.then(BatchMarker::new);
        let script = match &marker {
            Some(marker) => batch::compose(&bound, shell.kind, marker),
            None => bound[0].clone(),
        };
        let detail = if is_batch {
            format!(
                "[batch {}] {}",
                raw_commands.len(),
                raw_commands.join(" ; ")
            )
        } else {
            raw_commands[0].clone()
        };
        let login = args.login.unwrap_or(DEFAULT_LOGIN);
        let argv = shell::derive_exec_args(&shell, &script, login);

        let owner = Principal::of(&cx.caller);
        let unread = self.runtime.exited_unread(&owner);
        if unread.len() >= MAX_UNREAD_RESULTS {
            let ids = unread
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            return Err(refuse(format!(
                "EXEC_RESULTS_UNREAD: {} completed background results are still waiting for this session. Their output follows in tool responses; read it before retrying. Explicit write_stdin is also available for IDs {ids}. No child was spawned.",
                unread.len()
            )));
        }
        let identical = self
            .runtime
            .running_identical(&owner, &detail, dir.virtual_path.as_str());
        if let Some((first, started)) = identical.first() {
            let ids = identical
                .iter()
                .map(|(id, _)| id.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            let plural = if identical.len() > 1 { "s" } else { "" };
            let age = started.elapsed().as_secs_f64().round();
            notes.push(format!(
                "The same command in this folder is still running from earlier in this chat as session{plural} {ids} (started {age} s ago); this call started another copy. If this was a retry of a lost answer, read the running one with write_stdin(session_id={first}, chars=\"\") instead of starting more."
            ));
        }

        let id = self.runtime.allocate_id();
        let mut execution = shell::with_posix_path_prefix(
            &script,
            shell.kind,
            ripgrep.as_deref().and_then(std::path::Path::parent),
        );
        if shell.kind == ShellKind::PowerShell
            && !execution.trim_start().starts_with(UTF8_OUTPUT_PREFIX)
        {
            execution = format!("{UTF8_OUTPUT_PREFIX}{execution}");
        }
        let request = ExecRequest {
            launch: LaunchRequest {
                shell: shell.clone(),
                script: execution,
                login,
                working_folder: dir.real.clone(),
                env: exec_child_env(ripgrep.as_deref()).into_pairs(),
                tty: args.tty.unwrap_or(false),
            },
            command: detail.clone(),
            cwd: dir.virtual_path.to_string(),
            yield_time: args
                .yield_time_ms
                .map_or(DEFAULT_EXEC_YIELD, Duration::from_millis),
            max_output_tokens: None,
            batch: marker.clone(),
            classify: Some(exit_classifier(bound.clone(), script, marker.clone())),
        };
        let output = match self.runtime.exec(id, request).await {
            Ok(output) => output,
            Err(error) => {
                return Err(refuse(format!(
                    "exec_command failed for `{}`: {}",
                    shell::shlex_join(&argv),
                    error.debug_text()
                )));
            }
        };
        let session = match output.status {
            output::Status::Running(session) | output::Status::Completed { session, .. } => session,
        };
        self.runtime.set_owner(session, owner);

        let text = output.response_text();
        let benign = output.expected_exit;
        if let Some(marker) = &marker {
            let sections = batch::parse_sections(&String::from_utf8_lossy(&output.raw), marker);
            let failed: Vec<_> = sections
                .iter()
                .filter(|section| section.exit_code != 0)
                .collect();
            if !benign
                && sections.len() == raw_commands.len()
                && !failed.is_empty()
                && failed.len() < sections.len()
            {
                let ok = sections.len() - failed.len();
                let others = if ok == 1 {
                    "command".to_owned()
                } else {
                    format!("{ok} commands")
                };
                notes.push(format!(
                    "Batch: {}; the other {others} exited 0. The top-line exit code is the first non-zero one.",
                    failed
                        .iter()
                        .map(|section| format!("command {} exited {}", section.index, section.exit_code))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            if benign {
                notes.extend(failed.iter().map(|section| {
                    let command = nth_command(&bound, section.index);
                    let note = benign_exit_note(
                        command,
                        shell.kind,
                        Some(section.exit_code),
                        Some(&section.text),
                    );
                    format!("Command {}: {note}", section.index)
                }));
            }
        } else if benign {
            notes.push(benign_exit_note(
                &bound[0],
                shell.kind,
                output.exit_code(),
                Some(&text),
            ));
        }

        let mut structured = output.structured();
        let text = if notes.is_empty() {
            text
        } else {
            let notes_text = hints::notes_text(&notes);
            structured.insert(
                "supplemental_context".into(),
                Value::String(notes_text.clone()),
            );
            format!("{text}\n\n{notes_text}")
        };
        let mut call_notes = CallNotes {
            detail: Some(
                detail
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(120)
                    .collect(),
            ),
            ..CallNotes::default()
        };
        note_exec(&mut call_notes, &output);
        Ok(ToolOutput {
            result: ToolResult {
                content: vec![Content::Text { text }],
                structured_content: Some(Value::Object(structured)),
                is_error: false,
            },
            notes: call_notes,
        })
    }

    pub(crate) async fn write_stdin(
        &self,
        cx: &CallContext,
        args: WriteStdinArgs,
    ) -> Result<ToolOutput, ToolError> {
        let asker = Principal::of(&cx.caller);
        let Ok(id) = u32::try_from(args.session_id) else {
            return Err(custody_refusal(
                args.session_id,
                CustodyRefusal::Unavailable,
            ));
        };
        if let Some(refusal) = self.runtime.custody(id, &asker) {
            let error = custody_refusal(args.session_id, refusal);
            return Err(match (refusal, error) {
                (CustodyRefusal::Unidentified, ToolError::Refused(text)) => {
                    ToolError::Identity(text)
                }
                (_, error) => error,
            });
        }
        let input = args.chars.unwrap_or_default();
        let result = self
            .runtime
            .write_stdin(
                id,
                &input,
                args.yield_time_ms
                    .map_or(DEFAULT_WRITE_STDIN_YIELD, Duration::from_millis),
                None,
            )
            .await;
        let output = match result {
            Ok(output) => output,
            Err(error) => {
                let retry = if error == ExecError::WriteToStdin {
                    format!(
                        " Retry this same session_id ({id}); do not replace it with a new command."
                    )
                } else {
                    String::new()
                };
                return Err(refuse(format!("write_stdin failed: {error}{retry}")));
            }
        };
        let mut call_notes = CallNotes::default();
        note_exec(&mut call_notes, &output);
        Ok(ToolOutput {
            result: ToolResult {
                content: vec![Content::Text {
                    text: output.response_text(),
                }],
                structured_content: Some(Value::Object(output.structured())),
                is_error: false,
            },
            notes: call_notes,
        })
    }
}

/// The command a 1-based batch section names, or nothing for a section no command owns.
fn nth_command(commands: &[String], index: usize) -> &str {
    index
        .checked_sub(1)
        .and_then(|index| commands.get(index))
        .map_or("", String::as_str)
}

/// `nonZeroExitIsBenign` for one command, or for every non-zero section of a batch, which
/// needs its complete set of sections so a truncated tail cannot hide a real failure.
fn exit_classifier(
    commands: Vec<String>,
    script: String,
    batch: Option<BatchMarker>,
) -> ExitClassifier {
    Arc::new(move |exit, output| {
        let Some(marker) = &batch else {
            return non_zero_exit_is_benign(&script, exit, output);
        };
        let sections = batch::parse_sections(output, marker);
        let mut failed = sections
            .iter()
            .filter(|section| section.exit_code != 0)
            .peekable();
        exit.is_some_and(|code| code != 0)
            && sections.len() == commands.len()
            && failed.peek().is_some()
            && failed.all(|section| {
                let command = nth_command(&commands, section.index);
                non_zero_exit_is_benign(command, Some(section.exit_code), &section.text)
            })
    })
}

/// `noteExec`: what the child did, and `process_exit_nonzero` unless its exit was benign.
fn note_exec(notes: &mut CallNotes, output: &output::ToolOutput) {
    let running = match output.status {
        output::Status::Running(session) => Some(session),
        output::Status::Completed { .. } => None,
    };
    let exit_code = output.exit_code();
    notes.process = Some(ProcessNotes {
        exit_code,
        running: Some(running.is_some()),
        timed_out: false,
        benign_exit: output.expected_exit,
        duration_ms: Some(output.wall_time_ms as u64),
        session_id: running.map(|session| session.to_string()),
    });
    if exit_code.is_some_and(|code| code != 0) && !output.expected_exit {
        notes.outcome = process_exit_nonzero();
    }
}

fn custody_refusal(session_id: i64, refusal: CustodyRefusal) -> ToolError {
    let reason = match refusal {
        CustodyRefusal::Unavailable => {
            "EXEC_SESSION_UNAVAILABLE: This process id is not available to this call in the running app. Check the original exec_command response and earlier results for its exit/output before deciding what remains; do not rerun the command solely because its id is unavailable."
        }
        CustodyRefusal::Anonymous => {
            "EXEC_SESSION_ANONYMOUS: This process was launched without proven chat identity. An identified chat cannot adopt it. Check the original command and its saved output; retrying from this identified chat cannot change its ownership."
        }
        CustodyRefusal::Unidentified => {
            "EXEC_CALLER_UNIDENTIFIED: The current request has not been proven to own this process, so it cannot access it yet. After exact identity recovers, retry this same session_id once; do not launch a replacement command."
        }
        CustodyRefusal::DifferentOwner => {
            "EXEC_SESSION_OWNER_MISMATCH: This process belongs to a different local session. Only its owning session can poll it or send input; use a process id returned to this session."
        }
    };
    refuse(format!(
        "write_stdin failed for session {session_id}: {reason} No input was sent and no output was read. This refusal concerns this process id, not Read-only mode or permission to edit files or launch other authorized work."
    ))
}
