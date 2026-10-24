//! The handoff brief: what chat A is asked to write, how it is bounded and stored, and how chat
//! B's opening message carries it (`session/handoff.ts`, `session/handoff-prompt.ts`,
//! `shared/handoff.ts`).

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cos_sessions::SessionStore;
use cos_store::Logger;
use cos_types::config::HandoffLength;
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{AgentPlan, Handoff, HandoffProvenance, HandoffVersion};
use regex::Regex;
use sha2::{Digest, Sha256};

use crate::js;

/// `MAX_CHATGPT_MESSAGE_CHARS`: the most one composer message carries.
pub const MAX_CHATGPT_MESSAGE_CHARS: usize = cos_input::MAX_CHATGPT_MESSAGE_CHARS;

/// The shortest a brief may be for any session at all.
const MIN_BRIEF_CHARS: usize = 200;
/// Above this much recorded context a session's brief has real work to describe.
const SUBSTANTIAL_SESSION_TOKENS: u64 = 20_000;
const MIN_SUBSTANTIAL_BRIEF_CHARS: usize = 1_000;

/// `DEFAULT_HANDOFF_PROMPT`: the shipped, user-editable content instructions.
pub const DEFAULT_HANDOFF_PROMPT: &str = include_str!("default-handoff-prompt.txt");

const DEFAULT_NAVIGABLE: &str = "so a 10k–30k-token brief remains navigable";

/// `[[CLF-HANDOFF:<token>]]`, the marker chat A's compaction prompt opens with.
pub fn source_marker(token: &str) -> String {
    marker("HANDOFF", token)
}

/// `[[CLF-RESUME:<token>]]`, the marker chat B's opening message carries.
pub fn destination_marker(token: &str) -> String {
    marker("RESUME", token)
}

fn marker(kind: &str, token: &str) -> String {
    if token.is_empty() {
        String::new()
    } else {
        format!("[[CLF-{kind}:{token}]]")
    }
}

/// `handoffPromptForLength`: the content instructions with the chosen length applied.
pub fn handoff_prompt_for_length(prompt: &str, length: HandoffLength) -> String {
    let (range, max) = match length {
        HandoffLength::Thorough => return prompt.to_owned(),
        HandoffLength::Standard => ("4,000–10,000", "10,000"),
        HandoffLength::Short => ("2,000–6,000", "6,000"),
    };
    let rule = format!(
        "- Treat the brief as a dense operational compression, not an executive summary. For a substantial session, target roughly {range} tokens: keep every user requirement and correction, the current state, failures and the next actions, and cut narration and repetition first. Go shorter when there is less useful state. Never exceed {max} tokens."
    );
    let default_rule = DEFAULT_HANDOFF_PROMPT
        .lines()
        .find(|line| line.starts_with("- Treat the brief as a lossless operational compression"))
        .unwrap_or_default();
    let adapted = prompt.replacen(default_rule, &rule, 1).replacen(
        DEFAULT_NAVIGABLE,
        "so the brief remains navigable",
        1,
    );
    format!(
        "{adapted}\n\nLength setting: aim for roughly {range} tokens and never exceed {max}. This replaces any other length target in these instructions."
    )
}

