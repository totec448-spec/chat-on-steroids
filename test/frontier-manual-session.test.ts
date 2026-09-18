import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FrontierManualSessionAction,
  FrontierManualSessionGrantV1,
  FrontierManualSessionOperationEnvelopeV1,
  FrontierManualSessionOperationV1,
} from '../src/main/frontier-manual-session-contract.js';

const startPorts = vi.hoisted(() => ({ send: vi.fn(), retry: vi.fn() }));
vi.mock('../src/main/session/start-input.js', () => ({
  sendDesktopInput: startPorts.send,
  retryQueuedInputBrowser: startPorts.retry,
}));
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
const { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const {
  FRONTIER_MANUAL_SESSION_MAX_ENVELOPE_CHARS,
  REMOTE_STEERING_MAX_ENVELOPE_CHARS,
  pinRemoteSteeringKey,
  resetRemoteSteeringForTests,
  restoreRemoteSteering,
  steerRemotely,
} = await import('../src/main/remote-steering.js');
const {
  FRONTIER_MANUAL_SESSION_ACTIONS,
  FRONTIER_MANUAL_SESSION_AUTOMATION,
  FRONTIER_MANUAL_SESSION_ENVELOPE_CONTRACT,
  FRONTIER_MANUAL_SESSION_GRANT_CONTRACT,
  FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS,
  FRONTIER_MANUAL_SESSION_MODEL,
  FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT,
  FRONTIER_MANUAL_SESSION_REASONING,
  FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION,
  canonicalFrontierManualSessionGrantBytes,
  canonicalFrontierManualSessionOperationBytes,
  frontierManualSessionGrantDigest,
  frontierManualSessionProjectBindingDigest,
} = await import('../src/main/frontier-manual-session-contract.js');
const { frontierManualSessionStateNamesForTests } = await import('../src/main/frontier-manual-session.js');
const { remoteSteeringSha256 } = await import('../src/main/remote-steering-contract.js');
const {
  acknowledgeBrowserInput,
  cancelInput,
  claimBrowserInput,
  configureInputDelivery,
  enqueueInput,
  listInputs,
  offerToolInput,
  resetInputForTests,
  sessionInputPolicy,
} = await import('../src/main/session/input.js');
const {
  createSession,
  getSession,
  initSessionStore,
  observeSessionModel,
  rebindSession,
  resetSessionStoreForTests,
} = await import('../src/main/session/store.js');
const { goalSwitchFor, resetGoalStateForTests, setGoalReplyActiveNow, setGoalSwitchNow } = await import('../src/main/goal.js');
const { observeRequestCorrelation } = await import('../src/main/session/correlation.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const noMeasure = { measureSleepingWorkers: async () => undefined };
const CREATE_TEXT = 'Open the bounded VYPER manual session and inspect the current production lane.';
const PROMPT_TEXT = 'Continue the exact bounded manual session with the next verified slice.';
let directory: string;
let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
let fingerprint = '';
let grant: FrontierManualSessionGrantV1;
let grantSignature = '';
let nowMs = 0;
let operationCounter = 1;

function operationId(): string { return (operationCounter++).toString(16).padStart(32, '0'); }

function signedOperation(
  action: FrontierManualSessionAction,
  mutationSeq: number,
  options: { text?: string; inputId?: string; id?: string } = {}
): { envelope: FrontierManualSessionOperationEnvelopeV1; operation: FrontierManualSessionOperationV1; text: string } {
  const text = options.text ?? (action === 'SESSION_CREATE' ? CREATE_TEXT : PROMPT_TEXT);
  const bytes = Buffer.from(text, 'utf8');
  const carriesText = action === 'SESSION_CREATE' || action === 'SESSION_PROMPT';
  const operation: FrontierManualSessionOperationV1 = {
    contract: FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT,
    schemaVersion: 1,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION,
    operationId: options.id ?? operationId(),
    grantId: grant.grantId,
    grantDigest: frontierManualSessionGrantDigest(grant),
    projectBindingDigest: grant.projectBindingDigest,
    action,
    mutationSeq,
    inputId: carriesText ? options.inputId ?? randomUUID() : null,
    taskText: carriesText ? text : null,
    taskSha256: carriesText ? remoteSteeringSha256(bytes) : null,
    taskLength: carriesText ? bytes.length : null,
    issuedAt: new Date(nowMs - 500).toISOString(),
    expiresAt: new Date(nowMs + 59_000).toISOString(),
    signingKeyFingerprint: fingerprint,
  };
  return {
    text,
    operation,
    envelope: {
      contract: FRONTIER_MANUAL_SESSION_ENVELOPE_CONTRACT,
      schemaVersion: 1,
      verifierId: 'chat-on-steroids',
      verifierContractVersion: FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION,
      signingKeyFingerprint: fingerprint,
      grant: { payload: grant, signature: grantSignature },
      operation: { payload: operation, signature: sign(null, canonicalFrontierManualSessionOperationBytes(operation), privateKey).toString('base64') },
    }
  };
}

async function relay(fixture: ReturnType<typeof signedOperation>, at = nowMs) {
  return steerRemotely(JSON.stringify(fixture.envelope), noMeasure, at);
}

async function bindCreate(
  fixture: ReturnType<typeof signedOperation>,
  selectedModel = FRONTIER_MANUAL_SESSION_MODEL,
  reasoning: Parameters<typeof observeSessionModel>[4] = FRONTIER_MANUAL_SESSION_REASONING
) {
  const row = (await listInputs()).find(entry => entry.id === fixture.operation.inputId)!;
  expect(row).toBeDefined();
  expect(await claimBrowserInput(row.id, 'manual-page', null)).toMatchObject({ id: row.id, deliveryText: CREATE_TEXT });
  const conversationId = randomUUID();
  const session = await createSession({ conversationId, title: 'frontier manual session' });
  await observeSessionModel(session.id, conversationId, selectedModel, Date.now(), reasoning);
  expect(await acknowledgeBrowserInput(row.id, 'manual-page', conversationId, 'native-manual')).toBe(true);
  const acknowledged = (await listInputs()).find(entry => entry.id === row.id)!;
  const candidate = acknowledged.deliveredSessionId ? await getSession(acknowledged.deliveredSessionId) : null;
  expect(acknowledged).toMatchObject({ state: 'sent', messageId: 'native-manual', conversationId, deliveredSessionId: session.id });
  expect(candidate).toMatchObject({ id: session.id, conversationId, selectedModel: { conversationId, model: selectedModel, reasoningEffort: reasoning }, origin: { kind: 'frontier_manual_session' } });
  const status = signedOperation('SESSION_STATUS', 1);
  const statusResult = await relay(status);
  expect(statusResult).toMatchObject({
    status: 'accepted',
    manualSession: {
      state: selectedModel === FRONTIER_MANUAL_SESSION_MODEL && reasoning === FRONTIER_MANUAL_SESSION_REASONING ? 'bound' : 'model_mismatch'
    }
  });
  return { session, conversationId };
}

function retainedCapacityState(grantCount: number, expiresAt: string) {
  const retainedTask = Buffer.from('retained');
  const retainedTaskSha = remoteSteeringSha256(retainedTask);
  const grantIds = Array.from({ length: grantCount }, (_, index) => (0x1000 + index).toString(16).padStart(32, '0'));
  const grants = grantIds.map((grantId, index) => {
    const inputId = randomUUID();
    const digest = (0x3000 + index).toString(16).padStart(64, '0');
    return {
      grantId, grantDigest: digest, projectBindingDigest: (0x4000 + index).toString(16).padStart(64, '0'), expiresAt,
      createInputId: inputId, createOperationDigest: digest, createTaskSha256: retainedTaskSha, createTaskLength: retainedTask.length,
      lastMutationSeq: 1, lastMutationDigest: digest, lastOperationId: (0x5000 + index).toString(16).padStart(32, '0'),
      lastAction: 'SESSION_CREATE', lastInputId: inputId, lastTaskSha256: retainedTaskSha, lastTaskLength: retainedTask.length,
      lastEffectMaterialized: true, candidateSessionId: null, modelRejected: false, sessionId: null, createDelivery: 'reserved'
    };
  });
  const receipts = Array.from({ length: grantCount * FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS }, (_, index) => ({
    operationId: (0x10_000 + index).toString(16).padStart(32, '0'),
    operationDigest: (0x20_000 + index).toString(16).padStart(64, '0'),
    grantId: grantIds[index % grantIds.length]!, action: index % 2 === 0 ? 'SESSION_CREATE' : 'SESSION_PROMPT',
    mutationSeq: (index % FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS) + 1, inputId: randomUUID(), grantExpiresAt: expiresAt,
  }));
  return { grants, receipts };
}

beforeEach(async () => {
  resetRemoteSteeringForTests(); resetGoalStateForTests(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  directory = await makeTempDir('cos-frontier-manual-session-');
  initConfigPath(directory);
  initDurableStore(directory); initSessionStore(directory);
  await writeDurableNow('remote-steering-pin', null);
  await writeDurableNow('remote-steering-receipts', null);
  await writeDurableNow(frontierManualSessionStateNamesForTests.state, null);
  await writeDurableNow(frontierManualSessionStateNamesForTests.receipts, null);
  await writeDurableNow('session-input', []);
  await writeDurableNow('goal-switches', null);
  const base = defaultConfig();
  await saveConfig({
    ...base,
    sessions: { ...base.sessions, record: true },
    ui: { ...base.ui, finishTool: true, finishAction: 'goal' },
    multiAgent: { ...base.multiAgent, enabled: false },
    remoteSteering: { enabled: true },
  });
  configureInputDelivery({
    changed: () => undefined,
    applyAutomation: async (conversationId, automation) => {
      const mode = automation === 'off' ? goalSwitchFor(conversationId).mode : automation;
      await setGoalSwitchNow(conversationId, mode, automation !== 'off');
      await setGoalReplyActiveNow(conversationId, false);
    },
  });
  startPorts.send.mockReset().mockImplementation(async input => enqueueInput(input));
  startPorts.retry.mockReset();
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  fingerprint = createHash('sha256').update(publicDer).digest('hex');
  nowMs = Date.now(); operationCounter = 1;
  grant = {
    contract: FRONTIER_MANUAL_SESSION_GRANT_CONTRACT,
    schemaVersion: 1,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION,
    grantId: 'a1000000000000000000000000000001',
    travelParentId: 'b1000000000000000000000000000001',
    travelParentDigest: 'c'.repeat(64),
    scope: 'vyper',
    projectBindingDigest: frontierManualSessionProjectBindingDigest('vyper'),
    allowedActions: FRONTIER_MANUAL_SESSION_ACTIONS,
    maxTextClaims: FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS,
    model: FRONTIER_MANUAL_SESSION_MODEL,
    reasoning: FRONTIER_MANUAL_SESSION_REASONING,
    automation: FRONTIER_MANUAL_SESSION_AUTOMATION,
    issuedAt: new Date(nowMs - 1_000).toISOString(),
    expiresAt: new Date(nowMs + 259_199_000).toISOString(),
    signingKeyFingerprint: fingerprint,
  };
  grantSignature = sign(null, canonicalFrontierManualSessionGrantBytes(grant), privateKey).toString('base64');
  await pinRemoteSteeringKey(publicDer.toString('base64'));
});

afterEach(async () => {
  resetRemoteSteeringForTests(); resetGoalStateForTests(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  if (directory) await removeTempDir(directory);
  directory = '';
});

describe('Frontier manual-session verifier and runtime', () => {
  it.each([
    ['ascii', 'a'.repeat(16_000)],
    ['escaped-control', '\0'.repeat(16_000)],
  ])('accepts the full 16k signed task through the protocol-aware envelope bound (%s)', async (_kind, text) => {
    const create = signedOperation('SESSION_CREATE', 1, { text });
    const serialized = JSON.stringify(create.envelope);
    expect(Buffer.byteLength(text, 'utf8')).toBe(16_000);
    expect(serialized.length).toBeLessThanOrEqual(FRONTIER_MANUAL_SESSION_MAX_ENVELOPE_CHARS);
    if (text.includes('\0')) expect(serialized.length).toBeGreaterThan(REMOTE_STEERING_MAX_ENVELOPE_CHARS);
    expect(await relay(create)).toMatchObject({ status: 'accepted', action: 'SESSION_CREATE' });
  });

  it('keeps the legacy 32k ceiling for non-manual protocols even under the larger absolute pre-parse bound', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true }, remoteSteering: { enabled: true } });
    const oversized = JSON.stringify({ contract: 'unknown_protocol', padding: 'x'.repeat(REMOTE_STEERING_MAX_ENVELOPE_CHARS + 1) });
    expect(oversized.length).toBeGreaterThan(REMOTE_STEERING_MAX_ENVELOPE_CHARS);
    expect(await steerRemotely(oversized, noMeasure, nowMs)).toMatchObject({ status: 'refused', reason: 'REMOTE_STEERING_ENVELOPE_UNREADABLE' });
  });

  it('creates one fresh targetless PC-owned chat with exact fixed settings and no finish appendix', async () => {
    const create = signedOperation('SESSION_CREATE', 1);
    const result = await relay(create);
    expect(result).toMatchObject({ status: 'accepted', action: 'SESSION_CREATE', sessionId: null, runId: null, manualSession: { state: 'opening', found: false } });
    expect(startPorts.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: create.operation.inputId, sessionId: null, text: CREATE_TEXT, automation: 'off',
      authorityClass: 'frontier_manual_session_v1', mode: 'auto', model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh'
    }));
    const row = (await listInputs()).find(entry => entry.id === create.operation.inputId)!;
    const claimed = await claimBrowserInput(row.id, 'manual-page', null);
    expect(claimed?.deliveryText).toBe(CREATE_TEXT);
    expect(claimed?.deliveryText).not.toContain('session_finish');
    expect(JSON.stringify(result)).not.toContain('conversationId');
  });

  it('holds one complete prior-root rollover plus the current nine-child root with every admitted text claim still representable', async () => {
    const retained = retainedCapacityState(17, new Date(nowMs + 2 * 24 * 60 * 60_000).toISOString());
    expect(retained.receipts).toHaveLength(17 * FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS);
    expect(9 * FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS).toBe(576);
    expect(18 * FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS).toBe(1152);
    await writeDurableNow(frontierManualSessionStateNamesForTests.state, { version: 1, grants: retained.grants });
    await writeDurableNow(frontierManualSessionStateNamesForTests.receipts, { version: 1, receipts: retained.receipts });
    resetRemoteSteeringForTests(); await restoreRemoteSteering();

    const create = signedOperation('SESSION_CREATE', 1);
    expect(await relay(create)).toMatchObject({ status: 'accepted', action: 'SESSION_CREATE' });
    expect(startPorts.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: create.operation.inputId }));
    expect((await readDurable<{ grants: unknown[] }>(frontierManualSessionStateNamesForTests.state))?.grants).toHaveLength(18);
    expect((await readDurable<{ receipts: unknown[] }>(frontierManualSessionStateNamesForTests.receipts))?.receipts).toHaveLength(17 * FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS + 1);
  });

  it('evicts expired retained grants and receipts only under capacity pressure before accepting current live authority', async () => {
    const retained = retainedCapacityState(18, new Date(nowMs - 60 * 60_000).toISOString());
    expect(retained.receipts).toHaveLength(1152);
    await writeDurableNow(frontierManualSessionStateNamesForTests.state, { version: 1, grants: retained.grants });
    await writeDurableNow(frontierManualSessionStateNamesForTests.receipts, { version: 1, receipts: retained.receipts });
    resetRemoteSteeringForTests(); await restoreRemoteSteering();
    const create = signedOperation('SESSION_CREATE', 1);
    expect(await relay(create)).toMatchObject({ status: 'accepted', action: 'SESSION_CREATE' });
    expect((await readDurable<{ grants: unknown[] }>(frontierManualSessionStateNamesForTests.state))?.grants).toHaveLength(1);
    expect((await readDurable<{ receipts: unknown[] }>(frontierManualSessionStateNamesForTests.receipts))?.receipts).toHaveLength(1);
  });

  it('returns the same bound CREATE replay view without reopening a chat after the original outbox row is pruned', async () => {
    const create = signedOperation('SESSION_CREATE', 1);
    await relay(create); await bindCreate(create);
    expect(startPorts.send).toHaveBeenCalledTimes(1);
    await writeDurableNow('session-input', []); resetInputForTests();
    const replayed = await relay(create);
    expect(replayed).toMatchObject({ status: 'accepted', replay: true, manualSession: { state: 'bound', found: true, modelConfirmed: true, automationOff: true } });
    expect(startPorts.send).toHaveBeenCalledTimes(1);
    expect(await listInputs()).toEqual([]);
  });

  it('refuses to bind a CREATE receipt to a foreign-origin ordinary session even on the exact fixed model', async () => {
    const create = signedOperation('SESSION_CREATE', 1);
    expect(await relay(create)).toMatchObject({ status: 'accepted' });
    const row = (await listInputs()).find(entry => entry.id === create.operation.inputId)!;
    expect(await claimBrowserInput(row.id, 'foreign-page', null)).not.toBeNull();
    const conversationId = randomUUID();
    const foreign = await createSession({
      conversationId,
      title: 'foreign ordinary session',
      origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' },
    });
    await observeSessionModel(foreign.id, conversationId, FRONTIER_MANUAL_SESSION_MODEL, Date.now(), FRONTIER_MANUAL_SESSION_REASONING);
    expect(await acknowledgeBrowserInput(row.id, 'foreign-page', conversationId, 'foreign-native')).toBe(true);
    expect((await getSession(foreign.id))?.origin?.kind).toBe('desktop');

    const status = signedOperation('SESSION_STATUS', 1);
    expect(await relay(status)).toMatchObject({ status: 'accepted', manualSession: { state: 'session_mismatch', found: false } });
    const prompt = signedOperation('SESSION_PROMPT', 2);
    expect(await relay(prompt)).toMatchObject({ status: 'refused', reason: 'FRONTIER_MANUAL_SESSION_NOT_READY' });
    expect((await listInputs()).some(entry => entry.id === prompt.operation.inputId)).toBe(false);
  });

  it('treats a persisted foreign-origin bound session as unavailable and never prompts it', async () => {
    const create = signedOperation('SESSION_CREATE', 1);
    await relay(create); await bindCreate(create);
    const conversationId = randomUUID();
    const foreign = await createSession({
      conversationId,
      title: 'foreign persisted target',
      origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' },
    });
    await observeSessionModel(foreign.id, conversationId, FRONTIER_MANUAL_SESSION_MODEL, Date.now(), FRONTIER_MANUAL_SESSION_REASONING);
    const saved = await readDurable<{ version: 1; grants: Array<Record<string, unknown>> }>(frontierManualSessionStateNamesForTests.state);
    expect(saved?.grants).toHaveLength(1);
    saved!.grants[0]!.candidateSessionId = foreign.id;
    saved!.grants[0]!.sessionId = foreign.id;
    saved!.grants[0]!.createDelivery = 'bound';
    await writeDurableNow(frontierManualSessionStateNamesForTests.state, saved);
    resetRemoteSteeringForTests(); await restoreRemoteSteering();

    const status = signedOperation('SESSION_STATUS', 1);
    expect(await relay(status)).toMatchObject({ status: 'accepted', manualSession: { state: 'unavailable', found: false, modelConfirmed: false, automationOff: false } });
    const prompt = signedOperation('SESSION_PROMPT', 2, { text: 'must never reach the foreign session' });
    expect(await relay(prompt)).toMatchObject({ status: 'refused', reason: 'FRONTIER_MANUAL_SESSION_NOT_READY' });
    expect((await listInputs()).some(entry => entry.id === prompt.operation.inputId)).toBe(false);
  });

  it('refuses direct session_finish from a manual-origin caller without changing queued input or Goal state', async () => {
    const create = signedOperation('SESSION_CREATE', 1);
    await relay(create); const { session, conversationId } = await bindCreate(create);
    const prompt = signedOperation('SESSION_PROMPT', 2, { text: 'keep this queued while finish is refused' });
    expect(await relay(prompt)).toMatchObject({ status: 'accepted' });
    const inputsBefore = structuredClone(await listInputs());
    const goalBefore = structuredClone(goalSwitchFor(conversationId));
    const endpoint = await startMcpServer(() => ({ roots: [], caps: defaultConfig().capabilities, readOnly: true, sessionTools: false, agentTools: false, remoteSteeringTools: false, exposedFinishTool: true }));
    try {
      const requestId = 'wfr_frontier_manual_finish_refusal';
      expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: 'manual-finish-message', tool: 'session_finish', observedAt: Date.now() })).toBe('stored');
      const response = await fetch(endpoint.urls.core, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': `${requestId}/att1` },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'session_finish', arguments: { summary: 'manual session is done' } } })
      });
      const raw = await response.text();
      const payload = JSON.parse(raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').find(line => line.startsWith('data:'))!.slice(5) : raw);
      expect(payload.result.isError).toBe(true);
      expect(JSON.stringify(payload.result)).toContain('FRONTIER_MANUAL_SESSION_FINISH_DISABLED');
      expect(await listInputs()).toEqual(inputsBefore);
      expect(goalSwitchFor(conversationId)).toEqual(goalBefore);
    } finally { await endpoint.stop(); }
  });

  it.each([
    ['GPT-5-6-THINKING', 'xhigh'],
    [' gpt-5-6-thinking ', 'xhigh'],
    ['gpt-5-6-thinking-display', 'xhigh'],
    ['gpt-5-6-thinking', 'high'],
  ] as const)('requires literal recorder proof and rejects %s/%s', async (model, reasoning) => {
    const create = signedOperation('SESSION_CREATE', 1);
    const created = await relay(create);
    expect(created).toMatchObject({ status: 'accepted' });
    await bindCreate(create, model, reasoning);
    const prompt = signedOperation('SESSION_PROMPT', 2);
    expect(await relay(prompt)).toMatchObject({ status: 'refused', reason: 'FRONTIER_MANUAL_SESSION_NOT_READY' });
  });

  it('keeps STATUS state-neutral and treats a persisted STATUS receipt as malformed durable state', async () => {
    const create = signedOperation('SESSION_CREATE', 1);
    await relay(create);
    const before = await readDurable<{ receipts: unknown[] }>(frontierManualSessionStateNamesForTests.receipts);
    const status = signedOperation('SESSION_STATUS', 4);
    expect(await relay(status)).toMatchObject({ status: 'accepted', manualSession: { state: 'pending_out_of_order' } });
    expect(await relay(status)).toMatchObject({ status: 'accepted', replay: false, manualSession: { state: 'pending_out_of_order' } });
    const after = await readDurable<{ receipts: unknown[] }>(frontierManualSessionStateNamesForTests.receipts);
    expect(after?.receipts.length).toBe(before?.receipts.length);

    await writeDurableNow(frontierManualSessionStateNamesForTests.receipts, {
      version: 1,
      receipts: [{ operationId: status.operation.operationId, operationDigest: remoteSteeringSha256(Buffer.from('bad status receipt')),
        grantId: grant.grantId, action: 'SESSION_STATUS', mutationSeq: 4, inputId: null, grantExpiresAt: grant.expiresAt }]
    });
    resetRemoteSteeringForTests(); await restoreRemoteSteering();
    expect(await relay(status)).toMatchObject({ status: 'refused', reason: 'FRONTIER_MANUAL_SESSION_STATE_UNAVAILABLE' });
  });

  it('recovers one failed PROMPT reservation without letting N+1 overtake or a later N replay reorder', async () => {
    const create = signedOperation('SESSION_CREATE', 1);
    await relay(create); const { session, conversationId } = await bindCreate(create);
    expect((await sessionInputPolicy(session.id)).queueAtFinish).toBe(false);
    expect(await offerToolInput(session.id, conversationId, 'manual-tool-call', Date.now(), true)).toEqual({ messages: [], reminder: '' });
    expect(goalSwitchFor(conversationId).enabled).toBe(false);

    const blocker = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'operator blocker', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
    const second = signedOperation('SESSION_PROMPT', 2, { text: 'second signed prompt' });
    expect(await relay(second)).toMatchObject({ status: 'refused', reason: 'FRONTIER_MANUAL_SESSION_EFFECT_REFUSED' });
    const third = signedOperation('SESSION_PROMPT', 3, { text: 'third signed prompt' });
    expect(await relay(third)).toMatchObject({ status: 'refused', reason: 'FRONTIER_MANUAL_SESSION_OPERATION_INDETERMINATE' });

    expect(await cancelInput(blocker.id)).toBe(true);
    expect(await relay(second)).toMatchObject({ status: 'accepted', replay: true });
    const secondRow = (await listInputs()).find(entry => entry.id === second.operation.inputId)!;
    expect(secondRow).toMatchObject({ sessionId: session.id, authorityClass: 'frontier_manual_session_v1', automation: 'off', text: 'second signed prompt' });
    expect(await claimBrowserInput(secondRow.id, 'prompt-page', conversationId)).toMatchObject({ id: secondRow.id });
    expect(await acknowledgeBrowserInput(secondRow.id, 'prompt-page', conversationId, 'prompt-native')).toBe(true);

    expect(await relay(third)).toMatchObject({ status: 'accepted', replay: false });
    expect(await relay(second)).toMatchObject({ status: 'refused', reason: 'FRONTIER_MANUAL_SESSION_MUTATION_STALE' });
  });

  it('keeps the bound local session through Compact & Resume and never retargets a prompt', async () => {
    const create = signedOperation('SESSION_CREATE', 1);
    await relay(create); const { session, conversationId } = await bindCreate(create);
    const replacement = randomUUID();
    expect(await rebindSession(session.id, conversationId, replacement, 'manual-session-handoff')).toBe(true);
    await observeSessionModel(session.id, replacement, FRONTIER_MANUAL_SESSION_MODEL, Date.now(), FRONTIER_MANUAL_SESSION_REASONING);
    const status = signedOperation('SESSION_STATUS', 1);
    expect(await relay(status)).toMatchObject({ status: 'accepted', manualSession: { state: 'bound', found: true, modelConfirmed: true, automationOff: true } });
    const prompt = signedOperation('SESSION_PROMPT', 2);
    expect(await relay(prompt)).toMatchObject({ status: 'accepted' });
    expect((await listInputs()).find(entry => entry.id === prompt.operation.inputId)).toMatchObject({ sessionId: session.id, conversationId: replacement });
  });

  it('fails closed on altered signed input bytes and wrong signatures', async () => {
    const create = signedOperation('SESSION_CREATE', 1);
    const altered = structuredClone(create.envelope);
    (altered.operation.payload as any).taskText = CREATE_TEXT + ' changed';
    expect(await steerRemotely(JSON.stringify(altered), noMeasure, nowMs)).toMatchObject({ status: 'refused', reason: 'FRONTIER_MANUAL_SESSION_OPERATION_MALFORMED' });
    const badSig = structuredClone(create.envelope);
    (badSig.operation as any).signature = Buffer.alloc(64, 7).toString('base64');
    expect(await steerRemotely(JSON.stringify(badSig), noMeasure, nowMs)).toMatchObject({ status: 'refused', reason: 'FRONTIER_MANUAL_SESSION_OPERATION_SIGNATURE_INVALID' });
  });
});
