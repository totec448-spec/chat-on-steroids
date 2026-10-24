//! `apply_patch`: Codex V4A patches against the approved roots (unit C1.5).
//!
//! The grammar, matching and runtime are vendored from Codex `apply-patch` (see [`codex`]). This
//! file is the connector's wrapper around them, a port of the `apply_patch` handler and its
//! helpers in `src/main/mcp/tools-core.ts`:
//!
//! 1. Each hunk needs its own permission: Add needs Create, Delete needs Delete files, an Update
//!    that changes text needs Edit, and a Move needs Move. Replacing an existing file through Add
//!    or a Move also needs Edit.
//! 2. Every path is resolved through `cos-fs` before anything is read. A relative path starts at
//!    the first approved root.
//! 3. A dry run proves every hunk applies. Only then are the touched files snapshotted and the
//!    patch applied. A failure part-way rolls back what this patch wrote and nothing else.
//! 4. The answer is Codex's exec-shaped text, with every host path replaced by its virtual path.

mod codex;
mod fs;
mod output;
mod resolve;
mod rollback;

use std::sync::Arc;
use std::time::Instant;

use cos_fs::{Access, LineDelta};
use cos_tools::{
    CallContext, CallNotes, Capability, CapabilitySet, DynTool, FileChange, Listing, Requirement,
    Tool, ToolError, ToolOutput, ToolResult, ToolSpec,
};
use serde::Deserialize;

use crate::codex::{
    AppliedChange, AppliedPatchDelta, ApplyPatchError, ApplyPatchFileUpdateMode, Hunk, VerifyError,
};
use crate::resolve::{PatchPaths, first_task_root};
use crate::rollback::Snapshots;

pub fn tool() -> Arc<dyn DynTool> {
    Arc::new(ApplyPatch)
}

pub struct ApplyPatch;

#[derive(Debug, Deserialize)]
pub struct ApplyPatchArgs {
    pub patch: String,
}

const WRITING: &[Capability] = &[
    Capability::Create,
    Capability::Edit,
    Capability::Move,
    Capability::DeleteFile,
];

impl Tool for ApplyPatch {
    type Args = ApplyPatchArgs;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "apply_patch",
        listing: Listing::AnyCapability(WRITING),
        requires: Requirement::None,
    };

    async fn call(&self, cx: &CallContext, args: ApplyPatchArgs) -> Result<ToolOutput, ToolError> {
        let grants = cx.grants.clone();
        // Sandbox resolution and the patch itself are blocking filesystem work.
        tokio::task::spawn_blocking(move || run(grants.capabilities, &grants.roots, &args.patch))
            .await
            .map_err(|error| ToolError::Internal(format!("apply_patch did not finish: {error}")))?
    }
}

fn refused(text: impl Into<String>) -> ToolError {
    ToolError::Refused(text.into())
}

fn verification_failed(text: &str) -> ToolError {
    refused(format!("apply_patch verification failed: {text}"))
}

fn run(caps: CapabilitySet, roots: &cos_fs::Roots, patch: &str) -> Result<ToolOutput, ToolError> {
    if !caps.any_of(WRITING) {
        return Err(refused(
            "TOOL_DISABLED: apply_patch is disabled by the current Chat On Steroids permissions. Ask the user to enable changing files in the app.",
        ));
    }
    let args =
        codex::parse_patch(patch).map_err(|error| verification_failed(&error.to_string()))?;
    // One local environment: the `*** Environment ID:` preamble selects among several, which
    // this connector does not have.
    if args.environment_id.is_some() {
        return Err(refused(
            "apply_patch environment selection is unavailable for this turn",
        ));
    }
    let Some(base) = first_task_root(roots) else {
        return Err(refused(
            "No folder is approved, so there is nowhere to apply the patch.",
        ));
    };
    let base = cos_fs::resolve(roots, &base, Access::Read)?.virtual_path;

    if let Some(denial) = capability_denial(&args.hunks, caps) {
        return Err(refused(denial));
    }
    let paths = PatchPaths::resolve(roots, &base, &args.hunks)?;
    if let Some(denial) = effect_denial(&args.hunks, caps, &paths)? {
        return Err(refused(denial));
    }
    // Move alone is not Edit. The default mode rewrites every updated file with LF endings, so a
    // context-only rename of a CRLF file would change its bytes; keep the endings instead.
    let mode = if caps.contains(Capability::Edit) {
        ApplyPatchFileUpdateMode::NormalizeToLf
    } else {
        ApplyPatchFileUpdateMode::PreserveLineEndings
    };

    if let Err(error) = codex::verify(&args.hunks, mode, &paths) {
        let text = verify_error_text(&error, caps.contains(Capability::Read));
        return Err(verification_failed(&paths.redact(&text)));
    }
    let snapshots = Snapshots::capture(&paths).map_err(refused)?;

    let started = Instant::now();
    let mut execution = codex::execute(&args.hunks, mode, &paths);
    let wall_time = started.elapsed();
    if execution.failed {
        let note = snapshots.roll_back(&mut execution.delta);
        if !execution.stderr.is_empty() && !execution.stderr.ends_with('\n') {
            execution.stderr.push('\n');
        }
        execution.stderr.push_str(&note);
        execution.stderr.push('\n');
    }
    let shown = paths.redact(&format!("{}{}", execution.stdout, execution.stderr));
    let exit_code = i32::from(execution.failed);
    let content = output::format_exec_output(exit_code, wall_time, &shown);

    Ok(ToolOutput {
        result: ToolResult {
            is_error: execution.failed,
            ..ToolResult::text(content)
        },
        notes: CallNotes {
            changes: file_changes(&execution.delta, &paths),
            ..CallNotes::default()
        },
    })
}

