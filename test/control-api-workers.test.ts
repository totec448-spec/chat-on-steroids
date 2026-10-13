import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { faultGate } from './helpers.js';

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }) },
  BrowserWindow: class {}, clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined, openPath: async () => '' }, nativeTheme: { themeSource: 'system' }
}));

const config = await import('../src/main/config.js');
const api = await import('../src/main/control-api.js');
const broker = await import('../src/main/agents.js');
const durable = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const ownerId = '11111111-1111-4111-8111-111111111111';
let directory: string;

beforeAll(async () => {
  directory = await makeTempDir('cos-local-workers-');
  config.initConfigPath(directory);
  initSecretsPath(directory);
  durable.initDurableStore(directory);
  initSessionStore(directory);
  api.initControlApiPath(directory);
});

beforeEach(async () => {
  await api.stopControlApi();
  broker.resetAgentsForTests();
  const current = config.getConfig();
  await config.saveConfig({ ...current, controlApi: { enabled: true, allowActions: true },
    multiAgent: { ...current.multiAgent, enabled: true, allowUnattributedCalls: false, autoWorktrees: false } });
  broker.onSwarmPersistNow(snapshot => durable.writeDurableNow('swarm', snapshot));
  await api.startControlApi();
});

afterAll(async () => {
  await api.shutdownControlApi();
  broker.resetAgentsForTests();
  await durable.flushDurable();
  durable.resetDurableForTests();
  resetSessionStoreForTests();
  await removeTempDir(directory);
});

async function cli(command: string, request: unknown) {
  const file = path.join(directory, 'request.json');
  await fs.writeFile(file, JSON.stringify(request));
  return new Promise<{ code: number; body: any }>(resolve => {
    execFile(process.execPath, [path.resolve('scripts/t3-code-bridge.mjs'), command, '--data-dir', directory, '--request-file', file], { timeout: 10_000 }, (error, stdout) => {
      resolve({ code: error ? Number(error.code) || 1 : 0, body: JSON.parse(stdout.trim()) });
    });
  });
}

it('lets a local orchestrator spawn real broker workers without a ChatGPT prime or unattributed opt-in', async () => {
  const result = await cli('delegate', { ownerId, context: 'Read-only assignment.', workers: [{ label: 'Audit', task: 'Inspect and report.' }] });
  expect(result.code, JSON.stringify(result.body)).toBe(0);
  expect(result.body.workers).toMatchObject([{ id: 'worker-1', state: 'invited' }]);
  const status = await cli('agents', { ownerId, runId: result.body.runId });
  expect(status.body.workers).toMatchObject([{ id: 'worker-1', state: 'invited' }]);
  expect(status.body.freeWorkerSlots).toBe(config.getConfig().multiAgent.maxWorkers - 1);
  expect(broker.primeConversation(result.body.runId)).toBeNull();
});

it('collects exact worker reports across parking, explicitly acknowledges them, and reuses the sleeper', async () => {
  const spawn = (await cli('delegate', { ownerId, workers: [{ task: 'First assignment.' }] })).body;
  broker.bindConversation('worker-1', 'local-worker-chat', spawn.runId);
  broker.finishAgent({ conversationId: 'local-worker-chat' }, 'RESULT: first assignment complete');
  broker.releaseQuiescentRun({ allowPendingReports: true }, spawn.runId);
  const reports = (await cli('reports', { ownerId, runId: spawn.runId })).body;
  expect(reports.messages).toMatchObject([{ from: 'worker-1', text: expect.stringContaining('first assignment complete') }]);
  expect((await cli('reports', { ownerId, runId: spawn.runId })).body.messages.map((row: any) => row.id)).toEqual(reports.messages.map((row: any) => row.id));
  expect((await cli('ack', { ownerId, runId: spawn.runId, messageIds: reports.messages.map((row: any) => row.id) })).body.acknowledged).toEqual(reports.messages.map((row: any) => row.id));
  expect((await cli('reports', { ownerId, runId: spawn.runId })).body.messages).toEqual([]);
  const wake = await cli('message', { ownerId, runId: spawn.runId, messages: [{ to: 'worker-1', text: 'Second assignment.', label: 'Follow-up' }] });
  expect(wake.code, JSON.stringify(wake.body)).toBe(0);
  expect(wake.body.waking).toEqual(['worker-1']);
  expect(wake.body.runId).not.toBe(spawn.runId);
  expect((await cli('agents', { ownerId, runId: wake.body.runId })).body.workers).toMatchObject([{ id: 'worker-1', state: 'waking', label: 'Follow-up' }]);
});

it('retains local ownership and unread reports through a broker restart', async () => {
  const spawn = (await cli('delegate', { ownerId, workers: [{ task: 'Complete a task.' }] })).body;
  broker.bindConversation('worker-1', 'restart-worker', spawn.runId);
  broker.finishAgent({ conversationId: 'restart-worker' }, 'RESULT: retained report');
  broker.releaseQuiescentRun({ allowPendingReports: true }, spawn.runId);
  const snapshot = broker.snapshotSwarm();
  broker.resetAgentsForTests();
  broker.restoreSwarm(snapshot);
  broker.onSwarmPersistNow(state => durable.writeDurableNow('swarm', state));
  const status = await cli('agents', { ownerId, runId: spawn.runId });
  expect(status.body.workers).toMatchObject([{ id: 'worker-1', state: 'sleeping', revivable: true }]);
  expect((await cli('reports', { ownerId, runId: spawn.runId })).body.messages).toMatchObject([{ from: 'worker-1', text: expect.stringContaining('retained report') }]);
});

it('cannot use another local owner or a ChatGPT prime family through its run id', async () => {
  const otherOwner = '22222222-2222-4222-8222-222222222222';
  const own = (await cli('delegate', { ownerId, workers: [{ task: 'Owner one.' }] })).body;
  const foreign = (await cli('delegate', { ownerId: otherOwner, workers: [{ task: 'Owner two.' }] })).body;
  expect((await cli('agents', { ownerId, runId: foreign.runId })).code).toBe(1);
  expect((await cli('message', { ownerId, runId: foreign.runId, messages: [{ to: 'worker-1', text: 'Wrong owner.' }] })).code).toBe(1);
  const chat = broker.spawn({ caller: { conversationId: 'chatgpt-prime' }, workers: [{ task: 'Existing ChatGPT family.' }] });
  expect((await cli('agents', { ownerId, runId: chat.runId })).code).toBe(1);
  expect((await cli('agents', { ownerId, runId: own.runId })).body.workers).toMatchObject([{ id: 'worker-1', state: 'invited' }]);
  expect((await cli('agents', { ownerId: otherOwner, runId: foreign.runId })).body.workers).toMatchObject([{ id: 'worker-1', state: 'invited' }]);
});

it('publishes no worker when local actions are revoked during its durability barrier', async () => {
  const barrier = faultGate();
  let first = true;
  broker.onSwarmPersistNow(async snapshot => {
    if (first) { first = false; await barrier.hold(); }
    await durable.writeDurableNow('swarm', snapshot);
  });
  const pending = cli('delegate', { ownerId, workers: [{ task: 'Should be withdrawn.' }] });
  await barrier.entered;
  const current = config.getConfig();
  await config.saveConfig({ ...current, controlApi: { enabled: true, allowActions: false } });
  barrier.release();
  const result = await pending;
  expect(result.code).toBe(1);
  expect((await cli('agents', { ownerId })).body.workers).toEqual([]);
});
