/**
 * Worker ownership facade.
 *
 * The original broker remains intact in agents-prime.ts and continues to own every
 * ChatGPT-Prime family. This file adds the second ownership mode proposed in #82:
 * external workers have no Prime conversation at all, but reuse the same browser command
 * transport. Callers that are not provably external are delegated unchanged.
 */

export * from './agents-prime.js';

import type { AgentInfo, AgentState, SwarmState } from '../shared/session.js';
import * as prime from './agents-prime.js';
import {
  bindExternalWorkerConversation,
  externalRevivalFor,
  externalRunActive,
  externalWorkerByRun,
  failExternalWorkerBootstrap,
  markExternalRevivalAmbiguous,
  noteExternalWorkerRevived,
  onExternalReviveRequest,
  onExternalSpawnRequest,
  pendingExternalWorkerRevivals,
  pendingExternalWorkerSpawns,
  persistCriticalExternalControllerNow,
  snapshotExternalController,
  type ExternalWorkerStatus
} from './external-controller.js';

function externalByConversation(conversationId: string | null | undefined): ExternalWorkerStatus | null {
  if (!conversationId) return null;
  return snapshotExternalController().workers.find((worker) => worker.conversationId === conversationId) ?? null;
}

function externalState(worker: ExternalWorkerStatus): AgentState {
  if (worker.state === 'creating') return 'invited';
  if (worker.state === 'failed') return 'failed';
  if (pendingExternalWorkerRevivals().some((revival) => revival.runId === worker.runId)) return 'waking';
  if (worker.state === 'sleeping' || worker.state === 'ambiguous') return 'sleeping';
  return 'active';
}

function externalInfo(worker: ExternalWorkerStatus): AgentInfo {
  const state = externalState(worker);
  return {
    runId: worker.runId,
    // Deliberately no primeConversationId: external ownership never manufactures one.
    id: worker.providerWorkerId,
    role: 'worker',
    label: worker.workerKey,
    task: worker.task,
    reasoningEffort: worker.reasoningEffort,
    model: worker.model,
    state,
    createdAt: worker.createdAt,
    activatedAt: worker.conversationId ? worker.updatedAt : null,
    finishedAt: state === 'failed' ? worker.updatedAt : null,
    result: null,
    pending: pendingExternalWorkerRevivals().filter((revival) => revival.runId === worker.runId).length,
    awaitingAck: 0,
    delivered: 0,
    conversationId: worker.conversationId,
    detachedAt: null,
    lastSeenAt: worker.updatedAt,
    revivable: state !== 'failed' && worker.conversationId !== null,
    sleptAt: state === 'sleeping' ? worker.updatedAt : null,
    contextTokens: 0
  };
}

function externalBootstrapTask(task: string): string {
  return (
    'External controller mode: this worker is owned by a trusted local controller, not by a ChatGPT Prime. ' +
    'Do not manufacture or infer a Prime conversation. Execute the task below with the normal local Core tools. ' +
    'A generic legacy worker parenthetical may follow this task in the browser bootstrap; its instructions to report to "prime" do not apply to this externally-owned worker. ' +
    'Finish the ChatGPT turn normally so the recorder can preserve the result.\n\n' +
    task
  );
}

export function swarmRunning(runId?: string): boolean {
  if (runId && externalRunActive(runId)) return true;
  return prime.swarmRunning(runId);
}

export function onSpawnRequest(handler: (workers: prime.WorkerSpawn[]) => void): () => void {
  const dropPrime = prime.onSpawnRequest(handler);
  const dropExternal = onExternalSpawnRequest((worker) => {
    handler([{
      runId: worker.runId,
      // Compatibility projection only. No Prime conversation is stored as authority.
      primeConversationId: undefined as unknown as string,
      id: worker.id,
      task: externalBootstrapTask(worker.task),
      model: worker.model,
      reasoningEffort: worker.reasoningEffort
    }]);
  });
  return () => {
    dropPrime();
    dropExternal();
  };
}

export function pendingWorkerSpawns(): prime.WorkerSpawn[] {
  const external: prime.WorkerSpawn[] = pendingExternalWorkerSpawns().map((worker) => ({
    runId: worker.runId,
    primeConversationId: undefined as unknown as string,
    id: worker.id,
    task: externalBootstrapTask(worker.task),
    model: worker.model,
    reasoningEffort: worker.reasoningEffort
  }));
  return [...prime.pendingWorkerSpawns(), ...external];
}

export function onReviveRequest(handler: (revivals: prime.WorkerRevival[]) => void): () => void {
  const dropPrime = prime.onReviveRequest(handler);
  const dropExternal = onExternalReviveRequest((revival) => {
    handler([{
      primeConversationId: undefined as unknown as string,
      id: revival.id,
      conversationId: revival.conversationId,
      runId: revival.runId,
      text: revival.text,
      messageIds: [revival.operationId]
    }]);
  });
  return () => {
    dropPrime();
    dropExternal();
  };
}

export function pendingWorkerRevivals(): prime.WorkerRevival[] {
  const external: prime.WorkerRevival[] = pendingExternalWorkerRevivals().map((revival) => ({
    primeConversationId: undefined as unknown as string,
    id: revival.id,
    conversationId: revival.conversationId,
    runId: revival.runId,
    text: revival.text,
    messageIds: [revival.operationId]
  }));
  return [...prime.pendingWorkerRevivals(), ...external];
}

export function bindConversation(id: string, conversationId: string, runId?: string): boolean {
  if (runId && externalRunActive(runId)) {
    const worker = externalWorkerByRun(runId);
    return !!worker && worker.providerWorkerId === id && bindExternalWorkerConversation(runId, conversationId);
  }
  return prime.bindConversation(id, conversationId, runId);
}

