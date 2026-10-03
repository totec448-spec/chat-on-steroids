import { getConfig } from '../config.js';
import { workerPrimeOwner } from '../agents.js';
import { committedResumeAncestorsFromSummary } from '../../shared/session.js';
import { BLOCKED_CHAT_REFUSAL, isChatBlocked } from './blocked-chats.js';
import { findSessionByConversation } from './store.js';
import { isChatTrusted } from './trusted-chats.js';

export const STRICT_CHAT_REFUSAL =
  'CHAT_NOT_TRUSTED: strict chat allowlisting is enabled and this call is not currently allowed. No tool was run. ' +
  'For an attributed chat, ask the user to hover its row in the sidebar chat list and choose Trust (✓); if that row is blocked, choose Release there. ' +
  'For an app-created worker, use the owning prime row instead. Calls the app cannot link to a chat are refused in strict mode. Retry only after the user changes that policy.';

export function strictChatAllowlistEnabled(): boolean {
  return getConfig().multiAgent.strictChatAllowlist === true;
}

/** The one conversation-level policy decision used before any model-facing tool handler runs. */
async function trustedByExactProvenance(conversationId: string): Promise<boolean> {
  if (isChatBlocked(conversationId)) return false;
  const summary = await findSessionByConversation(conversationId, { requireUnique: true });
  // The durable lookup above can yield to Block/Trust IPC. Re-read policy before spending any
  // authority so a revoke that lands during disk I/O still wins this call.
  if (isChatBlocked(conversationId)) return false;
  // Broker history is intentionally bounded, but the session origin lasts with the transcript.
  // Once a worker's exact prime owner can no longer be proven, that durable worker identity is
  // fail-closed forever: a stale/direct worker Trust bit must never turn it into an ordinary chat.
  if (summary?.conversationId === conversationId && summary.origin?.kind === 'worker') return false;
  if (isChatTrusted(conversationId)) return true;
  const ancestors = summary?.conversationId === conversationId
    ? committedResumeAncestorsFromSummary(summary, conversationId)
    : [];
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
