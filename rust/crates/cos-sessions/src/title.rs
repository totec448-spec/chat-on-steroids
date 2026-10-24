//! Session titles (`src/main/session/title.ts` and `renameSession` in `store.ts`): the
//! preview built from the first authored request, and the automatic titles a page reports.

use cos_types::ids::SessionId;
use cos_types::json::{Extra, Record};
use cos_types::session::{
    AutoTitle, AutoTitleSource, SessionEvent, SessionOriginKind, SessionSummary, TitleSource,
    UserMessageEvent,
};

use crate::{SessionStore, js, redact};

pub(crate) const DEFAULT_TITLE: &str = "ChatGPT session";
pub(crate) const PLANNER_TITLE: &str = "You are a task planner, not the executor";

fn origin_kind(summary: &SessionSummary) -> Option<SessionOriginKind> {
    summary.origin.as_ref().map(|origin| origin.kind)
}

/// `userTitle`: the authored request, trimmed to 80 UTF-16 units.
pub(crate) fn user_title(text: &str, authored_text: Option<&str>) -> String {
    let authored = authored_text
        .map(str::to_owned)
        .or_else(|| redact::user_prompt_text(text));
    if authored.is_none() && context_prefix(text) {
        return String::new();
    }
    let source = authored.as_deref().unwrap_or(text);
    js::prefix(source.trim(), 80).trim().to_owned()
}

/// `/^\s*(?:\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\s*)?\[\[COS_CONTEXT:\d{1,6}\]\]/`.
fn context_prefix(text: &str) -> bool {
    let mut rest = text.trim_start();
    for marker in ["[[CLF-HANDOFF:", "[[CLF-RESUME:"] {
        if let Some(after) = rest.strip_prefix(marker)
            && let Some(end) = after.find("]]")
        {
            let token = &after[..end];
            if (16..=64).contains(&token.len())
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                rest = after[end + 2..].trim_start();
            }
            break;
        }
    }
    let Some(after) = rest.strip_prefix("[[COS_CONTEXT:") else {
        return false;
    };
    let digits = after.bytes().take_while(u8::is_ascii_digit).count();
    (1..=6).contains(&digits) && after[digits..].starts_with("]]")
}

fn legacy_context_title(summary: &SessionSummary) -> bool {
    summary.title_source.is_none()
        && context_prefix(&summary.title)
        && origin_kind(summary).is_none_or(|kind| kind == SessionOriginKind::Desktop)
}

/// `projectPageTitle`: "ChatGPT - <project>" is the project page, never the chat.
fn project_page_title(title: &str) -> bool {
    let trimmed = title.trim();
    let Some(head) = trimmed.get(..7) else {
        return false;
    };
    if !head.eq_ignore_ascii_case("chatgpt") {
        return false;
    }
    let rest = trimmed[7..].trim_start();
    let mut chars = rest.chars();
    matches!(chars.next(), Some('-' | '|' | '\u{b7}' | '\u{2013}'))
        && chars.as_str().trim_start().chars().next().is_some()
}

fn provider_title_ignored(summary: &SessionSummary) -> bool {
    origin_kind(summary) == Some(SessionOriginKind::Desktop)
}

fn first_title_message<'a>(
    events: impl Iterator<Item = &'a SessionEvent>,
) -> Option<&'a UserMessageEvent> {
    let mut first: Option<&UserMessageEvent> = None;
    for event in events {
        if let SessionEvent::UserMessage(message) = event {
            let position = message.origin.unwrap_or(message.base.seq);
            if first.is_none_or(|held| position < held.origin.unwrap_or(held.base.seq)) {
                first = Some(message);
            }
        }
    }
    first
}

/// JavaScript `text.slice(0, n)` and its trims, as `automaticTitle` compares them.
fn automatic_title(summary: &SessionSummary, first: Option<&UserMessageEvent>) -> bool {
    if origin_kind(summary).is_some_and(|kind| kind != SessionOriginKind::Desktop) {
        return false;
    }
    if let Some(source) = summary.title_source {
        return source != TitleSource::Manual;
    }
    if summary.title == DEFAULT_TITLE || legacy_context_title(summary) {
        return true;
    }
    if origin_kind(summary) == Some(SessionOriginKind::Desktop) && summary.title == "New chat" {
        return true;
    }
    let Some(first) = first else {
        return false;
    };
    let candidates = [
        first.authored_text.clone(),
        redact::user_prompt_text(&first.message.text),
        Some(first.message.text.clone()),
    ];
    candidates.into_iter().flatten().any(|text| {
        [80, 120].iter().any(|&length| {
            [
                js::prefix(&text, length).trim().to_owned(),
                js::prefix(text.trim(), length).to_owned(),
                js::prefix(text.trim(), length).trim().to_owned(),
            ]
            .contains(&summary.title)
        })
    })
}

