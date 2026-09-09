import { beforeEach, describe, expect, it } from 'vitest';

const controller = await import('../src/main/external-controller.js');

const {
  bindExternalWorkerConversation,
  ensureExternalWorker,
  externalWorkerByRun,
  inspectExternalDelivery,
  inspectExternalWorker,
  onExternalReviveRequest,
  onExternalSpawnRequest,
  publishExternalController,
  resetExternalControllerForTests,
  restoreExternalController,
  sendExternalWorkerMessage,
  snapshotExternalController
} = controller;

beforeEach(() => {
  resetExternalControllerForTests();
});

describe('external worker controller', () => {
  it('stages one stable worker and publishes only after the durability boundary', () => {
    const spawns: unknown[] = [];
    onExternalSpawnRequest((worker) => spawns.push(worker));

    const first = ensureExternalWorker({
      controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'Implement the frontend change.'
    });
    const replay = ensureExternalWorker({
      controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'Implement the frontend change.'
    });

    expect(replay).toEqual(first);
    expect(spawns).toHaveLength(0);
    publishExternalController();
    expect(spawns).toHaveLength(1);
    expect(first.workerKey).toBe('frontend');
    expect(first.providerWorkerId).toBeTruthy();
    expect(first.state).toBe('creating');
  });

  it('refuses reuse of an operation id with a different payload', () => {
    ensureExternalWorker({ controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'First task' });
    expect(() => ensureExternalWorker({
      controllerId: 'codex', workerKey: 'backend', operationId: 'ensure-1', task: 'Different task'
    })).toThrow(/operation.*different/i);
  });

  it('isolates identical worker keys belonging to different controllers', () => {
    const a = ensureExternalWorker({ controllerId: 'codex', workerKey: 'worker', operationId: 'a-1', task: 'A' });
    const b = ensureExternalWorker({ controllerId: 'omp', workerKey: 'worker', operationId: 'b-1', task: 'B' });
    expect(a.providerWorkerId).not.toBe(b.providerWorkerId);
    expect(inspectExternalWorker({ controllerId: 'codex', workerKey: 'worker' })?.providerWorkerId).toBe(a.providerWorkerId);
    expect(inspectExternalWorker({ controllerId: 'omp', workerKey: 'worker' })?.providerWorkerId).toBe(b.providerWorkerId);
  });

  it('binds provider conversation state without exposing it as controller authority', () => {
    const worker = ensureExternalWorker({ controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'A' });
    expect(bindExternalWorkerConversation(worker.runId, 'chat-provider-123')).toBe(true);
    const status = inspectExternalWorker({ controllerId: 'codex', workerKey: 'frontend' });
    expect(status?.state).toBe('active');
    expect(status?.conversationId).toBe('chat-provider-123');
    expect(externalWorkerByRun(worker.runId)?.controllerId).toBe('codex');
  });

  it('stages an idempotent follow-up and publishes the same persistent-worker revival once', () => {
    const worker = ensureExternalWorker({ controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'A' });
    bindExternalWorkerConversation(worker.runId, 'chat-provider-123');
    const revivals: unknown[] = [];
    onExternalReviveRequest((revival) => revivals.push(revival));
    const first = sendExternalWorkerMessage({
      controllerId: 'codex', workerKey: 'frontend', operationId: 'msg-1', text: 'Fix the review finding.'
    });
    const replay = sendExternalWorkerMessage({
      controllerId: 'codex', workerKey: 'frontend', operationId: 'msg-1', text: 'Fix the review finding.'
    });
    expect(replay).toEqual(first);
    expect(revivals).toHaveLength(0);
    publishExternalController();
    expect(revivals).toHaveLength(1);
    expect(first.state).toBe('pending');
    expect(inspectExternalDelivery({ controllerId: 'codex', operationId: 'msg-1' })).toEqual(first);
  });

  it('preserves worker and operation identity across restart restore', () => {
    const worker = ensureExternalWorker({ controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'A' });
    bindExternalWorkerConversation(worker.runId, 'chat-provider-123');
    sendExternalWorkerMessage({ controllerId: 'codex', workerKey: 'frontend', operationId: 'msg-1', text: 'Continue.' });
    const saved = snapshotExternalController();
    resetExternalControllerForTests();
    restoreExternalController(saved);
    const restored = inspectExternalWorker({ controllerId: 'codex', workerKey: 'frontend' });
    expect(restored?.providerWorkerId).toBe(worker.providerWorkerId);
    expect(restored?.conversationId).toBe('chat-provider-123');
    const replay = sendExternalWorkerMessage({ controllerId: 'codex', workerKey: 'frontend', operationId: 'msg-1', text: 'Continue.' });
    expect(replay.operationId).toBe('msg-1');
  });
});
