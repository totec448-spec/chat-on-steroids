import { getConfig } from '../config.js';
import { workerPrimeOwner } from '../agents.js';
import { BLOCKED_CHAT_REFUSAL, isChatBlocked } from './blocked-chats.js';
import { committedResumeAncestors } from './store.js';
import { isChatTrusted } from './trusted-chats.js';

export const STRICT_CHAT_REFUSAL =
  'CHAT_NOT_TRUSTED: strict chat allowlisting is enabled and this call is not from an explicitly trusted ChatGPT conversation. ' +
  'No tool was run. Ask the user to allow this chat in Sessions (Trust it and make sure it is not Blocked), or allow its owning prime if this is an app-created worker, before retrying.';

export function strictChatAllowlistEnabled(): boolean {
  return getConfig().multiAgent.strictChatAllowlist === true;
}

/** The one conversation-level policy decision used before any model-facing tool handler runs. */
async function trustedByExactProvenance(conversationId: string): Promise<boolean> {
  if (isChatBlocked(conversationId)) return false;
  if (isChatTrusted(conversationId)) return true;
  const ancestors = await committedResumeAncestors(conversationId);
  // The durable lineage lookup above can yield to Block/Trust IPC. Re-read the exact chat before
  // using inherited authority so a revoke that lands during disk I/O still wins this call.
  if (isChatBlocked(conversationId)) return false;
  if (isChatTrusted(conversationId)) return true;
  for (const source of ancestors) {
    // A blocked predecessor revokes inherited trust just as blocking the live prime revokes its
    // workers. Otherwise the nearest explicitly trusted predecessor is sufficient proof.
    if (isChatBlocked(source)) return false;
    if (isChatTrusted(source)) return true;
  }
  return false;
}

export async function conversationAccessRefusal(conversationId: string | null | undefined): Promise<string | null> {
  if (isChatBlocked(conversationId)) return BLOCKED_CHAT_REFUSAL;
  if (!strictChatAllowlistEnabled()) return null;
  if (!conversationId) return STRICT_CHAT_REFUSAL;

  // A worker is app-created on behalf of exactly one prime. Do not copy permission into the
  // worker: resolve its owner on every call so Untrust/Block on the prime takes effect at once.
  const worker = workerPrimeOwner(conversationId);
  if (worker.owned) {
    if (!worker.primeConversationId) return STRICT_CHAT_REFUSAL;
    const trusted = await trustedByExactProvenance(worker.primeConversationId);
    // Prime transfer/recovery can commit while durable resume ancestry is being read. Never let
    // one call spend stale parent authority; the next retry can be admitted against the new owner.
    const currentOwner = workerPrimeOwner(conversationId);
    if (!currentOwner.owned || currentOwner.primeConversationId !== worker.primeConversationId) {
      return STRICT_CHAT_REFUSAL;
    }
    return trusted ? null : STRICT_CHAT_REFUSAL;
  }
  return (await trustedByExactProvenance(conversationId)) ? null : STRICT_CHAT_REFUSAL;
}
