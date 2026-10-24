//! Code mode `exec`: JavaScript that composes the calling surface's own tools. Unit C1.7 owns
//! this crate (port of `src/main/mcp/code-mode-{tool,runtime,worker}.ts`).
//!
//! Each call runs the script in a fresh QuickJS-ng interpreter (`rquickjs`) on its own thread,
//! with the TypeScript runtime's memory, CPU, time, call and output limits. The script sees
//! `tools`, `ALL_TOOLS`, `text`, `image` and `exit`, and on Windows Desktop also `sky` and
//! `nodeRepl`. Child calls go through [`CallContext::nested_invoker`], so they re-check live
//! grants and are recorded separately. Only what the script emits reaches the model.

mod cpu;
mod image;
mod runtime;
mod text;
mod unknown;
mod worker;

use std::sync::Arc;

pub use cos_tools::NestedTool;
use cos_tools::{
    BoxFuture, CallContext, Content, DynTool, Listing, NestedInvoker, Requirement, SurfaceId, Tool,
    ToolError, ToolOutput, ToolResult, ToolSpec, UnknownTool,
};
use serde::Deserialize;
use serde_json::Value;

pub use runtime::{Invoke, LIMITS, Limits, Options, run};

/// One `exec` tool per surface; each composes only the tools of the surface it is called on.
pub fn tool() -> Arc<dyn DynTool> {
    Arc::new(CodeMode)
}

pub struct CodeMode;

#[derive(Debug, Deserialize)]
pub struct CodeModeArgs {
    pub code: String,
}

const IDENTITY_REQUIRED: &str = "CALLER_IDENTITY_REQUIRED: code mode needs exact companion chat/session proof or Allow unattributed calls enabled in app settings. No JavaScript or nested tool ran.";

impl Tool for CodeMode {
    type Args = CodeModeArgs;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "exec",
        listing: Listing::WithOtherTools,
        requires: Requirement::None,
    };

    async fn call(&self, cx: &CallContext, args: CodeModeArgs) -> Result<ToolOutput, ToolError> {
        let proven = cx.caller.request_id.is_some() && cx.caller.is_attributed();
        if !proven && !cx.grants.allow_unattributed {
            return Err(ToolError::Identity(IDENTITY_REQUIRED.to_owned()));
        }
        let tools = cx.nested_tools();
        let options = Options {
            windows_desktop: cx.surface == SurfaceId::Desktop && cfg!(windows),
        };
        let nested = Nested(cx.nested_invoker());
        let mut result = run(&args.code, &tools, &nested, &LIMITS, options).await;
        let available: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
        let unknown = unknown::unknown_tool_references(&args.code, &available);
        if !unknown.is_empty() {
            result.content.push(Content::Text {
                text: unknown::unknown_tool_note(cx.surface, &unknown, &cx.connectors),
            });
        }
        Ok(result.into())
    }
}

/// Child calls through the kernel, with the parent's identity and the live grants.
struct Nested(NestedInvoker);

impl Invoke for Nested {
    fn invoke(&self, tool: String, arguments: Value) -> BoxFuture<'static, ToolResult> {
        let child = self.0.invoke(tool, arguments);
        Box::pin(async move {
            match child.await {
                Ok(result) => result,
                // A tool listed when the script started and gone since (a permission revoked).
                Err(UnknownTool(_)) => ToolResult {
                    content: vec![Content::Text {
                        text: "UNKNOWN_TOOL: this tool is not available on this connector."
                            .to_owned(),
                    }],
                    structured_content: None,
                    is_error: true,
                },
            }
        })
    }
}
