/** Equality only: retain the original provider text in the recording. */
// The native alert sometimes includes its separate Retry button in textContent, in the page's
// language: the labels are those the extension's transport classifier knows (chatgpt-dom.js).
const NOTICE_BUTTON_LABEL = /\s+(?:Retry|Erneut versuchen|Tentar novamente)\.?\s*$/i;

export function chatErrorMessageKey(text: string, recoverable = false): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  // Only transport notices already classified recoverable use this normalization.
  return recoverable ? normalized.replace(NOTICE_BUTTON_LABEL, '') : normalized;
}

/**
 * A ChatGPT notice as the app shows it (2.1.51 polish pass): a recoverable transport notice without
 * its own Retry button's label; any other text exactly as recorded (CodeRabbit on #2084).
 */
export function chatErrorDisplayText(text: string, recoverable = false): string {
  return recoverable ? text.replace(NOTICE_BUTTON_LABEL, '') : text;
}

/**
 * The reason a message or turn ends when ChatGPT says its chat was deleted (`conversation_deleted`).
 * The same text is in extension/content.js; the renderer translates it.
 */
export const CONVERSATION_DELETED = 'This chat was deleted in ChatGPT. Start a new chat to continue.';
