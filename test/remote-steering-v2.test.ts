import http from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSteeringBrokerHooks } from '../src/main/remote-steering.js';
import type {
  RemoteSteeringActionV2,
  RemoteSteeringLeaseV2,
  RemoteSteeringOperationEnvelopeV2,
  RemoteSteeringOperationV2
} from '../src/main/remote-steering-contract-v2.js';

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

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const {
  bindConversation,
  currentRunId,
  onSwarmPersist,
  onSwarmPersistNow,
  pendingWorkerSpawns,
  persistCriticalSwarmNow,
  resetAgentsForTests,
  spawn,
  swarmState
} = await import('../src/main/agents.js');
const { initDurableStore, writeDurableNow } = await import('../src/main/durable.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const {
  noteRemoteSteeringAuthorityConfigChanged,
  pinRemoteSteeringKey,
  resetRemoteSteeringForTests,
  restoreRemoteSteering,
  steerRemotely
} = await import('../src/main/remote-steering.js');
const {
  REMOTE_STEERING_ENVELOPE_CONTRACT_V2,
  REMOTE_STEERING_LEASE_CONTRACT_V2,
  REMOTE_STEERING_OPERATION_CONTRACT_V2,
  REMOTE_STEERING_SCHEMA_VERSION_V2,
  REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2,
  REMOTE_STEERING_VERIFIER_ID_V2,
  canonicalLeaseBytesV2,
  canonicalOperationBytesV2,
  remoteSteeringLeaseDigestV2,
  validateRemoteSteeringEnvelopeV2
} = await import('../src/main/remote-steering-contract-v2.js');
const { remoteSteeringSha256 } = await import('../src/main/remote-steering-contract.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const PRIME_CHAT = 'c-remote-v2-prime';
const WORKER_CHAT = 'c-remote-v2-worker-1';
const TASK = 'Inspect the signed V2 remote-spawn path and report findings only.';
let dir: string;

interface SignedFixtureV2 {
  envelopeText: string;
  publicKeySpkiBase64: string;
  nowMs: number;
  operation: RemoteSteeringOperationV2;
}

function signedFixtureV2(
  runId: string,
  action: RemoteSteeringActionV2,
  operationId: string,
  targetWorkerId: string | null,
  text: string | null,
  workerAllowlist: readonly string[] = ['worker-2']
): SignedFixtureV2 {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeySpkiBase64 = publicDer.toString('base64');
  const fingerprint = createHash('sha256').update(publicDer).digest('hex');
  const nowMs = Date.now();
  const issuedAt = new Date(nowMs - 1_000).toISOString();
  const lease: RemoteSteeringLeaseV2 = {
    contract: REMOTE_STEERING_LEASE_CONTRACT_V2,
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION_V2,
    verifierId: REMOTE_STEERING_VERIFIER_ID_V2,
    verifierContractVersion: REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2,
    leaseId: '81000000000000000000000000000001',
    missionId: 'remote-spawn-v2-test',
    missionDigest: '8'.repeat(64),
    runId,
    workerAllowlist,
    allowedActions: [action],
    issuedAt,
    expiresAt: new Date(nowMs + 10 * 60_000).toISOString(),
    signingKeyFingerprint: fingerprint,
    operatorIntentDigest: '9'.repeat(64)
  };
  const bytes = text === null ? null : Buffer.from(text, 'utf8');
  const operation: RemoteSteeringOperationV2 = {
    contract: REMOTE_STEERING_OPERATION_CONTRACT_V2,
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION_V2,
    verifierId: REMOTE_STEERING_VERIFIER_ID_V2,
    verifierContractVersion: REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2,
    operationId,
    leaseId: lease.leaseId,
    leaseDigest: remoteSteeringLeaseDigestV2(lease),
    missionDigest: lease.missionDigest,
    runId,
    action,
    targetWorkerId: action === 'STATUS' ? null : targetWorkerId,
    messageText: action === 'MESSAGE' ? text : null,
    messageSha256: action === 'MESSAGE' && bytes ? remoteSteeringSha256(bytes) : null,
    messageLength: action === 'MESSAGE' && bytes ? bytes.length : null,
    spawnTaskText: action === 'SPAWN' ? text : null,
    spawnTaskSha256: action === 'SPAWN' && bytes ? remoteSteeringSha256(bytes) : null,
    spawnTaskLength: action === 'SPAWN' && bytes ? bytes.length : null,
    issuedAt,
    expiresAt: new Date(nowMs + 2 * 60_000).toISOString(),
    signingKeyFingerprint: fingerprint
  };
  const envelope: RemoteSteeringOperationEnvelopeV2 = {
    contract: REMOTE_STEERING_ENVELOPE_CONTRACT_V2,
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION_V2,
    verifierId: REMOTE_STEERING_VERIFIER_ID_V2,
    verifierContractVersion: REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2,
    signingKeyFingerprint: fingerprint,
    lease: { payload: lease, signature: sign(null, canonicalLeaseBytesV2(lease), privateKey).toString('base64') },
    operation: {
      payload: operation,
      signature: sign(null, canonicalOperationBytesV2(operation), privateKey).toString('base64')
    }
  };
  expect(validateRemoteSteeringEnvelopeV2(envelope)).not.toBeNull();
  return { envelopeText: JSON.stringify(envelope), publicKeySpkiBase64, nowMs, operation };
}

function startRun(): string {
  spawn({ workers: [{ task: 'existing local worker' }], caller: { conversationId: PRIME_CHAT } });
  expect(bindConversation('worker-1', WORKER_CHAT)).toBe(true);
  const runId = currentRunId(PRIME_CHAT);
  if (!runId) throw new Error('test run did not get an id');
  return runId;
}

const noMeasure: RemoteSteeringBrokerHooks = { measureSleepingWorkers: async () => undefined };

beforeAll(async () => {
  dir = await makeTempDir('clf-remote-steering-v2-');
  initConfigPath(dir);
  initDurableStore(dir);
  initSessionStore(dir);
});

afterAll(async () => {
  resetAgentsForTests();
  resetRemoteSteeringForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetAgentsForTests();
  resetRemoteSteeringForTests();
  resetSessionStoreForTests();
  await writeDurableNow('remote-steering-pin', null);
  await writeDurableNow('remote-steering-receipts', null);
  const base = defaultConfig();
  await saveConfig({
    ...base,
    sessions: { ...base.sessions, record: false },
    multiAgent: { ...base.multiAgent, enabled: true, maxWorkers: 2, allowUnattributedCalls: false },
    remoteSteering: { enabled: true }
  });
  onSwarmPersist(() => undefined);
  onSwarmPersistNow(async () => undefined);
});

afterEach(() => {
  resetAgentsForTests();
  resetRemoteSteeringForTests();
});

describe('remote steering V2 SPAWN', () => {
  it('creates exactly the signed future worker once and replay creates nothing else', async () => {
    const runId = startRun();
    const fixture = signedFixtureV2(runId, 'SPAWN', '82000000000000000000000000000002', 'worker-2', TASK);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    const result = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(result).toMatchObject({
      status: 'accepted',
      replay: false,
      verifierContractVersion: 2,
      action: 'SPAWN',
      runId,
      spawned: {
        workerId: 'worker-2',
        state: 'invited',
        taskSha256: fixture.operation.spawnTaskSha256,
        taskLength: fixture.operation.spawnTaskLength
      }
    });
    expect(JSON.stringify(result)).not.toContain(TASK);
    expect(swarmState(runId).agents.map((agent) => agent.id)).toEqual(['prime', 'worker-1', 'worker-2']);
    expect(pendingWorkerSpawns().map((worker) => ({ id: worker.id, task: worker.task }))).toEqual([
      { id: 'worker-2', task: TASK }
    ]);
    const created = swarmState(runId).agents.find((agent) => agent.id === 'worker-2');
    expect(created?.model ?? null).toBe(defaultConfig().multiAgent.defaultModel ?? null);
    expect(created?.reasoningEffort ?? null).toBe(defaultConfig().multiAgent.defaultReasoning ?? null);

    const replay = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(replay).toMatchObject({ status: 'accepted', replay: true, action: 'SPAWN', runId });
    expect(swarmState(runId).agents.map((agent) => agent.id)).toEqual(['prime', 'worker-1', 'worker-2']);
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-2']);
  });

  it('delivers the exact signed SPAWN task bytes without trimming', async () => {
    const runId = startRun();
    const task = '  preserve these signed bytes\n';
    const fixture = signedFixtureV2(runId, 'SPAWN', '82000000000000000000000000000009', 'worker-2', task);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    const result = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(result).toMatchObject({ status: 'accepted', action: 'SPAWN', spawned: { workerId: 'worker-2' } });
    expect(pendingWorkerSpawns().map((worker) => worker.task)).toEqual([task]);
    expect(result.spawned?.taskSha256).toBe(remoteSteeringSha256(Buffer.from(task, 'utf8')));
    expect(result.spawned?.taskLength).toBe(Buffer.byteLength(task, 'utf8'));
  });

  it('lets only one of two concurrent identical SPAWN relays create the worker', async () => {
    const runId = startRun();
    const fixture = signedFixtureV2(runId, 'SPAWN', '8200000000000000000000000000000a', 'worker-2', TASK);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    let writes = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    onSwarmPersistNow(async () => {
      writes += 1;
      if (writes === 1) await together;
    });

    const first = steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    await vi.waitFor(() => expect(writes).toBe(1));
    const second = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    release();
    const accepted = await first;

    expect(accepted).toMatchObject({ status: 'accepted', action: 'SPAWN' });
    expect(second).toMatchObject({ status: 'refused', reason: 'REMOTE_STEERING_OPERATION_INDETERMINATE' });
    expect(swarmState(runId).agents.filter((agent) => agent.id === 'worker-2')).toHaveLength(1);
    expect(pendingWorkerSpawns().filter((worker) => worker.id === 'worker-2')).toHaveLength(1);
  });

  it('restores a decided SPAWN receipt across restart and replays without another worker', async () => {
    const runId = startRun();
    const fixture = signedFixtureV2(runId, 'SPAWN', '8200000000000000000000000000000b', 'worker-2', TASK);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    const accepted = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(accepted).toMatchObject({ status: 'accepted', replay: false, action: 'SPAWN' });
    expect(pendingWorkerSpawns().filter((worker) => worker.id === 'worker-2')).toHaveLength(1);

    resetRemoteSteeringForTests();
    await restoreRemoteSteering();
    const replay = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);

    expect(replay).toMatchObject({ status: 'accepted', replay: true, action: 'SPAWN', runId });
    expect(swarmState(runId).agents.filter((agent) => agent.id === 'worker-2')).toHaveLength(1);
    expect(pendingWorkerSpawns().filter((worker) => worker.id === 'worker-2')).toHaveLength(1);
  });

  it('spends a signed spawn that names anything except the broker deterministic next worker id', async () => {
    const runId = startRun();
    const fixture = signedFixtureV2(runId, 'SPAWN', '82000000000000000000000000000003', 'worker-3', TASK, ['worker-3']);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    const result = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(result).toMatchObject({
      status: 'refused',
      reason: 'REMOTE_STEERING_SPAWN_REFUSED',
      action: 'SPAWN',
      runId,
      spawned: null
    });
    expect(result.detail).toContain('EXPECTED_WORKER_ID_MISMATCH');
    expect(swarmState(runId).agents.map((agent) => agent.id)).toEqual(['prime', 'worker-1']);

    const replay = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(replay).toMatchObject({ status: 'refused', replay: true, reason: 'REMOTE_STEERING_SPAWN_REFUSED' });
    expect(swarmState(runId).agents.map((agent) => agent.id)).toEqual(['prime', 'worker-1']);
  });

  it('never retasks an existing worker through SPAWN', async () => {
    const runId = startRun();
    const before = structuredClone(swarmState(runId).agents.find((agent) => agent.id === 'worker-1'));
    const fixture = signedFixtureV2(runId, 'SPAWN', '82000000000000000000000000000004', 'worker-1', TASK, ['worker-1']);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    const result = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(result).toMatchObject({ status: 'refused', reason: 'REMOTE_STEERING_SPAWN_REFUSED' });
    expect(swarmState(runId).agents.find((agent) => agent.id === 'worker-1')).toEqual(before);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('rolls the worker topology back when the durable broker barrier fails', async () => {
    const runId = startRun();
    const fixture = signedFixtureV2(runId, 'SPAWN', '82000000000000000000000000000005', 'worker-2', TASK);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);
    expect(await persistCriticalSwarmNow()).toBe(true);
    onSwarmPersistNow(async () => { throw new Error('simulated durable barrier failure'); });

    const result = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(result).toMatchObject({ status: 'refused', reason: 'REMOTE_STEERING_SPAWN_REFUSED', spawned: null });
    expect(swarmState(runId).agents.map((agent) => agent.id)).toEqual(['prime', 'worker-1']);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('rolls back a staged worker if authority is revoked inside the durable broker barrier', async () => {
    const runId = startRun();
    const fixture = signedFixtureV2(runId, 'SPAWN', '82000000000000000000000000000006', 'worker-2', TASK);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);
    expect(await persistCriticalSwarmNow()).toBe(true);

    let entered!: () => void;
    let release!: () => void;
    const barrierEntered = new Promise<void>((resolve) => { entered = resolve; });
    const barrierReleased = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    onSwarmPersistNow(async () => {
      writes += 1;
      if (writes === 1) {
        entered();
        await barrierReleased;
      }
    });

    const pending = steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    await barrierEntered;
    noteRemoteSteeringAuthorityConfigChanged();
    release();
    const result = await pending;

    expect(result).toMatchObject({ status: 'refused', reason: 'REMOTE_STEERING_DISABLED', action: 'SPAWN' });
    expect(writes).toBe(2);
    expect(swarmState(runId).agents.map((agent) => agent.id)).toEqual(['prime', 'worker-1']);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('V2 schema refuses model/reasoning fields and actions outside the closed triad', async () => {
    const runId = startRun();
    const fixture = signedFixtureV2(runId, 'SPAWN', '82000000000000000000000000000007', 'worker-2', TASK);
    const parsed = JSON.parse(fixture.envelopeText);
    parsed.operation.payload.model = 'gpt-5.6-sol';
    expect(validateRemoteSteeringEnvelopeV2(parsed)).toBeNull();
    delete parsed.operation.payload.model;
    parsed.operation.payload.action = 'FINISH';
    expect(validateRemoteSteeringEnvelopeV2(parsed)).toBeNull();
  });

  it('anonymous V2 SPAWN succeeds without turning the relay chat into an agents prime', async () => {
    const runId = startRun();
    const fixture = signedFixtureV2(runId, 'SPAWN', '82000000000000000000000000000008', 'worker-2', TASK);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    const endpoint = await startMcpServer(() => ({
      roots: [],
      caps: { ...DEFAULT_CAPABILITIES, read: true },
      readOnly: true,
      sessionTools: false,
      agentTools: true,
      remoteSteeringTools: true
    }));
    let rpcId = 1;
    const post = (name: string, args: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        const url = new URL(endpoint.url);
        const payload = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
        const request = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'content-length': Buffer.byteLength(payload)
            }
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8').trim();
              const frame = text.startsWith('{') ? text : ([...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? '{}');
              resolve(JSON.parse(frame));
            });
          }
        );
        request.on('error', reject);
        request.end(payload);
      });
    const textOf = (reply: any): string =>
      ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');

    try {
      const relayed = await post('remote_steering', { envelope: fixture.envelopeText });
      expect(relayed.result?.structuredContent).toMatchObject({
        status: 'accepted',
        action: 'SPAWN',
        run_id: runId,
        spawned: { worker_id: 'worker-2' }
      });
      const anonymousAgents = textOf(await post('agents', { action: 'status' }));
      expect(anonymousAgents).toContain('WORKER_IDENTITY_LOST');
      expect(anonymousAgents).toContain('No agent operation was performed');
      expect(anonymousAgents).not.toContain('worker-2');
    } finally {
      await endpoint.stop();
    }
  }, 15_000);
});
