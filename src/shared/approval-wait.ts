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

export const APPROVAL_TEXTS = [APPROVAL_WAITING_TEXT, APPROVAL_ANSWERED_TEXT] as const;
