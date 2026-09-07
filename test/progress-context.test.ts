import { describe, expect, it } from 'vitest';
import { emptyEvidence, runningToolProgress, trackInFlight, type CallContext } from '../src/main/mcp/call-context.js';

const context = (conversationId: string | null): CallContext => ({ startedAt: 1234, transportKey: null, agent: null,
  caller: { transportKey: null, requestId: null, conversationId }, outcome: null, evidence: emptyEvidence() });

describe('truthful tool wait projection', () => {
  it('reports exact local work until the handler returns, without charging unrelated or anonymous work', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const jobs = [context('prime'), context('worker'), context(null)].map(call => trackInFlight(call, () => held));
    try {
      expect(runningToolProgress('prime')).toEqual({ count: 1, since: 1234 });
      expect(runningToolProgress('unrelated')).toBeNull();
    } finally { release(); await Promise.all(jobs); }
    expect(runningToolProgress('prime')).toBeNull();
  });
});
