import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSteeringBrokerHooks } from '../src/main/remote-steering.js';
import type {
  RemoteSteeringActionV3,
  RemoteSteeringLeaseV3,
  RemoteSteeringOperationEnvelopeV3,
  RemoteSteeringOperationV3
} from '../src/main/remote-steering-contract-v3.js';

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
const { initDurableStore, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const {
  pinRemoteSteeringKey,
  resetRemoteSteeringForTests,
  steerRemotely
} = await import('../src/main/remote-steering.js');
const {
  REMOTE_STEERING_ENVELOPE_CONTRACT_V3,
  REMOTE_STEERING_LEASE_CONTRACT_V3,
  REMOTE_STEERING_LEASE_MAX_TTL_SECONDS_V3,
  REMOTE_STEERING_OPERATION_CONTRACT_V3,
  canonicalLeaseBytesV3,
  canonicalOperationBytesV3,
  remoteSteeringLeaseDigestV3,
  validateRemoteSteeringEnvelopeV3,
  validateRemoteSteeringLeaseV3
} = await import('../src/main/remote-steering-contract-v3.js');
const { remoteSteeringSha256 } = await import('../src/main/remote-steering-contract.js');
const {
  appendEvent,
  createSession,
  initSessionStore,
  observeSessionModel,
  rebindSession,
  resetSessionStoreForTests
} = await import('../src/main/session/store.js');
const {
  configureInputDelivery,
  listInputs,
  resetInputForTests
} = await import('../src/main/session/input.js');
const {
  goalSwitchFor,
  resetGoalStateForTests,
  setGoalSwitchNow
} = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');

const CONVERSATION = 'conversation-v3-longrun';
const LONGRUN = 'VYPER Frontier Longrun V1. Recover live truth, close one bounded product loop, checkpoint, then use session_finish instead of ordinary final.';
const noMeasure: RemoteSteeringBrokerHooks = { measureSleepingWorkers: async () => undefined };
let dir: string;

interface SignedFixtureV3 {
  envelopeText: string;
  publicKeySpkiBase64: string;
  nowMs: number;
  operation: RemoteSteeringOperationV3;
}

function signedFixtureV3(
  sessionId: string,
  action: RemoteSteeringActionV3,
  operationId: string,
  longrunText: string | null = null,
  leaseTtlSeconds = 600
): SignedFixtureV3 {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeySpkiBase64 = publicDer.toString('base64');
  const fingerprint = createHash('sha256').update(publicDer).digest('hex');
  const nowMs = Date.now();
  const issuedAt = new Date(nowMs - 1_000).toISOString();
  const lease: RemoteSteeringLeaseV3 = {
    contract: REMOTE_STEERING_LEASE_CONTRACT_V3,
    schemaVersion: 3,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: 3,
    leaseId: '93000000000000000000000000000001',
    missionId: 'vyper-frontier-longrun-v1',
    missionDigest: 'a'.repeat(64),
    sessionId,
    allowedActions: [action],
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + leaseTtlSeconds * 1000).toISOString(),
    signingKeyFingerprint: fingerprint,
    operatorIntentDigest: 'b'.repeat(64)
  };
  const bytes = longrunText === null ? null : Buffer.from(longrunText, 'utf8');
  const operation: RemoteSteeringOperationV3 = {
    contract: REMOTE_STEERING_OPERATION_CONTRACT_V3,
    schemaVersion: 3,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: 3,
    operationId,
    leaseId: lease.leaseId,
    leaseDigest: remoteSteeringLeaseDigestV3(lease),
    missionDigest: lease.missionDigest,
    sessionId,
    action,
    longrunText: action === 'LONGRUN_START' ? longrunText : null,
    longrunSha256: action === 'LONGRUN_START' && bytes ? remoteSteeringSha256(bytes) : null,
    longrunLength: action === 'LONGRUN_START' && bytes ? bytes.length : null,
    issuedAt,
    expiresAt: new Date(nowMs + 2 * 60_000).toISOString(),
    signingKeyFingerprint: fingerprint
  };
  const envelope: RemoteSteeringOperationEnvelopeV3 = {
    contract: REMOTE_STEERING_ENVELOPE_CONTRACT_V3,
    schemaVersion: 3,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: 3,
    signingKeyFingerprint: fingerprint,
    lease: { payload: lease, signature: sign(null, canonicalLeaseBytesV3(lease), privateKey).toString('base64') },
    operation: { payload: operation, signature: sign(null, canonicalOperationBytesV3(operation), privateKey).toString('base64') }
  };
  expect(validateRemoteSteeringEnvelopeV3(envelope)).not.toBeNull();
  return { envelopeText: JSON.stringify(envelope), publicKeySpkiBase64, nowMs, operation };
}

