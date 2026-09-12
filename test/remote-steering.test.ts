import http from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSteeringBrokerHooks } from '../src/main/remote-steering.js';
import type {
  RemoteSteeringAction,
  RemoteSteeringLeaseV1,
  RemoteSteeringOperationEnvelopeV1,
  RemoteSteeringOperationV1
} from '../src/main/remote-steering-contract.js';

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
  PRIME_ID,
  bindConversation,
  clearAgent,
  currentRunId,
  onSwarmPersist,
  onSwarmPersistNow,
  pendingCount,
  pendingWorkerRevivals,
  persistCriticalSwarmNow,
  releaseQuiescentRun,
  resetAgentsForTests,
  sleepWorker,
  spawn,
  swarmState
} = await import('../src/main/agents.js');
const { initDurableStore, writeDurableNow } = await import('../src/main/durable.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const {
  noteRemoteSteeringAuthorityConfigChanged,
  pinRemoteSteeringKey,
  resetRemoteSteeringForTests,
  steerRemotely
} = await import('../src/main/remote-steering.js');
const {
  REMOTE_STEERING_ENVELOPE_CONTRACT,
  REMOTE_STEERING_LEASE_CONTRACT,
  REMOTE_STEERING_OPERATION_CONTRACT,
  REMOTE_STEERING_SCHEMA_VERSION,
  REMOTE_STEERING_VERIFIER_CONTRACT_VERSION,
  REMOTE_STEERING_VERIFIER_ID,
  canonicalLeaseBytes,
  canonicalOperationBytes,
  remoteSteeringLeaseDigest,
  remoteSteeringSha256,
  validateRemoteSteeringEnvelope
} = await import('../src/main/remote-steering-contract.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const PRIME_CHAT = 'c-remote-prime';
const WORKER_CHAT = 'c-remote-worker-1';
const WORKER_CHAT_2 = 'c-remote-worker-2';
const PRIME_CHAT_B = 'c-remote-prime-b';
const WORKER_CHAT_B = 'c-remote-worker-b-1';
let dir: string;

interface SignedFixture {
  envelopeText: string;
  publicKeySpkiBase64: string;
  nowMs: number;
}

function signedFixture(
  runId: string,
  action: RemoteSteeringAction,
  operationId: string,
  targetWorkerId: string | null,
  messageText: string | null,
  workerAllowlist: readonly string[] = ['worker-1']
): SignedFixture {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeySpkiBase64 = publicDer.toString('base64');
  const fingerprint = createHash('sha256').update(publicDer).digest('hex');
  const nowMs = Date.now();
  const issuedAt = new Date(nowMs - 1_000).toISOString();
  const lease: RemoteSteeringLeaseV1 = {
    contract: REMOTE_STEERING_LEASE_CONTRACT,
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION,
    verifierId: REMOTE_STEERING_VERIFIER_ID,
    verifierContractVersion: REMOTE_STEERING_VERIFIER_CONTRACT_VERSION,
    leaseId: '10000000000000000000000000000001',
    missionId: 'remote-steering-test',
    missionDigest: '2'.repeat(64),
    runId,
    workerAllowlist,
    allowedActions: [action],
    issuedAt,
    expiresAt: new Date(nowMs + 10 * 60_000).toISOString(),
    signingKeyFingerprint: fingerprint,
    operatorIntentDigest: '3'.repeat(64)
  };
  const bytes = messageText === null ? null : Buffer.from(messageText, 'utf8');
  const operation: RemoteSteeringOperationV1 = {
    contract: REMOTE_STEERING_OPERATION_CONTRACT,
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION,
    verifierId: REMOTE_STEERING_VERIFIER_ID,
    verifierContractVersion: REMOTE_STEERING_VERIFIER_CONTRACT_VERSION,
    operationId,
    leaseId: lease.leaseId,
    leaseDigest: remoteSteeringLeaseDigest(lease),
    missionDigest: lease.missionDigest,
    runId,
    action,
    targetWorkerId,
    messageText,
    messageSha256: bytes ? remoteSteeringSha256(bytes) : null,
    messageLength: bytes ? bytes.length : null,
    issuedAt,
    expiresAt: new Date(nowMs + 2 * 60_000).toISOString(),
    signingKeyFingerprint: fingerprint
  };
  const envelope: RemoteSteeringOperationEnvelopeV1 = {
    contract: REMOTE_STEERING_ENVELOPE_CONTRACT,
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION,
    verifierId: REMOTE_STEERING_VERIFIER_ID,
    verifierContractVersion: REMOTE_STEERING_VERIFIER_CONTRACT_VERSION,
    signingKeyFingerprint: fingerprint,
    lease: { payload: lease, signature: sign(null, canonicalLeaseBytes(lease), privateKey).toString('base64') },
    operation: {
      payload: operation,
      signature: sign(null, canonicalOperationBytes(operation), privateKey).toString('base64')
    }
  };
  expect(validateRemoteSteeringEnvelope(envelope)).not.toBeNull();
  return { envelopeText: JSON.stringify(envelope), publicKeySpkiBase64, nowMs };
}

function startRun(workerCount = 1): string {
  spawn({
    workers: Array.from({ length: workerCount }, (_, index) => ({ task: `remote steering worker ${index + 1}` })),
    caller: { conversationId: PRIME_CHAT }
  });
  const chats = [WORKER_CHAT, WORKER_CHAT_2];
  for (let index = 0; index < workerCount; index += 1) {
    expect(bindConversation(`worker-${index + 1}`, chats[index]!)).toBe(true);
  }
  const runId = currentRunId(PRIME_CHAT);
  if (!runId) throw new Error('test run did not get an id');
  return runId;
}

beforeAll(async () => {
  dir = await makeTempDir('clf-remote-steering-');
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

describe('remote steering one-shot claim', () => {
  it('lets only one of two concurrent identical MESSAGE relays reach the broker', async () => {
    const runId = startRun();
    const fixture = signedFixture(
      runId,
      'MESSAGE',
      '20000000000000000000000000000002',
      'worker-1',
      'one signed message, one delivery'
    );
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    let arrivals = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hooks: RemoteSteeringBrokerHooks = {
      measureSleepingWorkers: async () => {
        arrivals += 1;
        if (arrivals === 2) release();
        await together;
      }
    };

    const [a, b] = await Promise.all([
      steerRemotely(fixture.envelopeText, hooks, fixture.nowMs),
      steerRemotely(fixture.envelopeText, hooks, fixture.nowMs)
    ]);

    expect(arrivals).toBe(2);
    expect([a, b].filter((result) => result.status === 'accepted')).toHaveLength(1);
    expect([a, b].filter((result) => result.reason === 'REMOTE_STEERING_OPERATION_INDETERMINATE')).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(1);

    const replay = await steerRemotely(
      fixture.envelopeText,
      { measureSleepingWorkers: async () => undefined },
      fixture.nowMs
    );
    expect(replay).toMatchObject({ status: 'accepted', replay: true, action: 'MESSAGE', runId });
    expect(pendingCount('worker-1')).toBe(1);
  });
});

describe('remote steering live authority', () => {
  it('publishes nothing when authority changes while target measurement is in flight', async () => {
    const runId = startRun();
    const fixture = signedFixture(
      runId,
      'MESSAGE',
      '40000000000000000000000000000004',
      'worker-1',
      'must not survive an in-flight revocation'
    );
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    let entered!: () => void;
    let release!: () => void;
    const measurementEntered = new Promise<void>((resolve) => { entered = resolve; });
    const measurementReleased = new Promise<void>((resolve) => { release = resolve; });
    const pending = steerRemotely(
      fixture.envelopeText,
      {
        measureSleepingWorkers: async (_caller, targetWorkerId) => {
          expect(targetWorkerId).toBe('worker-1');
          entered();
          await measurementReleased;
        }
      },
      fixture.nowMs
    );

    await measurementEntered;
    noteRemoteSteeringAuthorityConfigChanged();
    release();
    const result = await pending;

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'REMOTE_STEERING_DISABLED',
      action: 'MESSAGE',
      runId,
      delivered: null
    });
    expect(pendingCount('worker-1')).toBe(0);
    expect(pendingWorkerRevivals()).toEqual([]);
  });

  it('rolls back the staged message when authority changes inside the durable broker barrier', async () => {
    const runId = startRun();
    const fixture = signedFixture(
      runId,
      'MESSAGE',
      '40000000000000000000000000000005',
      'worker-1',
      'must not publish after barrier revocation'
    );
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

    const pending = steerRemotely(
      fixture.envelopeText,
      { measureSleepingWorkers: async () => undefined },
      fixture.nowMs
    );
    await barrierEntered;
    noteRemoteSteeringAuthorityConfigChanged();
    release();
    const result = await pending;

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'REMOTE_STEERING_DISABLED',
      action: 'MESSAGE',
      runId,
      delivered: null
    });
    expect(writes).toBe(2);
    expect(pendingCount('worker-1')).toBe(0);
    expect(pendingWorkerRevivals()).toEqual([]);
  });
});

