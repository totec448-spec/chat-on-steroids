//! `read`, `view_image`, `find` and `save_image`. Unit C1.4 owns this crate (the file half of
//! `src/main/mcp/tools-core.ts`, `search.ts`, `codex/read-backend.ts`, `codex/view-image.ts`,
//! `codex/filesystem.ts`). Paths resolve through `cos_fs::resolve`; refusals return `ToolError`.
//!
//! Every handler is synchronous file work, so it runs on Tokio's blocking pool and never holds a
//! runtime worker.

mod disk;
mod failure;
mod find;
mod image;
mod js;
mod read;
mod text;

use std::sync::Arc;

use cos_tools::{
    ArgIssue, CallContext, Capability, Content, DynTool, Grants, Listing, Requirement, SurfaceId,
    Tool, ToolError, ToolOutput, ToolResult, ToolSpec,
};
use serde::Deserialize;

pub use find::FindMode;

/// What the file tools need from the install. Nothing today: `find` searches in process with
/// ripgrep's engine, so no `rg` binary has to ship next to the app.
#[derive(Clone, Debug, Default)]
pub struct FileToolsDeps {}

/// The four tools, for the Core surface.
pub fn tools(_deps: FileToolsDeps) -> Vec<Arc<dyn DynTool>> {
    vec![
        Arc::new(Read),
        Arc::new(ViewImage),
        Arc::new(Find),
        Arc::new(SaveImage),
    ]
}

/// Runs `work` with the call's grants on the blocking pool.
async fn blocking<A: Send + 'static>(
    cx: &CallContext,
    args: A,
    work: fn(&Grants, A) -> Result<ToolOutput, ToolError>,
) -> Result<ToolOutput, ToolError> {
    let grants = cx.grants.clone();
    tokio::task::spawn_blocking(move || work(&grants, args))
        .await
        .map_err(|error| ToolError::Internal(format!("file work stopped: {error}")))?
}

pub struct Read;

#[derive(Debug, Deserialize)]
pub struct ReadArgs {
    pub paths: Vec<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub max_bytes: Option<u32>,
}

impl Tool for Read {
    type Args = ReadArgs;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "read",
        listing: Listing::AnyCapability(&[
            Capability::Read,
            Capability::Browse,
            Capability::Metadata,
        ]),
        requires: Requirement::None,
    };

    async fn call(&self, cx: &CallContext, args: ReadArgs) -> Result<ToolOutput, ToolError> {
        blocking(cx, args, read::read).await
    }
}

pub struct ViewImage;

#[derive(Debug, Deserialize)]
pub struct ViewImageArgs {
    pub path: String,
}

impl Tool for ViewImage {
    type Args = ViewImageArgs;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "view_image",
        listing: Listing::Capability(Capability::Read),
        requires: Requirement::Capability(Capability::Read),
    };

    async fn call(&self, cx: &CallContext, args: ViewImageArgs) -> Result<ToolOutput, ToolError> {
        blocking(cx, args, |grants, args| {
            let resolved = cos_fs::resolve(&grants.roots, &args.path, cos_fs::Access::Read)?;
            let image = image::view_image(&resolved.real, resolved.virtual_path.as_str())
                .map_err(ToolError::Refused)?;
            Ok(ToolOutput::from(ToolResult {
                content: vec![Content::Image {
                    data: image.base64,
                    mime_type: image.mime.as_str().to_owned(),
                }],
                structured_content: None,
                is_error: false,
            }))
        })
        .await
    }
}

pub struct Find;

#[derive(Debug, Deserialize)]
pub struct FindArgs {
    pub query: String,
    pub path: Option<String>,
    pub mode: Option<FindMode>,
    pub include: Option<String>,
    pub exclude: Option<Vec<String>>,
    pub case_sensitive: Option<bool>,
    pub regex: Option<bool>,
    pub max_results: Option<u32>,
}

impl Tool for Find {
    type Args = FindArgs;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "find",
        listing: Listing::FindInsteadOfCommand,
        requires: Requirement::Capability(Capability::Search),
    };

    /// The zod refinements of `find`'s schema, in its order: the query, each exclude entry,
    /// then the cross-field rule.
    fn refine(args: &FindArgs) -> Result<(), Vec<ArgIssue>> {
        let mut issues = Vec::new();
        if js::trim(&args.query).is_empty() {
            issues.push(ArgIssue::new(
                "query",
                "query must contain non-whitespace text",
            ));
        }
        for (index, entry) in args.exclude.iter().flatten().enumerate() {
            let star = entry.find('*');
            let folder_name =
                !entry.contains(['/', '\\']) && star.is_none_or(|at| at == entry.len() - 1);
            if !folder_name {
                issues.push(ArgIssue::new(
                    format!("exclude.{index}"),
                    "exclude entries must be folder names with at most one trailing * prefix wildcard",
                ));
            }
        }
        if args.mode.unwrap_or_default() != FindMode::Content && args.regex == Some(true) {
            issues.push(ArgIssue::new(
                "regex",
                "regex=true is only valid with mode=content",
            ));
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }

    async fn call(&self, cx: &CallContext, args: FindArgs) -> Result<ToolOutput, ToolError> {
        blocking(cx, args, find::find).await
    }
}

pub struct SaveImage;

#[derive(Debug, Deserialize)]
pub struct SaveImageArgs {
    pub path: String,
    pub nth: Option<u32>,
}

impl Tool for SaveImage {
    type Args = SaveImageArgs;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "save_image",
        listing: Listing::Capability(Capability::Create),
        requires: Requirement::Capability(Capability::Create),
    };

    /// Only the refusals are reachable before the browser plane exists: the chat must be known
    /// (never guessed, or another chat's image would be saved), and the page must hand over
    /// the image, which needs the extension.
    async fn call(&self, cx: &CallContext, args: SaveImageArgs) -> Result<ToolOutput, ToolError> {
        let SaveImageArgs { path: _, nth: _ } = args;
        if !cx.caller.is_attributed() {
            // Names the Core that answered: with one ChatGPT account on several computers, a
            // chat's call can reach another computer's Core, which never sees that chat.
            return Err(ToolError::Refused(format!(
                "{} could not tell which chat this save_image call came from, so it does not know which image to save. If the chat belongs to another computer, call save_image of that computer's Chat On Steroids Core instead. Otherwise call save_image directly as its own tool call, not from inside a JavaScript or exec step, and try again.",
                cx.connectors.name(SurfaceId::Core)
            )));
        }
        Err(ToolError::Refused(
            "save_image needs the Chat On Steroids browser extension to be connected and up to date, so the chat's page can hand over the image.".to_owned(),
        ))
    }
}