/// `refreshUserTitle`: rebuilds only a preview; provider, manual and origin titles keep theirs.
pub(crate) fn refresh_user_title(
    summary: &mut SessionSummary,
    messages: &Record<SessionEvent>,
) -> bool {
    let first = first_title_message(messages.values());
    let planner = match first {
        Some(first) => first.message.text.trim_start().starts_with(PLANNER_TITLE),
        None => summary.title.starts_with(PLANNER_TITLE),
    };
    if summary.origin.is_none() && planner {
        summary.origin = Some(cos_types::session::SessionOrigin {
            kind: SessionOriginKind::Helper,
            from_session_id: None,
            agent_id: None,
            task: String::new(),
            extra: Extra::new(),
        });
        return true;
    }
    let free = origin_kind(summary).is_none_or(|kind| kind == SessionOriginKind::Desktop);
    if first.is_none()
        && project_page_title(&summary.title)
        && summary.title_source != Some(TitleSource::Manual)
        && free
    {
        let trimmed = summary.title.trim();
        let rest = trimmed[7..].trim_start();
        let rest = rest
            .char_indices()
            .nth(1)
            .map_or("", |(index, _)| &rest[index..]);
        let project = js::prefix(rest.trim_start(), 80).trim().to_owned();
        if project.is_empty() {
            return false;
        }
        summary.title = project;
        summary.title_source = Some(TitleSource::Fallback);
        return true;
    }
    if first.is_none() && !legacy_context_title(summary) {
        return false;
    }
    let project_page = project_page_title(&summary.title);
    let replaceable = provider_title_ignored(summary) || project_page;
    if (summary.title_source == Some(TitleSource::Provider) && !replaceable)
        || (!automatic_title(summary, first)
            && !(project_page && summary.title_source != Some(TitleSource::Manual)))
    {
        return false;
    }
    let authored = first
        .map(|first| user_title(&first.message.text, first.authored_text.as_deref()))
        .unwrap_or_default();
    if authored.is_empty() && summary.title_source == Some(TitleSource::Provider) {
        return false;
    }
    let title = if authored.is_empty() {
        DEFAULT_TITLE.to_owned()
    } else {
        authored
    };
    let changed = summary.title != title || summary.title_source != Some(TitleSource::Fallback);
    summary.title = title;
    summary.title_source = Some(TitleSource::Fallback);
    changed
}

impl SessionStore {
    /// `renameSession` for an automatic title (`provider` or `fallback`); a manual name stays and
    /// the newer automatic title is kept for when the name is cleared.
    pub async fn rename_automatic(
        &self,
        id: &SessionId,
        title: &str,
        source: AutoTitleSource,
        conversation: Option<&str>,
    ) -> Result<(), String> {
        let live = self.ensure_open(id).await?;
        let mut writer = live.writer.lock().await;
        self.ensure_messages(id, &mut writer).await?;
        let next_title = js::prefix(title, 120).to_owned();
        let summary_state = &writer.summary;
        let attached = conversation.is_none_or(|conversation| {
            summary_state.conversation_id.as_deref() == Some(conversation)
        });
        if summary_state.title_source == Some(TitleSource::Manual) {
            if conversation.is_some() && !attached {
                return Ok(());
            }
            if origin_kind(summary_state).is_some_and(|kind| kind != SessionOriginKind::Desktop) {
                return Ok(());
            }
            let auto = summary_state.auto_title.as_ref();
            if source == AutoTitleSource::Fallback
                && auto.is_some_and(|auto| auto.source == AutoTitleSource::Provider)
            {
                return Ok(());
            }
            if source == AutoTitleSource::Provider
                && (provider_title_ignored(summary_state) || project_page_title(title))
            {
                return Ok(());
            }
            if auto.is_some_and(|auto| auto.title == next_title && auto.source == source) {
                return Ok(());
            }
            writer.summary.auto_title = Some(AutoTitle {
                title: next_title,
                source,
                extra: Extra::new(),
            });
            self.commit_summary(id, &live, &mut writer).await;
            return Ok(());
        }
        if !attached {
            return Ok(());
        }
        let first = writer
            .messages
            .as_ref()
            .and_then(|messages| first_title_message(messages.values()));
        if !automatic_title(summary_state, first) {
            return Ok(());
        }
        if source == AutoTitleSource::Fallback
            && summary_state.title_source == Some(TitleSource::Provider)
        {
            return Ok(());
        }
        if source == AutoTitleSource::Provider
            && (provider_title_ignored(summary_state) || project_page_title(title))
        {
            return Ok(());
        }
        let title_source = match source {
            AutoTitleSource::Fallback => TitleSource::Fallback,
            AutoTitleSource::Provider => TitleSource::Provider,
        };
        if summary_state.title == next_title && summary_state.title_source == Some(title_source) {
            return Ok(());
        }
        writer.summary.title = next_title;
        writer.summary.title_source = Some(title_source);
        self.commit_summary(id, &live, &mut writer).await;
        Ok(())
    }
}