describe('remote steering target-scoped measurement', () => {
  it('measures exactly the signed sleeping target and leaves a non-allowlisted sleeper untouched', async () => {
    const runId = startRun(2);
    expect(sleepWorker('worker-1', 'target is asleep for measurement', runId)?.info.state).toBe('sleeping');
    expect(sleepWorker('worker-2', 'unrelated worker is asleep too', runId)?.info.state).toBe('sleeping');
    const unrelatedBefore = structuredClone(swarmState(runId).agents.find((agent) => agent.id === 'worker-2'));

    const fixture = signedFixture(
      runId,
      'MESSAGE',
      '50000000000000000000000000000005',
      'worker-1',
      'measure only my signed target',
      ['worker-1']
    );
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);
    const measured: Array<{ conversationId: string | null | undefined; targetWorkerId: string }> = [];

    const result = await steerRemotely(
      fixture.envelopeText,
      {
        measureSleepingWorkers: async (caller, targetWorkerId) => {
          measured.push({ conversationId: caller.conversationId, targetWorkerId });
        }
      },
      fixture.nowMs
    );

    expect(result).toMatchObject({ status: 'accepted', action: 'MESSAGE', runId });
    expect(measured).toEqual([{ conversationId: PRIME_CHAT, targetWorkerId: 'worker-1' }]);
    expect(swarmState(runId).agents.find((agent) => agent.id === 'worker-2')).toEqual(unrelatedBefore);
    expect(pendingCount('worker-2')).toBe(0);
    expect(pendingWorkerRevivals().map((revival) => revival.id)).toEqual(['worker-1']);
  });
});

