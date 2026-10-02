import type { AgentInfo } from '../shared/session.js';
import { agentInfoForOwnedConversation } from './agents.js';
import { unifiedExecManager } from './codex/manager.js';
import {
  backgroundExecObligations,
  execOwner,
  forgetExecOwner,
  noteExecOwner
} from './codex/ownership.js';
import type { BackgroundExecState, BackgroundTerminalInfo } from './codex/unified-exec.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { runningToolCalls } from './mcp/call-context.js';
import { recordNote } from './session/recorder.js';
import { getSession } from './session/store.js';

/** Resource retention policy; this is never a worker-liveness deadline. */
export const AGENT_RUNTIME_RETENTION_MS = 30 * 60_000;
/** Coarse maintenance only: no per-worker timer and no high-frequency watchdog. */
export const AGENT_RUNTIME_GC_INTERVAL_MS = 10 * 60_000;

interface SessionIdentity {
  id: string;
  conversationId: string | null;
}

interface WorkerProof {
  runId: string;
  primeConversationId: string;
  agentId: string;
  conversationId: string;
  sleptAt: number;
}

export interface AgentRuntimeGcDependencies {
  enabled(): boolean;
  listProcesses(): BackgroundTerminalInfo[];
  execOwner(processId: number): string | null;
  getSession(sessionId: string): Promise<SessionIdentity | null>;
  agentInfo(conversationId: string): AgentInfo | null;
  runningToolCalls(conversationId: string): number;
  backgroundState(sessionId: string): BackgroundExecState;
  forgetExecOwner(processId: number): void;
  noteExecOwner(processId: number | null, sessionId: string | null): void;
  terminateProcess(processId: number): Promise<boolean>;
  recordNote(sessionId: string, text: string): Promise<void>;
  logInfo(message: string): void;
}

export interface AgentRuntimeGcSummary {
  checked: number;
  eligible: number;
  terminated: number;
  unowned: number;
  ineligible: number;
  busy: number;
  changed: number;
  completed: number;
  missing: number;
  failed: number;
}

const defaultDependencies: AgentRuntimeGcDependencies = {
  enabled: () => getConfig().multiAgent.endSleepingWorkerProcesses === true,
  listProcesses: () => unifiedExecManager.listProcesses(),
  execOwner,
  getSession,
  agentInfo: agentInfoForOwnedConversation,
  runningToolCalls,
  backgroundState: backgroundExecObligations,
  forgetExecOwner,
  noteExecOwner,
  terminateProcess: (processId) => unifiedExecManager.terminateProcess(processId),
  recordNote,
  logInfo
};

let timer: NodeJS.Timeout | null = null;
let sweepInFlight: Promise<void> | null = null;

function emptySummary(): AgentRuntimeGcSummary {
  return {
    checked: 0,
    eligible: 0,
    terminated: 0,
    unowned: 0,
    ineligible: 0,
    busy: 0,
    changed: 0,
    completed: 0,
    missing: 0,
    failed: 0
  };
}

function workerProof(info: AgentInfo | null, conversationId: string, cutoff: number): WorkerProof | null {
  if (
    !info ||
    info.role !== 'worker' ||
    info.state !== 'sleeping' ||
    !info.revivable ||
    info.conversationId !== conversationId ||
    !info.runId ||
    !info.primeConversationId ||
    info.sleptAt === null ||
    !Number.isFinite(info.sleptAt) ||
    info.sleptAt > cutoff
  ) {
    return null;
  }
  return {
    runId: info.runId,
    primeConversationId: info.primeConversationId,
    agentId: info.id,
    conversationId,
    sleptAt: info.sleptAt
  };
}

function sameProof(left: WorkerProof | null, right: WorkerProof): boolean {
  return Boolean(
    left &&
    left.runId === right.runId &&
    left.primeConversationId === right.primeConversationId &&
    left.agentId === right.agentId &&
    left.conversationId === right.conversationId &&
    left.sleptAt === right.sleptAt
  );
}

function processLive(dependencies: AgentRuntimeGcDependencies, processId: number): boolean {
  return dependencies.listProcesses().some((process) => process.processId === processId);
}

