import { createHash, randomUUID } from 'node:crypto';
import type { ReasoningEffort } from '../shared/session.js';

export type ExternalWorkerState = 'creating' | 'active' | 'sleeping' | 'failed' | 'ambiguous';
export type ExternalDeliveryState = 'pending' | 'active' | 'completed' | 'failed' | 'ambiguous';

export interface ExternalWorkerStatus {
  controllerId: string;
  workerKey: string;
  providerWorkerId: string;
  runId: string;
  conversationId: string | null;
  state: ExternalWorkerState;
  contextGeneration: number;
  task: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}

export interface ExternalDeliveryStatus {
  controllerId: string;
  workerKey: string;
  operationId: string;
  state: ExternalDeliveryState;
  acceptedAt: number;
  updatedAt: number;
  error: string | null;
}

interface ExternalWorkerRecord extends ExternalWorkerStatus {
  pendingSpawn: boolean;
}

interface ExternalDeliveryRecord extends ExternalDeliveryStatus {
  text: string;
  runId: string;
}

interface OperationRecord {
  controllerId: string;
  operationId: string;
  kind: 'ensure' | 'send';
  fingerprint: string;
  workerKey: string;
}

export interface ExternalControllerSnapshot {
  version: 1;
  workers: ExternalWorkerRecord[];
  deliveries: ExternalDeliveryRecord[];
  operations: OperationRecord[];
}

export interface ExternalWorkerSpawn {
  runId: string;
  id: string;
  task: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}

export interface ExternalWorkerRevival {
  runId: string;
  id: string;
  conversationId: string;
  operationId: string;
  text: string;
}

export interface EnsureExternalWorkerInput {
  controllerId: string;
  workerKey: string;
  operationId: string;
  task: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}

export interface SendExternalWorkerMessageInput {
  controllerId: string;
  workerKey: string;
  operationId: string;
  text: string;
}

const workers = new Map<string, ExternalWorkerRecord>();
const runIndex = new Map<string, string>();
const deliveries = new Map<string, ExternalDeliveryRecord>();
const operations = new Map<string, OperationRecord>();
const spawnListeners = new Set<(worker: ExternalWorkerSpawn) => void>();
const reviveListeners = new Set<(revival: ExternalWorkerRevival) => void>();
let persist: (() => void) | null = null;
let persistNow: ((snapshot: ExternalControllerSnapshot) => Promise<void>) | null = null;
let revision = 0;
let persistedRevision = 0;
let persistFlight: Promise<boolean> | null = null;

const MAX_ID = 128;
const MAX_TASK = 16_000;
const MAX_TEXT = 16_000;

function cleanId(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    throw new Error(`${name} must be 1-${MAX_ID} characters using letters, digits, dot, underscore, colon or hyphen`);
  }
  return trimmed;
}

function cleanText(name: string, value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  if (trimmed.length > max) throw new Error(`${name} is too long (limit ${max} characters)`);
  return trimmed;
}

function workerMapKey(controllerId: string, workerKey: string): string {
  return `${controllerId.length}:${controllerId}${workerKey}`;
}

