//! The kernel: one per Core, shared by every endpoint generation and every surface.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Instant;

use cos_store::Logger;
use cos_types::config::Config;
use cos_types::session::ToolOutcome;
use serde_json::{Map, Value};
use tokio::sync::watch;

use crate::admission::Admission;
use crate::call::{
    Attribution, CallContext, CallRecord, CallRecorder, Caller, ChatPolicy, Inbound, NestedInvoker,
    NestedTool,
};
use crate::connectors::Connectors;
use crate::declarations::{DECLARATIONS, Declaration};
use crate::exposure::{Exposed, Exposure};
use crate::grants::{GrantEnv, Grants};
use crate::instructions::{self, Facts, utf16_prefix};
use crate::tool::{CallNotes, Content, DynTool, Listing, ToolError, ToolResult};
use crate::validate::{ArgIssue, validate};
use crate::{EpochMs, SurfaceId};

/// The tools each surface can ever list. Order here does not matter: the kernel lists tools
/// in the order the TypeScript app registers them, from its own per-surface table.
#[derive(Default)]
pub struct SurfaceTools {
    core: Vec<Arc<dyn DynTool>>,
    desktop: Vec<Arc<dyn DynTool>>,
    plugins: Vec<Arc<dyn DynTool>>,
}

impl SurfaceTools {
    pub fn add(&mut self, surface: SurfaceId, tool: Arc<dyn DynTool>) -> &mut Self {
        self.of_mut(surface).push(tool);
        self
    }

    pub fn of(&self, surface: SurfaceId) -> &[Arc<dyn DynTool>] {
        match surface {
            SurfaceId::Core => &self.core,
            SurfaceId::Desktop => &self.desktop,
            SurfaceId::Plugins => &self.plugins,
        }
    }

    /// Registered tools with no recorded declaration. The kernel never lists them, so the
    /// composition root asserts this is empty.
    pub fn undeclared(&self) -> Vec<(SurfaceId, &'static str)> {
        SURFACES
            .into_iter()
            .flat_map(|surface| {
                self.of(surface)
                    .iter()
                    .map(move |tool| (surface, tool.spec().name))
            })
            .filter(|(surface, name)| DECLARATIONS.find(*surface, name).is_none())
            .collect()
    }

    fn of_mut(&mut self, surface: SurfaceId) -> &mut Vec<Arc<dyn DynTool>> {
        match surface {
            SurfaceId::Core => &mut self.core,
            SurfaceId::Desktop => &mut self.desktop,
            SurfaceId::Plugins => &mut self.plugins,
        }
    }
}

pub struct KernelDeps {
    /// The product version reported as `serverInfo.version`.
    pub app_version: &'static str,
    /// The Settings owner's published config. Grants are derived from it per call, and a
    /// config whose effective capabilities or feature switches changed forgets exposure
    /// (`forgetExposedSurface`), so a reconnect in ChatGPT reads the list the new settings give.
    pub config: watch::Receiver<Arc<Config>>,
    pub env: GrantEnv,
    pub tools: SurfaceTools,
    pub attribution: Arc<dyn Attribution>,
    /// Blocked chats and the strict allowlist, checked after attribution and before the
    /// requirement, on nested calls too.
    pub chat_policy: Arc<dyn ChatPolicy>,
    pub recorder: Arc<dyn CallRecorder>,
    pub admission: Admission,
    pub logger: Logger,
}

/// `serverInfo` and `instructions` of one surface's `initialize` result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerInfo {
    /// `chat-on-steroids-core`, `-desktop` or `-plugins`. ChatGPT keys its cache on it.
    pub name: &'static str,
    pub version: &'static str,
    pub instructions: String,
}

/// A `tools/call` for a tool this surface does not list. The only call failure that is a
/// JSON-RPC error (`-32602`, `Tool <name> not found`) rather than an `isError` result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownTool(pub String);

/// The counters `/v1/status` reports as `toolCalls`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CallCounts {
    /// Handlers that can still mutate the machine.
    pub running: u64,
    /// Calls whose handler finished and whose attribution or recording has not.
    pub settling: u64,
    pub in_flight: u64,
    /// MCP HTTP requests accepted and not yet answered, tool calls or not.
    pub in_flight_mcp_requests: u64,
}

#[derive(Default)]
struct Clocks {
    /// Epoch ms of the last request and the last tool call per surface; 0 means never.
    request: [AtomicU64; 3],
    tool_call: [AtomicU64; 3],
}

