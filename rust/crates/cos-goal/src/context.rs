//! The conversation as the helper sees it (`conversationMessages`): authored user requests,
//! ChatGPT's commentary and final answers in order, and of tool calls only a count per turn.
//! No tool names, arguments, results or file contents leave this machine.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use cos_sessions::SessionStore;
use cos_types::ids::SessionId;
use cos_types::session::{EventSource, SessionEvent};

use crate::human::clip;
use crate::js;

/// How many messages of history the helper is given, newest kept.
pub const MAX_CONTEXT_MESSAGES: usize = 120;
/// Recent CoS calls read to count per turn.
const MAX_TOOL_CALLS_COUNTED: usize = 500;
/// The whole context in characters, so one huge answer cannot be the whole prompt.
const MAX_CONTEXT_CHARS: usize = 120_000;
/// The per-message cut for answers.
const MAX_MESSAGE_CHARS: usize = 12_000;
/// Requests keep their middle requirements too.
const MAX_USER_MESSAGE_CHARS: usize = 48_000;
/// Hold calls are waiting, not work.
const HOLD_TOOLS: [&str; 2] = ["session_finish", "keep_astra_on_forever"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

/// One row of the reference transcript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    /// A message the app itself sent, from the outbox's own identity.
    pub automatic: bool,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
            automatic: false,
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            automatic: false,
        }
    }

    /// `JSON.stringify(message)`, in the TypeScript key order.
    pub fn to_json(&self) -> Value {
        let mut object = serde_json::Map::new();
        let role = match self.role {
            Role::User => "user",
            Role::Assistant => "assistant",
        };
        object.insert("role".into(), Value::from(role));
        if self.automatic {
            object.insert("origin".into(), Value::from("automatic"));
        }
        object.insert("content".into(), Value::from(self.content.clone()));
        Value::Object(object)
    }
}

/// `JSON.stringify(messages)`.
pub fn stringify(messages: &[ChatMessage]) -> String {
    Value::Array(messages.iter().map(ChatMessage::to_json).collect()).to_string()
}

fn pattern(source: &str) -> Regex {
    Regex::new(source).unwrap_or_else(|error| panic!("context pattern {source}: {error}"))
}

