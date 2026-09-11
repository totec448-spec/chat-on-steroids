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
  if (!first) return false;
  return [first.authoredText, userPromptText(first.message.text), first.message.text].some(text =>
    text != null && [80, 120].some(length => [text.slice(0, length).trim(), text.trim().slice(0, length), text.trim().slice(0, length).trim()].includes(summary.title)));
}

/** Rebuild only a preview. Provider/manual/origin titles keep their authority. */
export function refreshUserTitle(summary: SessionSummary, events: Iterable<SessionEvent>): boolean {
  const first = firstTitleMessage(events);
  if (!first && !legacyContextTitle(summary)) return false;
  if (summary.titleSource === 'provider' || !automaticTitle(summary, first)) return false;
  const title = first ? userTitle(first.message.text, first.authoredText) || 'ChatGPT session' : 'ChatGPT session';
  const changed = summary.title !== title || summary.titleSource !== 'fallback';
  summary.title = title;
  summary.titleSource = 'fallback';
  return changed;
}