#[derive(Default)]
struct Counters {
    running: AtomicU64,
    settling: AtomicU64,
    in_flight: AtomicU64,
    in_flight_mcp_requests: AtomicU64,
}

/// A registered tool and its recorded declaration.
struct Entry {
    tool: Arc<dyn DynTool>,
    declaration: Declaration<'static>,
}

pub struct Kernel {
    deps: KernelDeps,
    /// Per surface, the registered tools that have a declaration, in listing order.
    catalog: [Vec<Entry>; 3],
    exposure: Exposure,
    /// The effective capabilities and feature switches of the last config a request saw,
    /// tagged so that 0 means none yet. A different value means the settings changed.
    settings_key: AtomicU32,
    clocks: Clocks,
    counters: Counters,
}

/// Held by the transport for the lifetime of one MCP HTTP request.
pub struct RequestGuard {
    kernel: Arc<Kernel>,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.kernel
            .counters
            .in_flight_mcp_requests
            .fetch_sub(1, Ordering::Relaxed);
    }
}

/// Counts while alive, so a call future dropped mid-flight cannot leave a count behind.
struct Counted<'a>(&'a AtomicU64);

impl<'a> Counted<'a> {
    fn new(counter: &'a AtomicU64) -> Self {
        counter.fetch_add(1, Ordering::Relaxed);
        Self(counter)
    }
}

impl Drop for Counted<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

const SURFACES: [SurfaceId; 3] = [SurfaceId::Core, SurfaceId::Desktop, SurfaceId::Plugins];

fn slot(surface: SurfaceId) -> usize {
    match surface {
        SurfaceId::Core => 0,
        SurfaceId::Desktop => 1,
        SurfaceId::Plugins => 2,
    }
}

fn server_name(surface: SurfaceId) -> &'static str {
    match surface {
        SurfaceId::Core => "chat-on-steroids-core",
        SurfaceId::Desktop => "chat-on-steroids-desktop",
        SurfaceId::Plugins => "chat-on-steroids-plugins",
    }
}

/// Whether the tool appears under `exposed`, before the code-mode rule (`WithOtherTools`).
fn listed_alone(listing: Listing, exposed: &Exposed) -> bool {
    match listing {
        Listing::Capability(capability) => exposed.capabilities.contains(capability),
        Listing::AnyCapability(capabilities) => exposed.capabilities.any_of(capabilities),
        Listing::Feature(feature) => exposed.features.contains(feature),
        Listing::FindInsteadOfCommand => exposed.find,
        Listing::WithOtherTools => false,
    }
}

fn first_text(result: &ToolResult) -> Option<&str> {
    result.content.iter().find_map(|part| match part {
        Content::Text { text } => Some(text.as_str()),
        Content::Image { .. } => None,
    })
}

fn error_result(text: String) -> ToolResult {
    ToolResult {
        content: vec![Content::Text { text }],
        structured_content: None,
        is_error: true,
    }
}

/// The SDK's schema refusal: `Input validation error: Invalid arguments for tool <name>: ...`.
fn schema_refusal(tool: &str, issues: &[ArgIssue]) -> ToolResult {
    let details: Vec<String> = issues.iter().map(ArgIssue::render).collect();
    error_result(format!(
        "Input validation error: Invalid arguments for tool {tool}: {}",
        details.join(", ")
    ))
}

/// The registrar's refusal for a nested call's arguments: at most three bounded issues.
fn nested_refusal(issues: &[ArgIssue]) -> ToolResult {
    let details: Vec<String> = issues
        .iter()
        .take(3)
        .map(|issue| {
            let path = utf16_prefix(&issue.path, 80);
            let path = if path.is_empty() { "arguments" } else { path };
            format!("{path}: {}", utf16_prefix(&issue.message, 300))
        })
        .collect();
    error_result(format!("INVALID_ARGUMENTS: {}", details.join("; ")))
}

/// Tools that must be called directly, never from code mode, by their recorded name.
fn lifecycle_call(tool: &str, arguments: &Value) -> Option<&'static str> {
    match tool {
        "exec" => Some("exec"),
        "session_finish" => Some("session_finish"),
        "agents" if arguments["action"] == "finish" => Some("agents"),
        _ => None,
    }
}

