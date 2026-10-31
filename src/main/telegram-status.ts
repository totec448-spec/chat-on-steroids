/**
 * The bot's answer to `/status` (#1934): what the person's chats are doing, short enough for a
 * phone. Without "Include chat names and answers" it gives counts only, as the notifications say
 * no names then; with it, one line per chat (at most eight, then how many more).
 */

export interface StatusChat {
  title: string;
  /** An approval card waits for the person. */
  approval: boolean;
  /** The chat's turn is running. */
  working: boolean;
  /** Goal or Loop drives it. */
  automation: 'Goal' | 'Loop' | null;
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
