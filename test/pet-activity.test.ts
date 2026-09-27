import { describe, expect, it } from 'vitest';
import type { AgentInfo, SessionSummary } from '../src/shared/session.js';
import { highestPetActivityLevel, petActivityForAgent, petActivityForSession, petTaskSessionId } from '../src/shared/pet-activity.js';

const NOW = 10_000;
const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'session-one', title: 'Main task', conversationId: 'chat-main', chatIds: ['chat-main'],
  startedAt: 1_000, updatedAt: 9_000, endedAt: null, events: 1, userMessages: 1, toolCalls: 1,
  lastToolCallAt: 9_500, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
  estimatedTokens: 0, origin: { kind: 'manual' }, ...overrides
} as SessionSummary);
const agent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'worker-1', role: 'worker', label: 'Research', task: 'Check the implementation', state: 'active', runId: 'run-1',
  reasoningEffort: null, model: null, createdAt: 1, activatedAt: 2, finishedAt: null, result: null, pending: 0,
  awaitingAck: 0, delivered: 0, conversationId: 'chat-worker', detachedAt: null, lastSeenAt: 2, revivable: true,
  sleptAt: null, contextTokens: 0, ...overrides
} as AgentInfo);

describe('pet task activity projection', () => {
  it('resolves a parked worker back to its proven Prime without guessing an unlinked owner', () => {
    expect(petTaskSessionId(session())).toBe('session-one');
    expect(petTaskSessionId(session({ origin: { kind: 'worker', fromSessionId: 'prime-session', agentId: 'worker-1', task: 'Inspect' } }))).toBe('prime-session');
    expect(petTaskSessionId(session({ origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'Inspect' } }))).toBeNull();
    expect(petTaskSessionId(session({ origin: { kind: 'helper', fromSessionId: 'prime-session', agentId: null, task: '' } }))).toBeNull();
  });
  it('projects authoritative worker and session state without renderer ownership', () => {
    expect(petActivityForAgent(agent(), 'worker-session', false)).toEqual(expect.objectContaining({ level: 'running', sessionId: 'worker-session' }));
    expect(petActivityForSession(session({ activityExpiresAt: NOW + 2_000 }), false, NOW)?.activity).toEqual(expect.objectContaining({ level: 'running', sessionId: 'session-one' }));
  });
  it('preserves waiting, failure, blocked and review semantics', () => {
    const rows = [
      petActivityForAgent(agent({ state: 'sleeping' }), null, false),
      petActivityForAgent(agent({ id: 'worker-2', state: 'failed' }), null, false),
      petActivityForAgent(agent({ id: 'worker-3', state: 'finished' }), null, false),
      petActivityForAgent(agent({ id: 'worker-4' }), null, true)
    ];
    expect(rows.map(row => row.level)).toEqual(['waiting', 'failed', 'review', 'failed']);
    expect(highestPetActivityLevel(rows)).toBe('failed');
    expect(highestPetActivityLevel([rows[0]!, rows[2]!])).toBe('review');
    expect(highestPetActivityLevel([rows[0]!, petActivityForAgent(agent(), null, false)])).toBe('running');
  });
  it('keeps a tool-only completed turn green for review and does not revive failed history', () => {
    const completed = session({
      lastToolCallAt: NOW - 2_000, lastAssistantFinalAt: null, lastTurnEndAt: NOW - 1_000,
      lastTurnOutcome: 'completed', activityExpiresAt: null
    });
    expect(petActivityForSession(completed, false, NOW)).toEqual(expect.objectContaining({
      activity: expect.objectContaining({ level: 'review', body: 'Ready for review' }),
      nextAt: NOW - 1_000 + 45_000
    }));
    expect(petActivityForSession({ ...completed, lastTurnOutcome: 'failed', lastAssistantFinalAt: NOW - 500 }, false, NOW)).toBeNull();
    expect(petActivityForSession({ ...completed, activeTurnId: 'next-turn' }, false, NOW)).toBeNull();
  });
  it('expires the review reaction at its exact deadline', () => {
    const reviewed = session({ lastToolCallAt: null, lastAssistantFinalAt: NOW - 1_000, activityExpiresAt: null });
    expect(petActivityForSession(reviewed, false, NOW)?.activity.level).toBe('review');
    expect(petActivityForSession(reviewed, false, NOW + 46_000)).toBeNull();
  });
});
