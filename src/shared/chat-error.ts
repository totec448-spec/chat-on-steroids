/** Equality only: retain the original provider text in the recording. */
export function chatErrorMessageKey(text: string, recoverable = false): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  // The native alert sometimes includes its separate Retry button in textContent, in the page's
  // language: the labels are those the extension's transport classifier knows (chatgpt-dom.js).
  // Only transport notices already classified recoverable use this normalization.
  return recoverable ? normalized.replace(/\s+(?:Retry|Erneut versuchen|Tentar novamente)\.?$/i, '') : normalized;
}

/** A ChatGPT notice as the app shows it: without its own Retry button's label (2.1.51 polish pass). */
export const chatErrorDisplayText = chatErrorMessageKey;

/**
 * The reason a message or turn ends when ChatGPT says its chat was deleted (`conversation_deleted`).
 * The same text is in extension/content.js; the renderer translates it.
 */
export const CONVERSATION_DELETED = 'This chat was deleted in ChatGPT. Start a new chat to continue.';