static LEAF_DIRECTIVE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?im)^[ \t]*::[a-z][A-Za-z0-9_-]*(?:\{[^}\n]*\})?[ \t]*$"));
static CONTAINER_LINE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?im)^[ \t]*:::([a-z][A-Za-z0-9_-]*)(?:\{[^}\n]*\})?[ \t]*$"));
static CONTAINER_CLOSE: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?m)^[ \t]*:::[ \t]*$"));
static ANY_DIRECTIVE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(r"(?i)(?:^|\n)[ \t]*:{2,3}[a-z][A-Za-z0-9_-]*(?:\{[^}\n]*\})?[ \t]*(?:\n|$)")
});
static BLANK_RUNS: LazyLock<Regex> = LazyLock::new(|| pattern(r"\n{3,}"));
static SCRIPTS: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?is)<script\b.*?</script>|<style\b.*?</style>"));
static BREAKS: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)<br\s*/?>"));
static BLOCK_ENDS: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)</(?:p|div|li|h[1-6]|pre|blockquote|tr)>"));
static TAGS: LazyLock<Regex> = LazyLock::new(|| pattern(r"<[^>]+>"));
static ENTITIES: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)&(#\d+|#x[0-9a-f]+|[a-z]+|#39);"));
static SPACE_BEFORE_BREAK: LazyLock<Regex> = LazyLock::new(|| pattern(r"[ \t]+\n"));

/// `:::name` lines other than `:::writing`, which the renderer draws itself.
fn unknown_containers(text: &str) -> Vec<(usize, usize)> {
    CONTAINER_LINE
        .captures_iter(text)
        .filter(|captures| {
            let name = captures.get(1).map_or("", |m| m.as_str());
            !(name.len() >= 7
                && name[..7].eq_ignore_ascii_case("writing")
                && !name[7..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
        })
        .filter_map(|captures| captures.get(0).map(|m| (m.start(), m.end())))
        .collect()
}

fn has_provider_directive(text: &str) -> bool {
    LEAF_DIRECTIVE.is_match(text) || !unknown_containers(text).is_empty()
}

fn without_provider_directives(text: &str) -> String {
    let containers = unknown_containers(text);
    let had_container = !containers.is_empty();
    let mut result = LEAF_DIRECTIVE.replace_all(text, "").into_owned();
    let open = unknown_containers(&result);
    for (start, end) in open.into_iter().rev() {
        result.replace_range(start..end, "");
    }
    if had_container {
        result = CONTAINER_CLOSE.replace_all(&result, "").into_owned();
    }
    js::trim(&BLANK_RUNS.replace_all(&result, "\n\n")).to_owned()
}

fn plain_text_of_html(html: &str) -> String {
    let text = SCRIPTS.replace_all(html, "");
    let text = BREAKS.replace_all(&text, "\n");
    let text = BLOCK_ENDS.replace_all(&text, "\n");
    let text = TAGS.replace_all(&text, "");
    let text = ENTITIES.replace_all(&text, |captures: &regex::Captures<'_>| {
        let whole = captures.get(0).map_or("", |m| m.as_str()).to_owned();
        let name = captures.get(1).map_or("", |m| m.as_str());
        let code = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
            u32::from_str_radix(hex, 16).ok()
        } else if let Some(decimal) = name.strip_prefix('#').filter(|_| name != "#39") {
            decimal.parse().ok()
        } else {
            let known = match name.to_ascii_lowercase().as_str() {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                _ => None,
            };
            return known.map_or(whole, String::from);
        };
        code.and_then(char::from_u32).map_or(whole, String::from)
    });
    let text = SPACE_BEFORE_BREAK.replace_all(&text, "\n");
    let text = BLANK_RUNS.replace_all(&text, "\n\n");
    js::trim(&text).to_owned()
}

/// `modelFacingText`: the reply as a model should read it.
pub fn model_facing_text(text: &str, capture: Option<(&str, bool)>) -> String {
    if !has_provider_directive(text) {
        return text.to_owned();
    }
    if let Some((html, truncated)) = capture
        && !html.is_empty()
        && !truncated
    {
        let plain = plain_text_of_html(html);
        if !ANY_DIRECTIVE.is_match(&plain) && !plain.is_empty() {
            return plain;
        }
    }
    let stripped = without_provider_directives(text);
    if stripped.is_empty() {
        "[This reply points to content from another message that was not recorded.]".to_owned()
    } else {
        stripped
    }
}

/// `foldProgress`: a superseding progress caption keeps its first position.
fn fold_progress(events: Vec<SessionEvent>) -> Vec<SessionEvent> {
    let mut anchor: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Option<SessionEvent>> = events.into_iter().map(Some).collect();
    for index in 0..out.len() {
        let key = match &out[index] {
            Some(SessionEvent::Progress(event)) => event
                .progress_id
                .as_ref()
                .map(|id| format!("progress\0{id}")),
            Some(SessionEvent::ToolCall(event)) => {
                Some(format!("tool_call\0{}", event.call.call_id))
            }
            Some(SessionEvent::PageTool(event)) => Some(format!("page_tool\0{}", event.message_id)),
            _ => None,
        };
        let Some(key) = key else { continue };
        let Some(&at) = anchor.get(&key) else {
            anchor.insert(key, index);
            continue;
        };
        let later = out[index].take();
        if let (Some(SessionEvent::Progress(held)), Some(SessionEvent::Progress(event))) =
            (&mut out[at], &later)
        {
            held.message = event.message.clone();
        } else if let (Some(SessionEvent::PageTool(held)), Some(SessionEvent::PageTool(event))) =
            (&mut out[at], &later)
        {
            held.label = event.label.clone();
        } else if let (Some(SessionEvent::ToolCall(held)), Some(SessionEvent::ToolCall(event))) =
            (&out[at], &later)
            && event.base.seq >= held.base.seq
        {
            let mut replaced = event.clone();
            replaced.origin = Some(held.origin.unwrap_or(held.base.seq));
            replaced.base.time = held.base.time;
            out[at] = Some(SessionEvent::ToolCall(replaced));
        }
    }
    out.into_iter().flatten().collect()
}

fn origin_of(event: &SessionEvent) -> u64 {
    let origin = match event {
        SessionEvent::UserMessage(event) => event.origin,
        SessionEvent::AssistantMessage(event) => event.origin,
        SessionEvent::Progress(event) => event.origin,
        SessionEvent::ToolCall(event) => event.origin,
        SessionEvent::NativeImage(event) => event.origin,
        _ => None,
    };
    origin.unwrap_or(event.base().seq)
}

/// What the projection needs from the outbox: the app's own sends to this session.
#[derive(Clone, Debug, Default)]
pub struct OutboxView {
    /// Inputs a finish owner sent: shown as automatic continuations.
    pub automatic_ids: HashSet<String>,
}

fn user_text(event: &cos_types::session::UserMessageEvent) -> String {
    let authored = event
        .authored_text
        .clone()
        .or_else(|| cos_sessions::user_prompt_text(&event.message.text))
        .unwrap_or_else(|| event.message.text.clone());
    clip(&authored, MAX_USER_MESSAGE_CHARS)
}

/// `conversationMessages(sessionId, deliveredInput)`.
pub async fn conversation_messages(
    store: &SessionStore,
    session: &SessionId,
    delivered: &[String],
    outbox: &OutboxView,
) -> Vec<ChatMessage> {
    let recent_limit = MAX_CONTEXT_MESSAGES * 2;
    let read = |limit: usize, kinds: &'static [&'static str]| async move {
        store
            .recent_events(session, limit, kinds)
            .await
            .unwrap_or_default()
    };
    let recent = read(
        recent_limit,
        &["user_message", "assistant_message", "progress"],
    )
    .await;
    let users = read(MAX_CONTEXT_MESSAGES, &["user_message"]).await;
    let calls = read(MAX_TOOL_CALLS_COUNTED, &["tool_call"]).await;

    let mut calls_by_turn: HashMap<String, usize> = HashMap::new();
    for event in &calls {
        if let SessionEvent::ToolCall(call) = event
            && call.base.source == EventSource::Mcp
            && let Some(turn) = &call.base.turn_id
            && !HOLD_TOOLS.contains(&call.call.tool.as_str())
        {
            *calls_by_turn.entry(turn.clone()).or_default() += 1;
        }
    }
    let mut by_seq: Vec<SessionEvent> = Vec::new();
    let mut seen = HashSet::new();
    for event in recent.iter().chain(users.iter()) {
        if seen.insert(event.base().seq) {
            by_seq.push(event.clone());
        } else if let Some(slot) = by_seq.iter_mut().find(|e| e.base().seq == event.base().seq) {
            *slot = event.clone();
        }
    }
    by_seq.sort_by_key(origin_of);

    let mut ordered: Vec<ChatMessage> = Vec::new();
    let mut by_stable: HashMap<String, usize> = HashMap::new();
    let mut last_answer_of_turn: HashMap<String, usize> = HashMap::new();
    for event in fold_progress(by_seq) {
        let (next, stable, turn) = match &event {
            SessionEvent::UserMessage(user) => {
                let content = user_text(user);
                if content.is_empty() {
                    continue;
                }
                let automatic = user
                    .input_id
                    .as_ref()
                    .is_some_and(|id| outbox.automatic_ids.contains(id));
                let message = if automatic {
                    ChatMessage {
                        role: Role::User,
                        content: format!(
                            "[Automatic continuation; not a new human requirement]\n{content}"
                        ),
                        automatic: true,
                    }
                } else {
                    ChatMessage::user(content)
                };
                (
                    message,
                    user.message_id
                        .clone()
                        .filter(|id| !id.is_empty())
                        .map(|id| format!("user_message\0{id}")),
                    None,
                )
            }
            SessionEvent::AssistantMessage(answer)
                if answer.is_final || answer.message_id.is_some() =>
            {
                let capture = answer
                    .rendered_html
                    .as_ref()
                    .map(|html| (html.text.as_str(), html.truncated));
                let content = clip(
                    &model_facing_text(&answer.message.text, capture),
                    MAX_MESSAGE_CHARS,
                );
                if content.is_empty() {
                    continue;
                }
                (
                    ChatMessage::assistant(content),
                    answer
                        .message_id
                        .clone()
                        .filter(|id| !id.is_empty())
                        .map(|id| format!("assistant_message\0{id}")),
                    answer.base.turn_id.clone(),
                )
            }
            SessionEvent::Progress(progress) if progress.base.source == EventSource::Extension => {
                let content = clip(&progress.message.text, MAX_MESSAGE_CHARS);
                if content.is_empty() {
                    continue;
                }
                (
                    ChatMessage::assistant(content),
                    None,
                    progress.base.turn_id.clone(),
                )
            }
            _ => continue,
        };
        let existing = stable.as_ref().and_then(|key| by_stable.get(key).copied());
        let at = match existing {
            Some(at) => {
                ordered[at] = next;
                at
            }
            None => {
                if let Some(key) = stable {
                    by_stable.insert(key, ordered.len());
                }
                ordered.push(next);
                ordered.len() - 1
            }
        };
        if let Some(turn) = turn
            && calls_by_turn.contains_key(&turn)
        {
            let last = last_answer_of_turn.entry(turn).or_insert(at);
            *last = (*last).max(at);
        }
    }
    for (turn, at) in last_answer_of_turn {
        let count = calls_by_turn.get(&turn).copied().unwrap_or_default();
        let plural = if count == 1 { "" } else { "s" };
        ordered[at].content = format!(
            "{}\n\n[Chat On Steroids: {count} tool call{plural} ran in this turn. Arguments and results are not shown.]",
            ordered[at].content
        );
    }
    let skip = delivered.len().saturating_sub(5);
    for text in &delivered[skip..] {
        let authored = cos_sessions::user_prompt_text(text).unwrap_or_else(|| text.clone());
        let content = clip(&authored, MAX_USER_MESSAGE_CHARS);
        if !content.is_empty() {
            ordered.push(ChatMessage::user(content));
        }
    }
    bound(ordered)
}

