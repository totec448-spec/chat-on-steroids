/**
 * The notices strict chat trust records in a refused chat's timeline (kernel.ts). The main process
 * writes them in English; the renderer recognizes exactly these texts and shows them in the
 * interface language, as it does for approval rows.
 */
export const STRICT_REFUSAL_PROGRESS_PREFIX = 'strict-chat-refusal:';

export const UNTRUSTED_NOTICE =
  'A tool call from an untrusted chat was refused. To allow it, open this chat\'s ⋯ menu in the sidebar (or right-click its row) and choose Trust chat.';
export const UNTRUSTED_WORKER_NOTICE =
  'A tool call from a worker whose main chat is not currently allowed was refused. Open that main chat\'s ⋯ menu in the sidebar and choose Trust chat if it is untrusted, or Release chat if it is blocked.';
export const UNPROVEN_WORKER_NOTICE =
  'A tool call from an app-created worker was refused because the main chat that started it is not proven yet. Return to that main chat in the sidebar; once its row is there, open its ⋯ menu and choose Trust chat, or Release chat if it is blocked, then retry after the worker is attached or recovered there.';
