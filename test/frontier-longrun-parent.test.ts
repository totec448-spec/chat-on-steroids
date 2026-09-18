import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FrontierLongrunParentAction,
  FrontierLongrunParentGrantV1,
  FrontierLongrunParentOperationEnvelopeV1,
  FrontierLongrunParentOperationV1,
} from '../src/main/frontier-longrun-parent-contract.js';

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
  pinRemoteSteeringKey,
  resetRemoteSteeringForTests,
  restoreRemoteSteering,
  steerRemotely,
} = await import('../src/main/remote-steering.js');
const {
  FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT,
  FRONTIER_LONGRUN_PARENT_GRANT_CONTRACT,
  FRONTIER_LONGRUN_PARENT_MODEL,
  FRONTIER_LONGRUN_PARENT_OPERATION_CONTRACT,
  FRONTIER_LONGRUN_PARENT_REASONING,
  FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
  canonicalFrontierLongrunParentGrantBytes,
  canonicalFrontierLongrunParentOperationBytes,
  frontierLongrunParentGrantDigest,
} = await import('../src/main/frontier-longrun-parent-contract.js');
const { frontierLongrunParentStateNamesForTests } = await import('../src/main/frontier-longrun-parent.js');
const { remoteSteeringSha256 } = await import('../src/main/remote-steering-contract.js');
const {
  acknowledgeBrowserInput,
  claimBrowserInput,
  configureInputDelivery,
  enqueueInput,
  listInputs,
  noteInputStartupError,
  resetInputForTests,
} = await import('../src/main/session/input.js');
const {
  appendEvent,
  createSession,
  initSessionStore,
  observeSessionModel,
  rebindSession,
  resetSessionStoreForTests,
} = await import('../src/main/session/store.js');
const { recordChatObservations } = await import('../src/main/session/recorder.js');
const {
  goalObjectiveFor,
  goalSwitchFor,
  resetGoalStateForTests,
  setGoalObjectiveNow,
  setGoalReplyActiveNow,
  setGoalSwitchNow,
} = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const noMeasure = { measureSleepingWorkers: async () => undefined };
const CREATE_TEXT = 'Run the Frontier weekend mission and keep working until stopped.';
const PROMPT_TEXT = 'Continue with the next bounded VYPER production slice and verify it.';
let directory: string;
let publicKeySpkiBase64 = '';
let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
let fingerprint = '';
let grant: FrontierLongrunParentGrantV1;
let grantSignature = '';
let nowMs = 0;
let operationCounter = 1;

function operationId(): string { return (operationCounter++).toString(16).padStart(32, '0'); }

function signedOperation(
  action: FrontierLongrunParentAction,
  slot: number,
  mutationSeq: number,
  options: { text?: string; inputId?: string; id?: string } = {}
): { envelope: FrontierLongrunParentOperationEnvelopeV1; text: string; operation: FrontierLongrunParentOperationV1 } {
  const text = options.text ?? (action === 'SESSION_CREATE' ? CREATE_TEXT : PROMPT_TEXT);
  const bytes = Buffer.from(text, 'utf8');
  const carriesText = action === 'SESSION_CREATE' || action === 'LONGRUN_PROMPT';
  const operation: FrontierLongrunParentOperationV1 = {
    contract: FRONTIER_LONGRUN_PARENT_OPERATION_CONTRACT,
    schemaVersion: 1,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
    operationId: options.id ?? operationId(),
    grantId: grant.grantId,
    grantDigest: frontierLongrunParentGrantDigest(grant),
    missionDigest: grant.missionDigest,
    slot,
    action,
    mutationSeq,
    inputId: carriesText ? options.inputId ?? randomUUID() : null,
    longrunText: carriesText ? text : null,
    longrunSha256: carriesText ? remoteSteeringSha256(bytes) : null,
    longrunLength: carriesText ? bytes.length : null,
    issuedAt: new Date(nowMs - 500).toISOString(),
    expiresAt: new Date(nowMs + 59_000).toISOString(),
    signingKeyFingerprint: fingerprint,
  };
  const envelope: FrontierLongrunParentOperationEnvelopeV1 = {
    contract: FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT,
    schemaVersion: 1,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
    signingKeyFingerprint: fingerprint,
    grant: { payload: grant, signature: grantSignature },
    operation: { payload: operation, signature: sign(null, canonicalFrontierLongrunParentOperationBytes(operation), privateKey).toString('base64') },
  };
  return { envelope, text, operation };
}