/// The model-facing text of a dry-run refusal. A source excerpt is shown only with Read.
fn verify_error_text(error: &VerifyError, may_read: bool) -> String {
    match error {
        VerifyError::Patch(ApplyPatchError::ComputeReplacements {
            message,
            source_context: Some(excerpt),
        }) if may_read => format!("{message}\n\n{excerpt}"),
        VerifyError::Patch(error) => error.to_string(),
        VerifyError::Fs(error) => error.friendly(),
        VerifyError::Unresolved(text) => text.clone(),
    }
}

/// The permission each hunk needs, judged from the patch text alone (`patchCapabilityDenial`).
fn capability_denial(hunks: &[Hunk], caps: CapabilitySet) -> Option<&'static str> {
    for hunk in hunks {
        match hunk {
            Hunk::AddFile { .. } if !caps.contains(Capability::Create) => {
                return Some(
                    "TOOL_DISABLED: this patch adds a file but Create files and folders is disabled.",
                );
            }
            Hunk::DeleteFile { .. } if !caps.contains(Capability::DeleteFile) => {
                return Some(
                    "TOOL_DISABLED: this patch deletes a file but Delete files is disabled.",
                );
            }
            Hunk::UpdateFile {
                move_path, chunks, ..
            } => {
                // A rename is written as a context-only chunk, because an empty Update hunk is
                // refused. That chunk changes no text, so it needs Move but not Edit.
                let changes_text = move_path.is_none()
                    || chunks
                        .iter()
                        .any(|chunk| chunk.old_lines != chunk.new_lines);
                if changes_text && !caps.contains(Capability::Edit) {
                    return Some(
                        "TOOL_DISABLED: this patch updates a file but Edit files is disabled.",
                    );
                }
                if move_path.is_some() && !caps.contains(Capability::Move) {
                    return Some(
                        "TOOL_DISABLED: this patch moves a file but Move / rename is disabled.",
                    );
                }
            }
            Hunk::AddFile { .. } | Hunk::DeleteFile { .. } => {}
        }
    }
    None
}

/// Permissions that depend on the disk (`patchEffectCapabilityDenial`). Codex lets Add replace
/// an existing file and a Move replace an occupied destination. Here both are edits of existing
/// data, so they need Edit as well.
fn effect_denial(
    hunks: &[Hunk],
    caps: CapabilitySet,
    paths: &PatchPaths,
) -> Result<Option<&'static str>, ToolError> {
    if caps.contains(Capability::Edit) {
        return Ok(None);
    }
    let exists = |spelled: &str| -> Result<bool, ToolError> {
        let real = paths.real(spelled).map_err(ToolError::Refused)?;
        match std::fs::symlink_metadata(real) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(ToolError::from_io(&error)),
        }
    };
    for hunk in hunks {
        match hunk {
            Hunk::AddFile { path, .. } if exists(path)? => {
                return Ok(Some(
                    "TOOL_DISABLED: this patch replaces an existing file but Edit files is disabled.",
                ));
            }
            Hunk::UpdateFile {
                path,
                move_path: Some(move_path),
                ..
            } => {
                let source = paths.real(path).map_err(ToolError::Refused)?;
                let destination = paths.real(move_path).map_err(ToolError::Refused)?;
                if !resolve::same_file(source, destination) && exists(move_path)? {
                    return Ok(Some(
                        "TOOL_DISABLED: this patch replaces an existing move destination but Edit files is disabled.",
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(None)
}

/// The recorder's evidence: one entry per committed change, under its virtual path.
fn file_changes(delta: &AppliedPatchDelta, paths: &PatchPaths) -> Vec<FileChange> {
    delta
        .changes
        .iter()
        .map(|(real, change)| {
            let (shown_at, before, after) = match change {
                AppliedChange::Add {
                    content,
                    overwritten,
                } => (real, overwritten.as_deref().unwrap_or(""), content.as_str()),
                AppliedChange::Delete { content } => (real, content.as_str(), ""),
                AppliedChange::Update {
                    move_path,
                    old_content,
                    new_content,
                } => (
                    move_path.as_ref().unwrap_or(real),
                    old_content.as_str(),
                    new_content.as_str(),
                ),
            };
            let LineDelta {
                added,
                removed,
                approximate,
            } = cos_fs::line_delta(before, after);
            FileChange {
                path: paths
                    .virtual_of(shown_at)
                    .map_or_else(|| "[unresolved patch path]".to_owned(), ToString::to_string),
                added: added as u64,
                removed: removed as u64,
                approximate: approximate || !delta.exact,
                review_asset_id: None,
                review_unavailable: None,
                extra: Default::default(),
            }
        })
        .collect()
}
