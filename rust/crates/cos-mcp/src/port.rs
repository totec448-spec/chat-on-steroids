//! What the transport asks of the kernel. [`Kernel`] is the only implementation the Core
//! uses; the crate's tests substitute one that answers from the golden corpus, so the
//! transport is proven without the kernel unit.

use std::sync::Arc;

use cos_tools::{
    BoxFuture, Inbound, Kernel, RequestGuard, ServerInfo, SurfaceId, ToolResult, UnknownTool,
};
use serde_json::Value;

pub(crate) trait Dispatch: Send + Sync + 'static {
    /// Held while one accepted MCP request is being answered.
    type Request: Send + 'static;

    fn begin_generation(&self);
    fn begin_request(self: &Arc<Self>, surface: SurfaceId) -> Self::Request;
    fn server_info(&self, surface: SurfaceId) -> ServerInfo;
    fn list(&self, surface: SurfaceId) -> Vec<Value>;
    fn call(
        self: &Arc<Self>,
        surface: SurfaceId,
        tool: String,
        arguments: Value,
        inbound: Inbound,
    ) -> BoxFuture<'static, Result<ToolResult, UnknownTool>>;
}

impl Dispatch for Kernel {
    type Request = RequestGuard;

    fn begin_generation(&self) {
        Kernel::begin_generation(self);
    }

    fn begin_request(self: &Arc<Self>, surface: SurfaceId) -> RequestGuard {
        Kernel::begin_request(self, surface)
    }

    fn server_info(&self, surface: SurfaceId) -> ServerInfo {
        Kernel::server_info(self, surface)
    }

    fn list(&self, surface: SurfaceId) -> Vec<Value> {
        Kernel::list(self, surface)
    }

    fn call(
        self: &Arc<Self>,
        surface: SurfaceId,
        tool: String,
        arguments: Value,
        inbound: Inbound,
    ) -> BoxFuture<'static, Result<ToolResult, UnknownTool>> {
        let kernel = self.clone();
        Box::pin(async move { kernel.call(surface, &tool, arguments, inbound).await })
    }
}
