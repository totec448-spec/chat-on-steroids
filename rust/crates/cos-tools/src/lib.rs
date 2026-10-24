//! The model-facing tool kernel. Everything a tool is wired through, independent of which
//! surface lists it: capability projection, monotonic exposure, `TOOL_DISABLED`, error mapping,
//! the call clock, attribution and recording. Unit C1.2 owns this crate (port of
//! `src/main/mcp/{kernel,surfaces,tools,call-context,tool-declarations,instructions,coding-instructions}.ts`).
//!
//! A tool crate implements [`Tool`] and nothing else. The kernel decides whether a tool is
//! listed, refuses calls the live grants do not allow, maps every error to a tool result,
//! appends the identity notice, records the call and keeps the counters. A surface decides
//! which tools exist, never how a tool is wired up.
//!
//! The transport (`cos-mcp`, C1.1) parses HTTP and JSON-RPC and calls [`Kernel::list`] and
//! [`Kernel::call`]; the kernel never sees HTTP.

mod admission;
mod call;
mod connectors;
mod declarations;
mod exposure;
mod grants;
mod instructions;
mod kernel;
mod tool;
mod validate;

pub use admission::{Admission, AdmissionGate, Closed, Phase};
pub use call::{
    AnyChat, Attribution, CallContext, CallRecord, CallRecorder, Caller, ChatPolicy, Inbound,
    NestedInvoker, NestedTool, RequestId, Unattributed,
};
pub use connectors::Connectors;
pub use exposure::{Exposed, Exposure};
pub use grants::{CapabilitySet, Feature, FeatureSet, GrantEnv, Grants};
pub use kernel::{
    CallCounts, Kernel, KernelDeps, RequestGuard, ServerInfo, SurfaceTools, UnknownTool,
};
pub use tool::{
    BoxFuture, CallNotes, Content, DynTool, Listing, ProcessNotes, Requirement, Tool, ToolError,
    ToolOutput, ToolResult, ToolSpec,
};
pub use validate::{ArgIssue, StringCheck};

pub use cos_types::app_state::SurfaceId;
pub use cos_types::config::Capability;
/// The types `CallNotes` carries, so a tool crate needs no `cos-types` edge to fill them.
pub use cos_types::session::{FileChange, ToolOutcome};

use std::time::{SystemTime, UNIX_EPOCH};

/// Wall-clock milliseconds since the Unix epoch, the unit every recorded and published time uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EpochMs(pub u64);

impl EpochMs {
    pub fn now() -> Self {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        Self(u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
    }
}