/// Appended to every call from a caller this app cannot place in a conversation
/// (`withUnattributedNotice`). The attribution recovery ETA arrives with the browser plane.
fn identity_notice(allow_unattributed: bool, has_request_id: bool) -> String {
    if !allow_unattributed {
        return "\n--- Identity notice ---\nThis app could not tell which ChatGPT conversation made this call, so it is filed as Unattributed. This does not identify this chat as a reload target. The result above still states what ran. Attribution does not change tool permissions or mean Read-only; report a refusal only for the operation that actually failed. Do not repeat a successful mutation to repair attribution. A later exact request-id match can reattach this recorded call. Retry a refused operation once, and preserve any undelivered report in the chat.".to_owned();
    }
    let ownership = if has_request_id {
        "This request id owns its workspace, update_plan, terminals and agents/subagents. Use the process and run ids returned to this request; later exact proof attaches that state to its chat. "
    } else {
        "This call has no request id, so request-owned plans and worker families cannot be created until a request id or exact chat proof is available. "
    };
    format!(
        "\n--- Identity notice ---\nThis call is filed as Unattributed because its exact ChatGPT conversation is not known yet. Unattributed does not switch on Read-only mode or disable tools. Continue using every enabled tool, including apply_patch, exec_command, Desktop and Plugins; their existing permissions still apply. {ownership}A refusal about a particular process, worker or chat target applies only to that operation, not to file edits or other tools. Report the actual tool result; do not claim mutation or terminal tools are unavailable because of this notice, and never replay successful work. "
    )
}

/// Appends app text to a result, and for Core also to `structuredContent.supplemental_context`
/// for hosts that read structured results instead of content.
fn append_text(surface: SurfaceId, mut result: ToolResult, text: String) -> ToolResult {
    if surface == SurfaceId::Core
        && let Some(Value::Object(fields)) = &mut result.structured_content
    {
        let merged = match fields.get("supplemental_context") {
            Some(Value::String(own)) if !own.is_empty() => format!("{own}\n{text}"),
            _ => text.clone(),
        };
        fields.insert("supplemental_context".to_owned(), Value::String(merged));
    }
    result.content.push(Content::Text { text });
    result
}

fn settings_key(grants: &Grants) -> u32 {
    1 << 31 | u32::from(grants.features.bits()) << 16 | u32::from(grants.capabilities.bits())
}

/// How one call is being run: from the transport, or from inside a code-mode script.
struct Invocation<'a> {
    surface: SurfaceId,
    entry: &'a Entry,
    grants: Arc<Grants>,
    connectors: Connectors,
    caller: Caller,
    inbound: Inbound,
    /// What the recorder files: the parsed arguments, or a nested call's raw ones.
    arguments: Value,
    /// What the handler receives, or the refusal a nested call's arguments earned instead.
    handler_arguments: Result<Value, ToolResult>,
    nested: bool,
}

impl Kernel {
    pub fn new(deps: KernelDeps) -> Arc<Self> {
        let catalog = SURFACES.map(|surface| {
            let mut entries: Vec<Entry> = Vec::new();
            for tool in deps.tools.of(surface) {
                let name = tool.spec().name;
                match DECLARATIONS.find(surface, name) {
                    Some(declaration) => entries.push(Entry {
                        tool: tool.clone(),
                        declaration,
                    }),
                    None => deps.logger.warn(&format!(
                        "MCP surface {} registered \"{name}\", which has no recorded declaration; it is never listed",
                        surface.as_str()
                    )),
                }
            }
            entries.sort_by_key(|entry| entry.declaration.position);
            entries
        });
        Arc::new(Self {
            deps,
            catalog,
            exposure: Exposure::default(),
            settings_key: AtomicU32::new(0),
            clocks: Clocks::default(),
            counters: Counters::default(),
        })
    }

    /// Starts a new endpoint generation: forgets exposure and the per-surface clocks.
    pub fn begin_generation(&self) {
        self.exposure.reset();
        self.settings_key.store(0, Ordering::Release);
        for clock in self.clocks.request.iter().chain(&self.clocks.tool_call) {
            clock.store(0, Ordering::Relaxed);
        }
    }

    /// Counts an accepted MCP request against `surface` until the guard drops.
    pub fn begin_request(self: &Arc<Self>, surface: SurfaceId) -> RequestGuard {
        self.clocks.request[slot(surface)].store(EpochMs::now().0, Ordering::Relaxed);
        self.counters
            .in_flight_mcp_requests
            .fetch_add(1, Ordering::Relaxed);
        RequestGuard {
            kernel: self.clone(),
        }
    }

