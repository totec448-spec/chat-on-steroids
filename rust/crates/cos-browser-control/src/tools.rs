//! The eight `browser_*` Desktop tools (`tools-browser.ts`). Each resolves who may own the
//! browser work, queues it through the broker and turns the browser's result into a tool
//! result. Schemas and descriptions are the kernel's recorded declarations. What zod checked
//! beyond them is [`STRING_CHECKS`], which the kernel applies in its schema walk, and
//! [`Kind::refine`].

use std::marker::PhantomData;
use std::sync::Arc;

use base64::Engine as _;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use cos_tools::{
    ArgIssue, CallContext, Capability, Content, DynTool, Listing, Requirement, StringCheck, Tool,
    ToolError, ToolOutput, ToolResult, ToolSpec,
};
use cos_types::mcp::{BrowserResult, BrowserTool};
use serde_json::{Map, Value, json};

use crate::broker::Check;
use crate::{BrowserControl, Chat};

/// `BROWSER_LIMITS.imageBytes`: the largest screenshot a browser may return.
pub const IMAGE_BYTES: usize = 1_200_000;

const IDENTITY_REQUIRED: &str = "BROWSER_IDENTITY_REQUIRED: exact local session or Allow unattributed calls is required. No browser operation ran.";
const INVALID_IMAGE: &str = "unable to process image: invalid or unsupported image data";
/// `tabId` is `/^[a-f\d-]{36}:\d+$/i`, whose flag JSON Schema drops, and `pageId` is a UUID with
/// its own message.
const STRING_CHECKS: &[StringCheck] = &[
    StringCheck {
        path: "tabId",
        flags: "i",
        message: None,
    },
    StringCheck {
        path: "pageId",
        flags: "",
        message: Some(
            "Copy the top-level pageId from the observation, not a frameId or element ref.",
        ),
    },
];

/// The Desktop browser tools in their declaration order.
pub fn tools(control: &BrowserControl) -> Vec<Arc<dyn DynTool>> {
    fn one<K: Kind>(control: &BrowserControl) -> Arc<dyn DynTool> {
        Arc::new(Browse::<K> {
            control: control.clone(),
            kind: PhantomData,
        })
    }
    vec![
        one::<Tabs>(control),
        one::<Snapshot>(control),
        one::<Screenshot>(control),
        one::<Navigate>(control),
        one::<Action>(control),
        one::<Evaluate>(control),
        one::<Console>(control),
        one::<Network>(control),
    ]
}

/// `browserToolWrites`: tabs observe and attach, but opening and closing a tab is input.
fn writes(tool: BrowserTool, args: &Map<String, Value>) -> bool {
    BrowserTool::WRITE.contains(&tool)
        || (tool == BrowserTool::Tabs
            && matches!(
                args.get("action").and_then(Value::as_str),
                Some("new" | "close")
            ))
}

/// What differs between the eight tools.
trait Kind: Send + Sync + 'static {
    const TOOL: BrowserTool;
    const SPEC: &'static ToolSpec;

    /// The zod refinements of this tool's schema.
    fn refine(args: &Args, issues: &mut Vec<ArgIssue>) {
        let _ = (args, issues);
    }
}

const fn spec(name: &'static str, capability: Capability) -> ToolSpec {
    ToolSpec {
        name,
        listing: Listing::Capability(capability),
        requires: Requirement::Capability(capability),
    }
}

/// The parsed arguments, forwarded to the extension as they are.
type Args = Map<String, Value>;

/// zod's truthiness of an optional string: present and not empty.
fn filled(args: &Args, key: &str) -> bool {
    matches!(args.get(key), Some(Value::String(text)) if !text.is_empty())
}

fn present(args: &Args, key: &str) -> bool {
    args.get(key).is_some_and(|value| !value.is_null())
}

fn action(args: &Args) -> &str {
    args.get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

struct Tabs;
impl Kind for Tabs {
    const TOOL: BrowserTool = BrowserTool::Tabs;
    // Listed with "See the screen"; `new` and `close` need "Control" too, checked per call.
    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "browser_tabs",
        listing: Listing::Capability(Capability::Screen),
        requires: Requirement::None,
    };

    fn refine(args: &Args, issues: &mut Vec<ArgIssue>) {
        if matches!(action(args), "attach" | "release" | "close") && !filled(args, "tabId") {
            issues.push(ArgIssue::new("tabId", "Required for this action"));
        }
    }
}