function operationMapKey(controllerId: string, operationId: string): string {
  return `${controllerId.length}:${controllerId}${operationId}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicWorker(worker: ExternalWorkerRecord): ExternalWorkerStatus {
  const { pendingSpawn: _pendingSpawn, ...status } = worker;
  return { ...status };
}

function publicDelivery(delivery: ExternalDeliveryRecord): ExternalDeliveryStatus {
  const { text: _text, runId: _runId, ...status } = delivery;
  return { ...status };
}

function changed(): void {
  revision += 1;
  persist?.();
}

function operationReplay(
  controllerId: string,
  operationId: string,
  kind: OperationRecord['kind'],
  requestFingerprint: string
): OperationRecord | null {
  const existing = operations.get(operationMapKey(controllerId, operationId));
  if (!existing) return null;
  if (existing.kind !== kind || existing.fingerprint !== requestFingerprint) {
    throw new Error(`operationId ${operationId} was already used with a different request`);
  }
  return existing;
}

function rememberOperation(record: OperationRecord): void {
  operations.set(operationMapKey(record.controllerId, record.operationId), record);
}

export function onExternalControllerPersist(handler: (() => void) | null): void {
  persist = handler;
}

export function onExternalControllerPersistNow(
  handler: ((snapshot: ExternalControllerSnapshot) => Promise<void>) | null
): void {
  persistNow = handler;
}

export async function persistCriticalExternalControllerNow(): Promise<boolean> {
  if (!persistNow) return false;
  if (persistedRevision >= revision) return true;
  if (!persistFlight) {
    persistFlight = (async () => {
      while (persistedRevision < revision) {
        const writer = persistNow;
        if (!writer) return false;
        const target = revision;
        await writer(snapshotExternalController());
        persistedRevision = Math.max(persistedRevision, target);
      }
      return true;
    })().finally(() => {
      persistFlight = null;
    });
  }
  return persistFlight;
}

export function onExternalSpawnRequest(listener: (worker: ExternalWorkerSpawn) => void): () => void {
  spawnListeners.add(listener);
  for (const worker of pendingExternalWorkerSpawns()) listener(worker);
  return () => spawnListeners.delete(listener);
}

export function onExternalReviveRequest(listener: (revival: ExternalWorkerRevival) => void): () => void {
  reviveListeners.add(listener);
  for (const revival of pendingExternalWorkerRevivals()) listener(revival);
  return () => reviveListeners.delete(listener);
}

export function ensureExternalWorker(input: EnsureExternalWorkerInput): ExternalWorkerStatus {
  const controllerId = cleanId('controllerId', input.controllerId);
  const workerKey = cleanId('workerKey', input.workerKey);
  const operationId = cleanId('operationId', input.operationId);
  const task = cleanText('task', input.task, MAX_TASK);
  const model = input.model?.trim() || null;
  const reasoningEffort = input.reasoningEffort ?? null;
  const requestFingerprint = fingerprint({ workerKey, task, model, reasoningEffort });
  const replay = operationReplay(controllerId, operationId, 'ensure', requestFingerprint);
  if (replay) {
    const worker = workers.get(workerMapKey(controllerId, replay.workerKey));
    if (!worker) throw new Error('idempotent ensure references worker state that is unavailable');
    return publicWorker(worker);
  }

  const key = workerMapKey(controllerId, workerKey);
  const existing = workers.get(key);
  if (existing) {
    rememberOperation({ controllerId, operationId, kind: 'ensure', fingerprint: requestFingerprint, workerKey });
    changed();
    return publicWorker(existing);
  }

  const now = Date.now();
  const worker: ExternalWorkerRecord = {
    controllerId,
    workerKey,
    providerWorkerId: randomUUID(),
    runId: randomUUID(),
    conversationId: null,
    state: 'creating',
    contextGeneration: 1,
    task,
    model,
    reasoningEffort,
    createdAt: now,
    updatedAt: now,
    error: null,
    pendingSpawn: true
  };
  workers.set(key, worker);
  runIndex.set(worker.runId, key);
  rememberOperation({ controllerId, operationId, kind: 'ensure', fingerprint: requestFingerprint, workerKey });
  changed();
  const spawn: ExternalWorkerSpawn = {
    runId: worker.runId,
    id: worker.providerWorkerId,
    task: worker.task,
    model: worker.model,
    reasoningEffort: worker.reasoningEffort
  };
  for (const listener of spawnListeners) listener(spawn);
  return publicWorker(worker);
}

export function inspectExternalWorker(input: { controllerId: string; workerKey: string }): ExternalWorkerStatus | null {
  const controllerId = cleanId('controllerId', input.controllerId);
  const workerKey = cleanId('workerKey', input.workerKey);
  const worker = workers.get(workerMapKey(controllerId, workerKey));
  return worker ? publicWorker(worker) : null;
}

export function externalWorkerByRun(runId: string): ExternalWorkerStatus | null {
  const key = runIndex.get(runId);
  const worker = key ? workers.get(key) : null;
  return worker ? publicWorker(worker) : null;
}

export function externalRunActive(runId: string): boolean {
  const worker = externalWorkerRecordByRun(runId);
  return !!worker && worker.state !== 'failed';
}

function externalWorkerRecordByRun(runId: string): ExternalWorkerRecord | null {
  const key = runIndex.get(runId);
  return key ? workers.get(key) ?? null : null;
}

export function bindExternalWorkerConversation(runId: string, conversationId: string): boolean {
  const worker = externalWorkerRecordByRun(runId);
  const conversation = conversationId.trim();
  if (!worker || !conversation) return false;
  if (worker.conversationId && worker.conversationId !== conversation) return false;
  worker.conversationId = conversation;
  worker.pendingSpawn = false;
  worker.state = 'active';
  worker.updatedAt = Date.now();
  worker.error = null;
  changed();
  return true;
}

export function pendingExternalWorkerSpawns(): ExternalWorkerSpawn[] {
  return [...workers.values()]
    .filter((worker) => worker.pendingSpawn && worker.state === 'creating')
    .map((worker) => ({
      runId: worker.runId,
      id: worker.providerWorkerId,
      task: worker.task,
      model: worker.model,
      reasoningEffort: worker.reasoningEffort
    }));
}

export function sendExternalWorkerMessage(input: SendExternalWorkerMessageInput): ExternalDeliveryStatus {
  const controllerId = cleanId('controllerId', input.controllerId);
  const workerKey = cleanId('workerKey', input.workerKey);
  const operationId = cleanId('operationId', input.operationId);
  const text = cleanText('text', input.text, MAX_TEXT);
  const requestFingerprint = fingerprint({ workerKey, text });
  const replay = operationReplay(controllerId, operationId, 'send', requestFingerprint);
  if (replay) {
    const delivery = deliveries.get(operationMapKey(controllerId, operationId));
    if (!delivery) throw new Error('idempotent send references delivery state that is unavailable');
    return publicDelivery(delivery);
  }

  const worker = workers.get(workerMapKey(controllerId, workerKey));
  if (!worker) throw new Error(`worker ${workerKey} does not exist for controller ${controllerId}`);
  if (!worker.conversationId || worker.state === 'creating') throw new Error(`worker ${workerKey} is not bound to a ChatGPT conversation yet`);
  if (worker.state === 'failed') throw new Error(`worker ${workerKey} has failed and cannot accept new work`);

  const now = Date.now();
  const delivery: ExternalDeliveryRecord = {
    controllerId,
    workerKey,
    operationId,
    state: 'pending',
    acceptedAt: now,
    updatedAt: now,
    error: null,
    text,
    runId: worker.runId
  };
  deliveries.set(operationMapKey(controllerId, operationId), delivery);
  rememberOperation({ controllerId, operationId, kind: 'send', fingerprint: requestFingerprint, workerKey });
  worker.state = 'sleeping';
  worker.updatedAt = now;
  changed();
  const revival: ExternalWorkerRevival = {
    runId: worker.runId,
    id: worker.providerWorkerId,
    conversationId: worker.conversationId,
    operationId,
    text
  };
  for (const listener of reviveListeners) listener(revival);
  return publicDelivery(delivery);
}

export function inspectExternalDelivery(input: { controllerId: string; operationId: string }): ExternalDeliveryStatus | null {
  const controllerId = cleanId('controllerId', input.controllerId);
  const operationId = cleanId('operationId', input.operationId);
  const delivery = deliveries.get(operationMapKey(controllerId, operationId));
  return delivery ? publicDelivery(delivery) : null;
}

export function pendingExternalWorkerRevivals(): ExternalWorkerRevival[] {
  const result: ExternalWorkerRevival[] = [];
  for (const delivery of deliveries.values()) {
    if (delivery.state !== 'pending') continue;
    const worker = externalWorkerRecordByRun(delivery.runId);
    if (!worker?.conversationId) continue;
    result.push({
      runId: delivery.runId,
      id: worker.providerWorkerId,
      conversationId: worker.conversationId,
      operationId: delivery.operationId,
      text: delivery.text
    });
  }
  return result;
}

export function externalRevivalFor(id: string, runId: string): ExternalWorkerRevival | null {
  return pendingExternalWorkerRevivals().find((revival) => revival.id === id && revival.runId === runId) ?? null;
}

export function noteExternalWorkerRevived(runId: string, operationId: string): boolean {
  const worker = externalWorkerRecordByRun(runId);
  if (!worker) return false;
  const delivery = deliveries.get(operationMapKey(worker.controllerId, operationId));
  if (!delivery || delivery.runId !== runId || delivery.state !== 'pending') return false;
  const now = Date.now();
  delivery.state = 'active';
  delivery.updatedAt = now;
  worker.state = 'active';
  worker.updatedAt = now;
  worker.error = null;
  changed();
  return true;
}

export function failExternalWorkerBootstrap(runId: string, reason: string): boolean {
  const worker = externalWorkerRecordByRun(runId);
  if (!worker || !worker.pendingSpawn) return false;
  worker.pendingSpawn = false;
  worker.state = 'failed';
  worker.error = reason.slice(0, 500);
  worker.updatedAt = Date.now();
  changed();
  return true;
}

export function markExternalRevivalAmbiguous(runId: string, operationId: string, reason: string): boolean {
  const worker = externalWorkerRecordByRun(runId);
  if (!worker) return false;
  const delivery = deliveries.get(operationMapKey(worker.controllerId, operationId));
  if (!delivery || delivery.runId !== runId || (delivery.state !== 'pending' && delivery.state !== 'active')) return false;
  const now = Date.now();
  delivery.state = 'ambiguous';
  delivery.error = reason.slice(0, 500);
  delivery.updatedAt = now;
  worker.state = 'ambiguous';
  worker.error = delivery.error;
  worker.updatedAt = now;
  changed();
  return true;
}

export function snapshotExternalController(): ExternalControllerSnapshot {
  return {
    version: 1,
    workers: [...workers.values()].map((worker) => ({ ...worker })),
    deliveries: [...deliveries.values()].map((delivery) => ({ ...delivery })),
    operations: [...operations.values()].map((operation) => ({ ...operation }))
  };
}

export function restoreExternalController(saved: ExternalControllerSnapshot | null | undefined): void {
  workers.clear();
  runIndex.clear();
  deliveries.clear();
  operations.clear();
  if (!saved || saved.version !== 1 || !Array.isArray(saved.workers) || !Array.isArray(saved.deliveries) || !Array.isArray(saved.operations)) {
    revision = 0;
    persistedRevision = 0;
    return;
  }
  for (const raw of saved.workers) {
    if (!raw || typeof raw !== 'object') continue;
    try {
      const controllerId = cleanId('controllerId', raw.controllerId);
      const workerKey = cleanId('workerKey', raw.workerKey);
      if (typeof raw.providerWorkerId !== 'string' || typeof raw.runId !== 'string') continue;
      if (!['creating', 'active', 'sleeping', 'failed', 'ambiguous'].includes(raw.state)) continue;
      const record: ExternalWorkerRecord = { ...raw, controllerId, workerKey };
      const key = workerMapKey(controllerId, workerKey);
      workers.set(key, record);
      runIndex.set(record.runId, key);
    } catch {
      continue;
    }
  }
  for (const raw of saved.deliveries) {
    if (!raw || typeof raw !== 'object') continue;
    try {
      const controllerId = cleanId('controllerId', raw.controllerId);
      const operationId = cleanId('operationId', raw.operationId);
      if (!runIndex.has(raw.runId)) continue;
      if (!['pending', 'active', 'completed', 'failed', 'ambiguous'].includes(raw.state)) continue;
      deliveries.set(operationMapKey(controllerId, operationId), { ...raw, controllerId, operationId });
    } catch {
      continue;
    }
  }
  for (const raw of saved.operations) {
    if (!raw || typeof raw !== 'object') continue;
    try {
      const controllerId = cleanId('controllerId', raw.controllerId);
      const operationId = cleanId('operationId', raw.operationId);
      if (raw.kind !== 'ensure' && raw.kind !== 'send') continue;
      if (typeof raw.fingerprint !== 'string' || typeof raw.workerKey !== 'string') continue;
      operations.set(operationMapKey(controllerId, operationId), { ...raw, controllerId, operationId });
    } catch {
      continue;
    }
  }
  revision = 0;
  persistedRevision = 0;
}

export function resetExternalControllerForTests(): void {
  workers.clear();
  runIndex.clear();
  deliveries.clear();
  operations.clear();
  spawnListeners.clear();
  reviveListeners.clear();
  persist = null;
  persistNow = null;
  revision = 0;
  persistedRevision = 0;
  persistFlight = null;
}
