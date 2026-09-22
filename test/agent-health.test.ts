import { expect, it } from 'vitest';
import { evaluateAgentHealth, type AgentHealthInput } from '../src/shared/agent-health.js';

const NOW = 1_000_000;

function input(overrides: Partial<AgentHealthInput> = {}): AgentHealthInput {
  return {
    agentId: 'worker-1',
    conversationId: 'conversation-1',
    state: 'active',
    observedAt: NOW,
    identity: 'exact',
    browser: 'present',
    runningToolCalls: 0,
    generating: false,
    activeTurn: false,
    wait: null,
    blocker: null,
    ...overrides
  };
}

it('treats exact running tool work as healthy even when weaker browser or wait evidence looks stale', () => {
  expect(evaluateAgentHealth(input({
    browser: 'missing',
    runningToolCalls: 1,
    wait: { kind: 'delivery', deadlineAt: NOW - 1, exempt: false, recommendedAction: 'retry_delivery' }
  }))).toMatchObject({
    activity: 'tool_call',
    health: 'healthy',
    recommendedAction: 'none'
  });
});

it('treats exact generation or an active turn as healthy work', () => {
  expect(evaluateAgentHealth(input({ generating: true }))).toMatchObject({ activity: 'working', health: 'healthy' });
  expect(evaluateAgentHealth(input({ activeTurn: true }))).toMatchObject({ activity: 'working', health: 'healthy' });
});

it('fails closed when exact conversation identity is missing or conflicting', () => {
  for (const identity of ['missing', 'conflicting'] as const) {
    expect(evaluateAgentHealth(input({ identity }))).toMatchObject({
      health: 'unknown',
      recommendedAction: 'observe'
    });
  }
});

it('reports sleeping and terminal broker states as healthy non-running lifecycle states', () => {
  expect(evaluateAgentHealth(input({ state: 'sleeping', browser: 'missing' }))).toMatchObject({
    activity: 'sleeping',
    health: 'healthy',
    recommendedAction: 'none'
  });
  for (const state of ['finished', 'failed'] as const) {
    expect(evaluateAgentHealth(input({ state, browser: 'missing' }))).toMatchObject({
      activity: 'done',
      health: 'healthy',
      recommendedAction: 'none'
    });
  }
});

it('gives an explicit durable blocker precedence over active-work evidence', () => {
  const snapshot = evaluateAgentHealth(input({
    runningToolCalls: 1,
    generating: true,
    blocker: { kind: 'approval', summary: 'Waiting for explicit user approval' }
  }));
  expect(snapshot).toMatchObject({
    health: 'blocked',
    recommendedAction: 'user_attention',
    evidence: { blocker: { kind: 'approval', summary: 'Waiting for explicit user approval' } }
  });
});

it('uses only an owner-provided finite wait deadline to classify a stall', () => {
  const wait = { kind: 'delivery', deadlineAt: NOW + 50, exempt: false, recommendedAction: 'retry_delivery' as const };
  expect(evaluateAgentHealth(input({ wait }))).toMatchObject({
    activity: 'waiting',
    health: 'healthy',
    recommendedAction: 'observe'
  });
  expect(evaluateAgentHealth(input({ wait: { ...wait, deadlineAt: NOW - 1 } }))).toMatchObject({
    activity: 'waiting',
    health: 'stalled',
    recommendedAction: 'retry_delivery'
  });
});

it('does not manufacture a stall for exempt or unbounded waits', () => {
  expect(evaluateAgentHealth(input({
    wait: { kind: 'user', deadlineAt: NOW - 10_000, exempt: true, recommendedAction: 'user_attention' }
  }))).toMatchObject({ activity: 'waiting', health: 'healthy', recommendedAction: 'observe' });
  expect(evaluateAgentHealth(input({
    wait: { kind: 'external', deadlineAt: null, exempt: false, recommendedAction: 'observe' }
  }))).toMatchObject({ activity: 'waiting', health: 'healthy', recommendedAction: 'observe' });
});

it('degrades detached or browser-missing active workers without claiming their server-side turn ended', () => {
  for (const patch of [
    { state: 'detached' as const, browser: 'missing' as const },
    { state: 'active' as const, browser: 'missing' as const }
  ]) {
    expect(evaluateAgentHealth(input(patch))).toMatchObject({
      activity: 'working',
      health: 'degraded',
      recommendedAction: 'observe'
    });
  }
});

it('degrades malformed timing evidence instead of fabricating an expired wait', () => {
  expect(evaluateAgentHealth(input({
    wait: { kind: 'delivery', deadlineAt: Number.NaN, exempt: false, recommendedAction: 'retry_delivery' }
  }))).toMatchObject({
    activity: 'waiting',
    health: 'degraded',
    recommendedAction: 'observe'
  });
});

it('is deterministic and bounds human-readable blocker evidence', () => {
  const raw = 'x'.repeat(1_000);
  const value = input({ blocker: { kind: 'policy', summary: raw } });
  const first = evaluateAgentHealth(value);
  const second = evaluateAgentHealth(value);
  expect(second).toEqual(first);
  expect(first.reason.length).toBeLessThanOrEqual(240);
  expect(first.evidence.blocker?.summary.length).toBeLessThanOrEqual(160);
  expect(first.evidence.blocker?.summary).not.toBe(raw);
});