struct Snapshot;
impl Kind for Snapshot {
    const TOOL: BrowserTool = BrowserTool::Snapshot;
    const SPEC: &'static ToolSpec = &spec("browser_snapshot", Capability::Screen);
}

struct Screenshot;
impl Kind for Screenshot {
    const TOOL: BrowserTool = BrowserTool::Screenshot;
    const SPEC: &'static ToolSpec = &spec("browser_screenshot", Capability::Screen);
}

struct Console;
impl Kind for Console {
    const TOOL: BrowserTool = BrowserTool::Console;
    const SPEC: &'static ToolSpec = &spec("browser_console", Capability::Screen);
}

struct Network;
impl Kind for Network {
    const TOOL: BrowserTool = BrowserTool::Network;
    const SPEC: &'static ToolSpec = &spec("browser_network", Capability::Screen);
}

struct Navigate;
impl Kind for Navigate {
    const TOOL: BrowserTool = BrowserTool::Navigate;
    const SPEC: &'static ToolSpec = &spec("browser_navigate", Capability::Control);

    fn refine(args: &Args, issues: &mut Vec<ArgIssue>) {
        if action(args) == "url" && !filled(args, "url") {
            issues.push(ArgIssue::new("url", "URL required"));
        }
    }
}

struct Action;
impl Kind for Action {
    const TOOL: BrowserTool = BrowserTool::Action;
    const SPEC: &'static ToolSpec = &spec("browser_action", Capability::Control);

    fn refine(args: &Args, issues: &mut Vec<ArgIssue>) {
        let mut need = |condition: bool, field: &str, message: &str| {
            if !condition {
                issues.push(ArgIssue::new(field, message));
            }
        };
        let action = action(args);
        let coordinates =
            |x: &str, y: &str| present(args, x) && present(args, y) && filled(args, "screenshotId");
        if matches!(action, "click" | "hover" | "scroll" | "drag") {
            need(
                filled(args, "ref") || coordinates("x", "y"),
                "ref",
                "Use a DOM ref or x/y with screenshotId",
            );
        }
        if matches!(action, "fill" | "type" | "select") {
            need(filled(args, "ref"), "ref", "Editable/select ref required");
        }
        if matches!(action, "fill" | "type") {
            need(
                present(args, "text"),
                "text",
                "Text required (empty fill clears the field)",
            );
        }
        if action == "select" {
            need(present(args, "values"), "values", "Values required");
        }
        if action == "key" {
            need(filled(args, "key"), "key", "Key chord required");
        }
        if present(args, "holdMs") {
            need(action == "key", "holdMs", "Only supported for key input");
        }
        if action == "dialog" {
            need(present(args, "accept"), "accept", "Specify accept");
        }
        if action == "drag" {
            need(
                filled(args, "toRef") || coordinates("toX", "toY"),
                "toRef",
                "Destination ref or coordinates required",
            );
        }
    }
}

struct Evaluate;
impl Kind for Evaluate {
    const TOOL: BrowserTool = BrowserTool::Evaluate;
    const SPEC: &'static ToolSpec = &spec("browser_evaluate", Capability::Control);
}

struct Browse<K> {
    control: BrowserControl,
    kind: PhantomData<fn() -> K>,
}

/// Who a queued command belongs to, kept so the late checks can ask again.
#[derive(Clone)]
enum Principal {
    /// The call was proven to come from this chat.
    Exact(Chat),
    /// Not proven when it was made. A later page proof of its request id makes it exact.
    Unproven(Option<String>),
}

impl<K: Kind> Tool for Browse<K> {
    type Args = Args;

    const SPEC: &'static ToolSpec = K::SPEC;
    const STRING_CHECKS: &'static [StringCheck] = STRING_CHECKS;

    fn refine(args: &Args) -> Result<(), Vec<ArgIssue>> {
        let mut issues = Vec::new();
        K::refine(args, &mut issues);
        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }

