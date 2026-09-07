import { statusForCaller } from '../agents.js';
import { runningToolProgress } from '../mcp/call-context.js';

/** Minimal presentation on the existing activity feed. No tasks, commands or identities leave the app. */
export function conversationProgress(conversationId: string) {
  let workers: { total: number; active: number; finished: number; failed: number; names: string[] } | null = null;
  try {
    const snapshot = statusForCaller({ conversationId });
    if (snapshot.self.role === 'prime') {
      const list = snapshot.state.agents.filter(agent => agent.role === 'worker');
      const active = list.filter(agent => ['active', 'waking', 'detached'].includes(agent.state));
      if (list.length) workers = { total: list.length, active: active.length,
        finished: list.filter(agent => ['sleeping', 'finished'].includes(agent.state)).length,
        failed: list.filter(agent => agent.state === 'failed').length,
        names: active.slice(0, 3).map(agent => (agent.label || 'Worker').slice(0, 60)) };
    }
  } catch { /* No enabled, exact broker owner means no worker claim for this conversation. */ }
  return { tools: runningToolProgress(conversationId), workers };
}
