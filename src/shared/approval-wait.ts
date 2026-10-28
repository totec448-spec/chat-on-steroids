/**
 * The timeline row for a chat whose ChatGPT page waits on ChatGPT's own tool approval card.
 *
 * The main process writes the row in English; the renderer recognizes exactly these texts and
 * shows them in the interface language, with a button that opens the chat's page while it waits.
 */
export const APPROVAL_PROGRESS_PREFIX = 'approval-wait:';

export const APPROVAL_WAITING_TEXT =
  'ChatGPT is waiting for you to allow or deny a tool call in this chat. Nothing continues until you answer it there.';

export const APPROVAL_ANSWERED_TEXT = 'The tool approval ChatGPT asked for in this chat was answered.';

/** A past repair decision; the approval row alone owns the current waiting state. */
export const APPROVAL_REPAIR_DEFERRED_TEXT = 'Reload was deferred because ChatGPT showed a tool approval card.';

export const APPROVAL_TEXTS = [APPROVAL_WAITING_TEXT, APPROVAL_ANSWERED_TEXT] as const;

/** ChatGPT's approval card as the app shows it, with the last answer the person gave there. */
export interface ApprovalCardView {
  id: string;
  lines: string[];
  allow: boolean;
  answer: { choice: 'allow' | 'deny'; outcome: 'clicked' | 'card_changed' | 'unavailable' | 'expired' | null } | null;
}