async function makeSession(model = 'gpt-6-astra', effort: 'pro' | undefined = undefined): Promise<string> {
  const session = await createSession({ conversationId: CONVERSATION, title: 'VYPER Longrun target' });
  await observeSessionModel(session.id, CONVERSATION, model, Date.now(), effort);
  await appendEvent(session.id, {
    time: Date.now(), source: 'extension', kind: 'turn_end',
    turnId: 'bootstrap-turn', outcome: 'completed'
  });
  return session.id;
}

beforeAll(async () => {
  dir = await makeTempDir('clf-remote-steering-v3-');
  initConfigPath(dir);
  initDurableStore(dir);
  initSessionStore(dir);
});

afterAll(async () => {
  resetRemoteSteeringForTests();
  resetGoalStateForTests();
  resetInputForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetRemoteSteeringForTests();
  resetGoalStateForTests();
  resetInputForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  initDurableStore(dir);
  initSessionStore(dir);
  await writeDurableNow('remote-steering-pin', null);
  await writeDurableNow('remote-steering-receipts', null);
  await writeDurableNow('session-input', []);
  await writeDurableNow('goal-switches', null);
  await writeDurableNow('goal-objectives', null);
  await writeDurableNow('goal-replies', null);
  const base = defaultConfig();
  await saveConfig({
    ...base,
    sessions: { ...base.sessions, record: true },
    ui: { ...base.ui, finishTool: true, finishAction: 'goal' },
    multiAgent: { ...base.multiAgent, enabled: false },
    remoteSteering: { enabled: true }
  });
  configureInputDelivery({
    applyAutomation: async () => undefined,
    changed: () => undefined
  });
});

afterEach(() => {
  resetRemoteSteeringForTests();
  resetGoalStateForTests();
  resetInputForTests();
  resetSessionStoreForTests();
});

