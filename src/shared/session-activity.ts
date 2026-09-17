import { CHAT_ACTIVE_MS, type SessionSummary } from './session.js';

/** The Active label uses the bridge's projected deadline when one is available. */
export function recentChatActivity(summary: SessionSummary, now = Date.now()): boolean {
  if (summary.activityExpiresAt !== undefined) {
    return summary.activityExpiresAt !== null && now < summary.activityExpiresAt;
  }
  const lastActivityAt = Math.max(summary.startedAt, summary.lastToolCallAt ?? 0);
  const finishedAt = Math.max(summary.lastAssistantFinalAt ?? 0, summary.lastTurnEndAt ?? 0);
  return lastActivityAt > finishedAt && now - lastActivityAt < CHAT_ACTIVE_MS;
}

/** A worker's own finish report ends its work even while the broker view catches up. */
export function workerReportedFinish(summary: SessionSummary): boolean {
  return summary.origin?.kind === 'worker' && typeof summary.lastFinishReportAt === 'number' &&
    summary.lastFinishReportAt >= (summary.lastToolCallAt ?? 0);
}

/** Shared by the displayed label and the opening cohort of attribution recovery. */
export function sessionWorkingAt(summary: SessionSummary, now: number): boolean {
  return summary.endedAt === null && !workerReportedFinish(summary) && recentChatActivity(summary, now);
}
