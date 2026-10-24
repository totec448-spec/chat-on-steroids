//! One tool call: who made it, what it may do, and the ports that attribute and record it.

use std::sync::Arc;

use cos_types::ids::{ConversationId, SessionId};
use cos_types::session::ToolOutcome;
use serde::Serialize;
use serde_json::Value;

use crate::connectors::Connectors;
use crate::grants::Grants;
use crate::kernel::{Kernel, UnknownTool};
use crate::tool::{BoxFuture, CallNotes, ToolResult};
use crate::{EpochMs, SurfaceId};

/// ChatGPT's id for one request, from the `x-request-id` header without its per-attempt
/// suffix: the header `wfr_<id>/<suffix>` is `wfr_<id>`, the half the page evidence names.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct RequestId(String);

impl RequestId {
    /// Normalizes the raw header once, at HTTP ingress (`requestIdFromHeader`). `None` for a
    /// missing, empty or malformed value.
    ///
    /// The transport passes one header value. A request that carries the header twice is
    /// ambiguous identity evidence and gets `None` without calling this.
    pub fn from_header(value: &str) -> Option<Self> {
        // JavaScript's `trim` also strips the byte order mark.
        let id = value
            .split('/')
            .next()
            .unwrap_or_default()
            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
        let valid = !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
        valid.then(|| Self(id.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What the transport knows about a request before the kernel sees it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Inbound {
    pub request_id: Option<RequestId>,
    /// The Setup profile that created this endpoint generation, frozen for its lifetime so a
    /// late call accepted before a profile switch keeps its own provenance.
    pub setup_profile_id: Option<String>,
}

/// The chat a call is proven to come from. Both ids are present or neither is: a session
/// without its conversation is not proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Caller {
    pub request_id: Option<RequestId>,
    pub chat: Option<(ConversationId, SessionId)>,
}

impl Caller {
    pub fn unattributed(request_id: Option<RequestId>) -> Self {
        Self {
            request_id,
            chat: None,
        }
    }

    pub fn is_attributed(&self) -> bool {
        self.chat.is_some()
    }
}

/// Places a call in its chat from browser evidence. The browser plane (E2.2) implements the
/// real one; until then every call is [`Unattributed`].
pub trait Attribution: Send + Sync + 'static {
    fn resolve<'a>(
        &'a self,
        tool: &'a str,
        started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller>;

    /// Waits as long as attribution itself would for the page to prove this exact request id
    /// (`awaitFreshCallOrigin` with `REQUEST_ID_GRACE_MS`). A rule that refuses calls by chat
    /// asks for this, so it never settles for less evidence than the chat's timeline will.
    fn resolve_proven<'a>(
        &'a self,
        tool: &'a str,
        started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller> {
        self.resolve(tool, started_at, request_id)
    }
}

/// The user's per-chat rules, decided before any handler runs: blocked chats, and the strict
/// chat allowlist. The session plane implements the real one.
pub trait ChatPolicy: Send + Sync + 'static {
    /// Whether a call with no proven chat should wait for its proof before the rules decide:
    /// any chat is blocked, or strict mode is on. One cheap read per call when nothing is.
    fn needs_proof(&self) -> bool;

    /// The refusal for a call from `caller`, or `None` to let it run.
    fn refusal(&self, caller: &Caller) -> Option<String>;
}

/// No chat rules: every call runs.
pub struct AnyChat;

impl ChatPolicy for AnyChat {
    fn needs_proof(&self) -> bool {
        false
    }

    fn refusal(&self, _caller: &Caller) -> Option<String> {
        None
    }
}

/// No browser plane: every call is filed as Unattributed.
pub struct Unattributed;

impl Attribution for Unattributed {
    fn resolve<'a>(
        &'a self,
        _tool: &'a str,
        _started_at: EpochMs,
        request_id: Option<&'a RequestId>,
    ) -> BoxFuture<'a, Caller> {
        let caller = Caller::unattributed(request_id.cloned());
        Box::pin(async move { caller })
    }
}