/// `nativeHandoffPrompt`: the instruction typed into chat A. Its answer is the brief.
pub fn native_handoff_prompt(
    token: &str,
    include_tool_calls: bool,
    handoff_prompt: &str,
    length: HandoffLength,
) -> String {
    let identity = source_marker(token);
    let content = if js::trim(handoff_prompt).is_empty() {
        DEFAULT_HANDOFF_PROMPT
    } else {
        js::trim(handoff_prompt)
    };
    let instructions = handoff_prompt_for_length(content, length);
    let mut out = String::new();
    if !identity.is_empty() {
        out.push_str(&identity);
        out.push_str("\n\n");
    }
    out.push_str("Chat On Steroids is compacting this conversation so a fresh chat can continue the work. Stop whatever you were doing and do only this.\n\n");
    out.push_str("Write a handoff brief so a different coding agent can continue this unfinished task in a brand-new conversation, with no memory of anything here. Everything you know about this session — the user's ");
    out.push_str(if include_tool_calls {
        "messages, your own replies, and every tool call you made against this machine with its result — is the "
    } else {
        "messages and your own replies, including interim updates — is the "
    });
    out.push_str(
        "material. Write it so an agent who reads only your brief can carry on correctly.\n\n",
    );
    out.push_str(&instructions);
    out.push_str("\n\n");
    if !include_tool_calls {
        out.push_str("Tool-detail setting: preserve verified outcomes and distinguish them from claims, but omit raw tool-call arguments and result bodies from the brief. Do not copy tool transcripts. This setting controls the brief, not the history you already saw.\n\n");
    }
    out.push_str("Your reply to this message must be the brief itself and nothing else: no preamble, no closing remark, no question back, and no tool calls. The app reads this reply, stores it, and opens the fresh chat with it.");
    out
}

/// `handoffContinuationId`: a public fingerprint of the token, never the token itself.
pub fn continuation_id(token: &str) -> Option<String> {
    crate::continuation::token_shaped(token)
        .then(|| URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes())))
}

/// `handoffMatchesContinuation`: a versioned handoff proves which transaction wrote it; a legacy
/// one carries no proof and stays readable.
pub fn matches_continuation(
    handoff: &Handoff,
    token: &str,
    source_conversation: &str,
    source_turn: Option<&str>,
) -> bool {
    if handoff.version.is_none() && handoff.provenance.is_none() {
        return true;
    }
    let (Some(_), Some(provenance)) = (handoff.version, &handoff.provenance) else {
        return false;
    };
    continuation_id(token).is_some_and(|id| provenance.continuation_id.as_deref() == Some(&id))
        && provenance.source_conversation_id.as_deref() == Some(source_conversation)
        && provenance.source_turn_id.as_deref() == source_turn
}

/// `resumeBootstrapText`: the ordinary user message typed into chat B.
pub fn resume_bootstrap_text(summary: &str, token: &str) -> String {
    let identity = destination_marker(token);
    let mut out = String::new();
    if !identity.is_empty() {
        out.push_str(&identity);
        out.push_str("\n\n");
    }
    out.push_str("Continuing a Chat On Steroids session that was compacted. This is the brief the previous chat wrote about its own work; carry on from it rather than starting again.\n\n");
    out.push_str(summary);
    out
}

/// `boundBrief`: keeps the head (TASK) and the tail (NEXT, DO NOT) when a brief is longer than
/// the replacement message can carry.
fn bound_brief(text: &str, max: usize) -> String {
    if js::len(text) <= max {
        return text.to_owned();
    }
    let marker = "\n\n[… the middle of this brief was longer than the app carries across and was left out …]\n\n";
    let room = max.saturating_sub(js::len(marker));
    let head_room = room * 4 / 10;
    let head = js::slice(text, 0, head_room);
    let total = js::len(text);
    let tail = js::slice(text, total - (room - head_room), total);
    let head_break = js::last_index_of(&head, '\n');
    let tail_break = js::index_of(&tail, '\n');
    let head = match head_break {
        Some(at) if (at as isize) > head_room as isize - 400 => js::slice(&head, 0, at),
        _ => head,
    };
    let tail = match tail_break {
        Some(at) if at < 400 => js::slice(&tail, at + 1, js::len(&tail)),
        _ => tail,
    };
    format!("{head}{marker}{tail}")
}