async function relay(fixture: ReturnType<typeof signedOperation>, at = nowMs) {
  return steerRemotely(JSON.stringify(fixture.envelope), noMeasure, at);
}

async function bindCreate(fixture: ReturnType<typeof signedOperation>, conversationId = randomUUID()) {
  const row = (await listInputs()).find(entry => entry.id === fixture.operation.inputId)!;
  const owner = `page-${fixture.operation.slot}`;
  expect(await claimBrowserInput(row.id, owner, null)).toMatchObject({ id: row.id });
  const session = await createSession({ conversationId, title: `parent-slot-${fixture.operation.slot}` });
  await observeSessionModel(session.id, conversationId, 'gpt-5-6-thinking', Date.now(), 'xhigh');
  expect(await acknowledgeBrowserInput(row.id, owner, conversationId, `native-${fixture.operation.slot}`)).toBe(true);
  const status = signedOperation('SESSION_STATUS', fixture.operation.slot, fixture.operation.mutationSeq);
  await vi.waitFor(async () => {
    expect((await relay(status)).frontier).toMatchObject({ slot: fixture.operation.slot, state: 'bound', session: { modelClass: 'other' } });
  });
  return { session, conversationId };
}

beforeAll(async () => {
  directory = await makeTempDir('cos-frontier-parent-');
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
});

