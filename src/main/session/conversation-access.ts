import { getConfig } from '../config.js';
import { BLOCKED_CHAT_REFUSAL, isChatBlocked } from './blocked-chats.js';
import { isChatTrusted } from './trusted-chats.js';

export const STRICT_CHAT_REFUSAL =
  'CHAT_NOT_TRUSTED: strict chat allowlisting is enabled and this call is not from an explicitly trusted ChatGPT conversation. ' +
  'No tool was run. Ask the user to trust this chat in Sessions before retrying.';

export function strictChatAllowlistEnabled(): boolean {
  return getConfig().multiAgent.strictChatAllowlist === true;
}

/** The one conversation-level policy decision used before any model-facing tool handler runs. */
export function conversationAccessRefusal(conversationId: string | null | undefined): string | null {
  if (isChatBlocked(conversationId)) return BLOCKED_CHAT_REFUSAL;
  if (!strictChatAllowlistEnabled()) return null;
  return isChatTrusted(conversationId) ? null : STRICT_CHAT_REFUSAL;
}
