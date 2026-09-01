import type { ConnectionState } from './types.js';
import type { SwarmState } from './session.js';

export type RuntimeProgressKind = 'idle' | 'working' | 'waiting' | 'blocked';

export interface RuntimeProgress {
  kind: RuntimeProgressKind;
  summary: string;
  detail: string;
}

interface PendingBrowserCommand {
  what: string;
  lastError: string | null;
}

export function deriveRuntimeProgress(input: {
  connectionState: ConnectionState;
  pendingCommands: readonly PendingBrowserCommand[];
  swarm: Pick<SwarmState, 'agents'>;
}): RuntimeProgress {
  if (input.connectionState === 'auth-failed' || input.connectionState === 'tunnel-unavailable') {
    return {
      kind: 'blocked',
      summary: 'Connection needs attention',
      detail: input.connectionState === 'auth-failed' ? 'Authentication failed.' : 'The tunnel is unavailable.'
    };
  }

  if (input.connectionState === 'offline') {
    return { kind: 'waiting', summary: 'Waiting for network', detail: 'Core is running, but OpenAI is unreachable.' };
  }

  if (input.pendingCommands.length > 0) {
    const first = input.pendingCommands[0]!;
    const count = input.pendingCommands.length;
    return {
      kind: 'waiting',
      summary: 'Waiting for browser',
      detail: first.lastError
        ? `${first.what}: retrying after ${first.lastError}`
        : `${count === 1 ? first.what : `${count} browser commands`} queued for delivery.`
    };
  }

  const waiting = input.swarm.agents.filter((agent) => agent.state === 'invited' || agent.state === 'waking');
  if (waiting.length > 0) {
    return {
      kind: 'waiting',
      summary: `Waiting for ${waiting.length} worker${waiting.length === 1 ? '' : 's'} to start`,
      detail: 'Their browser handoff has not completed yet.'
    };
  }

  const working = input.swarm.agents.filter((agent) => agent.state === 'active' || agent.state === 'detached');
  if (working.length > 0) {
    return {
      kind: 'working',
      summary: `${working.length} worker${working.length === 1 ? '' : 's'} working`,
      detail: working.some((agent) => agent.state === 'detached')
        ? 'At least one worker is still active without an open browser tab.'
        : 'Worker turns are still active.'
    };
  }

  return { kind: 'idle', summary: '', detail: '' };
}