/// `briefShortfall`: why this text cannot be the brief for a session of this size.
pub fn brief_shortfall(text: &str, source_tokens: u64) -> Option<String> {
    let brief = js::trim(text);
    let chars = js::len(brief);
    if brief.is_empty() {
        return Some("ChatGPT answered the compaction request with nothing.".into());
    }
    if chars < MIN_BRIEF_CHARS {
        return Some(format!(
            "ChatGPT wrote only {chars} characters before its compaction turn looked finished, which is too little to continue any session from."
        ));
    }
    if source_tokens >= SUBSTANTIAL_SESSION_TOKENS && chars < MIN_SUBSTANTIAL_BRIEF_CHARS {
        return Some(format!(
            "The brief is {chars} characters for a session carrying about {}k tokens of work, so it cannot be the whole handoff.",
            js::round_half_up(source_tokens as f64 / 1000.0)
        ));
    }
    None
}

/// `handoffPlanNotice`: the saved plan frozen with the brief.
fn plan_notice(plan: Option<&AgentPlan>) -> String {
    let Some(plan) = plan.filter(|plan| !plan.plan.is_empty()) else {
        return String::new();
    };
    let steps: Vec<String> = plan
        .plan
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let details = step
                .details
                .as_ref()
                .map(|details| format!("\n{details}"))
                .unwrap_or_default();
            format!(
                "{}. [{}] {}{details}",
                index + 1,
                step.status.as_str(),
                step.step
            )
        })
        .collect();
    let explanation = plan
        .explanation
        .as_ref()
        .filter(|text| !text.is_empty())
        .map(|text| format!("{text}\n"))
        .unwrap_or_default();
    format!(
        "{PLAN_NOTICE_HEAD}{explanation}{}\nContinue the unfinished work using this plan and the brief. Report progress with update_plan.",
        steps.join("\n")
    )
}

/// The plan notice's head; a reused brief gets the current notice instead of the old one.
pub(crate) const PLAN_NOTICE_HEAD: &str =
    "\n\nSaved task plan at handoff (reported progress, not verification evidence):\n";

/// `newHandoffId`: the day and eight hex digits of a random UUID. Never taken from a model.
fn new_handoff_id(now: u64) -> String {
    format!("{}-{}", js::iso_day(now), crate::random_hex::<4>())
}

/// What [`prepare`] needs besides the store.
pub struct PrepareHandoff<'a> {
    pub session: &'a SessionId,
    pub text: &'a str,
    pub continuation_token: &'a str,
    pub source_conversation: Option<&'a str>,
    pub source_turn: Option<&'a str>,
    pub now: u64,
}

/// `prepareHandoff`: bounds the brief with its saved plan, refuses a stub, and writes
/// `handoffs/<id>.json` without publishing it into the timeline.
pub async fn prepare(
    sessions: &SessionStore,
    logger: &Logger,
    input: PrepareHandoff<'_>,
) -> Result<Handoff, String> {
    let text = js::trim(input.text);
    if text.is_empty() {
        return Err("A handoff cannot be empty".into());
    }
    let summary = sessions
        .summary(input.session)
        .await
        .ok_or_else(|| "That session no longer exists".to_owned())?;
    let notice = plan_notice(sessions.read_session_plan(input.session).await.as_ref());
    let overhead = js::len(&resume_bootstrap_text("", input.continuation_token)) + js::len(&notice);
    let text = bound_brief(text, MAX_CHATGPT_MESSAGE_CHARS.saturating_sub(overhead));
    if let Some(shortfall) = brief_shortfall(&text, summary.estimated_tokens) {
        return Err(shortfall);
    }
    let generation = input.source_conversation.and_then(|chat| {
        summary
            .chat_ids
            .iter()
            .position(|known| known == chat)
            .map(|index| index as u64 + 1)
    });
    let handoff = Handoff {
        version: Some(HandoffVersion),
        id: new_handoff_id(input.now),
        session_id: input.session.clone(),
        created_at: input.now,
        text: format!("{text}{notice}"),
        source_events: summary.events,
        source_tokens: summary.estimated_tokens,
        notes: Vec::new(),
        provenance: Some(HandoffProvenance {
            source_conversation_id: input.source_conversation.map(str::to_owned),
            source_generation: generation,
            source_turn_id: input.source_turn.map(str::to_owned),
            continuation_id: continuation_id(input.continuation_token),
            extra: Extra::new(),
        }),
        extra: Extra::new(),
    };
    sessions
        .save_handoff(&handoff)
        .await
        .map_err(|error| error.to_string())?;
    logger.info(&format!(
        "handoff {} prepared ({} characters)",
        handoff.id,
        js::len(&handoff.text)
    ));
    Ok(handoff)
}