    async fn call(&self, cx: &CallContext, args: Args) -> Result<ToolOutput, ToolError> {
        let tool = K::TOOL;
        let capability = if writes(tool, &args) {
            Capability::Control
        } else {
            Capability::Screen
        };
        if K::SPEC.requires == Requirement::None {
            cx.grants
                .require(Requirement::Capability(capability), K::SPEC.name)?;
        }
        let request = cx
            .caller
            .request_id
            .as_ref()
            .map(|id| id.as_str().to_owned());
        let exact = cx
            .caller
            .chat
            .clone()
            .map(|(conversation, session)| Chat {
                conversation,
                session,
            })
            .or_else(|| {
                request
                    .as_deref()
                    .and_then(|id| self.control.proof.proven(id))
            });
        let owner = match (&exact, &request) {
            (Some(chat), _) => format!("session:{}", chat.session),
            (None, Some(id)) if cx.grants.allow_unattributed => format!("request:{id}"),
            (None, None) if cx.grants.allow_unattributed => "unattributed".to_owned(),
            (None, _) => return Err(ToolError::Identity(IDENTITY_REQUIRED.to_owned())),
        };
        let conversation = exact.as_ref().map(|chat| chat.conversation.to_string());
        let principal = match exact {
            Some(chat) => Principal::Exact(chat),
            None => Principal::Unproven(request),
        };
        let check = self.check(capability, principal);
        let result = self
            .control
            .broker
            .execute(tool, args, owner, conversation, check)
            .await;
        respond(result).await
    }
}

impl<K: Kind> Browse<K> {
    /// The late check a queued command carries: the permission is still on, and the chat that
    /// owns it may still act.
    fn check(&self, capability: Capability, principal: Principal) -> Check {
        let control = self.control.clone();
        Arc::new(move || {
            let control = control.clone();
            let principal = principal.clone();
            Box::pin(async move {
                if !control.allows(capability) {
                    return false;
                }
                let chat = match principal {
                    Principal::Exact(chat) => Some(chat),
                    Principal::Unproven(request) => {
                        request.and_then(|id| control.proof.proven(&id))
                    }
                };
                let Some(chat) = chat else {
                    return control.grants().allow_unattributed;
                };
                control.proof.live(&chat).await && control.allows(capability)
            })
        })
    }
}

/// The browser's answer as a tool result: its value as JSON text and as
/// `structuredContent.value`, then a screenshot as one native image block.
async fn respond(result: BrowserResult) -> Result<ToolOutput, ToolError> {
    if let Some(error) = result.error.filter(|error| !error.is_empty()) {
        return Err(ToolError::Refused(error));
    }
    let value = result.value.unwrap_or(Value::Null);
    let mut content = vec![Content::Text {
        text: serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned()),
    }];
    if let Some(image) = result.image {
        content.push(image_block(image.data).await?);
    }
    Ok(ToolResult {
        content,
        structured_content: Some(json!({ "value": value })),
        is_error: false,
    }
    .into())
}

/// Node's `Buffer.from(data, 'base64')`, which ignores padding.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// Checks the screenshot's size and every pixel (`validateImageBytes`) before the model sees
/// it. The mime type is the one the bytes prove, not the one the browser claimed.
async fn image_block(data: String) -> Result<Content, ToolError> {
    let alphabet_ok = {
        let body = data.trim_end_matches('=');
        data.len() - body.len() <= 2
            && body
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
    };
    if !alphabet_ok || data.len() > (IMAGE_BYTES * 4).div_ceil(3) {
        return Err(ToolError::Refused(
            "BROWSER_IMAGE_INVALID: screenshot exceeds its byte limit.".to_owned(),
        ));
    }
    let invalid = || ToolError::Internal(INVALID_IMAGE.to_owned());
    let bytes = LENIENT.decode(&data).map_err(|_| invalid())?;
    let mime = tokio::task::spawn_blocking(move || cos_fs::validate_image_bytes(&bytes))
        .await
        .ok()
        .flatten()
        .ok_or_else(invalid)?;
    Ok(Content::Image {
        data,
        mime_type: mime.as_str().to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_and_closing_tabs_and_javascript_are_writes() {
        let with = |action: &str| {
            let mut args = Map::new();
            args.insert("action".to_owned(), json!(action));
            args
        };
        assert!(!writes(BrowserTool::Tabs, &with("list")));
        assert!(!writes(BrowserTool::Tabs, &with("attach")));
        assert!(writes(BrowserTool::Tabs, &with("new")));
        assert!(writes(BrowserTool::Tabs, &with("close")));
        assert!(writes(BrowserTool::Evaluate, &Map::new()));
        assert!(!writes(BrowserTool::Snapshot, &Map::new()));
    }
}
