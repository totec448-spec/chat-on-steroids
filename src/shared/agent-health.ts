import type { AgentState } from './session.js';

export type WorkerOverviewHealth = 'healthy' | 'degraded' | 'unknown';
export type WorkerOverviewActivity = 'starting' | 'working' | 'sleeping' | 'done';

export interface WorkerOverviewHealthInput {
  state: AgentState | null;
  exactIdentity: boolean;
  working: boolean;
  activeTurn: boolean;
}

export interface WorkerOverviewHealthSnapshot {
  health: WorkerOverviewHealth;
  activity: WorkerOverviewActivity;
  reason: string;
}

function activityFor(input: WorkerOverviewHealthInput): WorkerOverviewActivity {
  if (input.working || input.activeTurn) return 'working';
  if (input.state === 'invited' || input.state === 'waking') return 'starting';
  if (input.state === 'sleeping') return 'sleeping';
  if (input.state === 'finished' || input.state === 'failed') return 'done';
  return 'working';
}

/**
 * Read-only projection for the worker overview.
 *
 * This function owns no lifecycle fact and performs no recovery. It only interprets the
 * broker/session evidence the renderer already has. Strong positive work evidence wins over
 * browser detachment; missing exact worker/conversation binding fails closed to unknown.
 */
export function evaluateWorkerOverviewHealth(
  input: WorkerOverviewHealthInput
): WorkerOverviewHealthSnapshot {
  const activity = activityFor(input);
  if (!input.exactIdentity) {
    return {
      health: 'unknown',
      activity,
      reason: 'Exact worker/conversation binding is unavailable; health is not inferred.'
    };
  }
  if (input.state === 'failed') {
    return {
      health: 'degraded',
      activity: 'done',
      reason: 'The broker recorded this worker as failed.'
    };
  }
  if (input.state === 'sleeping') {
    return {
      health: 'healthy',
      activity: 'sleeping',
      reason: 'The broker reports this worker as sleeping and reusable.'
    };
  }
  if (input.state === 'finished') {
    return {
      health: 'healthy',
      activity: 'done',
      reason: 'The broker reports this worker in the finished lifecycle state.'
    };
  }
  if (input.working || input.activeTurn) {
    return {
      health: 'healthy',
      activity: 'working',
      reason: 'Exact recorded work is still active for this worker.'
    };
  }
  if (input.state === 'detached') {
    return {
      health: 'degraded',
      activity,
      reason: 'The worker is detached; browser absence does not prove its server-side work ended.'
    };
  }
  if (input.state === null) {
    return {
      health: 'unknown',
      activity,
      reason: 'No current broker lifecycle state is available.'
    };
  }
  return {
    health: 'healthy',
    activity,
    reason: `The broker reports the worker in the ${input.state} lifecycle state.`
  };
}
