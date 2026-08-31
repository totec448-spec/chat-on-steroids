/**
 * Which ChatGPT conversation owns a live `exec_command` session.
 *
 * Codex never needs this. It hangs `UnifiedExecProcessManager` off `session.services`, so a
 * conversation cannot even name another conversation's process: the manager it reaches is a
 * different object. This connector is one long-lived main process serving every chat through
 * one manager, so the same session ids are in scope everywhere, and `write_stdin(session_id)`
 * on a numeric id from another chat would otherwise reach that chat's shell.
 *
 * This is an authorization boundary. A proven owner can only be continued by that same proven
 * conversation. Legacy/single-chat calls that carry no request identity are kept in a separate
 * anonymous bucket so existing terminal semantics still work, but a later proven chat cannot
 * adopt such a session and an anonymous call cannot touch a proven-owned session.
 */

import { requestCorrelation } from '../session/correlation.js';
import { unifiedExecManager } from './manager.js';
import type { BackgroundExecState } from './unified-exec.js';

/** Prevent one caller from indefinitely postponing already-completed command results. */
export const MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION = 4;

/** Owners, keyed by the process id `exec_command` handed back as `session_id`. */
const owners = new Map<number, string | null>();

function processIdsOwnedBy(conversationId: string): Set<number> {
  const processIds = new Set<number>();
  for (const [processId, owner] of owners) if (owner === conversationId) processIds.add(processId);
  return processIds;
}

/**
 * The conversation behind an in-flight MCP request, when it is already proven.
 *
 * Never waits. The correlation registry resolves a request id the moment the page reports the
 * matching connector request, and everything here degrades to "unknown" rather than blocking a
 * command on browser evidence.
 */
export function provenConversation(requestId: string | null, conversationId: string | null): string | null {
  if (conversationId) return conversationId;
  return requestCorrelation(requestId)?.conversationId ?? null;
}

/** Records the conversation that opened a still-running exec session. */
export function noteExecOwner(processId: number | null, conversationId: string | null): void {
  if (processId === null) return;
  owners.set(processId, conversationId);
}

/** Drops a session's owner once it can no longer be written to. */
export function forgetExecOwner(processId: number | null): void {
  if (processId === null) return;
  owners.delete(processId);
}

/** The conversation that opened this session, or null when it was never proven. */
export function execOwner(processId: number): string | null {
  return owners.get(processId) ?? null;
}

/** One caller-scoped projection used by reminders, admission and runtime status. */
export function backgroundExecObligations(conversationId: string | null | undefined): BackgroundExecState {
  if (!conversationId) return { running: [], exitedUnread: [] };
  return unifiedExecManager.backgroundState(processIdsOwnedBy(conversationId));
}

/** Same-conversation reminders for exited sessions that have not been polled yet. */
export function backgroundExecRecoveryNotices(conversationId: string | null | undefined): string[] {
  const exited = backgroundExecObligations(conversationId).exitedUnread;
  if (exited.length === 0) return [];
  const notices = exited
    .slice(0, 3)
    .map(
      (session) =>
        `Background session ${session.processId} finished with exit code ${session.exitCode ?? 'unknown'} and has unread output. ` +
        `Poll it with write_stdin(session_id=${session.processId}, chars="").`
    );
  if (exited.length > notices.length) {
    notices.push(`${exited.length - notices.length} more background session result(s) are waiting to be polled.`);
  }
  return notices;
}

/**
 * Whether `conversationId` may write to `processId`.
 *
 * Proven sessions require the same proven caller. Anonymous sessions can only be continued by
 * anonymous callers; they are never adoptable by a later identified conversation. A process
 * with no registry entry at all is refused.
 */
export function execOwnershipDenied(processId: number, conversationId: string | null): boolean {
  if (!owners.has(processId)) return true;
  const owner = owners.get(processId);
  if (owner === null) return conversationId !== null;
  if (!conversationId) return true;
  return owner !== conversationId;
}

/**
 * Moves live process authority with a proven Compact & Resume chat A→B transition.
 *
 * Conversation ownership is the current representation used by the shared process manager.
 * Until it can be keyed directly by durable session principal, continuation publication must
 * move the processes opened by the old chat along with the session. This hook changes exactly
 * owners equal to `fromConversationId`: anonymous legacy sessions and processes belonging to
 * every other chat are untouched. It is app-internal and carries no discovery/wire surface.
 */
export function moveExecConversationOwners(fromConversationId: string, toConversationId: string): number {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return 0;
  let moved = 0;
  for (const [processId, owner] of owners) {
    if (owner !== fromConversationId) continue;
    owners.set(processId, toConversationId);
    moved += 1;
  }
  return moved;
}

/** Test seam: the registry is process-global state with no natural lifetime boundary. */
export function resetExecOwnershipForTests(): void {
  owners.clear();
}