/// Keeps the first user request and the newest result inside the message and character budget.
fn bound(ordered: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let first_user = ordered
        .iter()
        .position(|message| message.role == Role::User && !message.automatic);
    let total: usize = ordered
        .iter()
        .map(|message| js::len(&message.content))
        .sum();
    if first_user.is_some() && ordered.len() <= MAX_CONTEXT_MESSAGES && total <= MAX_CONTEXT_CHARS {
        return ordered;
    }
    let anchors: Vec<usize> = first_user.into_iter().collect();
    let mut chars: usize = anchors
        .iter()
        .map(|&at| js::len(&ordered[at].content))
        .sum();
    let tail_slots = MAX_CONTEXT_MESSAGES.saturating_sub(anchors.len());
    let newest_result = ordered
        .iter()
        .rposition(|message| message.role == Role::Assistant);
    let last = ordered.len().saturating_sub(1);
    let rank = |at: usize| -> u8 {
        if Some(at) == newest_result {
            0
        } else if at == last {
            1
        } else if ordered[at].role == Role::User && !ordered[at].automatic {
            2
        } else {
            3
        }
    };
    let mut priorities: Vec<usize> = (0..ordered.len()).rev().collect();
    priorities.sort_by_key(|&at| rank(at));
    let mut selected: Vec<usize> = Vec::new();
    for at in priorities {
        if selected.len() >= tail_slots {
            break;
        }
        if anchors.contains(&at) {
            continue;
        }
        let size = js::len(&ordered[at].content);
        if chars + size > MAX_CONTEXT_CHARS {
            continue;
        }
        chars += size;
        selected.push(at);
    }
    let mut keep: Vec<usize> = anchors.into_iter().chain(selected).collect();
    keep.sort_unstable();
    keep.into_iter().map(|at| ordered[at].clone()).collect()
}