    pub fn server_info(&self, surface: SurfaceId) -> ServerInfo {
        let (config, grants) = self.live();
        let exposed = self.observe(surface, &grants);
        let plugin_tools = surface == SurfaceId::Plugins
            && self
                .listed(surface, &exposed)
                .any(|entry| entry.tool.spec().name != "exec");
        let facts = Facts {
            config: &config,
            env: &self.deps.env,
            grants: &grants,
            exposed,
            plugin_tools,
        };
        ServerInfo {
            name: server_name(surface),
            version: self.deps.app_version,
            instructions: instructions::render(surface, &facts),
        }
    }

    /// The surface's `tools` array: each element as the TypeScript server sent it, key order
    /// included, with this config's roots filled in.
    pub fn list(&self, surface: SurfaceId) -> Vec<Value> {
        let (_, grants) = self.live();
        let exposed = self.observe(surface, &grants);
        let roots = roots_text(&grants);
        self.listed(surface, &exposed)
            .map(|entry| entry.declaration.render(&roots))
            .collect()
    }

    /// Runs one `tools/call`: admission, schema validation, requirement, attribution, the
    /// handler, error mapping, the identity notice, recording and the counters.
    pub async fn call(
        self: &Arc<Self>,
        surface: SurfaceId,
        tool: &str,
        arguments: Value,
        inbound: Inbound,
    ) -> Result<ToolResult, UnknownTool> {
        let (config, grants) = self.live();
        let exposed = self.observe(surface, &grants);
        let Some(entry) = self
            .listed(surface, &exposed)
            .find(|entry| entry.tool.spec().name == tool)
        else {
            return Err(UnknownTool(tool.to_owned()));
        };
        // The SDK validates `arguments ?? {}`.
        let arguments = if arguments.is_null() {
            Value::Object(Map::new())
        } else {
            arguments
        };
        let arguments = match self.check_arguments(entry, &arguments) {
            Ok(parsed) => parsed,
            Err(issues) => return Ok(schema_refusal(tool, &issues)),
        };
        if self.deps.admission.admit().await.is_err() {
            return Ok(error_result(
                "SERVER_STOPPING: Chat On Steroids is shutting down, so no local tool was run."
                    .to_owned(),
            ));
        }
        let started_at = EpochMs::now();
        let name = entry.tool.spec().name;
        let attribution = &self.deps.attribution;
        let request_id = inbound.request_id.as_ref();
        let mut caller = attribution.resolve(name, started_at, request_id).await;
        // A block or the strict allowlist refuses by chat, so a call whose page proof is late
        // waits for it instead of running as "no proven chat" and then landing in the blocked
        // chat's timeline.
        if !caller.is_attributed() && request_id.is_some() && self.deps.chat_policy.needs_proof() {
            caller = attribution
                .resolve_proven(name, started_at, request_id)
                .await;
        }
        Ok(self
            .run(Invocation {
                surface,
                entry,
                grants,
                connectors: Connectors::from_config(&config),
                caller,
                inbound,
                handler_arguments: Ok(arguments.clone()),
                arguments,
                nested: false,
            })
            .await)
    }

    pub(crate) async fn call_nested(
        self: &Arc<Self>,
        parent: &NestedInvoker,
        tool: &str,
        arguments: Value,
    ) -> Result<ToolResult, UnknownTool> {
        let surface = parent.surface;
        if let Some(name) = lifecycle_call(tool, &arguments) {
            let refusal = error_result(
                "DIRECT_CALL_REQUIRED: call this lifecycle tool directly, outside exec. No action was taken."
                    .to_owned(),
            );
            let now = EpochMs::now();
            self.deps
                .recorder
                .record(CallRecord {
                    surface,
                    tool: name,
                    nested: true,
                    caller: &parent.caller,
                    started_at: now,
                    finished_at: now,
                    outcome: ToolOutcome::ToolRejected,
                    arguments: &arguments,
                    result: &refusal,
                    notes: &CallNotes::default(),
                })
                .await;
            return Ok(refusal);
        }
        // Children recheck the live grants, so a permission revoked during a script applies.
        let (config, grants) = self.live();
        let exposed = self.observe(surface, &grants);
        let Some(entry) = self
            .listed(surface, &exposed)
            .find(|entry| entry.tool.spec().name == tool)
        else {
            return Err(UnknownTool(tool.to_owned()));
        };
        // Checked inside the recorded call and worded as the registrar words it
        // (`INVALID_ARGUMENTS`), not as the SDK words a direct call's.
        let handler_arguments = self
            .check_arguments(entry, &arguments)
            .map_err(|issues| nested_refusal(&issues));
        let invocation = Invocation {
            surface,
            entry,
            grants,
            connectors: Connectors::from_config(&config),
            caller: parent.caller.clone(),
            inbound: parent.inbound.clone(),
            arguments,
            handler_arguments,
            nested: true,
        };
        Ok(self.run(invocation).await)
    }

