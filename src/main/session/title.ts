import type { SessionEvent, SessionSummary } from '../../shared/session.js';
import { userPromptText } from '../../shared/user-prompt.js';

const contextPrefix = /^\s*(?:\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\s*)?\[\[COS_CONTEXT:\d{1,6}\]\]/;

/** Presentation only: never reinterpret a damaged frame as delivery/receipt evidence. */
export function userTitle(text: string, authoredText?: string): string {
  const authored = authoredText ?? userPromptText(text);
  if (authored === null && contextPrefix.test(text)) return '';
  return (authored ?? text).trim().slice(0, 80).trim();
}

export function legacyContextTitle(summary: SessionSummary): boolean {
  return !summary.titleSource && contextPrefix.test(summary.title) && (!summary.origin || summary.origin.kind === 'desktop');
}

export function firstTitleMessage(events: Iterable<SessionEvent>): Extract<SessionEvent, { kind: 'user_message' }> | undefined {
  let first: Extract<SessionEvent, { kind: 'user_message' }> | undefined;
  for (const event of events) if (event.kind === 'user_message' &&
      (!first || (event.origin ?? event.seq) < (first.origin ?? first.seq))) first = event;
  return first;
}

/** Old builds used both 80 and 120 characters, before or after trimming. */
export function automaticTitle(summary: SessionSummary, first?: Extract<SessionEvent, { kind: 'user_message' }>): boolean {
  if (summary.origin && summary.origin.kind !== 'desktop') return false;
  if (summary.titleSource) return summary.titleSource !== 'manual';
  if (summary.title === 'ChatGPT session' || legacyContextTitle(summary)) return true;
  if (summary.origin?.kind === 'desktop' && summary.title === 'New chat') return true;
  if (!first) return false;
  return [first.authoredText, userPromptText(first.message.text), first.message.text].some(text =>
    text != null && [80, 120].some(length => [text.slice(0, length).trim(), text.trim().slice(0, length), text.trim().slice(0, length).trim()].includes(summary.title)));
}

/**
 * ChatGPT names a chat from its first message. In a chat this app opened, that message is the
 * CoS instructions around the user's request, so every such chat was called some variant of
 * "Coding Agent Instructions". There the user's own request names the chat instead.
 */
export function providerTitleIgnored(summary: SessionSummary): boolean {
  return summary.origin?.kind === 'desktop';
}

/** "ChatGPT - <project>" is the project page's title, never the chat's (the extension skips it too). */
export function projectPageTitle(title: string): boolean {
  return /^ChatGPT\s*[-|·–]\s*\S/i.test(title.trim());
}

/**
 * 2.1.14 and 2.1.15 recorded Plan's temporary helper chat as an ordinary session, named after the
 * planner instructions ChatGPT echoed as its title. Such a session holds no message of the user.
 */
const PLANNER_TITLE = 'You are a task planner, not the executor';

/** A stored label an older build left that `refreshUserTitle` repairs; the list must not serve it as is. */
export function legacyLabelPending(summary: SessionSummary): boolean {
  if (!summary.origin && summary.title.startsWith(PLANNER_TITLE)) return true;
  return projectPageTitle(summary.title) && summary.titleSource !== 'manual' && (!summary.origin || summary.origin.kind === 'desktop');
}

/** Rebuild only a preview. Provider/manual/origin titles keep their authority. */
export function refreshUserTitle(summary: SessionSummary, events: Iterable<SessionEvent>): boolean {
  const first = firstTitleMessage(events);
  // A leftover Plan helper is hidden like every other helper chat, never deleted. Its only
  // "user" message is the planner instructions themselves; its title is often the same text.
  const planner = first ? first.message.text.trimStart().startsWith(PLANNER_TITLE) : summary.title.startsWith(PLANNER_TITLE);
  if (!summary.origin && planner) {
    summary.origin = { kind: 'helper', fromSessionId: null, agentId: null, task: '' };
    return true;
  }
  // A project page title with no request to name the chat by: the project's name is still more
  // honest than "ChatGPT - <project>", which is the page, not the chat.
  if (!first && projectPageTitle(summary.title) && summary.titleSource !== 'manual' && (!summary.origin || summary.origin.kind === 'desktop')) {
    const project = summary.title.trim().replace(/^ChatGPT\s*[-|·–]\s*/i, '').slice(0, 80).trim();
    if (!project) return false;
    summary.title = project;
    summary.titleSource = 'fallback';
    return true;
  }
  if (!first && !legacyContextTitle(summary)) return false;
  // A stored provider title yields to the request only when it was never really the chat's name.
  const projectPage = projectPageTitle(summary.title);
  const replaceable = providerTitleIgnored(summary) || projectPage;
  // A project page title never was the chat's name, whatever build stored it; only a title the
  // user typed is kept.
  if ((summary.titleSource === 'provider' && !replaceable) || (!automaticTitle(summary, first) && !(projectPage && summary.titleSource !== 'manual'))) return false;
  const authored = first ? userTitle(first.message.text, first.authoredText) : '';
  // Without a readable request, a provider title is still better than a placeholder.
  if (!authored && summary.titleSource === 'provider') return false;
  const title = authored || 'ChatGPT session';
  const changed = summary.title !== title || summary.titleSource !== 'fallback';
  summary.title = title;
  summary.titleSource = 'fallback';
  return changed;
}