afterAll(async () => {
  resetRemoteSteeringForTests(); resetGoalStateForTests(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

beforeEach(async () => {
  resetRemoteSteeringForTests(); resetGoalStateForTests(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  initDurableStore(directory); initSessionStore(directory);
  await writeDurableNow('remote-steering-pin', null);
  await writeDurableNow('remote-steering-receipts', null);
  await writeDurableNow(frontierLongrunParentStateNamesForTests.state, null);
  await writeDurableNow(frontierLongrunParentStateNamesForTests.receipts, null);
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
    remoteSteering: { enabled: true },
  });
  configureInputDelivery({
    changed: () => undefined,
    applyAutomation: async (conversationId, automation, _phase, objective) => {
      const mode = automation === 'off' ? goalSwitchFor(conversationId).mode : automation;
      await setGoalSwitchNow(conversationId, mode, automation !== 'off');
      await setGoalReplyActiveNow(conversationId, false);
      if (objective !== undefined) await setGoalObjectiveNow(conversationId, objective);
    },
  });
  startPorts.send.mockReset().mockImplementation(async input => enqueueInput(input));
  startPorts.retry.mockReset().mockImplementation(async id => {
    const row = (await listInputs()).find(entry => entry.id === id);
    if (!row || row.state !== 'queued' || !row.error?.startsWith('Message queued. Browser startup failed:')) return null;
    return noteInputStartupError(id, null);
  });
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  publicKeySpkiBase64 = publicDer.toString('base64');
  fingerprint = createHash('sha256').update(publicDer).digest('hex');
  nowMs = Date.now(); operationCounter = 1;
  grant = {
    contract: FRONTIER_LONGRUN_PARENT_GRANT_CONTRACT,
    schemaVersion: 1,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
    grantId: 'f1000000000000000000000000000001',
    missionId: 'frontier-weekend-parent',
    missionDigest: 'a'.repeat(64),
    maxSlots: 8,
    issuedAt: new Date(nowMs - 1_000).toISOString(),
    expiresAt: new Date(nowMs + 259_199_000).toISOString(),
    signingKeyFingerprint: fingerprint,
    operatorIntentDigest: 'b'.repeat(64),
  };
  grantSignature = sign(null, canonicalFrontierLongrunParentGrantBytes(grant), privateKey).toString('base64');
  await pinRemoteSteeringKey(publicKeySpkiBase64);
});

afterEach(() => {
  resetRemoteSteeringForTests(); resetGoalStateForTests(); resetInputForTests(); resetSessionStoreForTests();
});

describe('Frontier Longrun parent verifier and slot runtime', () => {
  it('creates through fixed raw gpt-5-6-thinking/xhigh desktop input without returning local identity', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    const result = await relay(create);
    expect(result).toMatchObject({
      status: 'accepted', verifierContractVersion: FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
      action: 'SESSION_CREATE', sessionId: null, runId: null, frontier: { slot: 1, state: 'opening', session: null }
    });
    expect(startPorts.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: create.operation.inputId,
      sessionId: null,
      text: CREATE_TEXT,
      objective: CREATE_TEXT,
      automation: 'loop',
      mode: 'auto',
      model: 'gpt-5-6-thinking',
      reasoningEffort: 'xhigh',
    }));
    expect(FRONTIER_LONGRUN_PARENT_MODEL).toBe('gpt-5-6-thinking');
    expect(FRONTIER_LONGRUN_PARENT_REASONING).toBe('xhigh');
    expect(JSON.stringify(result)).not.toContain('conversation');
    expect(JSON.stringify(result)).not.toContain('session-');
  });

  it('keeps an ACKed session model-pending until exact raw gpt-5-6-thinking/xhigh recorder proof arrives', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    await relay(create);
    const row = (await listInputs()).find(entry => entry.id === create.operation.inputId)!;
    expect(row.authorityClass).toBe('frontier_longrun_parent_v1');
    expect(await claimBrowserInput(row.id, 'page', null)).not.toBeNull();
    const conversationId = randomUUID();
    await createSession({ conversationId, title: 'model pending' });
    expect(await acknowledgeBrowserInput(row.id, 'page', conversationId, 'native')).toBe(true);
    const status = signedOperation('SESSION_STATUS', 1, 1);
    await vi.waitFor(async () => expect((await relay(status)).frontier?.state).toBe('model_pending'));
    await recordChatObservations(conversationId, [{ kind: 'model_selection', model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh', time: Date.now() }]);
    await vi.waitFor(async () => expect((await relay(status)).frontier?.state).toBe('bound'));
  });

  it.each([
    ['5.6', 'xhigh'],
    ['gpt-5.6-sol', 'xhigh'],
    ['gpt-5-6-thinking', 'high'],
    ['gpt-6-pro', 'pro'],
  ] as const)('rejects non-exact observed parent profile %s/%s', async (model, reasoningEffort) => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    await relay(create);
    const row = (await listInputs()).find(entry => entry.id === create.operation.inputId)!;
    await claimBrowserInput(row.id, 'page', null);
    const conversationId = randomUUID();
    const session = await createSession({ conversationId, title: 'model mismatch' });
    await observeSessionModel(session.id, conversationId, model, Date.now(), reasoningEffort);
    await acknowledgeBrowserInput(row.id, 'page', conversationId, 'native');
    const status = signedOperation('SESSION_STATUS', 1, 1);
    await vi.waitFor(async () => expect((await relay(status)).frontier?.state).toBe('model_mismatch'));
  });

  it('fails closed on explicit recorder model mismatch', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    await relay(create);
    const row = (await listInputs()).find(entry => entry.id === create.operation.inputId)!;
    await claimBrowserInput(row.id, 'page', null);
    const conversationId = randomUUID();
    const session = await createSession({ conversationId, title: 'model mismatch' });
    await observeSessionModel(session.id, conversationId, 'gpt-5.6-sol', Date.now(), 'high');
    await acknowledgeBrowserInput(row.id, 'page', conversationId, 'native');
    const status = signedOperation('SESSION_STATUS', 1, 1);
    await vi.waitFor(async () => expect((await relay(status)).frontier?.state).toBe('model_mismatch'));
    const prompt = signedOperation('LONGRUN_PROMPT', 1, 2);
    expect(await relay(prompt)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_SESSION_NOT_BOUND' });
  });

  it('uses monotonic supersession: seq3 stop is accepted with seq2 unseen, then delayed seq2 is stale across restore', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    await relay(create); await bindCreate(create);
    const stop = signedOperation('LOOP_OFF', 1, 3);
    expect(await relay(stop)).toMatchObject({ status: 'accepted', frontier: { state: 'stopped' } });
    resetRemoteSteeringForTests();
    await restoreRemoteSteering();
    const delayed = signedOperation('LONGRUN_PROMPT', 1, 2);
    expect(await relay(delayed)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_MUTATION_STALE' });
    const status = signedOperation('SESSION_STATUS', 1, 3);
    expect(await relay(status)).toMatchObject({ status: 'accepted', frontier: { state: 'stopped' } });
  });

  it('treats same seq+same digest as recovery, changed digest as altered, and retries only explicit CREATE startup failure', async () => {
    startPorts.send.mockImplementationOnce(async input => {
      const row = await enqueueInput(input);
      return (await noteInputStartupError(row.id, 'Message queued. Browser startup failed: fixture'))!;
    });
    const inputId = randomUUID();
    const create = signedOperation('SESSION_CREATE', 1, 1, { inputId });
    expect(await relay(create)).toMatchObject({ status: 'accepted', frontier: { state: 'startup_failed' } });
    expect(startPorts.retry).not.toHaveBeenCalled();
    expect(await relay(create)).toMatchObject({ status: 'accepted', replay: true });
    expect(startPorts.retry).toHaveBeenCalledExactlyOnceWith(inputId);
    const changed = signedOperation('SESSION_CREATE', 1, 1, { inputId, text: CREATE_TEXT + ' changed', id: create.operation.operationId });
    expect(await relay(changed)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_OPERATION_REPLAY_ALTERED' });
  });

  it('persists opening LOOP_OFF before cancel and applies Off after a late cancelled-send ACK binds', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    await relay(create);
    const row = (await listInputs()).find(entry => entry.id === create.operation.inputId)!;
    await claimBrowserInput(row.id, 'late-page', null);
    const stop = signedOperation('LOOP_OFF', 1, 3);
    expect(await relay(stop)).toMatchObject({ status: 'accepted', frontier: { state: 'stopping' } });
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    const conversationId = randomUUID();
    const session = await createSession({ conversationId, title: 'late ack' });
    await observeSessionModel(session.id, conversationId, 'gpt-5-6-thinking', Date.now(), 'xhigh');
    expect(await acknowledgeBrowserInput(row.id, 'late-page', conversationId, 'native-late')).toBe(true);
    const status = signedOperation('SESSION_STATUS', 1, 3);
    await vi.waitFor(async () => expect((await relay(status)).frontier?.state).toBe('stopped'));
    // A create stopped before its native ACK never armed Loop, so the default mode may
    // remain 'goal'; the safety property is that the late ACK cannot leave automation enabled.
    expect(goalSwitchFor(conversationId)).toMatchObject({ enabled: false });
  });

  it('preserves the original objective while a signed prompt follows Sol tool-free direct steering', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    await relay(create);
    const { session, conversationId } = await bindCreate(create);
    expect(goalObjectiveFor(conversationId)).toBe(CREATE_TEXT);
    const startedAt = Date.now();
    await appendEvent(session.id, { time: startedAt, source: 'extension', kind: 'turn_start', turnId: 'active-parent-turn' });
    const prompt = signedOperation('LONGRUN_PROMPT', 1, 2);
    expect(await relay(prompt)).toMatchObject({ status: 'accepted', action: 'LONGRUN_PROMPT' });
    const row = (await listInputs()).find(entry => entry.id === prompt.operation.inputId)!;
    expect(row).toMatchObject({
      sessionId: session.id,
      text: PROMPT_TEXT,
      automation: 'loop',
      transportIntent: 'browser',
      directTurn: { id: 'active-parent-turn', startedAt },
    });
    expect(row.objective).toBeUndefined();
    expect(goalObjectiveFor(conversationId)).toBe(CREATE_TEXT);
  });

  it('isolates slots and keeps the local slot binding across Compact & Resume', async () => {
    const first = signedOperation('SESSION_CREATE', 1, 1);
    await relay(first); const one = await bindCreate(first);
    const second = signedOperation('SESSION_CREATE', 2, 1);
    await relay(second); const two = await bindCreate(second);
    const replacement = randomUUID();
    expect(await rebindSession(one.session.id, one.conversationId, replacement, 'parent-handoff-proof')).toBe(true);
    await observeSessionModel(one.session.id, replacement, 'gpt-5-6-thinking', Date.now(), 'xhigh');
    const prompt = signedOperation('LONGRUN_PROMPT', 1, 2);
    expect(await relay(prompt)).toMatchObject({ status: 'accepted' });
    expect((await listInputs()).find(entry => entry.id === prompt.operation.inputId)?.sessionId).toBe(one.session.id);
    const twoStatus = signedOperation('SESSION_STATUS', 2, 1);
    expect(await relay(twoStatus)).toMatchObject({ status: 'accepted', frontier: { slot: 2, state: 'bound' } });
    expect(two.session.id).not.toBe(one.session.id);
  });

  it('supports all eight single-assignment slots and refuses a second CREATE in an assigned slot', async () => {
    for (let slot = 1; slot <= 8; slot++) {
      const create = signedOperation('SESSION_CREATE', slot, 1);
      expect(await relay(create)).toMatchObject({ status: 'accepted', frontier: { slot } });
      await bindCreate(create);
    }
    const again = signedOperation('SESSION_CREATE', 8, 2);
    expect(await relay(again)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_SLOT_ALREADY_USED' });
  });

  it('survives >50 unrelated outbox receipts after binding because slot identity is separately durable', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    await relay(create); await bindCreate(create);
    const rows = Array.from({ length: 60 }, (_, index) => ({
      id: randomUUID(), sessionId: null, text: `history-${index}`, mode: 'auto' as const, dueAt: 0,
      model: null, reasoningEffort: null, state: 'sent' as const, owner: `owner-${index}`, createdAt: index,
      conversationId: `history-chat-${index}`, messageId: `message-${index}`, deliveredAt: index + 1, historyRecorded: true
    }));
    await writeDurableNow('session-input', rows);
    resetInputForTests(); await listInputs();
    resetRemoteSteeringForTests(); await restoreRemoteSteering();
    const status = signedOperation('SESSION_STATUS', 1, 1);
    expect(await relay(status)).toMatchObject({ status: 'accepted', frontier: { state: 'bound' } });
  });

  it('keeps STATUS receipt-neutral and fences reads until the signed after-sequence is locally reached', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    await relay(create);
    const before = await readDurable<{ receipts: unknown[] }>(frontierLongrunParentStateNamesForTests.receipts);
    const future = signedOperation('SESSION_STATUS', 1, 4);
    expect(await relay(future)).toMatchObject({ status: 'accepted', frontier: { state: 'pending_out_of_order' } });
    expect(await relay(future)).toMatchObject({ status: 'accepted', frontier: { state: 'pending_out_of_order' } });
    const after = await readDurable<{ receipts: unknown[] }>(frontierLongrunParentStateNamesForTests.receipts);
    expect(after?.receipts.length).toBe(before?.receipts.length);
  });

  it('reserves receipt capacity for LOOP_OFF after non-stop parent mutations reach their cap', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    await relay(create); await bindCreate(create);
    const saved = await readDurable<{ version: number; receipts: any[] }>(frontierLongrunParentStateNamesForTests.receipts);
    const receipts = [...(saved?.receipts ?? [])];
    for (let index = receipts.length; index < 224; index++) {
      receipts.push({
        operationId: (index + 0x1000).toString(16).padStart(32, '0'),
        operationDigest: (index + 1).toString(16).padStart(64, '0'),
        grantId: grant.grantId,
        slot: 1,
        mutationSeq: index + 10,
        action: 'LONGRUN_PROMPT',
        inputId: `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        grantExpiresAt: grant.expiresAt,
      });
    }
    await writeDurableNow(frontierLongrunParentStateNamesForTests.receipts, { version: 1, receipts });
    resetRemoteSteeringForTests(); await restoreRemoteSteering();

    const prompt = signedOperation('LONGRUN_PROMPT', 1, 2);
    expect(await relay(prompt)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_RECEIPT_STORE_FULL' });
    const stop = signedOperation('LOOP_OFF', 1, 3);
    expect(await relay(stop)).toMatchObject({ status: 'accepted', frontier: { state: 'stopped' } });
  });

  it('recovers a durable CREATE reservation after restart while still live, but never duplicates an already-enqueued CREATE', async () => {
    startPorts.send.mockRejectedValueOnce(new Error('crash seam before enqueue'));
    const reserved = signedOperation('SESSION_CREATE', 1, 1);
    expect(await relay(reserved)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED' });
    expect((await listInputs()).find(row => row.id === reserved.operation.inputId)).toBeUndefined();
    resetRemoteSteeringForTests(); await restoreRemoteSteering();
    expect(await relay(reserved)).toMatchObject({ status: 'accepted', replay: true });
    expect(startPorts.send).toHaveBeenCalledTimes(2);
    expect((await listInputs()).filter(row => row.id === reserved.operation.inputId)).toHaveLength(1);

    resetRemoteSteeringForTests(); await restoreRemoteSteering();
    expect(await relay(reserved)).toMatchObject({ status: 'accepted', replay: true });
    expect(startPorts.send).toHaveBeenCalledTimes(2);
    expect((await listInputs()).filter(row => row.id === reserved.operation.inputId)).toHaveLength(1);
  });

  it('never adopts a planted same-input-id row whose bytes differ from the signed CREATE', async () => {
    startPorts.send.mockRejectedValueOnce(new Error('fixture: reserve only'));
    const create = signedOperation('SESSION_CREATE', 1, 1);
    expect(await relay(create)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED' });
    expect((await listInputs()).find(row => row.id === create.operation.inputId)).toBeUndefined();

    const plantedText = CREATE_TEXT + ' planted';
    const planted = await enqueueInput({
      id: create.operation.inputId!,
      sessionId: null,
      text: plantedText,
      objective: plantedText,
      automation: 'loop',
      mode: 'auto',
      dueAt: Date.now(),
      model: 'gpt-5-6-thinking',
      reasoningEffort: 'xhigh',
    });
    expect(await claimBrowserInput(planted.id, 'planted-page', null)).not.toBeNull();
    const conversationId = randomUUID();
    const session = await createSession({ conversationId, title: 'planted same id' });
    await observeSessionModel(session.id, conversationId, 'gpt-5-6-thinking', Date.now(), 'xhigh');
    expect(await acknowledgeBrowserInput(planted.id, 'planted-page', conversationId, 'native-planted')).toBe(true);

    resetRemoteSteeringForTests(); await restoreRemoteSteering();
    const status = signedOperation('SESSION_STATUS', 1, 1);
    await vi.waitFor(async () => expect((await relay(status)).frontier?.state).toBe('failed'));
    const prompt = signedOperation('LONGRUN_PROMPT', 1, 2);
    expect(await relay(prompt)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_SESSION_NOT_BOUND' });
    expect(await relay(create)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_INPUT_ID_CONFLICT', replay: true });
  });
  it('recovers ACK-before-model and fully bound slots across restart without creating another session input', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    await relay(create);
    const row = (await listInputs()).find(entry => entry.id === create.operation.inputId)!;
    await claimBrowserInput(row.id, 'restart-page', null);
    const conversationId = randomUUID();
    await createSession({ conversationId, title: 'restart binding' });
    await acknowledgeBrowserInput(row.id, 'restart-page', conversationId, 'native-restart');
    resetRemoteSteeringForTests(); await restoreRemoteSteering();
    const status = signedOperation('SESSION_STATUS', 1, 1);
    expect(await relay(status)).toMatchObject({ status: 'accepted', frontier: { state: 'model_pending' } });
    await recordChatObservations(conversationId, [{ kind: 'model_selection', model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh', time: Date.now() }]);
    await vi.waitFor(async () => expect((await relay(status)).frontier?.state).toBe('bound'));

    resetRemoteSteeringForTests(); await restoreRemoteSteering();
    expect(await relay(status)).toMatchObject({ status: 'accepted', frontier: { state: 'bound' } });
    expect((await listInputs()).filter(entry => entry.id === create.operation.inputId)).toHaveLength(1);
    expect(startPorts.send).toHaveBeenCalledTimes(1);
  });

  it('fails closed for wrong signatures and expired parent/operation windows', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    const bad = { ...create.envelope, operation: { ...create.envelope.operation, signature: Buffer.alloc(64).toString('base64') } };
    expect(await steerRemotely(JSON.stringify(bad), noMeasure, nowMs)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_OPERATION_SIGNATURE_INVALID' });
    expect(await relay(create, Date.parse(create.operation.expiresAt) + 1)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_OPERATION_NOT_LIVE' });
    expect(await relay(create, Date.parse(grant.expiresAt) + 1)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_GRANT_NOT_LIVE' });
  });

  it('recovers exact CREATE/PROMPT/STOP after operation expiry without duplicate effects, while unseen expired operations still refuse', async () => {
    const create = signedOperation('SESSION_CREATE', 1, 1);
    expect(await relay(create)).toMatchObject({ status: 'accepted' });
    await bindCreate(create);
    const createRows = (await listInputs()).filter(row => row.id === create.operation.inputId).length;
    const afterCreateExpiry = Date.parse(create.operation.expiresAt) + 1;
    expect(await relay(create, afterCreateExpiry)).toMatchObject({ status: 'accepted', replay: true });
    expect((await listInputs()).filter(row => row.id === create.operation.inputId)).toHaveLength(createRows);
    expect(startPorts.retry).not.toHaveBeenCalled();

    const prompt = signedOperation('LONGRUN_PROMPT', 1, 2);
    expect(await relay(prompt)).toMatchObject({ status: 'accepted' });
    const promptRows = (await listInputs()).filter(row => row.id === prompt.operation.inputId).length;
    expect(await relay(prompt, Date.parse(prompt.operation.expiresAt) + 1)).toMatchObject({ status: 'accepted', replay: true });
    expect((await listInputs()).filter(row => row.id === prompt.operation.inputId)).toHaveLength(promptRows);

    const stop = signedOperation('LOOP_OFF', 1, 3);
    expect(await relay(stop)).toMatchObject({ status: 'accepted' });
    expect(await relay(stop, Date.parse(stop.operation.expiresAt) + 1)).toMatchObject({ status: 'accepted', replay: true });

    const alteredBase = signedOperation('LOOP_OFF', 1, 3, { id: stop.operation.operationId });
    const alteredOperation: FrontierLongrunParentOperationV1 = {
      ...alteredBase.operation,
      expiresAt: new Date(Date.parse(alteredBase.operation.expiresAt) - 1_000).toISOString(),
    };
    const altered = {
      ...alteredBase,
      operation: alteredOperation,
      envelope: {
        ...alteredBase.envelope,
        operation: {
          payload: alteredOperation,
          signature: sign(null, canonicalFrontierLongrunParentOperationBytes(alteredOperation), privateKey).toString('base64')
        }
      }
    };
    expect(await relay(altered, Date.parse(stop.operation.expiresAt) + 1)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_OPERATION_REPLAY_ALTERED' });

    const unseenExpired = signedOperation('SESSION_STATUS', 1, 3);
    expect(await relay(unseenExpired, Date.parse(unseenExpired.operation.expiresAt) + 1)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_OPERATION_NOT_LIVE' });
  });

  it('refuses an expired exact mutation as indeterminate when its durable reservation has no effect evidence', async () => {
    startPorts.send.mockRejectedValueOnce(new Error('connector not ready before enqueue'));
    const create = signedOperation('SESSION_CREATE', 1, 1);
    expect(await relay(create)).toMatchObject({ status: 'refused', reason: 'FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED' });
    expect((await listInputs()).find(row => row.id === create.operation.inputId)).toBeUndefined();
    expect(await relay(create, Date.parse(create.operation.expiresAt) + 1)).toMatchObject({
      status: 'refused', replay: true, reason: 'FRONTIER_LONGRUN_PARENT_OPERATION_INDETERMINATE'
    });
    expect(startPorts.send).toHaveBeenCalledTimes(1);
  });
});