    /// What `list` serves on `surface`, except `exec`, as name and description.
    pub(crate) fn nested_tools(&self, surface: SurfaceId) -> Vec<NestedTool> {
        let (_, grants) = self.live();
        let exposed = self.observe(surface, &grants);
        let roots = roots_text(&grants);
        self.listed(surface, &exposed)
            .filter(|entry| entry.tool.spec().name != "exec")
            .map(|entry| NestedTool {
                name: entry.tool.spec().name.to_owned(),
                description: entry.declaration.description(&roots),
            })
            .collect()
    }

    pub fn counts(&self) -> CallCounts {
        let read = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        CallCounts {
            running: read(&self.counters.running),
            settling: read(&self.counters.settling),
            in_flight: read(&self.counters.in_flight),
            in_flight_mcp_requests: read(&self.counters.in_flight_mcp_requests),
        }
    }

    pub fn last_request_at(&self, surface: SurfaceId) -> Option<EpochMs> {
        let at = self.clocks.request[slot(surface)].load(Ordering::Relaxed);
        (at != 0).then_some(EpochMs(at))
    }

    /// The last tool call ChatGPT actually ran on `surface`: proof the whole chain works.
    pub fn last_tool_call_at(&self, surface: SurfaceId) -> Option<EpochMs> {
        let at = self.clocks.tool_call[slot(surface)].load(Ordering::Relaxed);
        (at != 0).then_some(EpochMs(at))
    }

    fn live(&self) -> (Arc<Config>, Arc<Grants>) {
        let config = self.deps.config.borrow().clone();
        let grants = Arc::new(Grants::derive(&config, &self.deps.env));
        (config, grants)
    }

    /// Joins `grants` into the surface's exposure. A deliberate settings change (different
    /// effective capabilities or feature switches) first forgets what was exposed, as the
    /// TypeScript settings save does with `forgetExposedSurface`.
    fn observe(&self, surface: SurfaceId, grants: &Grants) -> Exposed {
        let key = settings_key(grants);
        let previous = self.settings_key.swap(key, Ordering::AcqRel);
        if previous != 0 && previous != key {
            self.exposure.reset();
        }
        self.exposure.observe(surface, grants)
    }

