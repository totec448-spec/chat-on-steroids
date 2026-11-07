/**
 * The bot's answer to `/status` (#1934): what the person's chats are doing, short enough for a
 * phone. Without "Include chat names and answers" it gives counts only, as the notifications say
 * no names then; with it, one line per chat (at most eight, then how many more).
 */

import type { SessionSummary } from '../shared/session.js';
import { sessionWorkingAt } from '../shared/session-activity.js';

export interface StatusChat {
  title: string;
  /** An approval card waits for the person. */
  approval: boolean;
  /** The chat's turn is running. */
  working: boolean;
  /** Goal or Loop drives it. */
  automation: 'Goal' | 'Loop' | null;
  /** The person's own chat. A worker's is shown in `/status` but is never a target of a command (CodeRabbit on #1990). */
  own?: boolean;
  /** The chat holds a turn the app no longer counts as working; `/stop` can still end it. */
  held?: boolean;
}

export type StatusText =
  | 'Nothing is running and nothing waits for you.'
  | 'Working: {0}'
  | 'Waiting for your approval: {0}'
  | 'waits for your approval'
  | 'working'
  | '{0} more';

const SHOWN = 8;

export function telegramStatus(chats: readonly StatusChat[], details: boolean, text: (source: StatusText, values?: readonly (string | number)[]) => string): string {
  const relevant = chats.filter(chat => chat.working || chat.approval);
  if (!relevant.length) return text('Nothing is running and nothing waits for you.');
  const waiting = relevant.filter(chat => chat.approval).length;
  const working = relevant.filter(chat => chat.working && !chat.approval).length;
  const lines = [
    ...(waiting ? [text('Waiting for your approval: {0}', [waiting])] : []),
    ...(working ? [text('Working: {0}', [working])] : [])
  ];
  if (!details) return lines.join('\n');
  // The ones that wait for the person first: they are why someone asks.
  const ordered = [...relevant].sort((a, b) => Number(b.approval) - Number(a.approval));
  const rows = ordered.slice(0, SHOWN).map(chat => {
    const state = chat.approval ? text('waits for your approval') : text('working');
    const title = chat.title.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Chat';
    return `• ${title} — ${state}${chat.automation ? ` · ${chat.automation}` : ''}`;
  });
  if (ordered.length > SHOWN) rows.push(text('{0} more', [ordered.length - SHOWN]));
  return [...lines, '', ...rows].join('\n');
}

/** What `/status` needs from the app about each chat, without the bot importing the app's state. */
export interface StatusLookups {
  goal(conversationId: string): { enabled: boolean; mode: string } | null;
  card(conversationId: string): { answer?: unknown } | null;
  activityExpiresAt(summary: SessionSummary): number | null | undefined;
  /** The chat holds a turn although the app no longer counts it as working. */
  held?(summary: SessionSummary): boolean;
}

/**
 * The chats as `/status` sees them. A chat works when the app's own sidebar shows it working, never
 * because its stored record still names an open turn: that is history, and a sub-agent's from five
 * days earlier made `/status` say "Working: 6" while nothing ran (live test, 2026-11-07).
 */
export function statusChatsFrom(list: readonly SessionSummary[], lookups: StatusLookups, now: number): Array<StatusChat & { sessionId: string }> {
  return list.filter(chat => chat.origin?.kind !== 'helper').map(chat => {
    const goal = chat.conversationId ? lookups.goal(chat.conversationId) : null;
    const card = chat.conversationId ? lookups.card(chat.conversationId) : null;
    return { sessionId: chat.id, title: chat.title, working: sessionWorkingAt({ ...chat, activityExpiresAt: lookups.activityExpiresAt(chat) }, now),
      approval: !!card && !card.answer, own: chat.origin?.kind !== 'worker', held: lookups.held?.(chat) === true,
      automation: goal?.enabled ? (goal.mode === 'loop' ? 'Loop' as const : 'Goal' as const) : null };
  });
}
