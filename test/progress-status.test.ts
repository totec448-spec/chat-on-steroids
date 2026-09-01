import { describe, expect, it } from 'vitest';
import { deriveRuntimeProgress } from '../src/shared/progress.js';

const swarm = (states: string[] = []) => ({
  enabled: states.length > 0,
  running: states.length > 0,
  agents: states.map((state, index) => ({ id: `worker-${index + 1}`, role: 'worker', state }))
});

describe('runtime progress status', () => {
  it('reports active and detached workers as real work rather than a hang', () => {
    expect(deriveRuntimeProgress({ connectionState: 'connected', pendingCommands: [], swarm: swarm(['active', 'detached']) as any }))
      .toMatchObject({ kind: 'working', summary: '2 workers working' });
  });

  it('reports browser-owned worker startup as waiting', () => {
    expect(deriveRuntimeProgress({
      connectionState: 'connected',
      pendingCommands: [{ what: 'worker worker-1', lastError: null }],
      swarm: swarm(['invited']) as any
    })).toMatchObject({ kind: 'waiting', summary: 'Waiting for browser', detail: expect.stringContaining('worker') });
  });

  it('makes a broken connection a blocked state ahead of background work', () => {
    expect(deriveRuntimeProgress({ connectionState: 'auth-failed', pendingCommands: [], swarm: swarm(['active']) as any }))
      .toMatchObject({ kind: 'blocked', summary: 'Connection needs attention' });
  });

  it('stays silent when there is no live or waiting work', () => {
    expect(deriveRuntimeProgress({ connectionState: 'connected', pendingCommands: [], swarm: swarm() as any }))
      .toEqual({ kind: 'idle', summary: '', detail: '' });
  });
});
