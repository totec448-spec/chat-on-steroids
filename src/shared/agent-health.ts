import type { AgentState } from './session.js';

export type AgentActivity = 'starting' | 'working' | 'tool_call' | 'waiting' | 'sleeping' | 'done';
export type AgentHealth = 'healthy' | 'degraded' | 'stalled' | 'blocked' | 'unknown';
export type AgentHealthRecommendedAction = 'none' | 'observe' | 'retry_delivery' | 'user_attention';
export type AgentHealthIdentity = 'exact' | 'missing' | 'conflicting';
export type AgentHealthBrowser = 'present' | 'missing' | 'unknown';

export interface AgentHealthWaitEvidence {
  kind: string;
  deadlineAt: number | null;
  exempt: boolean;
  recommendedAction: Exclude<AgentHealthRecommendedAction, 'none'>;
}

export interface AgentHealthBlockerEvidence {
  kind: string;
  summary: string;
}

export interface AgentHealthEvidence {
  identity: AgentHealthIdentity;
  browser: AgentHealthBrowser;
  runningToolCalls: number;
  generating: boolean | null;
  activeTurn: boolean | null;
  wait: AgentHealthWaitEvidence | null;
  blocker: AgentHealthBlockerEvidence | null;
}

export interface AgentHealthInput extends AgentHealthEvidence {
  agentId: string;
  conversationId: string | null;
  state: AgentState;
  observedAt: number;
}

export interface AgentHealthSnapshot {
  agentId: string;
  conversationId: string | null;
  activity: AgentActivity;
  health: AgentHealth;
  recommendedAction: AgentHealthRecommendedAction;
  reason: string;
  observedAt: number;
  evidence: AgentHealthEvidence;
}

const MAX_REASON_CHARS = 240;
const MAX_EVIDENCE_KIND_CHARS = 80;
const MAX_BLOCKER_SUMMARY_CHARS = 160;

function bounded(value: string, limit: number): string {
  return value.trim().slice(0, limit);
}

function activityFor(input: AgentHealthInput): AgentActivity {
  if (Number.isFinite(input.runningToolCalls) && input.runningToolCalls > 0) return 'tool_call';
  if (input.generating === true || input.activeTurn === true) return 'working';
  if (input.state === 'sleeping') return 'sleeping';
  if (input.state === 'finished' || input.state === 'failed') return 'done';
  if (input.wait || input.blocker) return 'waiting';
  if (input.state === 'invited' || input.state === 'waking') return 'starting';
  return 'working';
}

function normalizedEvidence(input: AgentHealthInput): AgentHealthEvidence {
  return {
    identity: input.identity,
    browser: input.browser,
    runningToolCalls: input.runningToolCalls,
    generating: input.generating,
    activeTurn: input.activeTurn,
    wait: input.wait ? {
      kind: bounded(input.wait.kind, MAX_EVIDENCE_KIND_CHARS),
      deadlineAt: input.wait.deadlineAt,
      exempt: input.wait.exempt,
      recommendedAction: input.wait.recommendedAction
    } : null,
    blocker: input.blocker ? {
      kind: bounded(input.blocker.kind, MAX_EVIDENCE_KIND_CHARS),
      summary: bounded(input.blocker.summary, MAX_BLOCKER_SUMMARY_CHARS)
    } : null
  };
}

export function evaluateAgentHealth(input: AgentHealthInput): AgentHealthSnapshot {
  const evidence = normalizedEvidence(input);
  const activity = activityFor(input);
  const snapshot = (
    health: AgentHealth,
    recommendedAction: AgentHealthRecommendedAction,
    reason: string
  ): AgentHealthSnapshot => ({
    agentId: input.agentId,
    conversationId: input.conversationId,
    activity,
    health,
    recommendedAction,
    reason: bounded(reason, MAX_REASON_CHARS),
    observedAt: input.observedAt,
    evidence
  });

  if (evidence.blocker) {
    const detail = evidence.blocker.summary || evidence.blocker.kind || 'explicit workflow evidence';
    return snapshot('blocked', 'user_attention', `Blocked by ${detail}.`);
  }

  if (evidence.identity !== 'exact') {
    return snapshot('unknown', 'observe', evidence.identity === 'conflicting'
      ? 'Conversation identity evidence conflicts; health is not inferred.'
      : 'Exact conversation identity is missing; health is not inferred.');
  }

  if (!Number.isInteger(evidence.runningToolCalls) || evidence.runningToolCalls < 0) {
    return snapshot('degraded', 'observe', 'Running tool-call evidence is malformed.');
  }

  if (evidence.runningToolCalls > 0) {
    return snapshot('healthy', 'none', 'An exact conversation-owned tool call is still running.');
  }

  if (evidence.generating === true || evidence.activeTurn === true) {
    return snapshot('healthy', 'none', evidence.generating === true
      ? 'The exact conversation is actively generating.'
      : 'The exact conversation still has an active turn.');
  }

  if (input.state === 'sleeping') {
    return snapshot('healthy', 'none', 'The worker is sleeping and remains reusable.');
  }

  if (input.state === 'finished' || input.state === 'failed') {
    return snapshot('healthy', 'none', `The worker is in the terminal ${input.state} lifecycle state.`);
  }

  if (evidence.wait) {
    if (!Number.isFinite(input.observedAt) || input.observedAt < 0 ||
        (evidence.wait.deadlineAt !== null && (!Number.isFinite(evidence.wait.deadlineAt) || evidence.wait.deadlineAt < 0))) {
      return snapshot('degraded', 'observe', 'Wait timing evidence is malformed, so no stall is inferred.');
    }
    if (evidence.wait.exempt || evidence.wait.deadlineAt === null) {
      return snapshot('healthy', 'observe', 'The worker is waiting without an applicable finite stall deadline.');
    }
    if (input.observedAt >= evidence.wait.deadlineAt) {
      return snapshot('stalled', evidence.wait.recommendedAction, 'The owner-provided wait deadline has elapsed.');
    }
    return snapshot('healthy', 'observe', 'The owner-provided wait deadline has not elapsed.');
  }

  if ((input.state === 'active' || input.state === 'detached') && evidence.browser !== 'present') {
    return snapshot('degraded', 'observe', input.state === 'detached'
      ? 'The worker is detached; browser absence does not prove its server-side turn ended.'
      : 'Browser presence is not currently proven for this active worker.');
  }

  return snapshot('healthy', 'none', input.state === 'invited' || input.state === 'waking'
    ? `The worker is in the ${input.state} lifecycle state.`
    : 'No contradictory or expired evidence is present.');
}