export function agentConversation(id: string, runId?: string): string | null {
  if (runId && externalRunActive(runId)) {
    const worker = externalWorkerByRun(runId);
    return worker?.providerWorkerId === id ? worker.conversationId : null;
  }
  return prime.agentConversation(id, runId);
}

export function agentForConversation(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  return externalByConversation(conversationId)?.providerWorkerId ?? prime.agentForConversation(conversationId);
}

export function isWorkerConversation(conversationId: string | null | undefined): boolean {
  if (!conversationId) return false;
  return externalByConversation(conversationId) !== null || prime.isWorkerConversation(conversationId);
}

export function agentInfoForOwnedConversation(conversationId: string | null | undefined): AgentInfo | null {
  if (!conversationId) return null;
  const external = externalByConversation(conversationId);
  return external ? externalInfo(external) : prime.agentInfoForOwnedConversation(conversationId);
}

export function agentForOwnedConversation(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  return externalByConversation(conversationId)?.providerWorkerId ?? prime.agentForOwnedConversation(conversationId);
}

export function primeForOwnedConversation(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  // External workers deliberately have no Prime conversation.
  if (externalByConversation(conversationId)) return null;
  return prime.primeForOwnedConversation(conversationId);
}

export function primeConversation(runId?: string): string | null {
  if (runId && externalRunActive(runId)) return null;
  return prime.primeConversation(runId);
}

export function failAgent(
  id: string,
  reason: string,
  note?: string,
  options: { revivable?: boolean } = {},
  runId?: string
): ReturnType<typeof prime.failAgent> {
  if (runId && externalRunActive(runId)) {
    const worker = externalWorkerByRun(runId);
    if (worker?.providerWorkerId === id) failExternalWorkerBootstrap(runId, reason);
    return null;
  }
  return prime.failAgent(id, reason, note, options, runId);
}

export function claimWorkerRevival(id: string, conversationId: string, runId?: string): boolean {
  if (runId && externalRunActive(runId)) {
    const revival = externalRevivalFor(id, runId);
    return !!revival && revival.conversationId === conversationId;
  }
  return prime.claimWorkerRevival(id, conversationId, runId);
}

export function rollbackWorkerRevivalClaim(id: string, conversationId: string, runId?: string): boolean {
  if (runId && externalRunActive(runId)) {
    const revival = externalRevivalFor(id, runId);
    return !!revival && revival.conversationId === conversationId;
  }
  return prime.rollbackWorkerRevivalClaim(id, conversationId, runId);
}

export function noteWorkerRevived(
  id: string,
  conversationId: string,
  messageIds: readonly string[],
  commandId: string | null = null,
  runId?: string
): boolean {
  if (runId && externalRunActive(runId)) {
    const worker = externalWorkerByRun(runId);
    if (!worker || worker.providerWorkerId !== id || worker.conversationId !== conversationId) return false;
    const operationId = messageIds[0];
    return typeof operationId === 'string' && noteExternalWorkerRevived(runId, operationId);
  }
  return prime.noteWorkerRevived(id, conversationId, messageIds, commandId, runId);
}

export function workerRevivalDeliveredSince(
  id: string,
  conversationId: string,
  commandId: string,
  claimedAt: number,
  runId?: string
): boolean {
  if (runId && externalRunActive(runId)) {
    const worker = externalWorkerByRun(runId);
    if (!worker || worker.providerWorkerId !== id || worker.conversationId !== conversationId) return false;
    return snapshotExternalController().deliveries.some(
      (delivery) => delivery.workerKey === worker.workerKey && delivery.controllerId === worker.controllerId &&
        delivery.state === 'active' && delivery.acceptedAt >= claimedAt
    );
  }
  return prime.workerRevivalDeliveredSince(id, conversationId, commandId, claimedAt, runId);
}

export function failWorkerRevival(
  id: string,
  reason: string,
  runId?: string
): ReturnType<typeof prime.failWorkerRevival> {
  if (runId && externalRunActive(runId)) {
    const revival = externalRevivalFor(id, runId);
    if (revival) markExternalRevivalAmbiguous(runId, revival.operationId, reason);
    return null;
  }
  return prime.failWorkerRevival(id, reason, runId);
}

export function swarmState(runId?: string): SwarmState {
  if (runId && externalRunActive(runId)) {
    const worker = externalWorkerByRun(runId);
    return {
      enabled: true,
      running: !!worker && externalState(worker) !== 'sleeping' && externalState(worker) !== 'failed',
      agents: worker ? [externalInfo(worker)] : []
    };
  }
  return prime.swarmState(runId);
}

export async function persistCriticalSwarmNow(): Promise<boolean> {
  const [primeDurable, externalDurable] = await Promise.all([
    prime.persistCriticalSwarmNow(),
    persistCriticalExternalControllerNow()
  ]);
  // Startup wires both sinks. Focused tests may intentionally wire just one side.
  return primeDurable || externalDurable;
}

export function noteAgentAlive(
  conversationId: string | null | undefined,
  source: 'call' | 'page' | 'turn' = 'call',
  at = Date.now()
): ReturnType<typeof prime.noteAgentAlive> {
  const external = externalByConversation(conversationId);
  if (external) {
    const revival = pendingExternalWorkerRevivals().find((item) => item.runId === external.runId);
    if (revival) noteExternalWorkerRevived(external.runId, revival.operationId);
    return null;
  }
  return prime.noteAgentAlive(conversationId, source, at);
}
