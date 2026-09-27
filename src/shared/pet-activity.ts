import { CHAT_ACTIVE_MS, type AgentInfo, type SessionSummary } from './session.js';
import { sessionWorkingAt } from './session-activity.js';
import type { PetActivity, PetActivityLevel } from './pets.js';

export const PET_REVIEW_MS = 45_000;

/** Workers do not replace their Prime's task when they become the last recorded session. */
export function petTaskSessionId(session: SessionSummary): string | null {
  if (session.origin?.kind === 'helper') return null;
  if (session.origin?.kind === 'worker') return session.origin.fromSessionId ?? null;
  return session.id;
}

export function petActivityForAgent(agent: AgentInfo, sessionId: string | null, blocked: boolean): PetActivity {
  let level: PetActivityLevel;
  let body: string;
  if (blocked) {
    level = 'failed'; body = 'Blocked by user';
  } else {
    switch (agent.state) {
      case 'failed': level = 'failed'; body = 'Failed'; break;
      case 'sleeping': level = 'waiting'; body = 'Sleeping · ready to resume'; break;
      case 'finished': level = 'review'; body = 'Finished'; break;
      case 'invited': level = 'running'; body = 'Starting'; break;
      case 'waking': level = 'running'; body = 'Waking'; break;
      case 'detached': level = 'running'; body = 'Working in background'; break;
      case 'active': level = 'running'; body = agent.task || 'Working'; break;
    }
  }
  return {
    id: `${agent.runId ?? 'run'}:${agent.id}`,
    title: agent.role === 'prime' ? 'Prime' : (agent.label || agent.id),
    body: agent.task && body !== agent.task ? `${body} · ${agent.task}` : body,
    level,
    ...(sessionId ? { sessionId } : {})
  };
}

export function petActivityForSession(
  session: SessionSummary,
  blocked: boolean,
  now = Date.now()
): { activity: PetActivity; nextAt: number | null } | null {
  const working = sessionWorkingAt(session, now);
  // A completed turn is the authoritative task boundary even when the provider emitted no
  // final prose (for example a tool-only answer). Older recordings can have a stable final but
  // no outcome, so retain that legacy evidence without letting a later stopped/failed turn
  // resurrect an earlier green completion.
  const completedAt = session.lastTurnOutcome === 'completed'
    ? Math.max(session.lastTurnEndAt ?? 0, session.lastAssistantFinalAt ?? 0)
    : session.lastTurnOutcome === null || session.lastTurnOutcome === undefined
      ? (session.lastAssistantFinalAt ?? 0)
      : 0;
  const reviewDeadline = completedAt + PET_REVIEW_MS;
  const recentFinal = !session.activeTurnId && completedAt > 0 && reviewDeadline > now;
  if (!blocked && !working && !recentFinal) return null;
  const fallbackActivityDeadline = Math.max(session.startedAt, session.lastToolCallAt ?? 0) + CHAT_ACTIVE_MS;
  const activityDeadline = session.activityExpiresAt === undefined ? fallbackActivityDeadline : (session.activityExpiresAt ?? 0);
  return {
    activity: {
      id: `session:${session.id}`,
      title: session.title || 'Chat',
      body: blocked ? 'Blocked by user' : working ? 'Working' : 'Ready for review',
      level: blocked ? 'failed' : working ? 'running' : 'review',
      sessionId: session.id
    },
    nextAt: blocked ? null : working ? activityDeadline : reviewDeadline
  };
}

export function highestPetActivityLevel(rows: readonly PetActivity[]): PetActivityLevel {
  // Sleeping workers are reusable capacity, not a stronger task state than active work or a
  // completed result awaiting review. Failure remains the only state that overrides both.
  const rank: Record<PetActivityLevel, number> = { idle: 0, waiting: 1, review: 2, running: 3, failed: 4 };
  return rows.reduce<PetActivityLevel>((best, row) => rank[row.level] > rank[best] ? row.level : best, 'idle');
}