describe('remote steering V3 exact-session Longrun', () => {
  it('accepts an exactly 72-hour V3 lease and refuses the same signed shape one second beyond the ceiling', async () => {
    const sessionId = await makeSession('gpt-6-pro');
    const atCeiling = signedFixtureV3(
      sessionId,
      'SESSION_STATUS',
      '93000000000000000000000000000010',
      null,
      REMOTE_STEERING_LEASE_MAX_TTL_SECONDS_V3
    );
    await pinRemoteSteeringKey(atCeiling.publicKeySpkiBase64);
    expect(await steerRemotely(atCeiling.envelopeText, noMeasure, atCeiling.nowMs)).toMatchObject({
      status: 'accepted', action: 'SESSION_STATUS', sessionId
    });

    const over = JSON.parse(signedFixtureV3(
      sessionId,
      'SESSION_STATUS',
      '93000000000000000000000000000011',
      null,
      REMOTE_STEERING_LEASE_MAX_TTL_SECONDS_V3
    ).envelopeText) as RemoteSteeringOperationEnvelopeV3;
    expect(validateRemoteSteeringLeaseV3({
      ...over.lease.payload,
      expiresAt: new Date(Date.parse(over.lease.payload.issuedAt) + (REMOTE_STEERING_LEASE_MAX_TTL_SECONDS_V3 + 1) * 1000).toISOString()
    })).toBeNull();
  });

  it('starts exactly one queued Longrun mission on an existing Astra session even with multi-agent off, and replay repeats nothing', async () => {
    const sessionId = await makeSession();
    const fixture = signedFixtureV3(sessionId, 'LONGRUN_START', '93000000000000000000000000000002', LONGRUN);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    const result = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(result).toMatchObject({
      status: 'accepted', replay: false, verifierContractVersion: 3, action: 'LONGRUN_START',
      runId: null, sessionId,
      longrun: { longrunSha256: fixture.operation.longrunSha256, longrunLength: fixture.operation.longrunLength, automation: 'loop' },
      session: { found: true, modelClass: 'astra', finishToolEnabled: true, pendingLongrunStart: true }
    });
    expect(JSON.stringify(result)).not.toContain(LONGRUN);
    const rows = await listInputs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId, text: LONGRUN, objective: LONGRUN, automation: 'loop', state: 'queued' });

    const replay = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(replay).toMatchObject({ status: 'accepted', replay: true, action: 'LONGRUN_START', sessionId });
    expect(await listInputs()).toHaveLength(1);
  });

  it('returns content-blind SESSION_STATUS without requiring the worker broker', async () => {
    const sessionId = await makeSession('gpt-6-pro');
    const fixture = signedFixtureV3(sessionId, 'SESSION_STATUS', '93000000000000000000000000000003');
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);
    const result = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(result).toMatchObject({
      status: 'accepted', action: 'SESSION_STATUS', runId: null, sessionId,
      session: { found: true, modelClass: 'astra', activeTurn: false, loopEnabled: false, pendingUserInput: false }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CONVERSATION);
    expect(serialized).not.toContain('VYPER Longrun target');
    expect(serialized).not.toContain('gpt-6-pro');
  });

  it('refuses LONGRUN_START when the user-selected session is not Astra and never changes the model', async () => {
    const sessionId = await makeSession('gpt-5.6-sol');
    const fixture = signedFixtureV3(sessionId, 'LONGRUN_START', '93000000000000000000000000000004', LONGRUN);
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);
    const result = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(result).toMatchObject({ status: 'refused', reason: 'REMOTE_STEERING_ASTRA_REQUIRED', sessionId });
    expect(await listInputs()).toHaveLength(0);
  });

  it('turns Loop off for exactly the signed session and does not require multi-agent', async () => {
    const sessionId = await makeSession();
    await setGoalSwitchNow(CONVERSATION, 'loop', true);
    expect(goalSwitchFor(CONVERSATION)).toMatchObject({ enabled: true, mode: 'loop' });
    const fixture = signedFixtureV3(sessionId, 'LOOP_OFF', '93000000000000000000000000000005');
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);
    const result = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(result).toMatchObject({ status: 'accepted', action: 'LOOP_OFF', sessionId, session: { loopEnabled: false } });
    expect(goalSwitchFor(CONVERSATION)).toMatchObject({ enabled: false, mode: 'loop' });
  });

  it('exposes the signed relay without exposing agents when multi-agent is off', async () => {
    const sessionId = await makeSession();
    const fixture = signedFixtureV3(sessionId, 'SESSION_STATUS', '93000000000000000000000000000006');
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);
    const endpoint = await startMcpServer(() => ({
      roots: [],
      caps: { ...DEFAULT_CAPABILITIES, read: true },
      readOnly: true,
      sessionTools: false,
      agentTools: false,
      remoteSteeringTools: true
    }));
    let rpcId = 1;
    const post = (method: string, params: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        const url = new URL(endpoint.url);
        const payload = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params });
        const request = http.request({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(payload)
          }
        }, response => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            const frame = text.startsWith('{') ? text : ([...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? '{}');
            resolve(JSON.parse(frame));
          });
        });
        request.on('error', reject);
        request.end(payload);
      });
    try {
      const listed = await post('tools/list', {});
      const names = (listed.result?.tools ?? []).map((tool: { name: string }) => tool.name);
      expect(names).toContain('remote_steering');
      expect(names).not.toContain('agents');

      const relayed = await post('tools/call', { name: 'remote_steering', arguments: { envelope: fixture.envelopeText } });
      expect(relayed.result?.structuredContent).toMatchObject({
        status: 'accepted', action: 'SESSION_STATUS', run_id: null, session_id: sessionId,
        session: { session_id: sessionId, model_class: 'astra' }
      });
    } finally {
      await endpoint.stop();
    }
  }, 15_000);

  it('keeps one V3 session lease valid across Compact & Resume conversation rebind without authorizing an unrelated session', async () => {
    const sessionId = await makeSession('gpt-6-pro');
    const fixture = signedFixtureV3(
      sessionId,
      'SESSION_STATUS',
      '93000000000000000000000000000012',
      null,
      REMOTE_STEERING_LEASE_MAX_TTL_SECONDS_V3
    );
    await pinRemoteSteeringKey(fixture.publicKeySpkiBase64);

    const replacementConversation = 'conversation-v3-after-compact';
    expect(await rebindSession(sessionId, CONVERSATION, replacementConversation, 'handoff-72h-proof')).toBe(true);
    await observeSessionModel(sessionId, replacementConversation, 'gpt-6-pro', Date.now());
    const unrelated = await createSession({ conversationId: 'conversation-v3-unrelated', title: 'Unrelated chat' });
    await observeSessionModel(unrelated.id, 'conversation-v3-unrelated', 'gpt-6-pro', Date.now());

    const result = await steerRemotely(fixture.envelopeText, noMeasure, fixture.nowMs);
    expect(result).toMatchObject({
      status: 'accepted', action: 'SESSION_STATUS', sessionId,
      session: { found: true, modelClass: 'astra', activeTurn: false }
    });
    expect(result.session?.sessionId).toBe(sessionId);
    expect(result.session?.sessionId).not.toBe(unrelated.id);
  });
});
