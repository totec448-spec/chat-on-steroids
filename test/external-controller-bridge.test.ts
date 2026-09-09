import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const {
  bindExternalWorkerConversation,
  ensureExternalWorker,
  resetExternalControllerForTests,
  sendExternalWorkerMessage
} = await import('../src/main/external-controller.js');
const { queueWorkerBootstrap, queueWorkerRevival, resetBridgeForTests } = await import('../src/main/bridge.js');

beforeEach(() => {
  resetExternalControllerForTests();
  resetBridgeForTests();
});

describe('external worker bridge reuse', () => {
  it('creates the normal worker bootstrap command for an external-owned run', () => {
    const worker = ensureExternalWorker({
      controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'Implement A'
    });

    const command = queueWorkerBootstrap(
      worker.providerWorkerId,
      worker.task,
      worker.model,
      worker.reasoningEffort,
      worker.runId
    );

    expect(command).not.toBeNull();
    expect(command?.type).toBe('worker');
    expect(command?.agent).toBe(worker.providerWorkerId);
  });

  it('creates a safe existing-conversation revival command for an external message', () => {
    const worker = ensureExternalWorker({
      controllerId: 'codex', workerKey: 'frontend', operationId: 'ensure-1', task: 'Implement A'
    });
    bindExternalWorkerConversation(worker.runId, 'chat-provider-123');
    sendExternalWorkerMessage({
      controllerId: 'codex', workerKey: 'frontend', operationId: 'msg-1', text: 'Apply review fix'
    });

    const command = queueWorkerRevival(
      worker.providerWorkerId,
      'chat-provider-123',
      ['msg-1'],
      worker.runId
    );

    expect(command).not.toBeNull();
    expect(command?.type).toBe('revive');
    expect(command?.conversationId).toBe('chat-provider-123');
  });
});