describe('remote steering is not caller identity', () => {
  it('accepts an anonymous signed STATUS for live run B even while dormant run A still fences ordinary anonymous calls', async () => {
    const dormantRunId = startRun();
    expect(sleepWorker('worker-1', 'park run A before signed run B', dormantRunId)?.info.state).toBe('sleeping');
    expect(releaseQuiescentRun({}, dormantRunId)).toBe(true);

    const live = spawn({
      workers: [{ task: 'live run B target' }],
      caller: { conversationId: PRIME_CHAT_B }
    });
    expect(bindConversation('worker-1', WORKER_CHAT_B, live.runId)).toBe(true);
    const fixture = signedFixture(live.runId, 'STATUS', '30000000000000000000000000000004', null, null);
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
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId++,
          method: 'tools/call',
          params: { name, arguments: args }
        });
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
      expect(relayed.result?.structuredContent).toMatchObject({ status: 'accepted', action: 'STATUS', run_id: live.runId });
      expect(textOf(relayed)).not.toContain('CALLER_IDENTITY_REQUIRED');

      const ordinary = textOf(await post('read', { paths: ['/anything'] }));
      expect(ordinary).toContain('CALLER_IDENTITY_REQUIRED');
    } finally {
      await endpoint.stop();
    }
  }, 15_000);

  it('keeps ordinary WORKER_IDENTITY_LOST and CALLER_IDENTITY_REQUIRED fences after an anonymous signed relay', async () => {
    const runId = startRun();
    const fixture = signedFixture(runId, 'STATUS', '30000000000000000000000000000003', null, null);
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
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId++,
          method: 'tools/call',
          params: { name, arguments: args }
        });
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
      expect(relayed.result?.structuredContent).toMatchObject({ status: 'accepted', action: 'STATUS', run_id: runId });

      const anonymousAgents = textOf(await post('agents', { action: 'status' }));
      expect(anonymousAgents).toContain('WORKER_IDENTITY_LOST');
      expect(anonymousAgents).toContain('No agent operation was performed');
      expect(anonymousAgents).not.toContain('worker-1');

      expect(clearAgent(PRIME_ID).cleared).toBe('run');
      const ambiguousOrdinary = textOf(await post('read', { paths: ['/anything'] }));
      expect(ambiguousOrdinary).toContain('CALLER_IDENTITY_REQUIRED');
    } finally {
      await endpoint.stop();
    }
  }, 15_000);
});