    /// The registered tools `exposed` lists on `surface`, in listing order. Code mode is listed
    /// when at least one other tool is.
    fn listed<'a>(
        &'a self,
        surface: SurfaceId,
        exposed: &Exposed,
    ) -> impl Iterator<Item = &'a Entry> + 'a {
        let entries = &self.catalog[slot(surface)];
        let others = entries
            .iter()
            .any(|entry| listed_alone(entry.tool.spec().listing, exposed));
        let exposed = *exposed;
        entries
            .iter()
            .filter(move |entry| match entry.tool.spec().listing {
                Listing::WithOtherTools => others,
                listing => listed_alone(listing, &exposed),
            })
    }

    /// Schema validation and the tool's refinements. `Ok` holds the parsed arguments.
    fn check_arguments(&self, entry: &Entry, arguments: &Value) -> Result<Value, Vec<ArgIssue>> {
        let mut checked = validate(
            entry.declaration.input_schema(),
            arguments,
            entry.tool.string_checks(),
        );
        if checked.refinable
            && let Err(more) = entry.tool.refine_json(&checked.value)
        {
            checked.issues.extend(more);
        }
        if checked.issues.is_empty() {
            Ok(checked.value)
        } else {
            Err(checked.issues)
        }
    }

    /// Everything after admission: chat policy, requirement, handler, error mapping, log,
    /// notice, record.
    async fn run(self: &Arc<Self>, call: Invocation<'_>) -> ToolResult {
        let _in_flight = Counted::new(&self.counters.in_flight);
        let running = Counted::new(&self.counters.running);
        let spec = call.entry.tool.spec();
        let started_at = EpochMs::now();
        let clock = Instant::now();
        self.clocks.tool_call[slot(call.surface)].store(started_at.0, Ordering::Relaxed);

        let (result, notes, outcome) = match call.handler_arguments {
            Err(refusal) => (refusal, CallNotes::default(), ToolOutcome::ToolRejected),
            Ok(arguments) => {
                let allowed = match self.deps.chat_policy.refusal(&call.caller) {
                    Some(refusal) => Err(ToolError::Refused(refusal)),
                    None => call.grants.require(spec.requires, spec.name),
                };
                let handled = match allowed {
                    Ok(()) => {
                        let context = CallContext::in_kernel(
                            call.surface,
                            call.grants.clone(),
                            call.caller.clone(),
                            call.inbound,
                            started_at,
                            call.connectors,
                            self.clone(),
                        );
                        call.entry.tool.call_json(&context, arguments).await
                    }
                    Err(refusal) => Err(refusal),
                };
                self.settle(spec.name, handled, clock)
            }
        };
        drop(running);

        let _settling = Counted::new(&self.counters.settling);
        let delivered = if call.nested || call.caller.is_attributed() {
            result
        } else {
            let notice = identity_notice(
                call.grants.allow_unattributed,
                call.caller.request_id.is_some(),
            );
            append_text(call.surface, result, notice)
        };
        self.deps
            .recorder
            .record(CallRecord {
                surface: call.surface,
                tool: spec.name,
                nested: call.nested,
                caller: &call.caller,
                started_at,
                finished_at: EpochMs::now(),
                outcome,
                arguments: &call.arguments,
                result: &delivered,
                notes: &notes,
            })
            .await;
        delivered
    }

    /// Maps the handler's answer to a result and an outcome, and logs it as `guard` does.
    fn settle(
        &self,
        tool: &str,
        handled: Result<crate::tool::ToolOutput, ToolError>,
        clock: Instant,
    ) -> (ToolResult, CallNotes, ToolOutcome) {
        let elapsed = clock.elapsed().as_millis();
        let logger = &self.deps.logger;
        match handled {
            Ok(output) if !output.result.is_error => {
                logger.info(&format!("tool {tool} ok in {elapsed} ms"));
                let outcome = output.notes.outcome.unwrap_or(ToolOutcome::Ok);
                (output.result, output.notes, outcome)
            }
            Ok(output) => {
                log_rejected(logger, tool, elapsed, first_text(&output.result));
                let outcome = output.notes.outcome.unwrap_or(ToolOutcome::ToolRejected);
                (output.result, output.notes, outcome)
            }
            Err(error) => {
                let outcome = error.outcome();
                let text = error.to_string();
                let structured = match error {
                    ToolError::Internal(_) => {
                        logger.warn(&format!("tool {tool} failed in {elapsed} ms: {text}"));
                        None
                    }
                    ToolError::Refused(_) | ToolError::Identity(_) => {
                        log_rejected(logger, tool, elapsed, Some(&text));
                        None
                    }
                    ToolError::RefusedWithDetail { detail, .. } => {
                        log_rejected(logger, tool, elapsed, Some(&text));
                        Some(serde_json::json!({ "error": detail }))
                    }
                };
                (
                    ToolResult {
                        structured_content: structured,
                        ..error_result(text)
                    },
                    CallNotes::default(),
                    outcome,
                )
            }
        }
    }
}

/// Only the first line of a refusal, bounded, so Activity never copies command output.
fn log_rejected(logger: &Logger, tool: &str, elapsed: u128, text: Option<&str>) {
    let summary = text
        .and_then(|text| text.split('\n').next())
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .map(|line| utf16_prefix(line, 500))
        .filter(|line| !line.is_empty());
    match summary {
        Some(summary) => logger.info(&format!("tool {tool} rejected in {elapsed} ms: {summary}")),
        None => logger.info(&format!("tool {tool} rejected in {elapsed} ms")),
    }
}

/// The live roots as `read`'s description names them: `/project, /skills`.
fn roots_text(grants: &Grants) -> String {
    grants
        .roots
        .iter()
        .map(|root| root.name.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}
