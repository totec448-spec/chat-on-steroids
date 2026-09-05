/**
 * Which durable local session owns a live `exec_command` process.
 *
 * Codex never needs this. It hangs `UnifiedExecProcessManager` off `session.services`, so a
 * session cannot even name another session's process: the manager it reaches is a
 * different object. This connector is one long-lived main process serving every chat through
 * one manager, so the same session ids are in scope everywhere, and `write_stdin(session_id)`
 * on a numeric id from another chat would otherwise reach that chat's shell.
 *
 * This is an authorization boundary. A proven owner can only be continued by that same durable
 * session, whose frontend attachment may legitimately change from A to B during Compact & Resume.
 * Legacy/single-chat calls that carry no request identity are kept in a separate
 * anonymous bucket so existing terminal semantics still work, but a later proven chat cannot
 * adopt such a session and an anonymous call cannot touch a proven-owned session.
 */

import { requestCorrelation } from '../session/correlation.js';
import { unifiedExecManager } from './manager.js';
import type { BackgroundExecState } from './unified-exec.js';

/** Prevent one caller from indefinitely postponing already-completed command results. */
export const MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION = 4;

/**
 * How long a live session may go unpolled before the chat that opened it is reminded it exists.
 *
 * An exited session announces itself through `exitedUnread`: its result is retained, and the
 * reminder repeats every call until something drains it. A session that never exits has no such
 * trigger, and that is the second shape of a turn that reads as stuck — the model launched
 * something, moved on, and nothing in the loop ever mentioned it again. Two minutes is past any
 * yield an `exec_command` can ask for (30s) and well short of a real build.
 *
 * This buys a reminder and nothing else. It deliberately does not feed
 * `MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION`: a completed result is bounded work, one cheap poll
 * and it is gone, while a dev server or a `tail -f` is *meant* to sit there for the whole turn.
 * Spending the admission budget on those would lock a chat out of `exec_command` until it killed
 * its own server, which is a worse failure than the one this exists to catch.
 */
export const UNATTENDED_EXEC_NOTICE_MS = 120_000;

/** At most this many reminders of each kind per result; the rest keep until the next call. */
const NOTICES_PER_KIND = 3;

/** Owners, keyed by the process id `exec_command` handed back as `session_id`. */
const owners = new Map<number, string | null>();

/** When each owned session was last started or polled, keyed the same way. */
const attendedAt = new Map<number, number>();

/**
 * Sessions whose unattended reminder has already been delivered.
 *
 * Unlike the exited-unread reminder this one cannot clear itself — polling a live session leaves
 * it just as live — so a notice re-derived from state on every call would nag about a
 * deliberately long-lived server for the rest of the run and spend tokens doing it. One notice
 * per session is the whole obligation: if the model polls it the clock restarts and nothing
 * further is said, and if it later exits, `exitedUnread` takes over and repeats until the output
 * is actually consumed.
 */
const announcedUnattended = new Set<number>();