/// One finished call, as the recorder files it. Borrowed so recording copies nothing large.
pub struct CallRecord<'a> {
    pub surface: SurfaceId,
    pub tool: &'static str,
    /// A child call made from code mode (`invokeNested`), filed beside its parent.
    pub nested: bool,
    pub caller: &'a Caller,
    pub started_at: EpochMs,
    pub finished_at: EpochMs,
    pub outcome: ToolOutcome,
    pub arguments: &'a Value,
    pub result: &'a ToolResult,
    pub notes: &'a CallNotes,
}

/// Files finished calls into session history. The session store (C1.8) implements it. The
/// kernel awaits `record` before it answers, so a read of `/v1/sessions` after a call's reply
/// already sees that call.
pub trait CallRecorder: Send + Sync + 'static {
    fn record<'a>(&'a self, call: CallRecord<'a>) -> BoxFuture<'a, ()>;
}

/// A tool a code-mode script may call, as `ALL_TOOLS` lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NestedTool {
    pub name: String,
    pub description: String,
}

/// Everything a tool may know about the call it is running.
pub struct CallContext {
    pub surface: SurfaceId,
    /// The live grants, derived once when the call was admitted.
    pub grants: Arc<Grants>,
    pub caller: Caller,
    pub inbound: Inbound,
    pub started_at: EpochMs,
    /// Connector names and shared tunnel IDs, from the same config snapshot as `grants`.
    pub connectors: Connectors,
    kernel: Option<Arc<Kernel>>,
}

impl CallContext {
    /// A context outside the kernel, for a tool's own tests. Nested calls fail as unknown,
    /// and connectors have no suffix and no tunnel IDs.
    pub fn standalone(surface: SurfaceId, grants: Arc<Grants>, caller: Caller) -> Self {
        Self {
            surface,
            grants,
            caller,
            inbound: Inbound::default(),
            started_at: EpochMs::now(),
            connectors: Connectors::default(),
            kernel: None,
        }
    }

    pub(crate) fn in_kernel(
        surface: SurfaceId,
        grants: Arc<Grants>,
        caller: Caller,
        inbound: Inbound,
        started_at: EpochMs,
        connectors: Connectors,
        kernel: Arc<Kernel>,
    ) -> Self {
        Self {
            surface,
            grants,
            caller,
            inbound,
            started_at,
            connectors,
            kernel: Some(kernel),
        }
    }

    /// The tools this surface lists under the live grants, except `exec`, in listing order:
    /// what a code-mode script may call (the registrar's `descriptions()`). Empty outside the
    /// kernel.
    pub fn nested_tools(&self) -> Vec<NestedTool> {
        self.kernel
            .as_ref()
            .map_or_else(Vec::new, |kernel| kernel.nested_tools(self.surface))
    }

    /// Runs other tools of this surface as children of this call (code mode). The invoker
    /// owns what it needs, so a child may outlive this call.
    pub fn nested_invoker(&self) -> NestedInvoker {
        NestedInvoker {
            surface: self.surface,
            caller: self.caller.clone(),
            inbound: self.inbound.clone(),
            kernel: self.kernel.clone(),
        }
    }
}

/// Starts child calls for one parent call. Each child gets its own record, inherits the
/// parent's identity and re-checks the live grants and its arguments.
#[derive(Clone)]
pub struct NestedInvoker {
    pub(crate) surface: SurfaceId,
    pub(crate) caller: Caller,
    pub(crate) inbound: Inbound,
    kernel: Option<Arc<Kernel>>,
}

impl NestedInvoker {
    /// Runs `tool` as a child. The future borrows nothing, so it can run to completion after
    /// the parent answered; dropping it cancels the child. `UnknownTool` when the surface
    /// does not list `tool`, or outside the kernel.
    pub fn invoke(
        &self,
        tool: String,
        arguments: Value,
    ) -> BoxFuture<'static, Result<ToolResult, UnknownTool>> {
        let parent = self.clone();
        Box::pin(async move {
            match &parent.kernel {
                Some(kernel) => kernel.call_nested(&parent, &tool, arguments).await,
                None => Err(UnknownTool(tool)),
            }
        })
    }
}