function restoreClaimIfNeeded(
  dependencies: AgentRuntimeGcDependencies,
  processId: number,
  sessionId: string
): void {
  if (dependencies.execOwner(processId) !== null || !processLive(dependencies, processId)) return;
  dependencies.noteExecOwner(processId, sessionId);
}

/**
 * Releases live exec processes only when their exact durable session still belongs to the
 * same long-sleeping, revivable worker.
 *
 * Discovery is not authority. After every await, the sweep re-reads durable session attachment,
 * broker identity, current tool work, process state and process ownership. The destructive
 * boundary then synchronously removes the exact exec-ownership record before the first await;
 * a later write_stdin therefore cannot authorize against the runtime being reclaimed.
 */
export async function sweepAgentRuntimeGc(
  now = Date.now(),
  dependencies: AgentRuntimeGcDependencies = defaultDependencies
): Promise<AgentRuntimeGcSummary> {
  const cutoff = now - AGENT_RUNTIME_RETENTION_MS;
  const summary = emptySummary();
  if (!dependencies.enabled()) return summary;

  for (const runtime of dependencies.listProcesses()) {
    summary.checked += 1;
    const sessionId = dependencies.execOwner(runtime.processId);
    if (!sessionId) {
      summary.unowned += 1;
      continue;
    }

    const firstSession = await dependencies.getSession(sessionId);
    const conversationId = firstSession?.conversationId ?? null;
    if (!conversationId) {
      summary.ineligible += 1;
      continue;
    }
    const proof = workerProof(dependencies.agentInfo(conversationId), conversationId, cutoff);
    if (!proof) {
      summary.ineligible += 1;
      continue;
    }
    if (dependencies.runningToolCalls(conversationId) > 0) {
      summary.busy += 1;
      continue;
    }

    const currentSession = await dependencies.getSession(sessionId);
    if (!currentSession || currentSession.conversationId !== conversationId) {
      summary.changed += 1;
      continue;
    }
    if (!sameProof(workerProof(dependencies.agentInfo(conversationId), conversationId, cutoff), proof)) {
      summary.changed += 1;
      continue;
    }
    if (dependencies.runningToolCalls(conversationId) > 0) {
      summary.busy += 1;
      continue;
    }

    const currentState = dependencies.backgroundState(sessionId);
    if (currentState.exitedUnread.some((row) => row.processId === runtime.processId)) {
      summary.completed += 1;
      continue;
    }
    if (!currentState.running.includes(runtime.processId)) {
      summary.missing += 1;
      continue;
    }
    if (dependencies.execOwner(runtime.processId) !== sessionId) {
      summary.changed += 1;
      continue;
    }

    summary.eligible += 1;
    // Synchronous ownership removal is the destructive claim. A later write_stdin fails closed
    // before async process termination can yield.
    dependencies.forgetExecOwner(runtime.processId);
    try {
      if (!(await dependencies.terminateProcess(runtime.processId))) {
        restoreClaimIfNeeded(dependencies, runtime.processId, sessionId);
        summary.missing += 1;
        continue;
      }
    } catch {
      restoreClaimIfNeeded(dependencies, runtime.processId, sessionId);
      summary.failed += 1;
      continue;
    }
    summary.terminated += 1;
    const audit =
      `Worker ${proof.agentId}: ended background process ${runtime.processId} after more than 30 minutes asleep. ` +
      'The worker chat and history remain available.';
    dependencies.logInfo(`agent runtime GC: ${audit}`);
    await dependencies.recordNote(sessionId, audit).catch(() => undefined);
  }

  return summary;
}

function queueSweep(): void {
  if (sweepInFlight) return;
  sweepInFlight = sweepAgentRuntimeGc()
    .then(() => undefined)
    .catch((error: Error) => {
      logWarn(`agent runtime GC failed: ${error.message}`);
    })
    .finally(() => {
      sweepInFlight = null;
    });
}

/** Starts one process-owned coarse maintenance cadence after broker/session restore. */
export function startAgentRuntimeGc(): void {
  if (timer) return;
  timer = setInterval(queueSweep, AGENT_RUNTIME_GC_INTERVAL_MS);
  timer.unref?.();
}

/** Stops new sweeps and waits for an already-running sweep before process teardown. */
export function stopAgentRuntimeGc(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  return sweepInFlight ?? Promise.resolve();
}