function processIdsOwnedBy(sessionId: string): Set<number> {
  const processIds = new Set<number>();
  for (const [processId, owner] of owners) if (owner === sessionId) processIds.add(processId);
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

/** The stable local session principal behind this exact call, when it is proven. */
export function provenSession(requestId: string | null, sessionId: string | null): string | null {
  if (sessionId) return sessionId;
  return requestCorrelation(requestId)?.sessionId ?? null;
}

/** Records the durable session that opened a still-running exec process. */
export function noteExecOwner(processId: number | null, sessionId: string | null): void {
  if (processId === null) return;
  owners.set(processId, sessionId);
  attendedAt.set(processId, Date.now());
}

/**
 * Restarts a live session's unattended clock.
 *
 * Called on both sides of a `write_stdin` wait. An empty poll blocks for at least
 * `MIN_EMPTY_YIELD_TIME_MS` and may be asked to wait far longer, so marking only on the way out
 * would let a caller that is attending the session *right now* cross the threshold while it
 * waits. Refuses to resurrect a session the registry has already dropped, so the poll that
 * drains a terminal result cannot re-register the id it just retired.
 */
export function noteExecAttended(processId: number | null): void {
  if (processId === null || !owners.has(processId)) return;
  attendedAt.set(processId, Date.now());
}

/** Drops a session's owner once it can no longer be written to. */
export function forgetExecOwner(processId: number | null): void {
  if (processId === null) return;
  owners.delete(processId);
  attendedAt.delete(processId);
  announcedUnattended.delete(processId);
}

/** The durable local session that opened this process, or null when it was never proven. */
export function execOwner(processId: number): string | null {
  return owners.get(processId) ?? null;
}

/** Live/result-bearing process ids proven to belong to one conversation. */
export function execProcessIdsForConversation(conversationId: string): number[] {
  if (!conversationId) return [];
  return [...owners.entries()]
    .filter(([, owner]) => owner === conversationId)
    .map(([processId]) => processId);
}

/** All process ids still tracked by the ownership fence, including anonymous legacy sessions. */
export function execTrackedProcessIds(): number[] {
  return [...owners.keys()];
}

/** One caller-scoped projection used by reminders, admission and runtime status. */
export function backgroundExecObligations(sessionId: string | null | undefined): BackgroundExecState {
  if (!sessionId) return { running: [], exitedUnread: [] };
  return unifiedExecManager.backgroundState(processIdsOwnedBy(sessionId));
}

/** Owned sessions still running past the threshold that have not been announced yet. */
function unannouncedUnattended(running: readonly number[]): Array<{ processId: number; idleMs: number }> {
  const now = Date.now();
  const rows: Array<{ processId: number; idleMs: number }> = [];
  for (const processId of running) {
    if (announcedUnattended.has(processId)) continue;
    const since = attendedAt.get(processId);
    if (since === undefined) continue;
    const idleMs = now - since;
    if (idleMs >= UNATTENDED_EXEC_NOTICE_MS) rows.push({ processId, idleMs });
  }
  return rows;
}

/** An idle span as a one-line reminder can carry it. */
function describeIdle(idleMs: number): string {
  const minutes = Math.floor(idleMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * Same-conversation reminders: finished results waiting to be read, and live sessions left alone.
 *
 * This one both derives and *records* — delivering an unattended reminder is what marks that
 * session announced — so it belongs on the single path that appends notices to a delivered tool
 * result, and nowhere else. Calling it to peek would spend the only notice a session ever gets.
 */
export function backgroundExecRecoveryNotices(sessionId: string | null | undefined): string[] {
  const state = backgroundExecObligations(sessionId);
  const notices = state.exitedUnread
    .slice(0, NOTICES_PER_KIND)
    .map(
      (session) =>
        `Background session ${session.processId} finished with exit code ${session.exitCode ?? 'unknown'} and has unread output. ` +
        `Poll it with write_stdin(session_id=${session.processId}, chars="").`
    );
  if (state.exitedUnread.length > notices.length) {
    notices.push(
      `${state.exitedUnread.length - notices.length} more background session result(s) are waiting to be polled.`
    );
  }
  for (const session of unannouncedUnattended(state.running).slice(0, NOTICES_PER_KIND)) {
    announcedUnattended.add(session.processId);
    notices.push(
      `Background session ${session.processId} has been running unpolled for ${describeIdle(session.idleMs)}. ` +
        `Poll it with write_stdin(session_id=${session.processId}, chars="") or terminate it if it is no longer needed.`
    );
  }
  return notices;
}

/**
 * Whether `sessionId` may write to `processId`.
 *
 * Proven sessions require the same proven caller. Anonymous sessions can only be continued by
 * anonymous callers; they are never adoptable by a later identified conversation. A process
 * with no registry entry at all is refused.
 */
export function execOwnershipDenied(processId: number, sessionId: string | null): boolean {
  if (!owners.has(processId)) return true;
  const owner = owners.get(processId);
  if (owner === null) return sessionId !== null;
  if (!sessionId) return true;
  return owner !== sessionId;
}

/** Test seam: the registry is process-global state with no natural lifetime boundary. */
export function resetExecOwnershipForTests(): void {
  owners.clear();
  attendedAt.clear();
  announcedUnattended.clear();
}

/** Test seam: backdating one clock beats faking time around real child processes. */
export function backdateExecAttendanceForTests(processId: number, byMs: number): void {
  const since = attendedAt.get(processId);
  if (since !== undefined) attendedAt.set(processId, since - byMs);
}