static CONTINUATION_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*\[\[CLF-(HANDOFF|RESUME):([A-Za-z0-9_-]{16,64})\]\](?:\s|$)")
        .unwrap_or_else(|_| unreachable!("a literal pattern"))
});
static CONTINUATION_MARKER_ESCAPED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:\\?\[){2}CLF\\?-(HANDOFF|RESUME)\\?:((?:[A-Za-z0-9]|\\?[_-]){16,64})(?:\\?\]){2}\\?(?:\s|$)")
        .unwrap_or_else(|_| unreachable!("a literal pattern"))
});
static ESCAPED_PUNCTUATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\([!-/:-@\[-`{-~])").unwrap_or_else(|_| unreachable!("a literal pattern"))
});
static INDENT_ENTITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|\n)&#x20;").unwrap_or_else(|_| unreachable!("a literal pattern"))
});

/// A continuation marker at the head of a message (`continuationMarkerOf`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Marker {
    pub kind: MarkerKind,
    pub token: String,
    /// The matched text, as typed.
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerKind {
    Handoff,
    Resume,
}

/// `continuationMarkerOf`: the marker at the head of `text`, as typed or as the composer
/// escaped it.
pub fn marker_of(text: &str) -> Option<Marker> {
    let head = js::slice(text, 0, 200);
    let captures = CONTINUATION_MARKER
        .captures(text)
        .or_else(|| CONTINUATION_MARKER_ESCAPED.captures(&head))?;
    let kind = match captures.get(1)?.as_str() {
        "HANDOFF" => MarkerKind::Handoff,
        _ => MarkerKind::Resume,
    };
    Some(Marker {
        kind,
        token: captures.get(2)?.as_str().replace('\\', ""),
        text: captures.get(0)?.as_str().to_owned(),
    })
}

/// `unescapeMarkdown`: one layer of the composer's readback escaping.
fn unescape_markdown(value: &str) -> String {
    let value = value.replace("\\\r\n", "\n").replace("\\\n", "\n");
    let value = ESCAPED_PUNCTUATION.replace_all(&value, "$1");
    INDENT_ENTITY.replace_all(&value, "${1} ").into_owned()
}

/// `resumeBootstrapMatches`: whether a recorded user row is the exact bootstrap for this brief,
/// allowing only the known space artifacts and the composer's escaping.
pub fn resume_bootstrap_matches(recorded: &str, summary: &str) -> bool {
    let canonical = |value: &str| {
        value
            .replace("\u{c2}\u{a0}", " ")
            .replace('\u{a0}', " ")
            .replace("\r\n", "\n")
            .replace('\r', "\n")
    };
    let strip = |value: &str| -> String {
        let prompt = cos_sessions::user_prompt_text(value).unwrap_or_else(|| value.to_owned());
        let Some(marker) = marker_of(&prompt) else {
            return prompt;
        };
        let end = marker.text.trim_end().len();
        if marker.kind == MarkerKind::Resume
            && js::trim_start(&prompt).len() == prompt.len()
            && prompt.get(end..end + 2) == Some("\n\n")
        {
            prompt[end + 2..].to_owned()
        } else {
            prompt
        }
    };
    let expected = canonical(&resume_bootstrap_text(summary, ""));
    let normalized = canonical(recorded);
    strip(&normalized) == expected || strip(&unescape_markdown(&normalized)) == expected
}
